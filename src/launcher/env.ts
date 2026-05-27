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
}

const PROXY_VARS = [
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy",
]

export function composeEnv(opts: ComposeEnvArgs): Record<string, string> {
  const env: Record<string, string> = {
    SKVM_IN_SANDBOX: "1",
    HOME: "/workspace",
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
