/**
 * Cost accounting must survive the failure that caused it.
 *
 * A ProviderError (rate-limit exhaustion, provider down) propagates out of the
 * agent loop by design, past every usage accumulator on the way. Without the
 * partial-usage carrier, a probe that burned real tokens and then hit a 429
 * records 0 tokens and $0 — which understates profiling cost exactly where a
 * run got expensive enough to fail, and is invisible in the output.
 */

import { test, expect, describe } from "bun:test"
import { runAgentLoop } from "../../src/core/agent-loop.ts"
import {
  ProviderHttpError,
  attachPartialUsage,
  readPartialUsage,
  type PartialUsage,
} from "../../src/providers/errors.ts"
import type { LLMProvider, LLMResponse } from "../../src/providers/types.ts"
import { emptyTokenUsage } from "../../src/core/types.ts"

function response(over: Partial<LLMResponse> = {}): LLMResponse {
  return {
    text: "",
    toolCalls: [],
    tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0 },
    costUsd: 0.001,
    durationMs: 10,
    stopReason: "end_turn",
    ...over,
  }
}

/** Emits `script` in order; a thrown entry is thrown, a response is returned. */
function scriptedProvider(script: Array<LLMResponse | Error>): LLMProvider {
  let i = 0
  const next = async (): Promise<LLMResponse> => {
    const step = script[i++]
    if (step === undefined) throw new Error("provider called more times than scripted")
    if (step instanceof Error) throw step
    return step
  }
  return {
    name: "scripted",
    complete: next,
    completeWithToolResults: next,
  } as unknown as LLMProvider
}

const loopConfig = (provider: LLMProvider) => ({
  provider,
  model: "test/model",
  tools: [],
  executeTool: async () => ({ output: "ok", exitCode: 0, durationMs: 1 }),
  system: "",
  maxIterations: 5,
  timeoutMs: 10_000,
})

describe("partial usage carrier", () => {
  test("attach/read round-trips without making the payload enumerable", () => {
    const err = new ProviderHttpError("429", "openrouter", 429)
    const usage: PartialUsage = {
      tokens: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.5,
      llmCalls: 2,
      llmCallsWithCost: 2,
    }
    attachPartialUsage(err, usage)
    expect(readPartialUsage(err)).toEqual(usage)
    // Must not leak into serialized error dumps.
    expect(Object.keys(err)).not.toContain("partialUsage")
    expect(JSON.stringify(err)).not.toContain("0.5")
  })

  test("reading from an error with nothing attached yields undefined", () => {
    expect(readPartialUsage(new Error("plain"))).toBeUndefined()
    expect(readPartialUsage(undefined)).toBeUndefined()
    expect(readPartialUsage("not an error")).toBeUndefined()
  })
})

describe("runAgentLoop — spend survives an infra error", () => {
  test("tokens and cost billed before a 429 ride out on the thrown error", async () => {
    const provider = scriptedProvider([
      response({ toolCalls: [{ id: "1", name: "t", arguments: {} }], stopReason: "tool_use" }),
      new ProviderHttpError("rate limit exhausted", "openrouter", 429),
    ])

    let caught: unknown
    try {
      await runAgentLoop(loopConfig(provider), [{ role: "user", content: "go" }])
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ProviderHttpError)
    const partial = readPartialUsage(caught)
    expect(partial).toBeDefined()
    // The one completed call was billed; it must not vanish.
    expect(partial!.tokens).toEqual({ input: 100, output: 20, cacheRead: 5, cacheWrite: 0 })
    expect(partial!.costUsd).toBeCloseTo(0.001, 10)
    expect(partial!.llmCalls).toBe(1)
    expect(partial!.llmCallsWithCost).toBe(1)
  })

  test("an error before any call attaches a zeroed record, not a missing one", async () => {
    const provider = scriptedProvider([new ProviderHttpError("down", "openrouter", 503)])

    let caught: unknown
    try {
      await runAgentLoop(loopConfig(provider), [{ role: "user", content: "go" }])
    } catch (err) {
      caught = err
    }

    const partial = readPartialUsage(caught)
    expect(partial).toBeDefined()
    expect(partial!.tokens).toEqual(emptyTokenUsage())
    expect(partial!.llmCalls).toBe(0)
  })

  test("cost is left undefined — never a silent 0 — when a call went unpriced", async () => {
    const provider = scriptedProvider([
      response({ costUsd: undefined, toolCalls: [{ id: "1", name: "t", arguments: {} }], stopReason: "tool_use" }),
      new ProviderHttpError("boom", "openrouter", 500),
    ])

    let caught: unknown
    try {
      await runAgentLoop(loopConfig(provider), [{ role: "user", content: "go" }])
    } catch (err) {
      caught = err
    }

    const partial = readPartialUsage(caught)
    expect(partial!.costUsd).toBeUndefined()
    expect(partial!.tokens.input).toBe(100)
    expect(partial!.llmCalls).toBe(1)
    expect(partial!.llmCallsWithCost).toBe(0)
  })
})

describe("runAgentLoop — cost coverage on the success path", () => {
  test("counts every call and how many the provider priced", async () => {
    const provider = scriptedProvider([
      response({ toolCalls: [{ id: "1", name: "t", arguments: {} }], stopReason: "tool_use" }),
      response({ costUsd: undefined, text: "done" }),
    ])

    const result = await runAgentLoop(loopConfig(provider), [{ role: "user", content: "go" }])

    expect(result.llmCalls).toBe(2)
    expect(result.llmCallsWithCost).toBe(1)
    // One unpriced call makes the whole sum non-authoritative.
    expect(result.totalCostUsd).toBeUndefined()
    expect(result.tokens.input).toBe(200)
  })

  test("fully priced runs report matching counts and an authoritative total", async () => {
    const provider = scriptedProvider([response({ text: "done" })])
    const result = await runAgentLoop(loopConfig(provider), [{ role: "user", content: "go" }])
    expect(result.llmCalls).toBe(1)
    expect(result.llmCallsWithCost).toBe(1)
    expect(result.totalCostUsd).toBeCloseTo(0.001, 10)
  })
})
