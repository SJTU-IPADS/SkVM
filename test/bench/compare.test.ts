import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  generateCompareBenchSkillMarkdown,
  generateCompareSkillDiffMarkdown,
  matchesConditionResultSkill,
  summarizeTextDiff,
  writeCompareBenchSkillOutputs,
} from "../../src/bench/compare.ts"
import type { CompareBenchSkillReport, SkillReference } from "../../src/bench/compare.ts"
import type { ConditionResult } from "../../src/bench/types.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function mockSkillReference(overrides: Partial<SkillReference> = {}): SkillReference {
  return {
    inputPath: "skvm-data/skills/calendar",
    resolvedInputPath: "/root/feh/skillvm/skvm-data/skills/calendar",
    skillId: "calendar",
    skillDir: "/root/feh/skillvm/skvm-data/skills/calendar",
    candidateSkillPaths: [
      "/root/feh/skillvm/skvm-data/skills/calendar/SKILL.md",
    ],
    ...overrides,
  }
}

function mockConditionResult(overrides: Partial<ConditionResult> = {}): ConditionResult {
  return {
    condition: "original",
    score: 0.8,
    pass: true,
    evalDetails: [],
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    durationMs: 1000,
    llmDurationMs: 500,
    steps: 3,
    skillId: "calendar",
    skillPath: "/root/feh/skillvm/skvm-data/skills/calendar/SKILL.md",
    skillPaths: ["/root/feh/skillvm/skvm-data/skills/calendar/SKILL.md"],
    ...overrides,
  }
}

describe("matchesConditionResultSkill", () => {
  test("matches by skill path", () => {
    const skill = mockSkillReference()
    const result = mockConditionResult()
    expect(matchesConditionResultSkill(result, skill)).toBe(true)
  })

  test("matches by skill id when paths differ", () => {
    const skill = mockSkillReference({ candidateSkillPaths: ["/tmp/other/SKILL.md"] })
    const result = mockConditionResult({ skillPath: "/tmp/unrelated/SKILL.md" })
    expect(matchesConditionResultSkill(result, skill)).toBe(true)
  })

  test("does not match unrelated skill", () => {
    const skill = mockSkillReference({ skillId: "calendar", candidateSkillPaths: ["/tmp/one/SKILL.md"] })
    const result = mockConditionResult({ skillId: "todo", skillPath: "/tmp/two/SKILL.md" })
    expect(matchesConditionResultSkill(result, skill)).toBe(false)
  })
})

describe("summarizeTextDiff", () => {
  test("marks identical text correctly", () => {
    const summary = summarizeTextDiff("a\nb\n", "a\nb\n")
    expect(summary.identical).toBe(true)
    expect(summary.commonPrefixLines).toBe(3)
  })

  test("captures changed middle span", () => {
    const lhs = ["one", "two", "three", "four"].join("\n")
    const rhs = ["one", "two changed", "three", "four"].join("\n")
    const summary = summarizeTextDiff(lhs, rhs)
    expect(summary.identical).toBe(false)
    expect(summary.commonPrefixLines).toBe(1)
    expect(summary.commonSuffixLines).toBe(2)
    expect(summary.lhsChangedLines).toEqual(["two"])
    expect(summary.rhsChangedLines).toEqual(["two changed"])
    expect(summary.lhsChangedPreview).toEqual(["two"])
    expect(summary.rhsChangedPreview).toEqual(["two changed"])
  })
})

