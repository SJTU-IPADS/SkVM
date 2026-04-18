import type { LLMProvider } from "./types.ts"
import type { ProviderRoute, ProvidersConfig } from "../core/types.ts"
import { getProvidersConfig, stripRoutingPrefix } from "../core/config.ts"
import { OpenRouterProvider } from "./openrouter.ts"
import { AnthropicProvider } from "./anthropic.ts"
import { OpenAICompatibleProvider } from "./openai-compatible.ts"
import { ProviderAuthError } from "./errors.ts"

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
 * Resolve a model id to a concrete `LLMProvider`. Single chokepoint for
 * internal LLM calls (compiler passes, bench judging, jit-optimize eval,
 * jit-boost candidate parsing, bare-agent adapter, …).
 *
 * `overrides` lets test fixtures and exceptional call sites bypass env-var
 * lookup. Never use overrides to "work around" a missing route — add a route
 * instead.
 */
export function createProviderForModel(
  modelId: string,
  overrides?: ProviderOverrides,
): LLMProvider {
  return instantiate(modelId, resolveRoute(modelId), overrides)
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
 * Resolve a route's API key as a plain string. Used by env-var injection
 * (envForRoute) and the OPENCODE_CONFIG_CONTENT builder. Returns null when
 * neither `apiKey` nor `apiKeyEnv` yields a usable value — callers then
 * decide whether absence is a failure (instantiate) or just "no help"
 * (env injection — let the spawn inherit). `instantiate` keeps its own
 * branchy resolver because it must raise ProviderAuthError on missing keys
 * (the jit-optimize infraError classification depends on that exception
 * shape).
 */
export function resolveRouteApiKey(route: ProviderRoute): string | null {
  if (route.apiKey) return route.apiKey
  if (route.apiKeyEnv) {
    const val = process.env[route.apiKeyEnv]
    if (val) return val
  }
  return null
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
  // Resolve API key. Order: explicit override → route.apiKey (stored in
  // skvm.config.json by `skvm config init`) → env var named by route.apiKeyEnv.
  // A missing key is an infra / config failure, so raise ProviderAuthError —
  // plain Error would bypass the jit-optimize infraError classification and
  // show up as a normal score=0 criterion.
  let apiKey: string
  if (overrides?.apiKey !== undefined) {
    apiKey = overrides.apiKey
  } else if (route.apiKey) {
    apiKey = route.apiKey
  } else if (route.apiKeyEnv) {
    const val = process.env[route.apiKeyEnv]
    if (!val) {
      throw new ProviderAuthError(
        `Route "${route.match}" (kind=${route.kind}) requires env var ${route.apiKeyEnv}, which is not set`,
        route.kind,
      )
    }
    apiKey = val
  } else {
    throw new ProviderAuthError(
      `Route "${route.match}" (kind=${route.kind}) has neither apiKey nor apiKeyEnv set`,
      route.kind,
    )
  }

  switch (route.kind) {
    case "openrouter":
      // OR's native ids use `<vendor>/<model>` — after stripping SkVM's
      // routing prefix (`openrouter/`) we're left with exactly that shape.
      return new OpenRouterProvider({ apiKey, model: stripRoutingPrefix(modelId) })

    case "anthropic":
      // Anthropic SDK expects a bare id ("claude-sonnet-4.6").
      return new AnthropicProvider({
        apiKey,
        model: stripRoutingPrefix(modelId),
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
