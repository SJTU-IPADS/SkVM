/**
 * Cross-process file lock with crash-safe cleanup.
 *
 * Design goals:
 *   1. Atomic acquire via O_CREAT|O_EXCL (no races between concurrent acquirers).
 *   2. Crash recovery without waiting the full TTL: each lock file records the
 *      holder's pid + hostname. If the holder is on this host and no longer
 *      running (kill(pid, 0) → ESRCH), the lock is considered free.
 *   3. Graceful Ctrl-C: SIGINT / SIGTERM / SIGHUP / beforeExit release every
 *      lock currently held by this process before the process exits.
 *   4. Cross-host fallback: if the holder is on a different machine (shared
 *      filesystem) we can't probe it, so we fall back to an mtime TTL.
 *
 * Three public call shapes:
 *   - tryAcquireFileLock(file, opts)  → one-shot, returns boolean
 *   - acquireFileLock(file, opts)     → blocks with backoff, throws on timeout
 *   - withFileLock(file, opts, fn)    → acquire, run, release (even on throw)
 *
 * A single module is shared by jit-optimize proposals and the openclaw adapter.
 */

import { openSync, closeSync, writeSync, readFileSync, statSync, utimesSync, unlinkSync, constants } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createLogger } from "./logger.ts"

const log = createLogger("file-lock")

export interface FileLockOptions {
  /**
   * TTL ceiling for abandoned locks: after this age with no heartbeat, any
   * caller may reap the lock file. With `heartbeatMs` set this only ever
   * triggers for dead holders; without it, it also caps legitimate holders.
   * Default: 30 min.
   */
  staleMs?: number
  /** Blocking acquire only: max time to wait for the lock. Default: 0 (try once). */
  timeoutMs?: number
  /** Blocking acquire only: initial poll interval, exponentially doubles up to 500ms. Default: 50ms. */
  initialPollMs?: number
  /**
   * If set, refresh the lock file's mtime on this interval while held so the
   * `staleMs` ceiling can't reap a live, long-running holder. Choose a value
   * well below `staleMs` (a third is a good default) to tolerate missed beats.
   * The heartbeat verifies ownership on each tick — if the file was reaped
   * and reacquired by another process, it stops instead of refreshing their
   * lock. Default: no heartbeat.
   */
  heartbeatMs?: number
  /**
   * Whether the process-wide cleanup handlers (signal / exit / beforeExit)
   * may unlink this lock on their own. Default: true.
   *
   * Set to **false** when the lock protects a resource still in use by a
   * subprocess that can outlive the parent — e.g. a `Bun.spawn`ed agent.
   * On parent termination that doesn't also kill the child (SIGTERM/SIGHUP
   * to the parent's pid, or a fatal error calling `process.exit`), releasing
   * the lock would let a concurrent worker grab the same resource while the
   * orphaned child is still using it. Leaving the lock held means it falls
   * through to the `staleMs` / heartbeat-death ceiling, giving the orphaned
   * child a grace period to finish.
   *
   * Explicit `releaseFileLock` calls are not affected by this flag — the
   * adapter still releases normally when the subprocess completes.
   */
  releaseOnProcessExit?: boolean
}

interface LockPayload {
  pid: number
  host: string
  ts: string
}

const DEFAULT_STALE_MS = 30 * 60 * 1000
const MAX_POLL_MS = 500
const HOST = os.hostname()

interface HeldLock {
  /** The exact JSON payload we wrote to the file — our "ownership token". */
  token: string
  /** Whether process-wide cleanup handlers may unlink this lock. */
  releaseOnProcessExit: boolean
}

/**
 * Locks currently held by this process. Every unlink path (normal release +
 * signal/exit cleanup) re-reads the file and compares bytes before deleting;
 * if the file has been reaped and taken by another process while we were
 * stalled, the bytes won't match and we leave it alone.
 */
const heldLocks = new Map<string, HeldLock>()

/** Heartbeat timers keyed by lock file path. */
const heartbeats = new Map<string, ReturnType<typeof setInterval>>()

/** True once the process-wide signal/exit handlers have been registered. */
let handlersInstalled = false

function unlinkIfStillOurs(file: string, token: string): void {
  let current: string
  try {
    current = readFileSync(file, "utf8")
  } catch {
    return // file already gone
  }
  if (current !== token) {
    // Lock was reaped and reacquired by someone else while we were stalled —
    // do not delete their lock.
    log.warn(`skipping release of ${file}: ownership has moved to another holder`)
    return
  }
  try { unlinkSync(file) } catch { /* raced */ }
}

