import path from "node:path"
import { mkdtemp, readdir, copyFile } from "node:fs/promises"
import { copyDirRecursive } from "../../core/fs-utils.ts"
import type { AgentAdapter, AdapterConfig, RunResult, SkillBundle } from "../../core/types.ts"
import { emptyTokenUsage } from "../../core/types.ts"
import type { EvaluatorConfig, EvaluateAllOptions } from "../../framework/evaluator.ts"
import { runTask } from "../../framework/runner.ts"
import { getTmpDir } from "../../core/config.ts"
import type { BenchTask, BenchCondition, ConditionResult } from "../types.ts"
import type { ConversationLog } from "../../core/conversation-logger.ts"
import { createLogger } from "../../core/logger.ts"
import { runSubprocess } from "../../core/subprocess.ts"
import { computeWeightedScore, buildEvalDetails } from "./scoring.ts"

const log = createLogger("bench-conditions")

/**
 * For Terminal-Bench tasks, seed the host workDir with the image's /app
 * contents so the agent (which runs on the host against workDir) can read the
 * task's actual files (e.g. /app/filter.py). The tb-grade evaluator later
 * mounts this same workDir back into the image at /app, so the agent's edits
 * land in the container faithfully. No-op for non-TB tasks.
 */
async function seedTbAppFiles(task: BenchTask, workDir: string): Promise<void> {
  if (!task.tbDockerImage) return
  log.info(`Task ${task.id}: seeding workDir from ${task.tbDockerImage}:/app`)
  // `cp -r /app/. /out/` copies /app's contents (incl. dotfiles, subdirs) into
  // the mounted host workDir. --rm tears the throwaway container down at exit.
  const r = await runSubprocess(
    ["docker", "run", "--rm", "-v", `${workDir}:/out`, task.tbDockerImage,
     "sh", "-c", "cp -r /app/. /out/ 2>/dev/null"],
    { timeoutMs: 120000, env: { MSYS_NO_PATHCONV: "1" } },
  )
  if (r.exitCode !== 0) {
    log.warn(`Task ${task.id}: TB /app seed exited ${r.exitCode}: ${r.stderr.slice(0, 200)}`)
  }
}

/** Create workDir and copy fixture files from the task's fixtures/ directory */
export async function prepareWorkDir(task: BenchTask): Promise<string> {
  const workDir = await mkdtemp(path.join(getTmpDir(), `skvm-bench-${task.id}-`))

  // Copy files and directories from task's fixtures/ directory if it exists
  if (task.taskDir) {
    const fixturesDir = path.join(task.taskDir, "fixtures")
    try {
      const entries = await readdir(fixturesDir, { withFileTypes: true })
      for (const entry of entries) {
        const srcPath = path.join(fixturesDir, entry.name)
        const destPath = path.join(workDir, entry.name)
        if (entry.isDirectory()) {
          await copyDirRecursive(srcPath, destPath)
        } else {
          await copyFile(srcPath, destPath)
        }
      }
    } catch { /* no fixtures dir */ }

    // Run optional setup script (e.g. for git repo creation, fixture generation)
    const setupScript = path.join(workDir, "_setup.sh")
    try {
      const f = Bun.file(setupScript)
      if (await f.exists()) {
        log.debug(`Running _setup.sh for task ${task.id}`)
        const proc = Bun.spawn(["bash", "_setup.sh"], {
          cwd: workDir,
          stdout: "pipe",
          stderr: "pipe",
        })
        await proc.exited
      }
    } catch { /* no setup script or execution failed */ }
  }

  // Terminal-Bench: seed workDir with the image's /app so the host-side agent
  // sees the same files the verifier will score. See seedTbAppFiles.
  await seedTbAppFiles(task, workDir)

  return workDir
}

/** Identity fields a condition stamps onto both its success and crash results. */
export type ConditionResultMeta = Pick<
  ConditionResult,
  "skillId" | "skillPath" | "skillPaths" | "skillContentHash"
>

