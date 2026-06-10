import path from "node:path"
import { mkdir, readdir, stat } from "node:fs/promises"
import type { TokenUsage } from "../core/types.ts"
import type { LLMProvider } from "../providers/types.ts"
import type { BenchCondition, BenchReport, ConditionResult, EvalDetail } from "./types.ts"
import { isAotCondition, isValidCondition, parseAotPasses } from "./types.ts"
import { LOGS_DIR, toPassTag } from "../core/config.ts"
import { getVariantDir } from "../proposals/storage.ts"

interface BenchSessionMetadata {
  sessionId: string
  model: string
  adapter: string
  conditions?: string[]
  startedAt?: string
}

export interface CompareBenchSkillOptions {
  model: string
  adapter: string
  skillPath: string
  lhs: BenchCondition
  rhs: BenchCondition
}

export interface SkillReference {
  inputPath: string
  resolvedInputPath: string
  skillId?: string
  skillDir?: string
  candidateSkillPaths: string[]
}

export interface CompareArtifact {
  condition: BenchCondition
  kind: "original" | "compiled" | "unknown"
  path?: string
  exists: boolean
  note?: string
  extraPaths?: string[]
}

export interface CompareSessionSelection {
  condition: BenchCondition
  sessionId: string
  sessionDir: string
  reportPath: string
  report: BenchReport
  matchedTaskIds: string[]
  timestamp: number
}

export interface TaskDelta {
  taskId: string
  taskName: string
  lhs: ConditionResult
  rhs: ConditionResult
  delta: {
    score: number
    tokens: number
    durationMs: number
    llmDurationMs: number
    steps: number
  }
  /**
   * True when either side of this delta is tainted (`runStatus !== 'ok'`).
   * Score deltas for incomparable rows are meaningless — `0 - 0.8 = -0.8`
   * looks like a regression but actually means "lhs had no evaluable data".
   * `buildAggregate` excludes incomparable rows from avg/passRate
   * denominators, and the renderers display ⚠ instead of a numeric delta.
   */
  incomparable?: boolean
}

export interface AggregateDelta {
  /** Total tasks in the comparison set, including incomparable ones. */
  taskCount: number
  /**
   * Number of tasks where both sides were evaluable (runStatus === 'ok').
   * `avgScore` / `passRate` denominators count this, NOT `taskCount`.
   */
  comparableCount: number
  /** Tasks excluded from score / pass aggregates because at least one side was tainted. */
  incomparableCount: number
  avgScore: { lhs: number; rhs: number; delta: number }
  passRate: { lhs: number; rhs: number; delta: number }
  avgTokens: { lhs: number; rhs: number; delta: number }
  avgDurationMs: { lhs: number; rhs: number; delta: number }
  avgLlmDurationMs: { lhs: number; rhs: number; delta: number }
  avgSteps: { lhs: number; rhs: number; delta: number }
}

export interface TextDiffSummary {
  identical: boolean
  lhsLineCount: number
  rhsLineCount: number
  commonPrefixLines: number
  commonSuffixLines: number
  lhsChangedLines: string[]
  rhsChangedLines: string[]
  lhsChangedPreview: string[]
  rhsChangedPreview: string[]
}

export interface CompareBenchSkillReport {
  model: string
  adapter: string
  lhs: BenchCondition
  rhs: BenchCondition
  skill: SkillReference
  selections?: {
    lhs: CompareSessionSelection
    rhs: CompareSessionSelection
  }
  warnings: string[]
  unmatchedTaskIds?: {
    lhsOnly: string[]
    rhsOnly: string[]
  }
  aggregate?: AggregateDelta
  tasks: TaskDelta[]
  artifacts: {
    lhs: CompareArtifact
    rhs: CompareArtifact
  }
  artifactDiff?: TextDiffSummary
  analysis?: {
    model: string
    summary: string
  }
}

export interface CompareOutputPaths {
  rootDir: string
  skillDir: string
  reportJsonPath: string
  reportMarkdownPath: string
  skillDiffMarkdownPath: string
}

interface SessionCandidate {
  selection: CompareSessionSelection
  taskMap: Map<string, { taskName: string; result: ConditionResult }>
}

