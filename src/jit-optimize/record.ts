/**
 * Durable Evidence record — the single on-disk source of truth for one
 * (set, task, run) of a jit-optimize session.
 *
 * Layout per run directory:
 *
 *   <dir>/
 *     evidence.json       — structured sidecar (taskId, taskPrompt, criteria, runMeta)
 *     conversation.jsonl  — one ConversationLogEntry per line; absent when no entries
 *     workdir/<files...>  — workDirSnapshot files verbatim; the dir's presence is the
 *                           signal that a snapshot was captured (an empty workdir/
 *                           still means "we captured, agent produced nothing").
 *
 * The optimizer's `.optimize/` bundle is no longer a separate capture path —
 * it is a projection rendered from records of this shape.
 */

import path from "node:path"
import { mkdir, readdir, rm, stat } from "node:fs/promises"
import {
  EvidenceSidecarSchema,
  ConversationLogEntrySchema,
  type ConversationLogEntry,
  type Evidence,
  type WorkDirSnapshot,
} from "./types.ts"

const EVIDENCE_FILE = "evidence.json"
const CONVERSATION_FILE = "conversation.jsonl"
const WORKDIR_SUBDIR = "workdir"

/** Path of the conversation.jsonl inside a record dir. Exposed so the runner can
 * point its ConversationLog directly at the record's canonical location, avoiding
 * a write-then-copy. */
export function recordConversationPath(dir: string): string {
  return path.join(dir, CONVERSATION_FILE)
}

// ---------------------------------------------------------------------------
// Writer (split into composable parts so production code can stream the
// conversation log to its final location and skip the redundant rewrite)
// ---------------------------------------------------------------------------

/** Write evidence.json + workdir/. Does NOT touch conversation.jsonl. */
export async function writeEvidenceSidecar(dir: string, evidence: Evidence): Promise<void> {
  await mkdir(dir, { recursive: true })

  const sidecar = {
    taskId: evidence.taskId,
    taskPrompt: evidence.taskPrompt,
    criteria: evidence.criteria,
    runMeta: evidence.runMeta,
  }
  await Bun.write(path.join(dir, EVIDENCE_FILE), JSON.stringify(sidecar, null, 2))

  if (evidence.workDirSnapshot) {
    const wdRoot = path.join(dir, WORKDIR_SUBDIR)
    await mkdir(wdRoot, { recursive: true })
    // mkdir once per unique parent so sibling files don't pay repeated
    // recursive-mkdir cost — same approach as serializeContext's render.
    const createdDirs = new Set<string>([wdRoot])
    for (const [relPath, content] of evidence.workDirSnapshot.files) {
      const dest = path.join(wdRoot, relPath)
      const parent = path.dirname(dest)
      if (!createdDirs.has(parent)) {
        await mkdir(parent, { recursive: true })
        createdDirs.add(parent)
      }
      await Bun.write(dest, content)
    }
  }
}

/** Write conversation.jsonl from an in-memory log. */
export async function writeConversationLog(dir: string, entries: ConversationLogEntry[]): Promise<void> {
  if (entries.length === 0) return
  await mkdir(dir, { recursive: true })
  const lines = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
  await Bun.write(path.join(dir, CONVERSATION_FILE), lines)
}

