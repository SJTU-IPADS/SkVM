import { mkdir } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { AgentAdapter, AdapterConfig, AdapterConfigMode, RunResult, AgentStep, ToolCall, SkillMode, ProviderRoute } from "../core/types.ts"
import { emptyTokenUsage } from "../core/types.ts"
import { createLogger } from "../core/logger.ts"
import { getAdapterRepoDir, getAdapterSettings, stripRoutingPrefix } from "../core/config.ts"
import { envForRoute, resolveRoute, validateModelIdForRoute } from "../providers/registry.ts"
import { diagnoseHermes } from "./diagnose-failure.ts"
import { runCommand } from "./opencode.ts"
import { TASK_FILE_DEFAULTS } from "../core/ui-defaults.ts"
import {
  createSandbox,
  ensureDir,
  copyFileIfExists,
  symlinkIfExists,
  type Sandbox,
} from "../core/adapter-sandbox.ts"

const log = createLogger("hermes")

// ---------------------------------------------------------------------------
// Hermes Session Export Types
// ---------------------------------------------------------------------------

/** Message row from hermes session export (SQLite messages table). */
interface HermesMessage {
  id: number
  session_id: string
  role: "user" | "assistant" | "tool"
  content: string | null
  tool_call_id: string | null
  /** OpenAI format: [{id, function: {name, arguments}}] — deserialized from JSON. */
  tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> | null
  tool_name: string | null
  timestamp: number
  token_count: number | null
  finish_reason: string | null
  reasoning: string | null
}

/** Session-level metadata from hermes session export. */
interface HermesSessionExport {
  id: string
  source: string
  model: string
  started_at: number
  ended_at: number | null
  message_count: number
  tool_call_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  estimated_cost_usd: number | null
  actual_cost_usd: number | null
  messages: HermesMessage[]
}

// ---------------------------------------------------------------------------
// Session Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a hermes session export JSON into a RunResult.
 *
 * The export contains session-level token/cost aggregates and a `messages` array
 * with full conversation history including tool_calls (OpenAI format) and tool results.
 */
export function parseHermesSession(
  session: HermesSessionExport,
  workDir: string,
  durationMs: number,
): RunResult {
  const steps: AgentStep[] = []
  let finalText = ""

  // Build a map of tool_call_id → ToolCall so we can enrich them with outputs
  const toolCallMap = new Map<string, ToolCall>()

  for (const msg of session.messages) {
    if (msg.role === "assistant") {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Assistant message with tool calls
        const toolCalls: ToolCall[] = msg.tool_calls.map((tc) => {
          let input: Record<string, unknown> = {}
          try {
            input = JSON.parse(tc.function.arguments)
          } catch { /* keep empty */ }
          const toolCall: ToolCall = {
            id: tc.id,
            name: tc.function.name,
            input,
          }
          toolCallMap.set(tc.id, toolCall)
          return toolCall
        })
        steps.push({
          role: "assistant",
          text: msg.content ?? undefined,
          toolCalls,
          timestamp: msg.timestamp * 1000, // seconds → ms
        })
      } else {
        // Plain assistant text
        if (msg.content) {
          finalText = msg.content
          steps.push({
            role: "assistant",
            text: msg.content,
            toolCalls: [],
            timestamp: msg.timestamp * 1000,
          })
        }
      }
    } else if (msg.role === "tool") {
      // Enrich the matching ToolCall with output/exitCode
      const tc = msg.tool_call_id ? toolCallMap.get(msg.tool_call_id) : undefined
      let output = msg.content ?? ""
      let exitCode: number | undefined

      // Terminal tool returns JSON {output, exit_code, error}
      if (msg.content) {
        try {
          const parsed = JSON.parse(msg.content)
          if (typeof parsed === "object" && parsed !== null) {
            output = parsed.output ?? parsed.result ?? msg.content
            if (typeof parsed.exit_code === "number") exitCode = parsed.exit_code
          }
        } catch { /* content is plain text */ }
      }

      if (tc) {
        tc.output = output
        if (exitCode !== undefined) tc.exitCode = exitCode
      }

      steps.push({
        role: "tool",
        toolCalls: [{
          id: msg.tool_call_id ?? `tool-${msg.id}`,
          name: msg.tool_name ?? "unknown",
          input: {},
          output,
          exitCode,
        }],
        timestamp: msg.timestamp * 1000,
      })
    }
  }

  // If we didn't capture finalText from a non-tool-call assistant message,
  // use the last assistant message's content
  if (!finalText) {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i]!
      if (msg.role === "assistant" && msg.content) {
        finalText = msg.content
        break
      }
    }
  }

  return {
    text: finalText,
    steps,
    tokens: {
      input: session.input_tokens ?? 0,
      output: session.output_tokens ?? 0,
      cacheRead: session.cache_read_tokens ?? 0,
      cacheWrite: session.cache_write_tokens ?? 0,
    },
    cost: session.estimated_cost_usd ?? session.actual_cost_usd ?? 0,
    durationMs,
    llmDurationMs: 0,
    workDir,
    runStatus: "ok",
  }
}

