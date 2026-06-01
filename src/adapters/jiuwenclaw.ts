import { mkdir, copyFile, writeFile, unlink, readdir, stat, realpath } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import net from "node:net"
import type { AgentAdapter, AdapterConfig, RunResult, AgentStep, ToolCall, SkillBundle, SkillMode, TokenUsage } from "../core/types.ts"
import { emptyTokenUsage, addTokenUsage } from "../core/types.ts"
import { createLogger } from "../core/logger.ts"
import { getAdapterRepoDir, stripRoutingPrefix } from "../core/config.ts"
import { acquireFileLock, releaseFileLock } from "../core/file-lock.ts"
import { runCommandWithEnv } from "./hermes.ts"
import { TASK_FILE_DEFAULTS } from "../core/ui-defaults.ts"
import { resolveRoute, resolveRouteApiKey, validateModelIdForRoute } from "../providers/registry.ts"
import { diagnoseJiuwenclaw } from "./diagnose-failure.ts"

const log = createLogger("jiuwenclaw")

// ---------------------------------------------------------------------------
// Sidecar lifecycle constants
// ---------------------------------------------------------------------------
//
// Jiuwenclaw (renamed jiuwenswarm upstream) AgentServer reads its LLM
// credentials and target model from ~/.jiuwenswarm/config/.env at *startup*
// (jiuwenswarm/app.py → load_dotenv → resources/config.yaml
// ${API_BASE}/${API_KEY}/${MODEL_NAME}/${MODEL_PROVIDER}). There is no
// per-request model override — the ACP session/prompt request only carries
// `content`. So each target model needs its own sidecar launched with its
// own .env.
//
// Port 19001 and ~/.jiuwenswarm/config/.env are both user-global singletons,
// so at most one sidecar may live at a time across all processes on the host.
// We enforce that with a cross-process file lock (reused from openclaw's
// pattern). The SkVM adapter name stays `jiuwenclaw` for stable CLI / cache /
// proposals paths even though the upstream package was renamed.

const HOME = process.env.HOME ?? ""
const JIUWEN_DIR = path.join(HOME, ".jiuwenswarm")
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
 * A single record in ~/.jiuwenswarm/agent/sessions/{session_id}/history.json.
 *
 * Upstream writes per-event fields directly on the record (flat shape); the
 * fields below are populated based on `event_type`. See
 * jiuwenswarm/server/runtime/session/session_history.py and
 * jiuwenswarm/server/runtime/agent_adapter/interface_deep.py for the write logic.
 */
interface HistoryRecord {
  id: string
  role: "user" | "assistant"
  request_id: string
  channel_id: string
  timestamp: number
  content: string
  event_type?: string
  /** chat.tool_call: function name, arguments JSON, tool_call_id */
  tool_call?: { name?: string; arguments?: string; tool_call_id?: string }
  /** chat.tool_result */
  result?: string
  tool_name?: string
  tool_call_id?: string
  /** chat.usage_metadata */
  metadata?: { usage_metadata?: Record<string, unknown> }
  /** chat.error: exception class (e.g. "ValueError") */
  error_type?: string
}

// ---------------------------------------------------------------------------
// History Parsing
// ---------------------------------------------------------------------------

/**
 * Parse jiuwenclaw history.json records into a RunResult.
 *
 * Tokens and cost are summed from `chat.usage_metadata` events emitted per
 * LLM round-trip; the trailing `chat.usage_summary` aggregate is ignored
 * (redundant with the per-call sum and lacks cost). Tool calls and tool
 * results stream as flat fields on each record (upstream stopped nesting
 * under `event_payload` -- see jiuwenclaw `session_history.append_history_record`).
 */
