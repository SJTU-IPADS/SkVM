import { mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import type { AgentAdapter, AdapterConfig, AdapterConfigMode, RunResult, TokenUsage, SkillBundle } from "../core/types.ts"
import { RunRecordBuilder } from "../core/run-record.ts"
import { runSubprocess } from "../core/subprocess.ts"
import { createLogger } from "../core/logger.ts"
import { getAdapterRepoDir, getAdapterSettings, getHeadlessAgentConfig, expandHome } from "../core/config.ts"
import { envForRoute, resolveBackendModel, resolveRoute, validateModelIdForRoute } from "../providers/registry.ts"
import { diagnoseOpencode } from "./diagnose-failure.ts"
import { subprocessVerdict } from "./subprocess-verdict.ts"
import { TASK_FILE_DEFAULTS } from "../core/ui-defaults.ts"
import {
  createSandbox,
  ensureDir,
  copyFileIfExists,
  symlinkIfExists,
  buildOpenCodeConfigContent,
  type Sandbox,
} from "../core/adapter-sandbox.ts"
import { startContainer, execInContainer } from "../core/docker-run.ts"

const log = createLogger("opencode")

// ---------------------------------------------------------------------------
// NDJSON Event Types (from opencode --format json)
// ---------------------------------------------------------------------------

export interface OpenCodeEvent {
  type: "tool_use" | "text" | "step_start" | "step_finish" | "reasoning" | "error"
  timestamp?: number
  sessionID?: string
  part?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Event Parsing
// ---------------------------------------------------------------------------

export function parseNDJSON(output: string): OpenCodeEvent[] {
  const events: OpenCodeEvent[] = []
  for (const line of output.split("\n")) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as OpenCodeEvent)
    } catch {
      log.debug(`Skipping non-JSON line: ${line.slice(0, 100)}`)
    }
  }
  return events
}

export function eventsToRunRecord(events: OpenCodeEvent[]): RunRecordBuilder {
  const builder = new RunRecordBuilder()
  const errors: string[] = []

  for (const event of events) {
    const part = event.part ?? {}

    if (event.type === "text") {
      builder.assistantText((part.text as string) ?? "", event.timestamp ?? Date.now())
    } else if (event.type === "tool_use") {
      const state = (part.state as Record<string, unknown>) ?? {}
      builder.toolStep([{
        id: (part.callID as string) ?? (part.id as string) ?? `tc-${Date.now()}`,
        name: (part.tool as string) ?? (part.name as string) ?? "",
        input: (state.input as Record<string, unknown>) ?? {},
        output: (state.output as string) ?? (state.error as string) ?? undefined,
      }], event.timestamp ?? Date.now())
    } else if (event.type === "step_finish") {
      // OpenCode puts token usage and cost in step_finish events
      const usage = parseStepFinishUsage(part)
      if (usage.tokens) builder.usage(usage.tokens)
      if (usage.cost !== undefined) builder.cost(usage.cost)
    } else if (event.type === "error") {
      const errMsg = (part.error as Record<string, unknown>)?.data
        ?? (part.message as string)
        ?? JSON.stringify(part)
      const msg = typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg)
      log.warn(`OpenCode error event: ${msg}`)
      errors.push(msg)
    }
  }

  // Telemetry status only — the runner gate decides scoreability based on
  // subprocess-level state (timedOut / exitCode), set by adapter.run() after
  // this function returns. A clean exit with no parseable events is just
  // reduced telemetry: workDir is still the agent's natural final state and
  // remains scoreable. Marking it tainted here was a round-1 overreach (see
  // round-3 Codex review): it forced bench rows to 0 in environments where
  // opencode's NDJSON serializer was simply broken or off, even though the
  // agent had finished cleanly.
  const noOutput = builder.stepCount === 0
  builder.parseNote({
    statusDetail: noOutput
      ? errors.length > 0
        ? `opencode emitted ${errors.length} error event(s) and no steps — telemetry only`
        : `opencode produced no parseable events — telemetry only, workDir scored as-is`
      : undefined,
    // Surface error events as adapterError when the agent produced no useful output
    adapterError: errors.length > 0 && noOutput
      ? { exitCode: 1, stderr: errors.join("; ") || "opencode error (no details)" }
      : undefined,
  })
  return builder
}

