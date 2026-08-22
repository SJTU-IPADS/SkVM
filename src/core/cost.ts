import type { TokenUsage } from "./types.ts"
import { resolveBackendModel } from "../providers/registry.ts"

/**
 * Cost per million tokens for known models (input/output).
 *
 * Keys are **backend-namespace** ids — what `resolveBackendModel` returns after
 * stripping the CLI routing prefix. An OpenRouter id keeps its vendor segment
 * (`qwen/qwen3-30b-a3b-instruct-2507`), so bare names like `qwen3-30b` below
 * only ever match direct-vendor routes. A missing key prices the run at $0,
 * which is why this is a fallback of last resort: prefer the provider's own
 * `usage.cost`, and check `llmCallsWithCost` before trusting a dollar figure.
 */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // OpenRouter-routed ids, verified against the models API on 2026-08-06.
  // Listed prices drift; these exist so a provider that omits usage.cost
  // produces a usable estimate instead of a silent $0.
  "anthropic/claude-opus-4.6": { input: 5, output: 25 },
  "deepseek/deepseek-v3.2": { input: 0.269, output: 0.4 },
  "google/gemini-3-flash-preview": { input: 0.5, output: 3 },
  "qwen/qwen3-30b-a3b-instruct-2507": { input: 0.04815, output: 0.19305 },
  "qwen/qwen3.5-397b-a17b": { input: 0.39, output: 2.34 },
  "mistralai/mistral-small-2603": { input: 0.15, output: 0.6 },
  "mistralai/codestral-2508": { input: 0.3, output: 0.9 },
  "openai/gpt-5.6-sol": { input: 5, output: 30 },
  "openai/gpt-5.6-luna": { input: 0.1, output: 0.6 },
  "openai/gpt-5.4-mini": { input: 0.75, output: 4.5 },
  // Anthropic
  "claude-opus-4.6": { input: 15, output: 75 },
  "claude-opus-4-6": { input: 15, output: 75 },
  "claude-sonnet-4.6": { input: 3, output: 15 },
  "claude-haiku-4.5": { input: 0.8, output: 4 },
  "claude-haiku-4-5": { input: 0.8, output: 4 },
  // OpenAI
  "gpt-5.5": { input: 5, output: 30 },
  "gpt-5.4": { input: 2.5, output: 10 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "codex-mini-latest": { input: 1.5, output: 6 },
  // Google
  "gemini-2.5-flash": { input: 0.15, output: 0.6 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  // Qwen
  "qwen3-30b": { input: 0.2, output: 0.6 },
  "qwen3.5-9b": { input: 0.1, output: 0.3 },
  "qwen3.5-35b-a3b": { input: 0.15, output: 0.45 },
  "qwen3.5-122b-a10b": { input: 0.3, output: 0.9 },
  "qwen3.6-plus:free": { input: 0, output: 0 },
  "qwen3-235b-a22b-instruct-2507": { input: 0.5, output: 1.5 },
  // DeepSeek
  "deepseek-v3.2": { input: 0.27, output: 1.1 },
  // Mistral
  "devstral-small": { input: 0.1, output: 0.3 },
  "devstral-small-2507": { input: 0.1, output: 0.3 },
  // MiniMax
  "minimax-m2.7": { input: 0.5, output: 2 },
  "minimax-m2.5": { input: 0.3, output: 1.2 },  // approximate — verify on release
  // Z-AI / GLM
  "glm-5-turbo": { input: 0.3, output: 1.2 },
  "glm-5.1": { input: 0.5, output: 1.5 },       // approximate — verify on release
}

/**
 * Return the cost of a single LLM call in USD.
 *
 * Prefer the authoritative `providedCostUsd` when the provider returned one
 * (e.g. OpenRouter's `usage.cost` when `usage: { include: true }` is set).
 * The local pricing table below is a best-effort fallback for providers that
 * don't surface their own billing — it cannot account for prompt caching,
 * spot discounts, or provider variants, so it will drift from reality over
 * time. Any new code path that has access to an `LLMResponse` should pass
 * `response.costUsd` as the third argument.
 */
export function estimateCost(
  model: string,
  tokens: TokenUsage,
  providedCostUsd?: number,
): number {
  if (providedCostUsd !== undefined) return providedCostUsd
  // Pricing keys are backend-namespace ids, so routed ids shed their prefix.
  const pricing = MODEL_PRICING[resolveBackendModel(model)]
  if (!pricing) return 0
  const inputCost = (tokens.input / 1_000_000) * pricing.input
  const outputCost = (tokens.output / 1_000_000) * pricing.output
  // Cache reads are typically cheaper (e.g., 10% of input cost)
  const cacheCost = (tokens.cacheRead / 1_000_000) * pricing.input * 0.1
  return inputCost + outputCost + cacheCost
}

/** Track cumulative cost across multiple LLM calls */
export class CostTracker {
  private _totalUsd = 0
  private _calls = 0

  record(cost: number) {
    this._totalUsd += cost
    this._calls++
  }

  get totalUsd(): number {
    return this._totalUsd
  }

  get calls(): number {
    return this._calls
  }

  reset() {
    this._totalUsd = 0
    this._calls = 0
  }
}