export async function compareBenchSkill(
  opts: CompareBenchSkillOptions,
): Promise<CompareBenchSkillReport> {
  if (!isValidCondition(opts.lhs)) {
    throw new Error(`Invalid lhs condition: ${opts.lhs}`)
  }
  if (!isValidCondition(opts.rhs)) {
    throw new Error(`Invalid rhs condition: ${opts.rhs}`)
  }
  if (opts.lhs === opts.rhs) {
    throw new Error("lhs and rhs conditions must be different")
  }

  const skill = await resolveSkillReference(opts.skillPath)
  const warnings: string[] = []
  let selections: CompareBenchSkillReport["selections"]
  let unmatchedTaskIds: CompareBenchSkillReport["unmatchedTaskIds"]
  let aggregate: CompareBenchSkillReport["aggregate"]
  let tasks: TaskDelta[] = []

  const lhsCandidate = await trySelectLatestSessionForCondition(opts.model, opts.adapter, opts.lhs, skill)
  const rhsCandidate = await trySelectLatestSessionForCondition(opts.model, opts.adapter, opts.rhs, skill)

  if (lhsCandidate && rhsCandidate) {
    const lhsTaskIds = new Set(lhsCandidate.selection.matchedTaskIds)
    const rhsTaskIds = new Set(rhsCandidate.selection.matchedTaskIds)
    const commonTaskIds = [...lhsTaskIds].filter((taskId) => rhsTaskIds.has(taskId)).sort()
    const lhsOnly = [...lhsTaskIds].filter((taskId) => !rhsTaskIds.has(taskId)).sort()
    const rhsOnly = [...rhsTaskIds].filter((taskId) => !lhsTaskIds.has(taskId)).sort()

    if (lhsCandidate.selection.sessionId !== rhsCandidate.selection.sessionId) {
      warnings.push(`Conditions come from different sessions: ${lhsCandidate.selection.sessionId} vs ${rhsCandidate.selection.sessionId}`)
    }
    if (lhsOnly.length > 0 || rhsOnly.length > 0) {
      warnings.push("Task sets differ between the selected sessions; comparison uses task intersection only")
    }

    tasks = commonTaskIds.map((taskId) => {
      const lhsEntry = lhsCandidate.taskMap.get(taskId)!
      const rhsEntry = rhsCandidate.taskMap.get(taskId)!
      // A row is "incomparable" when either side is tainted (runStatus !== 'ok').
      // The score delta is still computed numerically (so JSON consumers see
      // it), but renderers and aggregates treat it as not-a-comparison.
      const lhsOk = lhsEntry.result.runStatus === undefined || lhsEntry.result.runStatus === "ok"
      const rhsOk = rhsEntry.result.runStatus === undefined || rhsEntry.result.runStatus === "ok"
      const incomparable = !lhsOk || !rhsOk
      return {
        taskId,
        taskName: lhsEntry.taskName,
        lhs: lhsEntry.result,
        rhs: rhsEntry.result,
        delta: {
          score: rhsEntry.result.score - lhsEntry.result.score,
          tokens: totalTokens(rhsEntry.result.tokens) - totalTokens(lhsEntry.result.tokens),
          durationMs: rhsEntry.result.durationMs - lhsEntry.result.durationMs,
          llmDurationMs: rhsEntry.result.llmDurationMs - lhsEntry.result.llmDurationMs,
          steps: rhsEntry.result.steps - lhsEntry.result.steps,
        },
        ...(incomparable ? { incomparable: true } : {}),
      }
    })

    if (tasks.length > 0) {
      selections = {
        lhs: lhsCandidate.selection,
        rhs: rhsCandidate.selection,
      }
      unmatchedTaskIds = { lhsOnly, rhsOnly }
      aggregate = buildAggregate(tasks)
    }
  }

  const lhsArtifact = await resolveArtifact(opts.lhs, opts.adapter, opts.model, skill)
  const rhsArtifact = await resolveArtifact(opts.rhs, opts.adapter, opts.model, skill)
  const artifactDiff = await buildArtifactDiff(lhsArtifact, rhsArtifact)

  return {
    model: opts.model,
    adapter: opts.adapter,
    lhs: opts.lhs,
    rhs: opts.rhs,
    skill,
    selections,
    warnings,
    unmatchedTaskIds,
    aggregate,
    tasks,
    artifacts: { lhs: lhsArtifact, rhs: rhsArtifact },
    artifactDiff,
  }
}

