/**
 * Single subprocess runner shared by the CLI-wrapping adapters and the
 * headless-agent drivers. Spawns with kill-on-timeout and drains
 * stdout/stderr in parallel with waiting for exit — draining concurrently
 * avoids pipe deadlock when the child's output exceeds the OS pipe buffer
 * (~64 KB on macOS) while the parent blocks on `proc.exited`.
 */

import { existsSync } from "node:fs"

export interface SubprocessResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
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
}

/**
 * On Windows under Git Bash / MSYS, `which <name>` returns MSYS drive paths
 * (`/d/...`) that `Bun.spawn` cannot resolve (it expects `D:\\...` or `D:/...`).
 * Adapter `tierGlobal` resolvers feed that path straight back as `cmd[0]`,
 * producing `ENOENT uv_spawn`. Convert MSYS drive paths to Windows paths and,
 * if the bare path doesn't exist, try `.exe` (e.g. `pi` → `pi.exe`, the
 * bun-compiled binary in `node_modules/.bin`). No-op on non-win32 and for bare
 * command names (`bash`, `docker`, ...) that Bun resolves via PATH.
 */
function resolveCmd0ForSpawn(cmd0: string): string {
  if (process.platform !== "win32") return cmd0
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(cmd0)
  if (!m) return cmd0
  const win = `${m[1]!.toUpperCase()}:/${m[2]}`
  if (existsSync(win)) return win
  if (existsSync(win + ".exe")) return win + ".exe"
  return win
}

/**
 * Forcibly kill a process AND its descendants. Adapter wrappers (pi.exe,
 * opencode) spawn grandchildren that survive a plain `proc.kill()` (SIGTERM
 * to the wrapper only) and keep the stdout pipe open, so `proc.exited` never
 * resolves and timeouts never fire. On Windows `taskkill /T /F <pid>` takes
 * down the whole tree; elsewhere we try SIGKILL on the process group.
 * Synchronous + best-effort: by the time a timeout fires we want the process
 * gone, not a graceful shutdown that might itself hang.
 */
function killProcessTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      // /T = tree, /F = force. Shell not needed; Bun.spawn resolves taskkill
      // via PATH. Ignore exit code — the process may already be exiting.
      Bun.spawn(["taskkill", "/T", "/F", "/PID", String(pid)], {
        stdout: "ignore", stderr: "ignore",
      })
    } else {
      process.kill(-pid, "SIGKILL")
    }
  } catch {
    // Best-effort. If the group kill fails (e.g. not a group leader), fall
    // back to a direct SIGKILL on the pid itself.
    try { process.kill(pid, "SIGKILL") } catch { /* already gone */ }
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
  const spawnCmd = cmd.length > 0
    ? [resolveCmd0ForSpawn(cmd[0]!), ...cmd.slice(1)]
    : cmd
  const proc = Bun.spawn(spawnCmd, {
    cwd: opts?.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
  })

  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  // Readers are kept so a timeout can cancel them. Without cancellation,
  // `Response(stream).text()` blocks until EOF — and on Windows/MSYS a
  // killed wrapper's grandchild (e.g. `sleep` spawned by bash) can keep the
  // stdout pipe open, so the timeout fires the kill but runSubprocess never
  // returns. Cancelling the reader lets us return promptly after the kill.
  const stdoutReader = proc.stdout.getReader()
  const stderrReader = proc.stderr.getReader()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readAll = async (reader: any): Promise<string> => {
    const chunks: Uint8Array[] = []
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) chunks.push(value)
      }
    } catch {
      // reader cancelled (timeout) — return what we have so far
    }
    return chunks.map((c) => new TextDecoder().decode(c)).join("")
  }
  if (opts?.timeoutMs) {
    timer = setTimeout(() => {
      timedOut = true
      // Kill the whole process tree, not just the direct child. Adapter
      // targets (pi.exe, opencode) are wrappers that spawn grandchildren
      // (node, bash, the LLM agent loop); proc.kill() only signals the
      // wrapper, which (a) may ignore SIGTERM and (b) leaves grandchildren
      // holding the stdout pipe — so proc.exited never resolves and the
      // timeout never actually fires. On Windows use taskkill /T /F to
      // forcibly take down the tree; elsewhere SIGKILL the group. Then cancel
      // the pipe readers so this function returns promptly with partial output.
      killProcessTree(proc.pid)
      stdoutReader.cancel().catch(() => {})
      stderrReader.cancel().catch(() => {})
    }, opts.timeoutMs)
  }

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited.then((code) => { if (timer) clearTimeout(timer); return code }),
    readAll(stdoutReader),
    readAll(stderrReader),
  ])
  return { exitCode, stdout, stderr, durationMs: Date.now() - start, timedOut }
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
