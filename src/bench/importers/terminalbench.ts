/**
 * Terminal-Bench 2.1 Importer
 *
 * Converts Terminal-Bench 2.1 task directories (`<repo>/tasks/<name>/` with
 * `task.toml` + `instruction.md` + `tests/`) into SkVM native bench task
 * format. One-time conversion tool — the core bench framework then loads the
 * emitted `task.json` via the standard loader.
 *
 * Architecture (validated by the path-C pilot, see memory
 * skvm-tb-pilot-pi-adapter): the TB verifier runs INSIDE the task's docker
 * image (needs apt + chromium + selenium). The tb-grade evaluator handles
 * that at eval time. This importer only lays out the on-disk task so the
 * evaluator has everything it needs:
 *   - prompt               <- instruction.md
 *   - tbDockerImage        <- task.toml [environment] docker_image
 *   - tbTestsDir           <- copied + LF-normalised tests/ under the task dir
 *   - timeoutMs            <- task.toml [agent] timeout_sec * 1000
 *   - eval                 <- single `custom` criterion, evaluatorId "tb-grade",
 *                             payload { dockerImage, testsDir } (the evaluator
 *                             reads from payload because CustomEvalContext
 *                             does not pass the task object)
 *
 * Usage:
 *   bun run skvm bench --import=terminalbench --path=<tb-2.1-repo>
 */

import path from "node:path"
import { chmod, copyFile, mkdir, readdir, stat } from "node:fs/promises"
import { parse as parseToml } from "smol-toml"
import type { EvalCriterion } from "../../core/types.ts"
import type { BenchTask } from "../types.ts"
import { ensureTaskDir, writeTask } from "../loader.ts"
import { createLogger } from "../../core/logger.ts"
import { TASK_FILE_DEFAULTS } from "../../core/ui-defaults.ts"

const log = createLogger("import-terminalbench")

interface TbTaskToml {
  task?: { name?: string; description?: string }
  metadata?: {
    difficulty?: string
    category?: string
    tags?: string[]
  }
  agent?: { timeout_sec?: number }
  verifier?: { timeout_sec?: number }
  environment?: { docker_image?: string }
}

/**
 * Read a TB task directory and emit a skvm BenchTask. Returns null if the
 * task is missing required pieces (task.toml, instruction.md, docker_image,
 * or tests/test.sh).
 */
