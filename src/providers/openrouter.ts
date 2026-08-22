import type { LLMProvider, LLMResponse, LLMToolCall, CompletionParams, LLMToolResult, LLMMessage, ToolChoice } from "./types.ts"
import type { TokenUsage } from "../core/types.ts"
import {
  ProviderHttpError,
  ProviderNetworkError,
  ProviderAuthError,
  ToolArgumentsParseError,
  RETRYABLE_HTTP_STATUS,
  looksLikeNetworkError,
} from "./errors.ts"

const OPENROUTER_BASE = "https://openrouter.ai/api/v1"
const PROVIDER_NAME = "openrouter"

interface OpenRouterMessage {
  role: string
  content: string | Array<{ type: string; tool_call_id?: string; [key: string]: unknown }>
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
}

/**
 * Pin the serving backend.
 *
 * OpenRouter routes a model id to whichever upstream fleet it likes, and it re-routes between
 * sessions. Two runs of the same skill on the same model can therefore land on different
 * backends — we measured a session pair where prompt-cache hit rate went 0% -> 75% and mean call
 * latency 1.8s -> 3.1s, with per-task scores moving up to 58 points on byte-identical inputs.
 * A benchmark that re-runs weeks later is then comparing serving paths, not skills.
 *
 * Set SKVM_OPENROUTER_PROVIDER (comma-separated, e.g. "deepinfra,nebius") to pin the order and
 * disable fallbacks. Unset = OpenRouter's default routing (and non-reproducible serving).
 *
 * Two things to know before setting it:
 *
 * - `order` takes lowercase provider SLUGS, not the display name that comes back as
 *   `servingProvider` ("Nebius AI Studio" is the slug `nebius`). Entries are lowercased here;
 *   anything beyond case still has to be the slug.
 * - The pin is PROCESS-WIDE, while slugs are per-model. One `skvm bench` process can drive several
 *   model ids — `--model=a,b,c`, plus `--judge-model`, plus optimizer and task-generation calls —
 *   and they all go through this provider. A fleet that serves the target model but not the judge
 *   turns every judge call into a hard failure, because allow_fallbacks is off. Pin only when every
 *   model in the process is served by the listed fleets.
 */
function providerRouting(): Record<string, unknown> | undefined {
  const order = process.env.SKVM_OPENROUTER_PROVIDER
    ?.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (!order?.length) return undefined
  return { order, allow_fallbacks: false }
}

function toOpenAIToolChoice(tc: ToolChoice | undefined): unknown | undefined {
  if (!tc) return undefined
  if (tc === "auto") return "auto"
  if (tc === "required") return "required"
  return { type: "function", function: { name: tc.name } }
}

