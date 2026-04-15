import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { SKVM_CACHE, SESSIONS_INDEX_PATH } from "./config.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("run-session")

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const SessionTypeSchema = z.enum([
  "profile",
  "aot-compile",
  "bench",
  "run",
  "pipeline",
])
export type SessionType = z.infer<typeof SessionTypeSchema>

export const SessionStatusSchema = z.enum(["running", "completed", "failed"])
export type SessionStatus = z.infer<typeof SessionStatusSchema>

export const SessionEntrySchema = z.object({
  id: z.string(),
  type: SessionTypeSchema,
  status: SessionStatusSchema,
  startedAt: z.string(),
  completedAt: z.string().optional(),
  logDir: z.string(),
  models: z.array(z.string()).optional(),
  harness: z.string().optional(),
  skill: z.string().optional(),
  conditions: z.array(z.string()).optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
})
export type SessionEntry = z.infer<typeof SessionEntrySchema>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(): string {
  const now = new Date()
  return [
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("")
}

function sanitizeTag(s: string): string {
  const cleaned = s
    .replace(/[^a-zA-Z0-9.+-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
  // Reject pure-dot tags (`.`, `..`, `...`). These would escape the log
  // directory when interpolated into path.join via run-session ids.
  if (cleaned.length === 0 || /^\.+$/.test(cleaned)) return "untagged"
  return cleaned
}

/**
 * Abbreviate a model ID for use in session ID tags.
 * "anthropic/claude-sonnet-4.6" → "claude-sonnet-4.6"
 * "qwen/qwen3-30b-a3b-instruct-2507" → "qwen3-30b"
 */
export function shortModel(model: string): string {
  const name = model.split("/").pop() ?? model
  return name
    .replace(/-instruct.*$/, "")
    .replace(/-a\d+b.*$/, "")
    .replace(/:.*$/, "")
    .slice(0, 30)
}

function toRelativePath(absPath: string): string {
  if (absPath.startsWith(SKVM_CACHE)) {
    return path.relative(SKVM_CACHE, absPath)
  }
  return absPath
}

async function appendEntry(entry: SessionEntry): Promise<void> {
  await mkdir(path.dirname(SESSIONS_INDEX_PATH), { recursive: true })
  await appendFile(SESSIONS_INDEX_PATH, JSON.stringify(entry) + "\n")
}

// ---------------------------------------------------------------------------
// RunSession
// ---------------------------------------------------------------------------

export interface RunSessionOptions {
  type: SessionType
  tag: string
  logDir: string
  models?: string[]
  harness?: string
  skill?: string
  conditions?: string[]
}

export class RunSession {
  readonly id: string
  readonly type: SessionType
  readonly startedAt: string
  readonly logDir: string

  private constructor(
    id: string,
    type: SessionType,
    startedAt: string,
    logDir: string,
  ) {
    this.id = id
    this.type = type
    this.startedAt = startedAt
    this.logDir = logDir
  }

  /** Generate a consistent, human-readable session ID. */
  static generateId(type: string, tag: string): string {
    const ts = formatTimestamp()
    const safe = sanitizeTag(tag)
    return safe ? `${ts}-${type}-${safe}` : `${ts}-${type}`
  }

  /** Create a new session and register it in sessions.jsonl with status=running. */
  static async start(opts: RunSessionOptions): Promise<RunSession> {
    const id = RunSession.generateId(opts.type, opts.tag)
    const startedAt = new Date().toISOString()
    const session = new RunSession(id, opts.type, startedAt, opts.logDir)

    const entry: SessionEntry = {
      id,
      type: opts.type,
      status: "running",
      startedAt,
      logDir: toRelativePath(opts.logDir),
      ...(opts.models && { models: opts.models }),
      ...(opts.harness && { harness: opts.harness }),
      ...(opts.skill && { skill: opts.skill }),
      ...(opts.conditions && { conditions: opts.conditions }),
    }

    await appendEntry(entry)
    log.debug(`Session started: ${id}`)
    return session
  }

  /** Mark session as completed. */
  async complete(summary?: string): Promise<void> {
    const entry: SessionEntry = {
      id: this.id,
      type: this.type,
      status: "completed",
      startedAt: this.startedAt,
      completedAt: new Date().toISOString(),
      logDir: toRelativePath(this.logDir),
      ...(summary && { summary }),
    }
    await appendEntry(entry)
    log.debug(`Session completed: ${this.id}`)
  }

  /** Mark session as failed. */
  async fail(error: string): Promise<void> {
    const entry: SessionEntry = {
      id: this.id,
      type: this.type,
      status: "failed",
      startedAt: this.startedAt,
      completedAt: new Date().toISOString(),
      logDir: toRelativePath(this.logDir),
      error,
    }
    await appendEntry(entry)
    log.debug(`Session failed: ${this.id}`)
  }
}

// ---------------------------------------------------------------------------
// Read sessions index
// ---------------------------------------------------------------------------

export interface ReadSessionsOptions {
  type?: string
  limit?: number
}

/**
 * Read sessions.jsonl, deduplicate by id (last entry wins for status updates),
 * optionally filter by type, and return in reverse-chronological order.
 */
export async function readSessions(opts?: ReadSessionsOptions): Promise<SessionEntry[]> {
  let raw: string
  try {
    raw = await Bun.file(SESSIONS_INDEX_PATH).text()
  } catch {
    return []
  }

  const lines = raw.trim().split("\n").filter(Boolean)

  // Deduplicate: last entry per id wins (complete/fail overwrites running)
  const byId = new Map<string, SessionEntry>()
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line)
      const entry = SessionEntrySchema.parse(parsed)
      byId.set(entry.id, entry)
    } catch {
      // Skip malformed lines
    }
  }

  let entries = [...byId.values()]

  // Filter by type
  if (opts?.type) {
    entries = entries.filter((e) => e.type === opts.type)
  }

  // Reverse chronological (IDs are timestamp-prefixed, so lexicographic sort works)
  entries.sort((a, b) => b.id.localeCompare(a.id))

  // Apply limit
  if (opts?.limit && opts.limit > 0) {
    entries = entries.slice(0, opts.limit)
  }

  return entries
}