async function convertTask(taskDir: string, dirName: string): Promise<BenchTask | null> {
  const tomlPath = path.join(taskDir, "task.toml")
  const tomlFile = Bun.file(tomlPath)
  if (!(await tomlFile.exists())) {
    log.debug(`skip ${dirName}: no task.toml`)
    return null
  }

  const toml = parseToml(await tomlFile.text()) as unknown as TbTaskToml
  const dockerImage = toml.environment?.docker_image
  if (!dockerImage) {
    log.warn(`skip ${dirName}: no [environment].docker_image in task.toml`)
    return null
  }

  const instructionPath = path.join(taskDir, "instruction.md")
  const instructionFile = Bun.file(instructionPath)
  if (!(await instructionFile.exists())) {
    log.warn(`skip ${dirName}: no instruction.md`)
    return null
  }
  const prompt = (await instructionFile.text()).trim()
    // The agent runs on the HOST against workDir, which is a mirror of the
    // image's /app. Rewrite /app/ → ./ so the agent looks in its cwd instead
    // of a non-existent /app on the host. The verifier runs inside the
    // container (where workDir is mounted back at /app), so absolute /app
    // paths in test.sh are untouched — only the prompt is rewritten.
    .replace(/\/app\//g, "./")
    // The TB verifier (tests/test.sh + test_outputs.py) needs the container's
    // apt + chromium + selenium and CANNOT run on the host. Without this
    // guardrail the agent repeatedly tries (and fails) to install/run the
    // verifier locally, which OOMs the host (observed: pi retries until 2.9GB).
    + "\n\nNOTE: The test suite (test_outputs.py / test.sh) runs in a separate " +
    "containerized verifier and cannot be executed from your shell. Do NOT " +
    "attempt to install or run it. Reason about correctness from the source " +
    "files instead, then write your solution file."

  // tests/ must contain test.sh (the verifier entrypoint). Copy the whole
  // tests/ dir into the task dir with CRLF→LF normalisation — the TB image is
  // Linux and bash chokes on the CRLF a Windows checkout carries (pilot坑 #3).
  const srcTestsDir = path.join(taskDir, "tests")
  const testShFile = Bun.file(path.join(srcTestsDir, "test.sh"))
  if (!(await testShFile.exists())) {
    log.warn(`skip ${dirName}: no tests/test.sh`)
    return null
  }

  const difficultyRaw = toml.metadata?.difficulty
  const difficulty = difficultyRaw === "easy" || difficultyRaw === "medium" || difficultyRaw === "hard"
    ? difficultyRaw
    : undefined

  // tbTestsDir is set by the loader AFTER writeTask creates the task dir —
  // we know the layout is <tasksDir>/<id>/tests, so compute it relative to
  // the task id. writeTask uses task.id as the dirname, so tests land at
  // <tasksDir>/<id>/tests.
  const testsDirRel = "tests"

  const eval_: EvalCriterion[] = [{
    method: "custom",
    evaluatorId: "tb-grade",
    id: "tb-grade",
    name: "Terminal-Bench verifier",
    weight: 1.0,
    // Evaluator reads dockerImage + testsDir from payload (CustomEvalContext
    // has no task object). testsDir is resolved against taskDir at eval time.
    payload: {
      dockerImage,
      testsDir: testsDirRel,
      verifierTimeoutSec: toml.verifier?.timeout_sec ?? 1200,
    },
  }]

  const benchTask: BenchTask = {
    id: `tb-${dirName}`,
    name: toml.task?.name ?? `Terminal-Bench 2.1: ${dirName}`,
    prompt,
    eval: eval_,
    timeoutMs: (toml.agent?.timeout_sec ?? 1200) * 1000,
    maxSteps: TASK_FILE_DEFAULTS.maxSteps,
    category: toml.metadata?.category ?? "terminal-bench",
    gradingType: "automated",
    skill: null,
    origin: {
      source: "terminalbench",
      repo: "https://github.com/laude-institute/terminal-bench",
      file: `tasks/${dirName}/task.toml`,
      importedAt: new Date().toISOString(),
    },
    // hostReady=true: the AGENT runs on the host against workDir (which the
    // tb-grade evaluator mounts into the container). hostReady here governs
    // whether the orchestrator runs the task at all, not whether the verifier
    // needs docker — the evaluator owns its own container lifecycle.
    hostReady: true,
    difficulty,
    tbDockerImage: dockerImage,
    // tbTestsDir set below after the dir exists; use the absolute path once
    // writeTask has created <tasksDir>/<id>.
    tbTestsDir: testsDirRel,
  }

  return benchTask
}

const TEXT_TEST_EXTENSIONS = new Set([
  ".css", ".csv", ".html", ".js", ".json", ".md", ".py", ".sh",
  ".toml", ".ts", ".txt", ".xml", ".yaml", ".yml",
])

/**
 * Copy tests/ into the task dir. Known text files get CRLF→LF normalization;
 * all other files are copied byte-for-byte. Source permission bits are
 * restored in both cases so executable verifier helpers stay executable.
 */
export async function copyTestsNormalized(
  srcTestsDir: string,
  destTestsDir: string,
): Promise<void> {
  await mkdir(destTestsDir, { recursive: true })
  const entries = await readdir(srcTestsDir, { withFileTypes: true })
  for (const entry of entries) {
    const src = path.join(srcTestsDir, entry.name)
    const dest = path.join(destTestsDir, entry.name)
    if (entry.isDirectory()) {
      await copyTestsNormalized(src, dest)
    } else if (entry.isFile()) {
      if (TEXT_TEST_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const raw = await Bun.file(src).text()
        await Bun.write(dest, raw.replace(/\r\n/g, "\n"))
      } else {
        await copyFile(src, dest)
      }
      const sourceMode = (await stat(src)).mode & 0o777
      await chmod(dest, sourceMode)
    }
  }
}

/**
 * Import Terminal-Bench 2.1 tasks from a repo directory into SkVM native
 * bench task format. Only tasks whose name appears in `opts.tasks` are
 * imported when that filter is set (path-B minimum: import one task).
 */
export async function importTerminalBench(
  repoDir: string,
  opts?: { excludedTasks?: string[]; tasks?: string[]; tasksDir?: string },
): Promise<{ imported: string[]; skipped: string[]; errors: string[] }> {
  const tasksRoot = path.join(repoDir, "tasks")
  const excluded = new Set(opts?.excludedTasks ?? [])
  const taskFilter = opts?.tasks ? new Set(opts?.tasks) : undefined

  let dirNames: string[]
  try {
    const dirents = await readdir(tasksRoot, { withFileTypes: true })
    dirNames = dirents
      .filter(d => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
      .map(d => d.name)
      .sort()
  } catch (err) {
    log.error(`Tasks directory not found: ${tasksRoot}: ${err}`)
    return { imported: [], skipped: [], errors: [`${tasksRoot}: ${err}`] }
  }

  const imported: string[] = []
  const skipped: string[] = []
  const errors: string[] = []

  for (const dirName of dirNames) {
    if (taskFilter && !taskFilter.has(dirName) && !taskFilter.has(`tb-${dirName}`)) {
      continue
    }
    if (excluded.has(dirName) || excluded.has(`tb-${dirName}`)) {
      skipped.push(`${dirName} (excluded)`)
      continue
    }

    const taskDir = path.join(tasksRoot, dirName)
    try {
      const benchTask = await convertTask(taskDir, dirName)
      if (!benchTask) {
        skipped.push(`${dirName} (incomplete)`)
        continue
      }

      // Create the canonical directory without writing an intermediate
      // task.json whose paths are still relative.
      const writeOpts = opts?.tasksDir ? { tasksDir: opts.tasksDir } : undefined
      const outDir = await ensureTaskDir(benchTask.id, writeOpts)
      await copyTestsNormalized(path.join(taskDir, "tests"), path.join(outDir, "tests"))
      // Stamp ABSOLUTE paths now that the dir exists — both the task-level
      // tbTestsDir and the evaluator payload's testsDir. The evaluator
      // (CustomEvalContext) has no task object, so it cannot resolve a relative
      // path; an absolute payload.testsDir is the only reliable contract.
      const absTestsDir = path.join(outDir, "tests")
      benchTask.tbTestsDir = absTestsDir
      const tbCriterion = benchTask.eval.find(c => c.method === "custom" && c.evaluatorId === "tb-grade")
      if (tbCriterion && tbCriterion.method === "custom" && tbCriterion.payload) {
        ;(tbCriterion.payload as Record<string, unknown>).testsDir = absTestsDir
      }
      await writeTask(benchTask, writeOpts)

      imported.push(`${dirName} -> ${outDir}`)
      log.debug(`Imported: ${dirName}`)
    } catch (err) {
      errors.push(`${dirName}: ${err}`)
    }
  }

  log.info(`Imported ${imported.length} tasks, skipped ${skipped.length}, errors ${errors.length}`)
  return { imported, skipped, errors }
}
