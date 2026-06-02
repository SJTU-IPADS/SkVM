import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { renderRoundShow } from "../../src/proposals/round-show.ts"
import { writeEvidenceRecord, runRecordDir } from "../../src/jit-optimize/record.ts"
import type { Evidence } from "../../src/jit-optimize/types.ts"

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "skvm-round-show-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function ev(taskId: string, score: number, status: "ok" | "timeout" = "ok"): Evidence {
  return {
    taskId,
    taskPrompt: `do ${taskId}`,
    conversationLog: [],
    criteria: [
      { id: "c1", method: "script", weight: 1, score, passed: score >= 0.5 },
    ],
    runMeta: {
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0,
      durationMs: 100,
      runStatus: status,
    },
  }
}

describe("renderRoundShow", () => {
  test("flags pre-v1 proposals as legacy when no record dirs exist", async () => {
    await withTempDir(async (dir) => {
      const result = await renderRoundShow(dir, 0)
      expect(result.legacy).toBe(true)
      expect(result.text).toContain("no durable record found")
    })
  })

  test("renders evidence record per set with score/status columns", async () => {
    await withTempDir(async (dir) => {
      const evidenceRoot = path.join(dir, "round-0-evidence")
      await writeEvidenceRecord(runRecordDir(evidenceRoot, "train", "task-A", 0), ev("task-A", 0.9))
      await writeEvidenceRecord(runRecordDir(evidenceRoot, "train", "task-A", 1), ev("task-A", 0.4))
      await writeEvidenceRecord(runRecordDir(evidenceRoot, "test", "task-B", 0), ev("task-B", 1.0))

      const result = await renderRoundShow(dir, 0)
      expect(result.legacy).toBe(false)
      expect(result.text).toContain("# Round 0")
      expect(result.text).toContain("### Set: train")
      expect(result.text).toContain("### Set: test")
      expect(result.text).toContain("task-A-run0")
      expect(result.text).toContain("task-A-run1")
      expect(result.text).toContain("task-B-run0")
      // The score column should reflect the per-run criterion score.
      expect(result.text).toMatch(/task-A-run0.*0\.900/)
      expect(result.text).toMatch(/task-A-run1.*0\.400/)
    })
  })

  test("renders optimizer step record with rootCause and artifact checklist", async () => {
    await withTempDir(async (dir) => {
      // Just the optimizer dir, no evidence — covers the "round-1 abstain"
      // shape where optimizer ran but no eval landed.
      const optDir = path.join(dir, "round-1-optimizer")
      await mkdir(optDir, { recursive: true })
      await Bun.write(path.join(optDir, "submission.json"), JSON.stringify({
        rootCause: "skill leaks task-specific examples",
        reasoning: "...",
        confidence: 0.7,
        changedFiles: ["SKILL.md"],
        changes: [],
      }))
      await Bun.write(path.join(optDir, "diff.json"), JSON.stringify({
        added: [],
        modified: ["SKILL.md"],
        removed: [],
      }))
      await Bun.write(path.join(optDir, "prompt.md"), "prompt body")
      await Bun.write(path.join(optDir, "stdout.log"), "")

      const result = await renderRoundShow(dir, 1)
      expect(result.text).toContain("## Optimizer step")
      expect(result.text).toContain("confidence: 0.70")
      expect(result.text).toContain("changedFiles: SKILL.md")
      expect(result.text).toContain("rootCause:")
      expect(result.text).toContain("skill leaks task-specific examples")
      expect(result.text).toContain("added=0 modified=1 removed=0")
      expect(result.text).toContain("prompt.md: ✓")
      expect(result.text).toContain("optimize-context: —")
    })
  })

  test("surfaces infraBlocked submission cleanly", async () => {
    await withTempDir(async (dir) => {
      const optDir = path.join(dir, "round-2-optimizer")
      await mkdir(optDir, { recursive: true })
      await Bun.write(path.join(optDir, "submission.json"), JSON.stringify({
        rootCause: "",
        reasoning: "all evidence tainted",
        confidence: 0,
        changedFiles: [],
        changes: [],
        infraBlocked: true,
        blockedEvidenceIds: ["0", "1"],
        blockedReason: "all timeouts",
      }))

      const result = await renderRoundShow(dir, 2)
      expect(result.text).toContain("status: **infra-blocked**")
      expect(result.text).toContain("blockedReason: all timeouts")
      expect(result.text).toContain("blockedEvidenceIds: 0, 1")
    })
  })

  test("orders runs numerically (run10 after run2) and sets train before test", async () => {
    await withTempDir(async (dir) => {
      const evidenceRoot = path.join(dir, "round-0-evidence")
      // Write out of order and with a 2-vs-10 boundary that lexicographic
      // sorting gets wrong.
      for (const k of [10, 2, 0, 1]) {
        await writeEvidenceRecord(runRecordDir(evidenceRoot, "train", "task-A", k), ev("task-A", 0.9))
      }
      await writeEvidenceRecord(runRecordDir(evidenceRoot, "test", "task-B", 0), ev("task-B", 1.0))

      const result = await renderRoundShow(dir, 0)
      // train section appears before test section
      expect(result.text.indexOf("### Set: train")).toBeLessThan(result.text.indexOf("### Set: test"))
      // run rows are numerically ordered: run0 < run1 < run2 < run10
      const idx = (s: string) => result.text.indexOf(s)
      expect(idx("task-A-run0")).toBeLessThan(idx("task-A-run1"))
      expect(idx("task-A-run1")).toBeLessThan(idx("task-A-run2"))
      expect(idx("task-A-run2")).toBeLessThan(idx("task-A-run10"))
    })
  })

  test("renders an 'unreadable' row instead of crashing on a missing/corrupt sidecar", async () => {
    await withTempDir(async (dir) => {
      const evidenceRoot = path.join(dir, "round-0-evidence")
      // One good record.
      await writeEvidenceRecord(runRecordDir(evidenceRoot, "train", "task-A", 0), ev("task-A", 0.9))
      // One interrupted record: dir exists, evidence.json never written —
      // exactly the shape runOne leaves after mkdir before the sidecar write.
      await mkdir(runRecordDir(evidenceRoot, "train", "task-B", 0), { recursive: true })

      const result = await renderRoundShow(dir, 0)
      // Render completes (does not throw) and surfaces both rows.
      expect(result.text).toContain("task-A-run0")
      expect(result.text).toContain("task-B-run0")
      expect(result.text).toContain("unreadable")
      // The good row still shows its real score.
      expect(result.text).toMatch(/task-A-run0.*0\.900/)
    })
  })
})