/**
 * Extract tokens and cost from a step_finish event part.
 *
 * Real format from opencode --format json:
 * ```json
 * { "type": "step-finish", "tokens": { "total": 15435, "input": 15430, "output": 5,
 *   "reasoning": 0, "cache": { "write": 0, "read": 0 } }, "cost": 0.015455 }
 * ```
 */
export function parseStepFinishUsage(
  part: Record<string, unknown>,
): { tokens?: TokenUsage; cost?: number } {
  const raw = part.tokens as Record<string, unknown> | undefined
  let tokens: TokenUsage | undefined
  if (raw && typeof raw === "object") {
    const cache = (raw.cache as Record<string, unknown>) ?? {}
    tokens = {
      input: (raw.input as number) ?? 0,
      output: (raw.output as number) ?? 0,
      cacheRead: (cache.read as number) ?? 0,
      cacheWrite: (cache.write as number) ?? 0,
    }
  }
  return { tokens, cost: typeof part.cost === "number" ? part.cost : undefined }
}

// ---------------------------------------------------------------------------
// OpenCode Adapter
// ---------------------------------------------------------------------------

/**
 * Result of resolving the opencode command to invoke.
 *
 * `env` is an **overlay** that callers must merge onto process.env before
 * spawning. It is populated only for the skvm-bundled tier, where we redirect
 * opencode's XDG_CONFIG/DATA/STATE/CACHE lookups into a skvm-private profile
 * directory so the bundled copy never touches a user's global
 * ~/.config/opencode etc. The config-path and global-install tiers return an
 * empty overlay — their behaviour is unchanged.
 *
 * HOME is deliberately **not** overridden: child processes that opencode spawns
 * (bash, git, python, node, ...) need the user's real home dir to read
 * ~/.ssh, ~/.gitconfig, ~/.npmrc, cloud credentials, etc. Poisoning HOME would
 * regress any task that relies on those. Modern tools honour XDG_CONFIG_HOME
 * over $HOME/.config, so XDG-only overrides still isolate opencode's own state.
 */
export interface OpenCodeResolution {
  cmd: string[]
  env: Record<string, string>
}

// SKVM_INSTALL_ROOT is set by bin/skvm.js before spawning the compiled binary.
// We need this because inside a Bun single-file executable, process.execPath
// points at a virtual /$bunfs/... path — not the real on-disk package dir, so
// deriving vendor/ location from it would silently miss. The execPath branch
// is only reached when someone runs the compiled binary directly (no shim).
function getSkvmInstallRoot(): string | null {
  const fromEnv = process.env.SKVM_INSTALL_ROOT
  if (fromEnv) return fromEnv

  const execPath = process.execPath
  if (execPath.startsWith("/$bunfs")) return null
  if (path.basename(execPath) === "skvm") {
    return path.dirname(path.dirname(execPath))
  }
  return null
}

// ---------------------------------------------------------------------------
// Resolution tiers
// ---------------------------------------------------------------------------
//
// Contract: a Tier returns a resolution+log or null (= not configured, try
// next). Throwing means "configured but broken" — a user-visible error that
// should short-circuit the chain rather than silently fall through to a
// surprising alternative.

type TierHit = { resolution: OpenCodeResolution; logLine: string }
type Tier = () => Promise<TierHit | null>

const INSTALL_HELP = "See https://skillvm.ai/install for setup."

const tierBundled: Tier = async () => {
  const installRoot = getSkvmInstallRoot()
  if (!installRoot) return null
  const bundled = path.join(installRoot, "vendor", "opencode", "current", "bin", "opencode")
  if (!(await Bun.file(bundled).exists())) return null
  const profileRoot = path.join(installRoot, "vendor", "opencode", "profile")
  const env: Record<string, string> = {
    XDG_CONFIG_HOME: path.join(profileRoot, "config"),
    XDG_DATA_HOME: path.join(profileRoot, "data"),
    XDG_STATE_HOME: path.join(profileRoot, "state"),
    XDG_CACHE_HOME: path.join(profileRoot, "cache"),
  }
  return {
    resolution: { cmd: [bundled], env },
    logLine: `Using skvm-bundled opencode: ${bundled} (profile: ${profileRoot})`,
  }
}

