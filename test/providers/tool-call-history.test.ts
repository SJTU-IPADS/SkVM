import { test, expect, describe, afterEach } from "bun:test"
import { AnthropicProvider } from "../../src/providers/anthropic.ts"
import { OpenAICompatibleProvider } from "../../src/providers/openai-compatible.ts"
import { OpenRouterProvider } from "../../src/providers/openrouter.ts"
import type { LLMMessage } from "../../src/providers/types.ts"

const realFetch = globalThis.fetch
let observedBody: any

afterEach(() => {
  globalThis.fetch = realFetch
  observedBody = undefined
})

function stubFetch(response: unknown) {
  globalThis.fetch = (async (_input: any, init?: any) => {
    observedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch
}

/**
 * One assistant turn that called two tools, followed by both results — the shape
 * agent-loop stages into history after a tool-using iteration.
 */
const HISTORY: LLMMessage[] = [
  { role: "user", content: "build the report" },
  {
    role: "assistant",
    content: "",
    toolCalls: [
      { id: "call_1", name: "write_file", arguments: { path: "report.py" } },
      { id: "call_2", name: "execute_command", arguments: { command: "python3 report.py" } },
    ],
  },
  { role: "tool", content: "written", toolCallId: "call_1" },
  { role: "tool", content: "ran", toolCallId: "call_2" },
]

const ANTHROPIC_REPLY = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  model: "claude-sonnet-4.6",
  stop_reason: "end_turn",
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
}

const OPENAI_REPLY = {
  id: "chatcmpl-1",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
}

describe("tool-call turns survive history serialization", () => {
  test("anthropic emits tool_use blocks and merges tool results into one user turn", async () => {
    stubFetch(ANTHROPIC_REPLY)
    const provider = new AnthropicProvider({ apiKey: "fake", model: "claude-sonnet-4.6" })

    await provider.complete({ messages: HISTORY })

    const messages = observedBody.messages
    expect(messages).toHaveLength(3)
    expect(messages[0]).toEqual({ role: "user", content: "build the report" })

    // The assistant turn keeps both calls as tool_use blocks — no invented prose.
    expect(messages[1].role).toBe("assistant")
    expect(messages[1].content).toEqual([
      { type: "tool_use", id: "call_1", name: "write_file", input: { path: "report.py" } },
      { type: "tool_use", id: "call_2", name: "execute_command", input: { command: "python3 report.py" } },
    ])

    // Anthropic requires tool_result blocks on a user turn; consecutive results merge into one.
    expect(messages[2].role).toBe("user")
    expect(messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "call_1", content: "written" },
      { type: "tool_result", tool_use_id: "call_2", content: "ran" },
    ])
  })

  test("openai-compatible emits tool_calls plus role:tool results", async () => {
    stubFetch(OPENAI_REPLY)
    const provider = new OpenAICompatibleProvider({
      apiKey: "fake",
      model: "some-model",
      baseUrl: "https://gateway.example.com/v1",
    })

    await provider.complete({ messages: HISTORY })

    const messages = observedBody.messages
    const assistant = messages.find((m: any) => m.role === "assistant")
    expect(assistant.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "write_file", arguments: '{"path":"report.py"}' } },
      {
        id: "call_2",
        type: "function",
        function: { name: "execute_command", arguments: '{"command":"python3 report.py"}' },
      },
    ])
    expect(messages.filter((m: any) => m.role === "tool")).toEqual([
      { role: "tool", content: "written", tool_call_id: "call_1" },
      { role: "tool", content: "ran", tool_call_id: "call_2" },
    ])
  })

  test("openrouter emits tool_calls plus role:tool results", async () => {
    stubFetch(OPENAI_REPLY)
    const provider = new OpenRouterProvider({ apiKey: "fake", model: "qwen/qwen3-30b" })

    await provider.complete({ messages: HISTORY })

    const messages = observedBody.messages
    const assistant = messages.find((m: any) => m.role === "assistant")
    expect(assistant.tool_calls.map((tc: any) => tc.function.name)).toEqual([
      "write_file",
      "execute_command",
    ])
    expect(messages.filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id)).toEqual([
      "call_1",
      "call_2",
    ])
    // No assistant turn may carry an invented placeholder for its tool calls.
    for (const m of messages) {
      expect(String(m.content ?? "")).not.toMatch(/^\[Called:/)
    }
  })
})

