import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Task, RunResult, EvalResult, AgentAdapter, AdapterConfig, SkillMode } from "../core/types.ts"
import type { ConversationLog } from "../core/conversation-logger.ts"
import type { TestResult } from "./types.ts"
import { evaluateAll } from "./evaluator.ts"
import type { EvaluatorConfig, EvaluateAllOptions } from "./evaluator.ts"
import { createLogger } from "../core/logger.ts"

const log = createLogger("runner")

export interface RunOptions {
  task: Task
  adapter: AgentAdapter
  adapterConfig: AdapterConfig
  evaluatorConfig?: EvaluatorConfig
  skillContent?: string
  skillMode?: SkillMode
  skillMeta?: { name: string; description: string }
  keepWorkDir?: boolean
  /** If provided, use this directory instead of creating a new temp dir */
  workDir?: string
  /** Conversation log for recording LLM interactions */
  convLog?: ConversationLog
  /** Options for deferred LLM-judge evaluation */
  evalOptions?: EvaluateAllOptions
}

/**
 * Run a single task against an adapter and evaluate the result.
 *
 * Flow: create workspace → copy fixtures → run adapter → evaluate → cleanup
 */
export async function runTask(opts: RunOptions): Promise<TestResult> {
  const { task, adapter, adapterConfig, evaluatorConfig, skillContent, keepWorkDir } = opts

  // 1. Setup adapter
  await adapter.setup(adapterConfig)

  // 2. Create temp workspace (or use provided one)
  const workDir = opts.workDir ?? await mkdtemp(path.join(tmpdir(), `skvm-run-${task.id}-`))
  if (opts.workDir) {
    await mkdir(workDir, { recursive: true })
  }
  log.info(`Task ${task.id}: workDir=${workDir}`)

  try {
    // 3. Copy fixtures
    if (task.fixtures) {
      for (const [name, content] of Object.entries(task.fixtures)) {
        const filePath = path.join(workDir, name)
        const dir = path.dirname(filePath)
        await mkdir(dir, { recursive: true })
        await writeFile(filePath, content)
      }
      log.debug(`Copied ${Object.keys(task.fixtures).length} fixtures`)
    }

    // 4. Run adapter
    log.info(`Task ${task.id}: running with adapter ${adapter.name}`)
    const runResult = await adapter.run({
      prompt: task.prompt,
      workDir,
      skillContent,
      skillMode: opts.skillMode,
      skillMeta: opts.skillMeta,
      taskId: task.id,
      convLog: opts.convLog,
      timeoutMs: task.timeoutMs,
    })

    // 5. Gate on adapter runStatus.
    //
    // When the adapter returns anything other than 'ok' we cannot trust the
    // workDir as a proxy for agent success: accounting fields may be zero
    // (timeout), the subprocess may have crashed mid-run, or structured output
    // extraction may have failed. Running the evaluator in those cases scores
    // residual artifacts the agent happened to leave behind — the exact
    // false-positive documented in docs/skvm/bench-adapter-error-false-positive.md.
    //
    // Policy: skip eval, return score=0/pass=false. The runStatus field in
    // the stored runResult is itself the taint marker for downstream aggregators.
    if (runResult.runStatus !== "ok") {
      log.warn(
        `Task ${task.id}: adapter runStatus=${runResult.runStatus}; skipping evaluation` +
          (runResult.statusDetail ? ` (${runResult.statusDetail})` : ""),
      )
      return {
        task,
        runResult: { ...runResult, workDir },
        evalResults: [],
        overallPass: false,
        overallScore: 0,
        timestamp: new Date().toISOString(),
      }
    }

    // 6. Evaluate
    log.info(`Task ${task.id}: evaluating ${task.eval.length} criteria`)
    const evalResults = await evaluateAll(task.eval, { ...runResult, workDir }, evaluatorConfig, opts.evalOptions)

    // 7. Compute overall score
    const overallPass = evalResults.every((r) => r.pass)
    const overallScore = evalResults.length > 0
      ? evalResults.reduce((sum, r) => sum + r.score, 0) / evalResults.length
      : 0

    log.info(`Task ${task.id}: ${overallPass ? "PASS" : "FAIL"} (score=${overallScore.toFixed(2)})`)

    return {
      task,
      runResult: { ...runResult, workDir },
      evalResults,
      overallPass,
      overallScore,
      timestamp: new Date().toISOString(),
    }
  } finally {
    // 7. Cleanup
    await adapter.teardown()
    if (!keepWorkDir) {
      await rm(workDir, { recursive: true, force: true })
    } else {
      log.info(`Keeping workDir: ${workDir}`)
    }
  }
}

/**
 * Run multiple tasks sequentially.
 */
export async function runTasks(
  tasks: Task[],
  adapter: AgentAdapter,
  adapterConfig: AdapterConfig,
  evaluatorConfig?: EvaluatorConfig,
): Promise<TestResult[]> {
  const results: TestResult[] = []
  for (const task of tasks) {
    const result = await runTask({ task, adapter, adapterConfig, evaluatorConfig })
    results.push(result)
  }
  return results
}
