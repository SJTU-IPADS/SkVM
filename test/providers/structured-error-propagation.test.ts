import { test, expect, describe } from "bun:test"
import { z } from "zod"
import { extractStructured } from "../../src/providers/structured.ts"
import type { LLMProvider, LLMResponse, CompletionParams, LLMToolResult } from "../../src/providers/types.ts"
import {
  ProviderAuthError,
  ProviderHttpError,
  ProviderNetworkError,
} from "../../src/providers/errors.ts"

function stubResponse(): LLMResponse {
  return {
    text: "",
    toolCalls: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    durationMs: 0,
    stopReason: "end_turn",
  }
}

function throwingProvider(err: unknown): LLMProvider {
  return {
    name: "throwing",
    async complete(_params: CompletionParams): Promise<LLMResponse> {
      throw err
    },
    async completeWithToolResults(
      _params: CompletionParams,
      _toolResults: LLMToolResult[],
      _previous: LLMResponse,
    ): Promise<LLMResponse> {
      throw err
    },
  }
}

function unhelpfulProvider(): LLMProvider {
  // Returns no tool call — a legitimate "model doesn't do tools" signal.
  // Layer 1 should catch this, and Layer 2 should succeed via prompt+parse.
  let call = 0
  return {
    name: "unhelpful",
    async complete(_params: CompletionParams): Promise<LLMResponse> {
      call++
      if (call === 1) return stubResponse()  // Layer 1 — no tool call
      // Layer 2 — return valid JSON
      return { ...stubResponse(), text: '{"x": 1}' }
    },
    async completeWithToolResults(): Promise<LLMResponse> {
      throw new Error("not reached")
    },
  }
}

function thinkingModeProvider(err: ProviderHttpError): LLMProvider {
  // Mimics a thinking-mode model: rejects Layer 1's forced tool_choice with a
  // 400, but answers a plain (tool_choice-free) request — i.e. Layer 2.
  return {
    name: "thinking-mode",
    async complete(params: CompletionParams): Promise<LLMResponse> {
      if (params.toolChoice !== undefined) throw err  // Layer 1
      return { ...stubResponse(), text: '{"x": 1}' }  // Layer 2
    },
    async completeWithToolResults(): Promise<LLMResponse> {
      throw new Error("not reached")
    },
  }
}

describe("extractStructured propagates ProviderError", () => {
  const schema = z.object({ x: z.number() })
  const opts = {
    schema,
    schemaName: "test_schema",
    schemaDescription: "test",
    prompt: "irrelevant",
  }

  test("ProviderAuthError from Layer 1 bypasses Layer 2", async () => {
    const err = new ProviderAuthError("401 bad key", "openrouter")
    let thrown: unknown
    try {
      await extractStructured({ provider: throwingProvider(err), ...opts })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBe(err)  // same instance — not rewrapped
  })

  test("ProviderHttpError propagates", async () => {
    const err = new ProviderHttpError("502 bad gateway", "openrouter", 502)
    let thrown: unknown
    try {
      await extractStructured({ provider: throwingProvider(err), ...opts })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBe(err)
  })

  test("ProviderNetworkError propagates", async () => {
    const err = new ProviderNetworkError("ECONNRESET", "openrouter")
    let thrown: unknown
    try {
      await extractStructured({ provider: throwingProvider(err), ...opts })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBe(err)
  })

  test("non-provider errors still fall back to Layer 2", async () => {
    // A plain "no tool call" failure should trigger prompt+parse fallback,
    // which then succeeds. This preserves the empirical-discovery behavior
    // for models that simply don't honor tools.
    const result = await extractStructured({ provider: unhelpfulProvider(), ...opts })
    expect(result.result.x).toBe(1)
  })

  test("a 400 rejecting forced tool_choice falls back to Layer 2 (thinking-mode models)", async () => {
    const err = new ProviderHttpError(
      "openai-compatible(api.deepseek.com) API error 400: deepseek-reasoner does not support this tool_choice",
      "openai-compatible",
      400,
    )
    const result = await extractStructured({ provider: thinkingModeProvider(err), ...opts })
    expect(result.result.x).toBe(1)
  })
})
