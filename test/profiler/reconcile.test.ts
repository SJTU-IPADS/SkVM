import { test, expect, describe } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { reconcileProfileCost, resolveLogDir } from "../../src/profiler/reconcile.ts"
import type { TCP, TokenUsage } from "../../src/core/types.ts"

function tokens(input: number, output: number, cacheRead = 0): TokenUsage {
  return { input, output, cacheRead, cacheWrite: 0 }
}

function makeTcp(opts: {
  convLogDirs?: string[]
  totalUsd: number
  totalTokens: TokenUsage
  llmCalls?: number
  llmCallsWithCost?: number
}): TCP {
  const dirs = opts.convLogDirs ?? []
  return {
    version: "1.0",
    model: "openrouter/vendor/model",
    harness: "bare-agent",
    profiledAt: "2026-01-01T00:00:00Z",
    capabilities: {},
    details: dirs.map((d, i) => ({
      primitiveId: `p${i}`,
      highestLevel: "L1" as const,
      levelResults: [],
      convLogDir: d,
    })) as TCP["details"],
    cost: {
      totalUsd: opts.totalUsd,
      totalTokens: opts.totalTokens,
      durationMs: 0,
      ...(opts.llmCalls !== undefined ? { llmCalls: opts.llmCalls } : {}),
      ...(opts.llmCallsWithCost !== undefined ? { llmCallsWithCost: opts.llmCallsWithCost } : {}),
    },
    isPartial: false,
  }
}

/** One run directory with per-primitive subdirectories of transcripts. */
async function writeLogs(entries: Array<{ primitive: string; tokens: TokenUsage; costUsd?: number; fleet?: string }>) {
  const runDir = await mkdtemp(path.join(tmpdir(), "reconcile-"))
  const byPrimitive = new Map<string, string[]>()
  for (const e of entries) {
    const line = JSON.stringify({
      type: "response", ts: "2026-01-01T00:00:00Z", text: "", toolCalls: [],
      tokens: e.tokens, durationMs: 1, stopReason: "end_turn",
      ...(e.costUsd !== undefined ? { costUsd: e.costUsd } : {}),
      ...(e.fleet ? { servingProvider: e.fleet } : {}),
    })
    byPrimitive.set(e.primitive, [...(byPrimitive.get(e.primitive) ?? []), line])
  }
  for (const [primitive, lines] of byPrimitive) {
    const dir = path.join(runDir, primitive)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, "instance-0.jsonl"), lines.join("\n") + "\n")
  }
  return runDir
}

describe("resolveLogDir", () => {
  test("collapses per-primitive convLogDirs to the one run directory", async () => {
    // convLogDir is recorded per primitive, so a 26-primitive profile yields 26
    // distinct strings. Comparing them raw meant the recorded location was never
    // used and every run fell back to the shared dir, where a rerun's stale
    // transcripts get summed in.
    const tcp = makeTcp({
      convLogDirs: ["/logs/run-A/gen.regex", "/logs/run-A/tool.exec", "/logs/run-A/reason.logic"],
      totalUsd: 0, totalTokens: tokens(0, 0),
    })
    expect(resolveLogDir(tcp)).toBe("/logs/run-A")
  })

  test("falls back to the shared dir when runs genuinely differ", () => {
    const tcp = makeTcp({
      convLogDirs: ["/logs/run-A/gen.regex", "/logs/run-B/tool.exec"],
      totalUsd: 0, totalTokens: tokens(0, 0),
    })
    expect(resolveLogDir(tcp)).not.toBe("/logs/run-A")
  })
})

