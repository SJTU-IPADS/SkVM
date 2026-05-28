import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs"
import path from "node:path"
import { safeRouteId } from "../core/config.ts"

const LAUNCHER_TMP_PREFIX = "/tmp/skvm-launcher-"

/**
 * Read the host's skvm.config.json and write a key-free copy to a per-host-pid
 * tmp file. The caller bind-mounts it at `/skvm-cache/skvm.config.json:ro`
 * inside the container so a `cat /skvm-cache/skvm.config.json` from a tool
 * call never sees a literal key.
 *
 * For each route that had key material, the secret `apiKey` is dropped and
 * `apiKeyEnv` is rewritten to point at the env var the launcher injects
 * (`SKVM_ROUTE_<safeRouteId>_KEY`, see env.ts). This keeps the route
 * schema-valid (ProviderRouteSchema requires `apiKey` or `apiKeyEnv`) while
 * keeping the secret out of the file — the in-container loader resolves the
 * key from the env var via `resolveRouteApiKey` in core/config.ts.
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
      const hadKey = apiKey !== undefined || apiKeyEnv !== undefined
      if (hadKey && typeof rest.match === "string") {
        rest.apiKeyEnv = `SKVM_ROUTE_${safeRouteId(rest.match)}_KEY`
      }
      return rest
    })
  }

  writeFileSync(outPath, JSON.stringify(config, null, 2), { mode: 0o600 })
  return outPath
}
