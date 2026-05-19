import { test, expect, describe } from "bun:test"
import {
  ProviderError,
  ProviderHttpError,
  ProviderNetworkError,
  ProviderAuthError,
  isProviderError,
  isToolChoiceUnsupportedError,
  isRetryableStatus,
  looksLikeNetworkError,
  ToolArgumentsParseError,
  isToolArgumentsParseError,
} from "../../src/providers/errors.ts"

describe("ProviderError classification", () => {
  test("ProviderAuthError is non-retryable", () => {
    const e = new ProviderAuthError("bad key", "openrouter")
    expect(e.retryable).toBe(false)
    expect(isProviderError(e)).toBe(true)
    expect(e.provider).toBe("openrouter")
  })

  test("ProviderNetworkError is retryable", () => {
    const e = new ProviderNetworkError("socket closed", "openai")
    expect(e.retryable).toBe(true)
    expect(isProviderError(e)).toBe(true)
  })

  test("ProviderHttpError 429 is retryable", () => {
    const e = new ProviderHttpError("rate limit", "openrouter", 429, "too many")
    expect(e.retryable).toBe(true)
    expect(e.status).toBe(429)
  })

  test("ProviderHttpError 404 is non-retryable", () => {
    const e = new ProviderHttpError("not found", "openrouter", 404)
    expect(e.retryable).toBe(false)
  })

  test("isProviderError is false for plain Error", () => {
    expect(isProviderError(new Error("generic"))).toBe(false)
    expect(isProviderError("string")).toBe(false)
    expect(isProviderError(undefined)).toBe(false)
  })
})

describe("isToolChoiceUnsupportedError", () => {
  test("matches a 400 mentioning tool_choice (DeepSeek phrasing)", () => {
    const e = new ProviderHttpError(
      "openai-compatible(api.deepseek.com) API error 400: deepseek-reasoner does not support this tool_choice",
      "openai-compatible",
      400,
    )
    expect(isToolChoiceUnsupportedError(e)).toBe(true)
  })

  test("matches a 400 mentioning tool_choice (DashScope/thinking-mode phrasing)", () => {
    const e = new ProviderHttpError(
      "Anthropic API error 400: The tool_choice parameter does not support being set to required or object in thinking mode",
      "anthropic",
      400,
    )
    expect(isToolChoiceUnsupportedError(e)).toBe(true)
  })

  test("rejects non-400 HTTP errors even if they mention tool_choice", () => {
    expect(isToolChoiceUnsupportedError(new ProviderHttpError("502 tool_choice gateway weirdness", "x", 502))).toBe(false)
  })

  test("rejects a 400 that does not mention tool_choice", () => {
    expect(isToolChoiceUnsupportedError(new ProviderHttpError("400 invalid request: bad max_tokens", "x", 400))).toBe(false)
  })

  test("rejects non-HTTP provider errors and plain values", () => {
    expect(isToolChoiceUnsupportedError(new ProviderAuthError("401 tool_choice", "x"))).toBe(false)
    expect(isToolChoiceUnsupportedError(new Error("tool_choice 400"))).toBe(false)
    expect(isToolChoiceUnsupportedError("tool_choice")).toBe(false)
    expect(isToolChoiceUnsupportedError(undefined)).toBe(false)
  })
})

describe("isRetryableStatus", () => {
  test("5xx status codes retry", () => {
    expect(isRetryableStatus(500)).toBe(true)
    expect(isRetryableStatus(502)).toBe(true)
    expect(isRetryableStatus(503)).toBe(true)
    expect(isRetryableStatus(504)).toBe(true)
  })

  test("429 retries", () => {
    expect(isRetryableStatus(429)).toBe(true)
  })

  test("4xx client errors don't retry", () => {
    expect(isRetryableStatus(400)).toBe(false)
    expect(isRetryableStatus(401)).toBe(false)
    expect(isRetryableStatus(403)).toBe(false)
    expect(isRetryableStatus(404)).toBe(false)
  })
})

describe("looksLikeNetworkError", () => {
  test("matches fetch-failed variants", () => {
    expect(looksLikeNetworkError(new Error("fetch failed"))).toBe(true)
    expect(looksLikeNetworkError(new Error("ECONNRESET"))).toBe(true)
    expect(looksLikeNetworkError(new Error("socket hang up"))).toBe(true)
  })

  test("rejects non-network errors", () => {
    expect(looksLikeNetworkError(new Error("JSON parse error"))).toBe(false)
    expect(looksLikeNetworkError("not an error")).toBe(false)
  })
})

describe("ToolArgumentsParseError", () => {
  test("ToolArgumentsParseError carries raw arguments and is a ProviderError", () => {
    const err = new ToolArgumentsParseError(
      "openai-compatible(test)",
      "<think>x</think>{bad",
      new SyntaxError("Unrecognized token '<'"),
    )
    expect(err.name).toBe("ToolArgumentsParseError")
    expect(err.rawArguments).toBe("<think>x</think>{bad")
    expect(err.cause).toBeInstanceOf(SyntaxError)
    expect(isToolArgumentsParseError(err)).toBe(true)
    expect(isProviderError(err)).toBe(true)
    expect(err.retryable).toBe(false)
  })

  test("isToolArgumentsParseError narrows non-matching errors", () => {
    expect(isToolArgumentsParseError(new Error("other"))).toBe(false)
    expect(isToolArgumentsParseError(undefined)).toBe(false)
    expect(isToolArgumentsParseError(null)).toBe(false)
  })
})
