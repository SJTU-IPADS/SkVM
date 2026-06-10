import type {
  BenchReport, BenchRunConfig, TaskReport, BenchSummary,
  BenchCondition, ConditionResult, ConditionSummary, BENCH_CONDITIONS,
  MultiModelReport, MultiAdapterReport,
} from "./types.ts"
import type { RunStatus } from "../core/types.ts"
import { hasUsageTelemetry } from "../core/run-record.ts"

/**
 * A row is "evaluable" — i.e. its score / pass boolean should be counted in
 * aggregates — iff the adapter returned a 'ok' runStatus. Rows missing the
 * field (older reports from before the bench-adapter-error-false-positive fix)
 * are also treated as evaluable for backwards compat: historical data is what
 * it is, and silently dropping it would change all past aggregates.
 */
function isEvaluable(r: ConditionResult): boolean {
  return r.runStatus === undefined || r.runStatus === "ok"
}

/** Render a nullable ranking score as "N/A" when no rows were evaluable. */
function formatRankScore(s: number | null): string {
  return s === null ? "  N/A" : s.toFixed(2)
}
function formatRankPass(p: number | null): string {
  return p === null ? "N/A" : `${(p * 100).toFixed(0)}%`
}

// ---------------------------------------------------------------------------
// Report Generation
// ---------------------------------------------------------------------------

export function generateReport(
  sessionId: string,
  config: BenchRunConfig,
  taskReports: TaskReport[],
): BenchReport {
  return {
    sessionId,
    model: config.model,
    adapter: config.adapter,
    timestamp: new Date().toISOString(),
    runsPerTask: (config.runsPerTask ?? 1) > 1 ? config.runsPerTask : undefined,
    tasks: taskReports,
    summary: computeSummary(taskReports, config.conditions),
  }
}

function computeSummary(tasks: TaskReport[], conditions: BenchCondition[]): BenchSummary {
  const perCondition: Partial<Record<BenchCondition, ConditionSummary>> = {}
  const perCategory: Record<string, Partial<Record<BenchCondition, number>>> = {}

  for (const condition of conditions) {
    const results = tasks
      .flatMap(t => t.conditions)
      .filter(c => c.condition === condition)

    if (results.length === 0) continue

    // Score / passRate exclude tainted rows (runStatus !== 'ok'). Cost and
    // tokens average over all rows WITH usage telemetry — resources are real
    // regardless of evaluability, but a harness that reported nothing
    // (usageAvailable: false) contributes no number, not a fake zero.
    const evaluable = results.filter(isEvaluable)
    const withUsage = results.filter(hasUsageTelemetry)
    const byStatus: Partial<Record<RunStatus, number>> = {}
    for (const r of results) {
      const key: RunStatus = r.runStatus ?? "ok"
      byStatus[key] = (byStatus[key] ?? 0) + 1
    }

    // A condition with zero evaluable rows has no meaningful avgScore /
    // passRate, and one with zero telemetry-bearing rows has no meaningful
    // avgTokens / avgCost — emit null so downstream readers (deltas,
    // multi-model ranking, report.md) can distinguish "no data" from
    // "measured 0". Durations always average over all rows — wall-clock is
    // real regardless of telemetry.
    perCondition[condition] = {
      avgScore: evaluable.length > 0 ? avg(evaluable.map(r => r.score)) : null,
      passRate: evaluable.length > 0
        ? evaluable.filter(r => r.pass).length / evaluable.length
        : null,
      avgTokens: withUsage.length > 0 ? avg(withUsage.map(r => r.tokens.input + r.tokens.output)) : null,
      avgCost: withUsage.length > 0 ? avg(withUsage.map(r => r.cost)) : null,
      avgDurationMs: avg(results.map(r => r.durationMs)),
      avgLlmDurationMs: avg(results.map(r => r.llmDurationMs)),
      evaluableCount: evaluable.length,
      taintedCount: results.length - evaluable.length,
      byStatus,
    }
  }

  // Per-category breakdown (also excludes tainted rows from the score).
  // Omit the condition entirely when there's nothing to score.
  const categories = [...new Set(tasks.map(t => t.category))]
  for (const cat of categories) {
    perCategory[cat] = {}
    const catTasks = tasks.filter(t => t.category === cat)

    for (const condition of conditions) {
      const results = catTasks
        .flatMap(t => t.conditions)
        .filter(c => c.condition === condition)
      const evaluable = results.filter(isEvaluable)
      if (evaluable.length > 0) {
        perCategory[cat]![condition] = avg(evaluable.map(r => r.score))
      }
    }
  }

  // Deltas
  const noSkillAvg = perCondition["no-skill"]?.avgScore ?? null
  const originalAvg = perCondition.original?.avgScore ?? null
  const aotAvg = perCondition.aot?.avgScore ?? null
  const jitAvg = perCondition.jit?.avgScore ?? null

  return {
    taskCount: tasks.length,
    perCondition,
    perCategory,
    delta: {
      originalVsBaseline: noSkillAvg !== null && originalAvg !== null
        ? originalAvg - noSkillAvg : null,
      aotVsOriginal: originalAvg !== null && aotAvg !== null
        ? aotAvg - originalAvg : null,
      jitVsAot: aotAvg !== null && jitAvg !== null
        ? jitAvg - aotAvg : null,
    },
  }
}

