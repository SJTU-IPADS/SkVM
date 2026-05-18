import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { AgentAdapter, AdapterConfig, AdapterConfigMode, ProviderRoute, RunResult, AgentStep, ToolCall, TokenUsage, SkillBundle } from "../core/types.ts"
import { emptyTokenUsage, addTokenUsage } from "../core/types.ts"
import { createLogger } from "../core/logger.ts"
import { getAdapterRepoDir, getAdapterSettings, getHeadlessAgentConfig, expandHome, stripRoutingPrefix } from "../core/config.ts"
import { envForRoute, resolveRoute, validateModelIdForRoute } from "../providers/registry.ts"
import { diagnoseClaudeCode } from "./diagnose-failure.ts"
import { runCommand } from "./opencode.ts"
import { TASK_FILE_DEFAULTS } from "../core/ui-defaults.ts"
import {
  createSandbox,
  ensureDir,
  copyFileIfExists,
  symlinkIfExists,
  buildClaudeCodeSettingsContent,
  type Sandbox,
} from "../core/adapter-sandbox.ts"

const log = createLogger("claude-code")

// ---------------------------------------------------------------------------
// Stream-JSON Event Types (from `claude -p --output-format stream-json`)
// ---------------------------------------------------------------------------

export interface ClaudeCodeContentText {
  type: "text"
  text: string
}

export interface ClaudeCodeContentToolUse {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ClaudeCodeContentToolResult {
  type: "tool_result"
  tool_use_id: string
  content: string | Array<{ type: string; text?: string }>
  is_error?: boolean
}

export type ClaudeCodeContent =
  | ClaudeCodeContentText
  | ClaudeCodeContentToolUse
  | ClaudeCodeContentToolResult
  | { type: string; [k: string]: unknown }

export interface ClaudeCodeUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  [k: string]: unknown
}

export interface ClaudeCodeMessage {
  id?: string
  role?: "assistant" | "user"
  content?: ClaudeCodeContent[] | string
  usage?: ClaudeCodeUsage
  stop_reason?: string | null
  [k: string]: unknown
}

