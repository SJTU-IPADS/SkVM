import type { LLMProvider } from "./types.ts"
import type { ProviderRoute, ProvidersConfig } from "../core/types.ts"
import { getProvidersConfig, stripRoutingPrefix, resolveRouteApiKey } from "../core/config.ts"
export { resolveRouteApiKey } from "../core/config.ts"
import { OpenRouterProvider } from "./openrouter.ts"
import { AnthropicProvider } from "./anthropic.ts"
import { OpenAICompatibleProvider } from "./openai-compatible.ts"
import { ProviderAuthError } from "./errors.ts"
import { AutoProbeProvider, type ProbeOrchestrator } from "./auto-probe.ts"
import { runProbe, inferAnthropicBaseUrl } from "./probe.ts"
import { appendDiscoveredRoute } from "../core/config-write.ts"

/**
 * Return true only when `baseUrl` is the exact official Anthropic API host.
 * Uses `new URL()` to parse the hostname, which prevents substring-match
 * bypasses like `https://notapi.anthropic.com.evil.com`.
 *
 * Returns `false` when the URL is unparseable — we treat an unrecognisable
 * gateway as non-official, which skips the `claude-` prefix check. That
 * matches the existing intent: the prefix guard is only for the real
 * Anthropic backend, not arbitrary custom gateways.
 */
function isOfficialAnthropicUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === "api.anthropic.com"
  } catch {
    // Unparseable URL: treat as non-official so we don't accidentally
    // enforce the claude- prefix on a custom gateway.
    return false
  }
}

/**
 * Built-in fallback route. Applied when `providers.routes` is empty or no
 * user route matches a given model id. Catches `openrouter/...` ids without
 * forcing the user to configure a route explicitly — other prefixes still
 * fail loudly so typos don't silently route through OR.
 */
const DEFAULT_ROUTE: ProviderRoute = {
  match: "openrouter/*",
  kind: "openrouter",
  apiKeyEnv: "OPENROUTER_API_KEY",
}

export interface ProviderOverrides {
  apiKey?: string
  baseUrl?: string
}

/**
 * Resolve a model id to its matching `ProviderRoute`. Single chokepoint for
 * "given a model id, what route applies?" — used by every subsystem that
 * cares (instantiate, envForRoute, headless-agent, jiuwenclaw env writer).
 *
 * Resolution order:
 *   1. First user route from `providers.routes` whose glob matches.
 *   2. Built-in `openrouter/*` default — only applies when the id actually
 *      starts with that prefix. Typoed or unconfigured prefixes (e.g.
 *      `ipads/gpt-4o` with no `ipads/*` route) throw, so they can't be
 *      silently misrouted through OpenRouter.
 */
export function resolveRoute(modelId: string): ProviderRoute {
  const route = findMatchingRoute(modelId, getProvidersConfig())
  if (route) return route
  if (globMatch(DEFAULT_ROUTE.match, modelId)) return DEFAULT_ROUTE
  throw new Error(
    `No providers.routes entry matches model id "${modelId}". Every CLI model id must carry ` +
    `a <provider>/ prefix with a matching route; the built-in openrouter/* fallback only covers ` +
    `openrouter/... ids. Configure a route in skvm.config.json or prefix the id with openrouter/.`,
  )
}

/**
 * Cheap shape check on the model id AFTER the routing prefix is stripped —
 * catches common user typos before we spawn any subprocess. This is
 * deliberately loose: we can't know what models a given backend catalog
 * actually has, only the format it expects.
 *
 *   openrouter: bare id must be `<vendor>/<model>` (the format the
 *               openrouter.ai /chat/completions endpoint expects)
 *   anthropic:  bare id must look like an Anthropic model (`claude-*`)
 *   openai-compatible: any non-whitespace string
 *
 * Throws an `Error` with an actionable hint. Callers (each adapter's managed
 * setup) should wrap in try/catch to add adapter-specific context.
 */
