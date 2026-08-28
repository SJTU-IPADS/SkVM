/**
 * Run-session routes — the JSON API behind the runs page. Read-only views
 * over the same on-disk state `skvm logs` prints: the sessions index plus
 * each session's logDir files.
 *
 * Routes:
 *   GET /api/sessions?type=&limit=      → entries newest-first, with liveness applied
 *   GET /api/session/files?id=          → recursive logDir listing
 *   GET /api/session/tail?id=&file=     → SSE tail of one logDir file
 */

import path from "node:path"
import { stat } from "node:fs/promises"
import { readSessions, effectiveStatus, resolveLogDir, type SessionEntry } from "../../core/run-session.ts"
import { json, bad, type RouteTable } from "../http.ts"

/** First SSE payload sends at most this much history so huge logs don't flood the stream. */
const TAIL_INIT_BYTES = 64 * 1024
const TAIL_POLL_MS = 500
/** Listing cap — a logDir with more files than this is truncated (the payload says so). */
const MAX_FILES = 500

async function findSession(id: string): Promise<SessionEntry | undefined> {
  return (await readSessions()).find((e) => e.id === id)
}

/**
 * Resolve a client-supplied relative path against a session's logDir,
 * rejecting anything that escapes it.
 */
function resolveWithin(logDir: string, rel: string): string | null {
  const abs = path.resolve(logDir, rel)
  return abs === logDir || abs.startsWith(logDir + path.sep) ? abs : null
}

async function handleGetSessions(_req: Request, url: URL): Promise<Response> {
  const type = url.searchParams.get("type") ?? undefined
  const limitParam = url.searchParams.get("limit")
  let limit: number | undefined
  if (limitParam !== null) {
    limit = parseInt(limitParam, 10)
    if (Number.isNaN(limit) || limit < 1) return bad(400, "limit must be a positive integer")
  }
  const entries = await readSessions({ type, limit })
  return json({
    sessions: entries.map((e) => ({ ...e, effectiveStatus: effectiveStatus(e) })),
  })
}

async function handleGetSessionFiles(_req: Request, url: URL): Promise<Response> {
  const id = url.searchParams.get("id")
  if (!id) return bad(400, "missing id")
  const entry = await findSession(id)
  if (!entry) return bad(404, "unknown session id")
  const logDir = resolveLogDir(entry)

  const files: Array<{ path: string; size: number; mtimeMs: number }> = []
  let truncated = false
  const glob = new Bun.Glob("**/*")
  try {
    for await (const rel of glob.scan({ cwd: logDir, onlyFiles: true, dot: false })) {
      if (files.length >= MAX_FILES) {
        truncated = true
        break
      }
      try {
        const s = await stat(path.join(logDir, rel))
        files.push({ path: rel, size: s.size, mtimeMs: s.mtimeMs })
      } catch {
        // deleted between scan and stat — skip
      }
    }
  } catch {
    // logDir missing entirely (session never wrote logs) — empty listing
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return json({ id, logDir: entry.logDir, files, truncated })
}

/**
 * SSE tail: poll the file's size and stream appended bytes as they land.
 * A shrinking size (truncate/rotate) resets to the start. The interval is
 * cleared when the client disconnects (stream cancel).
 */
function sseTail(filePath: string): Response {
  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setInterval> | null = null
  let offset = 0
  let closed = false
  let inFlight = false

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          closed = true
        }
      }
      const poll = async () => {
        if (inFlight || closed) return
        inFlight = true
        try {
          const f = Bun.file(filePath)
          if (await f.exists()) {
            const size = f.size
            if (size < offset) offset = 0
            if (size > offset) {
              const text = await f.slice(offset, size).text()
              offset = size
              send("chunk", { text })
            }
          }
        } catch {
          // transient read error — retry next tick
        } finally {
          inFlight = false
        }
      }
      const f = Bun.file(filePath)
      if (await f.exists()) offset = Math.max(0, f.size - TAIL_INIT_BYTES)
      await poll()
      send("ready", { offset })
      timer = setInterval(poll, TAIL_POLL_MS)
    },
    cancel() {
      closed = true
      if (timer) clearInterval(timer)
    },
  })

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  })
}

async function handleGetSessionTail(_req: Request, url: URL): Promise<Response> {
  const id = url.searchParams.get("id")
  const rel = url.searchParams.get("file")
  if (!id) return bad(400, "missing id")
  if (!rel) return bad(400, "missing file")
  const entry = await findSession(id)
  if (!entry) return bad(404, "unknown session id")
  const logDir = resolveLogDir(entry)
  const abs = resolveWithin(logDir, rel)
  if (!abs) return bad(400, "file outside session log dir")
  return sseTail(abs)
}

export const sessionRoutes: RouteTable = {
  "GET /api/sessions": handleGetSessions,
  "GET /api/session/files": handleGetSessionFiles,
  "GET /api/session/tail": handleGetSessionTail,
}
