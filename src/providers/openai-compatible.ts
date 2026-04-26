import type { LLMProvider, LLMResponse, LLMToolCall, CompletionParams, LLMToolResult, ToolChoice } from "./types.ts"
import type { TokenUsage } from "../core/types.ts"
import {
  ProviderHttpError,
  ProviderNetworkError,
  ProviderAuthError,
  RETRYABLE_HTTP_STATUS,
  looksLikeNetworkError,
} from "./errors.ts"

interface OAIMessage {
  role: string
  content: string | Array<{ type: string; tool_call_id?: string; [key: string]: unknown }>
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
  /**
   * deepseek thinking-mode chain-of-thought, echoed back on the next request
   * for the immediately previous assistant turn IFF that turn produced
   * tool_calls. Plain text turns must NOT include it (per deepseek's contract).
   */
  reasoning_content?: string
}

function toOpenAIToolChoice(tc: ToolChoice | undefined): unknown | undefined {
  if (!tc) return undefined
  if (tc === "auto") return "auto"
  if (tc === "required") return "required"
  return { type: "function", function: { name: tc.name } }
}

/**
 * Generic OpenAI Chat Completions client. Covers any endpoint that speaks the
 * `/chat/completions` dialect: OpenAI itself, Azure OpenAI (`/v1`-style),
 * vLLM, Ollama, DeepSeek, Groq, Together, Fireworks, SiliconFlow, …
 *
 * Does NOT send OpenRouter-specific fields (`usage: { include: true }`,
 * `reasoning: { effort }`) or OpenRouter tracking headers. `costUsd` on the
 * returned `LLMResponse` is always `undefined` — callers fall back to
 * `estimateCost(model, tokens)` against the local pricing table.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string
  private apiKey: string
  private model: string
  private baseUrl: string

  constructor(opts: {
    apiKey: string
    model: string
    baseUrl: string
    displayName?: string
  }) {
    this.apiKey = opts.apiKey
    this.model = opts.model
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "")
    this.name = opts.displayName ?? deriveName(opts.baseUrl)
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
    }
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

    const assistantMsg: OAIMessage = {
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
    // Deepseek thinking-mode contract: when the previous assistant turn issued
    // tool_calls, we must echo `reasoning_content` back on the next request,
    // otherwise the API returns 400 ("reasoning_content in the thinking mode
    // must be passed back to the API"). Non-thinking models simply ignore the
    // extra field, so this is safe to send unconditionally when present.
    if (previousResponse.reasoningContent && previousResponse.toolCalls.length > 0) {
      assistantMsg.reasoning_content = previousResponse.reasoningContent
    }
    messages.push(assistantMsg)

    for (const tr of toolResults) {
      messages.push({
        role: "tool",
        content: tr.content,
        tool_call_id: tr.toolCallId,
      } as OAIMessage)
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
    }
    if (tools?.length) body.tools = tools
    const toolChoice = toOpenAIToolChoice(params.toolChoice)
    if (toolChoice !== undefined) body.tool_choice = toolChoice

    return this.doRequest(body)
  }

  private buildMessages(params: CompletionParams): OAIMessage[] {
    const messages: OAIMessage[] = []
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
    const url = `${this.baseUrl}/chat/completions`
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const startMs = performance.now()
      let res: Response
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
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
          `${this.name} network error: ${error instanceof Error ? error.message : String(error)}`,
          this.name,
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
          `${this.name} authentication failed (${res.status}): ${errText.slice(0, 500)}`,
          this.name,
        )
      }
      throw new ProviderHttpError(
        `${this.name} API error ${res.status}: ${errText.slice(0, 500)}`,
        this.name,
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
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(tc.function.arguments)
        } catch {
          args = { raw: tc.function.arguments }
        }
        toolCalls.push({ id: tc.id, name: tc.function.name, arguments: args })
      }
    }

    // Cached prompt tokens: OpenAI-style APIs (OpenAI, Azure, vLLM) report
    // `prompt_tokens_details.cached_tokens` as the cached portion of the full
    // `prompt_tokens` count. Fresh input is the difference.
    const usage = data.usage as
      | (Record<string, number> & {
          prompt_tokens_details?: { cached_tokens?: number }
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

    const finishReason = (choice?.finish_reason as string) ?? "stop"
    const stopReason = finishReason === "tool_calls"
      ? "tool_use" as const
      : finishReason === "length"
        ? "max_tokens" as const
        : "end_turn" as const

    const rawReasoning = (message?.reasoning_content as string | null | undefined) ?? undefined
    const reasoningContent = typeof rawReasoning === "string" && rawReasoning.length > 0
      ? rawReasoning
      : undefined

    return { text, toolCalls, tokens, costUsd: undefined, durationMs, stopReason, reasoningContent }
  }
}

function deriveName(baseUrl: string): string {
  try {
    const { hostname } = new URL(baseUrl)
    return `openai-compatible(${hostname})`
  } catch {
    return "openai-compatible"
  }
}
