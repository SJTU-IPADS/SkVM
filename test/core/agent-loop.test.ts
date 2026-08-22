import { test, expect, describe } from "bun:test"
import { runAgentLoop, MAX_CONSECUTIVE_PARSE_FAILURES } from "../../src/core/agent-loop.ts"
import type { LLMProvider, LLMResponse, CompletionParams, LLMToolResult, LLMMessage } from "../../src/providers/types.ts"
import { ToolArgumentsParseError, ProviderHttpError } from "../../src/providers/errors.ts"

const EMPTY_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

// Minimal mock LLM. Each `complete` call sleeps for `delayMs` then returns
// a final end_turn response, so the loop exits naturally after one iteration.
function mockProvider(delayMs: number): LLMProvider {
  return {
    name: "mock",
    async complete(_params: CompletionParams): Promise<LLMResponse> {
      await new Promise((r) => setTimeout(r, delayMs))
      return {
        text: "done",
        toolCalls: [],
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        durationMs: delayMs,
        stopReason: "end_turn",
      }
    },
    async completeWithToolResults(
      _params: CompletionParams,
      _toolResults: LLMToolResult[],
      _previousResponse: LLMResponse,
    ): Promise<LLMResponse> {
      throw new Error("not used")
    },
  }
}

describe("runAgentLoop deadline detection", () => {
  test("post-loop check catches over-time await that returned end_turn", async () => {
    // Regression for round-6 / sweep G6: the in-loop deadline check only
    // fires before a new iteration starts. If `provider.complete()` runs
    // past `timeoutMs` and then returns a final response, the loop exits
    // naturally and the in-loop check never runs. Without the post-loop
    // check, `timedOut` would stay false, and bare-agent would report
    // `runStatus: 'ok'` for an over-time run — recreating the original
    // false-positive class.
    const result = await runAgentLoop(
      {
        provider: mockProvider(200),  // takes 200ms
        model: "mock",
        tools: [],
        executeTool: async () => ({ output: "", durationMs: 0 }),
        system: "",
        maxIterations: 5,
        timeoutMs: 50,                  // budget is 50ms — overrun by ~150ms
      },
      [{ role: "user", content: "hello" }],
    )

    expect(result.timedOut).toBe(true)
    expect(result.iterations).toBe(1)  // one iteration happened
  })

  test("normal in-budget run is not marked timedOut", async () => {
    const result = await runAgentLoop(
      {
        provider: mockProvider(20),    // takes 20ms
        model: "mock",
        tools: [],
        executeTool: async () => ({ output: "", durationMs: 0 }),
        system: "",
        maxIterations: 5,
        timeoutMs: 5000,                // ample budget
      },
      [{ role: "user", content: "hello" }],
    )

    expect(result.timedOut).toBe(false)
    expect(result.text).toBe("done")
    expect(result.iterations).toBe(1)
  })
})

/**
 * Provider that emits N independent tool_use blocks on the first turn, then
 * end_turn on the next call. Used to exercise ILP dispatch: each tool call
 * sleeps for `toolDelayMs`; with serial execution total wall-clock ≈ N*delay,
 * with parallel execution total ≈ delay.
 */
function ilpMockProvider(toolCount: number): LLMProvider {
  let turn = 0
  return {
    name: "ilp-mock",
    async complete(_params: CompletionParams): Promise<LLMResponse> {
      turn = 1
      return {
        text: "",
        toolCalls: Array.from({ length: toolCount }, (_, i) => ({
          id: `call_${i}`,
          name: "bash",
          arguments: { command: `echo ${i}` },
        })),
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        durationMs: 1,
        stopReason: "tool_use",
      }
    },
    async completeWithToolResults(
      _params: CompletionParams,
      _toolResults: LLMToolResult[],
      _previousResponse: LLMResponse,
    ): Promise<LLMResponse> {
      turn = 2
      return {
        text: "done",
        toolCalls: [],
        tokens: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 },
        durationMs: 1,
        stopReason: "end_turn",
      }
    },
  }
}