// Throws if repoDir is set but neither src/index.ts nor a dist/ binary is
// present — a misconfigured contributor checkout, not a "just fall through"
// state. Prefers src so the upstream model registry stays current.
const tierAdapterRepo: Tier = async () => {
  const repoDir = getAdapterRepoDir("opencode")
  if (!repoDir) return null
  const pkgDir = path.join(repoDir, "packages/opencode")

  const entryPoint = path.join(pkgDir, "src/index.ts")
  if (await Bun.file(entryPoint).exists()) {
    return {
      resolution: {
        cmd: ["bun", "run", "--cwd", pkgDir, "--conditions=browser", "src/index.ts", "--"],
        env: {},
      },
      logLine: `Using opencode from source: ${repoDir}`,
    }
  }

  const platformMap: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" }
  const archMap: Record<string, string> = { x64: "x64", arm64: "arm64" }
  const plat = platformMap[process.platform] ?? process.platform
  const arch = archMap[process.arch] ?? process.arch
  const binaryPath = path.join(pkgDir, "dist", `opencode-${plat}-${arch}`, "bin", "opencode")
  if (await Bun.file(binaryPath).exists()) {
    return {
      resolution: { cmd: [binaryPath], env: {} },
      logLine: `Using opencode binary: ${binaryPath}`,
    }
  }

  throw new Error(`opencode not found at ${repoDir} (no binary in dist/ and no src/index.ts)`)
}

// Throws if the user set `headlessAgent.opencodePath` to something missing —
// an explicit path that doesn't resolve is a config error, not a fallthrough.
const tierHeadlessExplicit: Tier = async () => {
  const raw = getHeadlessAgentConfig().opencodePath
  if (!raw) return null
  const binaryPath = expandHome(raw)
  if (!(await Bun.file(binaryPath).exists())) {
    throw new Error(`headlessAgent.opencodePath does not exist: ${binaryPath}`)
  }
  return {
    resolution: { cmd: [binaryPath], env: {} },
    logLine: `Using headlessAgent.opencodePath: ${binaryPath}`,
  }
}

const tierGlobal: Tier = async () => {
  const { exitCode, stdout } = await runSubprocess(["which", "opencode"])
  if (exitCode !== 0 || !stdout.trim()) return null
  const p = stdout.trim()
  return { resolution: { cmd: [p], env: {} }, logLine: `Using global opencode: ${p}` }
}

async function resolveTiers(tiers: Tier[], notFoundMsg: string): Promise<OpenCodeResolution> {
  for (const tier of tiers) {
    const hit = await tier()
    if (hit) {
      log.info(hit.logLine)
      return hit.resolution
    }
  }
  throw new Error(`${notFoundMsg} ${INSTALL_HELP}`)
}

// ---------------------------------------------------------------------------
// Public resolvers
// ---------------------------------------------------------------------------

// The two resolvers exist because adapter-mode (bench target, "measure what
// the user has") and headless-mode (internal tuner, "stay reproducible") want
// opposite priorities for the same tiers. Keep them as two explicit tier
// arrays so the ordering difference is visible at a glance.

export async function resolveAdapterOpenCodeCmd(): Promise<OpenCodeResolution> {
  return resolveTiers(
    [tierAdapterRepo, tierGlobal, tierBundled],
    "opencode not found for adapter. Tried: skvm.config.json → adapters.opencode, global `which opencode`, and skvm-bundled copy.",
  )
}

