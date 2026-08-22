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
      escalateTimer = setTimeout(() => {
        // Reap the child's own children first: once the child dies they
        // reparent to init and `pkill -P` can no longer find them.
        Bun.spawn(["pkill", "-KILL", "-P", String(proc.pid)], {
          stdout: "ignore",
          stderr: "ignore",
        })
        try { proc.kill("SIGKILL") } catch { /* already gone */ }
      }, killGraceMs)
    }, opts.timeoutMs)
  }

  const exited = proc.exited.then((code) => {
    if (killTimer) clearTimeout(killTimer)
    if (escalateTimer) clearTimeout(escalateTimer)
    return code
  })

  const drainGraceMs = opts?.drainGraceMs ?? DRAIN_GRACE_MS
  const [exitCode, stdout, stderr] = await Promise.all([
    exited,
    drainBounded(proc.stdout, exited, drainGraceMs),
    drainBounded(proc.stderr, exited, drainGraceMs),
  ])
  return { exitCode, stdout, stderr, durationMs: Date.now() - start, timedOut }
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
): Promise<string> {
  const reader = stream.getReader()
  const deadline = exited
    .then(() => new Promise<void>((resolve) => setTimeout(resolve, graceMs)))
    .then(() => DRAIN_DEADLINE)
  const decoder = new TextDecoder()
  let text = ""
  while (true) {
    const next = await Promise.race([reader.read(), deadline])
    if (typeof next === "symbol" || next.done) break
    text += decoder.decode(next.value, { stream: true })
  }
  reader.cancel().catch(() => {})
  return text + decoder.decode()
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