// ---------------------------------------------------------------------------
// End-to-end history integrity
// ---------------------------------------------------------------------------

/**
 * The loop stages the PREVIOUS exchange in `pendingHistory` and flushes it one iteration later,
 * while `completeWithToolResults` appends the CURRENT exchange itself. Nothing but that ordering
 * keeps an exchange from being sent twice — and a duplicated `tool_use` id, or a `tool_call_id`
 * with no matching assistant call, is a hard 400 on both wire formats. Assert it on the wire.
 */
describe("history integrity across a multi-turn run", () => {
  test("openrouter: every request has matched, unique tool calls and results", async () => {
    const { runAgentLoop } = await import("../../src/core/agent-loop.ts")
    const bodies: any[] = []
    let turn = 0
    globalThis.fetch = (async (_input: any, init?: any) => {
      bodies.push(JSON.parse(init.body as string))
      turn++
      const body = turn <= 3
        ? {
            id: "or-tools", object: "chat.completion",
            choices: [{
              index: 0,
              message: {
                role: "assistant", content: "",
                tool_calls: [{
                  id: `call_${turn}`, type: "function",
                  function: { name: "bash", arguments: JSON.stringify({ command: `echo ${turn}` }) },
                }],
              },
              finish_reason: "tool_calls",
            }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          }
        : OPENAI_REPLY
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
    }) as typeof fetch

    const provider = new OpenRouterProvider({ apiKey: "fake", model: "qwen/qwen3-30b" })
    await runAgentLoop(
      {
        provider, model: "qwen/qwen3-30b", tools: [],
        executeTool: async () => ({ output: "ok", durationMs: 1 }),
        system: "", maxIterations: 6, timeoutMs: 10_000,
      },
      [{ role: "user", content: "do the task" }],
    )

    expect(bodies.length).toBeGreaterThanOrEqual(3)
    for (const body of bodies) {
      const callIds = body.messages.flatMap((m: any) => (m.tool_calls ?? []).map((tc: any) => tc.id))
      const resultIds = body.messages.filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id)
      expect(new Set(callIds).size).toBe(callIds.length)        // no exchange sent twice
      expect(new Set(resultIds).size).toBe(resultIds.length)
      expect(resultIds.every((id: string) => callIds.includes(id))).toBe(true)  // no orphan results
      expect(resultIds.length).toBeLessThanOrEqual(callIds.length)
    }
    // The run really did accumulate history rather than resending one turn.
    expect(bodies.at(-1)!.messages.length).toBeGreaterThan(bodies[0]!.messages.length)
  })

  test("a thinking-mode turn keeps its reasoning when it is no longer the latest", async () => {
    // Deepseek 400s on an assistant turn that carries tool_calls without reasoning_content.
    // Before history was structural this could only apply to the most recent turn.
    stubFetch(OPENAI_REPLY)
    const provider = new OpenAICompatibleProvider({
      apiKey: "fake", model: "deepseek-reasoner", baseUrl: "https://api.deepseek.com/v1",
    })

    await provider.complete({
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant", content: "",
          toolCalls: [{ id: "call_1", name: "bash", arguments: {} }],
          reasoningContent: "first I will list the directory",
        },
        { role: "tool", content: "ok", toolCallId: "call_1" },
        { role: "user", content: "continue" },
      ],
    })

    const assistant = observedBody.messages.find((m: any) => m.role === "assistant")
    expect(assistant.reasoning_content).toBe("first I will list the directory")
  })

  test("a plain assistant turn carries no reasoning_content", async () => {
    // Deepseek's contract: only tool-call turns may carry it.
    stubFetch(OPENAI_REPLY)
    const provider = new OpenAICompatibleProvider({
      apiKey: "fake", model: "deepseek-reasoner", baseUrl: "https://api.deepseek.com/v1",
    })

    await provider.complete({
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "thinking out loud" },
        { role: "user", content: "continue" },
      ],
    })

    const assistant = observedBody.messages.find((m: any) => m.role === "assistant")
    expect("reasoning_content" in assistant).toBe(false)
  })
})
