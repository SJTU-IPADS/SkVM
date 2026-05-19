import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { OpenRouterProvider } from "../../src/providers/openrouter.ts"
import { ToolArgumentsParseError } from "../../src/providers/errors.ts"

const realFetch = globalThis.fetch
let lastRequest: { url: string; init: RequestInit } | undefined

function stubFetch(responseBody: unknown, status = 200) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    lastRequest = { url: typeof url === "string" ? url : url.toString(), init: init ?? {} }
    return new Response(
      typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody),
      { status, headers: { "Content-Type": "application/json" } },
    )
  }) as typeof fetch
}

beforeEach(() => { lastRequest = undefined })
afterEach(() => { globalThis.fetch = realFetch })

describe("OpenRouterProvider.complete", () => {
  test("throws ToolArgumentsParseError when tool_call arguments are not JSON", async () => {
    stubFetch({
      id: "or-bad",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "extract_fields",
                  arguments: "<think>x</think>{\"a\":1}",
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    })
    const provider = new OpenRouterProvider({ apiKey: "fake", model: "qwen/qwen3-30b" })

    let thrown: unknown
    try {
      await provider.complete({
        messages: [{ role: "user", content: "extract" }],
        tools: [{ name: "extract_fields", description: "", inputSchema: {} }],
      })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(ToolArgumentsParseError)
    expect((thrown as ToolArgumentsParseError).rawArguments).toBe("<think>x</think>{\"a\":1}")
  })
})
