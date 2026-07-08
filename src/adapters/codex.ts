import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import type { AgentAdapter, AdapterConfig, AdapterConfigMode, ProviderRoute, RunResult, TokenUsage, SkillBundle } from "../core/types.ts"
import { emptyTokenUsage } from "../core/types.ts"
import { RunRecordBuilder } from "../core/run-record.ts"
import { createLogger } from "../core/logger.ts"
import { estimateCost } from "../core/cost.ts"
import { getAdapterRepoDir, getAdapterSettings, expandHome } from "../core/config.ts"
import { envForRoute, resolveBackendModel, resolveRoute, validateModelIdForRoute } from "../providers/registry.ts"
import { diagnoseCodex } from "./diagnose-failure.ts"
import { subprocessVerdict } from "./subprocess-verdict.ts"
import { runSubprocess } from "../core/subprocess.ts"
import { TASK_FILE_DEFAULTS } from "../core/ui-defaults.ts"
import {
  createSandbox,
  ensureDir,
  copyFileIfExists,
  buildCodexConfigContent,
  type Sandbox,
} from "../core/adapter-sandbox.ts"

const log = createLogger("codex")

// ---------------------------------------------------------------------------
// JSONL Event Types (from `codex exec --json`)
// ---------------------------------------------------------------------------
//
// The stream is a flat sequence of top-level events. Verified against Codex
// CLI 0.142.3:
//
//   {"type":"thread.started","thread_id":"..."}
//   {"type":"turn.started"}
//   {"type":"item.started","item":{...}}      ← ignored (we score completed items)
//   {"type":"item.completed","item":{...}}
//   {"type":"error","message":"Reconnecting... 2/5 ..."}   ← often transient
//   {"type":"turn.completed","usage":{...}}
//   {"type":"turn.failed","error":{"message":"..."}}
//
// `item.completed` carries an `item` whose `type` is one of:
//   agent_message      { id, type, text }
//   reasoning          { id, type, text }
//   command_execution  { id, type, command, aggregated_output, exit_code, status }
//   file_change        { id, type, changes: [{ path, kind }], status }
//   error              { id, type, message }   ← non-fatal transport notice
// Unknown item types are preserved in the raw convLog but not turned into steps.

export interface CodexItemChange {
  path?: string
  kind?: string
}

export interface CodexItem {
  id?: string
  type?: string
  text?: string
  command?: string
  aggregated_output?: string
  exit_code?: number
  changes?: CodexItemChange[]
  status?: string
  message?: string
  [k: string]: unknown
}

export interface CodexUsage {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  [k: string]: unknown
}

export interface CodexEvent {
  type: string
  thread_id?: string
  item?: CodexItem
  usage?: CodexUsage
  error?: { message?: string } | string
  message?: string
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

export function parseCodexJSONL(output: string): CodexEvent[] {
  const events: CodexEvent[] = []
  for (const line of output.split("\n")) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as CodexEvent
      if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
        events.push(parsed)
      }
    } catch {
      log.debug(`Skipping non-JSON line: ${line.slice(0, 120)}`)
    }
  }
  return events
}

// ---------------------------------------------------------------------------
// Event → RunResult
// ---------------------------------------------------------------------------

/**
 * Codex reports OpenAI-style usage where `cached_input_tokens` is a SUBSET of
 * `input_tokens` (unlike Anthropic, where the two are disjoint). skvm's
 * `TokenUsage` keeps `input` and `cacheRead` disjoint so `estimateCost` bills
 * them separately, so we subtract the cached portion out of the input count.
 * `reasoning_output_tokens` is already included in `output_tokens` per OpenAI's
 * accounting, so it is not added again. Codex has no cache-write concept.
 */
export function fromCodexUsage(u: CodexUsage | undefined): TokenUsage {
  if (!u) return emptyTokenUsage()
  const cached = u.cached_input_tokens ?? 0
  const rawInput = u.input_tokens ?? 0
  return {
    input: Math.max(0, rawInput - cached),
    output: u.output_tokens ?? 0,
    cacheRead: cached,
    cacheWrite: 0,
  }
}

/** Pull a human message out of an `error` event / `turn.failed` payload. */
function errorText(err: CodexEvent["error"] | undefined, message: string | undefined): string | undefined {
  if (typeof message === "string" && message.trim()) return message.trim()
  if (typeof err === "string" && err.trim()) return err.trim()
  if (err && typeof err === "object" && typeof err.message === "string" && err.message.trim()) {
    return err.message.trim()
  }
  return undefined
}

