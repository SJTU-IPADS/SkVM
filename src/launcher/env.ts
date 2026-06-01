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

  // Forward host-set runtime toggles. `--no-auto-probe` is stripped from argv
  // on the host and re-expressed as SKVM_AUTO_PROBE=0; without forwarding it,
  // the container would re-enable auto-probe despite the user opting out.
  const autoProbe = opts.hostEnv.SKVM_AUTO_PROBE
  if (autoProbe !== undefined && autoProbe.length > 0) {
    env.SKVM_AUTO_PROBE = autoProbe
  }

  // Proxy passthrough
  for (const v of PROXY_VARS) {
    const val = opts.hostEnv[v]
    if (val && val.length > 0) env[v] = val
  }

  // Route key injection. safeRouteId collapses punctuation to `_`, so two
  // distinct matches that differ only by punctuation (e.g. "openai-x/*" and
  // "openai_x/*") would map to the same SKVM_ROUTE_<id>_KEY and the second
  // would silently overwrite the first — injecting the wrong key for one
  // route. Detect that collision on the host and fail loud before launching.
  const idToMatch = new Map<string, string>()
  for (const r of opts.routes) {
    const id = safeRouteId(r.match)
    const prior = idToMatch.get(id)
    if (prior !== undefined && prior !== r.match) {
      throw new Error(
        `route match collision: "${prior}" and "${r.match}" both map to ` +
        `SKVM_ROUTE_${id}_KEY. Rename one route's match so the two differ by ` +
        `more than punctuation.`,
      )
    }
    idToMatch.set(id, r.match)
    const key = resolveRouteApiKey({
      match: r.match,
      apiKey: r.apiKey,
      apiKeyEnv: r.apiKeyEnv,
    })
    if (key) {
      env[`SKVM_ROUTE_${id}_KEY`] = key
    }
  }

  return env
}
