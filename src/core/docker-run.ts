/**
 * Container lifecycle primitive for adapters that need to run the agent inside
 * a Docker container instead of on the host. Symmetric to runSubprocess but
 * three-phase: startContainer() → execInContainer() (potentially many times)
 * → container.cleanup(). One container per task-run; cleanup MUST live in a
 * finally block.
 *
 * Motivation: pi's bash tool executes model-generated shell commands with
 * cwd=workDir. On Windows Git-Bash the "root" is the host filesystem, so a
 * model-issued `find /` traverses C:\Users\...\AppData\Local\Temp — the
 * observed timeout of tb-db-wal-recovery under LongCat-2.0. Running the agent
 * inside a clean Ubuntu container gives `find /` bounded, relevant output.
 *
 * Design notes:
 *   • The container runs `sleep <lifetimeSec>` as PID 1 to stay alive across
 *     multiple exec calls. Lifetime is a safety net so a leaked container
 *     self-terminates.
 *   • execInContainer runs `docker exec` and inherits runSubprocess's timeout
 *     semantics. If an exec times out, we kill the whole container — simpler
 *     than doing `docker top` + `docker exec kill` gymnastics, and adapters
 *     don't need mid-run exec re-use.
 *   • MSYS_NO_PATHCONV=1 is REQUIRED on Windows Git-Bash — otherwise MSYS
 *     rewrites `C:\...` paths bound to `-v` into POSIX form, and Docker CLI
 *     translates `/app` back into `C:\Program Files\Git\app`. Every docker
 *     call in this file goes through dockerCli() so no callsite forgets.
 */

import { runSubprocess } from "./subprocess.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("docker-run")

export interface DockerContainer {
  readonly name: string
  /** Kill and remove the container. Idempotent — safe to call from finally. */
  cleanup(): Promise<void>
}

export interface StartContainerOpts {
  /** Docker image reference, e.g. "skvm-pi-runtime:latest". */
  image: string
  /** Volume mounts: hostPath → containerPath, mode ('rw' | 'ro'). */
  mounts: Array<{ host: string; container: string; mode?: "rw" | "ro" }>
  /** Env vars set inside the container (API keys, PI_CODING_AGENT_DIR, …). */
  env?: Record<string, string>
  /** Working directory for exec commands (defaults to image WORKDIR). */
  workDir?: string
  /**
   * Total container lifetime in ms. After this the sleep exits and the
   * container terminates. Choose > task timeout + cleanup slack.
   */
  lifetimeMs: number
}

export interface ExecInContainerOpts {
  /** argv passed to `docker exec`. First element is the binary name in $PATH. */
  cmd: string[]
  /** Container obtained from startContainer(). */
  container: DockerContainer
  /** Override the container's default workDir for this exec only. */
  cwd?: string
  /** Kill this exec (and the container) after this many ms. */
  timeoutMs: number
  /** Optional file to stream stdout into (matches runSubprocess.stdoutSink). */
  stdoutSink?: string
}

export interface ExecInContainerResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  /** Present when stdoutSink was set; stdout is "" in that case. */
  stdoutFile?: string
}

let containerSeq = 0

function uniqueName(prefix: string): string {
  containerSeq += 1
  return `${prefix}-${process.pid}-${containerSeq}`
}

/**
 * All docker CLI calls funnel through here so MSYS_NO_PATHCONV=1 is always set
 * on Windows Git-Bash, and callers get a uniform result shape.
 */
async function dockerCli(
  args: string[],
  opts?: { timeoutMs?: number; stdoutSink?: string },
): Promise<Awaited<ReturnType<typeof runSubprocess>>> {
  return runSubprocess(["docker", ...args], {
    timeoutMs: opts?.timeoutMs,
    stdoutSink: opts?.stdoutSink,
    env: { MSYS_NO_PATHCONV: "1" },
  })
}

export async function startContainer(opts: StartContainerOpts): Promise<DockerContainer> {
  const name = uniqueName("skvm-agent")
  // Lifetime is expressed to `sleep` in seconds; a floor of 60s prevents
  // rounding down to 0 for very short unit tests.
  const lifetimeSec = Math.max(60, Math.ceil(opts.lifetimeMs / 1000))

  const args: string[] = ["run", "-d", "--name", name]
  for (const m of opts.mounts) {
    const mode = m.mode ?? "rw"
    args.push("-v", `${m.host}:${m.container}:${mode}`)
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    // -e KEY=VALUE — Docker handles values with spaces/quotes correctly when
    // the entire "KEY=VALUE" is a single argv element.
    args.push("-e", `${k}=${v}`)
  }
  if (opts.workDir) args.push("-w", opts.workDir)
  args.push(opts.image, "sleep", String(lifetimeSec))

  log.debug(`docker run: ${args.slice(0, 20).join(" ")}${args.length > 20 ? " ..." : ""}`)
  const r = await dockerCli(args, { timeoutMs: 120_000 })
  if (r.exitCode !== 0) {
    throw new Error(
      `docker-run: startContainer failed (exit ${r.exitCode}): ${r.stderr.slice(0, 400)}`,
    )
  }

  let cleanedUp = false
  return {
    name,
    async cleanup(): Promise<void> {
      if (cleanedUp) return
      cleanedUp = true
      // `rm -f` both kills and removes; ignore errors (container may already
      // be gone from a timeout kill).
      await dockerCli(["rm", "-f", name], { timeoutMs: 30_000 }).catch((err) => {
        log.warn(`docker-run: cleanup ${name} failed (ignored): ${err}`)
      })
    },
  }
}

export async function execInContainer(
  opts: ExecInContainerOpts,
): Promise<ExecInContainerResult> {
  const args: string[] = ["exec"]
  if (opts.cwd) args.push("-w", opts.cwd)
  args.push(opts.container.name, ...opts.cmd)

  const start = Date.now()
  const r = await dockerCli(args, {
    timeoutMs: opts.timeoutMs,
    stdoutSink: opts.stdoutSink,
  })

  // When runSubprocess times out, killProcessTree() reaps the local `docker`
  // CLI — but the command running INSIDE the container survives (docker
  // daemon still holds the exec). Kill the container to reap it. If callers
  // ever need to preserve the container across a timed-out exec, we can grow
  // `docker top` + `docker exec kill` here.
  if (r.timedOut) {
    log.warn(
      `docker-run: exec timed out after ${opts.timeoutMs}ms; killing container ${opts.container.name}`,
    )
    await dockerCli(["kill", opts.container.name], { timeoutMs: 15_000 }).catch(() => {})
  }

  return {
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    durationMs: Date.now() - start,
    timedOut: r.timedOut,
    ...(r.stdoutFile ? { stdoutFile: r.stdoutFile } : {}),
  }
}
