import type { TokenUsage } from "../core/types.ts"

/** Message format for LLM conversations */
export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string
  /**
   * Tool calls this assistant turn made. Load-bearing for conversation history:
   * without it, a tool-call turn has to be flattened into prose, and whatever prose
   * we invent becomes a pattern the model imitates. Emitting a placeholder like
   * `[Called: write_file]` taught models to reply with that literal string as *text*
   * and no tool call — which the agent loop reads as "task finished", so the run ends
   * with the final tool call never made. Providers serialize this as a real
   * assistant tool-call turn instead.
   */
  toolCalls?: LLMToolCall[]
  /** For `role: "tool"` — which call this result answers. */
  toolCallId?: string
  /**
   * Thinking-mode chain-of-thought belonging to THIS assistant turn's tool calls.
   *
   * Deepseek rejects a request (400, "reasoning_content in the thinking mode must be passed back")
   * when an assistant turn carries tool_calls without it. Before history was structural that could
   * only ever apply to the most recent turn, so providers echoed it from `previousResponse`; now
   * that older turns keep their tool_calls, each one has to carry its own.
   */
  reasoningContent?: string
}

/** Tool definition for function calling */
export interface LLMTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** A tool call requested by the LLM */
export interface LLMToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/** Tool result to feed back to the LLM */
export interface LLMToolResult {
  toolCallId: string
  content: string
  isError?: boolean
}

/** Response from an LLM completion */
export interface LLMResponse {
  text: string
  toolCalls: LLMToolCall[]
  tokens: TokenUsage
  /**
   * Authoritative cost in USD as reported by the provider's billing, when
   * available (e.g. OpenRouter's `usage.cost` when `usage: { include: true }`
   * is set on the request). When undefined, callers should fall back to
   * `estimateCost(model, tokens)` using the local pricing table.
   */
  costUsd?: number
  durationMs: number
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence"
  /**
   * Reasoning trace returned alongside `text` by thinking-mode models
   * (deepseek-v4, deepseek-reasoner, …). Per deepseek's contract, this must be
   * echoed back in the assistant message of the NEXT request whenever the
   * response also produced tool_calls — otherwise the API rejects subsequent
   * turns with `reasoning_content in the thinking mode must be passed back`.
   * Carries through `completeWithToolResults` only; not needed when the
   * previous turn had no tool_calls.
   */
  reasoningContent?: string
}

/**
 * Tool selection strategy when `tools` is provided.
 *
 * - `"auto"` — model chooses whether/which tool to call (provider default).
 * - `"required"` — model must call SOME tool from the list.
 * - `{ name }` — model must call the named tool (used for structured-output
 *   extraction so the response shape is guaranteed).
 *
 * Maps to Anthropic's `tool_choice: {type: "auto"|"any"|"tool", name?}` and
 * OpenAI/OpenRouter's `tool_choice: "auto"|"required"|{type: "function", ...}`.
 */
export type ToolChoice = "auto" | "required" | { name: string }

/** Configuration for a completion request */
export interface CompletionParams {
  messages: LLMMessage[]
  system?: string
  tools?: LLMTool[]
  toolChoice?: ToolChoice
  maxTokens?: number
  temperature?: number
  stopSequences?: string[]
}

/**
 * Pluggable LLM provider interface.
 *
 * Note: there is intentionally no static `supportsToolUse` flag. Whether a
 * particular (provider × model) combo can honor a tool_use request is a
 * runtime fact, not a static capability — `extractStructured` discovers it
 * empirically by trying tool_use first and falling back to prompt+parse on
 * failure. Providers should always accept a `tools` parameter and pass it
 * through; if the underlying model ignores tools and returns prose, the
 * caller will catch the missing tool_call and adapt.
 */
export interface LLMProvider {
  readonly name: string

  /** Send a completion request */
  complete(params: CompletionParams): Promise<LLMResponse>

  /** Send a multi-turn conversation with tool results */
  completeWithToolResults(
    params: CompletionParams,
    toolResults: LLMToolResult[],
    previousResponse: LLMResponse,
  ): Promise<LLMResponse>
}
