/**
 * Typed provider error hierarchy.
 *
 * The goal is to distinguish **infrastructure failures** (provider down,
 * network hiccup, auth misconfigured, rate limit exhausted) from **content
 * failures** (LLM produced malformed JSON, schema validation failed, tool
 * call missing). Infra failures must propagate to the loop / CLI so they
 * can fail loudly; content failures can be retried, fallen back to, or
 * scored as 0 without polluting the skill-quality signal.
 *
 * Every `LLMProvider.complete` implementation that talks to the network
 * must throw one of these on terminal failure (after internal retries are
 * exhausted). Generic `Error` escaping a provider indicates a bug.
 */

import type { TokenUsage } from "../core/types.ts"

/** Base class. All provider-originating infra errors extend this. */
export class ProviderError extends Error {
  /** Underlying error, for debugging. */
  override readonly cause?: unknown
  constructor(
    message: string,
    /** Short provider identifier (e.g. "openrouter", "anthropic"). */
    readonly provider: string,
    cause?: unknown,
    /**
     * Whether retrying *might* succeed. Used by in-provider retry loops;
     * by the time a ProviderError escapes the provider, the retries have
     * already been exhausted, so higher layers should NOT re-retry.
     */
    readonly retryable: boolean = false,
  ) {
    super(message)
    this.name = "ProviderError"
    this.cause = cause
  }
}

/** HTTP-layer failure with a status code. */
export class ProviderHttpError extends ProviderError {
  constructor(
    message: string,
    provider: string,
    readonly status: number,
    readonly body?: string,
    cause?: unknown,
  ) {
    super(message, provider, cause, isRetryableStatus(status))
    this.name = "ProviderHttpError"
  }
}

/** Socket / DNS / connection / TLS / fetch-failed class. */
export class ProviderNetworkError extends ProviderError {
  constructor(message: string, provider: string, cause?: unknown) {
    super(message, provider, cause, true)
    this.name = "ProviderNetworkError"
  }
}

/** 401 / 403 / missing API key. Never retryable. */
export class ProviderAuthError extends ProviderError {
  constructor(message: string, provider: string, cause?: unknown) {
    super(message, provider, cause, false)
    this.name = "ProviderAuthError"
  }
}

/** Status codes that the provider's internal retry loop should retry. */
export const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529])

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUS.has(status)
}

/** Type guard for any infra-origin provider error. */
export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError
}

/**
 * Recognizes a 400 that rejects a *forced* `tool_choice` — what thinking-mode
 * models do (DeepSeek reasoner / v4, GLM-5, Anthropic extended thinking all
 * refuse `tool_choice: "required"` / `{tool}`). This is a capability limit,
 * not an infra failure: a request without `tool_choice` on the SAME provider
 * works fine. Callers that have a tool_choice-free fallback (prompt+parse in
 * `extractStructured`) should treat it like a content-layer miss rather than
 * a fatal provider error. Matches on the literal `tool_choice` token, which
 * appears in every observed phrasing:
 *   - DeepSeek:  "deepseek-reasoner does not support this tool_choice"
 *   - DashScope: "The tool_choice parameter does not support being set to
 *                 required or object in thinking mode"
 */
export function isToolChoiceUnsupportedError(err: unknown): boolean {
  if (!(err instanceof ProviderHttpError) || err.status !== 400) return false
  return err.message.toLowerCase().includes("tool_choice")
}

/**
 * Tool-call arguments string from the model could not be parsed as JSON.
 *
 * Symptom of issue #26: some OpenAI-compatible gateways serving thinking-mode
 * models leak reasoning content into `tool_calls[].function.arguments` instead
 * of routing it to a separate `reasoning_content` field. The result is a
 * string like `<think>...</think>{...}` or GLM-private `<tool_call>...` XML
 * that `JSON.parse` cannot consume.
 *
 * Surfaced by `openai-compatible.ts` / `openrouter.ts` instead of the previous
 * silent `args = { raw: ... }` fallback. `structured.ts` Layer 2 prompt+parse
 * picks this up as a content miss; `auto-probe.ts` recognizes it as the
 * trigger to test the Anthropic-shaped path on the same host.
 *
 * Carries the raw argument string for diagnostic logging.
 */
export class ToolArgumentsParseError extends ProviderError {
  constructor(provider: string, readonly rawArguments: string, cause?: unknown) {
    super(
      `tool_call arguments not parseable as JSON (${rawArguments.length} chars): ` +
      `${JSON.stringify(rawArguments.slice(0, 120))}${rawArguments.length > 120 ? "…" : ""}`,
      provider,
      cause,
      false,
    )
    this.name = "ToolArgumentsParseError"
  }
}

/** Type guard for the parse-failure case specifically. */
export function isToolArgumentsParseError(err: unknown): err is ToolArgumentsParseError {
  return err instanceof ToolArgumentsParseError
}

/** Substring hints suggesting `fetch()` threw a transient network error. */
const NETWORK_ERROR_HINTS = [
  "socket",
  "fetch failed",
  "network",
  "connection",
  "econnreset",
  "etimedout",
  "ehostunreach",
  "enotfound",
  "tls",
  "closed unexpectedly",
] as const

/**
 * Heuristic: does this `fetch` rejection look like a transient network error
 * (as opposed to a programmer bug or AbortError)? Used by providers to decide
 * whether to retry inside their own loop.
 */
export function looksLikeNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return NETWORK_ERROR_HINTS.some((keyword) => msg.includes(keyword))
}

// ---------------------------------------------------------------------------
// Partial usage carried on the throw path
// ---------------------------------------------------------------------------

/**
 * Tokens and cost already spent when an infra error aborted a run.
 *
 * A ProviderError propagates past every usage accumulator on its way out
 * (agent loop -> adapter -> caller), so without this the spend simply
 * disappears from the record: a rate-limited run reports 0 tokens and $0
 * despite having burned both. Cost accounting must survive the failure that
 * caused it, so the accumulators attach what they had to the error.
 */
export interface PartialUsage {
  tokens: TokenUsage
  /** Undefined when at least one call did not report an authoritative cost. */
  costUsd?: number
  /** LLM calls issued before the abort, and how many reported a cost. */
  llmCalls: number
  llmCallsWithCost: number
}

/**
 * Non-enumerable so the payload never leaks into `JSON.stringify(err)` or a
 * stderr dump, and `Symbol.for` so it survives module duplication.
 */
const PARTIAL_USAGE_KEY = Symbol.for("skvm.partialUsage")

/** Attach spend-so-far to an in-flight error. Returns the same error for `throw attach(...)`. */
export function attachPartialUsage<E>(err: E, usage: PartialUsage): E {
  if (err !== null && typeof err === "object") {
    Object.defineProperty(err, PARTIAL_USAGE_KEY, {
      value: usage,
      enumerable: false,
      configurable: true,
      writable: true,
    })
  }
  return err
}

/** Read spend-so-far off an error, if an accumulator attached any. */
export function readPartialUsage(err: unknown): PartialUsage | undefined {
  if (err !== null && typeof err === "object" && PARTIAL_USAGE_KEY in err) {
    return (err as Record<symbol, PartialUsage>)[PARTIAL_USAGE_KEY]
  }
  return undefined
}