export function validateModelIdForRoute(modelId: string, route: ProviderRoute): void {
  const bare = stripRoutingPrefix(modelId)
  if (!bare || /\s/.test(bare)) {
    throw new Error(`Invalid model id "${modelId}" — empty or contains whitespace after stripping routing prefix.`)
  }
  switch (route.kind) {
    case "openrouter": {
      if (!bare.includes("/")) {
        throw new Error(
          `Model id "${modelId}" is not a valid OpenRouter id. ` +
          `OpenRouter expects "<vendor>/<model>" (e.g. "openrouter/qwen/qwen3-30b-a3b-instruct-2507"). ` +
          `Got bare id "${bare}" — did you mean "openrouter/qwen/${bare}" or similar?`,
        )
      }
      return
    }
    case "anthropic": {
      // The `claude-*` prefix check only applies to the official Anthropic
      // endpoint. Third-party Anthropic-compatible gateways (e.g. xty.app's
      // /v1/messages, DeepSeek's /anthropic, Minimax's /anthropic) serve
      // non-Anthropic-vendor models whose ids do not start with "claude-"
      // (glm-5-thinking, minimax-m2.5, etc.). Skip the prefix check when a
      // custom baseUrl is configured and it is not api.anthropic.com.
      const isOfficial = !route.baseUrl || isOfficialAnthropicUrl(route.baseUrl)
      if (isOfficial && !/^claude-/i.test(bare)) {
        throw new Error(
          `Model id "${modelId}" doesn't look like an Anthropic model. ` +
          `Anthropic SDK expects ids starting with "claude-" (e.g. "anthropic/claude-sonnet-4.6"). ` +
          `Got bare id "${bare}".`,
        )
      }
      return
    }
    case "openai-compatible":
      return
  }
}

/**
 * Resolve a model id to a concrete `LLMProvider`. Single chokepoint for
 * internal LLM calls (compiler passes, bench judging, jit-optimize eval,
 * jit-boost candidate parsing, bare-agent adapter, …).
 *
 * `overrides` lets test fixtures and exceptional call sites bypass env-var
 * lookup. Never use overrides to "work around" a missing route — add a route
 * instead.
 *
 * For openai-compatible routes, the returned provider is wrapped in an
 * `AutoProbeProvider` that intercepts `ToolArgumentsParseError` failures,
 * probes the same gateway via its Anthropic-shaped endpoint, and — if the
 * alt is clean while the primary is polluted — writes a literal anthropic
 * route and retries via `AnthropicProvider`. Set `SKVM_AUTO_PROBE=0` to
 * opt out entirely.
 */
export function createProviderForModel(
  modelId: string,
  overrides?: ProviderOverrides,
): LLMProvider {
  const route = resolveRoute(modelId)
  const delegate = instantiate(modelId, route, overrides)

  // Auto-probe is gated to openai-compatible routes. The alternative endpoint
  // that auto-probe synthesises is an Anthropic-shaped URL on the same host
  // (e.g. /v1 → /v1/messages). That synthesis only makes sense when the
  // primary route is an openai-compatible gateway; anthropic and openrouter
  // routes have no such Anthropic-shaped alternative to discover.
  if (route.kind !== "openai-compatible") return delegate

  // Opt-out: env var, then check that auto-probe is even applicable here.
  if (process.env.SKVM_AUTO_PROBE === "0") return delegate
  if (!route.baseUrl) return delegate

  const orchestrator: ProbeOrchestrator = async (mid, r) => {
    const altBase = inferAnthropicBaseUrl(r.baseUrl ?? "")
    if (!altBase) {
      return { verdict: { primary: "polluted", alt: "indeterminate" }, altProvider: null, writeRoute: null }
    }
    const altApiKey = overrides?.apiKey ?? resolveRouteApiKey(r)
    const altProvider: LLMProvider = new AnthropicProvider({
      apiKey: altApiKey,
      model: stripRoutingPrefix(mid),
      baseUrl: altBase,
    })
    const verdict = await runProbe({ primary: delegate, alt: () => altProvider })
    if (verdict.primary === "polluted" && verdict.alt === "clean") {
      const writeRoute = async () => appendDiscoveredRoute({
        match: mid,
        kind: "anthropic",
        baseUrl: altBase,
        apiKey: r.apiKey,
        apiKeyEnv: r.apiKeyEnv,
        discoveredAt: new Date().toISOString(),
        discoveredFrom: r.match,
      })
      return { verdict, altProvider, writeRoute }
    }
    return { verdict, altProvider: null, writeRoute: null }
  }

  return new AutoProbeProvider(delegate, modelId, route, orchestrator)
}

export function findMatchingRoute(
  modelId: string,
  config: ProvidersConfig,
): ProviderRoute | undefined {
  for (const route of config.routes) {
    if (globMatch(route.match, modelId)) return route
  }
  return undefined
}

