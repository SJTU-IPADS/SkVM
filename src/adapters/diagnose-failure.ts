/**
 * Per-adapter failure diagnosis.
 *
 * When an adapter exits non-zero and stderr is empty or uninformative, the
 * real reason often lives in a sandbox artifact written by the harness —
 * hermes dumps failed HTTP requests to `sessions/request_dump_*.json`,
 * opencode emits `{type: "error"}` NDJSON events, etc. Each adapter's
 * diagnose function reads its own artifact(s), extracts a one-line summary,
 * and returns `null` when nothing useful is found (caller keeps existing
 * behavior). All file I/O is wrapped in try/catch and bounded to ≤500 ms so
 * a missing / racing / slow sandbox never blocks cleanup.
 */

import path from "node:path"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { parseNDJSON, type OpenCodeEvent } from "./opencode.ts"

const DIAGNOSE_TIMEOUT_MS = 500

export interface FailureDiagnosis {
  /** One-line human reason, e.g. "OpenRouter rejected model id 'foo'". */
  summary: string
  /** Optional next step for the user. */
  hint?: string
  /** Where we pulled the info from — for log traceability. */
  source: string
}

export interface DiagnoseInput {
  sandboxRoot: string
  sessionId?: string
  agentId?: string
  stdout: string
  stderr: string
  exitCode: number
}

/** Race any diagnose work against a short deadline so we never hold up teardown. */
async function withDeadline<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  return await Promise.race([
    fn(),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), DIAGNOSE_TIMEOUT_MS)),
  ])
}

// ---------------------------------------------------------------------------
// hermes
// ---------------------------------------------------------------------------

interface HermesRequestDump {
  timestamp?: string
  session_id?: string
  reason?: string
  request?: { method?: string; url?: string; body?: { model?: string } }
  response?: { status?: number; body?: unknown }
  error?: { response_body?: unknown; message?: string }
}

function findNewestFile(dir: string, prefix: string): string | null {
  try {
    const entries = readdirSync(dir).filter((n) => n.startsWith(prefix))
    if (entries.length === 0) return null
    let newest: string | null = null
    let newestMtime = -Infinity
    for (const name of entries) {
      const full = path.join(dir, name)
      try {
        const mt = statSync(full).mtimeMs
        if (mt > newestMtime) { newest = full; newestMtime = mt }
      } catch { /* ignore */ }
    }
    return newest
  } catch { return null }
}

function extractErrorMessage(body: unknown): string | undefined {
  if (!body) return undefined
  if (typeof body === "string") return body.trim() || undefined
  if (typeof body === "object") {
    const obj = body as Record<string, unknown>
    const err = obj.error
    if (typeof err === "string") return err
    if (err && typeof err === "object") {
      const msg = (err as Record<string, unknown>).message
      if (typeof msg === "string") return msg
    }
    const msg = obj.message
    if (typeof msg === "string") return msg
  }
  return undefined
}

export async function diagnoseHermes(input: DiagnoseInput): Promise<FailureDiagnosis | null> {
  return withDeadline(async () => {
    const sessionsDir = path.join(input.sandboxRoot, "sessions")
    const dump = findNewestFile(sessionsDir, "request_dump_")
    if (dump) {
      try {
        const parsed = JSON.parse(readFileSync(dump, "utf-8")) as HermesRequestDump
        const reason = parsed.reason ?? "api_error"
        const model = parsed.request?.body?.model
        const url = parsed.request?.url
        const errMsg = extractErrorMessage(parsed.error?.response_body)
          ?? extractErrorMessage(parsed.response?.body)
          ?? parsed.error?.message
        const parts = [`hermes ${reason}`]
        if (errMsg) parts.push(errMsg)
        if (model) parts.push(`(model: ${model})`)
        const summary = parts.join(": ").replace(/: \(/, " (")
        const hint = url ? `See ${dump} or ${url}` : `See ${dump}`
        return { summary, hint, source: "hermes:request_dump" }
      } catch { /* fall through */ }
    }
    const tail = pickStderrErrorLine(input.stderr)
    if (tail) return { summary: `hermes: ${tail}`, source: "hermes:stderr" }
    return null
  }, null)
}

// ---------------------------------------------------------------------------
// openclaw
// ---------------------------------------------------------------------------

export async function diagnoseOpenclaw(input: DiagnoseInput): Promise<FailureDiagnosis | null> {
  return withDeadline(async () => {
    // 1) Transcript: last lines for any {type:"error"} or error-role message
    if (input.agentId) {
      const sessionsDir = path.join(input.sandboxRoot, "agents", input.agentId, "sessions")
      const transcriptPath = findJsonlRecursive(sessionsDir)
      if (transcriptPath) {
        try {
          const lines = readFileSync(transcriptPath, "utf-8").split("\n").filter(Boolean)
          for (let i = lines.length - 1; i >= Math.max(0, lines.length - 50); i--) {
            try {
              const entry = JSON.parse(lines[i]!) as Record<string, unknown>
              const errText = extractOpenclawError(entry)
              if (errText) return { summary: `openclaw: ${errText}`, source: "openclaw:transcript" }
            } catch { /* skip line */ }
          }
        } catch { /* ignore */ }
      }
    }
    // 2) Stderr: "lane task error: lane=… error=\"…\"" pattern
    const laneMatch = input.stderr.match(/lane task error:[^\n]*error="([^"\n]+)"/)
    if (laneMatch) return { summary: `openclaw: ${laneMatch[1]}`, source: "openclaw:stderr" }
    // 3) Generic stderr tail
    const tail = pickStderrErrorLine(input.stderr)
    if (tail) return { summary: `openclaw: ${tail}`, source: "openclaw:stderr" }
    return null
  }, null)
}

