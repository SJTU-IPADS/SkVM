import path from "node:path"
import { mkdir } from "node:fs/promises"
import type { AgentAdapter, AdapterConfig, TCP } from "../core/types.ts"
import type { LLMProvider } from "../providers/types.ts"
import type { EvaluatorConfig, EvaluateAllOptions } from "../framework/evaluator.ts"
import { collectDeferredInput, appendDeferredManifest, runDeferredJudge, mergeDeferredResults, readDeferredManifest } from "../framework/deferred-eval.ts"
import type {
  BenchTask, BenchCondition, BenchRunConfig, BenchReport,
  TaskReport, ConditionResult, BenchProgress, ProgressEntry, BenchConfigFile,
  MultiModelReport, MultiAdapterReport, EvalDetail,
} from "./types.ts"
import { BenchConfigFileSchema, parseAotPasses, isAotCondition } from "./types.ts"
import { loadTasks } from "./loader.ts"
import { resolveTaskSkills } from "./skill-resolver.ts"
import type { ResolvedSkill } from "../core/skill-loader.ts"
// Side-effect import: ensures every custom evaluator registers at module load.
import "./evaluators/index.ts"
import { runNoSkill, runOriginal, runJitOptimized, runAOTVariant, runJITBoost } from "./conditions.ts"
import { generateReport, printSummary, printMultiModelSummary, generateMultiModelMarkdown, printMultiAdapterSummary, generateMultiAdapterMarkdown } from "./reporter.ts"
import { type AdapterName, createAdapter } from "../adapters/registry.ts"
import { getBenchLogDir, safeModelName } from "../core/config.ts"
import { createProviderForModel } from "../providers/registry.ts"
import { createLogger } from "../core/logger.ts"
import { ConversationLog } from "../core/conversation-logger.ts"
import { createAsyncMutex, runScheduled, type WorkItem, type RunnerHandle } from "../core/concurrency.ts"
import { RunSession, shortModel } from "../core/run-session.ts"
import { TASK_FILE_DEFAULTS, MODEL_DEFAULTS } from "../core/ui-defaults.ts"

const log = createLogger("bench-orchestrator")

// ---------------------------------------------------------------------------
// Progress Management
// ---------------------------------------------------------------------------

function progressPath(sessionId: string): string {
  return path.join(getBenchLogDir(sessionId), "progress.json")
}

async function loadProgress(sessionId: string): Promise<BenchProgress | null> {
  try {
    const raw = await Bun.file(progressPath(sessionId)).text()
    return JSON.parse(raw) as BenchProgress
  } catch {
    return null
  }
}

async function saveProgress(progress: BenchProgress): Promise<void> {
  const dir = getBenchLogDir(progress.sessionId)
  await mkdir(dir, { recursive: true })
  await Bun.write(progressPath(progress.sessionId), JSON.stringify(progress, null, 2))
}

function completedRunCount(progress: BenchProgress, taskId: string, condition: BenchCondition): number {
  return progress.entries.filter(e => e.taskId === taskId && e.condition === condition).length
}

function getCompletedResults(progress: BenchProgress, taskId: string, condition: BenchCondition): ConditionResult[] {
  return progress.entries
    .filter(e => e.taskId === taskId && e.condition === condition)
    .map(e => e.result)
}

// ---------------------------------------------------------------------------
// Bench Config Loading
// ---------------------------------------------------------------------------

async function loadBenchConfig(): Promise<BenchConfigFile> {
  // bench/config.json is legacy (was stored alongside the private bench tree).
  // The OSS layout doesn't ship one — fall back to defaults.
  return BenchConfigFileSchema.parse({})
}

// ---------------------------------------------------------------------------
// Bench Session Context
// ---------------------------------------------------------------------------

/** Payload for each scheduled work item. */
interface BenchWorkPayload {
  task: BenchTask
  condition: BenchCondition
  skills: ResolvedSkill[]
  runIndex?: number
}

/** Per-(adapter, model) session context, created during prepareBenchSession. */
interface BenchSessionContext {
  sessionId: string
  config: BenchRunConfig
  progress: BenchProgress
  taskResultsMap: Map<string, ConditionResult[]>
  tasks: BenchTask[]
  tcp: TCP | undefined
  evaluatorConfig: EvaluatorConfig | undefined
  providerFactory: (cfg: AdapterConfig) => LLMProvider
  compilerProvider: LLMProvider | undefined
  benchLogDir: string
  asyncJudgeDir: string | undefined
  adapterConfig: AdapterConfig
  createConvLog: (taskId: string, label: string) => Promise<ConversationLog>
  buildEvalOptions: (taskId: string, condition: string) => EvaluateAllOptions | undefined
}

/** Runner handle for the scheduler. */
interface BenchRunner extends RunnerHandle {
  adapter: AgentAdapter
}

// ---------------------------------------------------------------------------
// Prepare / Execute / Finalize — the 3 phases of a benchmark session
// ---------------------------------------------------------------------------

/**
 * Phase 1: Prepare a benchmark session. Loads tasks, skills, progress, and
 * builds the list of work items to dispatch.
 */
