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
      throw new ProviderHttpError(
        `OpenRouter API error ${res.status}: ${errText.slice(0, 500)}`,
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

    const finishReason = (choice?.finish_reason as string) ?? "stop"
    const stopReason = finishReason === "tool_calls"
      ? "tool_use" as const
      : finishReason === "length"
        ? "max_tokens" as const
        : "end_turn" as const

    return { text, toolCalls, tokens, costUsd, durationMs, stopReason }
  }
}
