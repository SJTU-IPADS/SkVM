import type { LLMProvider } from "./types.ts"
import type { ProviderRoute, ProvidersConfig } from "../core/types.ts"
import { getProvidersConfig } from "../core/config.ts"
import { OpenRouterProvider } from "./openrouter.ts"
import { AnthropicProvider } from "./anthropic.ts"
import { OpenAICompatibleProvider } from "./openai-compatible.ts"
import { ProviderAuthError } from "./errors.ts"

/**
 * Built-in fallback route. Applied when `skvm.config.json` has no
 * `providers.routes` section (or no route matches a given model id).
 * Preserves the pre-registry "everything goes through OpenRouter" behavior.
 */
const DEFAULT_ROUTE: ProviderRoute = {
  match: "*",
  kind: "openrouter",
  apiKeyEnv: "OPENROUTER_API_KEY",
}

export interface ProviderOverrides {
  apiKey?: string
  baseUrl?: string
}

/**
 * Resolve a model id to a concrete `LLMProvider`. This is the single
 * chokepoint for internal LLM calls (compiler passes, bench judging,
 * jit-optimize eval, jit-boost candidate parsing, bare-agent adapter, …).
 *
 * Resolution order:
 *   1. Routes from `skvm.config.json` `providers.routes`, first glob match wins.
 *   2. Built-in OpenRouter default, using `OPENROUTER_API_KEY`.
 *
 * `overrides` lets test fixtures and exceptional call sites bypass env-var
 * lookup. Never use overrides to "work around" a missing route — add a route
 * instead.
 */
export function createProviderForModel(
  modelId: string,
  overrides?: ProviderOverrides,
): LLMProvider {
  const config = getProvidersConfig()
  const route = findMatchingRoute(modelId, config) ?? DEFAULT_ROUTE
  return instantiate(modelId, route, overrides)
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
 * Drop the first `/`-separated segment of a model id so the backend sees its
 * native name. SkVM's routing namespace uses `<kind-prefix>/<backend-model-id>`
 * (e.g. `openai/gpt-4o`, `self/qwen3-7b`), but the concrete SDKs (Anthropic,
 * OpenAI, vLLM, Ollama) expect just the bare tail. No-op when there's no
 * slash — handles the case where the user's config already uses a bare id.
 *
 * NOT applied to OpenRouter: its native model-id namespace already contains
 * prefixes (`qwen/qwen3-30b`, `anthropic/claude-sonnet-4.6`), and stripping
 * them would break routing at the OR layer.
 */
export function stripRoutingPrefix(modelId: string): string {
  const slash = modelId.indexOf("/")
  return slash >= 0 ? modelId.slice(slash + 1) : modelId
}

function instantiate(
  modelId: string,
  route: ProviderRoute,
  overrides: ProviderOverrides | undefined,
): LLMProvider {
  // Resolve API key. A missing env var is an infra / config failure, so raise
  // ProviderAuthError here — plain Error would bypass the jit-optimize
  // infraError classification and show up as a normal score=0 criterion.
  let apiKey: string
  if (overrides?.apiKey !== undefined) {
    apiKey = overrides.apiKey
  } else {
    const val = process.env[route.apiKeyEnv]
    if (!val) {
      throw new ProviderAuthError(
        `Route "${route.match}" (kind=${route.kind}) requires env var ${route.apiKeyEnv}, which is not set`,
        route.kind,
      )
    }
    apiKey = val
  }

  switch (route.kind) {
    case "openrouter":
      // OpenRouter's own namespace already contains prefixes like
      // `qwen/qwen3-30b`; pass through unchanged.
      return new OpenRouterProvider({ apiKey, model: modelId })

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
