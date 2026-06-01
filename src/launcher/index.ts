import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"

import {
  SKVM_CACHE,
  SKVM_DATA_DIR,
  getConfigPath,
  getProvidersConfig,
  getSandboxConfig,
} from "../core/config.ts"
import pkgJson from "../../package.json" with { type: "json" }

import { composeMounts } from "./mounts.ts"
import { composeEnv } from "./env.ts"
import { writeSanitizedConfig } from "./config-sanitize.ts"
import { resolveImageRef, ensureImagePresent } from "./image.ts"
import { buildDockerRunArgv } from "./docker-argv.ts"
import { reapLeaked } from "./stale-reap.ts"

/**
 * Redact the value of any `NAME=VALUE` argv token whose NAME looks like it
 * carries a secret, so `--debug-sandbox` output is safe to paste into issues,
 * CI logs, or a screen share. The injected provider keys live in
 * `SKVM_ROUTE_<id>_KEY=...` env tokens; we also catch generic key/token/
 * secret/password names defensively.
 */
/**
 * Reject `--mount-extra` host paths that would hand the container control of
 * the host: the Docker socket (→ full host root via the daemon API) and the
 * host filesystem root. `--mount-extra` is a deliberate escape hatch, but
 * these two break containment so completely that they should never be a
 * frictionless one-liner — especially when a value is forwarded from a script.
 */
export function assertMountExtraAllowed(hostPath: string): void {
  const resolved = path.resolve(hostPath)
  if (resolved === "/") {
    throw new Error(`--mount-extra refuses to mount the host root "/" into the sandbox.`)
  }
  if (/(^|\/)docker\.sock$/.test(resolved)) {
    throw new Error(
      `--mount-extra refuses to mount the Docker socket (${hostPath}); ` +
      `that grants the container full control of the host Docker daemon.`,
    )
  }
}

/**
 * Validate every host path in a list of extra mounts against the denylist.
 * Both CLI `--mount-extra` and config `sandbox.docker.extraMounts` flow through
 * this so the two escape hatches share one set of rules.
 */
export function assertExtraMountsAllowed(mounts: Array<{ host: string }>): void {
  for (const m of mounts) {
    assertMountExtraAllowed(m.host)
  }
}

export function redactSecretToken(tok: string): string {
  const eq = tok.indexOf("=")
  if (eq <= 0) return tok
  const name = tok.slice(0, eq)
  if (name.startsWith("SKVM_ROUTE_") || /key|token|secret|password/i.test(name)) {
    return `${name}=<redacted>`
  }
  return tok
}

/**
 * Sandbox-mode dispatch. Composes mounts, env, image ref, and a hardened
 * `docker run` argv from the user's CLI args; then replaces this process
 * with `docker run`. Never returns on success.
 *
 * args: the full CLI args (slice(2) of process.argv) — `--sandbox` has
 * already been stripped by the caller in src/index.ts.
 */
export async function runLauncher(args: string[]): Promise<never> {
  reapLeaked()

  const sandboxCfg = getSandboxConfig()
  const providers = getProvidersConfig()
  const hostConfigPath = getConfigPath()

  // Ensure the cache root exists on the host before docker bind-mounts it.
  // A missing bind source is created by the daemon as root; the container then
  // runs as the host uid and cannot write /skvm-cache (logs/config/profiles),
  // and the host is left with a root-owned ~/.skvm. Creating it here keeps it
  // owned by the invoking user.
  mkdirSync(SKVM_CACHE, { recursive: true })

  // Config-supplied extra mounts are an escape hatch like --mount-extra, and
  // must clear the same denylist (Docker socket, host root). Validate before
  // composing mounts so a malformed config fails loud, not silently inside the
  // container.
  assertExtraMountsAllowed(sandboxCfg.docker.extraMounts)

  const sanitizedConfigPath = writeSanitizedConfig(hostConfigPath, process.pid)

  const skvmDataExists = existsSync(SKVM_DATA_DIR) ? SKVM_DATA_DIR : null

  // --docker-image override (parsed inline; doesn't need to live in path-flags.ts)
  let cliImageOverride: string | null = null
  let cliNetworkOverride: typeof sandboxCfg.docker.network | null = null
  const cliExtraMounts: Array<{ host: string; inner: string; mode: "ro" | "rw" }> = []
  let debugSandbox = false
  const forwarded: string[] = []
  for (const a of args) {
    if (a.startsWith("--docker-image=")) {
      cliImageOverride = a.slice("--docker-image=".length)
      continue
    }
    if (a.startsWith("--docker-network=")) {
      const v = a.slice("--docker-network=".length)
      if (v !== "none" && v !== "bridge" && v !== "host") {
        throw new Error(`--docker-network must be one of none|bridge|host (got ${v})`)
      }
      cliNetworkOverride = v
      continue
    }
    if (a.startsWith("--mount-extra=")) {
      const triple = a.slice("--mount-extra=".length).split(":")
      if (triple.length !== 3 || (triple[2] !== "ro" && triple[2] !== "rw")) {
        throw new Error(`--mount-extra expects host:inner:ro|rw (got ${a})`)
      }
      assertMountExtraAllowed(triple[0]!)
      cliExtraMounts.push({ host: triple[0]!, inner: triple[1]!, mode: triple[2] as "ro" | "rw" })
      continue
    }
    if (a === "--debug-sandbox") { debugSandbox = true; continue }
    forwarded.push(a)
  }

  const { argv: mountArgv, rewrittenArgs } = composeMounts({
    args: forwarded,
    roots: {
      cwd: process.cwd(),
      skvmCache: SKVM_CACHE,
      skvmDataDir: skvmDataExists,
      sanitizedConfigPath,
    },
    configExtraMounts: sandboxCfg.docker.extraMounts,
    cliExtraMounts,
  })

  const env = composeEnv({
    routes: providers.routes,
    hostEnv: process.env as Record<string, string | undefined>,
    skvmDataMounted: skvmDataExists !== null,
  })

  const image = resolveImageRef({
    cliOverride: cliImageOverride,
    configImage: sandboxCfg.docker.image,
    skvmVersion: pkgJson.version,
  })

  ensureImagePresent(image)

  // Run the container as the host user so bind-mounted writes are owned by the
  // invoker. Refuse to silently fall back to uid 0 (root) when getuid is
  // unavailable — running the sandbox as root would undermine the isolation
  // the `-u` flag is meant to provide.
  const getuid = process.getuid
  const getgid = process.getgid
  if (!getuid || !getgid) {
    throw new Error(
      `--sandbox: cannot determine host uid/gid on this platform ` +
      `(process.getuid unavailable); refusing to run the container as root.`,
    )
  }

  const argv = buildDockerRunArgv({
    mountArgv,
    env,
    image,
    networkMode: cliNetworkOverride ?? sandboxCfg.docker.network,
    resourceLimits: {
      memory: sandboxCfg.docker.memory,
      cpus: sandboxCfg.docker.cpus,
      pidsLimit: sandboxCfg.docker.pidsLimit,
    },
    hostUid: getuid(),
    hostGid: getgid(),
    hostPid: process.pid,
    command: ["skvm", ...rewrittenArgs],
  })

  if (debugSandbox) {
    for (const tok of argv) console.log(redactSecretToken(tok))
    process.exit(0)
  }

  // Exec docker. spawnSync with stdio: "inherit" gives us signal forwarding +
  // exit code propagation. (Bun lacks an execvp wrapper; spawnSync + exit is
  // the idiomatic substitute.)
  const child = spawnSync(argv[0]!, argv.slice(1), { stdio: "inherit" })
  process.exit(child.status ?? 1)
}