// ---------------------------------------------------------------------------
// CLI Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve hermes CLI command.
 * Priority: custom path from skvm.config.json → globally installed `hermes`.
 */
export async function resolveHermesCmd(): Promise<string[]> {
  // 1. Custom path from config — run via <python> -m hermes_cli.main
  const repoDir = getAdapterRepoDir("hermes")
  if (repoDir) {
    const mainModule = path.join(repoDir, "hermes_cli", "main.py")
    if (await Bun.file(mainModule).exists()) {
      const py = await resolvePython()
      log.info(`Using hermes from source: ${repoDir} (python=${py})`)
      return [py, "-m", "hermes_cli.main"]
    }
    throw new Error(`hermes not found at ${repoDir} (no hermes_cli/main.py)`)
  }

  // 2. Global install
  const { exitCode, stdout } = await runCommand(["which", "hermes"])
  if (exitCode === 0 && stdout.trim()) {
    log.info(`Using global hermes: ${stdout.trim()}`)
    return [stdout.trim()]
  }

  throw new Error(
    "hermes not found. Either install it globally or set adapters.hermes in skvm.config.json",
  )
}

/**
 * Pick a python binary to run hermes from source. `python` is tried first:
 * with a conda/venv activated it points at the env's interpreter (where
 * hermes's deps live), whereas `python3` on macOS is routinely Apple's
 * stock 3.9. Version-tagged names come last as a fallback for machines
 * without any env activated. If hermes's actual requirements (currently
 * >=3.11) aren't satisfied by the chosen interpreter, hermes itself will
 * surface that clearly on first import — we don't second-guess the version.
 */
async function resolvePython(): Promise<string> {
  const override = process.env.SKVM_HERMES_PYTHON?.trim()
  const candidates = override
    ? [override]
    : ["python", "python3", "python3.13", "python3.12", "python3.11"]
  for (const bin of candidates) {
    const { exitCode } = await runCommand([bin, "--version"])
    if (exitCode === 0) return bin
  }
  throw new Error(
    `No python interpreter found. Tried: ${candidates.join(", ")}. ` +
    `Activate a conda/venv env with python installed, or set SKVM_HERMES_PYTHON to an existing interpreter.`,
  )
}

// ---------------------------------------------------------------------------
// Hermes Adapter
// ---------------------------------------------------------------------------

const HOME = process.env.HOME ?? ""
const HERMES_ROOT = path.join(HOME, ".hermes")

/**
 * Resolve the hermes home directory the user actually runs against.
 *
 * Hermes supports profiles: the effective home is `~/.hermes/profiles/<name>`
 * when `HERMES_HOME` is set, or when `~/.hermes/active_profile` (sticky file,
 * managed by `hermes profile use`) names one. skvm must mirror that so native
 * mode clones the user's real config, not an empty default tree.
 */
