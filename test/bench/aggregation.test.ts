import { test, expect, describe } from "bun:test"
import { averageConditionResults } from "../../src/bench/orchestrator.ts"
import type { ConditionResult, TaskReport } from "../../src/bench/types.ts"
import { generateReport } from "../../src/bench/reporter.ts"

function makeResult(overrides: Partial<ConditionResult>): ConditionResult {
  return {
    condition: "original",
    score: 1.0,
    pass: true,
    evalDetails: [],
    tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    cost: 0.01,
    durationMs: 1000,
    llmDurationMs: 800,
    steps: 5,
    runStatus: "ok",
    ...overrides,
  }
}

describe("averageConditionResults — runsPerTask aggregation", () => {
  test("all-ok: averages scores normally and stays 'ok'", () => {
    const merged = averageConditionResults([
      makeResult({ score: 1.0 }),
      makeResult({ score: 0.5 }),
      makeResult({ score: 0.5 }),
    ])
    expect(merged.runStatus).toBe("ok")
    expect(merged.score).toBeCloseTo(2.0 / 3, 3)
    expect(merged.pass).toBe(true)
    expect(merged.runScores).toEqual([1.0, 0.5, 0.5])
  })

  test("one tainted run taints the aggregate regardless of order", () => {
    // Regression for two stacked Codex findings:
    //   round 1 — order-dependent runStatus from `...runs[0]` spread
    //   round 2 — score=0/pass=false invariant on tainted aggregates so
    //             downstream readers (compare.ts, console table) cannot
    //             surface the original false-positive.
    const okFirst = averageConditionResults([
      makeResult({ score: 0.9 }),
      makeResult({ score: 0, runStatus: "timeout", statusDetail: "killed" }),
    ])
    const taintedFirst = averageConditionResults([
      makeResult({ score: 0, runStatus: "timeout", statusDetail: "killed" }),
      makeResult({ score: 0.9 }),
    ])
    // Both orderings produce the exact same aggregate.
    expect(okFirst.runStatus).not.toBe("ok")
    expect(taintedFirst.runStatus).not.toBe("ok")
    expect(okFirst.pass).toBe(false)
    expect(taintedFirst.pass).toBe(false)
    // Tainted aggregate ⇒ score=0 (runner-gate invariant). The real per-run
    // scores stay visible via runScores for forensics.
    expect(okFirst.score).toBe(0)
    expect(taintedFirst.score).toBe(0)
    expect(okFirst.runScores).toEqual([0.9, 0])
    expect(taintedFirst.runScores).toEqual([0, 0.9])
  })

  test("all tainted: aggregate is tainted with score=0", () => {
    const merged = averageConditionResults([
      makeResult({ score: 0, runStatus: "timeout" }),
      makeResult({ score: 0, runStatus: "adapter-crashed" }),
    ])
    expect(merged.runStatus).not.toBe("ok")
    expect(merged.score).toBe(0)
    expect(merged.pass).toBe(false)
  })

  test("token/cost averages skip telemetry-less runs; availability is order-independent", () => {
    const withTelemetry = makeResult({
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      cost: 0.02,
    })
    const withoutTelemetry = makeResult({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      usageAvailable: false,
    })
    // Both orderings: averages over the telemetry-bearing run only, and the
    // aggregate is "available" even when the telemetry-less run came first
    // (the old runs[0] spread made this order-dependent).
    for (const runs of [[withTelemetry, withoutTelemetry], [withoutTelemetry, withTelemetry]]) {
      const merged = averageConditionResults(runs)
      expect(merged.tokens.input).toBe(100)
      expect(merged.cost).toBeCloseTo(0.02)
      expect(merged.usageAvailable).toBe(true)
    }
  })

  test("no run has telemetry: aggregate is unavailable with zero tokens", () => {
    const merged = averageConditionResults([
      makeResult({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, usageAvailable: false }),
      makeResult({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, usageAvailable: false }),
    ])
    expect(merged.usageAvailable).toBe(false)
    expect(merged.tokens.input).toBe(0)
    expect(merged.cost).toBe(0)
  })
})

