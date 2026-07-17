import { test, expect, describe } from "bun:test"
import { deriveDirectives } from "../../src/compiler/passes/rewrite-skill/directives.ts"
import type { TCP, Level } from "../../src/core/types.ts"

function makeTcp(capabilities: Record<string, Level>): TCP {
  return {
    version: "1.0",
    model: "test/model",
    harness: "bare-agent",
    profiledAt: "2026-01-01T00:00:00Z",
    capabilities,
    details: [],
    cost: { totalUsd: 0, totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, durationMs: 0 },
    isPartial: false,
  }
}

const STRONG: Record<string, Level> = {
  "gen.code.python": "L3", "gen.code.shell": "L3", "gen.text.structured": "L3",
  "reason.planning": "L3", "reason.logic": "L3",
  "tool.exec": "L3", "tool.call.format": "L3", "tool.file.write": "L3",
  "follow.procedure": "L3",
}

// A weak profile: mixed levels, weak tool formatting and procedure-following.
const WEAK: Record<string, Level> = {
  "gen.code.python": "L2", "gen.code.shell": "L2", "gen.text.structured": "L3",
  "gen.text.long": "L0", "gen.regex": "L1",
  "reason.planning": "L1", "reason.logic": "L2", "reason.analysis": "L1",
  "tool.exec": "L2", "tool.call.format": "L2", "tool.file.write": "L3",
  "follow.procedure": "L1",
}

describe("deriveDirectives", () => {
  test("strong model: full size budget, no weak-model rules", () => {
    const d = deriveDirectives(makeTcp(STRONG))
    expect(d.sizeBudgetFraction).toBe(1.0)
    expect(d.rules).toHaveLength(0)
  })

  test("weak model: deep-distillation budget", () => {
    const d = deriveDirectives(makeTcp(WEAK))
    expect(d.sizeBudgetFraction).toBe(0.4)
  })

  test("weak tool formatting triggers the script-scaffold rule with evidence", () => {
    const d = deriveDirectives(makeTcp(WEAK))
    const rule = d.rules.find((r) => r.directive.includes("write_file") && r.directive.includes("one-liner"))
    expect(rule).toBeDefined()
    expect(rule!.evidence).toContain("tool.call.format=L2")
  })

  test("weak tool execution triggers the no-repeat rule", () => {
    const d = deriveDirectives(makeTcp(WEAK))
    expect(d.rules.some((r) => r.directive.includes("same command"))).toBe(true)
  })

  test("weak procedure-following triggers the linear-path rule", () => {
    const d = deriveDirectives(makeTcp(WEAK))
    expect(d.rules.some((r) => r.directive.includes("single fixed"))).toBe(true)
  })

  test("low overall score triggers the engagement contract", () => {
    const d = deriveDirectives(makeTcp(WEAK))
    const rule = d.rules.find((r) => r.directive.includes("first tool call"))
    expect(rule).toBeDefined()
    expect(rule!.evidence).toContain("capability score")
  })

  test("mid-tier model: partial budget, only level-triggered rules", () => {
    // follow.procedure=L2 → 0.7 budget; score 23/27 ≈ 0.85 ≥ 0.7 → no engagement contract
    const mid: Record<string, Level> = {
      "gen.code.python": "L3", "gen.code.shell": "L2", "gen.text.structured": "L3",
      "reason.planning": "L3", "reason.logic": "L2",
      "tool.exec": "L3", "tool.call.format": "L2", "tool.file.write": "L3",
      "follow.procedure": "L2",
    }
    const d = deriveDirectives(makeTcp(mid))
    expect(d.sizeBudgetFraction).toBe(0.7)
    // scaffold rule fires (tool.call.format L2), engagement contract does not (score ≥ 0.7)
    expect(d.rules.some((r) => r.directive.includes("one-liner"))).toBe(true)
    expect(d.rules.some((r) => r.directive.includes("first tool call"))).toBe(false)
  })

  test("budget is keyed on follow.procedure, not the global score", () => {
    // Mid global score but follow.procedure=L3 → full budget; distillation
    // would strip procedure content this model handles well.
    const proceduralButMid: Record<string, Level> = {
      ...WEAK,
      "follow.procedure": "L3",
    }
    expect(deriveDirectives(makeTcp(proceduralButMid)).sizeBudgetFraction).toBe(1.0)

    // Conversely: high global score but weak procedure-following still needs
    // deep distillation.
    const strongButNonProcedural: Record<string, Level> = {
      ...STRONG,
      "follow.procedure": "L1",
    }
    expect(deriveDirectives(makeTcp(strongButNonProcedural)).sizeBudgetFraction).toBe(0.4)
  })

  test("every rule carries its triggering evidence", () => {
    const d = deriveDirectives(makeTcp(WEAK))
    expect(d.rules.length).toBeGreaterThan(0)
    for (const r of d.rules) {
      expect(r.evidence.length).toBeGreaterThan(0)
    }
  })

  test("empty capabilities: treated as fully unprofiled — no directives, full budget", () => {
    const d = deriveDirectives(makeTcp({}))
    expect(d.sizeBudgetFraction).toBe(1.0)
    expect(d.rules).toHaveLength(0)
  })

  test("non-bare harnesses never get bare-agent tool names in directives", () => {
    const tcp = { ...makeTcp(WEAK), harness: "claude-code" }
    const d = deriveDirectives(tcp)
    expect(d.rules.length).toBeGreaterThan(0)
    for (const r of d.rules) {
      expect(r.directive).not.toContain("write_file")
      expect(r.directive).not.toContain("execute_command")
    }
  })
})

describe("deriveDirectives — tier boundaries", () => {
  test("each follow.procedure level maps to a distinct tier", () => {
    // Consumers must not re-derive "weak" from `sizeBudgetFraction < 1.0`: that reading collapses
    // L2 into the deep-distillation branch, and the middle tier then receives both
    // "evidence-targeted edits only" and "a net negative diff is expected".
    expect(deriveDirectives(makeTcp({ ...STRONG, "follow.procedure": "L3" })).tier).toBe("keep")
    expect(deriveDirectives(makeTcp({ ...STRONG, "follow.procedure": "L2" })).tier).toBe("moderate")
    expect(deriveDirectives(makeTcp({ ...STRONG, "follow.procedure": "L1" })).tier).toBe("deep")
    expect(deriveDirectives(makeTcp({ ...STRONG, "follow.procedure": "L0" })).tier).toBe("deep")
  })

  test("follow.procedure absent from a populated profile makes no claim either way", () => {
    // A scoped profile (--primitives=) or an externally supplied TCP can omit the primitive.
    // Reading that as "long documents are safe for this model" manufactures a capability from
    // missing data — the same case `atOrBelow` already refuses to rule on.
    const { "follow.procedure": _omitted, ...withoutFollow } = STRONG
    const d = deriveDirectives(makeTcp(withoutFollow))
    expect(d.tier).toBe("keep")
    expect(d.sizeBudgetFraction).toBe(1.0)
    expect(d.budgetRationale).toContain("unprofiled")
    expect(d.budgetRationale).not.toContain("safe for this model")
  })

  test("an empty profile is conservative and claims nothing", () => {
    const d = deriveDirectives(makeTcp({}))
    expect(d.tier).toBe("keep")
    expect(d.rules).toEqual([])
  })
})
