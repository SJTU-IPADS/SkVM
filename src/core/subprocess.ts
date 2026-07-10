/**
 * Single subprocess runner shared by the CLI-wrapping adapters and the
 * headless-agent drivers. Spawns with kill-on-timeout and drains
 * stdout/stderr in parallel with waiting for exit — draining concurrently
 * avoids pipe deadlock when the child's output exceeds the OS pipe buffer
 * (~64 KB on macOS) while the parent blocks on `proc.exited`.
 */

import { mkdir } from "node:fs/promises"
import path from "node:path"

export interface SubprocessResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  /** Present (== opts.stdoutSink) when stdout was streamed to disk instead of
   * buffered into `stdout`. When set, `stdout` is the empty string. */
  stdoutFile?: string
}

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
  /**
   * When set, stream raw stdout bytes verbatim to this file path instead of
   * buffering them into `result.stdout`. `result.stdout` becomes "" and
   * `result.stdoutFile` is set to the path. The file is created lazily on
   * the first non-empty chunk — a child that produces no stdout leaves no
   * file behind (preserves the old `stdout.trim()` guard in adapters).
   *
   * WHY: agentic LLM transcripts (pi/opencode/claude-code) reach 0.3–1.7 GB;
   * buffering that into a single string drives peak heap to 10–32 GB and
   * throws `RangeError: Out of memory`. Streaming to the convLog file
   * collapses the dual-use "write to convLog + parse" into one disk write.
   */
  stdoutSink?: string
}

/**
 * Stream raw stdout bytes verbatim to a file. Lazy-open on the first
 * non-empty chunk so a child with no stdout leaves no empty file behind.
 * `finally { writer.end() }` flushes whatever was captured even if the
 * stream ends early (e.g. the child is killed on timeout).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readStreamToSink(stream: any, sinkPath: string): Promise<void> {
  const reader = stream.getReader()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let writer: any
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      if (!writer) {
        await mkdir(path.dirname(sinkPath), { recursive: true })
        writer = Bun.file(sinkPath).writer()
      }
      writer.write(value)
    }
  } finally {
    await writer?.end()
  }
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
  let timer: ReturnType<typeof setTimeout> | undefined
  if (opts?.timeoutMs) {
    timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, opts.timeoutMs)
  }

  // When a sink is requested, stream stdout to disk (bounds heap for giant
  // transcripts); otherwise buffer it into the result string as before.
  const sinkPath = opts?.stdoutSink
  const stdoutPromise = sinkPath
    ? readStreamToSink(proc.stdout, sinkPath).then(() => "")
    : new Response(proc.stdout).text()
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited.then((code) => { if (timer) clearTimeout(timer); return code }),
    stdoutPromise,
    new Response(proc.stderr).text(),
  ])
  return {
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - start,
    timedOut,
    ...(sinkPath ? { stdoutFile: sinkPath } : {}),
  }
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
