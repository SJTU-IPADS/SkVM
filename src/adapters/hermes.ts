import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { AgentAdapter, AdapterConfig, RunResult, AgentStep, ToolCall, SkillMode } from "../core/types.ts"
import { emptyTokenUsage } from "../core/types.ts"
import { createLogger } from "../core/logger.ts"
import { getAdapterRepoDir } from "../core/config.ts"
import { runCommand } from "./opencode.ts"
import { TASK_FILE_DEFAULTS } from "../core/ui-defaults.ts"

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
  // 1. Custom path from config — run via python3 -m hermes_cli.main
  const repoDir = getAdapterRepoDir("hermes")
  if (repoDir) {
    const mainModule = path.join(repoDir, "hermes_cli", "main.py")
    if (await Bun.file(mainModule).exists()) {
      log.info(`Using hermes from source: ${repoDir}`)
      return ["python3", "-m", "hermes_cli.main"]
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

// ---------------------------------------------------------------------------
// Hermes Adapter
// ---------------------------------------------------------------------------

export class HermesAdapter implements AgentAdapter {
  readonly name = "hermes"
  private model = ""
  private maxSteps: number = TASK_FILE_DEFAULTS.maxSteps
  private timeoutMs: number = TASK_FILE_DEFAULTS.timeoutMs
  private cmdPrefix: string[] = []
  private repoDir: string | undefined

  async setup(config: AdapterConfig): Promise<void> {
    this.model = config.model
    this.maxSteps = config.maxSteps ?? TASK_FILE_DEFAULTS.maxSteps
    this.timeoutMs = config.timeoutMs ?? TASK_FILE_DEFAULTS.timeoutMs
    this.repoDir = getAdapterRepoDir("hermes")
    this.cmdPrefix = await resolveHermesCmd()
    log.info(`hermes command: ${this.cmdPrefix.join(" ")}`)
    log.info(`hermes model: ${this.model}`)
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
        // Discover mode: copy to ~/.hermes/skills/<name>/
        const skillName = task.skillMeta?.name ?? "bench-skill"
        const hermesHome = path.join(process.env.HOME ?? "", ".hermes")
        const skillDir = path.join(hermesHome, "skills", skillName)
        await mkdir(skillDir, { recursive: true })
        await Bun.write(path.join(skillDir, "SKILL.md"), task.skillContent)
        skillLoaded = false
      }
    }

    prompt += task.prompt

    const startMs = performance.now()

    // --- Build command ---
    const cmd = [
      ...this.cmdPrefix,
      "chat",
      "-Q",                           // quiet mode
      "-q", prompt,                    // single query
      "-m", this.model,                // model
      "-t", "terminal,file",           // toolsets
      "--max-turns", String(this.maxSteps),
      "--yolo",                        // bypass command approval
      "--source", "tool",              // tag for separation
    ]

    // Add --skills flag for discover mode
    if (task.skillContent && skillMode === "discover") {
      const skillName = task.skillMeta?.name ?? "bench-skill"
      cmd.push("-s", skillName)
    }

    // Build env with PYTHONPATH for source installs
    const env: Record<string, string | undefined> = { ...process.env }
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
      log.warn(`hermes exited with code ${exitCode}: ${stderr.slice(0, 200)}`)
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
