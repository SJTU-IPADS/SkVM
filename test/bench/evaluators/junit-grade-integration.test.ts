/**
 * End-to-end integration test for junit-grade that exercises the full bench
 * path against a real migrated task:
 *
 *   loadTasks() → hydrateEvalPayloads → validatePayload → evaluate() →
 *   evaluateCustom() → junitGrade.run() → bun test → junit xml parse →
 *   scoreCriterion() → checkpoints[]
 *
 * This is deliberately separate from `junit-grade.test.ts` (which unit-tests
 * the evaluator in isolation) because it depends on the real
 * `skvm-data/tasks/` submodule being checked out and on the 184-file
 * migration having been applied.
 *
 * This test is what proves the dict-return fix actually works end-to-end.
 * Prior to the fix the same pipeline logged "grade() must return a list of
 * criterion records, got dict" and recorded score=0; after the fix the
 * pipeline emits real per-criterion checkpoints even against an empty
 * workDir (where every test naturally fails — the point is the pipeline
 * runs without the dict-return error).
 */

import { describe, test, expect } from "bun:test"
import path from "node:path"
import { mkdtemp, rm, copyFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { loadTasks } from "../../../src/bench/loader.ts"
import { evaluate } from "../../../src/framework/evaluator.ts"
import type { RunResult } from "../../../src/core/types.ts"

const baseRunResult = (workDir: string): RunResult => ({
  text: "",
  steps: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  cost: 0,
  durationMs: 0,
  llmDurationMs: 0,
  workDir,
  runStatus: "ok",
})

// Skip the integration test if skvm-data isn't checked out (e.g. CI without
// submodules). Unit tests in junit-grade.test.ts still provide full coverage
// of the evaluator logic in that environment.
const tasksDir = path.resolve(
  import.meta.dir,
  "../../../skvm-data/tasks",
)
const hasSubmodule = await Bun.file(
  path.join(tasksDir, "agile-product-owner_task_01", "task.json"),
).exists()

describe.if(hasSubmodule)(
  "junit-grade bench-path integration (requires skvm-data submodule)",
  () => {
    test("loadTasks → evaluate() produces checkpoints for a migrated task", async () => {
      // 1. Load the migrated task through the real bench loader. This
      //    exercises hydrateEvalPayloads + junitGrade.validatePayload on a
      //    file authored by the migration script, which is the strongest
      //    proof that the migration wrote a schema-valid payload.
      const tasks = await loadTasks({ tasksDir })
      const task = tasks.find((t) => t.id === "agile-product-owner_task_01")
      expect(task).toBeDefined()

      const junit = task!.eval.find(
        (c) => c.method === "custom" && c.evaluatorId === "junit-grade",
      )
      expect(junit).toBeDefined()
      expect(junit!.method).toBe("custom")

      // 2. Prepare a workDir with the task's fixtures copied in, matching
      //    what bench/conditions/run-condition.ts::prepareWorkDir does at bench time. We
      //    intentionally do NOT satisfy any of the test expectations — we
      //    want every test to fail so the pipeline exercises the
      //    score-zero-with-reason path.
      const workDir = await mkdtemp(path.join(tmpdir(), "junit-integration-"))
      try {
        const fixturesDir = path.join(task!.taskDir!, "fixtures")
        const entries = await readdir(fixturesDir, { withFileTypes: true })
        for (const e of entries) {
          if (e.isFile()) {
            await copyFile(
              path.join(fixturesDir, e.name),
              path.join(workDir, e.name),
            )
          }
        }

        // 3. Dispatch via the full framework evaluator (not junitGrade.run
        //    directly). This exercises the custom-evaluator dispatch in
        //    framework/evaluator.ts that bench actually uses at runtime.
        const result = await evaluate(junit!, baseRunResult(workDir))

        // 4. Assertions — the fix proves itself by what's in the result:
        //    - No "grade() must return a list..." error text
        //    - checkpoints array is populated (10 criteria for this task)
        //    - criterion preserved (id/name/weight flow through)
        //    - each checkpoint carries its description and a reason for
        //      non-perfect scores
        expect(result.details).not.toMatch(/must return a list/)
        expect(result.criterion.method).toBe("custom")
        if (result.criterion.method === "custom") {
          expect(result.criterion.evaluatorId).toBe("junit-grade")
          expect(result.criterion.id).toBe("custom-0")
          expect(result.criterion.name).toBe("Automated Grade")
          expect(result.criterion.weight).toBe(0.7)
        }
        expect(result.checkpoints).toBeDefined()
        expect(result.checkpoints!.length).toBe(10)
        for (const cp of result.checkpoints!) {
          expect(typeof cp.name).toBe("string")
          expect(cp.name.length).toBeGreaterThan(0)
          expect(cp.score).toBeGreaterThanOrEqual(0)
          expect(cp.score).toBeLessThanOrEqual(1)
          expect(typeof cp.weight).toBe("number")
          expect(typeof cp.description).toBe("string")
          expect(cp.description!.length).toBeGreaterThan(0)
        }

        // The weighted score is a real number in [0, 1], not NaN or error.
        expect(Number.isFinite(result.score)).toBe(true)
        expect(result.score).toBeGreaterThanOrEqual(0)
        expect(result.score).toBeLessThanOrEqual(1)
      } finally {
        await rm(workDir, { recursive: true, force: true })
      }
    }, 60_000)

    test("every task.json using junit-grade or python-grade loads cleanly through the bench loader", async () => {
      // The real invariant: `loadTasks` silently warn-and-skips on parse or
      // schema failures (see bench/loader.ts), so a single malformed payload
      // would drop the task without raising. Instead of hardcoding a magic
      // count that goes stale every time skvm-data drifts, derive the
      // expected counts from the filesystem itself and assert `loadTasks`
      // observes the same totals. Any silently-dropped task shows up as a
      // diff between on-disk and loaded.
      const diskEntries = await readdir(tasksDir, { withFileTypes: true })
      const taskDirs = diskEntries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)

      const onDiskUsing = async (evaluatorId: string): Promise<string[]> => {
        const hits: string[] = []
        for (const dir of taskDirs) {
          const taskJson = Bun.file(path.join(tasksDir, dir, "task.json"))
          if (!(await taskJson.exists())) continue
          let raw: unknown
          try {
            raw = await taskJson.json()
          } catch {
            continue
          }
          const evalList = (raw as { eval?: unknown }).eval
          if (!Array.isArray(evalList)) continue
          if (
            evalList.some(
              (c) =>
                c &&
                typeof c === "object" &&
                (c as { method?: unknown }).method === "custom" &&
                (c as { evaluatorId?: unknown }).evaluatorId === evaluatorId,
            )
          ) {
            hits.push(dir)
          }
        }
        return hits.sort()
      }

      const [junitOnDisk, pythonOnDisk] = await Promise.all([
        onDiskUsing("junit-grade"),
        onDiskUsing("python-grade"),
      ])

      // Sanity floor: if the submodule is present at all, at least one
      // grader of each type should exist. A zero here means the test is
      // running against an empty skvm-data and the real assertion below
      // would vacuously pass.
      expect(junitOnDisk.length).toBeGreaterThan(0)
      expect(pythonOnDisk.length).toBeGreaterThan(0)

      const tasks = await loadTasks({ tasksDir })
      const junitLoaded = tasks
        .filter((t) =>
          t.eval.some(
            (c) => c.method === "custom" && c.evaluatorId === "junit-grade",
          ),
        )
        .map((t) => t.id)
        .sort()
      const pythonLoaded = tasks
        .filter((t) =>
          t.eval.some(
            (c) => c.method === "custom" && c.evaluatorId === "python-grade",
          ),
        )
        .map((t) => t.id)
        .sort()

      expect(junitLoaded).toEqual(junitOnDisk)
      expect(pythonLoaded).toEqual(pythonOnDisk)

      // No task should carry both — the migration is a clean swap.
      const overlap = junitLoaded.filter((id) => pythonLoaded.includes(id))
      expect(overlap).toEqual([])
    }, 30_000)
  },
)
