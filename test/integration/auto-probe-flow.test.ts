import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { createProviderForModel } from "../../src/providers/registry.ts"
import { __resetProbeGuardForTest } from "../../src/providers/auto-probe.ts"
import { __resetConfigCacheForTest } from "../../src/core/config.ts"

let tmp: string
let savedCache: string | undefined
const realFetch = globalThis.fetch

beforeEach(() => {
  __resetProbeGuardForTest()
  __resetConfigCacheForTest()
  tmp = path.join(tmpdir(), `skvm-it-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmp, { recursive: true })
  savedCache = process.env.SKVM_CACHE
  process.env.SKVM_CACHE = tmp
  writeFileSync(path.join(tmp, "skvm.config.json"), JSON.stringify({
    providers: {
      routes: [
        { match: "gw/*", kind: "openai-compatible", baseUrl: "https://gw.example.com/v1", apiKey: "k" },
      ],
    },
  }, null, 2))
})

afterEach(() => {
  globalThis.fetch = realFetch
  if (savedCache === undefined) delete process.env.SKVM_CACHE
  else process.env.SKVM_CACHE = savedCache
  rmSync(tmp, { recursive: true, force: true })
})

test("polluted user call → probe → clean alt → write route → retry succeeds", async () => {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.toString?.() ?? ""
    // The Anthropic SDK requires content-type: application/json to parse the
    // response body as JSON rather than returning it as a plain string.
    if (url.includes("/v1/messages")) {
      // Determine what tool the caller is requesting by inspecting the body.
      let reqBody: Record<string, unknown> = {}
      try { reqBody = JSON.parse(init?.body ?? "{}") } catch { /* ignore */ }
      const tools = reqBody.tools as Array<{ name: string }> | undefined
      const isProbeCall = tools?.some(t => t.name === "extract_probe") ?? false

      if (isProbeCall) {
        // Probe alt verification: return clean probe values matching PROBE_EXPECTED.
        return new Response(JSON.stringify({
          id: "msg_probe", type: "message", role: "assistant",
          content: [{ type: "tool_use", id: "tp", name: "extract_probe",
            input: { name: "probe", score: 42 } }],
          stop_reason: "tool_use", model: "glm-5-thinking",
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      // Final retry after route is written: clean structured tool_use.
      return new Response(JSON.stringify({
        id: "msg_alt", type: "message", role: "assistant",
        content: [{ type: "tool_use", id: "tu", name: "anything",
          input: { name: "real", score: 99 } }],
        stop_reason: "tool_use", model: "glm-5-thinking",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }), { status: 200, headers: { "content-type": "application/json" } })
    }
    // openai-compatible /chat/completions: always polluted
    return new Response(JSON.stringify({
      id: "x", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "",
        tool_calls: [{ id: "1", type: "function",
          function: { name: "anything", arguments: "<think>x</think>{bad}" } }],
      }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    }), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch

  const provider = createProviderForModel("gw/glm-5-thinking")
  const res = await provider.complete({
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "anything", description: "", inputSchema: { type: "object" } }],
    toolChoice: { name: "anything" },
  })
  expect(res.toolCalls).toHaveLength(1)
  expect(res.toolCalls[0]!.arguments).toEqual({ name: "real", score: 99 })

  // Verify the literal route was written to config.
  const parsed = JSON.parse(readFileSync(path.join(tmp, "skvm.config.json"), "utf-8"))
  expect(parsed.providers.routes[0].match).toBe("gw/glm-5-thinking")
  expect(parsed.providers.routes[0].kind).toBe("anthropic")
  expect(parsed.providers.routes[0].discoveredAt).toBeTruthy()
})

test("second createProviderForModel call in same process uses written literal route (cache-bust regression)", async () => {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.toString?.() ?? ""
    if (url.includes("/v1/messages")) {
      let reqBody: Record<string, unknown> = {}
      try { reqBody = JSON.parse(init?.body ?? "{}") } catch { /* ignore */ }
      const tools = reqBody.tools as Array<{ name: string }> | undefined
      const isProbeCall = tools?.some(t => t.name === "extract_probe") ?? false

      if (isProbeCall) {
        return new Response(JSON.stringify({
          id: "msg_probe", type: "message", role: "assistant",
          content: [{ type: "tool_use", id: "tp", name: "extract_probe",
            input: { name: "probe", score: 42 } }],
          stop_reason: "tool_use", model: "glm-5-thinking",
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      // Any non-probe call to /v1/messages: clean structured tool_use.
      return new Response(JSON.stringify({
        id: "msg_alt", type: "message", role: "assistant",
        content: [{ type: "tool_use", id: "tu", name: "anything",
          input: { name: "real", score: 99 } }],
        stop_reason: "tool_use", model: "glm-5-thinking",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }), { status: 200, headers: { "content-type": "application/json" } })
    }
    // openai-compatible /chat/completions: always polluted
    return new Response(JSON.stringify({
      id: "x", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "",
        tool_calls: [{ id: "1", type: "function",
          function: { name: "anything", arguments: "<think>x</think>{bad}" } }],
      }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    }), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch

  // First call: triggers probe, writes literal anthropic route.
  const provider1 = createProviderForModel("gw/glm-5-thinking")
  await provider1.complete({
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "anything", description: "", inputSchema: { type: "object" } }],
    toolChoice: { name: "anything" },
  })

  // Second call in same process — no __resetConfigCacheForTest between calls.
  // Before the fix, the stale cache serves the old openai-compatible route,
  // the auto-probe wrapper fires again but the per-process probe guard blocks
  // a re-probe, and ToolArgumentsParseError is thrown.
  // After the fix, invalidateConfigCache() was called after the write, so this
  // resolves to a plain anthropic provider and returns cleanly.
  const provider2 = createProviderForModel("gw/glm-5-thinking")

  // provider2 must NOT be an auto-probe wrapper.
  expect(provider2.name).not.toMatch(/^auto-probe\(/)

  const res2 = await provider2.complete({
    messages: [{ role: "user", content: "second call" }],
    tools: [{ name: "anything", description: "", inputSchema: { type: "object" } }],
    toolChoice: { name: "anything" },
  })
  expect(res2.toolCalls).toHaveLength(1)
  expect(res2.toolCalls[0]!.arguments).toEqual({ name: "real", score: 99 })
})
