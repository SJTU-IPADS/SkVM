import { mkdir } from "node:fs/promises"
import path from "node:path"
import type {
  AgentAdapter,
  AdapterConfig,
  AdapterConfigMode,
  RunResult,
  AgentStep,
  ToolCall,
  SkillMode,
  ProviderRoute,
} from "../core/types.ts"
import { emptyTokenUsage } from "../core/types.ts"
import { createLogger } from "../core/logger.ts"
import { getAdapterRepoDir, getAdapterSettings, stripRoutingPrefix } from "../core/config.ts"
import { envForRoute, resolveRoute, validateModelIdForRoute } from "../providers/registry.ts"
import { runCommand } from "./opencode.ts"
import { TASK_FILE_DEFAULTS } from "../core/ui-defaults.ts"
import {
  createSandbox,
  ensureDir,
  copyFileIfExists,
  symlinkIfExists,
  type Sandbox,
} from "../core/adapter-sandbox.ts"

const log = createLogger("pi")

const HOME = process.env.HOME ?? ""
/** User-side pi config dir (`~/.pi/agent/`). Mirrored into sandbox in native mode. */
const PI_USER_AGENT_DIR = path.join(HOME, ".pi", "agent")

// ---------------------------------------------------------------------------
// Pi NDJSON Event Types
// ---------------------------------------------------------------------------

export interface PiTextContent {
  type: "text"
  text: string
}

export interface PiToolCallContent {
  type: "toolCall"
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface PiUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
}

export interface PiAssistantMessage {
  role: "assistant"
  content: (PiTextContent | PiToolCallContent)[]
  api: string
  provider: string
  model: string
  usage: PiUsage
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted"
  errorMessage?: string
  timestamp: number
}

export interface PiToolResultMessage {
  role: "toolResult"
  toolCallId: string
  toolName: string
  content: PiTextContent[]
  isError: boolean
  timestamp: number
}

export interface PiUserMessage {
  role: "user"
  content: PiTextContent[] | string
  timestamp: number
}

export type PiMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage

export type PiEvent =
  | { type: "session"; version: number; id: string; timestamp: string; cwd: string }
  | { type: "agent_start" }
  | { type: "agent_end"; messages: PiMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: PiMessage; toolResults: PiToolResultMessage[] }
  | { type: "message_start"; message: PiMessage }
  | { type: "message_update"; message: PiMessage }
  | { type: "message_end"; message: PiMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }

// ---------------------------------------------------------------------------
// Event Parsing
// ---------------------------------------------------------------------------

export function parsePiNDJSON(output: string): PiEvent[] {
  const events: PiEvent[] = []
  for (const line of output.split("\n")) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as PiEvent)
    } catch {
      log.debug(`Skipping non-JSON line: ${line.slice(0, 100)}`)
    }
  }
  return events
}

// ---------------------------------------------------------------------------
// Build RunResult from Pi events
// ---------------------------------------------------------------------------

