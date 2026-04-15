import Anthropic from "@anthropic-ai/sdk"
import type { LLMProvider, LLMResponse, LLMToolCall, CompletionParams, LLMToolResult, LLMMessage, ToolChoice } from "./types.ts"
import type { TokenUsage } from "../core/types.ts"
import { emptyTokenUsage } from "../core/types.ts"
import {
  ProviderError,
  ProviderHttpError,
  ProviderNetworkError,
  ProviderAuthError,
} from "./errors.ts"

const PROVIDER_NAME = "anthropic"

function toAnthropicToolChoice(tc: ToolChoice | undefined): Anthropic.MessageCreateParams["tool_choice"] {
  if (!tc) return undefined
  if (tc === "auto") return { type: "auto" }
  if (tc === "required") return { type: "any" }
  return { type: "tool", name: tc.name }
}

/**
 * Rewrap errors thrown by the Anthropic SDK as typed ProviderError subclasses.
 * The SDK has already retried internally (default maxRetries) before raising,
 * so every error that reaches us is terminal from the SDK's perspective.
 *
 * Duck-types on `status` rather than importing SDK error classes, since the
 * SDK's error exports are versioned.
 */
function wrapAnthropicError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err
  const anyErr = err as { status?: unknown; message?: unknown; name?: unknown }
  const message = typeof anyErr.message === "string" ? anyErr.message : String(err)
  const name = typeof anyErr.name === "string" ? anyErr.name : ""
  const status = typeof anyErr.status === "number" ? anyErr.status : undefined

  if (status === 401 || status === 403) {
    return new ProviderAuthError(
      `Anthropic authentication failed (${status}): ${message.slice(0, 500)}`,
      PROVIDER_NAME,
      err,
    )
  }
  if (status !== undefined) {
    return new ProviderHttpError(
      `Anthropic API error ${status}: ${message.slice(0, 500)}`,
      PROVIDER_NAME,
      status,
      message,
      err,
    )
  }
  // No status → connection / DNS / timeout / abort.
  if (name === "APIConnectionError" || name === "APIConnectionTimeoutError" || /network|timeout|econnreset|enotfound|socket/i.test(message)) {
    return new ProviderNetworkError(
      `Anthropic network error: ${message.slice(0, 500)}`,
      PROVIDER_NAME,
      err,
    )
  }
  // Fallthrough: unknown shape, still mark as infra-origin so callers see
  // it as ProviderError and don't mask it as a content failure.
  return new ProviderError(
    `Anthropic error: ${message.slice(0, 500)}`,
    PROVIDER_NAME,
    err,
    false,
  )
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic"
  private client: Anthropic
  private model: string

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    this.client = new Anthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY })
    this.model = opts.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4.6"
  }

  async complete(params: CompletionParams): Promise<LLMResponse> {
    const messages = this.toAnthropicMessages(params.messages)

    const tools = params.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }))

    const startMs = performance.now()
    let response: Anthropic.Message
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: params.maxTokens ?? 16384,
        temperature: params.temperature,
        system: params.system,
        messages,
        tools,
        tool_choice: toAnthropicToolChoice(params.toolChoice),
        stop_sequences: params.stopSequences,
      })
    } catch (err) {
      throw wrapAnthropicError(err)
    }
    const durationMs = performance.now() - startMs

    return this.parseResponse(response, durationMs)
  }

  async completeWithToolResults(
    params: CompletionParams,
    toolResults: LLMToolResult[],
    previousResponse: LLMResponse,
  ): Promise<LLMResponse> {
    const messages = this.toAnthropicMessages(params.messages)

    // Add the assistant's previous response with tool_use blocks
    const assistantContent: Anthropic.ContentBlockParam[] = []
    if (previousResponse.text) {
      assistantContent.push({ type: "text", text: previousResponse.text })
    }
    for (const tc of previousResponse.toolCalls) {
      assistantContent.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: tc.arguments,
      })
    }
    messages.push({ role: "assistant", content: assistantContent })

    // Add tool results
    const toolResultContent: Anthropic.ToolResultBlockParam[] = toolResults.map((tr) => ({
      type: "tool_result" as const,
      tool_use_id: tr.toolCallId,
      content: tr.content,
      is_error: tr.isError,
    }))
    messages.push({ role: "user", content: toolResultContent })

    const tools = params.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }))

    const startMs = performance.now()
    let response: Anthropic.Message
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: params.maxTokens ?? 16384,
        temperature: params.temperature,
        system: params.system,
        messages,
        tools,
        tool_choice: toAnthropicToolChoice(params.toolChoice),
        stop_sequences: params.stopSequences,
      })
    } catch (err) {
      throw wrapAnthropicError(err)
    }
    const durationMs = performance.now() - startMs

    return this.parseResponse(response, durationMs)
  }

  private toAnthropicMessages(messages: LLMMessage[]): Anthropic.MessageParam[] {
    return messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }))
  }

  private parseResponse(response: Anthropic.Message, durationMs: number): LLMResponse {
    let text = ""
    const toolCalls: LLMToolCall[] = []

    for (const block of response.content) {
      if (block.type === "text") {
        text += block.text
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        })
      }
    }

    const tokens: TokenUsage = {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
      cacheRead: (response.usage as unknown as Record<string, number>).cache_read_input_tokens ?? 0,
      cacheWrite: (response.usage as unknown as Record<string, number>).cache_creation_input_tokens ?? 0,
    }

    const stopReason = response.stop_reason === "tool_use"
      ? "tool_use" as const
      : response.stop_reason === "max_tokens"
        ? "max_tokens" as const
        : "end_turn" as const

    return { text, toolCalls, tokens, durationMs, stopReason }
  }
}
