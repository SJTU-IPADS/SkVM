import { test, expect, describe } from "bun:test"
import { profileCostCsv, COST_CSV_HEADER } from "../../src/profiler/cost-export.ts"
import type { TCP } from "../../src/core/types.ts"

type LevelSpec = {
  level: "L1" | "L2" | "L3"
  durationMs: number
  costUsd: number
  input: number
  output: number
  cacheRead: number
  total: number
  skip: number
  /** Omitted to model a profile written before coverage tracking. */
  llmCalls?: number
  llmCallsWithCost?: number
}

function makeTcp(model: string, primitives: Array<{
  id: string
  highest: "L0" | "L1" | "L2" | "L3"
  levels: LevelSpec[]
}>, opts: { harness?: string; profiledAt?: string } = {}): TCP {
  return {
    version: "1.0",
    model,
    harness: opts.harness ?? "bare-agent",
    profiledAt: opts.profiledAt ?? "2026-01-01T00:00:00Z",
    capabilities: Object.fromEntries(primitives.map((p) => [p.id, p.highest])),
    details: primitives.map((p) => ({
      primitiveId: p.id,
      highestLevel: p.highest,
      levelResults: p.levels.map((l) => ({
        level: l.level,
        passed: true,
        passCount: l.total - l.skip,
        totalCount: l.total,
        skipCount: l.skip,
        durationMs: l.durationMs,
        costUsd: l.costUsd,
        tokens: { input: l.input, output: l.output, cacheRead: l.cacheRead, cacheWrite: 0 },
        ...(l.llmCalls !== undefined ? { llmCalls: l.llmCalls } : {}),
        ...(l.llmCallsWithCost !== undefined ? { llmCallsWithCost: l.llmCallsWithCost } : {}),
        testDescription: "",
        failureDetails: [],
      })),
    })),
    cost: { totalUsd: 0, totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, durationMs: 0 },
    isPartial: false,
  }
}

/** Column index by name, so assertions survive future column additions. */
function field(row: string, column: string): string {
  const cols = COST_CSV_HEADER.split(",")
  // levels_run is the only quoted field and contains no commas we care about
  // past it, so a naive split is safe once the quotes are stripped.
  const cells = row.replace(/"([^"]*)"/g, (_m, inner: string) => inner.replace(/,/g, "|"))
  return cells.split(",")[cols.indexOf(column)] ?? ""
}

