import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"

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

  const sanitizedConfigPath = writeSanitizedConfig(hostConfigPath, process.pid)

  const skvmDataExists = existsSync(SKVM_DATA_DIR) ? SKVM_DATA_DIR : null

  // --docker-image override (parsed inline; doesn't need to live in path-flags.ts)
  let cliImageOverride: string | null = null
  let cliNetworkOverride: typeof sandboxCfg.docker.network | null = null
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
  })

  const env = composeEnv({
    routes: providers.routes,
    hostEnv: process.env as Record<string, string | undefined>,
  })

  const image = resolveImageRef({
    cliOverride: cliImageOverride,
    configImage: sandboxCfg.docker.image,
    skvmVersion: pkgJson.version,
  })

  ensureImagePresent(image)

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
    hostUid: process.getuid?.() ?? 0,
    hostGid: process.getgid?.() ?? 0,
    hostPid: process.pid,
    command: ["skvm", ...rewrittenArgs],
  })

  // Exec docker. spawnSync with stdio: "inherit" gives us signal forwarding +
  // exit code propagation. (Bun lacks an execvp wrapper; spawnSync + exit is
  // the idiomatic substitute.)
  const child = spawnSync(argv[0]!, argv.slice(1), { stdio: "inherit" })
  process.exit(child.status ?? 1)
}