describe("runAgentLoop ILP dispatch", () => {
  const TOOL_DELAY_MS = 80
  const TOOL_COUNT = 4

  test("serial dispatch runs tool calls one after another", async () => {
    const t0 = performance.now()
    const result = await runAgentLoop(
      {
        provider: ilpMockProvider(TOOL_COUNT),
        model: "mock",
        tools: [],
        executeTool: async () => {
          await new Promise((r) => setTimeout(r, TOOL_DELAY_MS))
          return { output: "ok", durationMs: TOOL_DELAY_MS }
        },
        system: "",
        maxIterations: 3,
        timeoutMs: 5000,
        // parallelToolExecution omitted → default false
      },
      [{ role: "user", content: "go" }],
    )
    const elapsed = performance.now() - t0

    expect(result.allToolCalls).toHaveLength(TOOL_COUNT)
    // Serial: total ≈ N * delay. Assert we are at least 90% of that sum.
    expect(elapsed).toBeGreaterThanOrEqual(TOOL_COUNT * TOOL_DELAY_MS * 0.9)
  })

  test("parallelToolExecution fans out tool calls concurrently", async () => {
    const t0 = performance.now()
    const result = await runAgentLoop(
      {
        provider: ilpMockProvider(TOOL_COUNT),
        model: "mock",
        tools: [],
        executeTool: async () => {
          await new Promise((r) => setTimeout(r, TOOL_DELAY_MS))
          return { output: "ok", durationMs: TOOL_DELAY_MS }
        },
        system: "",
        maxIterations: 3,
        timeoutMs: 5000,
        parallelToolExecution: true,
      },
      [{ role: "user", content: "go" }],
    )
    const elapsed = performance.now() - t0

    expect(result.allToolCalls).toHaveLength(TOOL_COUNT)
    // Parallel: wall-clock ≈ single delay. Must be strictly less than half
    // of the serial lower bound to prove fan-out actually happened.
    expect(elapsed).toBeLessThan(TOOL_COUNT * TOOL_DELAY_MS * 0.5)
  })

  test("ordering of allToolCalls is preserved across parallel dispatch", async () => {
    // Inject per-call delays so call_0 finishes LAST (longest delay). If
    // ordering were wall-clock based, allToolCalls[0] would be call_3.
    const delays = [200, 100, 60, 30]
    const result = await runAgentLoop(
      {
        provider: ilpMockProvider(4),
        model: "mock",
        tools: [],
        executeTool: async (tc) => {
          const idx = parseInt(tc.id.replace("call_", ""), 10)
          const d = delays[idx] ?? 20
          await new Promise((r) => setTimeout(r, d))
          return { output: tc.id, durationMs: d }
        },
        system: "",
        maxIterations: 3,
        timeoutMs: 5000,
        parallelToolExecution: true,
      },
      [{ role: "user", content: "go" }],
    )

    expect(result.allToolCalls.map((c) => c.id)).toEqual([
      "call_0",
      "call_1",
      "call_2",
      "call_3",
    ])
  })
})

// ---------------------------------------------------------------------------
// Malformed tool_call recovery (feed-back-and-retry, not adapter-crash)
// ---------------------------------------------------------------------------
//
// Small models (e.g. qwen3-30b) sometimes leak reasoning into tool_call
// arguments, producing JSON that JSON.parse rejects. The provider surfaces
// that as ToolArgumentsParseError. The loop must treat it as a recoverable
// content failure: feed the parse error back to the model and let it retry,
// rather than aborting the whole run as adapter-crashed.

