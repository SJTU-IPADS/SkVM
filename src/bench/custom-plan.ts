import path from "node:path"
import { mkdir, readdir, copyFile } from "node:fs/promises"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { parse as parseYaml } from "yaml"
import type { AgentAdapter, AdapterConfig } from "../core/types.ts"
import type { LLMProvider } from "../providers/types.ts"
import type { EvaluatorConfig } from "../framework/evaluator.ts"
import type {
  BenchTask, BenchCondition, BenchRunConfig, BenchReport, TaskReport, ConditionResult,
} from "./types.ts"
import { runCustomSkill, runNoSkill } from "./conditions.ts"
import { averageConditionResults } from "./orchestrator.ts"
import { hydrateEvalPayloads } from "./evaluators/index.ts"
import { generateReport, printSummary, generateMarkdown } from "./reporter.ts"
import { type AdapterName, createAdapter, isAdapterName } from "../adapters/registry.ts"
import { getBenchLogDir, SKVM_TASKS_DIR } from "../core/config.ts"
import { createProviderForModel } from "../providers/registry.ts"
import { createLogger } from "../core/logger.ts"
import { ConversationLog } from "../core/conversation-logger.ts"
import { runScheduled, createAsyncMutex, type WorkItem, type RunnerHandle } from "../core/concurrency.ts"
import { RunSession, shortModel } from "../core/run-session.ts"
import { TASK_FILE_DEFAULTS, CLI_DEFAULTS } from "../core/ui-defaults.ts"

const log = createLogger("bench-custom")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CustomPlanDefaults {
  model?: string
  adapter?: string
  concurrency?: number
  "judge-model"?: string
  "timeout-mult"?: number
  "max-steps"?: number
  "runs-per-task"?: number
}

export interface CustomPlanGroup {
  label?: string
  model?: string
  adapter?: string
  skill?: string
  tasks?: string[]
  groups?: CustomPlanGroup[]
  // Allow defaults fields at group level too
  concurrency?: number
  "judge-model"?: string
  "timeout-mult"?: number
  "max-steps"?: number
  "runs-per-task"?: number
}

export interface CustomPlanFile {
  defaults?: CustomPlanDefaults
  groups: CustomPlanGroup[]
}

/** Flattened work item produced from recursive group traversal. */
interface PlanWorkItem {
  label: string
  model: string
  adapter: string
  taskId: string
  skillDir?: string   // undefined = no-skill
  judgeModel?: string
  timeoutMult: number
  maxSteps: number
  runsPerTask: number
}

/** Context inherited during recursive flattening. */
interface InheritedContext {
  model?: string
  adapter?: string
  skill?: string
  label?: string
  judgeModel?: string
  timeoutMult: number
  maxSteps: number
  runsPerTask: number
}

// ---------------------------------------------------------------------------
// YAML Parsing + Flattening
// ---------------------------------------------------------------------------