export function parseJiuwenClawHistory(
  records: HistoryRecord[],
  workDir: string,
  durationMs: number,
): RunResult {
  const steps: AgentStep[] = []
  let finalText = ""
  let tokens: TokenUsage = emptyTokenUsage()
  let cost = 0

  for (const rec of records) {
    if (rec.role === "user") continue

    switch (rec.event_type) {
      case "chat.tool_call": {
        const tc = rec.tool_call ?? {}
        const id = tc.tool_call_id ?? `tc-${rec.timestamp}`
        const name = tc.name ?? ""
        let input: Record<string, unknown> = {}
        if (typeof tc.arguments === "string") {
          try { input = JSON.parse(tc.arguments) } catch { /* keep empty */ }
        }
        steps.push({
          role: "assistant",
          toolCalls: [{ id, name, input }],
          timestamp: rec.timestamp * 1000,
        })
        break
      }
      case "chat.tool_result": {
        const id = rec.tool_call_id ?? `tr-${rec.timestamp}`
        steps.push({
          role: "tool",
          toolCalls: [{
            id,
            name: rec.tool_name ?? "",
            input: {},
            output: rec.result ?? rec.content ?? "",
          }],
          timestamp: rec.timestamp * 1000,
        })
        break
      }
      case "chat.usage_metadata": {
        const usage = rec.metadata?.usage_metadata ?? {}
        const inT = Number(usage.input_tokens ?? 0)
        const outT = Number(usage.output_tokens ?? 0)
        tokens = addTokenUsage(tokens, {
          input: Number.isFinite(inT) ? inT : 0,
          output: Number.isFinite(outT) ? outT : 0,
          cacheRead: 0,
          cacheWrite: 0,
        })
        const c = Number(usage.total_cost ?? 0)
        if (Number.isFinite(c)) cost += c
        break
      }
      case "chat.final": {
        finalText = rec.content
        steps.push({
          role: "assistant",
          text: rec.content,
          toolCalls: [],
          timestamp: rec.timestamp * 1000,
        })
        break
      }
      case "chat.error": {
        const prefix = rec.error_type ? `[${rec.error_type}] ` : ""
        log.warn(`JiuwenClaw error event: ${prefix}${rec.content}`)
        break
      }
      // chat.delta, chat.tool_update (in-progress), chat.usage_summary (aggregate),
      // chat.processing_status: deliberately skipped — they don't add signal beyond
      // the per-event records above.
    }
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
    tokens,
    cost,
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
 * Resolve the ACP stdio bridge command (upstream renamed `jiuwenclaw-cli` to
 * `jiuwenswarm-tui`; new module path is `jiuwenswarm.channels.acp.app_acp`).
 * Priority: custom path from skvm.config.json → globally installed binary.
 */
export async function resolveJiuwenClawCmd(): Promise<string[]> {
  // 1. Custom path from config — run via python3 -m jiuwenswarm.channels.acp.app_acp
  const repoDir = getAdapterRepoDir("jiuwenclaw")
  if (repoDir) {
    const mainModule = path.join(repoDir, "jiuwenswarm", "channels", "acp", "app_acp.py")
    if (await Bun.file(mainModule).exists()) {
      log.info(`Using jiuwenswarm from source: ${repoDir}`)
      return ["python3", "-m", "jiuwenswarm.channels.acp.app_acp"]
    }
    throw new Error(
      `jiuwenswarm not found at ${repoDir} (no jiuwenswarm/channels/acp/app_acp.py)`,
    )
  }

  // 2. Global install
  const { exitCode, stdout } = await runCommandWithEnv(["which", "jiuwenswarm-tui"])
  if (exitCode === 0 && stdout.trim()) {
    log.info(`Using global jiuwenswarm-tui: ${stdout.trim()}`)
    return [stdout.trim()]
  }
  throw new Error(
    "jiuwenswarm-tui not found. Either install it globally or set adapters.jiuwenclaw in skvm.config.json",
  )
}

/**
 * Resolve the python interpreter that should run `python3 -m jiuwenswarm.app`.
 *
 * For source-checkout mode (`repoDir` set), `cmdPrefix[0]` is the literal
 * string "python3" — fall back to PATH resolution because `run()` already
 * uses the same active python for `app_cli`, so if it works there it works
 * here.
 *
 * For global-install mode, `cliFirstArg` is the absolute path to the
 * `jiuwenswarm-tui` script, which is a Python entry-point with a shebang
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
  // real CLI would otherwise leave us trying to run `/bin/sh -m jiuwenswarm.app`.
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
  // setup/teardown are refcounted so the bench orchestrator can hold a
  // session-long sidecar across many task runs while `runTask` (which does
  // its own setup/teardown around each task) becomes a no-op for the
  // jiuwenclaw adapter. Without this, the inner setup() blocks on the
  // host-wide sidecar lock the orchestrator already owns.
  private setupCount = 0

  async setup(config: AdapterConfig): Promise<void> {
    if (this.setupCount > 0) {
      this.setupCount += 1
      return
    }
    this.model = config.model
    this.apiKey = config.apiKey
    this.timeoutMs = config.timeoutMs ?? TASK_FILE_DEFAULTS.timeoutMs
    const mode = config.mode ?? "managed"
    if (mode === "native") {
      throw new Error(
        "jiuwenclaw does not support --adapter-config=native: its set_user_home() Python API " +
        "only scopes config for the in-process Python side, not for the subprocess AgentServer " +
        "+ gateway sidecars. Use --adapter-config=managed (or set defaults.adapterConfigMode=managed " +
        "in skvm.config.json) — skvm writes a minimal ~/.jiuwenswarm/config/.env from providers.routes " +
        "and backs up / restores the user's .env around the run.",
      )
    }
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
        // jiuwenswarm.app leaves app_agentserver + app_gateway as independent
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
      this.setupCount = 1
    } catch (err) {
      log.warn(`jiuwenclaw setup failed: ${(err as Error).message}; rolling back`)
      await this.teardownInternal()
      throw err
    }
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

    // Resolve symlinks (macOS mkdtemp hands back /var/folders/... which is a
    // symlink to /private/var/folders/...). jiuwenswarm scopes the agent's
    // workspace by passing --workspace-dir through Path.resolve(), so its
    // fs_operation sandbox checks writes against the *realpath*. If we hand the
    // agent the raw /var/... path in the hint and --workspace-dir, any
    // ABSOLUTE path it writes (/var/...) fails the membership check against the
    // resolved workspace (/private/var/...) and the write is silently dropped
    // (empty tool result, no file). Relative paths happen to work because they
    // resolve against the already-resolved cwd — but models that emit absolute
    // paths from the hint then score 0 on every file-output task. Resolve once
    // so the hint, --workspace-dir, and the agent's absolute paths all agree.
    const workDir = await realpath(task.workDir).catch(() => task.workDir)

    let prompt = `IMPORTANT: Do not ask clarifying questions. Proceed directly with implementation. Execute all steps immediately without waiting for user input.\n\n`

    // Filesystem tools resolve relative paths against sys_operation.work_dir
    // (scoped to workDir via --workspace-dir below); the hint nudges the model
    // to use them instead of hard-coding home-dir paths.
    prompt += `Your working directory is ${workDir}. Use relative paths (or absolute paths under that directory) for all file operations.\n\n`

    // --- Skill handling ---
    if (task.skill) {
      // Both modes use prompt prepend for v1 (jiuwenclaw has no well-known skill path for CLI mode)
      prompt += task.skill.content + "\n\n---\n\n"
      skillLoaded = false
    }

    prompt += task.prompt

    const startMs = performance.now()
    const sessionId = `bench_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    // jiuwenclaw's AgentServer maps the client-supplied session_id to an
    // internal `acp_*` id and writes history.json under the internal path.
    // The wire protocol surfaces only the external id back to the client, so
    // we observe the sessions/ directory pre/post-run and pick the newly
    // created entry as the correct path. Workaround pending an upstream fix
    // that surfaces the internal mapping (or writes history under the
    // external id directly).
    const sessionsRoot = path.join(JIUWEN_DIR, "agent", "sessions")
    const sessionsBefore = await snapshotSessionDirs(sessionsRoot)

    // --- Build command ---
    const cmd = [
      ...this.cmdPrefix,
      "acp",
      "--session-id", sessionId,
      "--workspace-dir", workDir,
      prompt,
    ]

    // Build env with PYTHONPATH for source installs. Model routing lives in
    // ~/.jiuwenswarm/config/.env (rewritten by setup()) and is read by the
    // long-running sidecar, not the short-lived ACP stdio client below.
    const env: Record<string, string | undefined> = { ...process.env }
    if (this.repoDir) {
      env.PYTHONPATH = this.repoDir + (env.PYTHONPATH ? `:${env.PYTHONPATH}` : "")
    }
    if (this.apiKey) {
      env.OPENROUTER_API_KEY = this.apiKey
    }

    const { stdout, stderr, exitCode, timedOut } = await runCommandWithEnv(cmd, {
      cwd: workDir,
      timeout: task.timeoutMs ?? this.timeoutMs,
      env,
    })

    const durationMs = performance.now() - startMs

    if (exitCode !== 0 && stderr) {
      log.warn(`jiuwenclaw exited with code ${exitCode}: ${stderr.slice(0, 2000)}`)
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

    // --- Read history.json ---
    // history.json is auxiliary: the primary run signal is responseText +
    // workDir contents, so missing/malformed history downgrades telemetry
    // but stays runStatus=ok. Subprocess-level failures (timeout / non-zero
    // exit) override below. We try the externally-known session id first,
    // then fall back to a freshly-created session dir (see snapshotSessionDirs
    // above) because AgentServer writes history under an internal id we
    // don't see on the wire.
    let result: RunResult | undefined
    let usedHistoryPath: string | undefined
    let usedHistoryText: string | undefined
    const candidates = await historyCandidatePaths(
      path.join(sessionsRoot, responseSessionId, "history.json"),
      sessionsRoot,
      sessionsBefore,
    )
    for (const candidate of candidates) {
      let text: string
      try {
        text = await Bun.file(candidate).text()
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== "ENOENT") {
          log.warn(`Failed to read jiuwenclaw history.json at ${candidate}: ${err}`)
        }
        continue
      }
      try {
        const historyData = JSON.parse(text) as HistoryRecord[]
        result = parseJiuwenClawHistory(historyData, workDir, durationMs)
        usedHistoryPath = candidate
        usedHistoryText = text
        log.debug(`Parsed ${historyData.length} history records from ${candidate}`)
        break
      } catch (err) {
        log.warn(`Failed to parse jiuwenclaw history.json at ${candidate}: ${err}`)
        result = buildMinimalResult(responseText, workDir, durationMs, "ok",
          `jiuwenclaw history.json invalid: ${String(err).slice(0, 200)} — telemetry unavailable, workDir scored as-is`)
        usedHistoryPath = candidate
        break
      }
    }
    if (!result) {
      log.debug(`No history.json near ${candidates[0]}, using JSON-RPC response only`)
      result = buildMinimalResult(responseText, workDir, durationMs, "ok",
        `jiuwenclaw history.json not written for session ${responseSessionId} — telemetry unavailable, workDir scored as-is`)
    }

    // --- Save conv log ---
    if (task.convLog) {
      try {
        const destDir = path.dirname(task.convLog.filePath)
        await mkdir(destDir, { recursive: true })
        let logContent = stdout
        if (usedHistoryText !== undefined) {
          try {
            logContent = JSON.stringify({
              jsonrpc_response: stdout.trim(),
              history: JSON.parse(usedHistoryText),
            }, null, 2)
          } catch { /* fall back to plain stdout */ }
        }
        await Bun.write(task.convLog.filePath, logContent)
        log.debug(`Saved jiuwenclaw conv log to ${task.convLog.filePath}`)
      } catch (err) {
        log.warn(`Failed to save jiuwenclaw conv log: ${err}`)
      }
    }

    // --- Verify skill loaded ---
    if (task.skill && skillLoaded === false) {
      // Inject: if agent produced any steps, skill was loaded (it's in the prompt)
      if (result.steps.length > 0) {
        skillLoaded = true
      }
      // Check if response text references skill content
      if (!skillLoaded) {
        const skillSnippet = task.skill.content.replace(/^#.*\n/m, "").trim().slice(0, 60)
        if (skillSnippet.length > 20 && result.text.includes(skillSnippet)) {
          skillLoaded = true
        }
      }
    }

    if (skillLoaded !== undefined) {
      result.skillLoaded = skillLoaded
    }
    // jiuwenswarm's app_acp + acp_connect log INFO messages to stderr as a
    // matter of course (e.g. "[CLI] starting ACP stdio gateway"), so we can't
    // treat a non-empty stderr as a failure. Only exitCode != 0 is a real
    // error — the parsed RunResult is authoritative.
    //
    // Subprocess-level failure overrides any earlier 'ok' / 'parse-failed'
    // status that buildMinimalResult / parseJiuwenClawHistory may have set.
    if (timedOut) {
      result.runStatus = "timeout"
      result.statusDetail = `jiuwenclaw subprocess killed after ${task.timeoutMs ?? this.timeoutMs}ms`
      // runCommandWithEnv group-killed the ACP client tree, but the long-lived
      // sidecar's AgentServer keeps running the (possibly runaway) session —
      // it is a separate process tree, not the client's child, so the client
      // timeout alone does not stop the server-side work. Without this, a
      // degenerate run (observed: 1200+ tool calls looping on memory lookups)
      // keeps burning API quota and can poison the next run sharing this
      // sidecar. Restart it to abort the session cleanly.
      log.warn("jiuwenclaw timed out; restarting sidecar to abort the server-side session")
      try {
        await this.stopSidecar()
        await this.startSidecar()
        result.statusDetail += " (sidecar restarted to clear the session)"
      } catch (err) {
        log.warn(`jiuwenclaw sidecar restart after timeout failed: ${(err as Error).message}`)
      }
    } else if (exitCode !== 0) {
      result.runStatus = "adapter-crashed"
      result.statusDetail = `jiuwenclaw exited with code ${exitCode}`
    }
    if (exitCode !== 0) {
      result.adapterError = { exitCode, stderr: stderr.slice(0, 2000) }
      const diagnosis = await diagnoseJiuwenclaw({
        sandboxRoot: JIUWEN_DIR,
        sessionId: responseSessionId,
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
    if (this.setupCount > 1) {
      this.setupCount -= 1
      return
    }
    this.setupCount = 0
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
        const killProc = Bun.spawn(["pkill", "-f", "jiuwenswarm\\.(app|server\\.app_agentserver|gateway\\.app_gateway)"], { stdout: "pipe", stderr: "pipe" })
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
          `jiuwenclaw port ${GATEWAY_PORT} still in use after pkill — please kill jiuwenswarm.app manually`,
        )
      }
      log.info(`jiuwenclaw orphan sidecar cleared from port ${GATEWAY_PORT}`)
    }

    // repoDir is optional: when the user configured a source checkout we use
    // it as both cwd and PYTHONPATH; when only a venv-installed
    // `jiuwenswarm-tui` is available, `python3 -m jiuwenswarm.app` resolves
    // from site-packages and cwd doesn't matter.
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
    log.info(`jiuwenclaw spawning sidecar: ${this.sidecarPython} -m jiuwenswarm.app (cwd=${cwd})`)
    const proc = Bun.spawn([this.sidecarPython, "-m", "jiuwenswarm.app"], {
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

    // jiuwenswarm/app.py's main() Popens app_agentserver + app_gateway as
    // independent children, and only runs its `_terminate_all()` finally block
    // on KeyboardInterrupt — not on SIGTERM. So killing the orchestrator
    // reliably leaves its two children orphaned. We own the sidecar lock, so
    // sweep any remaining jiuwenswarm.app* processes and wait for the port to
    // clear.
    try {
      const killProc = Bun.spawn(["pkill", "-f", "jiuwenswarm\\.(app|server\\.app_agentserver|gateway\\.app_gateway)"], { stdout: "pipe", stderr: "pipe" })
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
 * same toolset.
 *
 * `API_BASE` / `API_KEY` come from the route that matches the model id (or
 * the OpenRouter default when nothing matches). Anthropic-kind routes can't
 * be driven from this env shape — jiuwenclaw expects an OpenAI-format
 * `/chat/completions` endpoint at `API_BASE`, while Anthropic speaks
 * `/messages`. The route's `baseUrl` is still used if set; downstream calls
 * will surface the protocol mismatch loudly.
 *
 * `BROWSER_RUNTIME_MCP_ENABLED=0` defensively disables jiuwenclaw's browser
 * runtime / Playwright MCP integration — the stock `.env.template` ships with
 * this on, which would otherwise change the agent's available toolset (and
 * try to spawn a Playwright runtime on port 8940).
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
  const route = resolveRoute(model)
  validateModelIdForRoute(model, route)
  // jiuwenclaw's sidecar .env shape is OpenAI-only — it calls
  // `<API_BASE>/chat/completions` with `Authorization: Bearer`. Anthropic's
  // native API speaks /messages with `x-api-key`, so even with a valid
  // anthropic/* route there's no way to make jiuwenclaw drive it. Reject
  // up front so the user gets a clear config error instead of a mystery
  // HTTP failure from the sidecar.
  if (route.kind === "anthropic") {
    throw new Error(
      `jiuwenclaw adapter can't use the "${route.match}" route (kind=anthropic): ` +
      `jiuwenclaw's .env is OpenAI-format and Anthropic's API is incompatible. ` +
      `For "${model}", route it through an openrouter/* or openai-compatible ` +
      `route, or run this model on a different adapter.`,
    )
  }
  const resolvedKey = apiKey ?? resolveRouteApiKey(route) ?? ""
  const baseUrl = route.baseUrl ?? "https://openrouter.ai/api/v1"
  const modelName = stripRoutingPrefix(model)
  return [
    `API_BASE="${baseUrl}"`,
    `API_KEY="${resolvedKey}"`,
    `MODEL_NAME="${modelName}"`,
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
// and restore ~/.jiuwenswarm/config/.env so the user's config isn't left in
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

/** Snapshot session dir names so we can detect which one a fresh run wrote to. */
async function snapshotSessionDirs(sessionsRoot: string): Promise<Set<string>> {
  try {
    return new Set(await readdir(sessionsRoot))
  } catch {
    return new Set()
  }
}

/**
 * Pick the most recently created session dir that wasn't in `before`. Returns
 * `undefined` when no new dir appeared.
 */
async function pickNewSessionDir(
  sessionsRoot: string,
  before: Set<string>,
): Promise<string | undefined> {
  let names: string[]
  try {
    names = await readdir(sessionsRoot)
  } catch {
    return undefined
  }
  const fresh = names.filter((n) => !before.has(n))
  if (fresh.length === 0) return undefined
  if (fresh.length === 1) return fresh[0]
  const stats = await Promise.all(fresh.map(async (n) => {
    try {
      return { name: n, mtime: (await stat(path.join(sessionsRoot, n))).mtimeMs }
    } catch {
      return undefined
    }
  }))
  let bestName: string | undefined
  let bestMtime = -Infinity
  for (const s of stats) {
    if (s && s.mtime > bestMtime) {
      bestMtime = s.mtime
      bestName = s.name
    }
  }
  return bestName
}

/**
 * Ordered candidate paths for history.json: the externally-known session id
 * first, then any session dir created during the run (covers the
 * external→internal id remap that AgentServer applies before writing).
 */
async function historyCandidatePaths(
  primaryPath: string,
  sessionsRoot: string,
  before: Set<string>,
): Promise<string[]> {
  const paths = [primaryPath]
  const fallback = await pickNewSessionDir(sessionsRoot, before)
  if (fallback) {
    const fallbackPath = path.join(sessionsRoot, fallback, "history.json")
    if (fallbackPath !== primaryPath) paths.push(fallbackPath)
  }
  return paths
}

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