async function prepareBenchSession(config: BenchRunConfig): Promise<{
  workItems: WorkItem<BenchWorkPayload>[]
  ctx: BenchSessionContext
}> {
  const conditionTag = [...config.conditions].sort().join("+")
  const sessionId = config.resumeSession ?? RunSession.generateId("bench", `${shortModel(config.model)}-${conditionTag}`)
  const startedAt = new Date().toISOString()

  log.info(`=== SkVM Benchmark ===`)
  log.info(`Session: ${sessionId}`)
  log.info(`Model: ${config.model}`)
  log.info(`Adapter: ${config.adapter}`)
  log.info(`Conditions: ${config.conditions.join(", ")}`)

  // 1. Load bench config
  const benchConfig = await loadBenchConfig()

  // 2. Load tasks
  const allTasks = await loadTasks({ excludedTasks: benchConfig.excludedTasks })
  let tasks = allTasks

  if (config.source) {
    const sources = Array.isArray(config.source) ? config.source : [config.source]
    tasks = tasks.filter(t => t.origin?.source !== undefined && sources.includes(t.origin.source))
    log.info(`Source filter: ${sources.join(", ")} (${tasks.length} tasks)`)
  }
  if (config.tasks && config.tasks.length > 0) {
    const requested = new Set(config.tasks)
    tasks = tasks.filter(t => requested.has(t.id))
  }
  const hostSkipped = tasks.filter(t => t.hostReady === false)
  if (hostSkipped.length > 0) {
    tasks = tasks.filter(t => t.hostReady !== false)
    log.info(`Skipped ${hostSkipped.length} Docker-only tasks: ${hostSkipped.map(t => t.id).join(", ")}`)
  }
  const DOCKER_PATH_RE = /\/home\/\w+\/build\/|\/opt\/(?!homebrew)\w+\//
  for (const t of tasks) {
    if (DOCKER_PATH_RE.test(t.prompt)) {
      log.warn(`Task ${t.id} has Docker-style paths in prompt but hostReady≠false — may fail outside Docker`)
    }
  }
  log.info(`Tasks: ${tasks.length} loaded (${allTasks.length - tasks.length} filtered)`)

  // 3. (Skills are resolved per task via task.skill path bindings — no global registry.)

  // 4. Load or init progress
  let progress: BenchProgress
  if (config.resumeSession) {
    const existing = await loadProgress(config.resumeSession)
    if (existing) {
      progress = existing
      log.info(`Resuming session with ${existing.entries.length} completed entries`)
    } else {
      progress = { sessionId, model: config.model, adapter: config.adapter, startedAt, entries: [] }
    }
  } else {
    progress = { sessionId, model: config.model, adapter: config.adapter, startedAt, entries: [] }
  }

  // 6. Adapter config + providers
  const adapterConfig: AdapterConfig = {
    model: config.model,
    maxSteps: config.maxSteps,
    timeoutMs: TASK_FILE_DEFAULTS.timeoutMs * config.timeoutMult,
  }

  const providerFactory = (cfg: AdapterConfig): LLMProvider => createProviderForModel(cfg.model)

  let evaluatorConfig: EvaluatorConfig | undefined
  if (config.judgeModel) {
    evaluatorConfig = {
      llmProvider: createProviderForModel(config.judgeModel),
    }
  }

  // Compiler provider is only needed when the condition set contains at
  // least one AOT condition (`aot-p1`, `aot-p1p2`, …). Create it eagerly
  // during setup in that case so a misconfigured route / missing API key
  // fails fast with a clear ProviderAuthError instead of getting swallowed
  // into per-task runtime errors mid-bench. When no AOT condition is
  // present, skip entirely — we don't want to punish users who only run
  // no-skill / original / jit-optimized / jit-boost for not having a
  // compiler key set up.
  let compilerProvider: LLMProvider | undefined
  const compilerModel = config.compilerModel ?? MODEL_DEFAULTS.compiler
  if (config.conditions.some((c) => isAotCondition(c))) {
    compilerProvider = createProviderForModel(compilerModel)
    log.info(`Compiler provider: ${compilerProvider.name} (${compilerModel})`)
  }

  let tcp: TCP | undefined
  if (config.tcpPath) {
    try {
      const raw = await Bun.file(config.tcpPath).text()
      tcp = JSON.parse(raw) as TCP
      log.info(`Loaded TCP from ${config.tcpPath}`)
    } catch (err) {
      log.warn(`Failed to load TCP: ${err}`)
    }
  }

  // 7. Logging + async judge
  const benchLogDir = getBenchLogDir(sessionId)
  await mkdir(benchLogDir, { recursive: true })

  // Write session metadata so log directories are self-describing
  await Bun.write(path.join(benchLogDir, "metadata.json"), JSON.stringify({
    sessionId,
    type: "single",
    model: config.model,
    adapter: config.adapter,
    conditions: config.conditions,
    tasks: config.tasks ?? null,
    source: config.source ?? null,
    concurrency: config.concurrency ?? 1,
    jitRuns: config.jitRuns,
    maxSteps: config.maxSteps,
    timeoutMult: config.timeoutMult,
    judgeModel: config.judgeModel ?? null,
    compilerModel: config.compilerModel ?? null,
    asyncJudge: config.asyncJudge ?? false,
    startedAt,
  }, null, 2))
  async function createConvLog(taskId: string, label: string): Promise<ConversationLog> {
    const logPath = path.join(benchLogDir, taskId, `${label}.jsonl`)
    await mkdir(path.dirname(logPath), { recursive: true })
    return new ConversationLog(logPath)
  }

  const asyncJudgeDir = config.asyncJudge
    ? path.join(benchLogDir, "deferred-evals")
    : undefined

  function buildEvalOptions(taskId: string, condition: string): EvaluateAllOptions | undefined {
    if (!config.asyncJudge || !asyncJudgeDir) return undefined
    return {
      deferLLMJudge: true,
      onDefer: async (criterion, runResult, criterionIndex) => {
        const manifest = await collectDeferredInput(criterion, runResult, { sessionId, taskId, condition }, criterionIndex)
        await appendDeferredManifest(asyncJudgeDir, manifest)
      },
    }
  }

  // 8. Build work items
  const taskResultsMap = new Map<string, ConditionResult[]>()
  const workItems: WorkItem<BenchWorkPayload>[] = []

  for (const task of tasks) {
    let skills: ResolvedSkill[] = []
    try {
      skills = await resolveTaskSkills(task)
    } catch (err) {
      log.error(`Task ${task.id}: skill resolution failed — ${err instanceof Error ? err.message : err}`)
      continue
    }
    const hasSkill = skills.length > 0

    if (hasSkill) {
      const skillDesc = skills.map(s => s.skillId).join(", ")
      log.info(`Task ${task.id}: skill(s) ${skillDesc}`)
    }

    const runsPerTask = config.runsPerTask ?? 1

    for (const condition of config.conditions) {
      if (!hasSkill && condition !== "no-skill") continue
      if (isAotCondition(condition) && !tcp) continue

      const done = completedRunCount(progress, task.id, condition)
      if (done >= runsPerTask) {
        // All runs completed — restore from cache
        const cached = getCompletedResults(progress, task.id, condition)
        const avgScore = cached.reduce((s, r) => s + r.score, 0) / cached.length
        log.info(`[${condition}] ${task.id}: resumed (${cached.length} runs, avg=${avgScore.toFixed(2)})`)
        if (!taskResultsMap.has(task.id)) taskResultsMap.set(task.id, [])
        taskResultsMap.get(task.id)!.push(...cached)
        continue
      }

      // Partially completed — restore cached runs and schedule remaining
      if (done > 0) {
        const cached = getCompletedResults(progress, task.id, condition)
        if (!taskResultsMap.has(task.id)) taskResultsMap.set(task.id, [])
        taskResultsMap.get(task.id)!.push(...cached)
      }

      const remaining = runsPerTask - done
      for (let run = 0; run < remaining; run++) {
        workItems.push({
          adapter: config.adapter,
          model: config.model,
          payload: { task, condition, skills, runIndex: done + run },
        })
      }
    }
  }

  const ctx: BenchSessionContext = {
    sessionId, config, progress, taskResultsMap, tasks, tcp,
    evaluatorConfig, providerFactory, compilerProvider,
    benchLogDir, asyncJudgeDir, adapterConfig,
    createConvLog, buildEvalOptions,
  }

  return { workItems, ctx }
}