export async function analyzeCompareBenchSkill(
  report: CompareBenchSkillReport,
  provider: LLMProvider,
  analysisModel: string,
): Promise<CompareBenchSkillReport> {
  if (!report.artifactDiff) {
    return {
      ...report,
      analysis: {
        model: analysisModel,
        summary: "No artifact text diff is available, so there is nothing substantive to summarize.",
      },
    }
  }

  const lhsChanged = report.artifactDiff.lhsChangedLines.slice(0, 80).join("\n")
  const rhsChanged = report.artifactDiff.rhsChangedLines.slice(0, 80).join("\n")
  const prompt = [
    `You are analyzing differences between two versions of a skill document.`,
    `Summarize the meaningful behavioral changes, not just text edits.`,
    `Focus on:`,
    `1. What instructions became more explicit or constrained`,
    `2. What ambiguity was removed`,
    `3. Whether the new version likely changes execution strategy`,
    `4. Risks or tradeoffs introduced by the change`,
    `Output 3-6 concise bullet points in plain text.`,
    ``,
    `Skill: ${report.skill.skillId ?? path.basename(report.skill.resolvedInputPath)}`,
    `Compare: ${report.rhs} vs ${report.lhs}`,
    ``,
    `${report.lhs} changed span:`,
    lhsChanged || "(none)",
    ``,
    `${report.rhs} changed span:`,
    rhsChanged || "(none)",
  ].join("\n")

  const response = await provider.complete({
    messages: [{ role: "user", content: prompt }],
    maxTokens: 500,
    temperature: 0,
  })

  return {
    ...report,
    analysis: {
      model: analysisModel,
      summary: response.text.trim(),
    },
  }
}

export function printCompareBenchSkillReport(report: CompareBenchSkillReport): void {
  console.log(`=== Skill Compare: ${report.lhs} vs ${report.rhs} ===`)
  console.log(`Model: ${report.model}`)
  console.log(`Adapter: ${report.adapter}`)
  console.log(`Skill: ${report.skill.skillId ?? path.basename(report.skill.resolvedInputPath)}`)
  console.log(`Input: ${report.skill.resolvedInputPath}`)
  if (report.selections) {
    console.log(`LHS session: ${report.selections.lhs.sessionId}`)
    console.log(`RHS session: ${report.selections.rhs.sessionId}`)
  }
  console.log("")

  if (report.warnings.length > 0) {
    console.log("Warnings:")
    for (const warning of report.warnings) {
      console.log(`  - ${warning}`)
    }
    console.log("")
  }

  console.log(`Artifacts:`)
  console.log(`  ${report.lhs}: ${describeArtifact(report.artifacts.lhs)}`)
  console.log(`  ${report.rhs}: ${describeArtifact(report.artifacts.rhs)}`)
  if (report.artifactDiff) {
    if (report.artifactDiff.identical) {
      console.log("  Text diff: identical")
    } else {
      console.log(`  Text diff: ${report.artifactDiff.lhsLineCount} lines vs ${report.artifactDiff.rhsLineCount} lines`)
      console.log(`  Common prefix/suffix: ${report.artifactDiff.commonPrefixLines}/${report.artifactDiff.commonSuffixLines}`)
    }
  }
  console.log("")

  if (report.analysis?.summary) {
    console.log(`Analysis (${report.analysis.model}):`)
    console.log(report.analysis.summary)
    console.log("")
  }

  if (!report.aggregate || report.tasks.length === 0) {
    return
  }

  console.log(`Matched tasks: ${report.aggregate.taskCount}`
    + (report.aggregate.incomparableCount > 0
      ? ` (⚠${report.aggregate.incomparableCount} tainted excluded; ${report.aggregate.comparableCount} comparable)`
      : ""))
  console.log(`Avg score: ${formatNumber(report.aggregate.avgScore.lhs)} -> ${formatNumber(report.aggregate.avgScore.rhs)} (${formatSigned(report.aggregate.avgScore.delta)})`)
  console.log(`Pass rate: ${(report.aggregate.passRate.lhs * 100).toFixed(0)}% -> ${(report.aggregate.passRate.rhs * 100).toFixed(0)}% (${formatSigned(report.aggregate.passRate.delta * 100)}%)`)
  console.log(`Avg tokens: ${formatInteger(report.aggregate.avgTokens.lhs)} -> ${formatInteger(report.aggregate.avgTokens.rhs)} (${formatSigned(report.aggregate.avgTokens.delta)})`)
  console.log(`Avg duration: ${formatMs(report.aggregate.avgDurationMs.lhs)} -> ${formatMs(report.aggregate.avgDurationMs.rhs)} (${formatSigned(report.aggregate.avgDurationMs.delta)}ms)`)
  console.log(`Avg LLM time: ${formatMs(report.aggregate.avgLlmDurationMs.lhs)} -> ${formatMs(report.aggregate.avgLlmDurationMs.rhs)} (${formatSigned(report.aggregate.avgLlmDurationMs.delta)}ms)`)
  console.log(`Avg steps: ${formatNumber(report.aggregate.avgSteps.lhs)} -> ${formatNumber(report.aggregate.avgSteps.rhs)} (${formatSigned(report.aggregate.avgSteps.delta)})`)
  console.log("")

  console.log(`${"Task".padEnd(28)} | ${report.lhs.padStart(8)} | ${report.rhs.padStart(8)} | ${"delta".padStart(8)} | ${"tok Δ".padStart(8)} | ${"step Δ".padStart(8)}`)
  console.log("-".repeat(84))
  for (const task of report.tasks) {
    if (task.incomparable) {
      // Tainted on at least one side — show the runStatus instead of fake numbers.
      const lhsCell = task.lhs.runStatus && task.lhs.runStatus !== "ok"
        ? `⚠${task.lhs.runStatus}`.padStart(8).slice(0, 8)
        : task.lhs.score.toFixed(2).padStart(8)
      const rhsCell = task.rhs.runStatus && task.rhs.runStatus !== "ok"
        ? `⚠${task.rhs.runStatus}`.padStart(8).slice(0, 8)
        : task.rhs.score.toFixed(2).padStart(8)
      console.log(
        `${task.taskId.padEnd(28)} | ${lhsCell} | ${rhsCell} | ${"   ⚠ N/A".padStart(8)} | ${String(task.delta.tokens).padStart(8)} | ${String(task.delta.steps).padStart(8)}`,
      )
      continue
    }
    console.log(
      `${task.taskId.padEnd(28)} | ${task.lhs.score.toFixed(2).padStart(8)} | ${task.rhs.score.toFixed(2).padStart(8)} | ${task.delta.score.toFixed(2).padStart(8)} | ${String(task.delta.tokens).padStart(8)} | ${String(task.delta.steps).padStart(8)}`,
    )
    const lhsReason = summarizeEvalDeductions(task.lhs.evalDetails)
    const rhsReason = summarizeEvalDeductions(task.rhs.evalDetails)
    if (lhsReason || rhsReason) {
      console.log(`  ${report.lhs}: ${lhsReason || "no deduction details"}`)
      console.log(`  ${report.rhs}: ${rhsReason || "no deduction details"}`)
    }
  }
}