export function piEventsToRunResult(
  events: PiEvent[],
  workDir: string,
  durationMs: number,
): RunResult {
  const agentEndEvents = events.filter((e): e is Extract<PiEvent, { type: "agent_end" }> => e.type === "agent_end")
  const lastAgentEnd = agentEndEvents[agentEndEvents.length - 1]

  const messages: PiMessage[] = lastAgentEnd?.messages ? [...lastAgentEnd.messages] : []

  if (messages.length === 0) {
    // Fallback: collect message_end events when agent_end is missing (timeout / kill).
    const messageEnds = events.filter((e): e is Extract<PiEvent, { type: "message_end" }> => e.type === "message_end")
    for (const me of messageEnds) {
      if (me.message.role === "assistant" || me.message.role === "toolResult") {
        messages.push(me.message)
      }
    }
  }

  const steps: AgentStep[] = []
  let totalTokens = emptyTokenUsage()
  let totalCost = 0
  let finalText = ""
  const errors: string[] = []

  const toolOutputMap = new Map<string, { output: string; exitCode?: number }>()
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      const text = msg.content
        .filter((c): c is PiTextContent => c.type === "text")
        .map((c) => c.text)
        .join("")
      toolOutputMap.set(msg.toolCallId, { output: text, exitCode: msg.isError ? 1 : 0 })
    }
  }

  for (const msg of messages) {
    if (msg.role === "assistant") {
      const textParts = msg.content
        .filter((c): c is PiTextContent => c.type === "text")
        .map((c) => c.text)
      const text = textParts.join("")
      if (text) finalText = text

      const toolCalls: ToolCall[] = msg.content
        .filter((c): c is PiToolCallContent => c.type === "toolCall")
        .map((tc) => {
          const out = toolOutputMap.get(tc.id)
          return {
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
            output: out?.output,
            exitCode: out?.exitCode,
          }
        })

      steps.push({
        role: "assistant",
        text: text || undefined,
        toolCalls,
        timestamp: msg.timestamp,
      })

      const usage = msg.usage
      if (usage) {
        totalTokens = {
          input: totalTokens.input + (usage.input ?? 0),
          output: totalTokens.output + (usage.output ?? 0),
          cacheRead: totalTokens.cacheRead + (usage.cacheRead ?? 0),
          cacheWrite: totalTokens.cacheWrite + (usage.cacheWrite ?? 0),
        }
        totalCost += usage.cost?.total ?? 0
      }

      if (msg.stopReason === "error" && msg.errorMessage) {
        errors.push(msg.errorMessage)
      }
    } else if (msg.role === "toolResult") {
      const text = msg.content
        .filter((c): c is PiTextContent => c.type === "text")
        .map((c) => c.text)
        .join("")
      const out = toolOutputMap.get(msg.toolCallId)
      steps.push({
        role: "tool",
        toolCalls: [{
          id: msg.toolCallId,
          name: msg.toolName,
          input: {},
          output: text,
          exitCode: out?.exitCode,
        }],
        timestamp: msg.timestamp,
      })
    }
  }

  const lastAssistant = messages
    .filter((m): m is PiAssistantMessage => m.role === "assistant")
    .pop()

  let runStatus: RunResult["runStatus"] = "ok"
  let statusDetail: string | undefined

  if (!lastAgentEnd && messages.length === 0) {
    runStatus = "parse-failed"
    statusDetail = "pi produced no parseable events — telemetry only, workDir scored as-is"
  } else if (lastAssistant?.stopReason === "error") {
    statusDetail = `pi assistant stopped with error: ${lastAssistant.errorMessage ?? "unknown"}`
  }

  const result: RunResult = {
    text: finalText,
    steps,
    tokens: totalTokens,
    cost: totalCost,
    durationMs,
    llmDurationMs: 0,
    workDir,
    runStatus,
    ...(statusDetail ? { statusDetail } : {}),
  }

  if (errors.length > 0) {
    result.adapterError = { exitCode: 1, stderr: errors.join("; ").slice(0, 2000) }
  }

  return result
}

// ---------------------------------------------------------------------------
// Command Resolution (tiered)
// ---------------------------------------------------------------------------
//
// Contract matches opencode's: a Tier returns a hit or null (not configured,
// try next). A tier THROWS when configured-but-broken (e.g. repoPath set but
// nothing usable inside) so the user sees a clear error instead of silent
// fallthrough to a surprising alternative.

type TierHit = { cmd: string[]; logLine: string }
type Tier = () => Promise<TierHit | null>

const INSTALL_HELP =
  "Install with `npm i -g @mariozechner/pi-coding-agent`, or set `adapters.pi.repoPath` to a pi-mono checkout."