function findJsonlRecursive(root: string): string | null {
  try {
    const entries = readdirSync(root, { withFileTypes: true })
    let newestPath: string | null = null
    let newestMtime = -Infinity
    for (const e of entries) {
      const full = path.join(root, e.name)
      if (e.isDirectory()) {
        const inner = findJsonlRecursive(full)
        if (inner) {
          const mt = statSync(inner).mtimeMs
          if (mt > newestMtime) { newestPath = inner; newestMtime = mt }
        }
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        const mt = statSync(full).mtimeMs
        if (mt > newestMtime) { newestPath = full; newestMtime = mt }
      }
    }
    return newestPath
  } catch { return null }
}

function extractOpenclawError(entry: Record<string, unknown>): string | undefined {
  if (entry.type === "error" && typeof entry.message === "string") return entry.message
  const msg = entry.message as Record<string, unknown> | undefined
  if (msg && msg.role === "error") {
    const content = msg.content
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item === "object" && item && typeof (item as Record<string, unknown>).text === "string") {
          return (item as Record<string, unknown>).text as string
        }
      }
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// opencode
// ---------------------------------------------------------------------------

export async function diagnoseOpencode(input: DiagnoseInput): Promise<FailureDiagnosis | null> {
  return withDeadline(async () => {
    const events = parseNDJSON(input.stdout)
    const errors = events.filter((e) => e.type === "error")
    if (errors.length > 0) {
      const last = errors[errors.length - 1]!
      const msg = extractOpencodeErrorMessage(last)
      if (msg) return { summary: `opencode: ${msg}`, source: "opencode:error-event" }
    }
    const tail = pickStderrErrorLine(input.stderr)
    if (tail) return { summary: `opencode: ${tail}`, source: "opencode:stderr" }
    return null
  }, null)
}

function extractOpencodeErrorMessage(event: OpenCodeEvent): string | undefined {
  const part = event.part
  if (!part) return undefined
  const err = (part as Record<string, unknown>).error
  if (typeof err === "string") return err
  if (err && typeof err === "object") {
    const data = (err as Record<string, unknown>).data
    if (typeof data === "string") return data
    const msg = (err as Record<string, unknown>).message
    if (typeof msg === "string") return msg
  }
  const message = (part as Record<string, unknown>).message
  if (typeof message === "string") return message
  return undefined
}

// ---------------------------------------------------------------------------
// jiuwenclaw
// ---------------------------------------------------------------------------

export async function diagnoseJiuwenclaw(input: DiagnoseInput): Promise<FailureDiagnosis | null> {
  return withDeadline(async () => {
    if (input.sessionId) {
      const historyPath = path.join(input.sandboxRoot, "agent", "sessions", input.sessionId, "history.json")
      if (existsSync(historyPath)) {
        try {
          const parsed = JSON.parse(readFileSync(historyPath, "utf-8"))
          const records = Array.isArray(parsed) ? parsed
            : Array.isArray((parsed as Record<string, unknown>)?.events) ? (parsed as Record<string, unknown>).events as unknown[]
            : []
          for (let i = records.length - 1; i >= 0; i--) {
            const rec = records[i] as Record<string, unknown> | undefined
            if (rec && rec.event_type === "chat.error") {
              const content = rec.content
              if (typeof content === "string") {
                return { summary: `jiuwenclaw: ${content}`, source: "jiuwenclaw:history" }
              }
            }
          }
        } catch { /* ignore */ }
      }
    }
    const tail = pickStderrErrorLine(input.stderr)
    if (tail) return { summary: `jiuwenclaw: ${tail}`, source: "jiuwenclaw:stderr" }
    return null
  }, null)
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Pick the first line that looks like an error marker from the tail of stderr. */
function pickStderrErrorLine(stderr: string): string | null {
  if (!stderr) return null
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean)
  const tail = lines.slice(-40)
  const errLine = tail.reverse().find((l) => /\b(error|exception|traceback|fail)/i.test(l))
  if (errLine) return errLine.slice(0, 300)
  return lines[lines.length - 1]?.slice(0, 300) ?? null
}