export function generateCompareBenchSkillMarkdown(report: CompareBenchSkillReport): string {
  const lines: string[] = []
  lines.push(`# Skill Compare: ${report.lhs} vs ${report.rhs}`)
  lines.push("")
  lines.push(`- **Model**: ${report.model}`)
  lines.push(`- **Adapter**: ${report.adapter}`)
  lines.push(`- **Skill**: ${report.skill.skillId ?? path.basename(report.skill.resolvedInputPath)}`)
  lines.push(`- **Input**: ${report.skill.resolvedInputPath}`)
  if (report.selections) {
    lines.push(`- **LHS Session**: ${report.selections.lhs.sessionId}`)
    lines.push(`- **RHS Session**: ${report.selections.rhs.sessionId}`)
  }
  lines.push("")

  if (report.warnings.length > 0) {
    lines.push("## Warnings")
    lines.push("")
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`)
    }
    lines.push("")
  }

  lines.push("## Artifacts")
  lines.push("")
  lines.push(`- **${report.lhs}**: ${describeArtifact(report.artifacts.lhs)}`)
  lines.push(`- **${report.rhs}**: ${describeArtifact(report.artifacts.rhs)}`)
  if (report.analysis?.summary) {
    lines.push("")
    lines.push("## Analysis")
    lines.push("")
    lines.push(`- **Model**: ${report.analysis.model}`)
    lines.push("")
    lines.push(report.analysis.summary)
  }
  if (report.artifactDiff) {
    lines.push("")
    lines.push("### Text Diff Summary")
    lines.push("")
    if (report.artifactDiff.identical) {
      lines.push("Artifacts are text-identical.")
    } else {
      lines.push(`- LHS lines: ${report.artifactDiff.lhsLineCount}`)
      lines.push(`- RHS lines: ${report.artifactDiff.rhsLineCount}`)
      lines.push(`- Common prefix lines: ${report.artifactDiff.commonPrefixLines}`)
      lines.push(`- Common suffix lines: ${report.artifactDiff.commonSuffixLines}`)
      if (report.artifactDiff.lhsChangedPreview.length > 0) {
        lines.push("")
        lines.push(`**${report.lhs} changed span preview**`)
        lines.push("")
        lines.push("```markdown")
        lines.push(...report.artifactDiff.lhsChangedPreview)
        lines.push("```")
      }
      if (report.artifactDiff.rhsChangedPreview.length > 0) {
        lines.push("")
        lines.push(`**${report.rhs} changed span preview**`)
        lines.push("")
        lines.push("```markdown")
        lines.push(...report.artifactDiff.rhsChangedPreview)
        lines.push("```")
      }
    }
    lines.push("")
  }

  if (!report.aggregate || report.tasks.length === 0) {
    return lines.join("\n")
  }

  lines.push("## Aggregate")
  lines.push("")
  if (report.aggregate.incomparableCount > 0) {
    lines.push(
      `> ⚠ ${report.aggregate.incomparableCount} of ${report.aggregate.taskCount} task(s) `
      + `excluded from Avg Score / Pass Rate (tainted on at least one side). `
      + `${report.aggregate.comparableCount} comparable task(s) used in the score aggregates.`
    )
    lines.push("")
  }
  lines.push(`| Metric | ${report.lhs} | ${report.rhs} | Delta |`)
  lines.push(`|--------|--------|--------|-------|`)
  lines.push(`| Avg Score | ${report.aggregate.avgScore.lhs.toFixed(3)} | ${report.aggregate.avgScore.rhs.toFixed(3)} | ${report.aggregate.avgScore.delta.toFixed(3)} |`)
  lines.push(`| Pass Rate | ${(report.aggregate.passRate.lhs * 100).toFixed(1)}% | ${(report.aggregate.passRate.rhs * 100).toFixed(1)}% | ${(report.aggregate.passRate.delta * 100).toFixed(1)}% |`)
  lines.push(`| Avg Tokens | ${Math.round(report.aggregate.avgTokens.lhs)} | ${Math.round(report.aggregate.avgTokens.rhs)} | ${Math.round(report.aggregate.avgTokens.delta)} |`)
  lines.push(`| Avg Duration Ms | ${Math.round(report.aggregate.avgDurationMs.lhs)} | ${Math.round(report.aggregate.avgDurationMs.rhs)} | ${Math.round(report.aggregate.avgDurationMs.delta)} |`)
  lines.push(`| Avg LLM Duration Ms | ${Math.round(report.aggregate.avgLlmDurationMs.lhs)} | ${Math.round(report.aggregate.avgLlmDurationMs.rhs)} | ${Math.round(report.aggregate.avgLlmDurationMs.delta)} |`)
  lines.push(`| Avg Steps | ${report.aggregate.avgSteps.lhs.toFixed(2)} | ${report.aggregate.avgSteps.rhs.toFixed(2)} | ${report.aggregate.avgSteps.delta.toFixed(2)} |`)
  lines.push("")

  lines.push("## Per-Task")
  lines.push("")
  lines.push(`| Task | ${report.lhs} | ${report.rhs} | Score Delta | Token Delta | Step Delta |`)
  lines.push(`|------|--------|--------|-------------|-------------|------------|`)
  for (const task of report.tasks) {
    if (task.incomparable) {
      // Either side is tainted — show ⚠ <runStatus> for the tainted side(s)
      // and N/A for the score delta. Token / step deltas remain numeric
      // because tokens and steps are real resources spent.
      const lhsCell = task.lhs.runStatus && task.lhs.runStatus !== "ok"
        ? `⚠ ${task.lhs.runStatus}`
        : task.lhs.score.toFixed(2)
      const rhsCell = task.rhs.runStatus && task.rhs.runStatus !== "ok"
        ? `⚠ ${task.rhs.runStatus}`
        : task.rhs.score.toFixed(2)
      lines.push(`| ${task.taskId} | ${lhsCell} | ${rhsCell} | ⚠ N/A | ${task.delta.tokens} | ${task.delta.steps} |`)
      continue
    }
    lines.push(`| ${task.taskId} | ${task.lhs.score.toFixed(2)} | ${task.rhs.score.toFixed(2)} | ${task.delta.score.toFixed(2)} | ${task.delta.tokens} | ${task.delta.steps} |`)
  }
  lines.push("")

  for (const task of report.tasks) {
    const lhsReason = summarizeEvalDeductions(task.lhs.evalDetails)
    const rhsReason = summarizeEvalDeductions(task.rhs.evalDetails)
    if (!lhsReason && !rhsReason) continue
    lines.push(`### ${task.taskId}`)
    lines.push("")
    lines.push(`- **${report.lhs}**: ${lhsReason || "no deduction details"}`)
    lines.push(`- **${report.rhs}**: ${rhsReason || "no deduction details"}`)
    lines.push("")
  }

  return lines.join("\n")
}

