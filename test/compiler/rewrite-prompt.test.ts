import { test, expect, describe } from "bun:test"
import { buildInitialMessage } from "../../src/compiler/passes/rewrite-skill/agent.ts"
import type { TCP, SCR, Level } from "../../src/core/types.ts"

function makeTcp(capabilities: Record<string, Level>, harness = "bare-agent"): TCP {
  return {
    version: "1.0",
    model: "test/model",
    harness,
    profiledAt: "2026-01-01T00:00:00Z",
    capabilities,
    details: [],
    cost: { totalUsd: 0, totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, durationMs: 0 },
    isPartial: false,
  }
}

const SCR_FIXTURE: SCR = {
  skillName: "demo",
  purposes: [{
    id: "p1",
    description: "do the thing",
    currentPath: { primitives: [{ id: "gen.code.python", minLevel: "L2", evidence: "writes a script" }] },
    alternativePaths: [],
  }],
}

const WEAK: Record<string, Level> = {
  "gen.code.python": "L1", "gen.code.shell": "L1", "tool.call.format": "L1",
  "tool.exec": "L1", "follow.procedure": "L1", "reason.planning": "L1",
}

/** The stated budget, parsed back out of the prompt. */
function budgetOf(prompt: string): number {
  const m = prompt.match(/must be \*\*at most (\d+) lines\*\*/)
  if (!m) throw new Error("no size budget in prompt")
  return Number(m[1])
}

describe("compilation prompt — size budget", () => {
  test("a short skill on the weakest tier is never handed an expansion licence", () => {
    // The clamp floored the budget at 60 lines, so a 45-line skill was told "distill deeply …
    // at most 60 lines" — a 33% expansion, with a rationale saying the opposite.
    const skill = ["---", "name: demo", "description: A short demo skill for testing budgets.", "---",
      ...Array.from({ length: 41 }, (_, i) => `Line ${i + 1}`)].join("\n")
    const origLines = skill.split("\n").length
    expect(origLines).toBeLessThan(60)

    const prompt = buildInitialMessage(SCR_FIXTURE, [], makeTcp(WEAK), skill, [])
    expect(budgetOf(prompt)).toBeLessThanOrEqual(origLines)
  })

  test("a long skill on the weakest tier still gets a real cut", () => {
    const skill = ["---", "name: demo", "description: A long demo skill for testing budgets.", "---",
      ...Array.from({ length: 400 }, (_, i) => `Line ${i + 1}`)].join("\n")
    const prompt = buildInitialMessage(SCR_FIXTURE, [], makeTcp(WEAK), skill, [])
    const budget = budgetOf(prompt)
    expect(budget).toBeLessThanOrEqual(200)
    expect(budget).toBeGreaterThan(0)
  })

  test("a keep-tier target is told to hold the original length", () => {
    const skill = ["---", "name: demo", "description: A demo skill kept at original length.", "---",
      ...Array.from({ length: 120 }, (_, i) => `Line ${i + 1}`)].join("\n")
    const strong: Record<string, Level> = { "follow.procedure": "L3", "gen.code.python": "L3" }
    const prompt = buildInitialMessage(SCR_FIXTURE, [], makeTcp(strong), skill, [])
    expect(budgetOf(prompt)).toBe(skill.split("\n").length)
  })
})

describe("compilation prompt — harness-conditional tool naming", () => {
  test("a non-bare harness is never told to use bare-agent's tool names", () => {
    const skill = ["---", "name: demo", "description: A demo skill for harness wording.", "---",
      ...Array.from({ length: 80 }, (_, i) => `Line ${i + 1}`)].join("\n")
    const prompt = buildInitialMessage(SCR_FIXTURE, [], makeTcp(WEAK, "opencode"), skill, [])

    // The directives section must not prescribe tools this harness may not expose.
    const directives = prompt.slice(prompt.indexOf("## Size budget"), prompt.indexOf("## Skill"))
    expect(directives).not.toContain("write_file")
    expect(directives).not.toContain("execute_command")
  })
})
