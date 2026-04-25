import { describe, expect, test } from "bun:test"
import {
  ALL_PASSES,
  defaultPasses,
  formatRegistry,
  getPassById,
  getPassByNumber,
  resolvePassTokens,
  topoSort,
  validateDeps,
} from "../../src/compiler/registry.ts"
import type { CompilerPass } from "../../src/compiler/passes/types.ts"
import type { ArtifactKey } from "../../src/compiler/artifacts.ts"

describe("registry invariants", () => {
  test("ALL_PASSES has unique ids", () => {
    const ids = ALL_PASSES.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("ALL_PASSES has unique positive numbers", () => {
    const numbers = ALL_PASSES.map((p) => p.number)
    expect(new Set(numbers).size).toBe(numbers.length)
    for (const n of numbers) {
      expect(Number.isInteger(n)).toBe(true)
      expect(n).toBeGreaterThanOrEqual(1)
    }
  })
})

describe("registry token resolution", () => {
  test("resolves numeric tokens to passes by number", () => {
    const passes = resolvePassTokens(["1", "2", "3"])
    expect(passes.map((p) => p.id)).toEqual([
      "rewrite-skill",
      "bind-env",
      "extract-parallelism",
    ])
  })

  test("resolves string ids to passes", () => {
    const passes = resolvePassTokens(["bind-env", "rewrite-skill"])
    expect(passes.map((p) => p.id)).toEqual(["rewrite-skill", "bind-env"])
  })

  test("accepts mixed numeric and string tokens, returns sorted by number", () => {
    const passes = resolvePassTokens(["3", "rewrite-skill"])
    expect(passes.map((p) => p.number)).toEqual([1, 3])
  })

  test("deduplicates repeats", () => {
    const passes = resolvePassTokens(["1", "rewrite-skill", "1"])
    expect(passes.map((p) => p.id)).toEqual(["rewrite-skill"])
  })

  test("throws on unknown token with helpful message", () => {
    expect(() => resolvePassTokens(["bogus"])).toThrow(/Unknown pass: "bogus"/)
    expect(() => resolvePassTokens(["99"])).toThrow(/Unknown pass: "99"/)
  })

  test("getPassById and getPassByNumber agree", () => {
    for (const pass of ALL_PASSES) {
      expect(getPassById(pass.id)).toBe(pass)
      expect(getPassByNumber(pass.number)).toBe(pass)
    }
  })

  test("defaultPasses returns all registered, sorted by number", () => {
    const passes = defaultPasses()
    expect(passes).toHaveLength(ALL_PASSES.length)
    for (let i = 1; i < passes.length; i++) {
      expect(passes[i]!.number).toBeGreaterThan(passes[i - 1]!.number)
    }
  })

  test("formatRegistry produces a non-empty table", () => {
    const out = formatRegistry()
    expect(out).toContain("rewrite-skill")
    expect(out).toContain("bind-env")
    expect(out).toContain("extract-parallelism")
  })
})

describe("topoSort", () => {
  function mkPass(
    id: string,
    number: number,
    consumes: ArtifactKey[] = [],
    produces: ArtifactKey[] = [],
  ): CompilerPass {
    return {
      id,
      number,
      description: id,
      consumes,
      produces,
      run: async () => ({ artifacts: {}, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    }
  }

  test("respects consumes/produces ordering", () => {
    // B consumes scr produced by A — even if input order is reversed, A must run first
    const a = mkPass("produce-scr", 1, [], ["scr"])
    const b = mkPass("consume-scr", 2, ["scr"], [])
    const ordered = topoSort([b, a])
    expect(ordered.map((p) => p.id)).toEqual(["produce-scr", "consume-scr"])
  })

  test("falls back to number ordering when no deps", () => {
    const a = mkPass("a", 5)
    const b = mkPass("b", 2)
    const c = mkPass("c", 7)
    const ordered = topoSort([a, b, c])
    expect(ordered.map((p) => p.number)).toEqual([2, 5, 7])
  })

  test("detects cycles", () => {
    const a = mkPass("a", 1, ["scr"], ["dag"])
    const b = mkPass("b", 2, ["dag"], ["scr"])
    expect(() => topoSort([a, b])).toThrow(/Cyclic pass dependency/)
  })
})

describe("validateDeps", () => {
  function mkPass(
    id: string,
    consumes: ArtifactKey[],
    produces: ArtifactKey[] = [],
  ): CompilerPass {
    return {
      id,
      number: 1,
      description: id,
      consumes,
      produces,
      run: async () => ({ artifacts: {}, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    }
  }

  test("passes when consumed artifacts are produced by another enabled pass", () => {
    const errors = validateDeps(
      [mkPass("p", [], ["scr"]), mkPass("q", ["scr"])],
      new Set(),
    )
    expect(errors).toEqual([])
  })

  test("passes when consumed artifacts come from cache", () => {
    const errors = validateDeps(
      [mkPass("q", ["scr"])],
      new Set<ArtifactKey>(["scr"]),
    )
    expect(errors).toEqual([])
  })

  test("errors when a consume isn't satisfied", () => {
    const errors = validateDeps([mkPass("q", ["scr"])], new Set())
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Pass "q" consumes artifact "scr"')
  })
})