function avg(nums: number[]): number {
  return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0
}

// ---------------------------------------------------------------------------
// Console Output
// ---------------------------------------------------------------------------

export function printSummary(report: BenchReport): void {
  const { summary, tasks } = report

  const runsNote = report.runsPerTask && report.runsPerTask > 1 ? `, ${report.runsPerTask} runs/task` : ""
  console.log(`=== SkVM Benchmark: ${report.model} (${report.adapter}${runsNote}) ===\n`)

  // Per-task table
  const conditions = Object.keys(summary.perCondition) as BenchCondition[]
  const condHeaders = conditions.map(c => c === "jit" ? "JIT (warm)" : c).map(h => h.padStart(10))

  console.log(`${"Task".padEnd(28)} | ${condHeaders.join(" | ")}`)
  console.log("-".repeat(28 + conditions.length * 13))

  for (const task of tasks) {
    const scores = conditions.map(cond => {
      const result = task.conditions.find(c => c.condition === cond)
      if (!result) return "     -    "
      // Tainted rows must not be rendered as plain numeric scores: their
      // `score` field is forced to 0 by the runner gate / aggregator, and
      // showing it as 0.00 makes infra failures indistinguishable from
      // evaluator failures. Use the same ⚠ marker as generateMarkdown so
      // console + report.md agree. See round-4 Codex review.
      if (!isEvaluable(result)) {
        return `⚠ ${result.runStatus ?? "?"}`.padStart(10).slice(0, 10)
      }
      return result.score.toFixed(2).padStart(10)
    })
    console.log(`${task.taskId.padEnd(28)} | ${scores.join(" | ")}`)
  }

  console.log("-".repeat(28 + conditions.length * 13))

  // Summary row — annotate with tainted count when non-zero so nobody reads
  // the average without knowing how many rows were dropped from it.
  // avgScore === null means every row for the condition was tainted — show
  // ⚠ only, not a fake 0.00.
  const avgScores = conditions.map(cond => {
    const s = summary.perCondition[cond]
    if (!s) return "     -    "
    const tainted = s.taintedCount ?? 0
    if (s.avgScore === null) return `⚠${tainted} tainted`.padStart(10)
    const str = tainted > 0
      ? `${s.avgScore.toFixed(2)} ⚠${tainted}`
      : s.avgScore.toFixed(2)
    return str.padStart(10)
  })
  console.log(`${"Avg Score".padEnd(28)} | ${avgScores.join(" | ")}`)

  const passRates = conditions.map(cond => {
    const s = summary.perCondition[cond]
    if (!s || s.passRate === null) return "     -    "
    return `${(s.passRate * 100).toFixed(0)}%`.padStart(10)
  })
  console.log(`${"Pass Rate".padEnd(28)} | ${passRates.join(" | ")}`)

  const avgTokens = conditions.map(cond => {
    const s = summary.perCondition[cond]
    return s ? fmtOrNa(s.avgTokens, formatTokens).padStart(10) : "     -    "
  })
  console.log(`${"Avg Tokens".padEnd(28)} | ${avgTokens.join(" | ")}`)

  const avgDuration = conditions.map(cond => {
    const s = summary.perCondition[cond]
    return s ? formatDuration(s.avgDurationMs).padStart(10) : "     -    "
  })
  console.log(`${"Avg Duration".padEnd(28)} | ${avgDuration.join(" | ")}`)

  const avgLlmTime = conditions.map(cond => {
    const s = summary.perCondition[cond]
    return s ? formatDuration(s.avgLlmDurationMs).padStart(10) : "     -    "
  })
  console.log(`${"Avg LLM Time".padEnd(28)} | ${avgLlmTime.join(" | ")}`)

  const avgCost = conditions.map(cond => {
    const s = summary.perCondition[cond]
    return s ? fmtOrNa(s.avgCost, formatCost).padStart(10) : "     -    "
  })
  console.log(`${"Avg Cost".padEnd(28)} | ${avgCost.join(" | ")}`)

  // Deltas
  console.log("")
  if (summary.delta.originalVsBaseline !== null) {
    const d = summary.delta.originalVsBaseline
    const sign = d >= 0 ? "+" : ""
    console.log(`  Original vs No-Skill: ${sign}${(d * 100).toFixed(1)}%`)
  }
  if (summary.delta.aotVsOriginal !== null) {
    const d = summary.delta.aotVsOriginal
    const sign = d >= 0 ? "+" : ""
    console.log(`  AOT vs Original:      ${sign}${(d * 100).toFixed(1)}%`)
  }
  if (summary.delta.jitVsAot !== null) {
    const d = summary.delta.jitVsAot
    const sign = d >= 0 ? "+" : ""
    console.log(`  JIT vs AOT:           ${sign}${(d * 100).toFixed(1)}%`)
  }

  // Show deduction reasons for failed/low-score tasks (all eval methods)
  const lowScoreTasks = tasks.filter(t =>
    t.conditions.some(c => c.score < 0.8 && c.evalDetails?.some(d => d.score < 1.0))
  )
  if (lowScoreTasks.length > 0) {
    console.log("\n--- Eval Deductions ---\n")
    for (const task of lowScoreTasks) {
      for (const cond of task.conditions) {
        if (cond.score >= 0.8) continue
        const deductions = cond.evalDetails?.filter(d => d.score < 1.0) ?? []
        if (deductions.length === 0) continue

        const components: string[] = []
        if (cond.automatedScore !== undefined) components.push(`auto=${cond.automatedScore.toFixed(2)}`)
        if (cond.llmJudgeScore !== undefined) components.push(`judge=${cond.llmJudgeScore.toFixed(2)}`)
        const compStr = components.length > 0 ? ` [${components.join(", ")}]` : ""

        console.log(`  ${task.taskId} (${cond.condition}=${cond.score.toFixed(2)}${compStr}):`)
        for (const d of deductions) {
          const label = d.name ?? d.id ?? d.method
          console.log(`    ${d.method}/${label}=${d.score.toFixed(2)}: ${d.details.slice(0, 200)}`)
          if (d.checkpoints && d.checkpoints.length > 1) {
            for (const cp of d.checkpoints.filter(c => c.score < 1.0)) {
              console.log(`      - ${cp.name}: ${cp.score.toFixed(2)}${cp.reason ? ` (${cp.reason})` : ""}`)
            }
          }
        }
      }
    }
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.round(n))
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`
  return `${(ms / 1_000).toFixed(1)}s`
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0"
  if (usd < 0.001) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(3)}`
}

