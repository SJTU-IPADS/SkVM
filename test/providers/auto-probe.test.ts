import { test, expect, describe, beforeEach } from "bun:test"
import { AutoProbeProvider, __resetProbeGuardForTest } from "../../src/providers/auto-probe.ts"
import { ToolArgumentsParseError } from "../../src/providers/errors.ts"
import type { LLMProvider } from "../../src/providers/types.ts"
import type { ProviderRoute } from "../../src/core/types.ts"

beforeEach(() => { __resetProbeGuardForTest() })

describe("AutoProbeProvider", () => {
  test("pass-through when delegate returns successfully (zero probe)", async () => {
    let delegateCalls = 0
    const delegate: LLMProvider = {
      name: "delegate",
      complete: async () => {
        delegateCalls += 1
        return {
          text: "ok", toolCalls: [], tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          durationMs: 0, stopReason: "end_turn",
        }
      },
    } as unknown as LLMProvider
    const route: ProviderRoute = { match: "x/*", kind: "openai-compatible", baseUrl: "https://x.example.com/v1", apiKey: "k" }

    const wrapper = new AutoProbeProvider(delegate, "x/m", route, async () => { throw new Error("should not be called") })
    const res = await wrapper.complete({ messages: [{ role: "user", content: "hi" }] })
    expect(res.text).toBe("ok")
    expect(delegateCalls).toBe(1)
  })

  test("delegate throws ToolArgumentsParseError + probe finds clean alt: writes route, retries, returns alt result", async () => {
    const delegate: LLMProvider = {
      name: "delegate",
      complete: async () => { throw new ToolArgumentsParseError("delegate", "<think>x</think>{}") },
    } as unknown as LLMProvider
    const route: ProviderRoute = { match: "x/*", kind: "openai-compatible", baseUrl: "https://x.example.com/v1", apiKey: "k" }
    let probeRan = false
    let writeRan = false

    const wrapper = new AutoProbeProvider(delegate, "x/m", route, async () => {
      probeRan = true
      return {
        verdict: { primary: "polluted", alt: "clean" },
        altProvider: {
          name: "alt",
          complete: async () => ({
            text: "from-alt",
            toolCalls: [{ id: "1", name: "t", arguments: { ok: true } }],
            tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            durationMs: 0,
            stopReason: "tool_use" as const,
          }),
        } as unknown as LLMProvider,
        writeRoute: async () => { writeRan = true; return { written: true } },
      }
    })
    const res = await wrapper.complete({ messages: [{ role: "user", content: "hi" }] })
    expect(probeRan).toBe(true)
    expect(writeRan).toBe(true)
    expect(res.text).toBe("from-alt")
  })

  test("delegate throws + probe finds no clean alt: rethrows original error", async () => {
    const original = new ToolArgumentsParseError("delegate", "<think>x</think>{}")
    const delegate: LLMProvider = {
      name: "delegate", complete: async () => { throw original },
    } as unknown as LLMProvider
    const route: ProviderRoute = { match: "x/*", kind: "openai-compatible", baseUrl: "https://x.example.com/v1", apiKey: "k" }

    const wrapper = new AutoProbeProvider(delegate, "x/m", route, async () => ({
      verdict: { primary: "polluted", alt: "polluted" }, altProvider: null, writeRoute: null,
    }))
    let thrown: unknown
    try {
      await wrapper.complete({ messages: [{ role: "user", content: "hi" }] })
    } catch (e) { thrown = e }
    expect(thrown).toBe(original)
  })

  test("guard set prevents re-probing the same modelId in same process", async () => {
    let probeRuns = 0
    const delegate: LLMProvider = {
      name: "delegate", complete: async () => { throw new ToolArgumentsParseError("d", "<think>") },
    } as unknown as LLMProvider
    const route: ProviderRoute = { match: "x/*", kind: "openai-compatible", baseUrl: "https://x.example.com/v1", apiKey: "k" }
    const wrapper = new AutoProbeProvider(delegate, "x/m", route, async () => {
      probeRuns += 1
      return { verdict: { primary: "polluted", alt: "indeterminate" }, altProvider: null, writeRoute: null }
    })
    try { await wrapper.complete({ messages: [{ role: "user", content: "1" }] }) } catch {}
    try { await wrapper.complete({ messages: [{ role: "user", content: "2" }] }) } catch {}
    expect(probeRuns).toBe(1)
  })
})