export function generateCompareSkillDiffMarkdown(report: CompareBenchSkillReport): string {
  const lines: string[] = []
  lines.push(`# Skill Diff: ${report.rhs} vs ${report.lhs}`)
  lines.push("")
  lines.push(`- **Skill**: ${report.skill.skillId ?? path.basename(report.skill.resolvedInputPath)}`)
  lines.push(`- **Input**: ${report.skill.resolvedInputPath}`)
  lines.push(`- **LHS Artifact**: ${describeArtifact(report.artifacts.lhs)}`)
  lines.push(`- **RHS Artifact**: ${describeArtifact(report.artifacts.rhs)}`)
  lines.push("")

  if (report.analysis?.summary) {
    lines.push("## Summary")
    lines.push("")
    lines.push(`- **Model**: ${report.analysis.model}`)
    lines.push("")
    lines.push(report.analysis.summary)
    lines.push("")
  }

  if (!report.artifactDiff) {
    lines.push("No artifact text diff is available for this comparison.")
    return lines.join("\n")
  }

  if (report.artifactDiff.identical) {
    lines.push("Artifacts are text-identical.")
    return lines.join("\n")
  }

  lines.push(`- **LHS Lines**: ${report.artifactDiff.lhsLineCount}`)
  lines.push(`- **RHS Lines**: ${report.artifactDiff.rhsLineCount}`)
  lines.push(`- **Common Prefix Lines**: ${report.artifactDiff.commonPrefixLines}`)
  lines.push(`- **Common Suffix Lines**: ${report.artifactDiff.commonSuffixLines}`)
  lines.push("")

  lines.push(`## ${report.lhs} Changed Span`)
  lines.push("")
  lines.push("```markdown")
  lines.push(...(report.artifactDiff.lhsChangedLines.length > 0 ? report.artifactDiff.lhsChangedLines : ["(no unique changed lines)"]))
  lines.push("```")
  lines.push("")

  lines.push(`## ${report.rhs} Changed Span`)
  lines.push("")
  lines.push("```markdown")
  lines.push(...(report.artifactDiff.rhsChangedLines.length > 0 ? report.artifactDiff.rhsChangedLines : ["(no unique changed lines)"]))
  lines.push("```")
  lines.push("")

  return lines.join("\n")
}

