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

// ---------------------------------------------------------------------------
// Serving-backend pinning
// ---------------------------------------------------------------------------

const TEXT_REPLY = {
  id: "or-text",
  object: "chat.completion",
  provider: "DeepInfra",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
}

describe("OpenRouterProvider serving-backend pinning", () => {
  const realPin = process.env.SKVM_OPENROUTER_PROVIDER

  afterEach(() => {
    if (realPin === undefined) delete process.env.SKVM_OPENROUTER_PROVIDER
    else process.env.SKVM_OPENROUTER_PROVIDER = realPin
  })

  test("SKVM_OPENROUTER_PROVIDER pins provider.order and disables fallbacks", async () => {
    process.env.SKVM_OPENROUTER_PROVIDER = "deepinfra, nebius"
    stubFetch(TEXT_REPLY)

    const provider = new OpenRouterProvider({ apiKey: "fake", model: "qwen/qwen3-30b" })
    await provider.complete({ messages: [{ role: "user", content: "hi" }] })

    const body = JSON.parse(lastRequest!.init.body as string)
    expect(body.provider).toEqual({ order: ["deepinfra", "nebius"], allow_fallbacks: false })
  })

  test("the pin also reaches completeWithToolResults", async () => {
    // The tool-result continuation builds its own body; without its own test the pin can be
    // dropped there by a refactor and every tool-using turn silently re-routes.
    process.env.SKVM_OPENROUTER_PROVIDER = "deepinfra"
    stubFetch(TEXT_REPLY)

    const provider = new OpenRouterProvider({ apiKey: "fake", model: "qwen/qwen3-30b" })
    await provider.completeWithToolResults(
      { messages: [{ role: "user", content: "hi" }] },
      [{ toolCallId: "call_1", content: "ok" }],
      { text: "", toolCalls: [{ id: "call_1", name: "bash", arguments: {} }],
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, durationMs: 1, stopReason: "tool_use" },
    )

    const body = JSON.parse(lastRequest!.init.body as string)
    expect(body.provider).toEqual({ order: ["deepinfra"], allow_fallbacks: false })
  })

  test("slugs are lowercased; blank entries are dropped", async () => {
    // `order` takes slugs, but the value a user reads off a run is a display name.
    process.env.SKVM_OPENROUTER_PROVIDER = " DeepInfra , , Nebius "
    stubFetch(TEXT_REPLY)

    const provider = new OpenRouterProvider({ apiKey: "fake", model: "qwen/qwen3-30b" })
    await provider.complete({ messages: [{ role: "user", content: "hi" }] })

    const body = JSON.parse(lastRequest!.init.body as string)
    expect(body.provider).toEqual({ order: ["deepinfra", "nebius"], allow_fallbacks: false })
  })

  test("a whitespace-only value is not a pin", async () => {
    process.env.SKVM_OPENROUTER_PROVIDER = " , , "
    stubFetch(TEXT_REPLY)

    const provider = new OpenRouterProvider({ apiKey: "fake", model: "qwen/qwen3-30b" })
    await provider.complete({ messages: [{ role: "user", content: "hi" }] })

    expect(JSON.parse(lastRequest!.init.body as string).provider).toBeUndefined()
  })

  test("a failure under an active pin says the pin is why", async () => {
    process.env.SKVM_OPENROUTER_PROVIDER = "deepinfra"
    stubFetch("no endpoints found matching your data policy", 404)

    const provider = new OpenRouterProvider({ apiKey: "fake", model: "qwen/qwen3-30b" })
    await expect(
      provider.complete({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/SKVM_OPENROUTER_PROVIDER="deepinfra"/)
  })

  test("without a pin the error text is unchanged", async () => {
    delete process.env.SKVM_OPENROUTER_PROVIDER
    stubFetch("no endpoints found", 404)

    const provider = new OpenRouterProvider({ apiKey: "fake", model: "qwen/qwen3-30b" })
    await expect(
      provider.complete({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/^OpenRouter API error 404: no endpoints found$/)
  })

  test("unset leaves routing to OpenRouter", async () => {
    delete process.env.SKVM_OPENROUTER_PROVIDER
    stubFetch(TEXT_REPLY)

    const provider = new OpenRouterProvider({ apiKey: "fake", model: "qwen/qwen3-30b" })
    await provider.complete({ messages: [{ role: "user", content: "hi" }] })

    const body = JSON.parse(lastRequest!.init.body as string)
    expect(body.provider).toBeUndefined()
  })

  test("the serving fleet is recorded on the response", async () => {
    delete process.env.SKVM_OPENROUTER_PROVIDER
    stubFetch(TEXT_REPLY)

    const provider = new OpenRouterProvider({ apiKey: "fake", model: "qwen/qwen3-30b" })
    const res = await provider.complete({ messages: [{ role: "user", content: "hi" }] })

    expect(res.servingProvider).toBe("DeepInfra")
  })

  test("a response without a provider field leaves servingProvider undefined", async () => {
    delete process.env.SKVM_OPENROUTER_PROVIDER
    const { provider: _dropped, ...noProvider } = TEXT_REPLY
    stubFetch(noProvider)

    const provider = new OpenRouterProvider({ apiKey: "fake", model: "qwen/qwen3-30b" })
    const res = await provider.complete({ messages: [{ role: "user", content: "hi" }] })

    expect(res.servingProvider).toBeUndefined()
  })
})