export class OpenRouterProvider implements LLMProvider {
  readonly name = "openrouter"
  private apiKey: string
  private model: string

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    this.apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? ""
    this.model = opts.model ?? "qwen/qwen3-30b"
  }

  async complete(params: CompletionParams): Promise<LLMResponse> {
    const messages = this.buildMessages(params)
    const tools = params.tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }))

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: params.maxTokens ?? 16384,
      temperature: params.temperature ?? 0,
      // Ask OpenRouter to include authoritative billed cost and cache breakdown
      // in the response so we don't have to estimate from a pricing table that
      // gets stale and can't account for prompt caching.
      usage: { include: true },
    }
    const routing = providerRouting()
    if (routing) body.provider = routing
    if (!this.requiresReasoning()) body.reasoning = { effort: "none" }
    if (tools?.length) body.tools = tools
    const toolChoice = toOpenAIToolChoice(params.toolChoice)
    if (toolChoice !== undefined) body.tool_choice = toolChoice
    if (params.stopSequences?.length) body.stop = params.stopSequences

    return this.doRequest(body)
  }

  async completeWithToolResults(
    params: CompletionParams,
    toolResults: LLMToolResult[],
    previousResponse: LLMResponse,
  ): Promise<LLMResponse> {
    const messages = this.buildMessages(params)

    // Add assistant response with tool calls
    const assistantMsg: OpenRouterMessage = {
      role: "assistant",
      content: previousResponse.text || "",
      tool_calls: previousResponse.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      })),
    }
    messages.push(assistantMsg)

    // Add tool results
    for (const tr of toolResults) {
      messages.push({
        role: "tool",
        content: tr.content,
        tool_call_id: tr.toolCallId,
      } as OpenRouterMessage)
    }

    const tools = params.tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }))

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: params.maxTokens ?? 16384,
      temperature: params.temperature ?? 0,
      usage: { include: true },
    }
    const routing = providerRouting()
    if (routing) body.provider = routing
    if (!this.requiresReasoning()) body.reasoning = { effort: "none" }
    if (tools?.length) body.tools = tools
    const toolChoice = toOpenAIToolChoice(params.toolChoice)
    if (toolChoice !== undefined) body.tool_choice = toolChoice

    return this.doRequest(body)
  }

  /** Models that require reasoning and reject `reasoning: { effort: "none" }` */
  private requiresReasoning(): boolean {
    return this.model.includes("minimax")
  }

  private buildMessages(params: CompletionParams): OpenRouterMessage[] {
    const messages: OpenRouterMessage[] = []
    if (params.system) {
      messages.push({ role: "system", content: params.system })
    }
    for (const m of params.messages) {
      if (m.role === "system") continue
      messages.push({ role: m.role, content: m.content })
    }
    return messages
  }

  private async doRequest(body: Record<string, unknown>): Promise<LLMResponse> {
    const maxRetries = 3
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const startMs = performance.now()
      let res: Response
      try {
        res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            "HTTP-Referer": "https://github.com/skvm",
            "X-Title": "SkVM",
          },
          body: JSON.stringify(body),
        })
      } catch (error) {
        const canRetry = attempt < maxRetries && looksLikeNetworkError(error)
        if (canRetry) {
          await Bun.sleep(this.getRetryDelayMs(attempt))
          continue
        }
        throw new ProviderNetworkError(
          `OpenRouter network error: ${error instanceof Error ? error.message : String(error)}`,
          PROVIDER_NAME,
          error,
        )
      }

      if (res.ok) {
        const data = await res.json() as Record<string, unknown>
        const durationMs = performance.now() - startMs
        return this.parseResponse(data, durationMs)
      }

      if (RETRYABLE_HTTP_STATUS.has(res.status) && attempt < maxRetries) {
        const delayMs = this.getRetryDelayMs(attempt, res.headers.get("retry-after"))
        await Bun.sleep(delayMs)
        continue
      }

      const errText = await res.text()
      if (res.status === 401 || res.status === 403) {
        throw new ProviderAuthError(
          `OpenRouter authentication failed (${res.status}): ${errText.slice(0, 500)}`,
          PROVIDER_NAME,
        )
      }
      // A pinned fleet that is down, misspelled, or does not serve this model fails exactly like a
      // real OpenRouter incident. Say which, or the user re-runs against the same dead pin — and
      // 429 is retryable, so they wait through the backoff first.
      const pin = process.env.SKVM_OPENROUTER_PROVIDER
      const pinHint = pin && (res.status === 404 || res.status === 429)
        ? ` (SKVM_OPENROUTER_PROVIDER="${pin}" pins routing with allow_fallbacks:false — unset it to let OpenRouter route)`
        : ""
      throw new ProviderHttpError(
        `OpenRouter API error ${res.status}: ${errText.slice(0, 500)}${pinHint}`,
        PROVIDER_NAME,
        res.status,
        errText,
      )
    }
    throw new Error("Unreachable")
  }

  private getRetryDelayMs(attempt: number, retryAfterHeader?: string | null): number {
    const retryAfterMs = this.parseRetryAfterMs(retryAfterHeader)
    if (retryAfterMs !== null) return retryAfterMs

    const baseDelayMs = Math.min(1000 * 2 ** attempt, 30_000)
    const jitterMs = Math.floor(Math.random() * 250)
    return baseDelayMs + jitterMs
  }

  private parseRetryAfterMs(header?: string | null): number | null {
    if (!header) return null
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 60_000)
    }

    const when = Date.parse(header)
    if (!Number.isFinite(when)) return null
    const deltaMs = when - Date.now()
    if (deltaMs <= 0) return 0
    return Math.min(deltaMs, 60_000)
  }

  private parseResponse(data: Record<string, unknown>, durationMs: number): LLMResponse {
    const choices = data.choices as Array<Record<string, unknown>>
    const choice = choices?.[0]
    const message = choice?.message as Record<string, unknown> | undefined

    const text = (message?.content as string) ?? ""
    const toolCalls: LLMToolCall[] = []

    const rawToolCalls = message?.tool_calls as Array<{
      id: string
      function: { name: string; arguments: string }
    }> | undefined

    if (rawToolCalls) {
      for (const tc of rawToolCalls) {
        let args: Record<string, unknown>
        try {
          args = JSON.parse(tc.function.arguments)
        } catch (parseErr) {
          throw new ToolArgumentsParseError(this.name, tc.function.arguments, parseErr)
        }
        toolCalls.push({ id: tc.id, name: tc.function.name, arguments: args })
      }
    }

    // OpenRouter returns prompt_tokens as the TOTAL prompt (including any
    // cached portion). prompt_tokens_details.cached_tokens breaks out the
    // cached portion, so the fresh input is the difference.
    const usage = data.usage as
      | (Record<string, number> & {
          prompt_tokens_details?: { cached_tokens?: number }
          cost?: number
        })
      | undefined
    const promptTotal = usage?.prompt_tokens ?? 0
    const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0
    const tokens: TokenUsage = {
      input: Math.max(0, promptTotal - cachedTokens),
      output: usage?.completion_tokens ?? 0,
      cacheRead: cachedTokens,
      cacheWrite: 0,
    }
    // usage.cost is authoritative — present when the request body included
    // `usage: { include: true }`. Prefer it over local pricing-table estimates.
    const costUsd = typeof usage?.cost === "number" ? usage.cost : undefined

    // Which upstream fleet actually served this call. Recorded so a run's serving backend is
    // diagnosable after the fact rather than inferred from cache-hit rates (see providerRouting).
    // `provider` is not in OpenRouter's published response schema but is present on non-streaming
    // responses; absent or renamed simply yields undefined.
    const servingProvider = typeof data.provider === "string" ? data.provider : undefined

    const finishReason = (choice?.finish_reason as string) ?? "stop"
    const stopReason = finishReason === "tool_calls"
      ? "tool_use" as const
      : finishReason === "length"
        ? "max_tokens" as const
        : "end_turn" as const

    return { text, toolCalls, tokens, costUsd, durationMs, stopReason, servingProvider }
  }
}