export async function writeCompareBenchSkillOutputs(
  report: CompareBenchSkillReport,
  outputRoot: string,
): Promise<CompareOutputPaths> {
  const skillDirName = sanitizePathSegment(report.skill.skillId ?? path.basename(report.skill.resolvedInputPath))
  const pairName = `${sanitizePathSegment(report.rhs)}-vs-${sanitizePathSegment(report.lhs)}`
  const targetName = `${sanitizePathSegment(report.adapter)}--${sanitizePathSegment(report.model)}`
  const skillDir = path.join(outputRoot, skillDirName)

  await mkdir(skillDir, { recursive: true })

  const paths: CompareOutputPaths = {
    rootDir: outputRoot,
    skillDir,
    reportJsonPath: path.join(skillDir, `${targetName}--${pairName}.report.json`),
    reportMarkdownPath: path.join(skillDir, `${targetName}--${pairName}.report.md`),
    skillDiffMarkdownPath: path.join(skillDir, `${targetName}--${pairName}.skill-diff.md`),
  }

  await Bun.write(paths.reportJsonPath, JSON.stringify(report, null, 2))
  await Bun.write(paths.reportMarkdownPath, generateCompareBenchSkillMarkdown(report))
  await Bun.write(paths.skillDiffMarkdownPath, generateCompareSkillDiffMarkdown(report))
  return paths
}

export function summarizeTextDiff(lhsText: string, rhsText: string, previewLines = 8): TextDiffSummary {
  const lhsLines = lhsText.split("\n")
  const rhsLines = rhsText.split("\n")

  let prefix = 0
  while (prefix < lhsLines.length && prefix < rhsLines.length && lhsLines[prefix] === rhsLines[prefix]) {
    prefix++
  }

  let lhsEnd = lhsLines.length - 1
  let rhsEnd = rhsLines.length - 1
  let suffix = 0
  while (lhsEnd >= prefix && rhsEnd >= prefix && lhsLines[lhsEnd] === rhsLines[rhsEnd]) {
    lhsEnd--
    rhsEnd--
    suffix++
  }

  return {
    identical: lhsText === rhsText,
    lhsLineCount: lhsLines.length,
    rhsLineCount: rhsLines.length,
    commonPrefixLines: prefix,
    commonSuffixLines: suffix,
    lhsChangedLines: lhsLines.slice(prefix, lhsEnd + 1),
    rhsChangedLines: rhsLines.slice(prefix, rhsEnd + 1),
    lhsChangedPreview: lhsLines.slice(prefix, Math.min(lhsEnd + 1, prefix + previewLines)),
    rhsChangedPreview: rhsLines.slice(prefix, Math.min(rhsEnd + 1, prefix + previewLines)),
  }
}

async function trySelectLatestSessionForCondition(
  model: string,
  adapter: string,
  condition: BenchCondition,
  skill: SkillReference,
): Promise<SessionCandidate | null> {
  try {
    return await selectLatestSessionForCondition(model, adapter, condition, skill)
  } catch {
    return null
  }
}

