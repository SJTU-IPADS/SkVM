import path from "node:path"
import type { AgentAdapter, AdapterConfig, AdapterConfigMode, ProviderRoute, RunResult, SkillBundle, TokenUsage, AgentStep, ToolCall } from "../core/types.ts"
import { createLogger } from "../core/logger.ts"
import { getAdapterRepoDir, getAdapterSettings, getHeadlessAgentConfig, expandHome, stripRoutingPrefix } from "../core/config.ts"
import { resolveRoute, resolveRouteApiKey, validateModelIdForRoute } from "../providers/registry.ts"
import { runCommand } from "./opencode.ts"
import { TASK_FILE_DEFAULTS } from "../core/ui-defaults.ts"
import {
  createSandbox,
  ensureDir,
  copyFileIfExists,
  symlinkIfExists,
  type Sandbox,
} from "../core/adapter-sandbox.ts"
import { emptyTokenUsage, addTokenUsage } from "../core/types.ts"

const log = createLogger("codebuddy")

// ---------------------------------------------------------------------------
// CodeBuddy Stream-JSON Event Types
// ---------------------------------------------------------------------------

export interface CodeBuddyContentText {
  type: "text"
  text: string
}

export interface CodeBuddyContentToolUse {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

export interface CodeBuddyContentToolResult {
  type: "tool_result"
  tool_use_id: string
  content: string | Array<{ type: string; text?: string }>
  is_error?: boolean
}

export type CodeBuddyContent =
  | CodeBuddyContentText
  | CodeBuddyContentToolUse
  | CodeBuddyContentToolResult
  | { type: string; [k: string]: unknown }

export interface CodeBuddyUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  [k: string]: unknown
}

export interface CodeBuddyMessage {
  id?: string
  role?: "assistant" | "user"
  content?: CodeBuddyContent[] | string
  usage?: CodeBuddyUsage
  stop_reason?: string | null
  [k: string]: unknown
}

export interface CodeBuddyEvent {
  type: string
  subtype?: string
  session_id?: string
  uuid?: string
  message?: CodeBuddyMessage
  parent_tool_use_id?: string | null
  // Result event fields
  is_error?: boolean
  total_cost_usd?: number
  duration_ms?: number
  duration_api_ms?: number
  num_turns?: number
  result?: string
  usage?: CodeBuddyUsage
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

export function parseCodeBuddyStreamJSON(output: string): CodeBuddyEvent[] {
  const events: CodeBuddyEvent[] = []
  for (const line of output.split("\n")) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as CodeBuddyEvent
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

function fromCodeBuddyUsage(u: CodeBuddyUsage | undefined): TokenUsage {
  if (!u) return emptyTokenUsage()
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  }
}

export function codeBuddyEventsToRunResult(
  events: CodeBuddyEvent[],
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
        if (c.type === "text" && typeof (c as CodeBuddyContentText).text === "string") {
          textBuf += (c as CodeBuddyContentText).text
        } else if (c.type === "tool_use") {
          const tc = c as CodeBuddyContentToolUse
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
      summedTokens = addTokenUsage(summedTokens, fromCodeBuddyUsage(msg.usage))
      continue
    }

    if (event.type === "user" && event.message) {
      const msg = event.message
      const content = Array.isArray(msg.content) ? msg.content : []
      for (const c of content) {
        if (!c || typeof c !== "object") continue
        if (c.type !== "tool_result") continue
        const tr = c as CodeBuddyContentToolResult
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
      if (event.usage) resultTokens = fromCodeBuddyUsage(event.usage)
      if (event.is_error) {
        resultIsError = true
        if (typeof event.result === "string") errors.push(event.result)
      }
      continue
    }

    if (event.type === "error" || event.type === "stream_event") {
      const errMsg = (event as Record<string, unknown>).message
        ?? (event as Record<string, unknown>).error
      if (event.type === "error" && errMsg) {
        const msg = typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg)
        errors.push(msg)
      }
      continue
    }
  }

  const resultTotal = resultTokens
    ? resultTokens.input + resultTokens.output + resultTokens.cacheRead + resultTokens.cacheWrite
    : 0
  const tokens = resultTokens && resultTotal > 0 ? resultTokens : summedTokens
  const cost = typeof resultCost === "number" ? resultCost : 0

