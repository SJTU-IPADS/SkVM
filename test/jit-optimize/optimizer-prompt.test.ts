import { describe, expect, test } from "bun:test"
import { buildOptimizerPrompt } from "../../src/jit-optimize/optimizer.ts"

/**
 * Prompt contract tests. These assert that specific load-bearing phrases the
 * rest of the system depends on stay in the prompt. They intentionally do
 * NOT try to validate full wording — the point is to catch accidental
 * regressions when the prompt is edited.
 */
describe("buildOptimizerPrompt", () => {
  test("references the task-first workspace layout", () => {
    const p = buildOptimizerPrompt(4, 0)
    expect(p).toContain("PER_TASK_SUMMARY.md")
    expect(p).toContain("tasks/<safeTaskId>")
    expect(p).toContain("run-N.md")
  })

  test("requires reading PER_TASK_SUMMARY before the per-task directories", () => {
    const p = buildOptimizerPrompt(4, 0)
    const summaryIdx = p.indexOf("PER_TASK_SUMMARY.md")
    const taskDirIdx = p.indexOf("tasks/<safeTaskId>")
    expect(summaryIdx).toBeGreaterThan(-1)
    expect(taskDirIdx).toBeGreaterThan(-1)
    expect(summaryIdx).toBeLessThan(taskDirIdx)
  })

  test("contains the Pre-Edit Checklist 5(d) No-trade-off test", () => {
    const p = buildOptimizerPrompt(4, 0)
    expect(p).toContain("No-trade-off test")
    // Language that should survive edits — it is what the rule is about.
    expect(p).toContain("PASSING")
    expect(p).toContain("per-task regression gate")
  })

  test("contains the Hard Rule 'No task trade-off' invoking Pareto-non-inferiority", () => {
    const p = buildOptimizerPrompt(4, 0)
    expect(p).toContain("No task trade-off")
    expect(p).toContain("Pareto-non-inferior")
  })

  test("keeps the existing generality + task-content-agnostic guards", () => {
    // These are the prior defences against content overfitting. The new
    // No-trade-off rule is orthogonal — if the prior rules get deleted
    // by accident, this test catches it.
    const p = buildOptimizerPrompt(4, 0)
    expect(p).toContain("Generality test")
    expect(p).toContain("Task-content-agnostic")
  })

  test("history section appears only when historyCount > 0", () => {
    const none = buildOptimizerPrompt(2, 0)
    expect(none).not.toContain("history.md")
    const some = buildOptimizerPrompt(2, 3)
    expect(some).toContain("history.md")
    expect(some).toContain("3 previous optimization round(s)")
  })

  test("Evidence Indices contract for blockedEvidenceIds is still present", () => {
    // Downstream validation reads `blockedEvidenceIds` as indices matching
    // the global flat numbering shown in PER_TASK_SUMMARY.md. The prompt
    // must tell the optimizer to use that numbering, not the per-task
    // local numbering.
    const p = buildOptimizerPrompt(4, 0)
    expect(p).toContain("Evidence Indices")
    expect(p).toContain("blockedEvidenceIds")
  })
})

// ---------------------------------------------------------------------------
// Target-model awareness (profile-derived, mirroring pass-1's directives)
// ---------------------------------------------------------------------------

import type { TCP, Level } from "../../src/core/types.ts"

function makeTcp(capabilities: Record<string, Level>): TCP {
  return {
    version: "1.0",
    model: "example/weak-model",
    harness: "bare-agent",
    profiledAt: "2026-01-01T00:00:00Z",
    capabilities,
    details: [],
    cost: { totalUsd: 0, totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, durationMs: 0 },
    isPartial: false,
  }
}

const WEAK_CAPS: Record<string, Level> = {
  "gen.code.shell": "L2", "gen.text.long": "L0", "gen.regex": "L1",
  "reason.planning": "L1", "tool.exec": "L2", "tool.call.format": "L2",
  "follow.procedure": "L1",
}
const STRONG_CAPS: Record<string, Level> = {
  "gen.code.shell": "L3", "reason.planning": "L3", "tool.exec": "L3",
  "tool.call.format": "L3", "follow.procedure": "L3",
}

