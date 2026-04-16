import { mkdir, copyFile, writeFile, unlink } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import net from "node:net"
import type { AgentAdapter, AdapterConfig, RunResult, AgentStep, ToolCall, SkillMode } from "../core/types.ts"
import { emptyTokenUsage } from "../core/types.ts"
import { createLogger } from "../core/logger.ts"
import { getAdapterRepoDir } from "../core/config.ts"
import { acquireFileLock, releaseFileLock } from "../core/file-lock.ts"
import { runCommandWithEnv } from "./hermes.ts"
import { TASK_FILE_DEFAULTS } from "../core/ui-defaults.ts"

const log = createLogger("jiuwenclaw")

// ---------------------------------------------------------------------------
// Sidecar lifecycle constants
// ---------------------------------------------------------------------------
//
// Jiuwenclaw's AgentServer reads its LLM credentials and target model from
// ~/.jiuwenclaw/config/.env at *startup* (jiuwenclaw/app.py → load_dotenv →
// resources/config.yaml ${API_BASE}/${API_KEY}/${MODEL_NAME}/${MODEL_PROVIDER}).
// There is no per-request model override — the ACP session/prompt request only
// carries `content`. So each target model needs its own sidecar launched with
// its own .env.
//
// Port 19001 and ~/.jiuwenclaw/config/.env are both user-global singletons, so
// at most one sidecar may live at a time across all processes on the host. We
// enforce that with a cross-process file lock (reused from openclaw's pattern).

const HOME = process.env.HOME ?? ""
const JIUWEN_DIR = path.join(HOME, ".jiuwenclaw")
const JIUWEN_ENV_PATH = path.join(JIUWEN_DIR, "config", ".env")
const JIUWEN_ENV_BACKUP = path.join(JIUWEN_DIR, "config", ".env.skvm-backup")
const JIUWEN_LOCK_PATH = path.join(JIUWEN_DIR, "jiuwenclaw.sidecar.lock")
// Lock TTL ceiling. With the heartbeat below the file's mtime is refreshed
// before this fires, so `staleMs` only ever catches abandoned locks whose
// holder died hard (SIGKILL, kernel OOM). The file-lock also consults
// `kill(pid, 0)` for same-host reaping, so dead holders get cleaned up
// immediately without waiting for the TTL.
const JIUWEN_LOCK_STALE_MS = 30 * 60 * 1000
// How often to refresh the lock mtime while held. A third of `staleMs` is
// the file-lock module's recommendation — gives us two missed-beat tolerance.
const JIUWEN_LOCK_HEARTBEAT_MS = 10 * 60 * 1000
// Max time to wait for the lock during contention. 2 h covers long bench
// sweeps where a queued cell may sit behind 14 skills × 3 models × ~68 s.
const JIUWEN_LOCK_ACQUIRE_TIMEOUT_MS = 2 * 60 * 60 * 1000
const GATEWAY_HOST = "127.0.0.1"
const GATEWAY_PORT = 19001
const SIDECAR_READY_TIMEOUT_MS = 60_000
const SIDECAR_SHUTDOWN_TIMEOUT_MS = 15_000

// ---------------------------------------------------------------------------
// History Record Types (from history.json)
// ---------------------------------------------------------------------------

/**
 * A single record in ~/.jiuwenclaw/agent/sessions/{session_id}/history.json.
 *
 * For streaming events, `event_type` and `event_payload` are present.
 * See jiuwenclaw/agentserver/session_history.py for the write logic and
 * jiuwenclaw/agentserver/deep_agent/interface_deep.py for event payload format.
 */