/**
 * `error` events are also emitted for transient transport hiccups Codex
 * recovers from on its own ("Reconnecting... 2/5 ...", "Falling back from
 * WebSockets to HTTPS transport ..."). Those are not run failures — the real
 * failure is `turn.failed` / a non-zero exit — so they are filtered out of the
 * error accounting.
 */
export function isTransientCodexError(msg: string): boolean {
  return /^reconnecting\b/i.test(msg)
    || /falling back from websockets/i.test(msg)
}

/**
 * `computeCost` lets the adapter inject model-based pricing (Codex reports token
 * usage but never a USD cost). Omitted in unit tests, where cost stays 0 while
 * `usageAvailable` still reflects that real token telemetry was present.
 */
export function eventsToRunRecord(
  events: CodexEvent[],
  computeCost?: (tokens: TokenUsage) => number,
): RunRecordBuilder {
  // Each completed item is its own discrete step; the last agent_message wins
  // as the final text (RunRecordBuilder's default last-non-empty-text policy).
  const builder = new RunRecordBuilder()
  let finalUsage: TokenUsage | undefined
  let turnFailedMsg: string | undefined
  const errors: string[] = []

  for (const ev of events) {
    if (ev.type === "item.completed") {
      const it = ev.item
      if (!it || typeof it !== "object") continue
      const ts = Date.now()
      switch (it.type) {
        case "agent_message":
        case "reasoning": {
          if (typeof it.text === "string" && it.text) builder.assistantText(it.text, ts)
          break
        }
        case "command_execution": {
          builder.toolStep([{
            id: it.id ?? `cmd-${builder.stepCount}`,
            name: "shell",
            input: { command: it.command ?? "" },
            output: it.aggregated_output ?? "",
            ...(typeof it.exit_code === "number" ? { exitCode: it.exit_code } : {}),
          }], ts)
          break
        }
        case "file_change": {
          builder.toolStep([{
            id: it.id ?? `patch-${builder.stepCount}`,
            name: "apply_patch",
            input: { changes: it.changes ?? [] },
          }], ts)
          break
        }
        case "error": {
          // Non-fatal transport notice delivered as a completed item.
          const m = typeof it.message === "string" ? it.message : undefined
          if (m && !isTransientCodexError(m)) errors.push(m)
          break
        }
        // Unknown item types (mcp_tool_call, web_search, todo_list, …) are
        // left in the raw convLog but not synthesized into steps.
      }
      continue
    }

    if (ev.type === "turn.completed") {
      finalUsage = fromCodexUsage(ev.usage)
      continue
    }

    if (ev.type === "turn.failed") {
      turnFailedMsg = errorText(ev.error, undefined) ?? "codex turn failed"
      continue
    }

    if (ev.type === "error") {
      const m = errorText(ev.error, ev.message)
      if (m && !isTransientCodexError(m)) errors.push(m)
      continue
    }
    // thread.started / turn.started / item.started / thread.completed: ignored.
  }

  if (finalUsage) {
    builder.usageTotalOverride(finalUsage)
    if (computeCost) builder.cost(computeCost(finalUsage))
  }

  // A turn.failed message is authoritative; otherwise fall back to the last
  // non-transient error event.
  const failMsg = turnFailedMsg ?? (errors.length > 0 ? errors[errors.length - 1] : undefined)
  const noOutput = builder.stepCount === 0
  builder.parseNote({
    statusDetail: noOutput
      ? failMsg
        ? `codex failed: ${failMsg}`
        : `codex produced no parseable items — telemetry only, workDir scored as-is`
      : undefined,
    adapterError: failMsg && noOutput
      ? { exitCode: 1, stderr: failMsg }
      : undefined,
  })

  return builder
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

export interface CodexResolution {
  cmd: string[]
  env: Record<string, string>
}

const INSTALL_HELP = "See https://developers.openai.com/codex for setup."

type TierHit = { resolution: CodexResolution; logLine: string }
type Tier = () => Promise<TierHit | null>

// Throws if the user pinned an env override that doesn't exist — better to
// surface that loudly than to silently fall through.
const tierEnvOverride: Tier = async () => {
  const raw = process.env.SKVM_CODEX_CMD
  if (!raw) return null
  const binaryPath = expandHome(raw.trim())
  if (!(await Bun.file(binaryPath).exists())) {
    throw new Error(`SKVM_CODEX_CMD does not exist: ${binaryPath}`)
  }
  return {
    resolution: { cmd: [binaryPath], env: {} },
    logLine: `Using SKVM_CODEX_CMD: ${binaryPath}`,
  }
}

const tierAdapterRepo: Tier = async () => {
  const repoDir = getAdapterRepoDir("codex")
  if (!repoDir) return null
  if (!(await Bun.file(repoDir).exists())) {
    throw new Error(`adapters.codex.repoPath does not exist: ${repoDir}`)
  }
  return {
    resolution: { cmd: [repoDir], env: {} },
    logLine: `Using configured codex binary: ${repoDir}`,
  }
}

const tierGlobal: Tier = async () => {
  const { exitCode, stdout } = await runSubprocess(["which", "codex"])
  if (exitCode !== 0 || !stdout.trim()) return null
  const p = stdout.trim()
  return { resolution: { cmd: [p], env: {} }, logLine: `Using global codex: ${p}` }
}

async function resolveTiers(tiers: Tier[], notFoundMsg: string): Promise<CodexResolution> {
  for (const tier of tiers) {
    const hit = await tier()
    if (hit) {
      log.info(hit.logLine)
      return hit.resolution
    }
  }
  throw new Error(`${notFoundMsg} ${INSTALL_HELP}`)
}

export async function resolveAdapterCodexCmd(): Promise<CodexResolution> {
  return resolveTiers(
    [tierEnvOverride, tierAdapterRepo, tierGlobal],
    "codex binary not found for adapter. Tried: $SKVM_CODEX_CMD, skvm.config.json → adapters.codex, and global `which codex`.",
  )
}

// ---------------------------------------------------------------------------
// User-config discovery (native mode)
// ---------------------------------------------------------------------------

const HOME = process.env.HOME ?? ""

/** Codex reads its config + credentials from `$CODEX_HOME` (default `~/.codex`). */
export function resolveUserCodexHome(): string {
  const explicit = process.env.CODEX_HOME?.trim()
  if (explicit) return explicit
  return path.join(HOME, ".codex")
}

// ---------------------------------------------------------------------------
// Skill-mode helpers
// ---------------------------------------------------------------------------

/**
 * Sentinel written into the injected AGENTS.md so we can detect — by grepping
 * the model's own text — whether it actually read the injected instructions.
 * Mirrors the CONTEXT.md trick in opencode.ts and the append-system-prompt
 * sentinel in claude-code.ts.
 */
const SKILL_INJECT_SENTINEL = "<skvm-skill-injected/>"

function injectedAgentsDoc(skillContent: string): string {
  return `${SKILL_INJECT_SENTINEL}\n\n${skillContent}`
}

/** Every completed item text (agent_message / reasoning) — used for detection. */
function completedItemTexts(events: CodexEvent[]): string[] {
  const out: string[] = []
  for (const ev of events) {
    if (ev.type !== "item.completed") continue
    const it = ev.item
    if (it && typeof it.text === "string" && it.text) out.push(it.text)
  }
  return out
}

function hasCompletedStep(events: CodexEvent[]): boolean {
  return events.some((ev) =>
    ev.type === "item.completed"
    && ev.item?.type != null
    && ev.item.type !== "error")
}

export function detectSkillInject(events: CodexEvent[], snippet: string): boolean {
  for (const text of completedItemTexts(events)) {
    if (text.includes(SKILL_INJECT_SENTINEL)) return true
    if (snippet.length > 20 && text.includes(snippet)) return true
  }
  // AGENTS.md is auto-loaded into context; if the model produced any real
  // output at all, the injected instructions were in front of it.
  return hasCompletedStep(events)
}

/**
 * Codex loads a skill by shelling out to read its SKILL.md, so the reliable
 * discover signal is a command_execution whose command references the skill's
 * SKILL.md path (or the `skills/<name>/` segment). The model also tends to name
 * the skill in its narration, which we accept as a fallback.
 */
export function detectSkillDiscover(events: CodexEvent[], skillName: string): boolean {
  const skillSegment = `skills/${skillName}/`
  const mentionsSkill = (s: unknown): boolean =>
    typeof s === "string" && (s.includes(skillSegment) || s.includes(`\`${skillName}\``))

  for (const ev of events) {
    if (ev.type !== "item.completed") continue
    const it = ev.item
    if (!it) continue
    if (it.type === "command_execution" && mentionsSkill(it.command)) return true
    if ((it.type === "agent_message" || it.type === "reasoning") && mentionsSkill(it.text)) return true
  }
  return false
}

/** Repo-scoped skill location Codex scans from the run cwd. */
export function resolveCodexDiscoverSkillDir(workDir: string, skillName: string): string {
  return path.join(workDir, ".agents", "skills", skillName)
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class CodexAdapter implements AgentAdapter {
  readonly name = "codex"
  private model = ""
  private timeoutMs: number = TASK_FILE_DEFAULTS.timeoutMs
  private cmdPrefix: string[] = []
  private envOverlay: Record<string, string> = {}
  private mode: AdapterConfigMode = "managed"
  private extraCliArgs: string[] = []
  private sandbox: Sandbox | undefined

  async setup(config: AdapterConfig): Promise<void> {
    this.model = config.model
    this.timeoutMs = config.timeoutMs ?? TASK_FILE_DEFAULTS.timeoutMs
    this.mode = config.mode ?? "managed"

    const settings = getAdapterSettings("codex")
    this.extraCliArgs = config.extraCliArgs ?? settings.extraCliArgs ?? []

    // Resolve the route once. Managed mode requires it (and rejects anthropic
    // routes — Codex speaks the OpenAI wire only); native mode tolerates its
    // absence, since the user's copied config.toml / auth.json carries auth.
    let route: ProviderRoute | undefined
    try {
      route = resolveRoute(this.model)
      validateModelIdForRoute(this.model, route)
    } catch (err) {
      if (this.mode === "managed") {
        throw new Error(`codex (managed): ${(err as Error).message}`)
      }
      log.debug(`native mode: no providers.routes entry for ${this.model} — relying on copied config.toml / auth.json`)
    }

    if (this.mode === "managed" && route && route.kind === "anthropic") {
      throw new Error(
        `codex (managed) cannot use anthropic routes; route "${route.match}" is kind=anthropic. ` +
        `Codex speaks the OpenAI API only — use an openai-compatible or openrouter route, ` +
        `or switch to --adapter-config=native to use Codex's own auth (ChatGPT login / API key).`,
      )
    }

    const userHome = this.mode === "native" ? resolveUserCodexHome() : ""
    if (this.mode === "native") {
      const configFile = path.join(userHome, "config.toml")
      const authFile = path.join(userHome, "auth.json")
      if (!(await Bun.file(configFile).exists()) && !(await Bun.file(authFile).exists())) {
        throw new Error(
          `codex (native): neither ${configFile} nor ${authFile} found. Run codex's own setup ` +
          `(\`codex login\`) first, or switch to --adapter-config=managed.`,
        )
      }
    }

    const resolved = await resolveAdapterCodexCmd()
    this.cmdPrefix = resolved.cmd

    this.sandbox = createSandbox("codex")
    const root = this.sandbox.root
    ensureDir(root)

    // envForRoute resolves the route again internally; tolerated to fail in
    // native mode where auth lives in the copied config.toml / auth.json.
    let routeEnv: Record<string, string> = {}
    try {
      routeEnv = envForRoute(config.model)
    } catch (err) {
      if (this.mode === "managed") throw err
    }

    this.envOverlay = {
      ...resolved.env,
      ...routeEnv,
      CODEX_HOME: root,
    }

    if (this.mode === "native") {
      // auth.json holds the ChatGPT OAuth tokens (or the stored API key). Copy
      // (not symlink) so a token refresh inside the sandbox can't clobber the
      // user's real credentials. config.toml carries model/provider settings.
      copyFileIfExists(path.join(userHome, "auth.json"), path.join(root, "auth.json"))
      copyFileIfExists(path.join(userHome, "config.toml"), path.join(root, "config.toml"))
      copyFileIfExists(path.join(userHome, "AGENTS.md"), path.join(root, "AGENTS.md"))
      // Deliberately NOT symlinking any user skill library — bench discover
      // mode stages the one skill under test into the run workDir. See run().
    } else {
      const configToml = buildCodexConfigContent(route!, resolveBackendModel(this.model))
      await Bun.write(path.join(root, "config.toml"), configToml)
    }

    log.info(`codex command: ${this.cmdPrefix.join(" ")}`)
    log.info(`codex model: ${this.model} (mode=${this.mode}, sandbox=${root})`)
  }

  async run(task: {
    prompt: string
    workDir: string
    skill?: SkillBundle
    taskId?: string
    convLog?: import("../core/conversation-logger.ts").ConversationLog
    timeoutMs?: number
  }): Promise<RunResult> {
    let skillLoaded: boolean | undefined

    if (task.skill) {
      skillLoaded = false
      if (task.skill.mode === "inject") {
        // AGENTS.md is Codex's auto-loaded instructions file (its analog of
        // CLAUDE.md). Append so a task-provided AGENTS.md isn't clobbered.
        const agentsPath = path.join(task.workDir, "AGENTS.md")
        const existing = await Bun.file(agentsPath).exists()
          ? await Bun.file(agentsPath).text()
          : ""
        const injected = injectedAgentsDoc(task.skill.content)
        await Bun.write(agentsPath, existing ? `${existing}\n\n${injected}` : injected)
      } else {
        // Discover: Codex scans repo-scoped skills under .agents/skills from
        // the run cwd up to the repo root. Stage the current skill in the
        // disposable workDir instead of touching the user's skill library.
        const skillDir = resolveCodexDiscoverSkillDir(task.workDir, task.skill.meta.name)
        await rm(skillDir, { recursive: true, force: true })
        await mkdir(skillDir, { recursive: true })
        const frontmatter = `---\nname: ${task.skill.meta.name}\ndescription: ${task.skill.meta.description}\n---\n\n`
        await Bun.write(path.join(skillDir, "SKILL.md"), frontmatter + task.skill.content)
      }
    }

    const startMs = performance.now()

    const prompt = `IMPORTANT: Do not ask clarifying questions. Proceed directly with implementation. Execute all steps immediately without waiting for user input.\n\n${task.prompt}`

    // Codex accepts its native model ids verbatim (dot form, e.g. "gpt-5.5");
    // strip only skvm's routing prefix.
    const cliModel = resolveBackendModel(this.model)

    // `-s danger-full-access` + `approval_policy="never"` gives fully-autonomous,
    // non-interactive execution — the Codex analog of Claude Code's
    // bypassPermissions. skvm already runs each task in a disposable workDir.
    // `--skip-git-repo-check` because task workDirs are not necessarily git repos.
    const cmd = [
      ...this.cmdPrefix,
      "exec", prompt,
      "--json",
      "--skip-git-repo-check",
      "-C", task.workDir,
      "--model", cliModel,
      "-s", "danger-full-access",
      "-c", `approval_policy="never"`,
      ...this.extraCliArgs,
    ]

    const { stdout, stderr, exitCode, timedOut } = await runSubprocess(cmd, {
      cwd: task.workDir,
      timeoutMs: task.timeoutMs ?? this.timeoutMs,
      env: this.envOverlay,
    })

    const durationMs = performance.now() - startMs

    if (exitCode !== 0 && stderr) {
      log.warn(`codex exited with code ${exitCode}: ${stderr.slice(0, 2000)}`)
    }

    if (task.convLog && stdout.trim()) {
      try {
        const destDir = path.dirname(task.convLog.filePath)
        await mkdir(destDir, { recursive: true })
        await Bun.write(task.convLog.filePath, stdout)
        log.debug(`Saved codex JSONL to ${task.convLog.filePath}`)
      } catch (err) {
        log.warn(`Failed to save codex JSONL: ${err}`)
      }
    }

    const events = parseCodexJSONL(stdout)

    if (task.skill && skillLoaded === false) {
      if (task.skill.mode === "inject") {
        const snippet = task.skill.content.replace(/^#.*\n/m, "").trim().slice(0, 60)
        skillLoaded = detectSkillInject(events, snippet)
      } else {
        skillLoaded = detectSkillDiscover(events, task.skill.meta.name)
      }
    }

    const builder = eventsToRunRecord(events, (tokens) => estimateCost(this.model, tokens))
    const verdict = await subprocessVerdict({
      label: "codex",
      timedOut,
      exitCode,
      timeoutMs: task.timeoutMs ?? this.timeoutMs,
      stderr,
      diagnose: () => diagnoseCodex({
        sandboxRoot: this.sandbox?.root ?? "",
        stdout,
        stderr,
        exitCode,
      }),
      warn: (msg) => log.warn(msg),
    })

    return builder.finish({ workDir: task.workDir, durationMs, skillLoaded, ...verdict })
  }

  async teardown(): Promise<void> {
    this.sandbox?.teardown()
    this.sandbox = undefined
  }
}