describe("reconcileProfileCost", () => {
  test("agreeing profile with full coverage passes", async () => {
    const runDir = await writeLogs([
      { primitive: "p0", tokens: tokens(100, 20), costUsd: 0.001, fleet: "DeepInfra" },
      { primitive: "p1", tokens: tokens(50, 10), costUsd: 0.0005, fleet: "DeepInfra" },
    ])
    const tcp = makeTcp({
      convLogDirs: [path.join(runDir, "p0"), path.join(runDir, "p1")],
      totalUsd: 0.0015, totalTokens: tokens(150, 30), llmCalls: 2, llmCallsWithCost: 2,
    })

    const result = await reconcileProfileCost(tcp)
    expect(result.ok).toBe(true)
    expect(result.coverage.complete).toBe(true)
    expect(result.coverage.costIsFloor).toBe(false)
    expect(result.servingBackends).toEqual({ DeepInfra: 2 })
  })

  test("a few unpriced calls pass with the cost labelled a floor", async () => {
    // The gate's whole point: a provider that omits a usage block on 2 of 1060
    // calls perturbs nothing but the priced-call count. Those calls report zero
    // tokens, so the totals still agree — and the cost is the priced sum, not a
    // re-estimate, so it agrees too.
    const entries = Array.from({ length: 100 }, (_, i) => ({
      primitive: "p0", tokens: tokens(10, 2), ...(i < 98 ? { costUsd: 0.001 } : {}),
    }))
    const runDir = await writeLogs(entries)
    const tcp = makeTcp({
      convLogDirs: [path.join(runDir, "p0")],
      totalUsd: 0.098, totalTokens: tokens(1000, 200), llmCalls: 100, llmCallsWithCost: 98,
    })

    const result = await reconcileProfileCost(tcp, { minCoverage: 0.95 })
    expect(result.ok).toBe(true)
    expect(result.coverage.costIsFloor).toBe(true)
    expect(result.checks.find((c) => c.name === "cost usd")!.ok).toBe(true)
  })

  test("a re-estimated cost is caught as a mismatch", async () => {
    // What the floor rule prevents: re-pricing the whole run from the local
    // table when one call lacked usage.cost inflated a measured $0.001 into
    // $0.618 in one profile — while still presenting as a measurement.
    const runDir = await writeLogs([
      { primitive: "p0", tokens: tokens(100, 20), costUsd: 0.001 },
      { primitive: "p0", tokens: tokens(100, 20) },
    ])
    const tcp = makeTcp({
      convLogDirs: [path.join(runDir, "p0")],
      totalUsd: 0.618, totalTokens: tokens(200, 40), llmCalls: 2, llmCallsWithCost: 1,
    })

    const result = await reconcileProfileCost(tcp, { minCoverage: 0.4 })
    expect(result.ok).toBe(false)
    expect(result.checks.find((c) => c.name === "cost usd")!.ok).toBe(false)
  })

  test("coverage below the threshold fails even when every metric agrees", async () => {
    const runDir = await writeLogs([
      { primitive: "p0", tokens: tokens(100, 20), costUsd: 0.001 },
      { primitive: "p0", tokens: tokens(100, 20) },
    ])
    const tcp = makeTcp({
      convLogDirs: [path.join(runDir, "p0")],
      totalUsd: 0.001, totalTokens: tokens(200, 40), llmCalls: 2, llmCallsWithCost: 1,
    })

    const result = await reconcileProfileCost(tcp, { minCoverage: 0.99 })
    expect(result.ok).toBe(false)
    expect(result.checks.every((c) => c.ok)).toBe(true)
    expect(result.coverage.acceptable).toBe(false)
  })

  test("a missing log directory fails instead of passing vacuously", async () => {
    // An empty profile compared against an empty log dir agrees on every metric.
    // Passing there would certify a profile nothing was checked against.
    const tcp = makeTcp({
      convLogDirs: ["/nonexistent/run/p0"],
      totalUsd: 0, totalTokens: tokens(0, 0), llmCalls: 0, llmCallsWithCost: 0,
    })

    const result = await reconcileProfileCost(tcp)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("nothing to reconcile against")
  })

  test("unreported coverage cannot pass", async () => {
    // Adapters that do not report call counts leave coverage unknown; that is
    // not the same as verified.
    const runDir = await writeLogs([{ primitive: "p0", tokens: tokens(100, 20), costUsd: 0.001 }])
    const tcp = makeTcp({
      convLogDirs: [path.join(runDir, "p0")],
      totalUsd: 0.001, totalTokens: tokens(100, 20),
    })

    const result = await reconcileProfileCost(tcp)
    expect(result.coverage.known).toBe(false)
    expect(result.ok).toBe(false)
  })
})