/**
 * Phase 2: Execute a single bench work item.
 */
async function executeBenchItem(
  adapter: AgentAdapter,
  { task, condition, skills }: BenchWorkPayload,
  ctx: BenchSessionContext,
): Promise<ConditionResult> {
  // jit-boost never defers — it needs synchronous eval for its feedback loop
  const eo = condition === "jit-boost" ? undefined : ctx.buildEvalOptions(task.id, condition)

  switch (condition) {
    case "no-skill":
      return await runNoSkill(task, adapter, ctx.adapterConfig, ctx.evaluatorConfig,
        await ctx.createConvLog(task.id, "no-skill"), eo)

    case "original": {
      return await runOriginal(
        task, adapter, ctx.adapterConfig,
        skills,
        ctx.evaluatorConfig,
        await ctx.createConvLog(task.id, "original"),
        eo,
      )
    }

    case "jit-optimized": {
      return await runJitOptimized(
        task, adapter, ctx.adapterConfig,
        skills,
        ctx.config.adapter, ctx.config.model,
        ctx.evaluatorConfig,
        await ctx.createConvLog(task.id, "jit-optimized"),
        eo,
      )
    }

    case "jit-boost": {
      const allContent = skills.map(s => s.skillContent).join("\n\n---\n\n")
      const combinedId = skills.map(s => s.skillId).join("+")
      const firstSkill = skills[0]!
      return await runJITBoost(
        task, adapter, ctx.adapterConfig,
        allContent,
        combinedId,
        firstSkill.skillDir,
        ctx.config.jitRuns,
        ctx.evaluatorConfig,
        ctx.benchLogDir,
      )
    }

    default: {
      const passes = parseAotPasses(condition)
      if (passes) {
        const allContent = skills.map(s => s.skillContent).join("\n\n---\n\n")
        const combinedId = skills.map(s => s.skillId).join("+")
        const firstSkill = skills[0]!
        return await runAOTVariant(
          task, adapter, ctx.adapterConfig,
          allContent,
          combinedId,
          firstSkill.skillPath,
          ctx.tcp!,
          ctx.compilerProvider!,
          condition,
          passes,
          ctx.evaluatorConfig,
          await ctx.createConvLog(task.id, condition),
          eo,
        )
      }
      throw new Error(`Unknown condition: ${condition}`)
    }
  }
}

/**
 * Aggregate per-criterion `evalDetails` across runs.
 *
 * Entries with an `id` are averaged across runs that carry the same id.
 * Entries without an id fall back to positional alignment (keyed by index).
 * Checkpoints are not averaged (they carry per-run diagnostics) — the first
 * run's checkpoints are kept as representative.
 */
