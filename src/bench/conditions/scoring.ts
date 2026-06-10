import type { EvalDetail } from "../types.ts"

/** Minimal shape consumed by computeWeightedScore — both EvalDetail and mapped EvalResult satisfy it. */
export interface WeightedEntry {
  method: string
  score: number
  weight?: number
}

/** Classify an eval criterion as automated (script/file-check/custom) or llm-judge */
function isAutomated(e: WeightedEntry): boolean {
  return e.method === "script" || e.method === "file-check" || e.method === "custom"
}

/**
 * Compute weighted score from per-criterion entries.
 *
 * Scoring strategy (in priority order):
 * 1. Per-criterion weights: if any entry has an explicit `weight` field,
 *    use per-criterion weighted average.
 * 2. Legacy gradingWeights: if the task has `gradingWeights`, split entries
 *    into automated vs llm-judge groups and combine with group weights.
 * 3. Flat average: all entries weighted equally.
 *
 * This function is the single source of truth for condition scoring — both
 * the sync evaluation path and the async-judge merge call it on the same
 * `EvalDetail[]`, guaranteeing identical results regardless of path.
 */
export function computeWeightedScore(
  entries: WeightedEntry[],
  gradingWeights?: { automated: number; llmJudge: number },
): { overallScore: number; automatedScore?: number; llmJudgeScore?: number } {
  if (entries.length === 0) return { overallScore: 0 }

  const automated = entries.filter(isAutomated)
  const llmJudge = entries.filter(e => !isAutomated(e))
  const autoAvg = automated.length > 0
    ? automated.reduce((sum, e) => sum + e.score, 0) / automated.length
    : undefined
  const judgeAvg = llmJudge.length > 0
    ? llmJudge.reduce((sum, e) => sum + e.score, 0) / llmJudge.length
    : undefined

  // Strategy 1: per-criterion weights
  const hasPerCriterionWeights = entries.some(e => e.weight != null)
  if (hasPerCriterionWeights) {
    const defaultWeight = 1.0 / entries.length
    let totalWeight = 0
    let weightedSum = 0
    for (const e of entries) {
      const w = e.weight ?? defaultWeight
      totalWeight += w
      weightedSum += e.score * w
    }
    const overallScore = totalWeight > 0 ? weightedSum / totalWeight : 0
    return { overallScore, automatedScore: autoAvg, llmJudgeScore: judgeAvg }
  }

  // Strategy 2: legacy gradingWeights
  if (gradingWeights) {
    let overallScore: number
    if (autoAvg !== undefined && judgeAvg !== undefined) {
      const totalWeight = gradingWeights.automated + gradingWeights.llmJudge
      overallScore = (autoAvg * gradingWeights.automated + judgeAvg * gradingWeights.llmJudge) / totalWeight
    } else if (autoAvg !== undefined) {
      overallScore = autoAvg
    } else if (judgeAvg !== undefined) {
      overallScore = judgeAvg
    } else {
      overallScore = 0
    }
    return { overallScore, automatedScore: autoAvg, llmJudgeScore: judgeAvg }
  }

  // Strategy 3: flat average
  const overallScore = entries.reduce((sum, e) => sum + e.score, 0) / entries.length
  return { overallScore }
}

/** Build per-criterion detail entries with optional checkpoint breakdown */
export function buildEvalDetails(
  evalResults: { pass: boolean; score: number; details: string; criterion?: { method: string; id?: string; name?: string; weight?: number }; checkpoints?: { name: string; score: number; reason?: string }[] }[],
): EvalDetail[] {
  return evalResults.map((r) => ({
    id: r.criterion?.id,
    name: r.criterion?.name,
    method: r.criterion?.method ?? "unknown",
    score: r.score,
    weight: r.criterion?.weight,
    details: r.details,
    ...(r.checkpoints?.length ? { checkpoints: r.checkpoints } : {}),
  }))
}