describe("runAgentLoop malformed tool_call recovery", () => {
  test("feeds parse error back and recovers when the model retries with valid JSON", async () => {
    const calls: LLMMessage[][] = []
    let n = 0
    const provider: LLMProvider = {
      name: "parse-then-ok",
      async complete(params: CompletionParams): Promise<LLMResponse> {
        calls.push(params.messages.map((m) => ({ ...m })))
        n++
        if (n === 1) {
          throw new ToolArgumentsParseError("parse-then-ok", "<think>oops</think>{not: json")
        }
        return { text: "recovered", toolCalls: [], tokens: EMPTY_TOKENS, durationMs: 1, stopReason: "end_turn" }
      },
      async completeWithToolResults(): Promise<LLMResponse> {
        throw new Error("not used")
      },
    }

    const result = await runAgentLoop(
      {
        provider,
        model: "mock",
        tools: [],
        executeTool: async () => ({ output: "", durationMs: 0 }),
        system: "",
        maxIterations: 10,
        timeoutMs: 5000,
      },
      [{ role: "user", content: "go" }],
    )

    // Did not crash the run — recovered and produced the model's retry.
    expect(result.error).toBeUndefined()
    expect(result.text).toBe("recovered")
    expect(result.iterations).toBeGreaterThanOrEqual(2)
    // The retry actually saw a corrective message telling it to emit valid JSON.
    expect(calls.length).toBe(2)
    expect(calls[1]!.some((m) => m.role === "user" && m.content.includes("JSON"))).toBe(true)
  })

  test("the counter is consecutive: alternating bad/good never exhausts it", async () => {
    // The give-up rule is about a model that CANNOT emit valid JSON, not one that occasionally
    // fails. Without the reset, a long run with sporadic parse failures would be killed at the
    // third one, however far apart they were.
    let n = 0
    // One scripted sequence shared by both entry points: bad, good, bad, good, ... Each failure is
    // separated by a success, so the consecutive counter must never reach its limit.
    const next = (): LLMResponse => {
      n++
      if (n % 2 === 1 && n < 8) {
        throw new ToolArgumentsParseError("alternating", `{bad-${n}`, undefined, {
          tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          durationMs: 7,
        })
      }
      if (n < 8) {
        return {
          text: "",
          toolCalls: [{ id: `call_${n}`, name: "bash", arguments: { command: `echo ${n}` } }],
          tokens: EMPTY_TOKENS, durationMs: 1, stopReason: "tool_use",
        }
      }
      return { text: "done", toolCalls: [], tokens: EMPTY_TOKENS, durationMs: 1, stopReason: "end_turn" }
    }
    const provider: LLMProvider = {
      name: "alternating",
      async complete(): Promise<LLMResponse> {
        return next()
      },
      async completeWithToolResults(): Promise<LLMResponse> {
        return next()
      },
    }

    const result = await runAgentLoop(
      {
        provider,
        model: "mock",
        tools: [],
        executeTool: async () => ({ output: "ok", durationMs: 0 }),
        system: "",
        maxIterations: 30,
        timeoutMs: 5000,
      },
      [{ role: "user", content: "go" }],
    )

    expect(result.error).toBeUndefined()
    expect(result.text).toBe("done")
    // Four rejected turns happened, none of them consecutive, and the run survived all of them.
    expect(n).toBe(8)
  })

  test("a rejected turn's tokens, cost and latency still land in the run totals", async () => {
    // The provider throws AFTER a 200 OK, so the call was billed. Dropping it understates cost
    // exactly on the weak-model runs this recovery path exists to keep.
    let n = 0
    const provider: LLMProvider = {
      name: "billed-then-ok",
      async complete(): Promise<LLMResponse> {
        n++
        if (n === 1) {
          throw new ToolArgumentsParseError("billed-then-ok", "{bad", undefined, {
            tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0 },
            costUsd: 0.002,
            durationMs: 250,
          })
        }
        return {
          text: "recovered", toolCalls: [],
          tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
          costUsd: 0.001, durationMs: 50, stopReason: "end_turn",
        }
      },
      async completeWithToolResults(): Promise<LLMResponse> {
        throw new Error("not used")
      },
    }

    const result = await runAgentLoop(
      {
        provider, model: "mock", tools: [],
        executeTool: async () => ({ output: "", durationMs: 0 }),
        system: "", maxIterations: 10, timeoutMs: 5000,
      },
      [{ role: "user", content: "go" }],
    )

    expect(result.tokens).toEqual({ input: 110, output: 22, cacheRead: 5, cacheWrite: 0 })
    expect(result.totalCostUsd).toBeCloseTo(0.003, 6)
    expect(result.llmDurationMs).toBe(300)
  })

  test("the correction follows the model's own rejected output, not a bare user turn", async () => {
    // Two consecutive user turns are invalid on some providers, and "your previous reply" has to
    // have a previous reply to refer to.
    const calls: LLMMessage[][] = []
    let n = 0
    const provider: LLMProvider = {
      name: "shape-check",
      async complete(params: CompletionParams): Promise<LLMResponse> {
        calls.push(params.messages.map((m) => ({ ...m })))
        n++
        if (n === 1) throw new ToolArgumentsParseError("shape-check", "<think>x</think>{bad")
        return { text: "ok", toolCalls: [], tokens: EMPTY_TOKENS, durationMs: 1, stopReason: "end_turn" }
      },
      async completeWithToolResults(): Promise<LLMResponse> {
        throw new Error("not used")
      },
    }

    await runAgentLoop(
      {
        provider, model: "mock", tools: [],
        executeTool: async () => ({ output: "", durationMs: 0 }),
        system: "", maxIterations: 10, timeoutMs: 5000,
      },
      [{ role: "user", content: "go" }],
    )

    const retry = calls[1]!
    expect(retry.at(-2)).toEqual({ role: "assistant", content: "<think>x</think>{bad" })
    expect(retry.at(-1)!.role).toBe("user")
    // No two adjacent turns share a role.
    for (let i = 1; i < retry.length; i++) {
      expect(retry[i]!.role).not.toBe(retry[i - 1]!.role)
    }
  })

  test("a non-parse ProviderError still propagates as an infra failure", async () => {
    // The whole point of the change is that PARSE failures stop being infra errors. Everything
    // else must keep crashing the run loudly.
    const provider: LLMProvider = {
      name: "http-boom",
      async complete(): Promise<LLMResponse> {
        throw new ProviderHttpError("OpenRouter API error 500: upstream exploded", "http-boom", 500, "boom")
      },
      async completeWithToolResults(): Promise<LLMResponse> {
        throw new Error("not used")
      },
    }

    await expect(
      runAgentLoop(
        {
          provider, model: "mock", tools: [],
          executeTool: async () => ({ output: "", durationMs: 0 }),
          system: "", maxIterations: 5, timeoutMs: 5000,
        },
        [{ role: "user", content: "go" }],
      ),
    ).rejects.toThrow(/upstream exploded/)
  })

  test("gives up as a scored run (not a crash) after N consecutive parse failures", async () => {
    let n = 0
    const provider: LLMProvider = {
      name: "always-parse-err",
      async complete(): Promise<LLMResponse> {
        n++
        throw new ToolArgumentsParseError("always-parse-err", "<think>never valid</think>{")
      },
      async completeWithToolResults(): Promise<LLMResponse> {
        throw new Error("not used")
      },
    }

    const result = await runAgentLoop(
      {
        provider,
        model: "mock",
        tools: [],
        executeTool: async () => ({ output: "", durationMs: 0 }),
        system: "",
        maxIterations: 10, // deliberately larger than the parse-retry cap
        timeoutMs: 5000,
      },
      [{ role: "user", content: "go" }],
    )

    // Persistent malformed JSON is the model failing the task, not the harness
    // crashing: no propagated error, so runStatus stays 'ok' and it scores 0.
    expect(result.error).toBeUndefined()
    // The consecutive-failure cap fired before maxIterations was exhausted.
    expect(n).toBe(MAX_CONSECUTIVE_PARSE_FAILURES)
    expect(result.iterations).toBeLessThanOrEqual(MAX_CONSECUTIVE_PARSE_FAILURES)
  })

  test("recovers from a parse error on the completeWithToolResults (mid-conversation) path", async () => {
    const completeCalls: LLMMessage[][] = []
    let completeN = 0
    let toolRuns = 0
    const provider: LLMProvider = {
      name: "mid-conv",
      async complete(params: CompletionParams): Promise<LLMResponse> {
        completeCalls.push(params.messages.map((m) => ({ ...m })))
        completeN++
        if (completeN === 1) {
          return {
            text: "",
            toolCalls: [{ id: "c0", name: "bash", arguments: { command: "echo hi" } }],
            tokens: EMPTY_TOKENS,
            durationMs: 1,
            stopReason: "tool_use",
          }
        }
        return { text: "recovered after tool", toolCalls: [], tokens: EMPTY_TOKENS, durationMs: 1, stopReason: "end_turn" }
      },
      async completeWithToolResults(): Promise<LLMResponse> {
        throw new ToolArgumentsParseError("mid-conv", "<think>leak</think>{bad")
      },
    }

    const result = await runAgentLoop(
      {
        provider,
        model: "mock",
        tools: [],
        executeTool: async () => {
          toolRuns++
          return { output: "hi", durationMs: 0 }
        },
        system: "",
        maxIterations: 10,
        timeoutMs: 5000,
      },
      [{ role: "user", content: "go" }],
    )

    expect(result.error).toBeUndefined()
    expect(result.text).toBe("recovered after tool")
    expect(toolRuns).toBe(1)
    // Recovery restarted via complete(); the retry saw the prior tool exchange
    // plus a corrective message.
    expect(completeN).toBe(2)
    expect(completeCalls[1]!.some((m) => m.role === "user" && m.content.includes("JSON"))).toBe(true)
  })
})