/** Convenience: write all three pieces (sidecar + conv log + workdir). */
export async function writeEvidenceRecord(dir: string, evidence: Evidence): Promise<void> {
  await writeEvidenceSidecar(dir, evidence)
  await writeConversationLog(dir, evidence.conversationLog)
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export async function readEvidenceRecord(dir: string): Promise<Evidence> {
  const sidecarRaw = await Bun.file(path.join(dir, EVIDENCE_FILE)).json()
  const sidecar = EvidenceSidecarSchema.parse(sidecarRaw)

  const conversationLog = await readConversationLog(path.join(dir, CONVERSATION_FILE))
  const workDirSnapshot = await readWorkDirSnapshot(path.join(dir, WORKDIR_SUBDIR))

  const evidence: Evidence = {
    taskId: sidecar.taskId,
    taskPrompt: sidecar.taskPrompt,
    conversationLog,
  }
  if (sidecar.criteria) evidence.criteria = sidecar.criteria
  if (sidecar.runMeta) evidence.runMeta = sidecar.runMeta
  if (workDirSnapshot) evidence.workDirSnapshot = workDirSnapshot
  return evidence
}

async function readConversationLog(filePath: string): Promise<ConversationLogEntry[]> {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return []
  const text = await file.text()
  const out: ConversationLogEntry[] = []
  for (const line of text.split("\n")) {
    if (line.length === 0) continue
    const parsed = ConversationLogEntrySchema.parse(JSON.parse(line))
    out.push(parsed as ConversationLogEntry)
  }
  return out
}

async function readWorkDirSnapshot(workdirRoot: string): Promise<WorkDirSnapshot | undefined> {
  try {
    await stat(workdirRoot)
  } catch {
    return undefined
  }
  const files = new Map<string, string>()
  const entries = await readdir(workdirRoot, { withFileTypes: true, recursive: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const full = path.join(entry.parentPath ?? workdirRoot, entry.name)
    const rel = path.relative(workdirRoot, full)
    files.set(rel, await Bun.file(full).text())
  }
  return { files }
}

// ---------------------------------------------------------------------------
// Round-level helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the directory for a single run record:
 *   {roundEvidenceRoot}/{set}/{safeTaskId}-run{runIdx}
 *
 * `taskId` is slugged to a filesystem-safe name (same rules as the optimizer
 * projection: alphanumerics plus `._-`, collapse runs of `-`, never `.`/`..`,
 * never empty). The slug is idempotent on already-safe ids, so callers that
 * pre-resolve collisions with {@link resolveSafeTaskIds} can pass the resolved
 * id straight through.
 *
 * IMPORTANT: slugging alone is NOT injective — distinct ids like `task:a` and
 * `task a` both collapse to `task-a`. When more than one task id is in play in
 * the same set, the caller MUST first run them through {@link resolveSafeTaskIds}
 * and pass the disambiguated id here. Otherwise two distinct tasks would write
 * to the same record directory and silently clobber each other's
 * evidence.json / conversation.jsonl / workdir.
 */
export function runRecordDir(
  roundEvidenceRoot: string,
  setLabel: string,
  taskId: string,
  runIdx: number,
): string {
  return path.join(roundEvidenceRoot, setLabel, `${safeTaskSlug(taskId)}-run${runIdx}`)
}

/**
 * Map each distinct task id to a collision-free filesystem-safe slug.
 * Two distinct ids whose raw slugs coincide get disambiguated with a numeric
 * suffix (`task-a`, `task-a-2`, ...), so every task lands in its own record
 * directory. Mirrors the optimizer projection's allocateSafeId (workspace.ts).
 *
 * Matching is case-insensitive so case-only differences (`Foo` vs `foo`) don't
 * alias on case-insensitive filesystems (macOS APFS default). The result slugs
 * are themselves filesystem-safe and idempotent under safeTaskSlug, so they can
 * be handed directly to {@link runRecordDir}.
 *
 * Call this ONCE per set, before launching concurrent per-run jobs — the
 * allocation is stateful and must not race.
 */
export function resolveSafeTaskIds(taskIds: Iterable<string>): Map<string, string> {
  const claimed = new Set<string>()
  const resolved = new Map<string, string>()
  for (const taskId of taskIds) {
    if (resolved.has(taskId)) continue
    resolved.set(taskId, allocateSafeId(safeTaskSlug(taskId), claimed))
  }
  return resolved
}

function safeTaskSlug(taskId: string): string {
  const replaced = taskId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-")
  const trimmed = replaced.replace(/^-+|-+$/g, "")
  if (trimmed.length === 0) return "unnamed-task"
  if (/^\.+$/.test(trimmed)) return "unnamed-task"
  return trimmed
}

/**
 * Claim a unique slug, disambiguating with a numeric suffix when the base is
 * already taken. Case-insensitive so `Foo`/`foo` collide on APFS.
 */
function allocateSafeId(base: string, claimed: Set<string>): string {
  if (!claimed.has(base.toLowerCase())) {
    claimed.add(base.toLowerCase())
    return base
  }
  for (let suffix = 2; suffix < Number.MAX_SAFE_INTEGER; suffix++) {
    const candidate = `${base}-${suffix}`
    if (!claimed.has(candidate.toLowerCase())) {
      claimed.add(candidate.toLowerCase())
      return candidate
    }
  }
  // Unreachable — the loop runs until it finds a free slug.
  throw new Error("allocateSafeId: exhausted suffix range")
}

/**
 * Walk a round's evidence root and return every (set, run-dir) pair. The
 * caller decides whether to deserialise (via readEvidenceRecord) or just
 * inspect paths. Returns [] when the root does not exist — old proposals
 * predating the durable record have no such dir, and that is not an error.
 */
export async function listRunDirs(
  roundEvidenceRoot: string,
): Promise<Array<{ setLabel: string; runDir: string }>> {
  try {
    await stat(roundEvidenceRoot)
  } catch {
    return []
  }
  const out: Array<{ setLabel: string; runDir: string }> = []
  for (const setEntry of await readdir(roundEvidenceRoot, { withFileTypes: true })) {
    if (!setEntry.isDirectory()) continue
    const setDir = path.join(roundEvidenceRoot, setEntry.name)
    for (const runEntry of await readdir(setDir, { withFileTypes: true })) {
      if (!runEntry.isDirectory()) continue
      out.push({ setLabel: setEntry.name, runDir: path.join(setDir, runEntry.name) })
    }
  }
  return out
}

/** Delete a round's evidence root. Used by tests; production paths don't currently invoke this. */
export async function removeRoundEvidence(roundEvidenceRoot: string): Promise<void> {
  await rm(roundEvidenceRoot, { recursive: true, force: true })
}