function stopHeartbeat(file: string): void {
  const timer = heartbeats.get(file)
  if (timer === undefined) return
  clearInterval(timer)
  heartbeats.delete(file)
}

function beatHeartbeat(file: string): void {
  const held = heldLocks.get(file)
  if (held === undefined) {
    stopHeartbeat(file)
    return
  }
  let current: string
  try {
    current = readFileSync(file, "utf8")
  } catch {
    // File disappeared (reaped, deleted, fs unmounted). Stop refreshing;
    // any subsequent operation by the caller will surface the problem.
    log.warn(`heartbeat: ${file} is gone, stopping refresh`)
    stopHeartbeat(file)
    return
  }
  if (current !== held.token) {
    log.warn(`heartbeat: ownership of ${file} moved to another holder, stopping refresh`)
    stopHeartbeat(file)
    return
  }
  try {
    const now = new Date()
    utimesSync(file, now, now)
  } catch {
    stopHeartbeat(file)
  }
}

function startHeartbeat(file: string, intervalMs: number): void {
  const timer = setInterval(() => beatHeartbeat(file), intervalMs)
  // Unref so the heartbeat never keeps the event loop alive by itself.
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref()
  }
  heartbeats.set(file, timer)
}

/**
 * Process-wide cleanup invoked from `exit` / `beforeExit` / signal handlers.
 *
 * Stops heartbeats for ALL held locks (the event loop is about to die, timers
 * won't fire again anyway) and unlinks only those marked `releaseOnProcessExit`.
 * Locks where that flag is false stay on disk and fall through to their
 * `staleMs` ceiling so any subprocess they protect still has a grace period.
 */
function releaseAllHeld(): void {
  for (const timer of heartbeats.values()) clearInterval(timer)
  heartbeats.clear()
  for (const [file, held] of heldLocks) {
    if (!held.releaseOnProcessExit) continue
    unlinkIfStillOurs(file, held.token)
    heldLocks.delete(file)
  }
}

function installHandlers(): void {
  if (handlersInstalled) return
  handlersInstalled = true

  // Normal exit paths: `exit` fires synchronously whenever the event loop
  // drains or process.exit() is called from anywhere.
  process.on("exit", releaseAllHeld)
  process.on("beforeExit", releaseAllHeld)

  // Signals: node suppresses the default signal action whenever any listener
  // is registered, so we must exit ourselves — but only if we are the sole
  // handler. If other code (e.g. bench/orchestrator.ts) also handles SIGINT,
  // it will call process.exit() itself and our `exit` listener will run then.
  const signalHandler = (sig: NodeJS.Signals, code: number) => () => {
    releaseAllHeld()
    if (process.listenerCount(sig) <= 1) {
      process.exit(code)
    }
  }
  process.on("SIGINT", signalHandler("SIGINT", 130))
  process.on("SIGTERM", signalHandler("SIGTERM", 143))
  process.on("SIGHUP", signalHandler("SIGHUP", 129))
}

function readLockPayload(file: string): LockPayload | null {
  try {
    const raw = readFileSync(file, "utf8")
    const parsed = JSON.parse(raw) as Partial<LockPayload>
    if (typeof parsed.pid === "number" && typeof parsed.host === "string" && typeof parsed.ts === "string") {
      return parsed as LockPayload
    }
  } catch { /* missing, truncated, or not JSON */ }
  return null
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // EPERM: process exists but we lack permission to signal — treat as alive.
    return code === "EPERM"
  }
}

/**
 * If the lock file exists but its holder is definitely gone, remove it.
 * Returns true if the caller should retry acquisition immediately.
 *
 * Two layered checks, in order:
 *   1. Fast path: if the holder is on this host, `kill(pid, 0)` tells us
 *      within a syscall whether the process is still alive. Dead → reap.
 *   2. Safety floor (always applied, even when the pid "looks alive"):
 *      if the lock file is older than `staleMs`, reap anyway. This catches
 *      PID reuse after a crash — an unrelated process may now own the same
 *      PID, and without the floor the lock would be held forever.
 */
