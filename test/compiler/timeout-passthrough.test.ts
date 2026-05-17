/**
 * Verifies that runPass1Agentic forwards its `timeoutMs` parameter into the
 * config object passed to runAgentLoop.
 *
 * The test would fail if Task 3's change is reverted (i.e., if the code goes
 * back to a hardcoded `timeoutMs: 300_000` instead of using the parameter).
 *
 * Strategy: use mock.module to intercept both runAgentLoop (capturing the
 * config it receives) and extractSCR (returning a minimal SCR that produces a
 * non-empty gap list, so analyzeGaps yields at least one gap and runAgentLoop
 * is actually called rather than the function returning early).
 */
import { describe, test, expect, mock } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { TCP } from "../../src/core/types.ts"
import type { LLMProvider, CompletionParams, LLMResponse, LLMToolResult } from "../../src/providers/types.ts"

// ---------------------------------------------------------------------------
// Capture slot — populated by the mocked runAgentLoop.
// ---------------------------------------------------------------------------

let capturedTimeoutMs: number | undefined

// ---------------------------------------------------------------------------
// Mock runAgentLoop — intercepts the config so we can assert timeoutMs.
// ---------------------------------------------------------------------------

mock.module("../../src/core/agent-loop.ts", () => ({
  runAgentLoop: async (config: { timeoutMs: number }) => {
    capturedTimeoutMs = config.timeoutMs
    // Return a minimal AgentLoopResult so the caller (runPass1Agentic) can
    // continue without error.
    return {
      text: "",
      steps: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      totalCostUsd: 0,
      llmDurationMs: 0,
      iterations: 0,
      allToolCalls: [],
      timedOut: false,
    }
  },
}))

// ---------------------------------------------------------------------------
// Mock extractSCR — skips the real LLM exchange and returns a minimal SCR
// that references primitive "gen.code" at L1. The TCP below has an empty
// capabilities map, so analyzeGaps treats "gen.code" as L0 → "missing" gap.
// This ensures gaps.length > 0 and runAgentLoop IS called (the early-return
// branch `if (gaps.length === 0)` is not taken).
// ---------------------------------------------------------------------------

mock.module("../../src/compiler/passes/rewrite-skill/extractor.ts", () => ({
  extractSCR: async () => ({
    skillName: "test",
    purposes: [
      {
        id: "p1",
        description: "Test purpose",
        currentPath: {
          primitives: [
            {
              id: "gen.code",
              minLevel: "L1",
              evidence: "The skill requires code generation.",
            },
          ],
        },
        alternativePaths: [],
      },
    ],
  }),
}))

// Import the module under test AFTER mocking so Bun's module registry uses
// the stubs above when agent.ts and extractor.ts are resolved.
const { runPass1Agentic } = await import("../../src/compiler/passes/rewrite-skill/agent.ts")

// ---------------------------------------------------------------------------
// Minimal valid TCP — capabilities is empty so any primitive required by
// the SCR above is absent (defaults to L0 inside analyzeGaps).
// ---------------------------------------------------------------------------

const minimalTcp: TCP = {
  version: "1.0",
  model: "test/dummy",
  harness: "bare-agent",
  profiledAt: new Date().toISOString(),
  capabilities: {},
  details: [],
  cost: { totalUsd: 0, totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, durationMs: 0 },
  isPartial: false,
}

// Minimal provider — extractSCR is mocked so this is never actually called,
// but runPass1Agentic's type signature requires an LLMProvider.
const dummyProvider: LLMProvider = {
  name: "dummy",
  async complete(_params: CompletionParams): Promise<LLMResponse> {
    throw new Error("should not be called — extractSCR is mocked")
  },
  async completeWithToolResults(
    _params: CompletionParams,
    _toolResults: LLMToolResult[],
    _previousResponse: LLMResponse,
  ): Promise<LLMResponse> {
    throw new Error("should not be called — runAgentLoop is mocked")
  },
}

describe("runPass1Agentic: timeout passthrough", () => {
  test("forwards timeoutMs parameter into runAgentLoop config", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "skvm-timeout-passthrough-"))
    // Write a minimal SKILL.md so readWorkDirFiles does not fail.
    await Bun.write(path.join(tmp, "SKILL.md"), "# Test skill\n\nDo a thing.\n")

    capturedTimeoutMs = undefined

    await runPass1Agentic(
      "# Test skill\n\nDo a thing.\n",
      minimalTcp,
      dummyProvider,
      tmp,
      undefined,
      12345,
    )

    expect(capturedTimeoutMs as number | undefined).toBe(12345)

    rmSync(tmp, { recursive: true, force: true })
  })
})