export async function parseCustomPlan(yamlPath: string): Promise<{
  workItems: PlanWorkItem[]
  concurrency: number
}> {
  const raw = await Bun.file(yamlPath).text()
  const plan = parseYaml(raw) as CustomPlanFile

  if (!plan.groups || plan.groups.length === 0) {
    throw new Error("Custom plan must have at least one group")
  }

  const baseCtx: InheritedContext = {
    model: plan.defaults?.model,
    adapter: plan.defaults?.adapter,
    judgeModel: plan.defaults?.["judge-model"],
    timeoutMult: plan.defaults?.["timeout-mult"] ?? CLI_DEFAULTS.timeoutMult,
    maxSteps: plan.defaults?.["max-steps"] ?? CLI_DEFAULTS.maxSteps,
    runsPerTask: plan.defaults?.["runs-per-task"] ?? CLI_DEFAULTS.benchRunsPerTask,
  }

  const workItems: PlanWorkItem[] = []

  function flatten(group: CustomPlanGroup, parent: InheritedContext): void {
    // Merge: group overrides parent
    const ctx: InheritedContext = {
      model: group.model ?? parent.model,
      adapter: group.adapter ?? parent.adapter,
      skill: group.skill ?? parent.skill,
      label: group.label ?? parent.label,
      judgeModel: group["judge-model"] ?? parent.judgeModel,
      timeoutMult: group["timeout-mult"] ?? parent.timeoutMult,
      maxSteps: group["max-steps"] ?? parent.maxSteps,
      runsPerTask: group["runs-per-task"] ?? parent.runsPerTask,
    }

    if (group.tasks) {
      // Leaf group — emit work items
      if (!ctx.label) throw new Error(`Leaf group with tasks must have a label`)
      if (!ctx.model) throw new Error(`Leaf group "${ctx.label}" has no model (set in defaults or parent group)`)
      if (!ctx.adapter) throw new Error(`Leaf group "${ctx.label}" has no adapter (set in defaults or parent group)`)

      for (const taskRef of group.tasks) {
        workItems.push({
          label: ctx.label,
          model: ctx.model,
          adapter: ctx.adapter,
          taskId: taskRef,
          skillDir: ctx.skill ? resolveSkillPath(ctx.skill) : undefined,
          judgeModel: ctx.judgeModel,
          timeoutMult: ctx.timeoutMult,
          maxSteps: ctx.maxSteps,
          runsPerTask: ctx.runsPerTask,
        })
      }
    }

    if (group.groups) {
      for (const child of group.groups) {
        flatten(child, ctx)
      }
    }
  }

  for (const group of plan.groups) {
    flatten(group, baseCtx)
  }

  if (workItems.length === 0) {
    throw new Error("Custom plan produced no work items — check that leaf groups have tasks")
  }

  return {
    workItems,
    concurrency: plan.defaults?.concurrency ?? CLI_DEFAULTS.concurrency,
  }
}

// ---------------------------------------------------------------------------
// Path Resolution
// ---------------------------------------------------------------------------

/** Resolve skill reference: always a path (absolute or relative to CWD). */
function resolveSkillPath(ref: string): string {
  if (path.isAbsolute(ref)) return ref
  return path.resolve(ref)
}

/**
 * Resolve task reference:
 * - Bare name (no `/`) → walk SKVM_TASKS_DIR/<name>/task.json
 * - Otherwise → treat as filesystem path (absolute or CWD-relative)
 */
function resolveTaskPath(ref: string): string {
  if (!ref.includes("/")) {
    return path.join(SKVM_TASKS_DIR, ref)
  }
  if (path.isAbsolute(ref)) return ref
  return path.resolve(ref)
}

// ---------------------------------------------------------------------------
// Progress tracking for resume support
// ---------------------------------------------------------------------------

interface CustomProgressEntry {
  taskId: string
  condition: string  // label from the plan
  model: string
  adapter: string
  result: ConditionResult
}

interface CustomProgress {
  sessionId: string
  yamlPath: string
  startedAt: string
  entries: CustomProgressEntry[]
}

function progressPath(sessionId: string): string {
  return path.join(getBenchLogDir(sessionId), "progress.json")
}

async function loadCustomProgress(sessionId: string): Promise<CustomProgress | null> {
  try {
    const raw = await Bun.file(progressPath(sessionId)).text()
    return JSON.parse(raw) as CustomProgress
  } catch {
    return null
  }
}

