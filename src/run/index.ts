import path from "node:path"
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { z } from "zod"
import { BenchTaskFileSchema } from "../bench/types.ts"
import type { BenchTask } from "../bench/types.ts"
import { EvalCriterionSchema } from "../core/types.ts"
import type { AdapterConfig, AgentAdapter, EvalCriterion, RunResult } from "../core/types.ts"
import { loadSkill as loadSkillFromPath } from "../core/skill-loader.ts"
import type { ResolvedSkill } from "../core/skill-loader.ts"
import { createLogger } from "../core/logger.ts"

const log = createLogger("run")

export interface LoadedRunTask extends BenchTask {
  taskPath: string
}

/** Kept as an alias so existing callers don't break. */
export type LoadedSkill = ResolvedSkill

export interface ExecuteRunOptions {
  task: LoadedRunTask
  skill?: LoadedSkill
  adapter: AgentAdapter
  adapterConfig: AdapterConfig
  workDir?: string
  keepWorkDir?: boolean
}

export interface ExecuteRunResult {
  task: LoadedRunTask
  skill?: LoadedSkill
  runResult: RunResult
  workDir: string
}

const RunTaskFileSchema = BenchTaskFileSchema.omit({ eval: true }).extend({
  eval: z.array(z.any()).optional().default([]),
})

export async function loadRunTask(taskPath: string): Promise<LoadedRunTask> {
  const resolvedTaskPath = path.resolve(taskPath)
  const taskFile = Bun.file(resolvedTaskPath)
  if (!(await taskFile.exists())) {
    throw new Error(`Task file not found: ${resolvedTaskPath}`)
  }

  let raw: unknown
  try {
    raw = JSON.parse(await taskFile.text())
  } catch (err) {
    throw new Error(`Failed to parse task JSON at ${resolvedTaskPath}: ${err}`)
  }

  const parsed = RunTaskFileSchema.parse(raw)
  const eval_ = parsed.eval.map((criterion) => EvalCriterionSchema.parse(criterion)) as EvalCriterion[]

  return {
    id: parsed.id,
    name: parsed.name,
    prompt: parsed.prompt,
    fixtures: parsed.fixtures ? { ...parsed.fixtures } : undefined,
    eval: eval_,
    timeoutMs: parsed.timeoutMs,
    maxSteps: parsed.maxSteps,
    category: parsed.category,
    gradingType: parsed.gradingType,
    gradingWeights: parsed.gradingWeights,
    skill: parsed.skill,
    origin: parsed.origin,
    taskDir: path.dirname(resolvedTaskPath),
    hostReady: parsed.hostReady,
    difficulty: parsed.difficulty,
    taskPath: resolvedTaskPath,
  }
}

export async function loadRunSkill(skillPath: string): Promise<LoadedSkill> {
  return await loadSkillFromPath(skillPath)
}

export async function executeRun(opts: ExecuteRunOptions): Promise<ExecuteRunResult> {
  const { task, skill, adapter, adapterConfig } = opts
  const keepWorkDir = opts.keepWorkDir ?? true
  const workDir = opts.workDir
    ? path.resolve(opts.workDir)
    : await mkdtemp(path.join(tmpdir(), `skvm-run-${task.id}-`))

  await mkdir(workDir, { recursive: true })
  await copyTaskFixtures(task, workDir)
  if (skill) {
    await copySkillBundle(skill, workDir)
  }

  log.info(`Run task ${task.id}: adapter=${adapter.name} model=${adapterConfig.model} workDir=${workDir}`)

  await adapter.setup(adapterConfig)

  try {
    const runResult = await adapter.run({
      prompt: task.prompt,
      workDir,
      skillContent: skill?.skillContent,
      skillMode: skill ? "inject" : undefined,
      skillMeta: skill?.skillMeta,
      taskId: task.id,
      timeoutMs: task.timeoutMs,
    })

    return {
      task,
      skill,
      runResult,
      workDir,
    }
  } finally {
    await adapter.teardown()
    if (!keepWorkDir && !opts.workDir) {
      await rm(workDir, { recursive: true, force: true })
    }
  }
}

async function copyTaskFixtures(task: LoadedRunTask, workDir: string): Promise<void> {
  if (task.fixtures) {
    for (const [name, content] of Object.entries(task.fixtures)) {
      const filePath = path.join(workDir, name)
      await mkdir(path.dirname(filePath), { recursive: true })
      await writeFile(filePath, content)
    }
  }

  if (!task.taskDir) return

  const fixturesDir = path.join(task.taskDir, "fixtures")
  await copyDirectoryContents(fixturesDir, workDir)
}

async function copySkillBundle(skill: LoadedSkill, workDir: string): Promise<void> {
  await copyDirectoryContents(skill.skillDir, workDir, new Set([skill.skillPath]))
}

async function copyDirectoryContents(
  sourceDir: string,
  destDir: string,
  excludedPaths?: Set<string>,
): Promise<void> {
  try {
    const entries = await readdir(sourceDir, { withFileTypes: true })
    for (const entry of entries) {
      const src = path.join(sourceDir, entry.name)
      const dest = path.join(destDir, entry.name)
      if (excludedPaths?.has(src)) continue

      if (entry.isDirectory()) {
        await mkdir(dest, { recursive: true })
        await copyDirectoryContents(src, dest, excludedPaths)
      } else if (entry.isFile()) {
        await mkdir(path.dirname(dest), { recursive: true })
        await copyFile(src, dest)
      }
    }
  } catch {
    // Ignore missing optional directories like task fixtures.
  }
}