  const noOutput = steps.length === 0
  const text = finalText || resultText
  const statusDetail = noOutput
    ? errors.length > 0
      ? `codebuddy emitted ${errors.length} error(s) and no steps — telemetry only`
      : `codebuddy produced no parseable steps — telemetry only, workDir scored as-is`
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
      stderr: errors.join("; ") || "codebuddy error (no details)",
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Binary resolution for codebuddy / cbc
// ---------------------------------------------------------------------------

export interface CodeBuddyResolution {
  cmd: string[]
  env: Record<string, string>
}

type TierHit = { resolution: CodeBuddyResolution; logLine: string }
type Tier = () => Promise<TierHit | null>

const tierEnvOverride: Tier = async () => {
  const raw = process.env.SKVM_CODEBUDDY_CMD
  if (!raw) return null
  const binaryPath = expandHome(raw.trim())
  if (!(await Bun.file(binaryPath).exists())) {
    throw new Error(`SKVM_CODEBUDDY_CMD not found: ${binaryPath}`)
  }
  return {
    resolution: { cmd: [binaryPath], env: {} },
    logLine: `Using SKVM_CODEBUDDY_CMD: ${binaryPath}`,
  }
}

const tierAdapterRepo: Tier = async () => {
  const repoDir = getAdapterRepoDir("codebuddy")
  if (!repoDir) return null
  if (!(await Bun.file(repoDir).exists())) {
    throw new Error(`adapters.codebuddy.repoPath not found: ${repoDir}`)
  }
  return {
    resolution: { cmd: [repoDir], env: {} },
    logLine: `Using configured codebuddy binary: ${repoDir}`,
  }
}

const tierHeadlessExplicit: Tier = async () => {
  const raw = (getHeadlessAgentConfig() as { codebuddyPath?: string }).codebuddyPath
  if (!raw) return null
  const binaryPath = expandHome(raw)
  if (!(await Bun.file(binaryPath).exists())) {
    throw new Error(`headlessAgent.codebuddyPath not found: ${binaryPath}`)
  }
  return {
    resolution: { cmd: [binaryPath], env: {} },
    logLine: `Using headlessAgent.codebuddyPath: ${binaryPath}`,
  }
}

const tierGlobal: Tier = async () => {
  // Try codebuddy first, fall back to cbc
  for (const bin of ["codebuddy", "cbc"] as const) {
    const { exitCode, stdout } = await runCommand(["which", bin])
    if (exitCode === 0 && stdout.trim()) {
      return {
        resolution: { cmd: [stdout.trim()], env: {} },
        logLine: `Using global ${bin}: ${stdout.trim()}`,
      }
    }
  }
  return null
}

async function resolveTiers(tiers: Tier[], notFoundMsg: string): Promise<CodeBuddyResolution> {
  for (const tier of tiers) {
    const hit = await tier()
    if (hit) {
      log.info(hit.logLine)
      return hit.resolution
    }
  }
  throw new Error(notFoundMsg)
}

export async function resolveCodeBuddyCmd(): Promise<CodeBuddyResolution> {
  return resolveTiers(
    [tierEnvOverride, tierAdapterRepo, tierGlobal],
    "codebuddy/cbc binary not found. Tried: $SKVM_CODEBUDDY_CMD, skvm.config.json → adapters.codebuddy, and global `which codebuddy`.",
  )
}

let _headlessCache: Promise<CodeBuddyResolution> | undefined
export async function resolveHeadlessCodeBuddyCmd(): Promise<CodeBuddyResolution> {
  if (!_headlessCache) {
    _headlessCache = resolveTiers(
      [tierEnvOverride, tierHeadlessExplicit, tierGlobal],
      "codebuddy/cbc binary not found for headless agent. Tried: $SKVM_CODEBUDDY_CMD, headlessAgent.codebuddyPath, and global `which codebuddy`.",
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

function resolveUserCodeBuddyDir(): string {
  const explicit = process.env.CODEBUDDY_CONFIG_DIR?.trim()
  if (explicit) return explicit
  // Uses ~/.codebuddy as config directory
  return path.join(HOME, ".codebuddy")
}

// ---------------------------------------------------------------------------
// Skill-mode helpers
// ---------------------------------------------------------------------------

const SKILL_INJECT_SENTINEL = "<skvm-skill-injected/>"

function injectedSystemPrompt(skillContent: string): string {
  return `${SKILL_INJECT_SENTINEL}\n\n${skillContent}`
}

export function detectSkillInject(events: CodeBuddyEvent[], snippet: string): boolean {
  for (const ev of events) {
    if (ev.type !== "assistant" || !ev.message) continue
    const content = Array.isArray(ev.message.content) ? ev.message.content : []
    for (const c of content) {
      if (!c || (c as { type?: string }).type !== "text") continue
      const text = (c as { text?: string }).text ?? ""
      if (text.includes(SKILL_INJECT_SENTINEL)) return true
      if (snippet.length > 20 && text.includes(snippet)) return true
    }
  }
  return false
}

export function detectSkillDiscover(events: CodeBuddyEvent[], skillName: string): boolean {
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
      const tu = c as { type: string; name?: string; input?: Record<string, unknown> }
      if (tu.name !== "Skill" && tu.name !== "skill") continue
      const inputName = (tu.input as { name?: string; skill?: string })?.name
        ?? (tu.input as { name?: string; skill?: string })?.skill
      if (!inputName || matchesName(inputName)) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Failure Diagnosis
// ---------------------------------------------------------------------------

export interface CodeBuddyDiagnosis {
  summary: string
  source: string
  hint?: string
}

const DIAGNOSE_TIMEOUT_MS = 500

/** Race any diagnose work against a short deadline so we never hold up teardown. */
async function withDeadline<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  return await Promise.race([
    fn(),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), DIAGNOSE_TIMEOUT_MS)),
  ])
}

function inferCodeBuddyHint(ev: CodeBuddyEvent): string | undefined {
  const text = typeof ev.result === "string" ? ev.result.toLowerCase() : ""
  if (text.includes("not logged in") || text.includes("/login")) {
    return "Run `codebuddy login` (native mode) or set CODEBUDDY_API_KEY (managed mode)."
  }
  if (text.includes("issue with the selected model") || (ev as Record<string, unknown>).api_error_status === 404) {
    return "Check the --model id matches a CodeBuddy-supported model."
  }
  if ((ev as Record<string, unknown>).api_error_status === 401 || text.includes("authentication") || text.includes("unauthorized")) {
    return "Verify CODEBUDDY_API_KEY (managed) or login session (native: `codebuddy login`)."
  }
  if ((ev as Record<string, unknown>).api_error_status === 429 || text.includes("rate limit") || text.includes("quota")) {
    return "Rate-limited — wait or reduce concurrency."
  }
  return undefined
}

function extractCodeBuddyErrorMessage(event: CodeBuddyEvent): string | undefined {
  const msg = (event as Record<string, unknown>).message
  if (typeof msg === "string") return msg
  const err = (event as Record<string, unknown>).error
  if (typeof err === "string") return err
  if (err && typeof err === "object") {
    const m = (err as Record<string, unknown>).message
    if (typeof m === "string") return m
  }
  return undefined
}

/** Pick the first line that looks like an error marker from the tail of stderr. */
function pickStderrErrorLine(stderr: string): string | null {
  if (!stderr) return null
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean)
  const tail = lines.slice(-40)
  const errLine = tail.reverse().find((l) => /\b(error|exception|traceback|fail)/i.test(l))
  if (errLine) return errLine.slice(0, 300)
  return lines[lines.length - 1]?.slice(0, 300) ?? null
}