describe("profileCostCsv", () => {
  test("one row per (model, primitive), summed across levels", () => {
    const tcp = makeTcp("qwen3-30b", [
      {
        id: "gen.regex", highest: "L2",
        levels: [
          { level: "L1", durationMs: 1000, costUsd: 0.001, input: 100, output: 10, cacheRead: 5, total: 3, skip: 0, llmCalls: 4, llmCallsWithCost: 4 },
          { level: "L2", durationMs: 2500, costUsd: 0.004, input: 300, output: 40, cacheRead: 0, total: 3, skip: 1, llmCalls: 6, llmCallsWithCost: 6 },
        ],
      },
    ])
    const csv = profileCostCsv([tcp])
    const [header, row] = csv.trim().split("\n")
    expect(header).toBe(COST_CSV_HEADER)
    expect(field(row!, "model")).toBe("qwen3-30b")
    expect(field(row!, "harness")).toBe("bare-agent")
    expect(field(row!, "primitive")).toBe("gen.regex")
    expect(field(row!, "level")).toBe("L2")
    expect(field(row!, "levels_run")).toBe("L1|L2")
    expect(field(row!, "templates_run")).toBe("5")
    expect(field(row!, "templates_skipped")).toBe("1")
    expect(field(row!, "duration_ms")).toBe("3500")
    expect(field(row!, "cost_usd")).toBe("0.005")
    expect(field(row!, "input_tokens")).toBe("400")
    expect(field(row!, "output_tokens")).toBe("50")
    expect(field(row!, "cache_read_tokens")).toBe("5")
  })

  test("total_tokens sums every bucket, not just input+output", () => {
    // The cache split moves tokens between input and cacheRead depending on
    // which backend served the run, so only the sum is stable across runs.
    const tcp = makeTcp("m", [{
      id: "p", highest: "L1",
      levels: [{ level: "L1", durationMs: 1, costUsd: 0, input: 100, output: 20, cacheRead: 900, total: 1, skip: 0, llmCalls: 1, llmCallsWithCost: 1 }],
    }])
    const row = profileCostCsv([tcp]).trim().split("\n")[1]!
    expect(field(row, "total_tokens")).toBe("1020")
  })

  test("cost_source reports how much of the bill the provider actually priced", () => {
    const cases: Array<[LevelSpec, string]> = [
      [{ level: "L1", durationMs: 1, costUsd: 1, input: 1, output: 1, cacheRead: 0, total: 1, skip: 0, llmCalls: 5, llmCallsWithCost: 5 }, "measured"],
      [{ level: "L1", durationMs: 1, costUsd: 1, input: 1, output: 1, cacheRead: 0, total: 1, skip: 0, llmCalls: 5, llmCallsWithCost: 2 }, "partial"],
      [{ level: "L1", durationMs: 1, costUsd: 0, input: 1, output: 1, cacheRead: 0, total: 1, skip: 0, llmCalls: 5, llmCallsWithCost: 0 }, "estimated"],
      // Pre-coverage profile: absent counters must not read as a measured zero.
      [{ level: "L1", durationMs: 1, costUsd: 0, input: 1, output: 1, cacheRead: 0, total: 1, skip: 0 }, "unknown"],
    ]
    for (const [level, expected] of cases) {
      const tcp = makeTcp("m", [{ id: "p", highest: "L1", levels: [level] }])
      const row = profileCostCsv([tcp]).trim().split("\n")[1]!
      expect(field(row, "cost_source")).toBe(expected)
    }
  })

  test("rows carry harness and profiled_at, so repeats and harnesses stay distinguishable", () => {
    const bare = makeTcp("m", [{ id: "p", highest: "L1", levels: [{ level: "L1", durationMs: 1, costUsd: 0.1, input: 1, output: 1, cacheRead: 0, total: 1, skip: 0, llmCalls: 1, llmCallsWithCost: 1 }] }], { harness: "bare-agent", profiledAt: "2026-01-01T00:00:00Z" })
    const rerun = makeTcp("m", [{ id: "p", highest: "L1", levels: [{ level: "L1", durationMs: 1, costUsd: 0.2, input: 1, output: 1, cacheRead: 0, total: 1, skip: 0, llmCalls: 1, llmCallsWithCost: 1 }] }], { harness: "bare-agent", profiledAt: "2026-01-02T00:00:00Z" })
    const other = makeTcp("m", [{ id: "p", highest: "L1", levels: [{ level: "L1", durationMs: 1, costUsd: 0.3, input: 1, output: 1, cacheRead: 0, total: 1, skip: 0, llmCalls: 1, llmCallsWithCost: 1 }] }], { harness: "opencode" })
    const lines = profileCostCsv([
      bare,
      rerun,
      other,
    ]).trim().split("\n")
    expect(lines).toHaveLength(4)
    expect(field(lines[1]!, "profiled_at")).toBe("2026-01-01T00:00:00Z")
    expect(field(lines[2]!, "profiled_at")).toBe("2026-01-02T00:00:00Z")
    expect(field(lines[3]!, "harness")).toBe("opencode")
  })

  test("multiple models concatenate", () => {
    const a = makeTcp("m-a", [{ id: "p.one", highest: "L1", levels: [{ level: "L1", durationMs: 100, costUsd: 0.01, input: 1, output: 2, cacheRead: 3, total: 1, skip: 0 }] }])
    const b = makeTcp("m-b", [{ id: "p.two", highest: "L3", levels: [{ level: "L3", durationMs: 200, costUsd: 0.02, input: 4, output: 5, cacheRead: 6, total: 2, skip: 0 }] }])
    const lines = profileCostCsv([a, b]).trim().split("\n")
    expect(lines).toHaveLength(3)
    expect(field(lines[1]!, "model")).toBe("m-a")
    expect(field(lines[1]!, "primitive")).toBe("p.one")
    expect(field(lines[2]!, "model")).toBe("m-b")
    expect(field(lines[2]!, "primitive")).toBe("p.two")
  })
})