export function matchesConditionResultSkill(result: ConditionResult, skill: SkillReference): boolean {
  const normalizedCandidates = new Set(skill.candidateSkillPaths.map(normalizeComparePath))
  const resultPaths = [result.skillPath, ...(result.skillPaths ?? [])]
    .filter((value): value is string => Boolean(value))
    .map(normalizeComparePath)

  if (resultPaths.some((value) => normalizedCandidates.has(value))) {
    return true
  }

  if (skill.skillId && result.skillId === skill.skillId) {
    return true
  }

  return false
}

async function resolveSkillReference(inputPath: string): Promise<SkillReference> {
  const resolvedInputPath = path.resolve(inputPath)
  const inputStat = await stat(resolvedInputPath).catch(() => null)
  if (!inputStat) {
    throw new Error(`Skill path not found: ${inputPath}`)
  }

  const candidates = new Set<string>()
  const pushCandidate = (value?: string): void => {
    if (!value) return
    candidates.add(path.resolve(value))
  }

  if (inputStat.isDirectory()) {
    pushCandidate(path.join(resolvedInputPath, "SKILL.md"))
  } else {
    pushCandidate(resolvedInputPath)
  }

  const inferredDir = inputStat.isDirectory() ? resolvedInputPath : path.dirname(resolvedInputPath)
  const inferredSkillId = path.basename(inferredDir)

  return {
    inputPath,
    resolvedInputPath,
    skillId: inferredSkillId,
    skillDir: inferredDir,
    candidateSkillPaths: [...candidates].sort(),
  }
}

async function selectLatestSessionForCondition(
  model: string,
  adapter: string,
  condition: BenchCondition,
  skill: SkillReference,
): Promise<SessionCandidate> {
  const benchLogsDir = path.join(LOGS_DIR, "bench")
  const entries = await readdir(benchLogsDir, { withFileTypes: true }).catch(() => [])
  const candidates: SessionCandidate[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sessionDir = path.join(benchLogsDir, entry.name)
    const metadataPath = path.join(sessionDir, "metadata.json")
    const reportPath = path.join(sessionDir, "report.json")
    const metadataFile = Bun.file(metadataPath)
    const reportFile = Bun.file(reportPath)
    if (!(await metadataFile.exists()) || !(await reportFile.exists())) continue

    const metadata = JSON.parse(await metadataFile.text()) as BenchSessionMetadata
    if (metadata.model !== model || metadata.adapter !== adapter) continue
    if (metadata.conditions && !metadata.conditions.includes(condition)) continue

    const report = JSON.parse(await reportFile.text()) as BenchReport
    const taskMap = new Map<string, { taskName: string; result: ConditionResult }>()
    for (const task of report.tasks) {
      const result = task.conditions.find((value) => value.condition === condition)
      if (!result) continue
      if (!matchesConditionResultSkill(result, skill)) continue
      taskMap.set(task.taskId, { taskName: task.taskName, result })
    }
    if (taskMap.size === 0) continue

    candidates.push({
      selection: {
        condition,
        sessionId: report.sessionId,
        sessionDir,
        reportPath,
        report,
        matchedTaskIds: [...taskMap.keys()].sort(),
        timestamp: extractSessionTimestamp(report.sessionId, report.timestamp, metadata.startedAt),
      },
      taskMap,
    })
  }

  candidates.sort((a, b) => b.selection.timestamp - a.selection.timestamp)
  const latest = candidates[0]
  if (!latest) {
    throw new Error(`No completed bench session found for ${condition} with model=${model}, adapter=${adapter}, skill=${skill.resolvedInputPath}`)
  }
  return latest
}

function extractSessionTimestamp(sessionId: string, reportTimestamp?: string, startedAt?: string): number {
  const match = sessionId.match(/-(\d+)$/)
  if (match) return Number(match[1])
  const iso = reportTimestamp ?? startedAt
  if (iso) {
    const parsed = Date.parse(iso)
    if (!Number.isNaN(parsed)) return parsed
  }
  return 0
}