export function resolveUserHermesDir(): string {
  const envHome = process.env.HERMES_HOME?.trim()
  if (envHome) return envHome
  try {
    const name = readFileSync(path.join(HERMES_ROOT, "active_profile"), "utf-8").trim()
    if (name && name !== "default") {
      const profileDir = path.join(HERMES_ROOT, "profiles", name)
      if (existsSync(profileDir)) return profileDir
    }
  } catch { /* no active_profile — fall through */ }
  return HERMES_ROOT
}

export class HermesAdapter implements AgentAdapter {
  readonly name = "hermes"
  private model = ""
  private maxSteps: number = TASK_FILE_DEFAULTS.maxSteps
  private timeoutMs: number = TASK_FILE_DEFAULTS.timeoutMs
  private cmdPrefix: string[] = []
  private repoDir: string | undefined
  private mode: AdapterConfigMode = "managed"
  private extraCliArgs: string[] = []
  private sandbox: Sandbox | undefined
  private hermesHome: string | undefined

  async setup(config: AdapterConfig): Promise<void> {
    this.model = config.model
    this.maxSteps = config.maxSteps ?? TASK_FILE_DEFAULTS.maxSteps
    this.timeoutMs = config.timeoutMs ?? TASK_FILE_DEFAULTS.timeoutMs
    this.repoDir = getAdapterRepoDir("hermes")
    this.cmdPrefix = await resolveHermesCmd()
    this.mode = config.mode ?? "managed"

    const settings = getAdapterSettings("hermes")
    this.extraCliArgs = config.extraCliArgs ?? settings.extraCliArgs ?? []

    const srcDir = resolveUserHermesDir()

    if (this.mode === "native") {
      const cfgPath = path.join(srcDir, "config.yaml")
      if (!(await Bun.file(cfgPath).exists())) {
        throw new Error(
          `hermes (native): ${cfgPath} not found. Run hermes's own setup first, ` +
          `or switch to --adapter-config=managed.`,
        )
      }
    } else {
      try {
        const route = resolveRoute(this.model)
        validateModelIdForRoute(this.model, route)
      } catch (err) {
        throw new Error(
          `hermes (managed): ${(err as Error).message} Run \`skvm config init\` to add a route, ` +
          `or switch to --adapter-config=native.`,
        )
      }
    }

    this.sandbox = createSandbox("hermes")
    const root = this.sandbox.root
    this.hermesHome = root
    ensureDir(path.join(root, "sessions"))

    if (this.mode === "native") {
      copyFileIfExists(path.join(srcDir, "config.yaml"), path.join(root, "config.yaml"))
      copyFileIfExists(path.join(srcDir, ".env"), path.join(root, ".env"))
      copyFileIfExists(path.join(srcDir, "SOUL.md"), path.join(root, "SOUL.md"))
      symlinkIfExists(path.join(srcDir, "skills"), path.join(root, "skills"))
      symlinkIfExists(path.join(srcDir, "memories"), path.join(root, "memories"))
      symlinkIfExists(path.join(srcDir, "profiles"), path.join(root, "profiles"))
    } else {
      // Managed: generate minimal config.yaml + .env from providers.routes.
      const route = resolveRoute(this.model)
      const yamlDoc = renderHermesConfig(route, this.model)
      await Bun.write(path.join(root, "config.yaml"), yamlDoc)
      const envFile = renderHermesEnv(this.model)
      if (envFile) await Bun.write(path.join(root, ".env"), envFile)
    }

    log.info(`hermes command: ${this.cmdPrefix.join(" ")}`)
    log.info(`hermes model: ${this.model} (mode=${this.mode}, HERMES_HOME=${root})`)
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
    let prompt = `IMPORTANT: Do not ask clarifying questions. Proceed directly with implementation. Execute all steps immediately without waiting for user input.\n\n`

    // --- Skill handling ---
    if (task.skillContent) {
      if (skillMode === "inject") {
        // Inject mode: prepend skill content to prompt
        prompt += task.skillContent + "\n\n---\n\n"
        skillLoaded = false
      } else {
        const skillName = task.skillMeta?.name ?? "bench-skill"
        if (!this.hermesHome) {
          throw new Error("hermes.run called before setup() initialized sandbox")
        }
        const skillDir = path.join(this.hermesHome, "skills", skillName)
        await mkdir(skillDir, { recursive: true })
        await Bun.write(path.join(skillDir, "SKILL.md"), task.skillContent)
        skillLoaded = false
      }
    }

    prompt += task.prompt

    const startMs = performance.now()

    // --- Build command ---
    // hermes routes via `model.provider` in config.yaml (openrouter /
    // anthropic / openai-compatible / ...) and passes the `-m` value
    // verbatim to that provider's API. So strip skvm's routing prefix —
    // openrouter expects `qwen/qwen3-...`, not `openrouter/qwen/qwen3-...`.
    const cmd = [
      ...this.cmdPrefix,
      "chat",
      "-Q",
      "-q", prompt,
      "-m", stripRoutingPrefix(this.model),
      "-t", "terminal,file",
      "--max-turns", String(this.maxSteps),
      "--yolo",
      "--source", "tool",
      ...this.extraCliArgs,
    ]

    // Add --skills flag for discover mode
    if (task.skillContent && skillMode === "discover") {
      const skillName = task.skillMeta?.name ?? "bench-skill"
      cmd.push("-s", skillName)
    }

    // Build env with PYTHONPATH for source installs. Also inject standard SDK
    // env vars from the matched providers.routes entry so hermes can reach
    // the configured backend without the user also exporting them manually.
    // HERMES_HOME points at the sandbox so hermes reads the managed / native
    // config.yaml we just wrote and never touches ~/.hermes.
    const env: Record<string, string | undefined> = { ...process.env, ...envForRoute(this.model) }
    if (this.hermesHome) env.HERMES_HOME = this.hermesHome
    if (this.repoDir) {
      env.PYTHONPATH = this.repoDir + (env.PYTHONPATH ? `:${env.PYTHONPATH}` : "")
    }

    const { stdout, stderr, exitCode, timedOut } = await runCommandWithEnv(cmd, {
      cwd: task.workDir,
      timeout: task.timeoutMs ?? this.timeoutMs,
      env,
    })

    const durationMs = performance.now() - startMs

    if (exitCode !== 0 && stderr) {
      log.warn(`hermes exited with code ${exitCode}: ${stderr.slice(0, 2000)}`)
    }

    // Save whatever stdout we have to the conv log now, before any early return.
    // On timeout-kill the `sessions export` subprocess never runs, so we only have
    // raw stdout — that's still better than nothing (the old bug was losing it entirely).
    const saveConvLog = async (logContent: string) => {
      if (!task.convLog) return
      try {
        const destDir = path.dirname(task.convLog.filePath)
        await mkdir(destDir, { recursive: true })
        await Bun.write(task.convLog.filePath, logContent)
        log.debug(`Saved hermes session to ${task.convLog.filePath}`)
      } catch (err) {
        log.warn(`Failed to save hermes conv log: ${err}`)
      }
    }

    // --- Parse session_id from stdout ---
    const sessionIdMatch = stdout.match(/\nsession_id:\s*(\S+)\s*$/)
    const sessionId = sessionIdMatch?.[1]

    if (!sessionId) {
      // No session_id trailer line. Classify on subprocess state, NOT on
      // structured-output extraction success:
      //   - timedOut    → 'timeout' (workDir untrustworthy; runner gate skips eval)
      //   - exitCode!=0 → 'adapter-crashed' (workDir untrustworthy)
      //   - exitCode==0 → 'ok' with reduced telemetry. Hermes did finish; it
      //     just didn't emit (or we couldn't parse) the session_id trailer —
      //     either an older binary that doesn't print it, or a config issue.
      //     The workDir is the agent's natural final state and IS scoreable;
      //     only the per-token accounting is missing. (Pre-fix this was the
      //     reduced-telemetry happy path.) See round-3 Codex review.
      const earlyStatus: RunResult["runStatus"] = timedOut
        ? "timeout"
        : exitCode !== 0
          ? "adapter-crashed"
          : "ok"
      const earlyDetail = timedOut
        ? `hermes chat subprocess killed after ${task.timeoutMs ?? this.timeoutMs}ms`
        : exitCode !== 0
          ? `hermes exited with code ${exitCode}`
          : "hermes exited cleanly but session_id trailer missing — telemetry unavailable, workDir scored as-is"
      if (timedOut || exitCode !== 0) {
        log.warn(`Could not extract session_id from hermes output (runStatus=${earlyStatus})`)
      } else {
        log.debug(`Hermes session_id trailer missing — proceeding with reduced telemetry`)
      }
      await saveConvLog(stdout)
      const text = stdout.replace(/\nsession_id:\s*\S+\s*$/, "").trim()
      const result: RunResult = {
        text,
        steps: text ? [{ role: "assistant", text, toolCalls: [], timestamp: Date.now() }] : [],
        tokens: emptyTokenUsage(),
        cost: 0,
        durationMs,
        llmDurationMs: 0,
        workDir: task.workDir,
        runStatus: earlyStatus,
        statusDetail: earlyDetail,
      }
      if (exitCode !== 0) {
        result.adapterError = { exitCode, stderr: stderr.slice(0, 2000) }
        const diagnosis = await diagnoseHermes({
          sandboxRoot: this.hermesHome ?? "",
          sessionId,
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

    log.debug(`Hermes session_id: ${sessionId}`)

    // --- Export session for structured data ---
    const exportCmd = [
      ...this.cmdPrefix,
      "sessions", "export", "-",
      "--session-id", sessionId,
    ]

    const exportResult = await runCommandWithEnv(exportCmd, {
      timeout: 30_000,
      env,
    })

    // `hermes sessions export` is an AUXILIARY subprocess that fetches
    // structured token/cost data — the chat itself already finished cleanly
    // (we have a session_id and the workDir is populated). When it fails we
    // lose telemetry but the workDir is still trustworthy, so the result
    // stays 'ok' with reduced accounting. The subprocess-level overrides at
    // the bottom of run() still upgrade to 'timeout' / 'adapter-crashed' when
    // the chat itself failed. See round-3 Codex review.
    let result: RunResult
    if (exportResult.exitCode === 0 && exportResult.stdout.trim()) {
      try {
        const sessionData = JSON.parse(exportResult.stdout.trim()) as HermesSessionExport
        result = parseHermesSession(sessionData, task.workDir, durationMs)
      } catch (err) {
        log.warn(`Failed to parse hermes session export: ${err}`)
        result = buildMinimalResult(stdout, task.workDir, durationMs, "ok",
          `hermes sessions export returned invalid JSON: ${String(err).slice(0, 200)}`)
      }
    } else {
      log.warn(`hermes sessions export failed: ${exportResult.stderr.slice(0, 200)}`)
      result = buildMinimalResult(stdout, task.workDir, durationMs, "ok",
        `hermes sessions export exited ${exportResult.exitCode} — telemetry unavailable`)
    }

    // --- Save conv log (export JSON is richer than raw stdout when available) ---
    await saveConvLog(exportResult.exitCode === 0 ? exportResult.stdout : stdout)

    // --- Verify skill loaded ---
    if (task.skillContent && skillLoaded === false) {
      const skillSnippet = task.skillContent.replace(/^#.*\n/m, "").trim().slice(0, 60)

      if (skillMode === "inject") {
        // Inject: if agent produced any tool calls or steps, skill was loaded (it's in the prompt)
        if (result.steps.length > 0) {
          skillLoaded = true
        }
      }

      // Check if any assistant text references skill content
      if (!skillLoaded && skillSnippet.length > 20) {
        for (const step of result.steps) {
          if (step.text?.includes(skillSnippet)) {
            skillLoaded = true
            break
          }
        }
      }
    }

    if (skillLoaded !== undefined) {
      result.skillLoaded = skillLoaded
    }
    // Subprocess-level failure overrides whatever the parse path decided.
    // Rare on this branch (we already got a session_id) but possible if the
    // chat exits non-zero AFTER printing the trailer line.
    if (timedOut) {
      result.runStatus = "timeout"
      result.statusDetail = `hermes chat subprocess killed after ${task.timeoutMs ?? this.timeoutMs}ms`
    } else if (exitCode !== 0) {
      result.runStatus = "adapter-crashed"
      result.statusDetail = `hermes exited with code ${exitCode}`
    }
    if (exitCode !== 0) {
      result.adapterError = { exitCode, stderr: stderr.slice(0, 2000) }
      const diagnosis = await diagnoseHermes({
        sandboxRoot: this.hermesHome ?? "",
        sessionId,
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
    this.hermesHome = undefined
  }
}

// ---------------------------------------------------------------------------
// Managed-mode config / .env generators
// ---------------------------------------------------------------------------

/**
 * Emit a minimal hermes `config.yaml` for managed mode. Hermes reads
 * `model.provider` / `model.base_url` / `model.name` (and resolves API keys
 * via the matching provider-specific env var), so we write just enough to
 * drive one backend. Asset directories (skills/, profiles/, memories/) are
 * left empty — managed mode is a clean baseline.
 *
 * Exported so the doctor can preview the synthesized yaml.
 */
const HERMES_PROVIDER_KIND: Record<ProviderRoute["kind"], string> = {
  openrouter: "openrouter",
  anthropic: "anthropic",
  "openai-compatible": "openai",
}

const HERMES_DEFAULT_BASE_URL: Partial<Record<ProviderRoute["kind"], string>> = {
  openrouter: "https://openrouter.ai/api/v1",
  anthropic: "https://api.anthropic.com/v1",
}

export function renderHermesConfig(route: ProviderRoute, model: string): string {
  const bareModel = stripRoutingPrefix(model)
  const baseUrl = route.baseUrl ?? HERMES_DEFAULT_BASE_URL[route.kind]
  const lines = [
    `# Generated by skvm (managed mode); do not hand-edit — next run will overwrite.`,
    `model:`,
    `  name: "${bareModel}"`,
    `  provider: "${HERMES_PROVIDER_KIND[route.kind]}"`,
  ]
  if (baseUrl) lines.push(`  base_url: "${baseUrl}"`)
  lines.push(``)
  return lines.join("\n")
}

/**
 * Serialize the matched route's SDK env vars as `.env` lines for hermes's
 * managed sandbox. Returns `null` when the route has no resolvable key —
 * caller leaves .env absent and lets hermes surface the auth error natively.
 */
export function renderHermesEnv(model: string): string | null {
  const env = envForRoute(model)
  if (Object.keys(env).length === 0) return null
  return Object.entries(env).map(([k, v]) => `${k}="${v}"`).join("\n") + "\n"
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function buildMinimalResult(
  stdout: string,
  workDir: string,
  durationMs: number,
  runStatus: RunResult["runStatus"],
  statusDetail?: string,
): RunResult {
  const text = stdout.replace(/\nsession_id:\s*\S+\s*$/, "").trim()
  return {
    text,
    steps: text ? [{ role: "assistant", text, toolCalls: [], timestamp: Date.now() }] : [],
    tokens: emptyTokenUsage(),
    cost: 0,
    durationMs,
    llmDurationMs: 0,
    workDir,
    runStatus,
    ...(statusDetail ? { statusDetail } : {}),
  }
}

export async function runCommandWithEnv(
  cmd: string[],
  opts?: { cwd?: string; timeout?: number; env?: Record<string, string | undefined> },
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts?.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: opts?.env ?? process.env,
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
