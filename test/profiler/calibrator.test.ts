import { test, expect, describe } from "bun:test"
import { detectInversions, resolveInversion } from "../../src/profiler/calibrator.ts"
import type { PrimitiveResult, LevelResult } from "../../src/profiler/types.ts"

function makeLevelResult(level: "L1" | "L2" | "L3", passed: boolean, passCount = passed ? 3 : 1): LevelResult {
  return {
    level,
    passed,
    passCount,
    totalCount: 3,
    skipCount: 0,
    instances: [],
    durationMs: 1000,
    costUsd: 0.01,
  }
}

describe("detectInversions", () => {
  test("no inversion when levels are consistent", () => {
    const results: PrimitiveResult[] = [{
      primitiveId: "gen.code.python",
      highestLevel: "L2",
      levelResults: [
        makeLevelResult("L3", false),
        makeLevelResult("L2", true),
        // L1 skipped (progressive)
      ],
    }]
    expect(detectInversions(results)).toHaveLength(0)
  })

  test("detects inversion: L3 passed but L2 failed", () => {
    const results: PrimitiveResult[] = [{
      primitiveId: "gen.code.python",
      highestLevel: "L3",
      levelResults: [
        makeLevelResult("L3", true),
        makeLevelResult("L2", false),
        makeLevelResult("L1", true),
      ],
    }]
    const inversions = detectInversions(results)
    expect(inversions).toHaveLength(1)
    expect(inversions[0]!.primitiveId).toBe("gen.code.python")
    expect(inversions[0]!.higherLevel).toBe("L3")
    expect(inversions[0]!.lowerLevel).toBe("L2")
  })

  test("detects multiple inversions across primitives", () => {
    const results: PrimitiveResult[] = [
      {
        primitiveId: "gen.code.python",
        highestLevel: "L3",
        levelResults: [
          makeLevelResult("L3", true),
          makeLevelResult("L2", false),
        ],
      },
      {
        primitiveId: "reason.arithmetic",
        highestLevel: "L2",
        levelResults: [
          makeLevelResult("L2", true),
          makeLevelResult("L1", false),
        ],
      },
    ]
    const inversions = detectInversions(results)
    expect(inversions).toHaveLength(2)
  })

  test("no inversion when only one level tested", () => {
    const results: PrimitiveResult[] = [{
      primitiveId: "gen.code.python",
      highestLevel: "L3",
      levelResults: [makeLevelResult("L3", true)],
    }]
    expect(detectInversions(results)).toHaveLength(0)
  })
})

describe("resolveInversion", () => {
  test("majority pass → resolved as passed", () => {
    const original = makeLevelResult("L2", false, 1) // 1/3
    const rerun = makeLevelResult("L2", true, 3) // 3/3
    // Total: 4/6 → passes
    expect(resolveInversion(original, rerun)).toBe(true)
  })

  test("majority fail → resolved as failed", () => {
    const original = makeLevelResult("L2", false, 0) // 0/3
    const rerun = makeLevelResult("L2", false, 1) // 1/3
    // Total: 1/6 → fails
    expect(resolveInversion(original, rerun)).toBe(false)
  })
})
