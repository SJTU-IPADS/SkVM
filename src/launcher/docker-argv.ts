import type { SandboxNetwork } from "../core/types.ts"

export interface DockerRunArgvOpts {
  mountArgv: string[]
  env: Record<string, string>
  image: string
  networkMode: SandboxNetwork
  resourceLimits: { memory: string; cpus: string; pidsLimit: number }
  hostUid: number
  hostGid: number
  hostPid: number
  command: string[]
}

export function buildDockerRunArgv(opts: DockerRunArgvOpts): string[] {
  const argv: string[] = ["docker", "run", "--rm", "-i"]

  argv.push("-u", `${opts.hostUid}:${opts.hostGid}`)
  argv.push("--cap-drop=ALL")
  argv.push("--security-opt", "no-new-privileges")
  argv.push(`--pids-limit=${opts.resourceLimits.pidsLimit}`)
  argv.push(`--memory=${opts.resourceLimits.memory}`)
  argv.push(`--cpus=${opts.resourceLimits.cpus}`)
  argv.push(`--network=${opts.networkMode}`)
  argv.push("--label", "skvm-sandbox=1")
  argv.push("--label", `skvm-sandbox-host-pid=${opts.hostPid}`)
  argv.push("-w", "/workspace")
  argv.push(...opts.mountArgv)
  for (const [k, v] of Object.entries(opts.env)) {
    // A newline (or NUL) in an env value would corrupt the `-e K=V` argument
    // docker receives — e.g. an API key with a stray trailing newline from a
    // secrets manager. Reject loudly rather than silently injecting a
    // truncated/garbled value.
    if (/[\n\r\0]/.test(v)) {
      throw new Error(`sandbox env value for "${k}" contains a newline or NUL byte; refusing to pass a corrupt -e argument to docker.`)
    }
    argv.push("-e", `${k}=${v}`)
  }
  argv.push(opts.image)
  argv.push(...opts.command)
  return argv
}
