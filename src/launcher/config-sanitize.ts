import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs"
import path from "node:path"

const LAUNCHER_TMP_PREFIX = "/tmp/skvm-launcher-"

/**
 * Read the host's skvm.config.json, strip every route's `apiKey` / `apiKeyEnv`
 * field, and write the result to a per-host-pid tmp file. Returns the tmp
 * file path; the caller bind-mounts it at `/skvm-cache/skvm.config.json:ro`
 * inside the container so a `cat /skvm-cache/skvm.config.json` from a tool
 * call sees no keys.
 *
 * The container's in-process config loader pulls keys from
 * `SKVM_ROUTE_<safeRouteId>_KEY` env vars instead (see env.ts +
 * resolveRouteApiKey in core/config.ts).
 */
export function writeSanitizedConfig(hostConfigPath: string, hostPid: number): string {
  const tmpDir = `${LAUNCHER_TMP_PREFIX}${hostPid}`
  mkdirSync(tmpDir, { recursive: true })
  chmodSync(tmpDir, 0o700)
  const outPath = path.join(tmpDir, "skvm.config.json")

  let raw: unknown = {}
  if (existsSync(hostConfigPath)) {
    try {
      raw = JSON.parse(readFileSync(hostConfigPath, "utf-8"))
    } catch {
      raw = {}
    }
  }

  const config = raw as { providers?: { routes?: Array<Record<string, unknown>> } }
  if (config.providers?.routes) {
    config.providers.routes = config.providers.routes.map(r => {
      const { apiKey, apiKeyEnv, ...rest } = r
      return rest
    })
  }

  writeFileSync(outPath, JSON.stringify(config, null, 2), { mode: 0o600 })
  return outPath
}