describe("generateCompareBenchSkillMarkdown", () => {
  test("renders aggregate and task details", () => {
    const report: CompareBenchSkillReport = {
      model: "openrouter/qwen/qwen3.5-122b-a10b",
      adapter: "bare-agent",
      lhs: "original",
      rhs: "aot-compiled-p1",
      skill: mockSkillReference(),
      selections: {
        lhs: {
          condition: "original",
          sessionId: "bench-original-1",
          sessionDir: "/tmp/bench-original-1",
          reportPath: "/tmp/bench-original-1/report.json",
          report: {
            sessionId: "bench-original-1",
            model: "openrouter/qwen/qwen3.5-122b-a10b",
            adapter: "bare-agent",
            timestamp: new Date().toISOString(),
            tasks: [],
            summary: { taskCount: 0, perCondition: {}, perCategory: {}, delta: { originalVsBaseline: null, aotVsOriginal: null, jitVsAot: null } },
          },
          matchedTaskIds: ["task_a"],
          timestamp: 1,
        },
        rhs: {
          condition: "aot-compiled-p1",
          sessionId: "bench-aot-1",
          sessionDir: "/tmp/bench-aot-1",
          reportPath: "/tmp/bench-aot-1/report.json",
          report: {
            sessionId: "bench-aot-1",
            model: "openrouter/qwen/qwen3.5-122b-a10b",
            adapter: "bare-agent",
            timestamp: new Date().toISOString(),
            tasks: [],
            summary: { taskCount: 0, perCondition: {}, perCategory: {}, delta: { originalVsBaseline: null, aotVsOriginal: null, jitVsAot: null } },
          },
          matchedTaskIds: ["task_a"],
          timestamp: 2,
        },
      },
      warnings: ["Task sets differ between the selected sessions; comparison uses task intersection only"],
      unmatchedTaskIds: { lhsOnly: ["task_b"], rhsOnly: [] },
      aggregate: {
        taskCount: 1,
        comparableCount: 1,
        incomparableCount: 0,
        avgScore: { lhs: 0.9, rhs: 0.7, delta: -0.2 },
        passRate: { lhs: 1, rhs: 0, delta: -1 },
        avgTokens: { lhs: 100, rhs: 150, delta: 50 },
        avgDurationMs: { lhs: 1000, rhs: 1400, delta: 400 },
        avgLlmDurationMs: { lhs: 500, rhs: 900, delta: 400 },
        avgSteps: { lhs: 3, rhs: 6, delta: 3 },
      },
      tasks: [{
        taskId: "task_a",
        taskName: "Task A",
        lhs: mockConditionResult({ condition: "original", score: 0.9, evalDetails: [{ method: "llm-judge", score: 0.9, details: "minor issue" }] }),
        rhs: mockConditionResult({ condition: "aot-compiled-p1", score: 0.7, pass: false, evalDetails: [{ method: "llm-judge", score: 0.7, details: "major issue" }] }),
        delta: { score: -0.2, tokens: 50, durationMs: 400, llmDurationMs: 400, steps: 3 },
      }],
      artifacts: {
        lhs: { condition: "original", kind: "original", path: "/tmp/original/SKILL.md", exists: true },
        rhs: { condition: "aot-compiled-p1", kind: "compiled", path: "/tmp/aot/SKILL.md", exists: true },
      },
      artifactDiff: {
        identical: false,
        lhsLineCount: 10,
        rhsLineCount: 12,
        commonPrefixLines: 3,
        commonSuffixLines: 4,
        lhsChangedLines: ["old line"],
        rhsChangedLines: ["new line"],
        lhsChangedPreview: ["old line"],
        rhsChangedPreview: ["new line"],
      },
    }

    const markdown = generateCompareBenchSkillMarkdown(report)
    expect(markdown).toContain("# Skill Compare: original vs aot-compiled-p1")
    expect(markdown).toContain("| Avg Score | 0.900 | 0.700 | -0.200 |")
    expect(markdown).toContain("| task_a | 0.90 | 0.70 | -0.20 | 50 | 3 |")
    expect(markdown).toContain("major issue")
  })

  test("writes output files with adapter and model in the filename", async () => {
    const report: CompareBenchSkillReport = {
      model: "openrouter/qwen/qwen3.5-122b-a10b",
      adapter: "openclaw",
      lhs: "original",
      rhs: "aot-compiled-p1",
      skill: mockSkillReference(),
      warnings: [],
      tasks: [],
      artifacts: {
        lhs: { condition: "original", kind: "original", path: "/tmp/original/SKILL.md", exists: true },
        rhs: { condition: "aot-compiled-p1", kind: "compiled", path: "/tmp/aot/SKILL.md", exists: true },
      },
      artifactDiff: {
        identical: false,
        lhsLineCount: 1,
        rhsLineCount: 1,
        commonPrefixLines: 0,
        commonSuffixLines: 0,
        lhsChangedLines: ["old line"],
        rhsChangedLines: ["new line"],
        lhsChangedPreview: ["old line"],
        rhsChangedPreview: ["new line"],
      },
    }

    const outputRoot = await mkdtemp(join(tmpdir(), "skillvm-compare-"))
    tempDirs.push(outputRoot)

    const outputs = await writeCompareBenchSkillOutputs(report, outputRoot)
    expect(outputs.reportJsonPath).toEndWith("calendar/openclaw--openrouter-qwen-qwen3.5-122b-a10b--aot-compiled-p1-vs-original.report.json")
    expect(outputs.reportMarkdownPath).toEndWith("calendar/openclaw--openrouter-qwen-qwen3.5-122b-a10b--aot-compiled-p1-vs-original.report.md")
    expect(outputs.skillDiffMarkdownPath).toEndWith("calendar/openclaw--openrouter-qwen-qwen3.5-122b-a10b--aot-compiled-p1-vs-original.skill-diff.md")

    const written = await readFile(outputs.reportMarkdownPath, "utf8")
    expect(written).toContain("# Skill Compare: original vs aot-compiled-p1")
  })

  test("renders change-only skill diff markdown", () => {
    const report: CompareBenchSkillReport = {
      model: "openrouter/qwen/qwen3.5-122b-a10b",
      adapter: "bare-agent",
      lhs: "original",
      rhs: "aot-compiled-p1",
      skill: mockSkillReference(),
      selections: {
        lhs: {
          condition: "original",
          sessionId: "bench-original-1",
          sessionDir: "/tmp/bench-original-1",
          reportPath: "/tmp/bench-original-1/report.json",
          report: {
            sessionId: "bench-original-1",
            model: "openrouter/qwen/qwen3.5-122b-a10b",
            adapter: "bare-agent",
            timestamp: new Date().toISOString(),
            tasks: [],
            summary: { taskCount: 0, perCondition: {}, perCategory: {}, delta: { originalVsBaseline: null, aotVsOriginal: null, jitVsAot: null } },
          },
          matchedTaskIds: ["task_a"],
          timestamp: 1,
        },
        rhs: {
          condition: "aot-compiled-p1",
          sessionId: "bench-aot-1",
          sessionDir: "/tmp/bench-aot-1",
          reportPath: "/tmp/bench-aot-1/report.json",
          report: {
            sessionId: "bench-aot-1",
            model: "openrouter/qwen/qwen3.5-122b-a10b",
            adapter: "bare-agent",
            timestamp: new Date().toISOString(),
            tasks: [],
            summary: { taskCount: 0, perCondition: {}, perCategory: {}, delta: { originalVsBaseline: null, aotVsOriginal: null, jitVsAot: null } },
          },
          matchedTaskIds: ["task_a"],
          timestamp: 2,
        },
      },
      warnings: [],
      unmatchedTaskIds: { lhsOnly: [], rhsOnly: [] },
      aggregate: {
        taskCount: 1,
        comparableCount: 1,
        incomparableCount: 0,
        avgScore: { lhs: 0.9, rhs: 0.7, delta: -0.2 },
        passRate: { lhs: 1, rhs: 0, delta: -1 },
        avgTokens: { lhs: 100, rhs: 150, delta: 50 },
        avgDurationMs: { lhs: 1000, rhs: 1400, delta: 400 },
        avgLlmDurationMs: { lhs: 500, rhs: 900, delta: 400 },
        avgSteps: { lhs: 3, rhs: 6, delta: 3 },
      },
      tasks: [],
      artifacts: {
        lhs: { condition: "original", kind: "original", path: "/tmp/original/SKILL.md", exists: true },
        rhs: { condition: "aot-compiled-p1", kind: "compiled", path: "/tmp/aot/SKILL.md", exists: true },
      },
      artifactDiff: {
        identical: false,
        lhsLineCount: 10,
        rhsLineCount: 12,
        commonPrefixLines: 3,
        commonSuffixLines: 4,
        lhsChangedLines: ["old line 1", "old line 2"],
        rhsChangedLines: ["new line 1", "new line 2"],
        lhsChangedPreview: ["old line 1"],
        rhsChangedPreview: ["new line 1"],
      },
    }

    const markdown = generateCompareSkillDiffMarkdown(report)
    expect(markdown).toContain("# Skill Diff: aot-compiled-p1 vs original")
    expect(markdown).toContain("## original Changed Span")
    expect(markdown).toContain("old line 2")
    expect(markdown).toContain("## aot-compiled-p1 Changed Span")
    expect(markdown).toContain("new line 2")
  })
})