export function averageEvalDetails(runs: { evalDetails: EvalDetail[] }[]): EvalDetail[] {
  if (runs.length === 0) return []
  interface Bucket { sum: number; count: number; first: EvalDetail }
  const buckets = new Map<string, Bucket>()
  const order: string[] = []
  for (const run of runs) {
    run.evalDetails.forEach((d, i) => {
      const key = d.id ?? `__pos_${i}`
      const cur = buckets.get(key)
      if (cur) {
        cur.sum += d.score
        cur.count += 1
      } else {
        buckets.set(key, { sum: d.score, count: 1, first: d })
        order.push(key)
      }
    })
  }
  return order.map(key => {
    const b = buckets.get(key)!
    return {
      ...b.first,
      score: b.sum / b.count,
      details: b.count < runs.length
        ? `${b.first.details} (averaged over ${b.count}/${runs.length} runs)`
        : b.first.details,
    }
  })
}

/**
 * Average multiple ConditionResults from repeated runs into a single result.
 *
 * `evalDetails` is aggregated by criterion `id` across runs — entries with the
 * same id are averaged, entries without an id fall back to positional alignment.
 * The averaged details become the new source of truth for downstream reporters.
 *
 * Invariant (mirrors the runner gate): when ANY repetition was non-'ok' the
 * aggregate is tainted AND score=0/pass=false. Order-independent. Two reasons:
 *
 *   1. Some downstream readers (`src/bench/compare.ts`, the per-task console
 *      table in `printSummary`) read `.score`/`.pass` directly without
 *      consulting `runStatus`. If we leave a positive average sitting on a
 *      tainted row, those readers will silently surface the original
 *      false-positive bug all over again.
 *   2. It keeps `ConditionResult` self-consistent — the same invariant holds
 *      for single-row tainted results out of the runner gate, so consumers
 *      never have to special-case the runsPerTask layer.
 *
 * Per-run scores are still preserved in `runScores` for forensics. Cost,
 * tokens, and durations remain averaged over ALL runs — those are real
 * resources spent on the attempt regardless of evaluability.
 */
export function averageConditionResults(runs: ConditionResult[]): ConditionResult {
  const n = runs.length
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / n
  const scores = runs.map(r => r.score)

  const evaluable = runs.filter(r => r.runStatus === undefined || r.runStatus === "ok")
  const firstTainted = runs.find(r => r.runStatus !== undefined && r.runStatus !== "ok")
  const allOk = firstTainted === undefined

  // Tainted aggregate ⇒ score=0/pass=false (runner-gate invariant).
  // All-ok aggregate ⇒ true average over the evaluable set.
  const avgScore = allOk
    ? (evaluable.length > 0
        ? evaluable.reduce((s, r) => s + r.score, 0) / evaluable.length
        : 0)
    : 0

  return {
    ...runs[0]!,
    score: avgScore,
    pass: allOk && avgScore >= 0.5,
    // Tainted aggregate ⇒ no eval breakdown. Otherwise the markdown
    // "Task Eval Details" section would render a full per-criterion
    // breakdown (sourced from the successful repetition) attached to a
    // row marked ⚠ — making it look like the timed-out attempt was
    // evaluated. Per-run scores are still preserved in `runScores` for
    // forensics. See round-4 Codex review.
    evalDetails: allOk ? averageEvalDetails(runs) : [],
    tokens: {
      input: Math.round(avg(runs.map(r => r.tokens.input))),
      output: Math.round(avg(runs.map(r => r.tokens.output))),
      cacheRead: Math.round(avg(runs.map(r => r.tokens.cacheRead))),
      cacheWrite: Math.round(avg(runs.map(r => r.tokens.cacheWrite))),
    },
    cost: avg(runs.map(r => r.cost)),
    durationMs: avg(runs.map(r => r.durationMs)),
    llmDurationMs: avg(runs.map(r => r.llmDurationMs)),
    steps: Math.round(avg(runs.map(r => r.steps))),
    runScores: scores,
    // First non-ok wins — informative enough for the status detail, and
    // avoids inventing a new "mixed" enum value.
    runStatus: allOk ? "ok" : firstTainted!.runStatus,
    ...(firstTainted?.statusDetail
      ? { statusDetail: `${evaluable.length}/${n} runs evaluable; first taint: ${firstTainted.statusDetail}` }
      : !allOk
        ? { statusDetail: `${evaluable.length}/${n} runs evaluable` }
        : {}),
  }
}

/**
 * Phase 3: Run deferred judge, build task reports, generate final report.
 */