/** Convert TestResult to ConditionResult */
export function toConditionResult(
  condition: BenchCondition,
  runResult: RunResult,
  evalResults: { pass: boolean; score: number; details: string; criterion?: { method: string } }[],
  opts?: ConditionResultMeta & {
    gradingWeights?: { automated: number; llmJudge: number }
  },
): ConditionResult {
  const evalDetails = buildEvalDetails(evalResults)
  const { overallScore, automatedScore, llmJudgeScore } = computeWeightedScore(
    evalDetails, opts?.gradingWeights,
  )

  // Propagate adapter errors so they show up in bench reports
  let error: string | undefined
  if (runResult.adapterError) {
    const ae = runResult.adapterError
    error = ae.stderr || `adapter exit code ${ae.exitCode}`
  } else if (runResult.runStatus !== "ok" && runResult.statusDetail) {
    // Non-ok runs that don't carry a noisy stderr snippet still deserve a
    // visible error string in report.md.
    error = runResult.statusDetail
  }

  return {
    condition,
    score: overallScore,
    pass: overallScore >= 0.5,
    evalDetails,
    automatedScore,
    llmJudgeScore,
    ...(opts?.gradingWeights ? { gradingWeights: opts.gradingWeights } : {}),
    tokens: runResult.tokens,
    cost: runResult.cost,
    ...(runResult.usageAvailable !== undefined ? { usageAvailable: runResult.usageAvailable } : {}),
    durationMs: runResult.durationMs,
    llmDurationMs: runResult.llmDurationMs ?? 0,
    steps: runResult.steps.length,
    skillId: opts?.skillId,
    skillPath: opts?.skillPath,
    skillPaths: opts?.skillPaths,
    skillContentHash: opts?.skillContentHash,
    ...(runResult.skillLoaded !== undefined ? { skillLoaded: runResult.skillLoaded } : {}),
    ...(error ? { error } : {}),
    runStatus: runResult.runStatus,
    ...(runResult.statusDetail ? { statusDetail: runResult.statusDetail } : {}),
  }
}

/**
 * Zero-score ConditionResult skeleton for cells that never produced a run —
 * crash conversion, tainted skips, compile failures. The verdict supplies
 * what distinguishes them.
 */
export function zeroConditionResult(
  condition: BenchCondition,
  resultMeta: ConditionResultMeta | undefined,
  verdict: {
    runStatus: ConditionResult["runStatus"]
    statusDetail?: string
    error?: string
  },
): ConditionResult {
  return {
    condition,
    score: 0, pass: false, evalDetails: [],
    tokens: emptyTokenUsage(),
    cost: 0, durationMs: 0, llmDurationMs: 0, steps: 0,
    ...resultMeta,
    ...(verdict.error !== undefined ? { error: verdict.error } : {}),
    runStatus: verdict.runStatus,
    ...(verdict.statusDetail ? { statusDetail: verdict.statusDetail } : {}),
  }
}

/**
 * The ConditionResult for a (task, condition) cell whose orchestration threw
 * — adapter setup/run crash, evaluator crash, anything escaping `runTask`.
 */
export function crashedConditionResult(
  condition: BenchCondition,
  err: unknown,
  resultMeta?: ConditionResultMeta,
): ConditionResult {
  return zeroConditionResult(condition, resultMeta, {
    error: String(err),
    runStatus: "adapter-crashed",
    statusDetail: `bench orchestration threw: ${String(err).slice(0, 200)}`,
  })
}

/** What a single-run condition hands to the shared scaffold. */
export interface RunConditionArgs {
  /** Concrete condition label stamped on the result (e.g. "aot-compiled-p12"). */
  condition: BenchCondition
  task: BenchTask
  adapter: AgentAdapter
  adapterConfig: AdapterConfig
  evaluatorConfig?: EvaluatorConfig
  convLog?: ConversationLog
  evalOptions?: EvaluateAllOptions
  /** Skill bundle handed to the adapter; omit to run bare (no-skill). */
  skill?: SkillBundle
  /** Stage extra bundle files into the prepared workDir before the run. */
  stage?: (workDir: string) => Promise<void>
  /** Identity fields merged into both the success and the crash result. */
  resultMeta?: ConditionResultMeta
}

/**
 * Shared scaffold for every single-run condition (all but jit-boost, which
 * owns a multi-run loop): prepare the workDir, stage the condition's skill
 * bundle, run + evaluate via `runTask`, and assemble the `ConditionResult` —
 * converting anything thrown past `runTask` into an `adapter-crashed` result.
 *
 * Failures in workDir prep / staging deliberately happen *outside* the guard
 * and propagate to the orchestrator (they are operator/environment bugs, not
 * adapter crashes) — matching the historical per-condition behavior.
 */
export async function runCondition(args: RunConditionArgs): Promise<ConditionResult> {
  const workDir = await prepareWorkDir(args.task)
  await args.stage?.(workDir)

  try {
    const result = await runTask({
      task: args.task,
      adapter: args.adapter,
      adapterConfig: args.adapterConfig,
      evaluatorConfig: args.evaluatorConfig,
      convLog: args.convLog,
      skill: args.skill,
      workDir,
      keepWorkDir: true,
      evalOptions: args.evalOptions,
    })

    return toConditionResult(args.condition, result.runResult, result.evalResults, {
      ...args.resultMeta,
      gradingWeights: args.task.gradingWeights,
    })
  } catch (err) {
    log.error(`[${args.condition}] ${args.task.id} failed: ${err}`)
    return crashedConditionResult(args.condition, err, args.resultMeta)
  }
}