// Throws when repoPath is set but the checkout has neither source nor built
// entry — a misconfigured contributor checkout, not a silent-skip case.
const tierAdapterRepo: Tier = async () => {
  const repoDir = getAdapterRepoDir("pi")
  if (!repoDir) return null
  const pkgDir = path.join(repoDir, "packages/coding-agent")

  // Prefer source: contributors editing pi-mono get live behavior without
  // rebuilding dist/. Invoke via absolute path — do NOT use `bun --cwd`,
  // which would change the child process's cwd to pkgDir and break pi's
  // assumption that the user's workDir is the cwd.
  const srcEntry = path.join(pkgDir, "src/cli.ts")
  if (await Bun.file(srcEntry).exists()) {
    return {
      cmd: ["bun", srcEntry],
      logLine: `Using pi from source: ${repoDir}`,
    }
  }

  // Then the Bun-compiled single-file binary produced by `npm run build:binary`.
  const binary = path.join(pkgDir, "dist/pi")
  if (await Bun.file(binary).exists()) {
    return { cmd: [binary], logLine: `Using pi binary: ${binary}` }
  }

  // Finally the node entry from `npm run build`.
  const distJs = path.join(pkgDir, "dist/cli.js")
  if (await Bun.file(distJs).exists()) {
    return { cmd: ["node", distJs], logLine: `Using pi node entry: ${distJs}` }
  }

  throw new Error(
    `pi not found at ${repoDir} (no packages/coding-agent/src/cli.ts, dist/pi, or dist/cli.js)`,
  )
}

const tierGlobal: Tier = async () => {
  const { exitCode, stdout } = await runCommand(["which", "pi"])
  if (exitCode !== 0 || !stdout.trim()) return null
  const p = stdout.trim()
  return { cmd: [p], logLine: `Using global pi: ${p}` }
}

const tierNpx: Tier = async () => ({
  cmd: ["npx", "-y", "@mariozechner/pi-coding-agent"],
  logLine: "Falling back to npx @mariozechner/pi-coding-agent",
})

export async function resolvePiCmd(): Promise<string[]> {
  for (const tier of [tierAdapterRepo, tierGlobal, tierNpx]) {
    const hit = await tier()
    if (hit) {
      log.info(hit.logLine)
      return hit.cmd
    }
  }
  throw new Error(`pi not found. ${INSTALL_HELP}`)
}

// ---------------------------------------------------------------------------
// Model Translation
// ---------------------------------------------------------------------------

/**
 * Translate a skvm model id to pi's `--model` syntax (managed mode).
 *
 * Pi accepts `<known-provider>/<id>` where `<known-provider>` is one of its
 * built-in providers (openrouter / anthropic / openai / ...). Skvm's route
 * prefix is often the same name (e.g. `anthropic/claude-sonnet-4.6`) but
 * NOT always — `openai-compatible` routes use arbitrary user-chosen match
 * patterns like `ipads/gpt-4o-mini` that pi can't resolve.
 *
 * Translation:
 *   - openai-compatible → strip skvm's prefix and route through pi's
 *     `openai` provider, whose baseUrl we override via `models.json`
 *     (see `renderPiModelsJson`).
 *   - anthropic / openrouter → pass through; prefix already matches pi.
 *
 * Native mode skips this function — the user's own pi config owns model
 * resolution.
 */
export function toPiModel(model: string, route: ProviderRoute): string {
  if (route.kind === "openai-compatible") {
    return `openai/${stripRoutingPrefix(model)}`
  }
  return model
}

// ---------------------------------------------------------------------------
// Managed-mode models.json override
// ---------------------------------------------------------------------------

/**
 * Pi reads provider baseUrl overrides from `models.json`, NOT from
 * OPENAI_BASE_URL env var. For openai-compatible routes with a non-default
 * baseUrl, emit a minimal override so pi's built-in OpenAI models get
 * redirected to the user's endpoint. Returns null when no override is
 * needed (openrouter / anthropic / openai with default baseUrl).
 */
export function renderPiModelsJson(route: ProviderRoute): string | null {
  if (route.kind !== "openai-compatible" || !route.baseUrl) return null
  const doc = { providers: { openai: { baseUrl: route.baseUrl } } }
  return JSON.stringify(doc, null, 2) + "\n"
}