async function finalizeBenchReport(ctx: BenchSessionContext): Promise<BenchReport> {
  const { sessionId, config, taskResultsMap, tasks, evaluatorConfig, benchLogDir, asyncJudgeDir } = ctx

  // Run async LLM-judge batch (if enabled)
  if (asyncJudgeDir && config.asyncJudge) {
    const manifest = await readDeferredManifest(asyncJudgeDir)
    if (manifest.length > 0) {
      if (evaluatorConfig?.llmProvider) {
        log.info(`Running async LLM judge: ${manifest.length} entries`)
        const judgeResults = await runDeferredJudge({
          manifestDir: asyncJudgeDir,
          llmProvider: evaluatorConfig.llmProvider,
          concurrency: config.concurrency ?? 1,
        })
        mergeDeferredResults(judgeResults, taskResultsMap)
        log.info(`Async judge complete: merged ${judgeResults.length} results`)
      } else {
        log.info(`Async judge manifest written to: ${asyncJudgeDir}/manifest.jsonl`)
        log.info(`Run judge later: bun run skvm bench judge --manifest=${asyncJudgeDir}`)
      }
    }
  }

  // Build task reports (preserve original task order, aggregate multi-run results)
  const taskReports: TaskReport[] = []
  for (const task of tasks) {
    const allResults = taskResultsMap.get(task.id)
    if (allResults && allResults.length > 0) {
      // Group results by condition
      const byCondition = new Map<string, ConditionResult[]>()
      for (const r of allResults) {
        if (!byCondition.has(r.condition)) byCondition.set(r.condition, [])
        byCondition.get(r.condition)!.push(r)
      }

      const aggregated: ConditionResult[] = []
      for (const [, runs] of byCondition) {
        if (runs.length === 1) {
          aggregated.push(runs[0]!)
        } else {
          aggregated.push(averageConditionResults(runs))
        }
      }

      taskReports.push({
        taskId: task.id,
        taskName: task.name ?? task.id,
        category: task.category,
        gradingType: task.gradingType,
        conditions: aggregated,
      })
    }
  }

  // Generate report
  const report = generateReport(sessionId, config, taskReports)
  log.info(`\n`)
  printSummary(report)

  const reportPath = path.join(benchLogDir, "report.json")
  await Bun.write(reportPath, JSON.stringify(report, null, 2))
  log.info(`\nReport saved to: ${reportPath}`)

  return report
}

// ---------------------------------------------------------------------------
// Main Orchestrator
// ---------------------------------------------------------------------------

export async function runBenchmark(config: BenchRunConfig): Promise<BenchReport> {
  const { workItems, ctx } = await prepareBenchSession(config)

  // Register session (skip if resuming — original session already registered)
  let session: RunSession | undefined
  if (!config.resumeSession) {
    const conditionTag = [...config.conditions].sort().join("+")
    session = await RunSession.start({
      type: "bench",
      tag: `${shortModel(config.model)}-${conditionTag}`,
      logDir: ctx.benchLogDir,
      models: [config.model],
      harness: config.adapter,
      conditions: config.conditions,
    })
  }

  // SIGINT handler
  const sigintHandler = () => {
    console.log(`\n\nBenchmark interrupted.`)
    console.log(`Resume with: bun run skvm bench --resume=${ctx.sessionId} --model=${config.model}`)
    process.exit(130)
  }
  process.on("SIGINT", sigintHandler)

  const concurrency = config.concurrency ?? 1
  log.info(`Work items: ${workItems.length} (concurrency=${concurrency})`)

  if (workItems.length === 0) {
    if (ctx.tasks.length === 0) {
      log.error("No tasks found. Import tasks first: bun run skvm bench --import=pinchbench")
    }
    process.removeListener("SIGINT", sigintHandler)
    const report = await finalizeBenchReport(ctx)
    await session?.complete(`${report.tasks.length} tasks`)
    return report
  }

  const withProgressLock = createAsyncMutex()

  await runScheduled({
    concurrency,
    items: workItems,
    createRunner: async (adapterName, model) => {
      const adapter = createAdapter(adapterName as AdapterName, ctx.providerFactory)
      await adapter.setup({ ...ctx.adapterConfig, model })
      return {
        adapter,
        teardown: async () => adapter.teardown(),
      } satisfies BenchRunner
    },
    execute: async (runner: BenchRunner, item) => {
      let result: ConditionResult
      try {
        result = await executeBenchItem(runner.adapter, item.payload, ctx)
      } catch (err) {
        log.error(`[${item.payload.condition}] ${item.payload.task.id} error: ${err}`)
        result = {
          condition: item.payload.condition,
          score: 0, pass: false, evalDetails: [],
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          cost: 0, durationMs: 0, llmDurationMs: 0, steps: 0,
          error: String(err),
        }
      }

      const runTag = item.payload.runIndex != null && (config.runsPerTask ?? 1) > 1
        ? ` run=${item.payload.runIndex + 1}/${config.runsPerTask}`
        : ""
      log.info(`[${item.payload.condition}] ${item.payload.task.id}:${runTag} score=${result.score.toFixed(2)} ${result.pass ? "PASS" : "FAIL"}`)

      await withProgressLock(async () => {
        if (!ctx.taskResultsMap.has(item.payload.task.id)) ctx.taskResultsMap.set(item.payload.task.id, [])
        ctx.taskResultsMap.get(item.payload.task.id)!.push(result)
        ctx.progress.entries.push({ taskId: item.payload.task.id, condition: item.payload.condition, result })
        await saveProgress(ctx.progress)
      })
    },
  })

  process.removeListener("SIGINT", sigintHandler)
  const report = await finalizeBenchReport(ctx)
  await session?.complete(`${report.tasks.length} tasks`)
  return report
}

// ---------------------------------------------------------------------------
// Multi-Model Benchmark
// ---------------------------------------------------------------------------

