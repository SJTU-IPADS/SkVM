import path from "node:path"
import { readdir, mkdir, copyFile } from "node:fs/promises"
import { EvalCriterionSchema } from "../core/types.ts"
import type { EvalCriterion } from "../core/types.ts"
import type { BenchTask, Origin } from "./types.ts"
import { BenchTaskFileSchema } from "./types.ts"
import { hydrateEvalPayloads, persistEvalPayloads } from "./evaluators/index.ts"
import { SKVM_TASKS_DIR } from "../core/config.ts"
import { createLogger } from "../core/logger.ts"

const log = createLogger("bench-loader")

const TASKS_DIR = SKVM_TASKS_DIR

// ---------------------------------------------------------------------------
// Load Tasks
// ---------------------------------------------------------------------------

/**
 * Load all bench tasks from skvm-data/tasks/<name>/task.json.
 *
 * Flat layout — no source grouping, no nesting:
 *   tasks/
 *     calendar_task_01/
 *       task.json           ← directory name MUST equal task.json "id"
 *       grade.py            ← optional python-grade script
 *       fixtures/           ← optional
 *     another_task/
 *       task.json
 */
export async function loadTasks(opts?: {
  excludedTasks?: string[]
  tasksDir?: string
}): Promise<BenchTask[]> {
  const tasksDir = opts?.tasksDir ?? TASKS_DIR
  const excluded = new Set(opts?.excludedTasks ?? [])

  let taskDirNames: string[]
  try {
    const dirents = await readdir(tasksDir, { withFileTypes: true })
    taskDirNames = dirents
      .filter(d => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith("."))
      .map(d => d.name)
      .sort()
  } catch {
    log.warn(`Tasks directory not found: ${tasksDir}`)
    return []
  }

  const tasks: BenchTask[] = []

  for (const dirName of taskDirNames) {
    const taskDir = path.join(tasksDir, dirName)
    const taskJsonPath = path.join(taskDir, "task.json")

    try {
      const taskFile = Bun.file(taskJsonPath)
      if (!(await taskFile.exists())) continue

      const raw = JSON.parse(await taskFile.text())
      const parsed = BenchTaskFileSchema.parse(raw)

      if (parsed.id !== dirName) {
        log.warn(`Task directory "${dirName}" has mismatched id "${parsed.id}" — skipping (dirname must equal task.id)`)
        continue
      }

      if (excluded.has(parsed.id)) {
        log.debug(`Skipping excluded task: ${parsed.id}`)
        continue
      }

      // Build eval criteria, then let each custom criterion's evaluator
      // hydrate its own per-task payload (e.g. python-grade reads grade.py).
      const eval_: EvalCriterion[] = parsed.eval.map(e => EvalCriterionSchema.parse(e))
      await hydrateEvalPayloads(eval_, taskDir)

      const fixtures = parsed.fixtures ? { ...parsed.fixtures } : undefined

      const benchTask: BenchTask = {
        id: parsed.id,
        name: parsed.name,
        prompt: parsed.prompt,
        fixtures,
        eval: eval_,
        timeoutMs: parsed.timeoutMs,
        maxSteps: parsed.maxSteps,
        category: parsed.category,
        gradingType: parsed.gradingType,
        gradingWeights: parsed.gradingWeights,
        skill: parsed.skill,
        origin: parsed.origin,
        taskDir,
        hostReady: parsed.hostReady,
        difficulty: parsed.difficulty,
      }

      tasks.push(benchTask)
      log.debug(`Loaded task: ${parsed.id} (${benchTask.category}, ${benchTask.gradingType})`)
    } catch (err) {
      log.warn(`Failed to parse task ${dirName}: ${err}`)
    }
  }

  log.info(`Loaded ${tasks.length} tasks from ${tasksDir}`)
  return tasks
}

// ---------------------------------------------------------------------------
// Write Task
// ---------------------------------------------------------------------------

/**
 * Write a BenchTask to the folder-based native format.
 * Creates: <tasksDir>/<id>/task.json, grade.py, fixtures/
 * Enforces: directory name == task.id.
 */
export async function writeTask(
  task: BenchTask,
  opts?: { tasksDir?: string },
): Promise<string> {
  const tasksDir = opts?.tasksDir ?? TASKS_DIR
  const taskDir = path.join(tasksDir, task.id)
  await mkdir(taskDir, { recursive: true })

  const filePath = path.join(taskDir, "task.json")

  // Persist per-criterion payloads via each evaluator's savePayload hook
  // (e.g. python-grade writes the custom criterion's payload to grade.py).
  // The set of persisted indices is stripped from the serialized task.json
  // so the payload lives in exactly one place.
  const persisted = await persistEvalPayloads(task.eval, taskDir)
  const serializedEval = task.eval.map((c, i) => {
    if (persisted.has(i) && c.method === "custom") {
      const { payload: _payload, ...rest } = c
      return rest
    }
    return c
  })

  const data: Record<string, unknown> = {
    id: task.id,
    name: task.name,
    category: task.category,
    gradingType: task.gradingType,
    prompt: task.prompt,
    timeoutMs: task.timeoutMs,
    maxSteps: task.maxSteps,
    eval: serializedEval,
    skill: task.skill,
    origin: task.origin,
  }
  if (task.fixtures) data.fixtures = task.fixtures
  if (task.gradingWeights) data.gradingWeights = task.gradingWeights
  if (task.hostReady === false) data.hostReady = false
  if (task.difficulty) data.difficulty = task.difficulty

  await Bun.write(filePath, JSON.stringify(data, null, 2))

  return taskDir
}

/**
 * Copy a binary fixture file into a task's fixtures/ directory.
 */
export async function addFixtureFile(
  taskId: string,
  destName: string,
  sourcePath: string,
  opts?: { tasksDir?: string },
): Promise<void> {
  const tasksDir = opts?.tasksDir ?? TASKS_DIR
  const fixturesDir = path.join(tasksDir, taskId, "fixtures")
  await mkdir(fixturesDir, { recursive: true })
  await copyFile(sourcePath, path.join(fixturesDir, destName))
}