function reapStaleLock(file: string, staleMs: number): boolean {
  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    return false // no lock file at all
  }

  const payload = readLockPayload(file)

  if (payload && payload.host === HOST && !isPidAlive(payload.pid)) {
    log.warn(`reaping stale lock ${file} (local pid ${payload.pid} is gone)`)
    try { unlinkSync(file) } catch { /* raced with another reaper */ }
    return true
  }

  // Same-host live pid, unknown host, unreadable payload, or legacy format:
  // all fall through to the mtime TTL as a safety ceiling.
  if (Date.now() - mtimeMs > staleMs) {
    log.warn(`reaping stale lock ${file} (age ${Math.round((Date.now() - mtimeMs) / 1000)}s > ${staleMs / 1000}s)`)
    try { unlinkSync(file) } catch { /* raced */ }
    return true
  }
  return false
}

/**
 * Atomically create the lock file and write the holder payload.
 *
 * Returns the ownership token (exact bytes written to the file) on success,
 * or `null` if another process already holds the lock (EEXIST). All other
 * I/O errors — permission denied, out of space, read-only filesystem,
 * ENOENT on the parent directory — are rethrown so callers can surface the
 * real cause instead of treating them as contention.
 */
function atomicCreate(file: string): string | null {
  let fd: number
  try {
    fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null
    throw err
  }
  const payload: LockPayload = { pid: process.pid, host: HOST, ts: new Date().toISOString() }
  const token = JSON.stringify(payload)
  try {
    writeSync(fd, token)
  } catch (err) {
    // We created the file but couldn't write the payload (e.g. ENOSPC).
    // Unlink so the next acquirer doesn't see an empty lock file it would
    // have to TTL-wait on, then surface the real error.
    try { closeSync(fd) } catch { /* ignore */ }
    try { unlinkSync(file) } catch { /* ignore */ }
    throw err
  }
  closeSync(fd)
  return token
}

/**
 * Try to acquire the lock once. Returns true on success.
 *
 * Also reaps an abandoned lock file on the spot (dead pid, or older than
 * staleMs if we can't probe the holder) and retries a single time.
 */
export function tryAcquireFileLock(file: string, opts: FileLockOptions = {}): boolean {
  installHandlers()
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS
  const releaseOnProcessExit = opts.releaseOnProcessExit ?? true

  let token = atomicCreate(file)
  if (token === null && reapStaleLock(file, staleMs)) {
    token = atomicCreate(file)
  }
  if (token === null) return false
  heldLocks.set(file, { token, releaseOnProcessExit })
  if (opts.heartbeatMs && opts.heartbeatMs > 0) {
    startHeartbeat(file, opts.heartbeatMs)
  }
  return true
}

/**
 * Wait for the lock, polling with exponential backoff until timeoutMs elapses.
 * Throws if the deadline passes before acquisition.
 */
export async function acquireFileLock(file: string, opts: FileLockOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 0
  const start = Date.now()
  let poll = opts.initialPollMs ?? 50

  while (true) {
    if (tryAcquireFileLock(file, opts)) return
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`Timed out waiting for file lock ${file} after ${timeoutMs}ms`)
    }
    await Bun.sleep(poll)
    poll = Math.min(poll * 2, MAX_POLL_MS)
  }
}

/**
 * Release the lock. Idempotent. Only unlinks if the file on disk still
 * contains the exact bytes we wrote at acquire time — guards against a race
 * where the lock was reaped and reacquired by another process while we were
 * stalled past `staleMs`.
 */
export function releaseFileLock(file: string): void {
  const held = heldLocks.get(file)
  if (held === undefined) return
  stopHeartbeat(file)
  heldLocks.delete(file)
  unlinkIfStillOurs(file, held.token)
}

/**
 * Acquire (blocking), run fn, release — even if fn throws or the process is
 * interrupted. For a one-shot try, pass timeoutMs: 0 and handle the thrown
 * timeout yourself, or call tryAcquireFileLock directly.
 */
export async function withFileLock<T>(
  file: string,
  opts: FileLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(path.dirname(file), { recursive: true })
  await acquireFileLock(file, opts)
  try {
    return await fn()
  } finally {
    releaseFileLock(file)
  }
}

/** Test-only: current set of lock paths held by this process. */
export function __heldLocksForTest(): ReadonlySet<string> {
  return new Set(heldLocks.keys())
}

/**
 * Test-only: simulate the process-wide cleanup handler (as if an `exit` event
 * or SIGINT had fired). Allows unit tests to verify the `releaseOnProcessExit`
 * opt-out without actually terminating the test runner.
 */
export function __simulateProcessExitForTest(): void {
  releaseAllHeld()
}