let _headlessCache: Promise<OpenCodeResolution> | undefined
export async function resolveHeadlessOpenCodeCmd(): Promise<OpenCodeResolution> {
  // Cache: jit-optimize / jit-boost call this once per task in hot loops,
  // and the config is process-lifetime constant.
  if (!_headlessCache) {
    _headlessCache = resolveTiers(
      [tierHeadlessExplicit, tierBundled, tierGlobal],
      "opencode not found for headless agent. Tried: headlessAgent.opencodePath, skvm-bundled copy (reinstall skvm via install.sh or npm), and global `which opencode`.",
    ).catch((err) => {
      _headlessCache = undefined
      throw err
    })
  }
  return _headlessCache
}

const HOME = process.env.HOME ?? ""

// Per opencode `packages/opencode/src/config/config.ts:1106,1255,1348`:
// global user config honors three filenames; explicit-dir and legacy home
// only honor two (no `config.json`).
const OPENCODE_CONFIG_FILENAMES_FULL = ["opencode.jsonc", "opencode.json", "config.json"] as const
const OPENCODE_CONFIG_FILENAMES_SHORT = ["opencode.jsonc", "opencode.json"] as const

function firstExisting(dir: string, names: readonly string[]): string | null {
  for (const n of names) {
    const p = path.join(dir, n)
    if (existsSync(p)) return p
  }
  return null
}

function userOpencodeHome(): string {
  return process.env.OPENCODE_TEST_HOME ?? HOME
}

function userOpencodeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  return path.join(xdg || path.join(userOpencodeHome(), ".config"), "opencode")
}

function userOpencodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim()
  return path.join(xdg || path.join(userOpencodeHome(), ".local", "share"), "opencode")
}

/**
 * Resolve the active opencode user config file, mirroring opencode's own
 * precedence. Priority: `$OPENCODE_CONFIG` → `$OPENCODE_CONFIG_DIR` → XDG
 * global → legacy `~/.opencode/`. Explicit-path-but-missing logs a warning
 * and falls through; returns null if nothing is found.
 */
