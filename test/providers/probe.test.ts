import { test, expect, describe } from "bun:test"
import { classifyArguments, inferAnthropicBaseUrl, runProbe } from "../../src/providers/probe.ts"
import type { LLMProvider, LLMResponse, CompletionParams } from "../../src/providers/types.ts"
import { ToolArgumentsParseError } from "../../src/providers/errors.ts"

describe("classifyArguments", () => {
  const expected = { name: "probe", score: 42 }

  test("clean: exact JSON match", () => {
    expect(classifyArguments('{"name":"probe","score":42}', expected)).toBe("clean")
  })
  test("clean: whitespace and escaping variations", () => {
    expect(classifyArguments('{"name": "probe", "score": 42}', expected)).toBe("clean")
  })
  test("polluted: <think> prefix", () => {
    expect(classifyArguments('<think>x</think>{"name":"probe","score":42}', expected)).toBe("polluted")
  })
  test("polluted: lone </think> token", () => {
    expect(classifyArguments("用户思考...</think>{}", expected)).toBe("polluted")
  })
  test("polluted: ACHI marker", () => {
    expect(classifyArguments("ACHI mid ACHI{}", expected)).toBe("polluted")
  })
  test("polluted: GLM private tool_call XML", () => {
    expect(classifyArguments("<tool_call>extract<arg_key>name</arg_key><arg_value>probe</arg_value></tool_call>", expected)).toBe("polluted")
  })
  test("polluted: parse succeeds but values mismatch", () => {
    expect(classifyArguments('{"name":"other","score":42}', expected)).toBe("polluted")
  })
  test("polluted: parse succeeds but missing key", () => {
    expect(classifyArguments('{"name":"probe"}', expected)).toBe("polluted")
  })
})

describe("inferAnthropicBaseUrl", () => {
  test("strips trailing /v1", () => {
    expect(inferAnthropicBaseUrl("https://svip.xty.app/v1")).toBe("https://svip.xty.app")
  })
  test("strips trailing /v1/", () => {
    expect(inferAnthropicBaseUrl("https://svip.xty.app/v1/")).toBe("https://svip.xty.app")
  })
  test("returns unchanged when no /v1 suffix", () => {
    expect(inferAnthropicBaseUrl("https://api.example.com")).toBe("https://api.example.com")
  })
  test("returns null on invalid input", () => {
    expect(inferAnthropicBaseUrl("")).toBe(null)
    expect(inferAnthropicBaseUrl("not-a-url")).toBe(null)
  })
})

function fakeProvider(name: string, behavior: (p: CompletionParams) => Promise<LLMResponse> | LLMResponse): LLMProvider {
  return {
    name,
    complete: async (p: CompletionParams) => behavior(p),
  } as LLMProvider
}

describe("runProbe", () => {
  test("clean primary: returns verdict=clean, no alt invoked", async () => {
    let altInvoked = false
    const primary = fakeProvider("p", () => ({
      text: "",
      toolCalls: [{ id: "1", name: "extract_probe", arguments: { name: "probe", score: 42 } }],
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      durationMs: 0,
      stopReason: "tool_use",
    }))
    const alt = fakeProvider("alt", () => { altInvoked = true; throw new Error("should not be called") })
    const verdict = await runProbe({ primary, alt: () => alt })
    expect(verdict.primary).toBe("clean")
    expect(verdict.alt).toBeUndefined()
    expect(altInvoked).toBe(false)
  })

  test("polluted primary + clean alt: returns both verdicts", async () => {
    const primary = fakeProvider("p", () => { throw new ToolArgumentsParseError("p", "<think>x</think>{}") })
    const alt = fakeProvider("a", () => ({
      text: "",
      toolCalls: [{ id: "1", name: "extract_probe", arguments: { name: "probe", score: 42 } }],
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      durationMs: 0,
      stopReason: "tool_use",
    }))
    const verdict = await runProbe({ primary, alt: () => alt })
    expect(verdict.primary).toBe("polluted")
    expect(verdict.alt).toBe("clean")
  })

  test("polluted primary + polluted alt: returns both verdicts polluted", async () => {
    const primary = fakeProvider("p", () => { throw new ToolArgumentsParseError("p", "<think>") })
    const alt = fakeProvider("a", () => { throw new ToolArgumentsParseError("a", "ACHI") })
    const verdict = await runProbe({ primary, alt: () => alt })
    expect(verdict.primary).toBe("polluted")
    expect(verdict.alt).toBe("polluted")
  })

  test("network error on primary returns verdict=indeterminate", async () => {
    const primary = fakeProvider("p", () => { throw new Error("ECONNRESET") })
    const verdict = await runProbe({ primary, alt: () => fakeProvider("a", () => ({} as LLMResponse)) })
    expect(verdict.primary).toBe("indeterminate")
    expect(verdict.alt).toBeUndefined()
  })

  test("polluted primary + alt throws non-parse error: alt verdict=indeterminate", async () => {
    const primary = fakeProvider("p", () => { throw new ToolArgumentsParseError("p", "<think>") })
    const alt = fakeProvider("a", () => { throw new Error("404") })
    const verdict = await runProbe({ primary, alt: () => alt })
    expect(verdict.primary).toBe("polluted")
    expect(verdict.alt).toBe("indeterminate")
  })
})