/** Null-sentinel aware formatting: null means "no usage telemetry" → "n/a". */
function fmtOrNa(value: number | null, fmt: (n: number) => string): string {
  return value !== null ? fmt(value) : "n/a"
}

// ---------------------------------------------------------------------------
// Markdown Report
// ---------------------------------------------------------------------------

export function generateMarkdown(report: BenchReport): string {
  const lines: string[] = []
  const { summary, tasks } = report
  const conditions = Object.keys(summary.perCondition) as BenchCondition[]

  lines.push(`# SkVM Benchmark Benchmark Report`)
  lines.push("")
  lines.push(`- **Model**: ${report.model}`)
  lines.push(`- **Adapter**: ${report.adapter}`)
  lines.push(`- **Session**: ${report.sessionId}`)
  lines.push(`- **Timestamp**: ${report.timestamp}`)
  lines.push(`- **Tasks**: ${summary.taskCount}`)
  lines.push("")

  // Summary table
  lines.push("## Summary")
  lines.push("")
  lines.push(`| Metric | ${conditions.join(" | ")} |`)
  lines.push(`|--------|${conditions.map(() => "-------").join("|")}|`)

  const avgRow = conditions.map(c => {
    const s = summary.perCondition[c]
    if (!s) return "-"
    // Annotate tainted count inline so nobody reads the avg without knowing
    // how many rows were dropped from the denominator. When every row is
    // tainted, avgScore is null — show ⚠ only, never a fake 0.00.
    const tainted = s.taintedCount ?? 0
    if (s.avgScore === null) return `⚠ ${tainted} tainted, none evaluable`
    return tainted > 0
      ? `${s.avgScore.toFixed(2)} (⚠${tainted})`
      : s.avgScore.toFixed(2)
  })
  lines.push(`| Avg Score | ${avgRow.join(" | ")} |`)

  const passRow = conditions.map(c => {
    const s = summary.perCondition[c]
    if (!s || s.passRate === null) return "-"
    return `${(s.passRate * 100).toFixed(0)}%`
  })
  lines.push(`| Pass Rate | ${passRow.join(" | ")} |`)

  const tokenRow = conditions.map(c => {
    const s = summary.perCondition[c]
    return s ? fmtOrNa(s.avgTokens, formatTokens) : "-"
  })
  lines.push(`| Avg Tokens | ${tokenRow.join(" | ")} |`)

  const durationRow = conditions.map(c => {
    const s = summary.perCondition[c]
    return s ? formatDuration(s.avgDurationMs) : "-"
  })
  lines.push(`| Avg Duration | ${durationRow.join(" | ")} |`)

  const llmTimeRow = conditions.map(c => {
    const s = summary.perCondition[c]
    return s ? formatDuration(s.avgLlmDurationMs) : "-"
  })
  lines.push(`| Avg LLM Time | ${llmTimeRow.join(" | ")} |`)

  const costRow = conditions.map(c => {
    const s = summary.perCondition[c]
    return s ? fmtOrNa(s.avgCost, formatCost) : "-"
  })
  lines.push(`| Avg Cost | ${costRow.join(" | ")} |`)
  lines.push("")

  // Per-task table
  lines.push("## Per-Task Results")
  lines.push("")
  lines.push(`| Task | Category | ${conditions.join(" | ")} |`)
  lines.push(`|------|----------|${conditions.map(() => "-------").join("|")}|`)

  for (const task of tasks) {
    const scores = conditions.map(c => {
      const r = task.conditions.find(cr => cr.condition === c)
      if (!r) return "-"
      // Mark tainted rows with ⚠ so readers don't conflate an evaluator 0
      // with a run that never got scored at all.
      return isEvaluable(r)
        ? r.score.toFixed(2)
        : `⚠ ${r.runStatus ?? "?"}`
    })
    lines.push(`| ${task.taskId} | ${task.category} | ${scores.join(" | ")} |`)
  }
  lines.push("")

  // Tainted runs section — lets readers see which rows were dropped and why.
  const taintedRows: Array<{ taskId: string; cond: ConditionResult }> = []
  for (const task of tasks) {
    for (const cond of task.conditions) {
      if (!isEvaluable(cond)) taintedRows.push({ taskId: task.taskId, cond })
    }
  }
  if (taintedRows.length > 0) {
    lines.push("## Tainted runs")
    lines.push("")
    lines.push(`${taintedRows.length} row(s) excluded from Avg Score / Pass Rate aggregates.`)
    lines.push("")
    lines.push("| Task | Condition | runStatus | Detail |")
    lines.push("|------|-----------|-----------|--------|")
    for (const { taskId, cond } of taintedRows) {
      // stderr snippets and Python tracebacks routinely contain newlines and
      // tabs. A bare \n splits the row across multiple Markdown lines and
      // nukes the rest of the table — collapse all whitespace runs to a
      // single space, escape pipes, then truncate.
      const detail = (cond.statusDetail ?? cond.error ?? "")
        .replace(/\s+/g, " ")
        .replace(/\|/g, "\\|")
        .trim()
        .slice(0, 160)
      lines.push(`| ${taskId} | ${cond.condition} | ${cond.runStatus ?? "?"} | ${detail} |`)
    }
    lines.push("")
  }

  // Deltas
  lines.push("## Optimization Impact")
  lines.push("")
  if (summary.delta.originalVsBaseline !== null) {
    lines.push(`- **Original vs No-Skill**: ${summary.delta.originalVsBaseline >= 0 ? "+" : ""}${(summary.delta.originalVsBaseline * 100).toFixed(1)}%`)
  }
  if (summary.delta.aotVsOriginal !== null) {
    lines.push(`- **AOT vs Original**: ${summary.delta.aotVsOriginal >= 0 ? "+" : ""}${(summary.delta.aotVsOriginal * 100).toFixed(1)}%`)
  }
  if (summary.delta.jitVsAot !== null) {
    lines.push(`- **JIT vs AOT**: ${summary.delta.jitVsAot >= 0 ? "+" : ""}${(summary.delta.jitVsAot * 100).toFixed(1)}%`)
  }
  lines.push("")

  // Task Details — show per-criterion scores and deduction reasons for all methods
  const tasksWithDeductions = tasks.filter(t =>
    t.conditions.some(c =>
      c.evalDetails?.some(d => d.score < 1.0)
    )
  )
  if (tasksWithDeductions.length > 0) {
    lines.push("## Task Eval Details")
    lines.push("")
    for (const task of tasksWithDeductions) {
      lines.push(`### ${task.taskId}`)
      lines.push("")
      for (const cond of task.conditions) {
        if (!cond.evalDetails?.length) continue

        const scoreComponents: string[] = []
        if (cond.automatedScore !== undefined) scoreComponents.push(`auto=${cond.automatedScore.toFixed(2)}`)
        if (cond.llmJudgeScore !== undefined) scoreComponents.push(`judge=${cond.llmJudgeScore.toFixed(2)}`)
        const componentStr = scoreComponents.length > 0 ? ` (${scoreComponents.join(", ")})` : ""
        lines.push(`**${cond.condition}**: ${cond.score.toFixed(2)}${componentStr}`)
        lines.push("")

        for (const detail of cond.evalDetails) {
          const icon = detail.score >= 1.0 ? "+" : detail.score >= 0.5 ? "~" : "-"
          const label = detail.name ?? detail.id ?? detail.method
          const weightStr = detail.weight != null ? ` (w=${detail.weight.toFixed(2)})` : ""
          lines.push(`- [${icon}] \`${detail.method}\` ${label} ${detail.score.toFixed(2)}${weightStr}${detail.score < 1.0 && detail.details ? ` — ${detail.details}` : ""}`)

          // Show checkpoint breakdown for multi-checkpoint criteria
          if (detail.checkpoints && detail.checkpoints.length > 1) {
            for (const cp of detail.checkpoints) {
              const cpIcon = cp.score >= 1.0 ? "+" : cp.score >= 0.5 ? "~" : "-"
              const cpWeight = cp.weight != null ? ` w=${cp.weight.toFixed(2)}` : ""
              const cpDesc = cp.description ? ` (${cp.description})` : ""
              lines.push(`  - [${cpIcon}] ${cp.name}${cpWeight}: ${cp.score.toFixed(2)}${cp.reason ? ` — ${cp.reason}` : ""}${cpDesc}`)
            }
          }
        }
        lines.push("")
      }
    }
  }

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Multi-Model Console Output
// ---------------------------------------------------------------------------

export function printMultiModelSummary(report: MultiModelReport): void {
  const { comparison } = report

  console.log(`\n${"=".repeat(80)}`)
  console.log(`  MULTI-MODEL BENCHMARK: ${report.models.length} models`)
  console.log(`${"=".repeat(80)}\n`)

  // Ranking table
  console.log("## Model Ranking (by avg score across all conditions)\n")
  console.log(`${"#".padStart(3)} | ${"Model".padEnd(40)} | ${"Avg Score".padStart(10)} | ${"Pass Rate".padStart(10)}`)
  console.log("-".repeat(72))

  for (let i = 0; i < comparison.ranking.length; i++) {
    const r = comparison.ranking[i]!
    console.log(
      `${String(i + 1).padStart(3)} | ${r.model.padEnd(40)} | ${formatRankScore(r.avgScore).padStart(10)} | ${formatRankPass(r.passRate).padStart(10)}`,
    )
  }

  // Score matrix
  const conditions = getConditionsFromReports(report.reports)
  if (conditions.length > 0) {
    console.log(`\n## Score Matrix (model x condition)\n`)
    const condHeaders = conditions.map(c => c.padStart(10))
    console.log(`${"Model".padEnd(40)} | ${condHeaders.join(" | ")}`)
    console.log("-".repeat(40 + conditions.length * 13))

    for (const model of report.models) {
      const scores = conditions.map(c => {
        const s = comparison.scoreMatrix[model]?.[c as BenchCondition]
        return s !== undefined ? s.toFixed(2).padStart(10) : "     -    "
      })
      // Truncate long model names
      const displayModel = model.length > 38 ? model.slice(0, 35) + "..." : model
      console.log(`${displayModel.padEnd(40)} | ${scores.join(" | ")}`)
    }
  }

  console.log("")
}

function getConditionsFromReports(reports: BenchReport[]): string[] {
  const set = new Set<string>()
  for (const r of reports) {
    for (const cond of Object.keys(r.summary.perCondition)) {
      set.add(cond)
    }
  }
  return [...set]
}

// ---------------------------------------------------------------------------
// Multi-Model Markdown Report
// ---------------------------------------------------------------------------

export function generateMultiModelMarkdown(report: MultiModelReport): string {
  const lines: string[] = []
  const { comparison } = report

  lines.push("# Multi-Model SkVM Benchmark Benchmark")
  lines.push("")
  lines.push(`- **Session**: ${report.sessionId}`)
  lines.push(`- **Models**: ${report.models.length}`)
  lines.push(`- **Started**: ${report.timestamp}`)
  lines.push(`- **Completed**: ${report.completedAt}`)
  lines.push("")

  // Ranking
  lines.push("## Model Ranking")
  lines.push("")
  lines.push("| # | Model | Avg Score | Pass Rate |")
  lines.push("|---|-------|-----------|-----------|")
  for (let i = 0; i < comparison.ranking.length; i++) {
    const r = comparison.ranking[i]!
    lines.push(`| ${i + 1} | ${r.model} | ${formatRankScore(r.avgScore)} | ${formatRankPass(r.passRate)} |`)
  }
  lines.push("")

  // Score matrix
  const conditions = getConditionsFromReports(report.reports)
  if (conditions.length > 0) {
    lines.push("## Score Matrix")
    lines.push("")
    lines.push(`| Model | ${conditions.join(" | ")} |`)
    lines.push(`|-------|${conditions.map(() => "-------").join("|")}|`)
    for (const model of report.models) {
      const scores = conditions.map(c => {
        const s = comparison.scoreMatrix[model]?.[c as BenchCondition]
        return s !== undefined ? s.toFixed(2) : "-"
      })
      lines.push(`| ${model} | ${scores.join(" | ")} |`)
    }
    lines.push("")
  }

  // Per-task matrix (best score per model)
  const tasks = Object.keys(comparison.taskMatrix)
  if (tasks.length > 0) {
    lines.push("## Per-Task Best Scores")
    lines.push("")
    const shortModels = report.models.map(m => m.split("/").pop() ?? m)
    lines.push(`| Task | ${shortModels.join(" | ")} |`)
    lines.push(`|------|${shortModels.map(() => "-------").join("|")}|`)
    for (const task of tasks) {
      const scores = report.models.map(m => {
        const s = comparison.taskMatrix[task]?.[m]
        return s !== undefined ? s.toFixed(2) : "-"
      })
      lines.push(`| ${task} | ${scores.join(" | ")} |`)
    }
    lines.push("")
  }

  // Per-model details
  for (const r of report.reports) {
    lines.push(`---`)
    lines.push("")
    lines.push(generateMarkdown(r))
  }

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Multi-Adapter Console Output
// ---------------------------------------------------------------------------

export function printMultiAdapterSummary(report: MultiAdapterReport): void {
  const { comparison } = report

  console.log(`\n${"=".repeat(80)}`)
  console.log(`  MULTI-ADAPTER BENCHMARK: ${report.adapters.length} adapters (${report.model})`)
  console.log(`${"=".repeat(80)}\n`)

  // Ranking table
  console.log("## Adapter Ranking (by avg score across all conditions)\n")
  console.log(`${"#".padStart(3)} | ${"Adapter".padEnd(20)} | ${"Avg Score".padStart(10)} | ${"Pass Rate".padStart(10)}`)
  console.log("-".repeat(52))

  for (let i = 0; i < comparison.ranking.length; i++) {
    const r = comparison.ranking[i]!
    console.log(
      `${String(i + 1).padStart(3)} | ${r.adapter.padEnd(20)} | ${formatRankScore(r.avgScore).padStart(10)} | ${formatRankPass(r.passRate).padStart(10)}`,
    )
  }

  // Score matrix
  const conditions = getConditionsFromReports(report.reports)
  if (conditions.length > 0) {
    console.log(`\n## Score Matrix (adapter x condition)\n`)
    const condHeaders = conditions.map(c => c.padStart(10))
    console.log(`${"Adapter".padEnd(20)} | ${condHeaders.join(" | ")}`)
    console.log("-".repeat(20 + conditions.length * 13))

    for (const adapter of report.adapters) {
      const scores = conditions.map(c => {
        const s = comparison.scoreMatrix[adapter]?.[c as BenchCondition]
        return s !== undefined ? s.toFixed(2).padStart(10) : "     -    "
      })
      console.log(`${adapter.padEnd(20)} | ${scores.join(" | ")}`)
    }
  }

  console.log("")
}

// ---------------------------------------------------------------------------
// Multi-Adapter Markdown Report
// ---------------------------------------------------------------------------

export function generateMultiAdapterMarkdown(report: MultiAdapterReport): string {
  const lines: string[] = []
  const { comparison } = report

  lines.push("# Multi-Adapter SkVM Benchmark")
  lines.push("")
  lines.push(`- **Session**: ${report.sessionId}`)
  lines.push(`- **Model**: ${report.model}`)
  lines.push(`- **Adapters**: ${report.adapters.join(", ")}`)
  lines.push(`- **Started**: ${report.timestamp}`)
  lines.push(`- **Completed**: ${report.completedAt}`)
  lines.push("")

  // Ranking
  lines.push("## Adapter Ranking")
  lines.push("")
  lines.push("| # | Adapter | Avg Score | Pass Rate |")
  lines.push("|---|---------|-----------|-----------|")
  for (let i = 0; i < comparison.ranking.length; i++) {
    const r = comparison.ranking[i]!
    lines.push(`| ${i + 1} | ${r.adapter} | ${formatRankScore(r.avgScore)} | ${formatRankPass(r.passRate)} |`)
  }
  lines.push("")

  // Score matrix
  const conditions = getConditionsFromReports(report.reports)
  if (conditions.length > 0) {
    lines.push("## Score Matrix")
    lines.push("")
    lines.push(`| Adapter | ${conditions.join(" | ")} |`)
    lines.push(`|---------|${conditions.map(() => "-------").join("|")}|`)
    for (const adapter of report.adapters) {
      const scores = conditions.map(c => {
        const s = comparison.scoreMatrix[adapter]?.[c as BenchCondition]
        return s !== undefined ? s.toFixed(2) : "-"
      })
      lines.push(`| ${adapter} | ${scores.join(" | ")} |`)
    }
    lines.push("")
  }

  // Per-task matrix
  const tasks = Object.keys(comparison.taskMatrix)
  if (tasks.length > 0) {
    lines.push("## Per-Task Best Scores")
    lines.push("")
    lines.push(`| Task | ${report.adapters.join(" | ")} |`)
    lines.push(`|------|${report.adapters.map(() => "-------").join("|")}|`)
    for (const task of tasks) {
      const scores = report.adapters.map(a => {
        const s = comparison.taskMatrix[task]?.[a]
        return s !== undefined ? s.toFixed(2) : "-"
      })
      lines.push(`| ${task} | ${scores.join(" | ")} |`)
    }
    lines.push("")
  }

  // Per-adapter details
  for (const r of report.reports) {
    lines.push(`---`)
    lines.push("")
    lines.push(generateMarkdown(r))
  }

  return lines.join("\n")
}