describe("reporter summary — usage-telemetry sentinel", () => {
  test("rows with usageAvailable=false are excluded from token/cost averages", () => {
    const tasks: TaskReport[] = [{
      taskId: "t1",
      taskName: "t1",
      category: "cat",
      gradingType: "automated",
      conditions: [
        makeResult({ condition: "original", tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }, cost: 0.02 }),
      ],
    }, {
      taskId: "t2",
      taskName: "t2",
      category: "cat",
      gradingType: "automated",
      conditions: [
        // A jiuwenclaw-style row: zero-filled tokens, no telemetry. Counting
        // it would halve the average with a fake zero.
        makeResult({ condition: "original", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, usageAvailable: false }),
      ],
    }]
    const report = generateReport("test", {
      model: "m", adapter: "a", conditions: ["original"],
    } as any, tasks)

    const original = report.summary.perCondition.original
    expect(original?.avgTokens).toBe(150)
    expect(original?.avgCost).toBeCloseTo(0.02)
  })

  test("condition where no row has usage telemetry reports avgTokens/avgCost=null", () => {
    const tasks: TaskReport[] = [{
      taskId: "t1",
      taskName: "t1",
      category: "cat",
      gradingType: "automated",
      conditions: [
        makeResult({ condition: "original", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, usageAvailable: false }),
      ],
    }]
    const report = generateReport("test", {
      model: "m", adapter: "a", conditions: ["original"],
    } as any, tasks)

    const original = report.summary.perCondition.original
    expect(original?.avgTokens).toBeNull()
    expect(original?.avgCost).toBeNull()
    // avgScore is unaffected — telemetry availability is orthogonal to evaluability.
    expect(original?.avgScore).toBe(1.0)
  })
})

describe("reporter summary — empty-denominator sentinel", () => {
  test("condition with only tainted rows reports avgScore=null and passRate=null", () => {
    // Regression for Codex P2: fully tainted conditions were reported as
    // 0.00 / 0%, indistinguishable from "evaluated and failed".
    const tasks: TaskReport[] = [{
      taskId: "t1",
      taskName: "t1",
      category: "cat",
      gradingType: "automated",
      conditions: [
        makeResult({ condition: "no-skill", score: 0.8, runStatus: "ok" }),
        makeResult({ condition: "original", score: 0, runStatus: "timeout" }),
      ],
    }]
    const report = generateReport("test", {
      model: "m", adapter: "a", conditions: ["no-skill", "original"],
    } as any, tasks)

    const noSkill = report.summary.perCondition["no-skill"]
    const original = report.summary.perCondition.original
    expect(noSkill?.avgScore).toBe(0.8)
    expect(noSkill?.passRate).toBe(1)
    expect(original?.avgScore).toBeNull()
    expect(original?.passRate).toBeNull()
    expect(original?.taintedCount).toBe(1)
    expect(original?.evaluableCount).toBe(0)
  })

  test("condition with mixed tainted + evaluable rows reports real avg", () => {
    const tasks: TaskReport[] = [{
      taskId: "t1",
      taskName: "t1",
      category: "cat",
      gradingType: "automated",
      conditions: [
        makeResult({ condition: "original", score: 1.0, runStatus: "ok" }),
      ],
    }, {
      taskId: "t2",
      taskName: "t2",
      category: "cat",
      gradingType: "automated",
      conditions: [
        makeResult({ condition: "original", score: 0, runStatus: "timeout" }),
      ],
    }]
    const report = generateReport("test", {
      model: "m", adapter: "a", conditions: ["original"],
    } as any, tasks)

    const original = report.summary.perCondition.original
    expect(original?.avgScore).toBe(1.0) // only the evaluable row counts
    expect(original?.passRate).toBe(1)
    expect(original?.taintedCount).toBe(1)
    expect(original?.evaluableCount).toBe(1)
  })
})