export function resolveUserOpencodeConfigFile(): string | null {
  const explicit = process.env.OPENCODE_CONFIG?.trim()
  if (explicit) {
    if (existsSync(explicit)) return explicit
    log.warn(`OPENCODE_CONFIG="${explicit}" does not exist; falling back to XDG resolution.`)
  }
  const explicitDir = process.env.OPENCODE_CONFIG_DIR?.trim()
  if (explicitDir) {
    const hit = firstExisting(explicitDir, OPENCODE_CONFIG_FILENAMES_SHORT)
    if (hit) return hit
  }
  const globalHit = firstExisting(userOpencodeConfigDir(), OPENCODE_CONFIG_FILENAMES_FULL)
  if (globalHit) return globalHit
  return firstExisting(path.join(userOpencodeHome(), ".opencode"), OPENCODE_CONFIG_FILENAMES_SHORT)
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly name = "opencode"
  private model = ""
  private timeoutMs: number = TASK_FILE_DEFAULTS.timeoutMs
  private cmdPrefix: string[] = []
  private envOverlay: Record<string, string> = {}
  private mode: AdapterConfigMode = "managed"
  private nativeAgent = "build"
  private extraCliArgs: string[] = []
  private sandbox: Sandbox | undefined
  /** Cached route env overlay (API keys) from setup. Container mode uses
   * this to seed the container's env — cheaper and safer than re-resolving
   * the route at run time. */
  private routeEnv: Record<string, string> = {}
  /** Cached OPENCODE_CONFIG_CONTENT JSON from managed-mode setup. Container
   * mode injects it verbatim into the container env — no file needed since
   * opencode reads this env variable directly. `null` when the route is
   * native or non-openai-compatible; container-mode setup rejects those. */
  private opencodeConfigContent: string | null = null

  async setup(config: AdapterConfig): Promise<void> {
    this.model = config.model
    this.timeoutMs = config.timeoutMs ?? TASK_FILE_DEFAULTS.timeoutMs
    this.mode = config.mode ?? "managed"

    const settings = getAdapterSettings("opencode")
    this.nativeAgent = config.nativeAgent ?? settings.nativeAgent ?? "build"
    this.extraCliArgs = config.extraCliArgs ?? settings.extraCliArgs ?? []

    // Fail-fast: native needs a config opencode would itself load; managed
    // needs a providers.routes entry matching this.model.
    const userConfigFile = this.mode === "native" ? resolveUserOpencodeConfigFile() : null
    if (this.mode === "native" && !userConfigFile) {
      throw new Error(
        `opencode (native): no opencode.{jsonc,json} / config.json found in any of: ` +
        `OPENCODE_CONFIG, OPENCODE_CONFIG_DIR, ${userOpencodeConfigDir()}, ${userOpencodeHome()}/.opencode. ` +
        `Run opencode's own setup first, or switch to --adapter-config=managed.`,
      )
    }
    if (this.mode === "managed") {
      try {
        const route = resolveRoute(this.model)
        validateModelIdForRoute(this.model, route)
      } catch (err) {
        throw new Error(
          `opencode (managed): ${(err as Error).message} Run \`skvm config init\` to add a route, ` +
          `or switch to --adapter-config=native.`,
        )
      }
    }

    const resolved = await resolveAdapterOpenCodeCmd()
    this.cmdPrefix = resolved.cmd

    // Build the sandbox HOME (XDG_* pointing into it) so runs don't touch
    // the user's global opencode state.
    this.sandbox = createSandbox("opencode")
    const root = this.sandbox.root
    const cfgDir = path.join(root, "config", "opencode")
    const dataDir = path.join(root, "data", "opencode")
    const cacheDir = path.join(root, "cache", "opencode")
    const stateDir = path.join(root, "state", "opencode")
    ensureDir(cfgDir)
    ensureDir(dataDir)
    ensureDir(cacheDir)
    ensureDir(stateDir)

    // Empty managed-config dir inside the sandbox so opencode's
    // system-managed config layer (macOS /Library/Application Support,
    // Linux /etc) never leaks into skvm runs.
    const managedEmpty = path.join(root, "managed-empty")
    ensureDir(managedEmpty)

    const envOverlay: Record<string, string> = {
      ...resolved.env,
      ...envForRoute(config.model),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      // Disable `.opencode/` walk-up from the task workdir — it'd pull
      // per-repo config into bench runs and break reproducibility.
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_TEST_MANAGED_CONFIG_DIR: managedEmpty,
    }
    this.routeEnv = envForRoute(config.model)

    if (userConfigFile) {
      // Preserve the user's extension so opencode finds the same file in
      // the sandbox (.json vs .jsonc vs config.json all valid).
      copyFileIfExists(userConfigFile, path.join(cfgDir, path.basename(userConfigFile)))
      const srcCfgDir = userOpencodeConfigDir()
      symlinkIfExists(path.join(srcCfgDir, "agent"), path.join(cfgDir, "agent"))
      symlinkIfExists(path.join(srcCfgDir, "rules"), path.join(cfgDir, "rules"))
      symlinkIfExists(path.join(srcCfgDir, "skills"), path.join(cfgDir, "skills"))
      // auth.json is copied (not symlinked) so an OAuth refresh from the
      // sandbox doesn't overwrite the user's real credentials.
      copyFileIfExists(path.join(userOpencodeDataDir(), "auth.json"), path.join(dataDir, "auth.json"))
    } else {
      // Managed: empty sandbox. For openai-compatible routes, inject a
      // synthesized provider via OPENCODE_CONFIG_CONTENT so opencode doesn't
      // need the user's config at all.
      const route = resolveRoute(this.model)
      if (route.kind === "openai-compatible") {
        const cfg = buildOpenCodeConfigContent(
          route,
          resolveBackendModel(this.model),
        )
        envOverlay.OPENCODE_CONFIG_CONTENT = cfg
        this.opencodeConfigContent = cfg
      }
    }

    this.envOverlay = envOverlay
    log.info(`opencode command: ${this.cmdPrefix.join(" ")}`)
    log.info(`opencode model: ${this.model} (mode=${this.mode}, sandbox=${root})`)
  }

  async run(task: {
    prompt: string
    workDir: string
    skill?: SkillBundle
    taskId?: string
    convLog?: import("../core/conversation-logger.ts").ConversationLog
    timeoutMs?: number
    /** Terminal-Bench image — when set (and SKVM_OC_HOST_MODE is not),
     * opencode runs inside skvm-opencode-runtime with workDir bind-mounted
     * at /app so model-generated shell commands (find /, grep -r, etc.)
     * execute in a clean Ubuntu root rather than the Windows Git-Bash host.
     * Mirrors pi's / claude-code's containerized branch. */
    tbDockerImage?: string
  }): Promise<RunResult> {
    if (task.tbDockerImage && !process.env.SKVM_OC_HOST_MODE) {
      return this.runInContainer(task)
    }
    return this.runOnHost(task)
  }

  private async runOnHost(task: {
    prompt: string
    workDir: string
    skill?: SkillBundle
    taskId?: string
    convLog?: import("../core/conversation-logger.ts").ConversationLog
    timeoutMs?: number
  }): Promise<RunResult> {
    let skillLoaded: boolean | undefined

    if (task.skill) {
      if (task.skill.mode === "inject") {
        // Inject mode: write skill content to CONTEXT.md (opencode auto-loads into system prompt)
        await Bun.write(path.join(task.workDir, "CONTEXT.md"), task.skill.content)
        // skillLoaded will be verified from NDJSON events below
        skillLoaded = false
      } else {
        // Discover mode (current behavior): copy to .opencode/skills/<name>/
        const skillName = task.skill.meta.name
        const skillDesc = task.skill.meta.description
        const skillDir = path.join(task.workDir, ".opencode", "skills", skillName)
        await mkdir(skillDir, { recursive: true })
        const frontmatter = `---\nname: ${skillName}\ndescription: ${skillDesc}\n---\n\n`
        await Bun.write(path.join(skillDir, "SKILL.md"), frontmatter + task.skill.content)
        // skillLoaded will be determined by checking NDJSON output below
        skillLoaded = false
      }
    }

    const startMs = performance.now()

    // Prepend directive to suppress clarification questions in non-interactive bench mode
    const prompt = `IMPORTANT: Do not ask clarifying questions. Proceed directly with implementation. Execute all steps immediately without waiting for user input.\n\n${task.prompt}`

    const agentFlag = this.mode === "native" ? this.nativeAgent : "build"
    const cmd = [
      ...this.cmdPrefix,
      "run",
      prompt,
      "--dir", task.workDir,
      "--model", this.model,
      "--agent", agentFlag,
      "--pure",
      "--format", "json",
      ...this.extraCliArgs,
    ]

    const { stdout, stderr, exitCode, timedOut } = await runSubprocess(cmd, {
      cwd: task.workDir,
      timeoutMs: task.timeoutMs ?? this.timeoutMs,
      env: this.envOverlay,
    })

    const durationMs = performance.now() - startMs

    if (exitCode !== 0 && stderr) {
      log.warn(`opencode exited with code ${exitCode}: ${stderr.slice(0, 2000)}`)
    }

    // Save raw NDJSON to convLog path if available
    if (task.convLog && stdout.trim()) {
      try {
        const destDir = path.dirname(task.convLog.filePath)
        await mkdir(destDir, { recursive: true })
        await Bun.write(task.convLog.filePath, stdout)
        log.debug(`Saved opencode NDJSON to ${task.convLog.filePath}`)
      } catch (err) {
        log.warn(`Failed to save opencode NDJSON: ${err}`)
      }
    }

    const events = parseNDJSON(stdout)

    // Verify skill was actually loaded from events
    if (task.skill && skillLoaded === false) {
      // Extract a recognizable snippet from skill content for matching
      const skillSnippet = task.skill.content.replace(/^#.*\n/m, "").trim().slice(0, 60)

      for (const event of events) {
        if (skillLoaded) break
        const part = event.part ?? {}

        if (task.skill.mode === "discover" && event.type === "tool_use") {
          // Discover: check if agent called the `skill` tool
          const toolName = (part.tool as string) ?? (part.name as string) ?? ""
          if (toolName === "skill") {
            skillLoaded = true
          }
        }

        if (task.skill.mode === "inject") {
          // Inject: CONTEXT.md loaded into system prompt — verify agent shows
          // awareness by checking if any step_finish event exists (agent ran with
          // the instructions), AND if the CONTEXT.md file was consumed
          if (event.type === "step_finish") {
            // Agent completed at least one step with the injected instructions
            const contextFile = Bun.file(path.join(task.workDir, "CONTEXT.md"))
            if (await contextFile.exists()) {
              skillLoaded = true
            }
          }
        }

        // Both modes: check if agent text references skill content
        if (event.type === "text" && skillSnippet.length > 20) {
          const text = (part.text as string) ?? ""
          if (text.includes(skillSnippet)) {
            skillLoaded = true
          }
        }
      }
    }

    const builder = eventsToRunRecord(events)
    const verdict = await subprocessVerdict({
      label: "opencode",
      timedOut,
      exitCode,
      timeoutMs: task.timeoutMs ?? this.timeoutMs,
      stderr,
      diagnose: () => diagnoseOpencode({
        sandboxRoot: this.sandbox?.root ?? "",
        stdout,
        stderr,
        exitCode,
      }),
      warn: (msg) => log.warn(msg),
    })

    return builder.finish({ workDir: task.workDir, durationMs, skillLoaded, ...verdict })
  }

  /**
   * Container-mode opencode: launch skvm-opencode-runtime with workDir
   * bind-mounted at /app, then `docker exec opencode …` there. Mirrors the
   * pi + claude-code adapter container branches (see pi.ts:runInContainer
   * and claude-code.ts:runInContainer for the shared rationale — model-
   * issued shell commands run in a clean Ubuntu root, not the Windows host
   * via MSYS).
   *
   * Native mode is not yet supported for container path (bench always uses
   * managed mode). Attempting native → clear error, tell the user to switch.
   *
   * Opencode's advantage over the other two adapters: its provider config
   * comes via OPENCODE_CONFIG_CONTENT env var (a JSON string), not a file.
   * So container mode just passes the same cached JSON string through -e —
   * no per-run sandbox directory needed.
   */
  private async runInContainer(task: {
    prompt: string
    workDir: string
    skill?: SkillBundle
    taskId?: string
    convLog?: import("../core/conversation-logger.ts").ConversationLog
    timeoutMs?: number
    tbDockerImage?: string
  }): Promise<RunResult> {
    if (this.mode === "native") {
      throw new Error(
        "opencode (container mode): native adapter-config is not supported " +
        "inside containers yet — the host ~/.config/opencode is not mounted. " +
        "Switch to --adapter-config=managed, or set SKVM_OC_HOST_MODE=1 to run " +
        "on the host.",
      )
    }
    if (!this.opencodeConfigContent) {
      throw new Error(
        "opencode (container mode): managed setup did not produce a config " +
        "content (route must be openai-compatible). Anthropic / native " +
        "routes are not yet supported in container mode.",
      )
    }

    let skillLoaded: boolean | undefined

    // Skill staging is the SAME as host mode — files live under workDir and
    // the container sees them at /app via the mount.
    if (task.skill) {
      skillLoaded = false
      if (task.skill.mode === "inject") {
        await Bun.write(path.join(task.workDir, "CONTEXT.md"), task.skill.content)
      } else {
        const skillName = task.skill.meta.name
        const skillDesc = task.skill.meta.description
        const skillDir = path.join(task.workDir, ".opencode", "skills", skillName)
        await mkdir(skillDir, { recursive: true })
        const frontmatter = `---\nname: ${skillName}\ndescription: ${skillDesc}\n---\n\n`
        await Bun.write(path.join(skillDir, "SKILL.md"), frontmatter + task.skill.content)
      }
    }

    const startMs = performance.now()
    const timeoutMs = task.timeoutMs ?? this.timeoutMs

    // Container env: API keys + OPENCODE_CONFIG_CONTENT (verbatim from setup).
    // XDG_* is deliberately NOT set — the container is a fresh /root every run,
    // no user global config to shield from, and letting opencode use its own
    // defaults (~/.config/opencode) is simpler.
    // OPENCODE_DISABLE_PROJECT_CONFIG stays on: even in-container we don't
    // want opencode auto-loading /app/.opencode as project-scoped config.
    const env: Record<string, string> = {
      ...this.routeEnv,
      OPENCODE_CONFIG_CONTENT: this.opencodeConfigContent,
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    }

    const container = await startContainer({
      image: "skvm-opencode-runtime:latest",
      mounts: [{ host: task.workDir, container: "/app", mode: "rw" }],
      env,
      workDir: "/app",
      // Lifetime > task timeout so cleanup can rm -f cleanly even after a kill.
      lifetimeMs: timeoutMs + 60_000,
    })

    try {
      const prompt = `IMPORTANT: Do not ask clarifying questions. Proceed directly with implementation. Execute all steps immediately without waiting for user input.\n\n${task.prompt}`

      const agentFlag = this.mode === "managed" ? "build" : this.nativeAgent
      const opencodeCmd = [
        "opencode",
        "run",
        prompt,
        "--dir", "/app",
        "--model", this.model,
        "--agent", agentFlag,
        "--pure",
        "--format", "json",
        ...this.extraCliArgs,
      ]

      log.info(`opencode (container): image=skvm-opencode-runtime:latest container=${container.name} model=${this.model}`)

      const convLogPath = task.convLog?.filePath
      const { stdout, stderr, exitCode, timedOut } = await execInContainer({
        cmd: opencodeCmd,
        container,
        cwd: "/app",
        timeoutMs,
        stdoutSink: convLogPath,
      })

      const durationMs = performance.now() - startMs

      if (exitCode !== 0 && stderr) {
        log.warn(`opencode (container) exited with code ${exitCode}: ${stderr.slice(0, 2000)}`)
      }

      // If we streamed to disk we need to read it back to parse events;
      // otherwise stdout is the entire payload.
      let ndjsonText = stdout
      if (convLogPath && !stdout) {
        const convLogFile = Bun.file(convLogPath)
        if (await convLogFile.exists()) {
          try {
            ndjsonText = await convLogFile.text()
          } catch (err) {
            log.warn(`Failed to read opencode NDJSON from ${convLogPath}: ${err}`)
          }
        }
      }

      const events = parseNDJSON(ndjsonText)

      // Verify skill was actually loaded from events — same logic as host branch.
      if (task.skill && skillLoaded === false) {
        const skillSnippet = task.skill.content.replace(/^#.*\n/m, "").trim().slice(0, 60)

        for (const event of events) {
          if (skillLoaded) break
          const part = event.part ?? {}

          if (task.skill.mode === "discover" && event.type === "tool_use") {
            const toolName = (part.tool as string) ?? (part.name as string) ?? ""
            if (toolName === "skill") {
              skillLoaded = true
            }
          }

          if (task.skill.mode === "inject" && event.type === "step_finish") {
            const contextFile = Bun.file(path.join(task.workDir, "CONTEXT.md"))
            if (await contextFile.exists()) {
              skillLoaded = true
            }
          }

          if (event.type === "text" && skillSnippet.length > 20) {
            const text = (part.text as string) ?? ""
            if (text.includes(skillSnippet)) {
              skillLoaded = true
            }
          }
        }
      }

      const builder = eventsToRunRecord(events)
      const verdict = await subprocessVerdict({
        label: "opencode",
        timedOut,
        exitCode,
        timeoutMs,
        stderr,
        diagnose: () => diagnoseOpencode({
          sandboxRoot: this.sandbox?.root ?? "",
          stdout: ndjsonText,
          stderr,
          exitCode,
        }),
        warn: (msg) => log.warn(msg),
      })

      return builder.finish({ workDir: task.workDir, durationMs, skillLoaded, ...verdict })
    } finally {
      await container.cleanup()
    }
  }

  async teardown(): Promise<void> {
    this.sandbox?.teardown()
    this.sandbox = undefined
  }
}