/**
 * Literal + `*` glob match. No regex, no character classes — keeps the
 * config surface minimal and the behavior predictable.
 *
 * Examples:
 *   "anthropic/*" matches "anthropic/claude-sonnet-4.6"
 *   "*"           matches anything
 *   "openai/gpt-*" matches "openai/gpt-4o"
 */
export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`).test(value)
}

/**
 * Standard SDK env vars to inject into adapter / headless subprocesses so
 * they can reach the backend matched by `providers.routes` without the user
 * also having to configure those credentials on the adapter side.
 *
 * Returns `{}` only when the resolved route has no usable key — in that case
 * the spawn inherits whatever the parent shell already had set.
 *
 * Best-effort, NOT a full bridge: an adapter that ignores the SDK conventions
 * (e.g. reads its own config file) won't pick these up. The skvm-managed
 * opencode subprocess in `headless-agent` goes further and also injects
 * OPENCODE_CONFIG_CONTENT for openai-compatible routes.
 */
export function envForRoute(modelId: string): Record<string, string> {
  const route = resolveRoute(modelId)
  const apiKey = resolveRouteApiKey(route)
  if (!apiKey) return {}
  switch (route.kind) {
    case "openrouter":
      return { OPENROUTER_API_KEY: apiKey }
    case "anthropic":
      return { ANTHROPIC_API_KEY: apiKey }
    case "openai-compatible":
      return route.baseUrl
        ? { OPENAI_API_KEY: apiKey, OPENAI_BASE_URL: route.baseUrl }
        : { OPENAI_API_KEY: apiKey }
  }
}

function instantiate(
  modelId: string,
  route: ProviderRoute,
  overrides: ProviderOverrides | undefined,
): LLMProvider {
  // Resolve API key. Order: explicit override → resolveRouteApiKey (covers
  // route.apiKey, SKVM_ROUTE_<id>_KEY sandbox injection, and route.apiKeyEnv).
  // A missing key is an infra / config failure, so raise ProviderAuthError —
  // plain Error would bypass the jit-optimize infraError classification and
  // show up as a normal score=0 criterion.
  let apiKey: string
  if (overrides?.apiKey !== undefined) {
    apiKey = overrides.apiKey
  } else {
    const resolved = resolveRouteApiKey(route)
    if (!resolved) {
      if (route.apiKeyEnv) {
        throw new ProviderAuthError(
          `Route "${route.match}" (kind=${route.kind}) requires env var ${route.apiKeyEnv}, which is not set`,
          route.kind,
        )
      }
      throw new ProviderAuthError(
        `Route "${route.match}" (kind=${route.kind}) has neither apiKey nor apiKeyEnv set`,
        route.kind,
      )
    }
    apiKey = resolved
  }

  switch (route.kind) {
    case "openrouter":
      // OR's native ids use `<vendor>/<model>` — after stripping SkVM's
      // routing prefix (`openrouter/`) we're left with exactly that shape.
      return new OpenRouterProvider({ apiKey, model: stripRoutingPrefix(modelId) })

    case "anthropic":
      // Anthropic SDK expects a bare id ("claude-sonnet-4.6"). When the
      // route specifies a custom baseUrl (e.g., a third-party Anthropic-
      // compatible gateway), thread it through — the SDK appends
      // `/v1/messages` itself.
      return new AnthropicProvider({
        apiKey,
        model: stripRoutingPrefix(modelId),
        baseUrl: overrides?.baseUrl ?? route.baseUrl,
      })

    case "openai-compatible": {
      const baseUrl = overrides?.baseUrl ?? route.baseUrl
      if (!baseUrl) {
        throw new ProviderAuthError(
          `Route "${route.match}" (kind=openai-compatible) is missing "baseUrl". ` +
          `Add it in skvm.config.json under providers.routes.`,
          route.kind,
        )
      }
      // OpenAI / Azure / vLLM / Ollama / DeepSeek expect their native bare
      // model id; strip the SkVM routing prefix so a route `openai/*` called
      // with `openai/gpt-4o` passes just `gpt-4o` to the backend.
      return new OpenAICompatibleProvider({
        apiKey,
        model: stripRoutingPrefix(modelId),
        baseUrl,
      })
    }
  }
}
