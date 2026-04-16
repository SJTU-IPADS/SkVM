import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { AgentAdapter, AdapterConfig, RunResult, AgentStep, ToolCall, TokenUsage, SkillMode } from "../core/types.ts"
import { emptyTokenUsage } from "../core/types.ts"
import { createLogger } from "../core/logger.ts"
import { getAdapterRepoDir } from "../core/config.ts"
import { TASK_FILE_DEFAULTS } from "../core/ui-defaults.ts"

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

export function eventsToRunResult(
  events: OpenCodeEvent[],
  workDir: string,
  durationMs: number,
): RunResult {
  const steps: AgentStep[] = []
  let totalTokens = emptyTokenUsage()
  let totalCost = 0
  let finalText = ""
  const errors: string[] = []

  for (const event of events) {
    const part = event.part ?? {}

    if (event.type === "text") {
      const text = (part.text as string) ?? ""
      if (text) {
        finalText = text
        steps.push({
          role: "assistant",
          text,
          toolCalls: [],
          timestamp: event.timestamp ?? Date.now(),
        })
      }
    } else if (event.type === "tool_use") {
      const state = (part.state as Record<string, unknown>) ?? {}
      const toolCall: ToolCall = {
        id: (part.callID as string) ?? (part.id as string) ?? `tc-${Date.now()}`,
        name: (part.tool as string) ?? (part.name as string) ?? "",
        input: (state.input as Record<string, unknown>) ?? {},
        output: (state.output as string) ?? (state.error as string) ?? undefined,
      }
      steps.push({
        role: "tool",
        toolCalls: [toolCall],
        timestamp: event.timestamp ?? Date.now(),
      })
    } else if (event.type === "step_finish") {
      // OpenCode puts token usage and cost in step_finish events
      extractStepFinishTokens(part, totalTokens, (t) => { totalTokens = t }, (c) => { totalCost += c })
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
  const noOutput = steps.length === 0
  const statusDetail = noOutput
    ? errors.length > 0
      ? `opencode emitted ${errors.length} error event(s) and no steps — telemetry only`
      : `opencode produced no parseable events — telemetry only, workDir scored as-is`
    : undefined

  const result: RunResult = {
    text: finalText,
    steps,
    tokens: totalTokens,
    cost: totalCost,
    durationMs,
    llmDurationMs: 0,
    workDir,
    runStatus: "ok",
    ...(statusDetail ? { statusDetail } : {}),
  }

  // Surface error events as adapterError when the agent produced no useful output
  if (errors.length > 0 && noOutput) {
    result.adapterError = { exitCode: 1, stderr: errors.join("; ") || "opencode error (no details)" }
  }

  return result
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
export function extractStepFinishTokens(
  part: Record<string, unknown>,
  current: TokenUsage,
  setTokens: (t: TokenUsage) => void,
  addCost: (c: number) => void,
) {
  const tokens = part.tokens as Record<string, unknown> | undefined
  if (tokens && typeof tokens === "object") {
    const cache = (tokens.cache as Record<string, unknown>) ?? {}
    setTokens({
      input: current.input + ((tokens.input as number) ?? 0),
      output: current.output + ((tokens.output as number) ?? 0),
      cacheRead: current.cacheRead + ((cache.read as number) ?? 0),
      cacheWrite: current.cacheWrite + ((cache.write as number) ?? 0),
    })
  }

  if (typeof part.cost === "number") {
    addCost(part.cost)
  }
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

/**
 * Compute the skvm install root when running as a compiled Bun binary. Returns
 * null when running via `bun run src/index.ts` (dev) or from a Node shim — in
 * those cases the bundled-opencode tier is skipped.
 *
 * The compiled binary lives at `<root>/bin/skvm`; resolve two-dirname-up.
 */
function getSkvmInstallRoot(): string | null {
  const execPath = process.execPath
  const base = path.basename(execPath)
  if (base === "skvm") {
    return path.dirname(path.dirname(execPath))
  }
  return null
}

/**
 * Resolve opencode CLI command. Priority:
 *   0. skvm-private bundled opencode at <install-root>/vendor/opencode/current/bin/opencode
 *      — isolated with XDG/HOME env overlay pointing at vendor/opencode/profile/
 *   1. Custom path from skvm.config.json → adapters.opencode
 *   2. Globally installed `opencode` via `which opencode`
 */
export async function resolveOpenCodeCmd(): Promise<OpenCodeResolution> {
  // 0. skvm-private bundled opencode (populated by install.sh / postinstall.js)
  const installRoot = getSkvmInstallRoot()
  if (installRoot) {
    const bundled = path.join(installRoot, "vendor", "opencode", "current", "bin", "opencode")
    if (await Bun.file(bundled).exists()) {
      const profileRoot = path.join(installRoot, "vendor", "opencode", "profile")
      const env: Record<string, string> = {
        XDG_CONFIG_HOME: path.join(profileRoot, "config"),
        XDG_DATA_HOME: path.join(profileRoot, "data"),
        XDG_STATE_HOME: path.join(profileRoot, "state"),
        XDG_CACHE_HOME: path.join(profileRoot, "cache"),
      }
      log.info(`Using skvm-bundled opencode: ${bundled} (profile: ${profileRoot})`)
      return { cmd: [bundled], env }
    }
  }

  // 1. Custom path from config
  const repoDir = getAdapterRepoDir("opencode")
  if (repoDir) {
    const pkgDir = path.join(repoDir, "packages/opencode")

    // Prefer source (always up-to-date with latest model registry)
    const entryPoint = path.join(pkgDir, "src/index.ts")
    if (await Bun.file(entryPoint).exists()) {
      log.info(`Using opencode from source: ${repoDir}`)
      return { cmd: ["bun", "run", "--cwd", pkgDir, "--conditions=browser", "src/index.ts", "--"], env: {} }
    }

    // Fallback: compiled binary
    const platformMap: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" }
    const archMap: Record<string, string> = { x64: "x64", arm64: "arm64" }
    const plat = platformMap[process.platform] ?? process.platform
    const arch = archMap[process.arch] ?? process.arch
    const binaryPath = path.join(pkgDir, "dist", `opencode-${plat}-${arch}`, "bin", "opencode")
    if (await Bun.file(binaryPath).exists()) {
      log.info(`Using opencode binary: ${binaryPath}`)
      return { cmd: [binaryPath], env: {} }
    }

    throw new Error(
      `opencode not found at ${repoDir} (no binary in dist/ and no src/index.ts)`,
    )
  }

  // 2. Global install
  const { exitCode, stdout } = await runCommand(["which", "opencode"])
  if (exitCode === 0 && stdout.trim()) {
    log.info(`Using global opencode: ${stdout.trim()}`)
    return { cmd: [stdout.trim()], env: {} }
  }

  throw new Error(
    "opencode not found. Tried: skvm-bundled copy (reinstall skvm via install.sh or npm), " +
      "skvm.config.json → adapters.opencode, and global `which opencode`. " +
      "See https://skillvm.ai/install for setup.",
  )
}

/**
 * Translate model ID to opencode format.
 *
 * Bench config model IDs are all in OpenRouter format (e.g., `anthropic/claude-haiku-4.5`,
 * `qwen/qwen3.5-9b`). OpenCode routes these through its openrouter provider as
 * `openrouter/anthropic/claude-haiku-4.5`.
 *
 * If the model already starts with `openrouter/`, pass through as-is.
 */
export function toOpenCodeModel(model: string): string {
  if (model.startsWith("openrouter/")) return model
  return `openrouter/${model}`
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly name = "opencode"
  private model = ""
  private timeoutMs: number = TASK_FILE_DEFAULTS.timeoutMs
  private cmdPrefix: string[] = []
  private envOverlay: Record<string, string> = {}

  async setup(config: AdapterConfig): Promise<void> {
    this.model = toOpenCodeModel(config.model)
    this.timeoutMs = config.timeoutMs ?? TASK_FILE_DEFAULTS.timeoutMs
    const resolved = await resolveOpenCodeCmd()
    this.cmdPrefix = resolved.cmd
    this.envOverlay = resolved.env
    log.info(`opencode command: ${this.cmdPrefix.join(" ")}`)
    log.info(`opencode model: ${this.model} (from ${config.model})`)
  }

  async run(task: {
    prompt: string
    workDir: string
    skillContent?: string
    skillMode?: SkillMode
    skillMeta?: { name: string; description: string }
    taskId?: string
    convLog?: import("../core/conversation-logger.ts").ConversationLog
    timeoutMs?: number
  }): Promise<RunResult> {
    const skillMode = task.skillMode ?? "inject"
    let skillLoaded: boolean | undefined

    if (task.skillContent) {
      if (skillMode === "inject") {
        // Inject mode: write skill content to CONTEXT.md (opencode auto-loads into system prompt)
        await Bun.write(path.join(task.workDir, "CONTEXT.md"), task.skillContent)
        // skillLoaded will be verified from NDJSON events below
        skillLoaded = false
      } else {
        // Discover mode (current behavior): copy to .opencode/skills/<name>/
        const skillName = task.skillMeta?.name ?? "bench-skill"
        const skillDesc = task.skillMeta?.description ?? "Benchmark skill injected by SkVM"
        const skillDir = path.join(task.workDir, ".opencode", "skills", skillName)
        await mkdir(skillDir, { recursive: true })
        const frontmatter = `---\nname: ${skillName}\ndescription: ${skillDesc}\n---\n\n`
        await Bun.write(path.join(skillDir, "SKILL.md"), frontmatter + task.skillContent)
        // skillLoaded will be determined by checking NDJSON output below
        skillLoaded = false
      }
    }

    const startMs = performance.now()

    // Prepend directive to suppress clarification questions in non-interactive bench mode
    const prompt = `IMPORTANT: Do not ask clarifying questions. Proceed directly with implementation. Execute all steps immediately without waiting for user input.\n\n${task.prompt}`

    const cmd = [
      ...this.cmdPrefix,
      "run",
      prompt,
      "--dir", task.workDir,
      "--model", this.model,
      "--agent", "build",
      "--pure",
      "--format", "json",
    ]

    const { stdout, stderr, exitCode, timedOut } = await runCommand(cmd, {
      cwd: task.workDir,
      timeout: task.timeoutMs ?? this.timeoutMs,
      env: this.envOverlay,
    })

    const durationMs = performance.now() - startMs

    if (exitCode !== 0 && stderr) {
      log.warn(`opencode exited with code ${exitCode}: ${stderr.slice(0, 200)}`)
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
    if (task.skillContent && skillLoaded === false) {
      // Extract a recognizable snippet from skill content for matching
      const skillSnippet = task.skillContent.replace(/^#.*\n/m, "").trim().slice(0, 60)

      for (const event of events) {
        if (skillLoaded) break
        const part = event.part ?? {}

        if (skillMode === "discover" && event.type === "tool_use") {
          // Discover: check if agent called the `skill` tool
          const toolName = (part.tool as string) ?? (part.name as string) ?? ""
          if (toolName === "skill") {
            skillLoaded = true
          }
        }

        if (skillMode === "inject") {
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

    const result = eventsToRunResult(events, task.workDir, durationMs)
    if (skillLoaded !== undefined) {
      result.skillLoaded = skillLoaded
    }
    // Subprocess-level failure overrides whatever eventsToRunResult decided.
    if (timedOut) {
      result.runStatus = "timeout"
      result.statusDetail = `opencode subprocess killed after ${task.timeoutMs ?? this.timeoutMs}ms`
    } else if (exitCode !== 0) {
      result.runStatus = "adapter-crashed"
      result.statusDetail = `opencode exited with code ${exitCode}`
    }
    if (exitCode !== 0) {
      result.adapterError = { exitCode, stderr: stderr.slice(0, 2000) }
    }
    return result
  }

  async teardown(): Promise<void> {
    // No persistent state to clean up
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export async function runCommand(
  cmd: string[],
  opts?: { cwd?: string; timeout?: number; env?: Record<string, string> },
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const env = opts?.env && Object.keys(opts.env).length > 0
    ? { ...process.env, ...opts.env }
    : process.env
  const proc = Bun.spawn(cmd, {
    cwd: opts?.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
  })

  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  if (opts?.timeout) {
    timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, opts.timeout)
  }

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited.then((code) => { if (timer) clearTimeout(timer); return code }),
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { stdout, stderr, exitCode, timedOut }
}