export async function runMultiModelBenchmark(
  models: string[],
  baseConfig: Omit<BenchRunConfig, "model">,
): Promise<MultiModelReport> {
  const conditionTag = [...(baseConfig.conditions ?? [])].sort().join("+")
  const tag = `${models.length}m-${conditionTag}`
  const sessionId = RunSession.generateId("bench", tag)
  const startedAt = new Date().toISOString()
  const totalConcurrency = baseConfig.concurrency ?? 1

  const multiLogDir = getBenchLogDir(sessionId)
  const session = await RunSession.start({
    type: "bench",
    tag,
    logDir: multiLogDir,
    models,
    harness: baseConfig.adapter,
    conditions: baseConfig.conditions,
  })

  log.info(`=== Multi-Model SkVM Benchmark ===`)
  log.info(`Session: ${sessionId}`)
  log.info(`Models: ${models.length} (${models.join(", ")})`)
  log.info(`Concurrency: ${totalConcurrency}`)

  // Write session metadata
  await mkdir(multiLogDir, { recursive: true })
  await Bun.write(path.join(multiLogDir, "metadata.json"), JSON.stringify({
    sessionId,
    type: "multi-model",
    models,
    adapter: baseConfig.adapter,
    conditions: baseConfig.conditions,
    tasks: baseConfig.tasks ?? null,
    source: baseConfig.source ?? null,
    concurrency: totalConcurrency,
    jitRuns: baseConfig.jitRuns,
    maxSteps: baseConfig.maxSteps,
    timeoutMult: baseConfig.timeoutMult,
    judgeModel: baseConfig.judgeModel ?? null,
    compilerModel: baseConfig.compilerModel ?? null,
    asyncJudge: baseConfig.asyncJudge ?? false,
    startedAt,
  }, null, 2))

  // Prepare each model's session and collect all work items
  const sessions = new Map<string, BenchSessionContext>()
  const allItems: WorkItem<BenchWorkPayload>[] = []

  for (const model of models) {
    log.info(`Preparing session for model: ${model}`)
    const { workItems, ctx } = await prepareBenchSession({ ...baseConfig, model })
    sessions.set(model, ctx)
    allItems.push(...workItems)
  }

  log.info(`Total work items: ${allItems.length} across ${models.length} models (concurrency=${totalConcurrency})`)

  // Single dispatch — scheduler distributes by adapter, then models sequentially,
  // with work-stealing when one model finishes faster
  const withProgressLock = createAsyncMutex()

  await runScheduled({
    concurrency: totalConcurrency,
    items: allItems,
    createRunner: async (adapterName, model) => {
      const ctx = sessions.get(model)!
      const adapter = createAdapter(adapterName as AdapterName, ctx.providerFactory)
      await adapter.setup({ ...ctx.adapterConfig, model })
      return {
        adapter,
        teardown: async () => adapter.teardown(),
      } satisfies BenchRunner
    },
    execute: async (runner: BenchRunner, item) => {
      const ctx = sessions.get(item.model)!
      let result: ConditionResult
      try {
        result = await executeBenchItem(runner.adapter, item.payload, ctx)
      } catch (err) {
        log.error(`[${item.payload.condition}] ${item.payload.task.id} error: ${err}`)
        result = {
          condition: item.payload.condition,
          score: 0, pass: false, evalDetails: [],
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          cost: 0, durationMs: 0, llmDurationMs: 0, steps: 0,
          error: String(err),
        }
      }

      const runTag = item.payload.runIndex != null && (baseConfig.runsPerTask ?? 1) > 1
        ? ` run=${item.payload.runIndex + 1}/${baseConfig.runsPerTask}`
        : ""
      log.info(`[${item.model}] [${item.payload.condition}] ${item.payload.task.id}:${runTag} score=${result.score.toFixed(2)} ${result.pass ? "PASS" : "FAIL"}`)

      await withProgressLock(async () => {
        if (!ctx.taskResultsMap.has(item.payload.task.id)) ctx.taskResultsMap.set(item.payload.task.id, [])
        ctx.taskResultsMap.get(item.payload.task.id)!.push(result)
        ctx.progress.entries.push({ taskId: item.payload.task.id, condition: item.payload.condition, result })
        await saveProgress(ctx.progress)
      })
    },
  })

  // Finalize each model's report
  const reports: BenchReport[] = []
  for (const model of models) {
    try {
      reports.push(await finalizeBenchReport(sessions.get(model)!))
    } catch (err) {
      log.error(`Model ${model} finalize failed: ${err}`)
      reports.push({
        sessionId: `${sessionId}-${safeModelName(model)}`,
        model,
        adapter: baseConfig.adapter,
        timestamp: new Date().toISOString(),
        tasks: [],
        summary: {
          taskCount: 0, perCondition: {}, perCategory: {},
          delta: { originalVsBaseline: null, aotVsOriginal: null, jitVsAot: null },
        },
      })
    }
  }

  const comparison = buildComparison(reports)

  const multiReport: MultiModelReport = {
    sessionId,
    timestamp: startedAt,
    completedAt: new Date().toISOString(),
    models,
    reports,
    comparison,
  }

  printMultiModelSummary(multiReport)

  // Save to logs/bench/{sessionId}/ (dir already created for metadata above)
  const reportPath = path.join(multiLogDir, "report.json")
  await Bun.write(reportPath, JSON.stringify(multiReport, null, 2))
  log.info(`\nMulti-model report: ${reportPath}`)

  const mdPath = path.join(multiLogDir, "report.md")
  await Bun.write(mdPath, generateMultiModelMarkdown(multiReport))
  log.info(`Markdown report: ${mdPath}`)

  await session.complete(`${models.length} models, ${reports.reduce((n, r) => n + r.tasks.length, 0)} tasks`)
  return multiReport
}