function buildAggregate(tasks: TaskDelta[]): AggregateDelta {
  // Score / passRate are computed over comparable rows only. Including a
  // tainted row (`score: 0` from the runner gate) on either side would
  // pollute the cross-condition comparison with infra-failure noise. Cost
  // and timing aggregates still use ALL rows because those are real
  // resources spent on the attempt regardless of evaluability.
  const comparable = tasks.filter((task) => !task.incomparable)
  const lhsScores = comparable.map((task) => task.lhs.score)
  const rhsScores = comparable.map((task) => task.rhs.score)
  const lhsPass = comparable.length > 0
    ? comparable.filter((task) => task.lhs.pass).length / comparable.length
    : 0
  const rhsPass = comparable.length > 0
    ? comparable.filter((task) => task.rhs.pass).length / comparable.length
    : 0
  const lhsTokens = tasks.map((task) => totalTokens(task.lhs.tokens))
  const rhsTokens = tasks.map((task) => totalTokens(task.rhs.tokens))
  const lhsDuration = tasks.map((task) => task.lhs.durationMs)
  const rhsDuration = tasks.map((task) => task.rhs.durationMs)
  const lhsLlm = tasks.map((task) => task.lhs.llmDurationMs)
  const rhsLlm = tasks.map((task) => task.rhs.llmDurationMs)
  const lhsSteps = tasks.map((task) => task.lhs.steps)
  const rhsSteps = tasks.map((task) => task.rhs.steps)

  return {
    taskCount: tasks.length,
    comparableCount: comparable.length,
    incomparableCount: tasks.length - comparable.length,
    avgScore: avgWithDelta(lhsScores, rhsScores),
    passRate: { lhs: lhsPass, rhs: rhsPass, delta: rhsPass - lhsPass },
    avgTokens: avgWithDelta(lhsTokens, rhsTokens),
    avgDurationMs: avgWithDelta(lhsDuration, rhsDuration),
    avgLlmDurationMs: avgWithDelta(lhsLlm, rhsLlm),
    avgSteps: avgWithDelta(lhsSteps, rhsSteps),
  }
}

async function resolveArtifact(
  condition: BenchCondition,
  adapter: string,
  model: string,
  skill: SkillReference,
): Promise<CompareArtifact> {
  if (condition === "original") {
    const existing = await firstExistingPath(skill.candidateSkillPaths)
    return {
      condition,
      kind: "original",
      path: existing ?? skill.candidateSkillPaths[0],
      exists: Boolean(existing),
      note: existing ? undefined : "Original SKILL.md was not found at the resolved skill path",
    }
  }

  if (isAotCondition(condition)) {
    if (!skill.skillId) {
      return {
        condition,
        kind: "compiled",
        exists: false,
        note: "Skill ID could not be resolved; cannot derive compiled variant path",
      }
    }
    const passes = parseAotPasses(condition) ?? [1, 2, 3]
    const passTag = toPassTag(passes)
    const variantDir = getVariantDir(adapter, model, skill.skillId, passTag)
    const compiledPath = path.join(variantDir, "SKILL.md")
    const exists = await Bun.file(compiledPath).exists()
    return {
      condition,
      kind: "compiled",
      path: compiledPath,
      exists,
      note: exists ? undefined : `Compiled variant not found for ${passTag}`,
    }
  }

  return {
    condition,
    kind: "unknown",
    exists: false,
    note: "Artifact resolution is not implemented for this condition",
  }
}

async function buildArtifactDiff(
  lhs: CompareArtifact,
  rhs: CompareArtifact,
): Promise<TextDiffSummary | undefined> {
  if (!lhs.exists || !rhs.exists || !lhs.path || !rhs.path) return undefined
  const lhsText = await Bun.file(lhs.path).text().catch(() => null)
  const rhsText = await Bun.file(rhs.path).text().catch(() => null)
  if (lhsText === null || rhsText === null) return undefined
  return summarizeTextDiff(lhsText, rhsText)
}

async function firstExistingPath(paths: string[]): Promise<string | undefined> {
  for (const value of paths) {
    if (await Bun.file(value).exists()) return value
  }
  return undefined
}

function normalizeComparePath(value: string): string {
  return path.resolve(value)
}

function totalTokens(tokens: TokenUsage): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
}

function avg(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function avgWithDelta(lhsValues: number[], rhsValues: number[]): { lhs: number; rhs: number; delta: number } {
  const lhs = avg(lhsValues)
  const rhs = avg(rhsValues)
  return { lhs, rhs, delta: rhs - lhs }
}

function summarizeEvalDeductions(details?: EvalDetail[]): string {
  if (!details?.length) return ""
  const deductions = details.filter((detail) => detail.score < 1.0)
  if (deductions.length === 0) return ""
  return deductions
    .slice(0, 2)
    .map((detail) => {
      const label = detail.name ?? detail.id ?? detail.method
      return `${detail.method}/${label}=${detail.score.toFixed(2)}: ${detail.details.slice(0, 120)}`
    })
    .join(" | ")
}

function describeArtifact(artifact: CompareArtifact): string {
  const base = artifact.path ? `${artifact.kind} ${artifact.path}` : artifact.kind
  if (artifact.exists) return base
  const note = artifact.note ? ` (${artifact.note})` : ""
  return `${base}${note}`
}

function formatNumber(value: number): string {
  return value.toFixed(2)
}

function formatInteger(value: number): string {
  return String(Math.round(value))
}

function formatSigned(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return `${rounded >= 0 ? "+" : ""}${rounded.toFixed(2)}`
}

function formatMs(value: number): string {
  return `${Math.round(value)}ms`
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-")
}