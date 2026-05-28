import { safeRouteId, resolveRouteApiKey } from "../core/config.ts"

interface RouteLike {
  match: string
  kind: string
  apiKey?: string
  apiKeyEnv?: string
}

export interface ComposeEnvArgs {
  routes: RouteLike[]
  hostEnv: Record<string, string | undefined>
  /** Whether the launcher mounted the dataset at /skvm-data. When true the
   *  container is told to resolve its dataset root there. */
  skvmDataMounted?: boolean
}

const PROXY_VARS = [
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy",
]

export function composeEnv(opts: ComposeEnvArgs): Record<string, string> {
  const env: Record<string, string> = {
    SKVM_IN_SANDBOX: "1",
    HOME: "/workspace",
    // Point the in-container skvm at the mounted cache (which holds the
    // sanitized config + profiles/logs/proposals). Without this, the
    // container resolves SKVM_CACHE to ~/.skvm = /workspace/.skvm (because
    // HOME=/workspace) and never sees the mounted config or its routes.
    SKVM_CACHE: "/skvm-cache",
  }

  // Dataset root, only when the launcher actually mounted it at /skvm-data.
  if (opts.skvmDataMounted) {
    env.SKVM_DATA_DIR = "/skvm-data"
  }

  // Proxy passthrough
  for (const v of PROXY_VARS) {
    const val = opts.hostEnv[v]
    if (val && val.length > 0) env[v] = val
  }

  // Route key injection
  for (const r of opts.routes) {
    const key = resolveRouteApiKey({
      match: r.match,
      apiKey: r.apiKey,
      apiKeyEnv: r.apiKeyEnv,
    })
    if (key) {
      env[`SKVM_ROUTE_${safeRouteId(r.match)}_KEY`] = key
    }
  }

  return env
}