interface HistoryRecord {
  id: string
  role: "user" | "assistant"
  request_id: string
  channel_id: string
  timestamp: number
  content: string
  event_type?: string
  /** Present for stream events — contains the full event payload dict. */
  event_payload?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// History Parsing
// ---------------------------------------------------------------------------

/**
 * Parse jiuwenclaw history.json records into a RunResult.
 *
 * History records include event_type-tagged entries for tool calls, tool results,
 * delta text, and final responses.
 *
 * Note: `tokens` and `cost` are always zero. jiuwenclaw upstream does not
 * persist per-message usage in history.json, and no per-request generation ID
 * is exposed to query OpenRouter post-hoc. Downstream aggregators (bench cost
 * totals, proposal meta, profile cost summaries) will therefore under-report
 * spend for jiuwenclaw runs until upstream adds usage persistence.
 */
export function parseJiuwenClawHistory(
  records: HistoryRecord[],
  workDir: string,
  durationMs: number,
): RunResult {
  const steps: AgentStep[] = []
  let finalText = ""
  const toolCallMap = new Map<string, ToolCall>()

  for (const rec of records) {
    if (rec.role === "user") continue

    const et = rec.event_type
    const payload = rec.event_payload ?? {}

    if (et === "chat.tool_call") {
      // Tool call event — payload: {event_type, tool_call: {name, arguments, id, ...}}
      const tcInfo = (payload.tool_call as Record<string, unknown>) ?? payload
      const name = (tcInfo.name as string) ?? ""
      const id = (tcInfo.id as string) ?? (tcInfo.tool_call_id as string) ?? `tc-${rec.timestamp}`
      let input: Record<string, unknown> = {}
      const rawArgs = tcInfo.arguments ?? tcInfo.args
      if (typeof rawArgs === "string") {
        try { input = JSON.parse(rawArgs) } catch { /* keep empty */ }
      } else if (typeof rawArgs === "object" && rawArgs !== null) {
        input = rawArgs as Record<string, unknown>
      }

      const toolCall: ToolCall = { id, name, input }
      toolCallMap.set(id, toolCall)

      steps.push({
        role: "assistant",
        toolCalls: [toolCall],
        timestamp: rec.timestamp * 1000,
      })
    } else if (et === "chat.tool_result") {
      // Tool result event — payload: {event_type, result, tool_name, tool_call_id}
      const result = (payload.result as string) ?? rec.content ?? ""
      const toolName = (payload.tool_name as string) ?? ""
      const toolCallId = (payload.tool_call_id as string) ?? ""

      // Enrich matching ToolCall
      if (toolCallId) {
        const tc = toolCallMap.get(toolCallId)
        if (tc) tc.output = result
      }

      steps.push({
        role: "tool",
        toolCalls: [{
          id: toolCallId || `tr-${rec.timestamp}`,
          name: toolName,
          input: {},
          output: result,
        }],
        timestamp: rec.timestamp * 1000,
      })
    } else if (et === "chat.final") {
      finalText = rec.content
      steps.push({
        role: "assistant",
        text: rec.content,
        toolCalls: [],
        timestamp: rec.timestamp * 1000,
      })
    } else if (et === "chat.error") {
      log.warn(`JiuwenClaw error event: ${rec.content}`)
    }
    // Skip chat.delta, chat.processing_status, etc.
  }

  // Fallback: if no chat.final, use the last assistant content
  if (!finalText) {
    for (let i = records.length - 1; i >= 0; i--) {
      const rec = records[i]!
      if (rec.role === "assistant" && rec.content && rec.event_type !== "chat.tool_call") {
        finalText = rec.content
        break
      }
    }
  }

  return {
    text: finalText,
    steps,
    tokens: emptyTokenUsage(),
    cost: 0,
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
 * Resolve jiuwenclaw-cli command.
 * Priority: custom path from skvm.config.json → globally installed `jiuwenclaw-cli`.
 */
export async function resolveJiuwenClawCmd(): Promise<string[]> {
  // 1. Custom path from config — run via python3 -m jiuwenclaw.app_cli
  const repoDir = getAdapterRepoDir("jiuwenclaw")
  if (repoDir) {
    const mainModule = path.join(repoDir, "jiuwenclaw", "app_cli.py")
    if (await Bun.file(mainModule).exists()) {
      log.info(`Using jiuwenclaw from source: ${repoDir}`)
      return ["python3", "-m", "jiuwenclaw.app_cli"]
    }
    throw new Error(`jiuwenclaw not found at ${repoDir} (no jiuwenclaw/app_cli.py)`)
  }

  // 2. Global install
  const { exitCode, stdout } = await runCommandWithEnv(["which", "jiuwenclaw-cli"])
  if (exitCode === 0 && stdout.trim()) {
    log.info(`Using global jiuwenclaw-cli: ${stdout.trim()}`)
    return [stdout.trim()]
  }
  throw new Error(
    "jiuwenclaw-cli not found. Either install it globally or set adapters.jiuwenclaw in skvm.config.json",
  )
}

/**
 * Resolve the python interpreter that should run `python3 -m jiuwenclaw.app`.
 *
 * For source-checkout mode (`repoDir` set), `cmdPrefix[0]` is the literal
 * string "python3" — fall back to PATH resolution because `run()` already
 * uses the same active python for `app_cli`, so if it works there it works
 * here.
 *
 * For global-install mode, `cliFirstArg` is the absolute path to the
 * `jiuwenclaw-cli` script, which is a Python entry-point with a shebang
 * pointing at the venv interpreter (true for venv, virtualenv, pipx, and
 * any pip-installed setup). Use that interpreter directly so the sidecar
 * never depends on whether the active PATH happens to expose the same venv.
 */
/** Match `python`, `python3`, `python3.12`, etc. — basename only, no version suffix tricks. */
function isPythonInterpreter(p: string): boolean {
  return /^python(?:3(?:\.\d+)?)?$/.test(path.basename(p))
}

async function resolveSidecarPython(
  repoDir: string | undefined,
  cliFirstArg: string,
): Promise<string> {
  if (repoDir) return "python3"

  // Try shebang first (handles `#!/abs/path/python` and `#!/usr/bin/env python3`).
  // Only trust the shebang if its interpreter actually looks like a Python —
  // a `#!/bin/sh` wrapper script that activates a venv before exec'ing the
  // real CLI would otherwise leave us trying to run `/bin/sh -m jiuwenclaw.app`.
  try {
    const head = await Bun.file(cliFirstArg).text()
    const firstLine = head.split("\n", 1)[0] ?? ""
    if (firstLine.startsWith("#!")) {
      const tokens = firstLine.slice(2).trim().split(/\s+/)
      const candidate =
        tokens[0] === "/usr/bin/env" && tokens[1]
          ? tokens[1]
          : tokens[0]
      if (candidate && isPythonInterpreter(candidate)) {
        log.debug(`jiuwenclaw sidecar python (shebang): ${candidate}`)
        return candidate
      }
      if (candidate) {
        log.debug(`jiuwenclaw shebang interpreter ${candidate} is not Python; falling through`)
      }
    }
  } catch {
    // Binary wrapper or unreadable — fall through.
  }

  // Fallback: sibling `python3` in the same bin/ directory as the CLI.
  // Covers every standard venv/virtualenv/pipx layout.
  for (const candidate of ["python3", "python"]) {
    const sibling = path.join(path.dirname(cliFirstArg), candidate)
    if (existsSync(sibling)) {
      log.debug(`jiuwenclaw sidecar python (sibling): ${sibling}`)
      return sibling
    }
  }

  log.warn(
    `jiuwenclaw could not derive sidecar python from ${cliFirstArg}; falling back to PATH "python3"`,
  )
  return "python3"
}

// ---------------------------------------------------------------------------
// JiuwenClaw Adapter
// ---------------------------------------------------------------------------

export class JiuwenClawAdapter implements AgentAdapter {
  readonly name = "jiuwenclaw"
  private model = ""
  private apiKey: string | undefined
  private timeoutMs: number = TASK_FILE_DEFAULTS.timeoutMs
  private cmdPrefix: string[] = []
  private repoDir: string | undefined
  private sidecar: ReturnType<typeof Bun.spawn> | undefined
  private envBackedUp = false
  private envWritten = false
  private lockHeld = false
  private sidecarPython = "python3"

  async setup(config: AdapterConfig): Promise<void> {
    this.model = config.model
    this.apiKey = config.apiKey
    this.timeoutMs = config.timeoutMs ?? TASK_FILE_DEFAULTS.timeoutMs
    this.repoDir = getAdapterRepoDir("jiuwenclaw")
    this.cmdPrefix = await resolveJiuwenClawCmd()
    this.sidecarPython = await resolveSidecarPython(this.repoDir, this.cmdPrefix[0]!)
    log.info(`jiuwenclaw command: ${this.cmdPrefix.join(" ")}`)
    log.info(`jiuwenclaw sidecar python: ${this.sidecarPython}`)
    log.info(`jiuwenclaw model: ${this.model}`)

    try {
      await mkdir(path.dirname(JIUWEN_LOCK_PATH), { recursive: true })
      log.info(`jiuwenclaw acquiring sidecar lock at ${JIUWEN_LOCK_PATH}`)
      await acquireFileLock(JIUWEN_LOCK_PATH, {
        staleMs: JIUWEN_LOCK_STALE_MS,
        timeoutMs: JIUWEN_LOCK_ACQUIRE_TIMEOUT_MS,
        heartbeatMs: JIUWEN_LOCK_HEARTBEAT_MS,
        // jiuwenclaw.app leaves app_agentserver + app_gateway as independent
        // children that outlive the wrapper pid, so releasing the lock on
        // abnormal parent exit would let another skvm process acquire while
        // the orphans still own port 19001 and the adapter-owned .env. Hold
        // the lock through crash recovery; same-host dead-pid reaping in
        // file-lock.ts still frees it fast for the next acquirer.
        releaseOnProcessExit: false,
      })
      this.lockHeld = true
      log.info("jiuwenclaw sidecar lock acquired")

      await this.backupEnvFile()
      await mkdir(path.dirname(JIUWEN_ENV_PATH), { recursive: true })
      await writeFile(JIUWEN_ENV_PATH, renderJiuwenEnv(this.model, this.apiKey), "utf-8")
      this.envWritten = true
      log.info(`jiuwenclaw wrote ${JIUWEN_ENV_PATH} for model=${this.model}`)

      installProcessExitHook()
      registerLiveAdapter(this)

      await this.startSidecar()
    } catch (err) {
      log.warn(`jiuwenclaw setup failed: ${(err as Error).message}; rolling back`)
      await this.teardownInternal()
      throw err
    }
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
    let skillLoaded: boolean | undefined
    let prompt = `IMPORTANT: Do not ask clarifying questions. Proceed directly with implementation. Execute all steps immediately without waiting for user input.\n\n`

    // --- Skill handling ---
    if (task.skillContent) {
      // Both modes use prompt prepend for v1 (jiuwenclaw has no well-known skill path for CLI mode)
      prompt += task.skillContent + "\n\n---\n\n"
      skillLoaded = false
    }

    prompt += task.prompt

    const startMs = performance.now()
    const sessionId = `bench_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    // --- Build command ---
    const cmd = [
      ...this.cmdPrefix,
      "acp",
      "--session-id", sessionId,
      prompt,
    ]

    // Build env with PYTHONPATH for source installs. Model routing lives in
    // ~/.jiuwenclaw/config/.env (rewritten by setup()) and is read by the
    // long-running sidecar, not the short-lived ACP stdio client below.
    const env: Record<string, string | undefined> = { ...process.env }
    if (this.repoDir) {
      env.PYTHONPATH = this.repoDir + (env.PYTHONPATH ? `:${env.PYTHONPATH}` : "")
    }
    if (this.apiKey) {
      env.OPENROUTER_API_KEY = this.apiKey
    }

    const { stdout, stderr, exitCode, timedOut } = await runCommandWithEnv(cmd, {
      cwd: task.workDir,
      timeout: task.timeoutMs ?? this.timeoutMs,
      env,
    })

    const durationMs = performance.now() - startMs

    if (exitCode !== 0 && stderr) {
      log.warn(`jiuwenclaw exited with code ${exitCode}: ${stderr.slice(0, 200)}`)
    }

    // --- Parse JSON-RPC response from stdout ---
    let responseText = ""
    let responseSessionId = sessionId
    try {
      const rpc = JSON.parse(stdout.trim()) as {
        jsonrpc: string
        id: string
        result?: Record<string, unknown>
        error?: { code: number; message: string }
      }
      if (rpc.error) {
        log.warn(`jiuwenclaw JSON-RPC error: ${rpc.error.message}`)
      }
      if (rpc.result) {
        responseText = (rpc.result.content as string) ?? (rpc.result.response as string) ?? ""
        responseSessionId = (rpc.result.session_id as string) ?? sessionId
      }
    } catch {
      log.warn(`Failed to parse jiuwenclaw JSON-RPC response: ${stdout.slice(0, 200)}`)
      responseText = stdout.trim()
    }

    // --- Read history.json for detailed conversation data ---
    const historyPath = path.join(
      process.env.HOME ?? "",
      ".jiuwenclaw", "agent", "sessions", responseSessionId, "history.json",
    )

    // history.json is the AUXILIARY source for richer per-step data. The
    // primary signal that the agent ran is the JSON-RPC `responseText` and
    // the populated workDir — when history.json is missing or malformed we
    // lose telemetry but the workDir is still trustworthy. Mark 'ok' so the
    // runner gate evaluates normally; subprocess-level failures (timeout,
    // non-zero exit) are upgraded to non-ok further down. Per CLAUDE.md the
    // upstream CLI does not always persist token/cost data — this branch is
    // jiuwenclaw's normal reduced-telemetry mode, NOT a failure. See round-3
    // Codex review for the regression that drove this fix.
    let result: RunResult
    const historyFile = Bun.file(historyPath)
    if (await historyFile.exists()) {
      try {
        const historyData = await historyFile.json() as HistoryRecord[]
        result = parseJiuwenClawHistory(historyData, task.workDir, durationMs)
        log.debug(`Parsed ${historyData.length} history records from ${historyPath}`)
      } catch (err) {
        log.warn(`Failed to parse jiuwenclaw history.json: ${err}`)
        result = buildMinimalResult(responseText, task.workDir, durationMs, "ok",
          `jiuwenclaw history.json invalid: ${String(err).slice(0, 200)} — telemetry unavailable, workDir scored as-is`)
      }
    } else {
      log.debug(`No history.json found at ${historyPath}, using JSON-RPC response only`)
      result = buildMinimalResult(responseText, task.workDir, durationMs, "ok",
        `jiuwenclaw history.json not written at ${historyPath} — telemetry unavailable, workDir scored as-is`)
    }

    // --- Save conv log ---
    if (task.convLog) {
      try {
        const destDir = path.dirname(task.convLog.filePath)
        await mkdir(destDir, { recursive: true })
        // Save both JSON-RPC response and history.json if available
        let logContent = stdout
        if (await historyFile.exists()) {
          const historyText = await historyFile.text()
          logContent = JSON.stringify({
            jsonrpc_response: stdout.trim(),
            history: JSON.parse(historyText),
          }, null, 2)
        }
        await Bun.write(task.convLog.filePath, logContent)
        log.debug(`Saved jiuwenclaw conv log to ${task.convLog.filePath}`)
      } catch (err) {
        log.warn(`Failed to save jiuwenclaw conv log: ${err}`)
      }
    }

    // --- Verify skill loaded ---
    if (task.skillContent && skillLoaded === false) {
      // Inject: if agent produced any steps, skill was loaded (it's in the prompt)
      if (result.steps.length > 0) {
        skillLoaded = true
      }
      // Check if response text references skill content
      if (!skillLoaded) {
        const skillSnippet = task.skillContent.replace(/^#.*\n/m, "").trim().slice(0, 60)
        if (skillSnippet.length > 20 && result.text.includes(skillSnippet)) {
          skillLoaded = true
        }
      }
    }

    if (skillLoaded !== undefined) {
      result.skillLoaded = skillLoaded
    }
    // jiuwenclaw's app_cli + acp_channel log INFO messages to stderr as a
    // matter of course (e.g. "[CLI] starting ACP stdio gateway"), so we can't
    // treat a non-empty stderr as a failure. Only exitCode != 0 is a real
    // error — the parsed RunResult is authoritative.
    //
    // Subprocess-level failure overrides any earlier 'ok' / 'parse-failed'
    // status that buildMinimalResult / parseJiuwenClawHistory may have set.
    if (timedOut) {
      result.runStatus = "timeout"
      result.statusDetail = `jiuwenclaw subprocess killed after ${task.timeoutMs ?? this.timeoutMs}ms`
    } else if (exitCode !== 0) {
      result.runStatus = "adapter-crashed"
      result.statusDetail = `jiuwenclaw exited with code ${exitCode}`
    }
    if (exitCode !== 0) {
      result.adapterError = { exitCode, stderr: stderr.slice(0, 2000) }
    }
    return result
  }

  async teardown(): Promise<void> {
    await this.teardownInternal()
  }

  /** Idempotent teardown used by both teardown() and the setup() rollback. */
  private async teardownInternal(): Promise<void> {
    unregisterLiveAdapter(this)
    try {
      await this.stopSidecar()
    } finally {
      try {
        await this.restoreEnvFile()
      } finally {
        if (this.lockHeld) {
          try {
            releaseFileLock(JIUWEN_LOCK_PATH)
            log.info("jiuwenclaw sidecar lock released")
          } catch (err) {
            log.warn(`jiuwenclaw failed to release lock: ${(err as Error).message}`)
          }
          this.lockHeld = false
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // .env backup / restore
  // -------------------------------------------------------------------------

  private async backupEnvFile(): Promise<void> {
    if (!existsSync(JIUWEN_ENV_PATH)) {
      // No existing file to preserve; teardown will simply unlink the one we
      // write.
      this.envBackedUp = false
      return
    }
    // If a backup already exists from a previous crashed run, leave it alone —
    // that backup holds the true original.
    if (!existsSync(JIUWEN_ENV_BACKUP)) {
      await copyFile(JIUWEN_ENV_PATH, JIUWEN_ENV_BACKUP)
      log.debug(`jiuwenclaw backed up .env → ${JIUWEN_ENV_BACKUP}`)
    } else {
      log.warn(
        `jiuwenclaw found stale backup at ${JIUWEN_ENV_BACKUP}; reusing it as the original`,
      )
    }
    this.envBackedUp = true
  }

  private async restoreEnvFile(): Promise<void> {
    // Idempotent: both guards key off of "did *this* setup call own the .env",
    // so a second teardown invocation is a no-op and cannot delete a restored
    // original.
    if (this.envBackedUp && existsSync(JIUWEN_ENV_BACKUP)) {
      try {
        await copyFile(JIUWEN_ENV_BACKUP, JIUWEN_ENV_PATH)
        await unlink(JIUWEN_ENV_BACKUP)
        log.debug("jiuwenclaw .env restored from backup")
      } catch (err) {
        log.warn(`jiuwenclaw failed to restore .env: ${(err as Error).message}`)
      }
    } else if (this.envWritten && !this.envBackedUp && existsSync(JIUWEN_ENV_PATH)) {
      // We wrote .env but there was no original to preserve. Remove the
      // adapter-written file so a future run starts from a clean slate.
      try {
        await unlink(JIUWEN_ENV_PATH)
      } catch { /* ignore */ }
    }
    this.envBackedUp = false
    this.envWritten = false
  }

  // -------------------------------------------------------------------------
  // Sidecar spawn + shutdown
  // -------------------------------------------------------------------------

  private async startSidecar(): Promise<void> {
    // Pre-flight: because we hold JIUWEN_LOCK_PATH, port 19001 should be free.
    // If it is not, an orphan sidecar from a prior crash / manual experiment
    // is still running and we would silently attach to it, running the wrong
    // target model. Kill the orphan (we own the lock so this is safe) and
    // wait for the port to clear before spawning our own.
    if (await tcpProbe(GATEWAY_HOST, GATEWAY_PORT)) {
      log.warn(`jiuwenclaw port ${GATEWAY_PORT} already in use; killing orphan sidecar`)
      try {
        const killProc = Bun.spawn(["pkill", "-f", "jiuwenclaw\\.app"], { stdout: "pipe", stderr: "pipe" })
        await killProc.exited
      } catch { /* ignore */ }
      // Wait up to 5s for the port to actually release.
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        if (!(await tcpProbe(GATEWAY_HOST, GATEWAY_PORT))) break
        await Bun.sleep(200)
      }
      if (await tcpProbe(GATEWAY_HOST, GATEWAY_PORT)) {
        throw new Error(
          `jiuwenclaw port ${GATEWAY_PORT} still in use after pkill — please kill jiuwenclaw.app manually`,
        )
      }
      log.info(`jiuwenclaw orphan sidecar cleared from port ${GATEWAY_PORT}`)
    }

    // repoDir is optional: when the user configured a source checkout we use
    // it as both cwd and PYTHONPATH; when only a venv-installed
    // `jiuwenclaw-cli` is available, `python3 -m jiuwenclaw.app` resolves from
    // site-packages and cwd doesn't matter.
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v
    }
    if (this.repoDir) {
      env.PYTHONPATH = this.repoDir + (env.PYTHONPATH ? `:${env.PYTHONPATH}` : "")
    }
    env.PYTHONIOENCODING = "utf-8"
    if (this.apiKey) env.OPENROUTER_API_KEY = this.apiKey

    const cwd = this.repoDir ?? process.cwd()
    log.info(`jiuwenclaw spawning sidecar: ${this.sidecarPython} -m jiuwenclaw.app (cwd=${cwd})`)
    const proc = Bun.spawn([this.sidecarPython, "-m", "jiuwenclaw.app"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env,
    })
    this.sidecar = proc

    pumpToLogger(proc.stdout as ReadableStream<Uint8Array> | null, "sidecar.stdout")
    pumpToLogger(proc.stderr as ReadableStream<Uint8Array> | null, "sidecar.stderr")

    const deadline = Date.now() + SIDECAR_READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (proc.exitCode !== null && proc.exitCode !== undefined) {
        throw new Error(
          `jiuwenclaw sidecar exited prematurely with code ${proc.exitCode} before gateway became ready`,
        )
      }
      if (await tcpProbe(GATEWAY_HOST, GATEWAY_PORT)) {
        log.info(`jiuwenclaw sidecar ready on ${GATEWAY_HOST}:${GATEWAY_PORT}`)
        return
      }
      await Bun.sleep(500)
    }

    // Timed out — kill whatever we spawned and fail.
    try { proc.kill() } catch { /* ignore */ }
    throw new Error(
      `jiuwenclaw sidecar did not reach ${GATEWAY_HOST}:${GATEWAY_PORT} within ${SIDECAR_READY_TIMEOUT_MS}ms`,
    )
  }

  private async stopSidecar(): Promise<void> {
    const proc = this.sidecar
    this.sidecar = undefined

    if (proc && proc.exitCode === null) {
      try {
        proc.kill("SIGTERM")
      } catch { /* ignore */ }

      const timer = Bun.sleep(SIDECAR_SHUTDOWN_TIMEOUT_MS).then(() => "timeout" as const)
      const exited = proc.exited.then(() => "exited" as const)
      const outcome = await Promise.race([timer, exited])
      if (outcome === "timeout") {
        log.warn("jiuwenclaw sidecar did not exit within 15s; sending SIGKILL")
        try { proc.kill("SIGKILL") } catch { /* ignore */ }
        try { await proc.exited } catch { /* ignore */ }
      }
    }

    // jiuwenclaw/app.py's main() Popens app_agentserver + app_gateway as
    // independent children, and only runs its `_terminate_all()` finally block
    // on KeyboardInterrupt — not on SIGTERM. So killing the orchestrator
    // reliably leaves its two children orphaned. We own the sidecar lock, so
    // sweep any remaining jiuwenclaw.app* processes and wait for the port to
    // clear.
    try {
      const killProc = Bun.spawn(["pkill", "-f", "jiuwenclaw\\.app"], { stdout: "pipe", stderr: "pipe" })
      await killProc.exited
    } catch { /* ignore */ }

    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (!(await tcpProbe(GATEWAY_HOST, GATEWAY_PORT))) break
      await Bun.sleep(200)
    }
    log.info("jiuwenclaw sidecar stopped")
  }
}

// ---------------------------------------------------------------------------
// Module-level sidecar helpers
// ---------------------------------------------------------------------------

/**
 * Build a deterministic minimal .env for the sidecar. SkVM benchmarks must be
 * reproducible across users, so we **clobber** the user's `.env` rather than
 * merging — the same skill × model run on a different machine has to see the
 * same toolset. Concretely:
 *
 * - The four routing keys point at the SkVM-controlled OpenRouter endpoint
 *   and the run's target model.
 * - `BROWSER_RUNTIME_MCP_ENABLED=0` defensively disables jiuwenclaw's browser
 *   runtime / Playwright MCP integration. The stock jiuwenclaw `.env.template`
 *   ships with this flag set to `1`, which would otherwise change the agent's
 *   available toolset (and try to spawn a Playwright runtime on port 8940).
 *
 * Other optional credentials (`SERPER_API_KEY`, `JINA_API_KEY`, `VISION_*`,
 * `AUDIO_*`, …) are intentionally **not preserved**. If a future skill needs
 * those tools, they should be plumbed through SkVM-level config so every user
 * benchmarks the same configuration, not picked up out-of-band from each
 * developer's local `.env`. The pre-run file is captured in
 * `.env.skvm-backup` and restored on teardown, so the user's credentials are
 * not lost — only suppressed for the duration of the run.
 */
function renderJiuwenEnv(model: string, apiKey: string | undefined): string {
  const key = apiKey ?? process.env.OPENROUTER_API_KEY ?? ""
  return [
    `API_BASE="https://openrouter.ai/api/v1"`,
    `API_KEY="${key}"`,
    `MODEL_NAME="${model}"`,
    `MODEL_PROVIDER=OpenAI`,
    `BROWSER_RUNTIME_MCP_ENABLED=0`,
    ``,
  ].join("\n")
}

async function tcpProbe(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port })
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* ignore */ }
      resolve(ok)
    }
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
    // Guard against weird hangs on half-open sockets.
    socket.setTimeout(2000, () => done(false))
  })
}

/** Pipe a Bun subprocess stdout/stderr stream into the logger, line by line. */
function pumpToLogger(stream: ReadableStream<Uint8Array> | null, tag: string): void {
  if (!stream) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  const loop = async () => {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          if (line.trim()) log.debug(`[${tag}] ${line}`)
        }
      }
      if (buf.trim()) log.debug(`[${tag}] ${buf}`)
    } catch { /* ignore */ }
  }
  void loop()
}

// ---------------------------------------------------------------------------
// Process-exit safety net
// ---------------------------------------------------------------------------
//
// If the SkVM process is interrupted mid-run, best-effort kill the sidecar
// and restore ~/.jiuwenclaw/config/.env so the user's config isn't left in
// an adapter-owned state. The file lock already auto-releases on process exit
// (see src/core/file-lock.ts); this hook only handles the sidecar + .env.

const liveAdapters = new Set<JiuwenClawAdapter>()
let exitHookInstalled = false

function registerLiveAdapter(a: JiuwenClawAdapter): void {
  liveAdapters.add(a)
}

function unregisterLiveAdapter(a: JiuwenClawAdapter): void {
  liveAdapters.delete(a)
}

function installProcessExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true

  const cleanupSync = () => {
    // Best-effort: on synchronous `exit`, we can only issue SIGKILL and copy
    // files synchronously. Use the node:fs sync APIs.
    const { copyFileSync, unlinkSync } = require("node:fs") as typeof import("node:fs")
    for (const a of liveAdapters) {
      try {
        // Access private fields via bracket notation (trusted call — same
        // module).
        const proc = (a as unknown as { sidecar?: { kill: (sig?: number | string) => void } }).sidecar
        if (proc) {
          try { proc.kill("SIGKILL") } catch { /* ignore */ }
        }
        const envBackedUp = (a as unknown as { envBackedUp: boolean }).envBackedUp
        if (envBackedUp && existsSync(JIUWEN_ENV_BACKUP)) {
          try { copyFileSync(JIUWEN_ENV_BACKUP, JIUWEN_ENV_PATH) } catch { /* ignore */ }
          try { unlinkSync(JIUWEN_ENV_BACKUP) } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
  }

  process.on("exit", cleanupSync)
  const signalExit = (sig: NodeJS.Signals) => {
    cleanupSync()
    // Re-raise so default disposition runs and the process actually exits.
    process.kill(process.pid, sig)
  }
  process.once("SIGINT", signalExit)
  process.once("SIGTERM", signalExit)
  process.once("SIGHUP", signalExit)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMinimalResult(
  text: string,
  workDir: string,
  durationMs: number,
  runStatus: RunResult["runStatus"],
  statusDetail?: string,
): RunResult {
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
