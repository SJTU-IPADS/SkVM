/**
 * Single subprocess runner shared by the CLI-wrapping adapters and the
 * headless-agent drivers. Spawns with kill-on-timeout and drains
 * stdout/stderr in parallel with waiting for exit — draining concurrently
 * avoids pipe deadlock when the child's output exceeds the OS pipe buffer
 * (~64 KB on macOS) while the parent blocks on `proc.exited`.
 *
 * Two invariants, learned from a wedged CLI-adapter probe:
 * - Timeout kills escalate SIGTERM → SIGKILL. openclaw sits on SIGTERM while
 *   waiting for its agent child, so a single `proc.kill()` left the whole
 *   tree alive indefinitely.
 * - Drains are bounded by child-exit + a grace window. A grandchild that
 *   survives the kill inherits the pipe's write end, so waiting for stream
 *   EOF can block forever even after the direct child is dead.
 */

export interface SubprocessResult {
  /**
   * True when the drain deadline cut output short — a surviving grandchild was
   * still writing. Without it, a caller parsing stdout cannot tell "no more
   * output" from "we stopped listening".
   */
  drainTruncated?: boolean
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

/** SIGTERM → SIGKILL escalation delay after a timeout kill. */
const KILL_GRACE_MS = 5_000
/** How long to keep draining output after the direct child has exited. */
const DRAIN_GRACE_MS = 1_500
/** Cap on waiting for `pkill` itself, so a hung reaper cannot delay the SIGKILL. */
const PKILL_TIMEOUT_MS = 2_000

export interface SubprocessOptions {
  /** Working directory for the child process. */
  cwd?: string
  /** Kill the child after this many milliseconds; `result.timedOut` is set. */
  timeoutMs?: number
  /**
   * Environment overlay merged over `process.env`. A value of `undefined`
   * removes that variable from the child's environment.
   */
  env?: Record<string, string | undefined>
  /** Override the SIGTERM → SIGKILL escalation delay (tests). */
  killGraceMs?: number
  /** Override the post-exit drain grace window (tests). */
  drainGraceMs?: number
}

export async function runSubprocess(
  cmd: string[],
  opts?: SubprocessOptions,
): Promise<SubprocessResult> {
  const env = opts?.env && Object.keys(opts.env).length > 0
    ? mergeEnv(process.env, opts.env)
    : process.env
  const start = Date.now()
  const proc = Bun.spawn(cmd, {
    cwd: opts?.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
  })

  let timedOut = false
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let escalateTimer: ReturnType<typeof setTimeout> | undefined
  if (opts?.timeoutMs) {
    const killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS
    killTimer = setTimeout(() => {
      timedOut = true
      proc.kill()
      escalateTimer = setTimeout(() => { void escalateKill(proc) }, killGraceMs)
    }, opts.timeoutMs)
  }

  const clearTimers = () => {
    if (killTimer) clearTimeout(killTimer)
    if (escalateTimer) clearTimeout(escalateTimer)
  }
  const exited = proc.exited.then((code) => {
    clearTimers()
    return code
  })

  const drainGraceMs = opts?.drainGraceMs ?? DRAIN_GRACE_MS
  try {
    const [exitCode, out, err] = await Promise.all([
      exited,
      drainBounded(proc.stdout, exited, drainGraceMs),
      drainBounded(proc.stderr, exited, drainGraceMs),
    ])
    return {
      exitCode,
      stdout: out.text,
      stderr: err.text,
      durationMs: Date.now() - start,
      timedOut,
      drainTruncated: out.truncated || err.truncated,
    }
  } finally {
    // A rejected drain (stream error, reader failure) would otherwise leave the
    // kill timers armed, keeping the event loop alive and eventually signalling
    // a pid that may have been recycled.
    clearTimers()
  }
}

/**
 * SIGTERM has already been sent and ignored. Reap the child's own children
 * FIRST — once the parent dies they reparent to init and `pkill -P` can no
 * longer find them — then SIGKILL the parent.
 *
 * Both halves are guarded: `Bun.spawn` throws *synchronously* when the binary
 * is missing, and this runs from a timer callback, so an unguarded throw here
 * takes down the whole process on any host without `pkill` (Windows, distroless
 * containers). Losing the escalation is a wedged lane; throwing is a dead run.
 */
export async function escalateKill(proc: Bun.Subprocess, reaperBin = "pkill"): Promise<void> {
  try {
    // Awaited: without this the SIGKILL below lands first, the tree reparents,
    // and pkill scans for a parent that no longer has children — which is to
    // say it reaps nothing at all.
    const reaper = Bun.spawn([reaperBin, "-KILL", "-P", String(proc.pid)], {
      stdout: "ignore",
      stderr: "ignore",
    })
    let reaperTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        reaper.exited,
        new Promise((resolve) => {
          reaperTimer = setTimeout(resolve, PKILL_TIMEOUT_MS)
          reaperTimer.unref?.()
        }),
      ])
    } finally {
      if (reaperTimer) clearTimeout(reaperTimer)
    }
  } catch {
    /* no pkill on this host — fall through to SIGKILL */
  }
  try { proc.kill("SIGKILL") } catch { /* already gone */ }
}

const DRAIN_DEADLINE = Symbol("drain-deadline")

/**
 * Read a stream to completion, but give up `graceMs` after the direct child
 * has exited: surviving grandchildren can hold the pipe's write end open
 * indefinitely, so EOF is not guaranteed. Output already read is kept.
 */
async function drainBounded(
  stream: ReadableStream<Uint8Array>,
  exited: Promise<unknown>,
  graceMs: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader()
  // The timer is created only once the child has exited, and cleared as soon as
  // the drain ends — an uncleared 1.5s timer per call kept the event loop alive
  // and delayed process exit for every command skvm ran.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let finished = false
  const deadline = exited
    .then(() => new Promise<void>((resolve) => {
      // The stream can finish before the child's exit resolves this chain, in
      // which case the timer must never be created at all — it would be armed
      // after the drain's cleanup already ran, and keep the event loop alive.
      if (finished) { resolve(); return }
      deadlineTimer = setTimeout(resolve, graceMs)
      deadlineTimer.unref?.()
    }))
    .then(() => DRAIN_DEADLINE)
  const decoder = new TextDecoder()
  let text = ""
  let truncated = false
  try {
    while (true) {
      const next = await Promise.race([reader.read(), deadline])
      if (typeof next === "symbol") { truncated = true; break }
      if (next.done) break
      text += decoder.decode(next.value, { stream: true })
    }
  } finally {
    finished = true
    if (deadlineTimer) clearTimeout(deadlineTimer)
    reader.cancel().catch(() => {})
  }
  return { text: text + decoder.decode(), truncated }
}

function mergeEnv(
  base: NodeJS.ProcessEnv,
  overlay: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (typeof v === "string") out[k] = v
  for (const [k, v] of Object.entries(overlay)) {
    if (v === undefined) delete out[k]
    else out[k] = v
  }
  return out
}
