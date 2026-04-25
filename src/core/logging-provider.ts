import type { LLMProvider, LLMResponse, CompletionParams, LLMToolResult } from "../providers/types.ts"
import type { ConversationLog } from "./conversation-logger.ts"
import { addTokenUsage, emptyTokenUsage, type TokenUsage } from "./types.ts"

/**
 * Decorator that logs every LLM request/response to a ConversationLog and
 * accumulates token usage across all responses.
 */
export class LoggingProvider implements LLMProvider {
  readonly name: string
  private _tokens: TokenUsage = emptyTokenUsage()

  constructor(
    private inner: LLMProvider,
    private log: ConversationLog,
  ) {
    this.name = inner.name
  }

  get tokens(): TokenUsage {
    return this._tokens
  }

  resetTokens(): void {
    this._tokens = emptyTokenUsage()
  }

  async complete(params: CompletionParams): Promise<LLMResponse> {
    this.log.logRequest(params, "complete")
    const response = await this.inner.complete(params)
    this.log.logResponse(response)
    this._tokens = addTokenUsage(this._tokens, response.tokens)
    return response
  }

  async completeWithToolResults(
    params: CompletionParams,
    toolResults: LLMToolResult[],
    previousResponse: LLMResponse,
  ): Promise<LLMResponse> {
    this.log.logRequest(params, "completeWithToolResults", toolResults)
    const response = await this.inner.completeWithToolResults(params, toolResults, previousResponse)
    this.log.logResponse(response)
    this._tokens = addTokenUsage(this._tokens, response.tokens)
    return response
  }
}