describe("compare: tainted row handling (sweep G3)", () => {
  test("tainted lhs is rendered as ⚠ runStatus and excluded from aggregate", () => {
    // Regression for sweep G3: per-task delta for a tainted side used to
    // compute a misleading numeric (`0 - 0.8 = -0.8` looking like a real
    // regression). Now: incomparable rows show ⚠ in the markdown table
    // and are excluded from the avgScore / passRate denominators.
    const report: CompareBenchSkillReport = {
      model: "qwen/test",
      adapter: "bare-agent",
      lhs: "original",
      rhs: "aot-compiled-p1",
      skill: mockSkillReference(),
      warnings: [],
      aggregate: {
        taskCount: 2,
        comparableCount: 1,
        incomparableCount: 1,
        avgScore: { lhs: 0.8, rhs: 0.7, delta: -0.1 },
        passRate: { lhs: 1, rhs: 0, delta: -1 },
        avgTokens: { lhs: 100, rhs: 150, delta: 50 },
        avgDurationMs: { lhs: 1000, rhs: 2000, delta: 1000 },
        avgLlmDurationMs: { lhs: 500, rhs: 900, delta: 400 },
        avgSteps: { lhs: 3, rhs: 5, delta: 2 },
      },
      tasks: [
        {
          taskId: "task_ok",
          taskName: "Task OK",
          lhs: mockConditionResult({ score: 0.8, runStatus: "ok" }),
          rhs: mockConditionResult({ condition: "aot-compiled-p1", score: 0.7, runStatus: "ok" }),
          delta: { score: -0.1, tokens: 50, durationMs: 1000, llmDurationMs: 400, steps: 2 },
        },
        {
          taskId: "task_tainted",
          taskName: "Task Tainted",
          lhs: mockConditionResult({ score: 0, pass: false, runStatus: "timeout", statusDetail: "killed at 300s" }),
          rhs: mockConditionResult({ condition: "aot-compiled-p1", score: 0.9, runStatus: "ok" }),
          delta: { score: 0.9, tokens: 0, durationMs: 0, llmDurationMs: 0, steps: 0 },
          incomparable: true,
        },
      ],
      artifacts: {
        lhs: { condition: "original", kind: "original", path: "/tmp/original/SKILL.md", exists: true },
        rhs: { condition: "aot-compiled-p1", kind: "compiled", path: "/tmp/aot/SKILL.md", exists: true },
      },
    }

    const markdown = generateCompareBenchSkillMarkdown(report)
    // Aggregate header notes the tainted exclusion
    expect(markdown).toContain("1 of 2 task(s) excluded")
    expect(markdown).toContain("1 comparable")
    // Per-task table: tainted side shown as ⚠ timeout, score delta as N/A
    expect(markdown).toContain("⚠ timeout")
    expect(markdown).toContain("⚠ N/A")
    // The healthy row is unchanged
    expect(markdown).toMatch(/task_ok \| 0\.80 \| 0\.70 \| -0\.10/)
  })
})