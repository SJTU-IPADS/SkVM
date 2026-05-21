import { z } from "zod"
import { mkdir, appendFile } from "node:fs/promises"
import path from "node:path"
import type { EvalCriterion, RunResult } from "../core/types.ts"
import type { LLMProvider } from "../providers/types.ts"
import { callJudge, formatAgentTrace, collectWorkDirFiles } from "./evaluator.ts"
import { isProviderError } from "../providers/errors.ts"
import { isHeadlessAgentError } from "../core/headless-agent/index.ts"
import { createSlotPool } from "../core/concurrency.ts"
import { createLogger } from "../core/logger.ts"
import type { EvalDetail } from "../bench/types.ts"
import { computeWeightedScore } from "../bench/conditions.ts"

const log = createLogger("deferred-eval")

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const DeferredJudgeInputSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  context: z.object({
    sessionId: z.string(),
    taskId: z.string(),
    condition: z.string(),
    criterionIndex: z.number(),
    /** Criterion id from task.json — the stable key used to merge the result back into evalDetails. */
    criterionId: z.string().optional(),
  }),
  criterion: z.object({
    method: z.literal("llm-judge"),
    rubric: z.string(),
    maxScore: z.number(),
  }),
  inputs: z.object({
    trace: z.string(),
    finalOutput: z.string(),
    workDirFiles: z.string(),
  }),
})

export type DeferredJudgeInput = z.infer<typeof DeferredJudgeInputSchema>

export const DeferredJudgeResultSchema = z.object({
  id: z.string(),
  context: DeferredJudgeInputSchema.shape.context,
  pass: z.boolean(),
  score: z.number(),
  details: z.string(),
  criterion: DeferredJudgeInputSchema.shape.criterion,
  evaluatedAt: z.string(),
  /** Set when the judge couldn't run due to an infrastructure failure. */
  infraError: z.string().optional(),
})

export type DeferredJudgeResult = z.infer<typeof DeferredJudgeResultSchema>

// ---------------------------------------------------------------------------
// Collect deferred input
// ---------------------------------------------------------------------------

export async function collectDeferredInput(
  criterion: Extract<EvalCriterion, { method: "llm-judge" }>,
  runResult: RunResult,
  context: { sessionId: string; taskId: string; condition: string },
  criterionIndex: number,
): Promise<DeferredJudgeInput> {
  const trace = formatAgentTrace(runResult.steps, { maxInputLen: 500, maxOutputLen: 1000 })
  const workDirFiles = runResult.workDir ? await collectWorkDirFiles(runResult.workDir) : ""

  return {
    id: `${context.sessionId}-${context.taskId}-${context.condition}-crit${criterionIndex}`,
    createdAt: new Date().toISOString(),
    context: { ...context, criterionIndex, criterionId: criterion.id },
    criterion: {
      method: "llm-judge",
      rubric: typeof criterion.rubric === "string"
        ? criterion.rubric
        : Object.entries(criterion.rubric)
            .sort(([a], [b]) => parseFloat(b) - parseFloat(a))
            .map(([score, desc]) => `Score ${score}: ${desc}`)
            .join("\n"),
      maxScore: criterion.maxScore,
    },
    inputs: { trace, finalOutput: runResult.text, workDirFiles },
  }
}

// ---------------------------------------------------------------------------
// Manifest I/O (JSONL)
// ---------------------------------------------------------------------------

export async function appendDeferredManifest(dir: string, entry: DeferredJudgeInput): Promise<void> {
  const filePath = path.join(dir, "manifest.jsonl")
  await mkdir(dir, { recursive: true })
  await appendFile(filePath, JSON.stringify(entry) + "\n")
}

export async function readDeferredManifest(dir: string): Promise<DeferredJudgeInput[]> {
  const filePath = path.join(dir, "manifest.jsonl")
  const content = await readFileOrEmpty(filePath)
  if (!content) return []
  return content.trim().split("\n").map(line => DeferredJudgeInputSchema.parse(JSON.parse(line)))
}

export async function writeDeferredResults(dir: string, results: DeferredJudgeResult[]): Promise<void> {
  const filePath = path.join(dir, "results.jsonl")
  await mkdir(dir, { recursive: true })
  const content = results.map(r => JSON.stringify(r)).join("\n") + "\n"
  await Bun.write(filePath, content)
}

export async function readDeferredResults(dir: string): Promise<DeferredJudgeResult[]> {
  const filePath = path.join(dir, "results.jsonl")
  const content = await readFileOrEmpty(filePath)
  if (!content) return []
  return content.trim().split("\n").map(line => DeferredJudgeResultSchema.parse(JSON.parse(line)))
}

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await Bun.file(filePath).text()
  } catch {
    return ""
  }
}

// ---------------------------------------------------------------------------
// Deferred judge runner
// ---------------------------------------------------------------------------