export interface ClaudeCodeEvent {
  type: string
  subtype?: string
  session_id?: string
  uuid?: string
  message?: ClaudeCodeMessage
  parent_tool_use_id?: string | null
  // Result event fields
  is_error?: boolean
  total_cost_usd?: number
  duration_ms?: number
  duration_api_ms?: number
  num_turns?: number
  result?: string
  usage?: ClaudeCodeUsage
  // Init event fields
  cwd?: string
  tools?: string[]
  mcp_servers?: Array<{ name: string; status?: string }>
  model?: string
  permissionMode?: string
  slash_commands?: string[]
  agents?: string[]
  skills?: string[]
  // Generic passthrough
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// Stream-JSON parsing
// ---------------------------------------------------------------------------

export function parseClaudeCodeStreamJSON(output: string): ClaudeCodeEvent[] {
  const events: ClaudeCodeEvent[] = []
  for (const line of output.split("\n")) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as ClaudeCodeEvent
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

function fromClaudeUsage(u: ClaudeCodeUsage | undefined): TokenUsage {
  if (!u) return emptyTokenUsage()
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  }
}

export function eventsToRunResult(
  events: ClaudeCodeEvent[],
  workDir: string,
  durationMs: number,
): RunResult {
  const steps: AgentStep[] = []
  let summedTokens = emptyTokenUsage()
  let resultTokens: TokenUsage | undefined
  let resultCost: number | undefined
  let finalText = ""
  let resultText = ""
  const errors: string[] = []
  let resultIsError = false

  // Track tool_use ids so user-side tool_result events can enrich the existing
  // ToolCall in place — Claude Code emits them as separate user-role events.
  const toolCallIndex = new Map<string, ToolCall>()

  for (const event of events) {
    if (event.type === "system" && event.subtype === "init") {
      continue
    }

    if (event.type === "assistant" && event.message) {
      const msg = event.message
      const content = Array.isArray(msg.content) ? msg.content : []
      const toolCalls: ToolCall[] = []
      let textBuf = ""
      for (const c of content) {
        if (!c || typeof c !== "object") continue
        if (c.type === "text" && typeof (c as ClaudeCodeContentText).text === "string") {
          textBuf += (c as ClaudeCodeContentText).text
        } else if (c.type === "tool_use") {
          const tc = c as ClaudeCodeContentToolUse
          const call: ToolCall = {
            id: tc.id,
            name: tc.name,
            input: (tc.input ?? {}) as Record<string, unknown>,
          }
          toolCalls.push(call)
          toolCallIndex.set(call.id, call)
        }
      }

      const ts = Date.now()
      if (textBuf) {
        finalText = textBuf
      }
      if (toolCalls.length > 0) {
        steps.push({
          role: "assistant",
          ...(textBuf ? { text: textBuf } : {}),
          toolCalls,
          timestamp: ts,
        })
      } else if (textBuf) {
        steps.push({
          role: "assistant",
          text: textBuf,
          toolCalls: [],
          timestamp: ts,
        })
      }
      summedTokens = addTokenUsage(summedTokens, fromClaudeUsage(msg.usage))
      continue
    }

    if (event.type === "user" && event.message) {
      const msg = event.message
      const content = Array.isArray(msg.content) ? msg.content : []
      for (const c of content) {
        if (!c || typeof c !== "object") continue
        if (c.type !== "tool_result") continue
        const tr = c as ClaudeCodeContentToolResult
        let outputText = ""
        if (typeof tr.content === "string") {
          outputText = tr.content
        } else if (Array.isArray(tr.content)) {
          outputText = tr.content
            .map((p) => (typeof (p as { text?: string }).text === "string" ? (p as { text: string }).text : ""))
            .filter(Boolean)
            .join("\n")
        }
        const existing = toolCallIndex.get(tr.tool_use_id)
        if (existing) {
          existing.output = outputText
          if (tr.is_error) existing.exitCode = 1
        } else {
          steps.push({
            role: "tool",
            toolCalls: [{
              id: tr.tool_use_id,
              name: "",
              input: {},
              output: outputText,
              ...(tr.is_error ? { exitCode: 1 } : {}),
            }],
            timestamp: Date.now(),
          })
        }
      }
      continue
    }

    if (event.type === "result") {
      if (typeof event.result === "string") resultText = event.result
      if (typeof event.total_cost_usd === "number") resultCost = event.total_cost_usd
      if (event.usage) resultTokens = fromClaudeUsage(event.usage)
      if (event.is_error) {
        resultIsError = true
        if (typeof event.result === "string") errors.push(event.result)
      }
      continue
    }

    if (event.type === "error" || event.type === "stream_event") {
      // stream_event is the partial-message envelope; ignore for accounting.
      const errMsg = (event as Record<string, unknown>).message
        ?? (event as Record<string, unknown>).error
      if (event.type === "error" && errMsg) {
        const msg = typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg)
        errors.push(msg)
      }
      continue
    }

    // Unknown event types (rate_limit_event, hook_started, hook_response, etc.)
    // are ignored — they don't carry data we need.
  }

  // Result-event totals beat assistant-message sums when present and non-zero.
  // Claude Code's `result` event aggregates the whole run including server-side
  // accounting that individual assistant events sometimes miss; assistant sums
  // are the safer fallback for partial / interrupted runs.
  const resultTotal = resultTokens
    ? resultTokens.input + resultTokens.output + resultTokens.cacheRead + resultTokens.cacheWrite
    : 0
  const tokens = resultTokens && resultTotal > 0 ? resultTokens : summedTokens
  const cost = typeof resultCost === "number" ? resultCost : 0

  const noOutput = steps.length === 0
  const text = finalText || resultText
  const statusDetail = noOutput
    ? errors.length > 0
      ? `claude-code emitted ${errors.length} error(s) and no steps — telemetry only`
      : `claude-code produced no parseable steps — telemetry only, workDir scored as-is`
    : undefined