describe("buildOptimizerPrompt — target-model awareness", () => {
  test("without target: no Target Model section, conservative budget unchanged", () => {
    const p = buildOptimizerPrompt(4, 0)
    expect(p).not.toContain("## Target Model")
    expect(p).toContain("net diff under ~50 added lines")
  })

  test("weak-profile target on a gated run: identity + derived directives + deletion license", () => {
    const p = buildOptimizerPrompt(4, 0, {
      model: "example/weak-model",
      harness: "bare-agent",
      tcp: makeTcp(WEAK_CAPS),
    }, true)
    expect(p).toContain("## Target Model")
    expect(p).toContain("example/weak-model")
    // Derived directive from tool.call.format=L2 (scaffold rule)
    expect(p).toContain("one-liner")
    // Deletion becomes a first-class move for weak profiles
    expect(p).toContain("Deleting")
    expect(p).toContain("per-task regression gate protects")
    // The flat +50-line additive budget must NOT be the operative rule
    expect(p).not.toContain("net diff under ~50 added lines")
  })

  test("weak-profile target on an ungated run: deletion license softened, no gate claim", () => {
    const p = buildOptimizerPrompt(4, 0, {
      model: "example/weak-model",
      harness: "bare-agent",
      tcp: makeTcp(WEAK_CAPS),
    }, false)
    expect(p).toContain("nothing re-checks your output")
    expect(p).not.toContain("per-task regression gate protects")
    // Weak-profile size posture still applies — only the license changes.
    expect(p).not.toContain("net diff under ~50 added lines")
  })

  test("strong-profile target: identity present, conservative editing retained", () => {
    const p = buildOptimizerPrompt(4, 0, {
      model: "example/strong-model",
      harness: "bare-agent",
      tcp: makeTcp(STRONG_CAPS),
    })
    expect(p).toContain("## Target Model")
    expect(p).toContain("example/strong-model")
    expect(p).toContain("net diff under ~50 added lines")
    expect(p).not.toContain("one-liner")
  })

  test("target without TCP: identity only, conservative editing retained", () => {
    const p = buildOptimizerPrompt(4, 0, { model: "m/x", harness: "bare-agent" })
    expect(p).toContain("## Target Model")
    expect(p).toContain("m/x")
    expect(p).toContain("net diff under ~50 added lines")
  })
})

describe("buildOptimizerPrompt — the middle tier", () => {
  const MID_CAPS: Record<string, Level> = {
    "gen.code.shell": "L3", "reason.planning": "L3", "tool.exec": "L3",
    "tool.call.format": "L3", "follow.procedure": "L2",
  }

  test("an L2 target gets one coherent posture, not both", () => {
    // `sizeBudgetFraction < 1.0` read L2 as "weak", so the prompt carried the cut-weight posture
    // AND the line saying the profile shows no systematic weaknesses. Whichever the model obeyed
    // was a coin flip.
    const p = buildOptimizerPrompt(4, 0, {
      model: "example/mid-model",
      harness: "bare-agent",
      tcp: makeTcp(MID_CAPS),
    }, true)

    expect(p).toContain("follow.procedure=L2")
    expect(p).not.toContain("no systematic weaknesses; make only evidence-targeted edits")
    expect(p).not.toContain("a net NEGATIVE diff is the expected shape")
    expect(p).not.toContain("net diff under ~50 added lines")
    expect(p).toContain("net-neutral in size")
  })

  test("the middle tier still narrows its deletion licence without a gate", () => {
    const gated = buildOptimizerPrompt(4, 0, {
      model: "example/mid-model", harness: "bare-agent", tcp: makeTcp(MID_CAPS),
    }, true)
    const ungated = buildOptimizerPrompt(4, 0, {
      model: "example/mid-model", harness: "bare-agent", tcp: makeTcp(MID_CAPS),
    }, false)

    expect(ungated).toContain("NO evaluation gate")
    expect(gated).not.toContain("NO evaluation gate")
  })

  test("a deep-tier target keeps the cut-weight posture", () => {
    const p = buildOptimizerPrompt(4, 0, {
      model: "example/weak-model", harness: "bare-agent", tcp: makeTcp(WEAK_CAPS),
    }, true)
    expect(p).toContain("a net NEGATIVE diff is the expected shape")
  })
})
