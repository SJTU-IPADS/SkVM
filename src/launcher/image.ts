import { spawnSync } from "node:child_process"

export interface ResolveImageRefArgs {
  cliOverride: string | null
  configImage: string | null
  skvmVersion: string
}

export function resolveImageRef(opts: ResolveImageRefArgs): string {
  if (opts.cliOverride) return opts.cliOverride
  if (opts.configImage) return opts.configImage
  return `ghcr.io/sjtu-ipads/skvm-sandbox:${opts.skvmVersion}`
}

export function buildBuildCommandHint(ref: string): string {
  return `docker build -f docker/skvm-sandbox.Dockerfile -t ${ref} .`
}

/**
 * Check whether `ref` is present locally; if not, attempt `docker pull`; if
 * that fails, throw with the exact build-locally command in the message.
 */
export function ensureImagePresent(ref: string): void {
  const inspect = spawnSync("docker", ["image", "inspect", ref], { stdio: "ignore" })
  if (inspect.status === 0) return

  const pull = spawnSync("docker", ["pull", ref], { stdio: "inherit" })
  if (pull.status === 0) return

  throw new Error(
    `skvm: image ${ref} not present locally and pull failed.\n` +
    `Build it yourself with:\n  ${buildBuildCommandHint(ref)}\n`,
  )
}