export async function runDeferredJudge(opts: {
  manifestDir: string
  llmProvider: LLMProvider
  concurrency?: number
}): Promise<DeferredJudgeResult[]> {
  const entries = await readDeferredManifest(opts.manifestDir)
  if (entries.length === 0) {
    log.info("No deferred judge entries found")
    return []
  }

  log.info(`Running deferred LLM judge: ${entries.length} entries (concurrency=${opts.concurrency ?? 4})`)

  const concurrency = opts.concurrency ?? 4
  const pool = createSlotPool(concurrency)
  const results: DeferredJudgeResult[] = []

  await Promise.allSettled(entries.map(async (entry) => {
    const slot = await pool.acquire()
    try {
      const result = await judgeOneEntry(entry, opts.llmProvider)
      results.push(result)
      log.info(`Judged ${entry.context.taskId}/${entry.context.condition} crit${entry.context.criterionIndex}: score=${result.score.toFixed(2)}`)
    } catch (err) {
      const infra = isProviderError(err) || isHeadlessAgentError(err)
      log.error(`Judge failed for ${entry.id}${infra ? " (infra)" : ""}: ${err}`)
      results.push({
        id: entry.id,
        context: entry.context,
        pass: false,
        score: 0,
        details: `Deferred judge${infra ? " infrastructure" : ""} error: ${err instanceof Error ? err.message : String(err)}`,
        criterion: entry.criterion,
        evaluatedAt: new Date().toISOString(),
        ...(infra ? { infraError: err instanceof Error ? err.message : String(err) } : {}),
      })
    } finally {
      pool.release(slot)
    }
  }))

  // Write results
  await writeDeferredResults(opts.manifestDir, results)
  log.info(`Deferred judge complete: ${results.length} results written`)

  return results
}

async function judgeOneEntry(entry: DeferredJudgeInput, llmProvider: LLMProvider): Promise<DeferredJudgeResult> {
  const { criterion, inputs } = entry

  const { normalizedScore, reasoning } = await callJudge({
    llmProvider,
    rubric: criterion.rubric,
    maxScore: criterion.maxScore,
    trace: inputs.trace,
    finalOutput: inputs.finalOutput,
    workDirFiles: inputs.workDirFiles,
  })

  return {
    id: entry.id,
    context: entry.context,
    pass: normalizedScore >= 0.5,
    score: normalizedScore,
    details: reasoning,
    criterion: entry.criterion,
    evaluatedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Merge deferred results into ConditionResult map
// ---------------------------------------------------------------------------

/**
 * Minimal write target the merge needs. `ConditionResult` satisfies this
 * interface — the merge treats `evalDetails` as the single source of truth.
 */
export interface MergeableConditionResult {
  condition: string
  score: number
  pass: boolean
  evalDetails: EvalDetail[]
  automatedScore?: number
  llmJudgeScore?: number
  gradingWeights?: { automated: number; llmJudge: number }
  /**
   * Optional adapter run status. When present and not 'ok', the merge skips
   * this row to preserve the runner-gate invariant (tainted ⇒ score=0/pass=false).
   * `ConditionResult` from `src/bench/types.ts` satisfies this interface.
   */
  runStatus?: string
}

/**
 * Merge deferred-judge results back into the in-memory ConditionResult map.
 *
 * Strategy:
 *   1. Locate the target evalDetails entry by `criterionId` (preferred) or
 *      by `criterionIndex` as fallback for criteria without an explicit id.
 *   2. Patch the entry's score + details in place.
 *   3. Recompute the condition's overall score via `computeWeightedScore` —
 *      the same helper the sync path uses, so both paths produce identical
 *      results on identical evalDetails.
 */
export function mergeDeferredResults(
  results: DeferredJudgeResult[],
  taskResultsMap: Map<string, MergeableConditionResult[]>,
): void {
  for (const result of results) {
    const conditionResults = taskResultsMap.get(result.context.taskId)
    if (!conditionResults) continue
    const cr = conditionResults.find(c => c.condition === result.context.condition)
    if (!cr) continue

    // Defensive: tainted rows must remain at score=0 / pass=false. Today
    // the runner gate already guarantees `evalDetails: []` for tainted
    // ConditionResults, so the slot lookup below would no-op anyway. But
    // any future change that populates evalDetails on a tainted row would
    // silently un-zero it via computeWeightedScore. Keep the invariant
    // explicit at every consumer.
    if (cr.runStatus !== undefined && cr.runStatus !== "ok") {
      continue
    }

    const { criterionId, criterionIndex } = result.context
    const idx = criterionId
      ? cr.evalDetails.findIndex(d => d.id === criterionId)
      : criterionIndex
    if (idx == null || idx < 0 || idx >= cr.evalDetails.length) {
      log.warn(`mergeDeferredResults: no evalDetails slot for ${result.context.taskId}/${result.context.condition} crit=${criterionId ?? criterionIndex}`)
      continue
    }

    const target = cr.evalDetails[idx]!
    target.score = result.score
    target.details = result.details

    const { overallScore, automatedScore, llmJudgeScore } = computeWeightedScore(
      cr.evalDetails,
      cr.gradingWeights,
    )
    cr.score = overallScore
    cr.pass = overallScore >= 0.5
    cr.automatedScore = automatedScore
    cr.llmJudgeScore = llmJudgeScore
  }
}