// ---------------------------------------------------------------------------
// Pi Adapter
// ---------------------------------------------------------------------------

export class PiAdapter implements AgentAdapter {
  readonly name = "pi"
  private model = ""
  private timeoutMs: number = TASK_FILE_DEFAULTS.timeoutMs
  private cmdPrefix: string[] = []
  private mode: AdapterConfigMode = "managed"
  private extraCliArgs: string[] = []
  private sandbox: Sandbox | undefined
  private piAgentDir: string | undefined
  /** Cached SDK env overlay derived from the skvm route at setup time. */
  private routeEnv: Record<string, string> = {}

  async setup(config: AdapterConfig): Promise<void> {
    this.timeoutMs = config.timeoutMs ?? TASK_FILE_DEFAULTS.timeoutMs
    this.mode = config.mode ?? "managed"

    const settings = getAdapterSettings("pi")
    this.extraCliArgs = config.extraCliArgs ?? settings.extraCliArgs ?? []

    this.cmdPrefix = await resolvePiCmd()

    // Fail-fast validation before sandbox setup so the user sees a clear
    // error at the adapter boundary instead of a cryptic failure inside pi.
    if (this.mode === "native") {
      const authExists = await Bun.file(path.join(PI_USER_AGENT_DIR, "auth.json")).exists()
      const modelsExists = await Bun.file(path.join(PI_USER_AGENT_DIR, "models.json")).exists()
      if (!authExists && !modelsExists) {
        throw new Error(
          `pi (native): ${PI_USER_AGENT_DIR} has no auth.json or models.json. ` +
          `Run pi's own setup (e.g. \`pi /login\`) first, or switch to --adapter-config=managed.`,
        )
      }
      // Native mode: pass the user's model id through unchanged; their pi
      // config (models.json / auth.json) owns resolution.
      this.model = config.model
    } else {
      let route
      try {
        route = resolveRoute(config.model)
        validateModelIdForRoute(config.model, route)
      } catch (err) {
        throw new Error(
          `pi (managed): ${(err as Error).message} Run \`skvm config init\` to add a route, ` +
          `or switch to --adapter-config=native.`,
        )
      }
      this.model = toPiModel(config.model, route)
      this.routeEnv = envForRoute(config.model)
    }

    this.sandbox = createSandbox("pi")
    const root = this.sandbox.root
    this.piAgentDir = root
    ensureDir(path.join(root, "sessions"))

    if (this.mode === "native") {
      // Copy writable state so runs in parallel sandboxes can't race on the
      // user's real config. Symlink static asset dirs so live edits show up.
      copyFileIfExists(path.join(PI_USER_AGENT_DIR, "auth.json"), path.join(root, "auth.json"))
      copyFileIfExists(path.join(PI_USER_AGENT_DIR, "models.json"), path.join(root, "models.json"))
      copyFileIfExists(path.join(PI_USER_AGENT_DIR, "settings.json"), path.join(root, "settings.json"))
      symlinkIfExists(path.join(PI_USER_AGENT_DIR, "skills"), path.join(root, "skills"))
      symlinkIfExists(path.join(PI_USER_AGENT_DIR, "prompts"), path.join(root, "prompts"))
      symlinkIfExists(path.join(PI_USER_AGENT_DIR, "themes"), path.join(root, "themes"))
      symlinkIfExists(path.join(PI_USER_AGENT_DIR, "tools"), path.join(root, "tools"))
      symlinkIfExists(path.join(PI_USER_AGENT_DIR, "bin"), path.join(root, "bin"))
    } else {
      // Managed: start from empty. Pi's auth precedence (auth.json → OAuth →
      // env var → fallback) means we can authenticate via env vars alone, so
      // no auth.json is needed. Only write models.json when the route has a
      // custom baseUrl that pi can't pick up from env vars.
      const route = resolveRoute(config.model)
      const doc = renderPiModelsJson(route)
      if (doc) await Bun.write(path.join(root, "models.json"), doc)
    }

    log.info(`pi command: ${this.cmdPrefix.join(" ")}`)
    log.info(`pi model: ${this.model} (mode=${this.mode}, PI_CODING_AGENT_DIR=${root})`)
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
    let skillPath: string | undefined

    if (task.skillContent) {
      if (skillMode === "inject") {
        // Pi auto-loads AGENTS.md from CWD into the system prompt.
        await Bun.write(path.join(task.workDir, "AGENTS.md"), task.skillContent)
        skillLoaded = false
      } else {
        const skillName = task.skillMeta?.name ?? "bench-skill"
        const skillDir = path.join(task.workDir, ".pi-skills", skillName)
        await mkdir(skillDir, { recursive: true })
        await Bun.write(path.join(skillDir, "SKILL.md"), task.skillContent)
        skillPath = skillDir
        skillLoaded = false
      }
    }

    const startMs = performance.now()

    const prompt = `IMPORTANT: Do not ask clarifying questions. Proceed directly with implementation. Execute all steps immediately without waiting for user input.\n\n${task.prompt}`

    const cmd = [
      ...this.cmdPrefix,
      "-p", prompt,
      "--mode", "json",
      "--no-session",
      "--model", this.model,
      "--tools", "read,bash,edit,write",
      "--no-extensions",
    ]

    if (task.skillContent) {
      if (skillMode === "discover" && skillPath) {
        cmd.push("--skill", skillPath, "--no-skills", "--no-context-files")
      }
    } else {
      cmd.push("--no-context-files", "--no-skills")
    }

    cmd.push(...this.extraCliArgs)

    const envOverlay: Record<string, string> = { ...this.routeEnv }
    if (this.piAgentDir) envOverlay.PI_CODING_AGENT_DIR = this.piAgentDir

    const { stdout, stderr, exitCode, timedOut } = await runCommand(cmd, {
      cwd: task.workDir,
      timeout: task.timeoutMs ?? this.timeoutMs,
      env: envOverlay,
    })

    const durationMs = performance.now() - startMs

    if (exitCode !== 0 && stderr) {
      log.warn(`pi exited with code ${exitCode}: ${stderr.slice(0, 200)}`)
    }

    if (task.convLog && stdout.trim()) {
      try {
        const destDir = path.dirname(task.convLog.filePath)
        await mkdir(destDir, { recursive: true })
        await Bun.write(task.convLog.filePath, stdout)
      } catch (err) {
        log.warn(`Failed to save pi NDJSON: ${err}`)
      }
    }

    const events = parsePiNDJSON(stdout)
    const result = piEventsToRunResult(events, task.workDir, durationMs)

    if (task.skillContent && skillLoaded === false) {
      const skillSnippet = task.skillContent.replace(/^#.*\n/m, "").trim().slice(0, 60)
      if (skillMode === "inject" && result.steps.length > 0) {
        skillLoaded = true
      }
      if (!skillLoaded && skillSnippet.length > 20) {
        for (const step of result.steps) {
          if (step.role === "assistant" && step.text?.includes(skillSnippet)) {
            skillLoaded = true
            break
          }
        }
      }
    }

    if (skillLoaded !== undefined) {
      result.skillLoaded = skillLoaded
    }

    if (timedOut) {
      result.runStatus = "timeout"
      result.statusDetail = `pi subprocess killed after ${task.timeoutMs ?? this.timeoutMs}ms`
    } else if (exitCode !== 0) {
      result.runStatus = "adapter-crashed"
      result.statusDetail = `pi exited with code ${exitCode}`
    }
    if (exitCode !== 0) {
      result.adapterError = { exitCode, stderr: stderr.slice(0, 2000) }
    }

    return result
  }

  async teardown(): Promise<void> {
    this.sandbox?.teardown()
    this.sandbox = undefined
    this.piAgentDir = undefined
  }
}