  const result: RunResult = {
    text,
    steps,
    tokens,
    cost,
    durationMs,
    llmDurationMs: 0,
    workDir,
    runStatus: "ok",
    ...(statusDetail ? { statusDetail } : {}),
  }

  if (errors.length > 0 && noOutput) {
    result.adapterError = {
      exitCode: resultIsError ? 1 : 0,
      stderr: errors.join("; ") || "claude-code error (no details)",
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

export interface ClaudeCodeResolution {
  cmd: string[]
  env: Record<string, string>
}

const INSTALL_HELP = "See https://code.claude.com/docs/en/setup for setup."

type TierHit = { resolution: ClaudeCodeResolution; logLine: string }
type Tier = () => Promise<TierHit | null>

// Throws if the user pinned an env override that doesn't exist — better to
// surface that loudly than to silently fall through.
const tierEnvOverride: Tier = async () => {
  const raw = process.env.SKVM_CLAUDE_CMD
  if (!raw) return null
  const binaryPath = expandHome(raw.trim())
  if (!(await Bun.file(binaryPath).exists())) {
    throw new Error(`SKVM_CLAUDE_CMD does not exist: ${binaryPath}`)
  }
  return {
    resolution: { cmd: [binaryPath], env: {} },
    logLine: `Using SKVM_CLAUDE_CMD: ${binaryPath}`,
  }
}

const tierAdapterRepo: Tier = async () => {
  const repoDir = getAdapterRepoDir("claude-code")
  if (!repoDir) return null
  if (!(await Bun.file(repoDir).exists())) {
    throw new Error(`adapters.claude-code.repoPath does not exist: ${repoDir}`)
  }
  return {
    resolution: { cmd: [repoDir], env: {} },
    logLine: `Using configured claude binary: ${repoDir}`,
  }
}

// Throws if an explicit headlessAgent.claudePath is configured but missing —
// keeps parity with the opencode tier of the same shape, even though
// claude-code is not yet wired as a headless driver.
const tierHeadlessExplicit: Tier = async () => {
  const raw = (getHeadlessAgentConfig() as { claudePath?: string }).claudePath
  if (!raw) return null
  const binaryPath = expandHome(raw)
  if (!(await Bun.file(binaryPath).exists())) {
    throw new Error(`headlessAgent.claudePath does not exist: ${binaryPath}`)
  }
  return {
    resolution: { cmd: [binaryPath], env: {} },
    logLine: `Using headlessAgent.claudePath: ${binaryPath}`,
  }
}

const tierGlobal: Tier = async () => {
  const { exitCode, stdout } = await runCommand(["which", "claude"])
  if (exitCode !== 0 || !stdout.trim()) return null
  const p = stdout.trim()
  return { resolution: { cmd: [p], env: {} }, logLine: `Using global claude: ${p}` }
}

async function resolveTiers(tiers: Tier[], notFoundMsg: string): Promise<ClaudeCodeResolution> {
  for (const tier of tiers) {
    const hit = await tier()
    if (hit) {
      log.info(hit.logLine)
      return hit.resolution
    }
  }
  throw new Error(`${notFoundMsg} ${INSTALL_HELP}`)
}

export async function resolveAdapterClaudeCmd(): Promise<ClaudeCodeResolution> {
  return resolveTiers(
    [tierEnvOverride, tierAdapterRepo, tierGlobal],
    "claude binary not found for adapter. Tried: $SKVM_CLAUDE_CMD, skvm.config.json → adapters.claude-code, and global `which claude`.",
  )
}

let _headlessCache: Promise<ClaudeCodeResolution> | undefined
export async function resolveHeadlessClaudeCmd(): Promise<ClaudeCodeResolution> {
  if (!_headlessCache) {
    _headlessCache = resolveTiers(
      [tierEnvOverride, tierHeadlessExplicit, tierGlobal],
      "claude binary not found for headless agent. Tried: $SKVM_CLAUDE_CMD, headlessAgent.claudePath, and global `which claude`.",
    ).catch((err) => {
      _headlessCache = undefined
      throw err
    })
  }
  return _headlessCache
}

// ---------------------------------------------------------------------------
// User-config discovery (native mode)
// ---------------------------------------------------------------------------

const HOME = process.env.HOME ?? ""

export function resolveUserClaudeDir(): string {
  const explicit = process.env.CLAUDE_CONFIG_DIR?.trim()
  if (explicit) return explicit
  return path.join(HOME, ".claude")
}

// ---------------------------------------------------------------------------
// Skill-mode helpers
// ---------------------------------------------------------------------------

/**
 * Sentinel string written into the injected system prompt so we can detect
 * — by grepping the assistant's text — whether the model actually read the
 * skill content. Mirrors the CONTEXT.md trick in opencode.ts.
 */
const SKILL_INJECT_SENTINEL = "<skvm-skill-injected/>"

function injectedSystemPrompt(skillContent: string): string {
  return `${SKILL_INJECT_SENTINEL}\n\n${skillContent}`
}

export function detectSkillInject(events: ClaudeCodeEvent[], snippet: string): boolean {
  for (const ev of events) {
    if (ev.type !== "assistant" || !ev.message) continue
    const content = Array.isArray(ev.message.content) ? ev.message.content : []
    for (const c of content) {
      if (!c || (c as { type?: string }).type !== "text") continue
      const text = (c as ClaudeCodeContentText).text
      if (text.includes(SKILL_INJECT_SENTINEL)) return true
      if (snippet.length > 20 && text.includes(snippet)) return true
    }
  }
  return false
}

export function detectSkillDiscover(events: ClaudeCodeEvent[], skillName: string): boolean {
  const matchesName = (s: unknown): boolean =>
    typeof s === "string" && (s === skillName || s.endsWith(`:${skillName}`))

  for (const ev of events) {
    if (ev.type === "system" && ev.subtype === "init") {
      const skills = Array.isArray(ev.skills) ? ev.skills : []
      if (skills.some(matchesName)) return true
    }
    if (ev.type !== "assistant" || !ev.message) continue
    const content = Array.isArray(ev.message.content) ? ev.message.content : []
    for (const c of content) {
      if (!c || (c as { type?: string }).type !== "tool_use") continue
      const tu = c as ClaudeCodeContentToolUse
      if (tu.name !== "Skill" && tu.name !== "skill") continue
      const inputName = (tu.input as { name?: string; skill?: string })?.name
        ?? (tu.input as { name?: string; skill?: string })?.skill
      if (!inputName || matchesName(inputName)) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude-code"
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

    const settings = getAdapterSettings("claude-code")
    this.extraCliArgs = config.extraCliArgs ?? settings.extraCliArgs ?? []

    // Resolve the route once. Managed mode requires it (and rejects non-anthropic
    // kinds); native mode tolerates its absence — the user's copied settings.json
    // carries the auth in that path.
    let route: ProviderRoute | undefined
    try {
      route = resolveRoute(this.model)
      validateModelIdForRoute(this.model, route)
    } catch (err) {
      if (this.mode === "managed") {
        throw new Error(`claude-code (managed): ${(err as Error).message}`)
      }
      log.debug(`native mode: no providers.routes entry for ${this.model} — relying on copied settings.json`)
    }

    if (this.mode === "managed" && route && route.kind !== "anthropic") {
      throw new Error(
        `claude-code (managed) only supports anthropic routes today; route "${route.match}" is kind=${route.kind}. ` +
        `Switch to --adapter-config=native to use Claude Code's own provider config (Bedrock, Vertex, OAuth), ` +
        `or add an anthropic route via \`skvm config init\`.`,
      )
    }

    const userDir = this.mode === "native" ? resolveUserClaudeDir() : ""
    if (this.mode === "native") {
      const settingsFile = path.join(userDir, "settings.json")
      if (!(await Bun.file(settingsFile).exists())) {
        throw new Error(
          `claude-code (native): ${settingsFile} not found. Run claude's own setup (\`claude /login\`) first, ` +
          `or switch to --adapter-config=managed.`,
        )
      }
    }

    const resolved = await resolveAdapterClaudeCmd()
    this.cmdPrefix = resolved.cmd

    this.sandbox = createSandbox("claude-code")
    const root = this.sandbox.root
    ensureDir(root)

    // envForRoute resolves the route again internally; tolerated to fail in
    // native mode where auth lives in the copied settings.json.
    let routeEnv: Record<string, string> = {}
    try {
      routeEnv = envForRoute(config.model)
    } catch (err) {
      if (this.mode === "managed") throw err
    }

    this.envOverlay = {
      ...resolved.env,
      ...routeEnv,
      CLAUDE_CONFIG_DIR: root,
    }

    if (this.mode === "native") {
      // .credentials.json holds the OAuth access/refresh tokens (mode 0600).
      // Copy preserves perms via copyFileSync; a refresh inside the sandbox
      // can't clobber the user's real credentials.
      copyFileIfExists(path.join(userDir, ".credentials.json"), path.join(root, ".credentials.json"))
      copyFileIfExists(path.join(userDir, "settings.json"), path.join(root, "settings.json"))
      copyFileIfExists(path.join(userDir, "settings.local.json"), path.join(root, "settings.local.json"))
      copyFileIfExists(path.join(userDir, "CLAUDE.md"), path.join(root, "CLAUDE.md"))
      symlinkIfExists(path.join(userDir, "plugins"), path.join(root, "plugins"))
      symlinkIfExists(path.join(userDir, "skills"), path.join(root, "skills"))
      symlinkIfExists(path.join(userDir, "agents"), path.join(root, "agents"))
      symlinkIfExists(path.join(userDir, "hooks"), path.join(root, "hooks"))
      symlinkIfExists(path.join(userDir, "commands"), path.join(root, "commands"))
    } else {
      const settingsJson = buildClaudeCodeSettingsContent(route!, stripRoutingPrefix(this.model))
      await Bun.write(path.join(root, "settings.json"), settingsJson)
    }

    log.info(`claude-code command: ${this.cmdPrefix.join(" ")}`)
    log.info(`claude-code model: ${this.model} (mode=${this.mode}, sandbox=${root})`)
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
    let appendSystemPrompt: string | undefined

    if (task.skill) {
      skillLoaded = false
      if (task.skill.mode === "inject") {
        // --append-system-prompt is the documented headless way to inject
        // extra context. The sentinel lets us verify the model actually
        // saw the skill (matches opencode's CONTEXT.md trick).
        appendSystemPrompt = injectedSystemPrompt(task.skill.content)
      } else {
        // Discover: <workDir>/.claude/skills/ is project-scope, so it works
        // regardless of sandbox HOME — managed-mode runs ship the skill too.
        const skillDir = path.join(task.workDir, ".claude", "skills", task.skill.meta.name)
        await mkdir(skillDir, { recursive: true })
        const frontmatter = `---\nname: ${task.skill.meta.name}\ndescription: ${task.skill.meta.description}\n---\n\n`
        await Bun.write(path.join(skillDir, "SKILL.md"), frontmatter + task.skill.content)
      }
    }

    const startMs = performance.now()

    const prompt = `IMPORTANT: Do not ask clarifying questions. Proceed directly with implementation. Execute all steps immediately without waiting for user input.\n\n${task.prompt}`

    // Claude Code wants its model id in dash form ("claude-sonnet-4-6"); SkVM
    // canonicalizes Anthropic ids in dot form. Convert here only — the rest
    // of skvm continues to see the user-facing dot id.
    const stripped = stripRoutingPrefix(this.model)
    const cliModel = toClaudeCodeModelId(stripped)

    // `--bare` forces Anthropic auth strictly through ANTHROPIC_API_KEY (or
    // apiKeyHelper) and skips hooks, LSP, plugins, keychain reads, and
    // CLAUDE.md auto-discovery. In managed mode that's exactly what we want
    // (envForRoute injects the key, skvm controls the sandbox). In native
    // mode the user's settings.json may carry an OAuth token / apiKeyHelper
    // / Bedrock / Vertex config we want to honor, so --bare would break it.
    const bareFlag = this.mode === "managed" ? ["--bare"] : []

    const cmd = [
      ...this.cmdPrefix,
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model", cliModel,
      "--permission-mode", "bypassPermissions",
      "--add-dir", task.workDir,
      ...bareFlag,
      ...(appendSystemPrompt ? ["--append-system-prompt", appendSystemPrompt] : []),
      ...this.extraCliArgs,
    ]

    const { stdout, stderr, exitCode, timedOut } = await runCommand(cmd, {
      cwd: task.workDir,
      timeout: task.timeoutMs ?? this.timeoutMs,
      env: this.envOverlay,
    })

    const durationMs = performance.now() - startMs

    if (exitCode !== 0 && stderr) {
      log.warn(`claude-code exited with code ${exitCode}: ${stderr.slice(0, 2000)}`)
    }

    if (task.convLog && stdout.trim()) {
      try {
        const destDir = path.dirname(task.convLog.filePath)
        await mkdir(destDir, { recursive: true })
        await Bun.write(task.convLog.filePath, stdout)
        log.debug(`Saved claude-code stream-json to ${task.convLog.filePath}`)
      } catch (err) {
        log.warn(`Failed to save claude-code stream-json: ${err}`)
      }
    }

    const events = parseClaudeCodeStreamJSON(stdout)

    if (task.skill && skillLoaded === false) {
      if (task.skill.mode === "inject") {
        const snippet = task.skill.content.replace(/^#.*\n/m, "").trim().slice(0, 60)
        skillLoaded = detectSkillInject(events, snippet)
      } else {
        skillLoaded = detectSkillDiscover(events, task.skill.meta.name)
      }
    }

    const result = eventsToRunResult(events, task.workDir, durationMs)
    if (skillLoaded !== undefined) {
      result.skillLoaded = skillLoaded
    }
    if (timedOut) {
      result.runStatus = "timeout"
      result.statusDetail = `claude-code subprocess killed after ${task.timeoutMs ?? this.timeoutMs}ms`
    } else if (exitCode !== 0) {
      result.runStatus = "adapter-crashed"
      result.statusDetail = `claude-code exited with code ${exitCode}`
    }
    if (exitCode !== 0) {
      result.adapterError = { exitCode, stderr: stderr.slice(0, 2000) }
      const diagnosis = await diagnoseClaudeCode({
        sandboxRoot: this.sandbox?.root ?? "",
        stdout,
        stderr,
        exitCode,
      })
      if (diagnosis) {
        result.adapterError.diagnosis = diagnosis
        log.warn(`${diagnosis.summary}${diagnosis.hint ? `\n  ${diagnosis.hint}` : ""}`)
      }
    }
    return result
  }

  async teardown(): Promise<void> {
    this.sandbox?.teardown()
    this.sandbox = undefined
  }
}

/**
 * Translate skvm's canonical Anthropic id ("claude-sonnet-4.6") to the
 * dash-form id Claude Code accepts on the wire ("claude-sonnet-4-6"). The
 * regex is narrow — it only rewrites the version segment of well-known
 * Anthropic family ids — so aliases like "sonnet" or "opus" pass through
 * unchanged. (Empirically the CLI rejects dot form: api_error_status:404,
 * "It may not exist or you may not have access to it".)
 */
export function toClaudeCodeModelId(id: string): string {
  return id.replace(/^(claude-(?:sonnet|opus|haiku|3-5-sonnet|3-5-haiku|3-opus)-)(\d+)\.(\d+)/, "$1$2-$3")
}