export async function diagnoseCodeBuddyFailure(args: {
  sandboxRoot: string
  stdout: string
  stderr: string
  exitCode: number
}): Promise<CodeBuddyDiagnosis | null> {
  return withDeadline(async () => {
    const events = parseCodeBuddyStreamJSON(args.stdout)

    // Result event with is_error=true is the most reliable signal.
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!
      if (ev.type === "result" && ev.is_error && typeof ev.result === "string" && ev.result.trim()) {
        const hint = inferCodeBuddyHint(ev)
        return {
          summary: `codebuddy: ${ev.result.trim()}`,
          ...(hint ? { hint } : {}),
          source: "codebuddy:result-event",
        }
      }
    }

    // Plain "error" envelopes — used by the CLI for catastrophic init errors.
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!
      if (ev.type === "error") {
        const msg = extractCodeBuddyErrorMessage(ev)
        if (msg) return { summary: `codebuddy: ${msg}`, source: "codebuddy:error-event" }
      }
    }

    // Fallback: stderr patterns
    const { stderr, exitCode } = args
    if (stderr.includes("command not found") || stderr.includes("No such file")) {
      return {
        summary: "codebuddy binary not found",
        source: "codebuddy:stderr",
        hint: "Ensure codebuddy (or cbc) CLI is installed and in PATH.",
      }
    }
    if (stderr.includes("permission denied")) {
      return {
        summary: "codebuddy binary not executable",
        source: "codebuddy:stderr",
        hint: "Run chmod +x <codebuddy-binary> to add execute permission.",
      }
    }

    const tail = pickStderrErrorLine(stderr)
    if (tail) return { summary: `codebuddy: ${tail}`, source: "codebuddy:stderr" }

    if (exitCode === 1 && stderr.trim() === "") {
      return {
        summary: "codebuddy exited 1 with no stderr",
        source: "codebuddy:stderr",
        hint: "Check stdout for errors, or run codebuddy manually to reproduce.",
      }
    }

    return null
  }, null)
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class CodeBuddyAdapter implements AgentAdapter {
  readonly name = "codebuddy"
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

    const settings = getAdapterSettings("codebuddy")
    this.extraCliArgs = config.extraCliArgs ?? settings.extraCliArgs ?? []

    // Resolve the provider route. Managed mode requires it so we can inject
    // CODEBUDDY_API_KEY; native mode tolerates its absence — the user's own
    // settings.json carries the auth credentials.
    let route: ProviderRoute | undefined
    try {
      route = resolveRoute(this.model)
      validateModelIdForRoute(this.model, route)
    } catch (err) {
      if (this.mode === "managed") {
        throw new Error(`codebuddy (managed): ${(err as Error).message}`)
      }
      log.debug(`native mode: no providers.routes entry for ${this.model} — relying on copied settings.json`)
    }

    const userDir = this.mode === "native" ? resolveUserCodeBuddyDir() : ""
    if (this.mode === "native") {
      const settingsFile = path.join(userDir, "settings.json")
      if (!(await Bun.file(settingsFile).exists())) {
        throw new Error(
          `codebuddy (native): ${settingsFile} not found. Run \`codebuddy login\` first, `
            + `or switch to --adapter-config=managed.`,
        )
      }
    }

    const resolved = await resolveCodeBuddyCmd()
    this.cmdPrefix = resolved.cmd

    this.sandbox = createSandbox("codebuddy")
    const root = this.sandbox.root
    ensureDir(root)

    // Build env overlay with auth credentials from provider route.
    // CodeBuddy CLI reads CODEBUDDY_API_KEY and CODEBUDDY_BASE_URL from env.
    let routeEnv: Record<string, string> = {}
    if (route) {
      const apiKey = resolveRouteApiKey(route)
      if (apiKey) {
        routeEnv.CODEBUDDY_API_KEY = apiKey
      }
      if (route.baseUrl) {
        routeEnv.CODEBUDDY_BASE_URL = route.baseUrl
      }
    }
    if (!routeEnv.CODEBUDDY_API_KEY && this.mode === "managed") {
      log.warn(
        `route for "${this.model}" has no resolved API key — the codebuddy subprocess will fail to authenticate ` +
        `unless CODEBUDDY_API_KEY is already set in the parent environment.`,
      )
    }

    this.envOverlay = {
      ...resolved.env,
      ...routeEnv,
      CODEBUDDY_CONFIG_DIR: root,
    }

    if (this.mode === "native") {
      // Copy credentials and config from the user's real config dir into the
      // sandbox so the subprocess can authenticate without touching the original.
      copyFileIfExists(path.join(userDir, ".credentials.json"), path.join(root, ".credentials.json"))
      copyFileIfExists(path.join(userDir, "settings.json"), path.join(root, "settings.json"))
      copyFileIfExists(path.join(userDir, "settings.local.json"), path.join(root, "settings.local.json"))
      copyFileIfExists(path.join(userDir, "CODEBUDDY.md"), path.join(root, "CODEBUDDY.md"))
      symlinkIfExists(path.join(userDir, "plugins"), path.join(root, "plugins"))
      symlinkIfExists(path.join(userDir, "skills"), path.join(root, "skills"))
      symlinkIfExists(path.join(userDir, "agents"), path.join(root, "agents"))
      symlinkIfExists(path.join(userDir, "hooks"), path.join(root, "hooks"))
      symlinkIfExists(path.join(userDir, "commands"), path.join(root, "commands"))
    } else {
      // Managed mode: write minimal config with model pinned and permissions
      // bypassed. Auth flows through CODEBUDDY_API_KEY env var (injected above).
      const bareModel = stripRoutingPrefix(this.model)
      const settingsContent = JSON.stringify({
        model: bareModel,
        env: {
          CODEBUDDY_API_KEY: routeEnv.CODEBUDDY_API_KEY ?? "",
          ...(routeEnv.CODEBUDDY_BASE_URL ? { CODEBUDDY_BASE_URL: routeEnv.CODEBUDDY_BASE_URL } : {}),
        },
        permissions: {
          defaultMode: "bypassPermissions",
        },
      }, null, 2)
      await Bun.write(path.join(root, "settings.json"), settingsContent)
    }

    log.info(`codebuddy cmd: ${this.cmdPrefix.join(" ")}`)
    log.info(`codebuddy model: ${this.model} (mode=${this.mode}, sandbox=${root})`)
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
        appendSystemPrompt = injectedSystemPrompt(task.skill.content)
      } else {
        const skillDir = path.join(task.workDir, ".codebuddy", "skills", task.skill.meta.name)
        ensureDir(skillDir)
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---\nname: ${task.skill.meta.name}\ndescription: ${task.skill.meta.description}\n---\n\n${task.skill.content}`,
        )
      }
    }

    const startMs = performance.now()

    const prompt = `IMPORTANT: Do not ask clarifying questions. Proceed directly with implementation. Execute all steps immediately without waiting for user input.\n\n${task.prompt}`

    // Strip the routing prefix (e.g. "anthropic/model-name" → "model-name")
    // so the CLI receives a bare model id it can understand.
    const cliModel = stripRoutingPrefix(this.model)

    // In managed mode, restrict setting-sources to only the sandbox's own
    // settings.json (loaded as "user" since CODEBUDDY_CONFIG_DIR points at the
    // sandbox root). This prevents the workDir's .codebuddy/settings.json from
    // bleeding in unexpected config — analogous to claude-code's --bare flag.
    const settingSourcesFlag = this.mode === "managed"
      ? ["--setting-sources", "user"]
      : []

    const cmd = [
      ...this.cmdPrefix,
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model", cliModel,
      "--permission-mode", "bypassPermissions",
      "--add-dir", task.workDir,
      ...settingSourcesFlag,
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
      log.warn(`codebuddy exit ${exitCode}: ${stderr.slice(0, 2000)}`)
    }

    if (task.convLog && stdout.trim()) {
      try {
        const destDir = path.dirname(task.convLog.filePath)
        ensureDir(destDir)
        await Bun.write(task.convLog.filePath, stdout)
        log.debug(`Saved codebuddy stream-json to ${task.convLog.filePath}`)
      } catch (err) {
        log.warn(`Failed to save codebuddy stream-json: ${err}`)
      }
    }

    const events = parseCodeBuddyStreamJSON(stdout)

    if (task.skill && skillLoaded === false) {
      if (task.skill.mode === "inject") {
        const snippet = task.skill.content.replace(/^#.*\n/m, "").trim().slice(0, 60)
        skillLoaded = detectSkillInject(events, snippet)
      } else {
        skillLoaded = detectSkillDiscover(events, task.skill.meta.name)
      }
    }

    const result = codeBuddyEventsToRunResult(events, task.workDir, durationMs)
    if (skillLoaded !== undefined) {
      result.skillLoaded = skillLoaded
    }
    if (timedOut) {
      result.runStatus = "timeout"
      result.statusDetail = `codebuddy subprocess killed after ${task.timeoutMs ?? this.timeoutMs}ms`
    } else if (exitCode !== 0) {
      result.runStatus = "adapter-crashed"
      result.statusDetail = `codebuddy exit code ${exitCode}`
    }
    if (exitCode !== 0) {
      result.adapterError = { exitCode, stderr: stderr.slice(0, 2000) }
      // Error diagnosis
      const diagnosis = await diagnoseCodeBuddyFailure({
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
