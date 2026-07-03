/**
 * Integration-level proof for #76: `--failures` JSON files are wired through
 * `buildTaskSource` as `criteriaPath` and `loadEvidencesFromLogs` (the
 * execution-log source's loader, `src/jit-optimize/task-source.ts:158`)
 * actually reads them and attaches the parsed `EvidenceCriterion[]` to the
 * resulting `Evidence`. No LLM call is involved — the loader only touches
 * the filesystem.
 */
import { describe, test, expect } from "bun:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadEvidencesFromLogs } from "../../src/jit-optimize/task-source.ts"
import type { TaskSource, EvidenceCriterion } from "../../src/jit-optimize/types.ts"

describe("loadEvidencesFromLogs — criteriaPath reaches the engine (#76)", () => {
  test("criteria from a --failures file are parsed and attached to the loaded Evidence", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "jit-optimize-criteria-"))
    try {
      const logPath = path.join(dir, "a.jsonl")
      const criteriaPath = path.join(dir, "a-failures.json")

      const logLines = [
        { type: "request", ts: "2026-07-02T00:00:00Z", text: "do the thing" },
        { type: "response", ts: "2026-07-02T00:00:01Z", text: "done" },
      ]
      await writeFile(logPath, logLines.map((l) => JSON.stringify(l)).join("\n") + "\n")

      const criteria: EvidenceCriterion[] = [
        {
          id: "check-1",
          method: "llm-judge",
          weight: 1,
          score: 0,
          passed: false,
          details: "the agent forgot to write output.json",
        },
      ]
      await writeFile(criteriaPath, JSON.stringify(criteria))

      const source: TaskSource = {
        kind: "execution-log",
        logs: [{ path: logPath, criteriaPath }],
      }

      const evidences = await loadEvidencesFromLogs(source)

      expect(evidences).toHaveLength(1)
      expect(evidences[0]!.taskId).toBe("a")
      expect(evidences[0]!.taskPrompt).toBe("do the thing")
      expect(evidences[0]!.criteria).toEqual(criteria)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("without a criteriaPath, the log's own criteria (if any) are used unmodified", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "jit-optimize-criteria-"))
    try {
      const logPath = path.join(dir, "b.jsonl")
      await writeFile(
        logPath,
        [
          JSON.stringify({ type: "request", ts: "2026-07-02T00:00:00Z", text: "do another thing" }),
          JSON.stringify({ type: "response", ts: "2026-07-02T00:00:01Z", text: "done" }),
        ].join("\n") + "\n",
      )

      const source: TaskSource = {
        kind: "execution-log",
        logs: [{ path: logPath }],
      }

      const evidences = await loadEvidencesFromLogs(source)

      expect(evidences).toHaveLength(1)
      expect(evidences[0]!.criteria).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
