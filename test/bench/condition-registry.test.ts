import { describe, test, expect } from "bun:test"
import { CONDITION_RUNNERS, resolveConditionKind } from "../../src/bench/conditions/index.ts"
import type { ConditionKind } from "../../src/bench/conditions/types.ts"
import { BENCH_CONDITIONS } from "../../src/bench/types.ts"

// Runtime mirror of the ConditionKind union. The `satisfies` clause on
// CONDITION_RUNNERS already makes a missing runner a compile error; this
// keeps the runtime shape honest too (e.g. against accidental `as` casts).
const ALL_KINDS = ["no-skill", "original", "jit-optimized", "jit-boost", "aot-variant"] as const satisfies readonly ConditionKind[]

describe("bench/conditions registry", () => {
  test("every ConditionKind has a runner with a run() function", () => {
    for (const kind of ALL_KINDS) {
      const runner = CONDITION_RUNNERS[kind]
      expect(runner).toBeDefined()
      expect(typeof runner.run).toBe("function")
    }
  })

  test("the registry contains exactly the known kinds", () => {
    expect(Object.keys(CONDITION_RUNNERS).sort()).toEqual([...ALL_KINDS].sort())
  })

  test("fixed condition names resolve to themselves", () => {
    expect(resolveConditionKind("no-skill")).toBe("no-skill")
    expect(resolveConditionKind("original")).toBe("original")
    expect(resolveConditionKind("jit-optimized")).toBe("jit-optimized")
    expect(resolveConditionKind("jit-boost")).toBe("jit-boost")
  })

  test("AOT pass-glob conditions resolve to aot-variant", () => {
    expect(resolveConditionKind("aot-compiled")).toBe("aot-variant")
    expect(resolveConditionKind("aot-compiled-p1")).toBe("aot-variant")
    expect(resolveConditionKind("aot-compiled-p12")).toBe("aot-variant")
    expect(resolveConditionKind("aot-compiled-p23")).toBe("aot-variant")
    expect(resolveConditionKind("aot-compiled-p123")).toBe("aot-variant")
  })

  test("unknown conditions resolve to null", () => {
    expect(resolveConditionKind("bogus")).toBeNull()
    expect(resolveConditionKind("aot-compiled-p4")).toBeNull()
    expect(resolveConditionKind("")).toBeNull()
  })

  test("every standard bench condition resolves to a registered runner", () => {
    for (const condition of BENCH_CONDITIONS) {
      const kind = resolveConditionKind(condition)
      expect(kind).not.toBeNull()
      expect(CONDITION_RUNNERS[kind!]).toBeDefined()
    }
  })
})