async function saveCustomProgress(progress: CustomProgress): Promise<void> {
  const dir = getBenchLogDir(progress.sessionId)
  await mkdir(dir, { recursive: true })
  await Bun.write(progressPath(progress.sessionId), JSON.stringify(progress, null, 2))
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface CustomRunner extends RunnerHandle {
  adapter: AgentAdapter
}

interface CustomWorkPayload {
  item: PlanWorkItem
  task: BenchTask
  skillDir?: string   // resolved absolute path (undefined = no-skill, or bare ID resolved to dir)
}

export async function executeCustomPlan(yamlPath: string, resumeSession?: string): Promise<void> {
  const { workItems, concurrency } = await parseCustomPlan(yamlPath)

  log.info(`Custom plan: ${workItems.length} work items, concurrency=${concurrency}`)

  // 1. Resolve tasks and skills → build scheduler work items
  //    Task references are always paths after resolveTaskPath() — either an
  //    explicit filesystem path or SKVM_TASKS_DIR/<bare-name>.
  //    Skill references are always paths too — no registry lookup.
  const taskCache = new Map<string, BenchTask>()
  let resolvedItems: WorkItem<CustomWorkPayload>[] = []

  for (const item of workItems) {
    const taskDir = resolveTaskPath(item.taskId)
    let task = taskCache.get(taskDir)
    if (!task) {
      const loaded = await loadTaskFromPath(taskDir)
      if (!loaded) {
        log.warn(`Task "${item.taskId}" not found at ${taskDir} — skipping`)
        continue
      }
      taskCache.set(taskDir, loaded)
      task = loaded
    }

    // Skill dir is already resolved to an absolute path by resolveSkillPath()
    const skillDir = item.skillDir

    const runsPerTask = item.runsPerTask
    for (let run = 0; run < runsPerTask; run++) {
      resolvedItems.push({
        adapter: item.adapter,
        model: item.model,
        payload: { item, task, skillDir },
      })
    }
  }

  // Build a taskId → task map for report generation (driven by resolvedItems)
  const taskMap = new Map<string, BenchTask>()
  for (const r of resolvedItems) {
    taskMap.set(r.payload.task.id, r.payload.task)
  }

  if (resolvedItems.length === 0) {
    log.error("No resolvable work items — nothing to run")
    return
  }

  // 5. Session setup + resume
  const labels = [...new Set(workItems.map(w => w.label))].sort()
  const models = [...new Set(workItems.map(w => w.model))]
  const adapters = [...new Set(workItems.map(w => w.adapter))]
  const sessionId = resumeSession ?? RunSession.generateId("bench", `custom-${labels.slice(0, 3).join("+")}`)

  const benchLogDir = getBenchLogDir(sessionId)
  await mkdir(benchLogDir, { recursive: true })

  // 5a. Load progress if resuming
  const resultsByKey = new Map<string, Map<string, ConditionResult[]>>()

  function resultKey(model: string, adapter: string): string {
    return `${model}::${adapter}`
  }

  let progress: CustomProgress
  if (resumeSession) {
    const existing = await loadCustomProgress(resumeSession)
    if (existing) {
      progress = existing
      log.info(`Resuming session with ${existing.entries.length} completed entries`)

      // Restore completed results into resultsByKey
      for (const entry of existing.entries) {
        const key = resultKey(entry.model, entry.adapter)
        if (!resultsByKey.has(key)) resultsByKey.set(key, new Map())
        const taskResults = resultsByKey.get(key)!
        if (!taskResults.has(entry.taskId)) taskResults.set(entry.taskId, [])
        taskResults.get(entry.taskId)!.push(entry.result)
      }

      // Filter out completed work items
      // Build a count of completed runs per (model, adapter, taskId, label)
      const completedCounts = new Map<string, number>()
      for (const entry of existing.entries) {
        const k = `${entry.model}::${entry.adapter}::${entry.taskId}::${entry.condition}`
        completedCounts.set(k, (completedCounts.get(k) ?? 0) + 1)
      }

      // Track how many we've kept per key to handle runsPerTask > 1
      const keptCounts = new Map<string, number>()
      resolvedItems = resolvedItems.filter(item => {
        const k = `${item.model}::${item.adapter}::${item.payload.task.id}::${item.payload.item.label}`
        const done = completedCounts.get(k) ?? 0
        const kept = keptCounts.get(k) ?? 0
        if (kept < done) {
          keptCounts.set(k, kept + 1)
          return false  // skip — already completed
        }
        return true
      })

      log.info(`Remaining work items after resume: ${resolvedItems.length}`)
    } else {
      progress = { sessionId, yamlPath: path.resolve(yamlPath), startedAt: new Date().toISOString(), entries: [] }
      log.warn(`No progress found for session ${resumeSession} — starting fresh`)
    }
  } else {
    progress = { sessionId, yamlPath: path.resolve(yamlPath), startedAt: new Date().toISOString(), entries: [] }
  }

  if (resolvedItems.length === 0) {
    log.info("All work items already completed — generating reports")
  }

  // Write plan metadata (only for new sessions)
  if (!resumeSession) {
    await Bun.write(path.join(benchLogDir, "metadata.json"), JSON.stringify({
      sessionId,
      type: "custom",
      yamlPath: path.resolve(yamlPath),
      models,
      adapters,
      labels,
      totalWorkItems: resolvedItems.length,
      concurrency,
      startedAt: new Date().toISOString(),
    }, null, 2))
  }

  log.info(`Session: ${sessionId}`)
  log.info(`Models: ${models.join(", ")}`)
  log.info(`Adapters: ${adapters.join(", ")}`)
  log.info(`Labels: ${labels.join(", ")}`)
  log.info(`Work items: ${resolvedItems.length}`)

  // 6. Provider factory
  const providerFactory = (model: string): LLMProvider => createProviderForModel(model)

  // Evaluator configs per judge model
  const evaluatorConfigs = new Map<string, EvaluatorConfig>()
  function getEvaluatorConfig(judgeModel?: string): EvaluatorConfig | undefined {
    if (!judgeModel) return undefined
    if (!evaluatorConfigs.has(judgeModel)) {
      evaluatorConfigs.set(judgeModel, { llmProvider: providerFactory(judgeModel) })
    }
    return evaluatorConfigs.get(judgeModel)
  }

  // 7. SIGINT handler
  const sigintHandler = () => {
    console.log(`\n\nCustom benchmark interrupted.`)
    console.log(`Resume with: bun run skvm bench --custom=${yamlPath} --resume=${sessionId}`)
    process.exit(130)
  }
  process.on("SIGINT", sigintHandler)

  // 8. Schedule and execute
  const withProgressLock = createAsyncMutex()

  if (resolvedItems.length > 0) {
    await runScheduled<CustomWorkPayload, CustomRunner>({
      concurrency,
      items: resolvedItems,
      createRunner: async (adapterName, model) => {
        if (!isAdapterName(adapterName)) {
          throw new Error(`custom-plan: unknown adapter "${adapterName}"`)
        }
        const adapter = createAdapter(adapterName, (cfg) => providerFactory(cfg.model))
        await adapter.setup({ model, maxSteps: TASK_FILE_DEFAULTS.maxSteps, timeoutMs: TASK_FILE_DEFAULTS.timeoutMs })
        return { adapter, teardown: async () => adapter.teardown() }
      },
      execute: async (runner, workItem) => {
        const { item, task, skillDir } = workItem.payload
        const adapterConfig: AdapterConfig = {
          model: item.model,
          maxSteps: item.maxSteps,
          timeoutMs: TASK_FILE_DEFAULTS.timeoutMs * item.timeoutMult,
        }
        const evaluatorConfig = getEvaluatorConfig(item.judgeModel)

        const safeModel = item.model.replace(/\//g, "--").replace(/:/g, "_")
        const logPath = path.join(benchLogDir, item.adapter, safeModel, task.id, `${item.label}.jsonl`)
        await mkdir(path.dirname(logPath), { recursive: true })
        const convLog = new ConversationLog(logPath)

        let result: ConditionResult
        if (skillDir) {
          result = await runCustomSkill(
            task, runner.adapter, adapterConfig,
            item.label, skillDir,
            evaluatorConfig, convLog,
          )
        } else {
          result = await runNoSkill(
            task, runner.adapter, adapterConfig,
            evaluatorConfig, convLog,
          )
          // Override condition name to use the plan label
          result = { ...result, condition: item.label }
        }

        await withProgressLock(async () => {
          const key = resultKey(item.model, item.adapter)
          if (!resultsByKey.has(key)) resultsByKey.set(key, new Map())
          const taskResults = resultsByKey.get(key)!
          if (!taskResults.has(task.id)) taskResults.set(task.id, [])
          taskResults.get(task.id)!.push(result)

          progress.entries.push({
            taskId: task.id,
            condition: item.label,
            model: item.model,
            adapter: item.adapter,
            result,
          })
          await saveCustomProgress(progress)
        })

        const icon = result.score >= 0.5 ? "✓" : "✗"
        log.info(`[${item.label}] ${task.id} ${icon} score=${result.score.toFixed(3)} (${(result.durationMs / 1000).toFixed(1)}s)`)
      },
      onError: (item, err) => {
        log.error(`[${item.payload.item.label}] ${item.payload.task.id} failed: ${err}`)
      },
    })
  }

  process.removeListener("SIGINT", sigintHandler)

  // 9. Generate reports per (model, adapter)
  const reports: BenchReport[] = []

  for (const [key, taskResultMap] of resultsByKey) {
    const [model, adapter] = key.split("::")
    const keyLabels = [...new Set(
      [...taskResultMap.values()].flatMap(results => results.map(r => r.condition))
    )]

    // Build task reports
    const taskReports: TaskReport[] = []
    for (const [taskId, results] of taskResultMap) {
      const task = taskMap.get(taskId) ?? resolvedItems.find(w => w.payload.task.id === taskId)?.payload.task
      if (!task) continue

      // Group by condition label, average if multiple runs
      const byLabel = new Map<string, ConditionResult[]>()
      for (const r of results) {
        if (!byLabel.has(r.condition)) byLabel.set(r.condition, [])
        byLabel.get(r.condition)!.push(r)
      }

      const aggregated: ConditionResult[] = []
      for (const [, runs] of byLabel) {
        if (runs.length === 1) {
          aggregated.push(runs[0]!)
        } else {
          aggregated.push(averageConditionResults(runs))
        }
      }

      taskReports.push({
        taskId,
        taskName: task.name ?? taskId,
        category: task.category ?? TASK_FILE_DEFAULTS.category,
        gradingType: task.gradingType ?? TASK_FILE_DEFAULTS.gradingType,
        conditions: aggregated,
      })
    }

    const config: BenchRunConfig = {
      model: model!,
      adapter: adapter! as AdapterName,
      conditions: keyLabels,
      jitRuns: 0,
      timeoutMult: CLI_DEFAULTS.timeoutMult,
      maxSteps: CLI_DEFAULTS.maxSteps,
      keepWorkDirs: false,
      verbose: false,
    }
    const report = generateReport(sessionId, config, taskReports)
    reports.push(report)
    printSummary(report)
  }

  // Save reports
  if (reports.length === 1) {
    const report = reports[0]!
    await Bun.write(path.join(benchLogDir, "report.json"), JSON.stringify(report, null, 2))
    await Bun.write(path.join(benchLogDir, "report.md"), generateMarkdown(report))
  } else {
    for (const report of reports) {
      const tag = `${shortModel(report.model)}-${report.adapter}`
      await Bun.write(path.join(benchLogDir, `report-${tag}.json`), JSON.stringify(report, null, 2))
      await Bun.write(path.join(benchLogDir, `report-${tag}.md`), generateMarkdown(report))
    }
  }

  log.info(`\nSession: ${sessionId}`)
  log.info(`Reports saved to: ${benchLogDir}`)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Load a single BenchTask from a task directory path. */
async function loadTaskFromPath(taskDir: string): Promise<BenchTask | undefined> {
  const { BenchTaskFileSchema } = await import("./types.ts")
  const taskJsonPath = path.join(taskDir, "task.json")
  try {
    const raw = JSON.parse(await Bun.file(taskJsonPath).text())
    const parsed = BenchTaskFileSchema.parse(raw)

    const { EvalCriterionSchema } = await import("../core/types.ts")
    const eval_ = parsed.eval.map(e => EvalCriterionSchema.parse(e))

    // Populate `payload` on every custom criterion via its evaluator's
    // loadPayload hook (e.g. python-grade reads the sibling grade.py).
    await hydrateEvalPayloads(eval_, taskDir)

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
      taskDir,
      hostReady: parsed.hostReady,
      difficulty: parsed.difficulty,
    }
  } catch (err) {
    log.warn(`Failed to load task from ${taskDir}: ${err}`)
    return undefined
  }
}

// Repeated-run aggregation lives in `./orchestrator.ts::averageConditionResults`
// so the runner-gate invariant ("tainted ⇒ score=0/pass=false") and the
// runStatus-propagation rules are enforced in exactly one place.