function buildComparison(reports: BenchReport[]): MultiModelReport["comparison"] {
  const scoreMatrix: Record<string, Partial<Record<BenchCondition, number>>> = {}
  const tokenMatrix: Record<string, Partial<Record<BenchCondition, number>>> = {}
  const taskMatrix: Record<string, Record<string, number>> = {}
  const ranking: { model: string; avgScore: number | null; passRate: number | null }[] = []

  for (const report of reports) {
    const model = report.model
    scoreMatrix[model] = {}
    tokenMatrix[model] = {}

    for (const [cond, summary] of Object.entries(report.summary.perCondition)) {
      if (summary) {
        // Skip conditions with no evaluable rows — a null avgScore would be
        // misread as "0.00" by consumers of the matrix.
        if (summary.avgScore !== null) {
          scoreMatrix[model]![cond as BenchCondition] = summary.avgScore
        }
        tokenMatrix[model]![cond as BenchCondition] = summary.avgTokens
      }
    }

    // Per-task best score — only consider evaluable rows.
    for (const task of report.tasks) {
      if (!taskMatrix[task.taskId]) taskMatrix[task.taskId] = {}
      const evaluable = task.conditions.filter(c => c.runStatus === undefined || c.runStatus === "ok")
      if (evaluable.length > 0) {
        taskMatrix[task.taskId]![model] = evaluable.reduce((max, c) => Math.max(max, c.score), 0)
      }
    }

    // Overall ranking: average across evaluable (non-tainted) rows only.
    // Including a tainted row in the denominator either as 0 or as its
    // residual score pollutes the cross-model ranking. When NO rows are
    // evaluable (every task tainted), avgScore/passRate are `null` rather
    // than 0 — matches the `ConditionSummary` sentinel and keeps "no
    // comparable data" distinct from "evaluated and failed".
    const evaluableConds = report.tasks
      .flatMap(t => t.conditions)
      .filter(c => c.runStatus === undefined || c.runStatus === "ok")
    const allScores = evaluableConds.map(c => c.score)
    const allPasses = evaluableConds.map(c => c.pass)
    ranking.push({
      model,
      avgScore: allScores.length > 0 ? allScores.reduce((a, b) => a + b, 0) / allScores.length : null,
      passRate: allPasses.length > 0 ? allPasses.filter(Boolean).length / allPasses.length : null,
    })
  }

  // Sort: real scores descending, null entries (no evaluable data) at the bottom.
  ranking.sort((a, b) => {
    if (a.avgScore === null && b.avgScore === null) return 0
    if (a.avgScore === null) return 1
    if (b.avgScore === null) return -1
    return b.avgScore - a.avgScore
  })

  return { scoreMatrix, tokenMatrix, taskMatrix, ranking }
}

// ---------------------------------------------------------------------------
// Multi-Adapter Benchmark
// ---------------------------------------------------------------------------

export async function runMultiAdapterBenchmark(
  adapters: AdapterName[],
  baseConfig: Omit<BenchRunConfig, "adapter">,
): Promise<MultiAdapterReport> {
  const conditionTag = [...(baseConfig.conditions ?? [])].sort().join("+")
  const tag = `${adapters.length}a-${shortModel(baseConfig.model)}-${conditionTag}`
  const sessionId = RunSession.generateId("bench", tag)
  const startedAt = new Date().toISOString()
  const totalConcurrency = baseConfig.concurrency ?? 1

  const multiLogDir = getBenchLogDir(sessionId)
  const session = await RunSession.start({
    type: "bench",
    tag,
    logDir: multiLogDir,
    models: [baseConfig.model],
    harness: adapters.join(","),
    conditions: baseConfig.conditions,
  })

  log.info(`=== Multi-Adapter SkVM Benchmark ===`)
  log.info(`Session: ${sessionId}`)
  log.info(`Model: ${baseConfig.model}`)
  log.info(`Adapters: ${adapters.length} (${adapters.join(", ")})`)
  log.info(`Concurrency: ${totalConcurrency}`)

  // Write session metadata
  await mkdir(multiLogDir, { recursive: true })
  await Bun.write(path.join(multiLogDir, "metadata.json"), JSON.stringify({
    sessionId,
    type: "multi-adapter",
    model: baseConfig.model,
    adapters,
    conditions: baseConfig.conditions,
    tasks: baseConfig.tasks ?? null,
    source: baseConfig.source ?? null,
    concurrency: totalConcurrency,
    jitRuns: baseConfig.jitRuns,
    maxSteps: baseConfig.maxSteps,
    timeoutMult: baseConfig.timeoutMult,
    judgeModel: baseConfig.judgeModel ?? null,
    compilerModel: baseConfig.compilerModel ?? null,
    asyncJudge: baseConfig.asyncJudge ?? false,
    startedAt,
  }, null, 2))

  // Prepare each adapter's session and collect all work items
  const sessionKey = (adapter: string) => `${adapter}::${baseConfig.model}`
  const sessions = new Map<string, BenchSessionContext>()
  const allItems: WorkItem<BenchWorkPayload>[] = []

  for (const adapter of adapters) {
    log.info(`Preparing session for adapter: ${adapter}`)
    const { workItems, ctx } = await prepareBenchSession({ ...baseConfig, adapter })
    sessions.set(sessionKey(adapter), ctx)
    allItems.push(...workItems)
  }

  log.info(`Total work items: ${allItems.length} across ${adapters.length} adapters (concurrency=${totalConcurrency})`)

  const withProgressLock = createAsyncMutex()

  await runScheduled({
    concurrency: totalConcurrency,
    items: allItems,
    createRunner: async (adapterName, model) => {
      const ctx = sessions.get(sessionKey(adapterName))!
      const adapter = createAdapter(adapterName as AdapterName, ctx.providerFactory)
      await adapter.setup({ ...ctx.adapterConfig, model })
      return {
        adapter,
        teardown: async () => adapter.teardown(),
      } satisfies BenchRunner
    },
    execute: async (runner: BenchRunner, item) => {
      const ctx = sessions.get(sessionKey(item.adapter))!
      let result: ConditionResult
      try {
        result = await executeBenchItem(runner.adapter, item.payload, ctx)
      } catch (err) {
        log.error(`[${item.payload.condition}] ${item.payload.task.id} error: ${err}`)
        result = {
          condition: item.payload.condition,
          score: 0, pass: false, evalDetails: [],
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          cost: 0, durationMs: 0, llmDurationMs: 0, steps: 0,
          error: String(err),
        }
      }

      const runTag = item.payload.runIndex != null && (baseConfig.runsPerTask ?? 1) > 1
        ? ` run=${item.payload.runIndex + 1}/${baseConfig.runsPerTask}`
        : ""
      log.info(`[${item.adapter}] [${item.payload.condition}] ${item.payload.task.id}:${runTag} score=${result.score.toFixed(2)} ${result.pass ? "PASS" : "FAIL"}`)

      await withProgressLock(async () => {
        if (!ctx.taskResultsMap.has(item.payload.task.id)) ctx.taskResultsMap.set(item.payload.task.id, [])
        ctx.taskResultsMap.get(item.payload.task.id)!.push(result)
        ctx.progress.entries.push({ taskId: item.payload.task.id, condition: item.payload.condition, result })
        await saveProgress(ctx.progress)
      })
    },
  })

  // Finalize each adapter's report
  const reports: BenchReport[] = []
  for (const adapter of adapters) {
    try {
      reports.push(await finalizeBenchReport(sessions.get(sessionKey(adapter))!))
    } catch (err) {
      log.error(`Adapter ${adapter} finalize failed: ${err}`)
      reports.push({
        sessionId: `${sessionId}-${adapter}`,
        model: baseConfig.model,
        adapter,
        timestamp: new Date().toISOString(),
        tasks: [],
        summary: {
          taskCount: 0, perCondition: {}, perCategory: {},
          delta: { originalVsBaseline: null, aotVsOriginal: null, jitVsAot: null },
        },
      })
    }
  }

  const comparison = buildAdapterComparison(reports)

  const multiReport: MultiAdapterReport = {
    sessionId,
    timestamp: startedAt,
    completedAt: new Date().toISOString(),
    model: baseConfig.model,
    adapters,
    reports,
    comparison,
  }

  printMultiAdapterSummary(multiReport)

  // Save to logs/bench/{sessionId}/ (dir already created for metadata above)
  const reportPath = path.join(multiLogDir, "report.json")
  await Bun.write(reportPath, JSON.stringify(multiReport, null, 2))
  log.info(`\nMulti-adapter report: ${reportPath}`)

  const mdPath = path.join(multiLogDir, "report.md")
  await Bun.write(mdPath, generateMultiAdapterMarkdown(multiReport))
  log.info(`Markdown report: ${mdPath}`)

  await session.complete(`${adapters.length} adapters, ${reports.reduce((n, r) => n + r.tasks.length, 0)} tasks`)
  return multiReport
}

function buildAdapterComparison(reports: BenchReport[]): MultiAdapterReport["comparison"] {
  const scoreMatrix: Record<string, Partial<Record<BenchCondition, number>>> = {}
  const tokenMatrix: Record<string, Partial<Record<BenchCondition, number>>> = {}
  const taskMatrix: Record<string, Record<string, number>> = {}
  const ranking: { adapter: string; avgScore: number | null; passRate: number | null }[] = []

  for (const report of reports) {
    const adapter = report.adapter
    scoreMatrix[adapter] = {}
    tokenMatrix[adapter] = {}

    for (const [cond, summary] of Object.entries(report.summary.perCondition)) {
      if (summary) {
        if (summary.avgScore !== null) {
          scoreMatrix[adapter]![cond as BenchCondition] = summary.avgScore
        }
        tokenMatrix[adapter]![cond as BenchCondition] = summary.avgTokens
      }
    }

    for (const task of report.tasks) {
      if (!taskMatrix[task.taskId]) taskMatrix[task.taskId] = {}
      const evaluable = task.conditions.filter(c => c.runStatus === undefined || c.runStatus === "ok")
      if (evaluable.length > 0) {
        taskMatrix[task.taskId]![adapter] = evaluable.reduce((max, c) => Math.max(max, c.score), 0)
      }
    }

    // Exclude tainted rows from the ranking denominator. All-tainted adapter
    // ⇒ null sentinel (matches ConditionSummary semantics).
    const evaluableConds = report.tasks
      .flatMap(t => t.conditions)
      .filter(c => c.runStatus === undefined || c.runStatus === "ok")
    const allScores = evaluableConds.map(c => c.score)
    const allPasses = evaluableConds.map(c => c.pass)
    ranking.push({
      adapter,
      avgScore: allScores.length > 0 ? allScores.reduce((a, b) => a + b, 0) / allScores.length : null,
      passRate: allPasses.length > 0 ? allPasses.filter(Boolean).length / allPasses.length : null,
    })
  }

  // Real scores descending, null entries at the bottom.
  ranking.sort((a, b) => {
    if (a.avgScore === null && b.avgScore === null) return 0
    if (a.avgScore === null) return 1
    if (b.avgScore === null) return -1
    return b.avgScore - a.avgScore
  })

  return { scoreMatrix, tokenMatrix, taskMatrix, ranking }
}

/** Load bench config (exported for CLI use) */
export { loadBenchConfig }

