/**
 * Workspace helpers for the optimizer:
 *  - copy skill folder to a temp workspace
 *  - serialize evidence + history into .optimize/ as both JSON and markdown
 *  - compute the diff between workspace and original skill folder
 */

import path from "node:path"
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { copySkillDir } from "../core/fs-utils.ts"
import { scoreFromCriteria } from "./evidence.ts"
import type { Evidence, EvidenceCriterion, HistoryEntry } from "./types.ts"

/**
 * Per-task status thresholds. A task mean at or above `PASSING` is
 * considered safe (the No-trade-off rule's "don't make these worse"
 * set); below `FAILING` is where the optimizer should focus. Anything
 * in between is MARGINAL — fixable but riskier. Defined once so the
 * README explanation, the summary table, and the bucketing logic
 * can't drift from each other.
 */
const STATUS_THRESHOLD_PASSING = 0.9
const STATUS_THRESHOLD_FAILING = 0.5

/**
 * Turn a task id into a filesystem-safe directory name. Task ids in
 * practice are already simple slugs (`pdf-extract`, `chart-generator`)
 * but the log source derives them from file paths, so we defensively
 * reduce anything non-alphanumeric/.-_ to `-` and collapse repeats.
 *
 * Critical constraints enforced here:
 *  - Never return `.`, `..`, or any sequence of pure dots. `path.join(root,
 *    "..")` resolves outside `root` and would clobber the workspace; a bare
 *    `.` collapses the parent segment and confuses layout. The log source
 *    can realistically produce these ids (e.g. a file named `...jsonl`
 *    whose extension-stripped basename is `..`).
 *  - Never return empty. Empty path segments silently drop a directory
 *    level on most platforms.
 *
 * `safeModelName` in core/config.ts only handles `/` and `:` — the
 * semantics are wrong for task ids and its slash replacement (`--`)
 * looks like a CLI flag prefix, which is confusing in directory names.
 */
function safeTaskSlug(taskId: string): string {
  const replaced = taskId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-")
  const trimmed = replaced.replace(/^-+|-+$/g, "")
  if (trimmed.length === 0) return "unnamed-task"
  // Reject pure-dot slugs (`.`, `..`, `...`, etc.). A slug must contain at
  // least one non-dot character to be a distinct directory name.
  if (/^\.+$/.test(trimmed)) return "unnamed-task"
  return trimmed
}

// ---------------------------------------------------------------------------
// Walk helper (for diffing)
// ---------------------------------------------------------------------------

const BUNDLE_EXCLUDED = new Set(["LICENSE.txt", "_meta.json"])

/**
 * Walk a directory recursively and yield (relativePath, absolutePath) for every
 * file. Skips hidden files and the .optimize/ scratch directory.
 */
async function* walkFiles(root: string, base: string = root): AsyncGenerator<{ rel: string; abs: string }> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(base, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue
    if (BUNDLE_EXCLUDED.has(entry.name)) continue
    const full = path.join(base, entry.name)
    if (entry.isDirectory()) {
      yield* walkFiles(root, full)
    } else if (entry.isFile()) {
      yield { rel: path.relative(root, full), abs: full }
    }
  }
}

// ---------------------------------------------------------------------------
// Workspace creation
// ---------------------------------------------------------------------------

export interface Workspace {
  dir: string
  optimizeDir: string
  submissionPath: string
}

export async function createWorkspace(skillDir: string): Promise<Workspace> {
  const dir = await mkdtemp(path.join(tmpdir(), "jit-optimize-"))
  await copySkillDir(skillDir, dir)
  const optimizeDir = path.join(dir, ".optimize")
  await mkdir(optimizeDir, { recursive: true })
  return {
    dir,
    optimizeDir,
    submissionPath: path.join(optimizeDir, "submission.json"),
  }
}

// ---------------------------------------------------------------------------
// Evidence / history serialization
// ---------------------------------------------------------------------------

export interface SerializeOptions {
  maxConvLogEntries?: number
  maxFileInlineChars?: number
}

const DEFAULT_MAX_CONV_LOG = 400
const DEFAULT_MAX_FILE_INLINE = 4000

/**
 * Grouped view of a single evidence for layout purposes. `globalIndex` is the
 * stable 0..N-1 integer the optimizer still uses in `blockedEvidenceIds` —
 * kept as the canonical audit reference even though the files themselves live
 * under `tasks/{safeTaskId}/run-{localIndex}.md` now. `infraTainted` /
 * `score` are cached at grouping time so the render helpers don't
 * re-scan criteria for each run.
 */
interface TaskGroupRun {
  globalIndex: number
  localIndex: number
  evidence: Evidence
  infraTainted: boolean
  score: number | null
}

type TaskStatus = "FAILING" | "MARGINAL" | "PASSING" | "TAINTED"

interface TaskGroup {
  taskId: string
  safeId: string
  runs: TaskGroupRun[]
  mean: number | null
  status: TaskStatus
  worstCriterion: string | null
}

/** Write evidence + history + a README into {workspace}/.optimize/ */
export async function serializeContext(
  optimizeDir: string,
  evidences: Evidence[],
  history: HistoryEntry[],
  opts: SerializeOptions = {},
): Promise<void> {
  const maxConvLog = opts.maxConvLogEntries ?? DEFAULT_MAX_CONV_LOG
  const maxFileInline = opts.maxFileInlineChars ?? DEFAULT_MAX_FILE_INLINE

  const groups = groupEvidencesByTask(evidences)

  // README: navigation guide
  const readme = buildReadme(groups, history.length)
  await Bun.write(path.join(optimizeDir, "README.md"), readme)

  // Top-level PER_TASK_SUMMARY.md. This is the anchor the optimizer prompt
  // references for the No-trade-off rule: the PASSING column tells it what
  // it must NOT break while fixing the FAILING / MARGINAL rows.
  await Bun.write(
    path.join(optimizeDir, "PER_TASK_SUMMARY.md"),
    renderPerTaskSummary(groups),
  )

  // Submission template. Three valid shapes — pick one and fill it in.
  await Bun.write(
    path.join(optimizeDir, "submission.template.json"),
    JSON.stringify({
      _comment: "This file shows all three valid submission shapes. Pick ONE for submission.json — don't submit this file verbatim.",
      _shape_1_edit: {
        rootCause: "One paragraph diagnosing the underlying problem (not what you changed).",
        reasoning: "Full analysis, including the four answers from the Pre-Edit Checklist in step 4: generality test, rewrite-in-place test, budget, no-trade-off test.",
        confidence: 0.8,
        changedFiles: ["SKILL.md"],
        changes: [
          {
            file: "SKILL.md",
            section: "workflow",
            description: "Rewrite step 2 to make the ordering explicit.",
            generality: "Any task on this skill that exercises step 2 under time pressure benefits from the tightened ordering — e.g. the batch-import task under tasks/task-import/ and any similar bulk-operation task.",
            linesDelta: -1,
          },
        ],
      },
      _shape_2_no_changes: {
        noChanges: true,
        rootCause: "The failure is specific to the task fixture under tasks/task-foo/; the skill correctly instructs the agent and no generalizable fix exists.",
      },
      _shape_3_infra_blocked: {
        infraBlocked: true,
        blockedEvidenceIds: ["0", "1"],
        blockedReason: "Both runs have runStatus=timeout with tokens=0 and durationMs matching task.timeoutMs — the agent subprocess was killed before producing any LLM output. The 'Evidence Index' column in PER_TASK_SUMMARY.md identifies these runs (0 and 1). No skill-level diagnosis is possible.",
      },
    }, null, 2),
  )

  // Task-first evidence layout: tasks/{safeTaskId}/{summary.md, run-N.md, run-N.json, run-N-workdir/}
  // runsPerTask > 1 means a task contributes multiple runs; localIndex is
  // sequential per task, globalIndex is the flat 0..N-1 position that
  // `blockedEvidenceIds` still references.
  for (const group of groups) {
    const taskDir = path.join(optimizeDir, "tasks", group.safeId)
    await mkdir(taskDir, { recursive: true })
    await Bun.write(
      path.join(taskDir, "summary.md"),
      renderTaskGroupSummary(group),
    )
    for (const run of group.runs) {
      await Bun.write(
        path.join(taskDir, `run-${run.localIndex}.json`),
        JSON.stringify(serializeEvidenceJson(run.evidence), null, 2),
      )
      await Bun.write(
        path.join(taskDir, `run-${run.localIndex}.md`),
        renderEvidenceMarkdown(group, run, { maxConvLog, maxFileInline }),
      )

      if (run.evidence.workDirSnapshot && run.evidence.workDirSnapshot.files.size > 0) {
        const snapDir = path.join(taskDir, `run-${run.localIndex}-workdir`)
        // mkdir once per unique parent directory instead of once per
        // file — sibling files in the same workdir subdirectory don't
        // need a repeated recursive mkdir call each time.
        const createdDirs = new Set<string>()
        for (const [filePath, content] of run.evidence.workDirSnapshot.files) {
          const dest = path.join(snapDir, filePath)
          const parent = path.dirname(dest)
          if (!createdDirs.has(parent)) {
            await mkdir(parent, { recursive: true })
            createdDirs.add(parent)
          }
          await Bun.write(dest, content)
        }
      }
    }
  }

  // History
  if (history.length > 0) {
    await Bun.write(
      path.join(optimizeDir, "history.json"),
      JSON.stringify(history, null, 2),
    )
    await Bun.write(
      path.join(optimizeDir, "history.md"),
      renderHistoryMarkdown(history),
    )
  }
}

/**
 * Claim a unique filesystem-safe id for a task group, disambiguating with
 * a numeric suffix when a previously-seen group already took the slug.
 * Comparison is case-insensitive so case-only differences (`Foo` vs
 * `foo`) collide on case-insensitive filesystems like macOS APFS.
 */
function allocateSafeId(base: string, claimed: Set<string>): string {
  if (!claimed.has(base.toLowerCase())) {
    claimed.add(base.toLowerCase())
    return base
  }
  for (let suffix = 2; suffix < Number.MAX_SAFE_INTEGER; suffix++) {
    const candidate = `${base}-${suffix}`
    if (!claimed.has(candidate.toLowerCase())) {
      claimed.add(candidate.toLowerCase())
      return candidate
    }
  }
  // Unreachable — the loop runs until it finds a free slug.
  throw new Error("allocateSafeId: exhausted suffix range")
}

/**
 * Group evidences by taskId in the order they first appear. Each run's
 * infra-taint flag, score, and the group's worst-criterion label are
 * computed in one pass over the criteria list, which is what the render
 * helpers need downstream. Preserves the original flat index as
 * `globalIndex` so `blockedEvidenceIds` keeps working.
 */
function groupEvidencesByTask(evidences: Evidence[]): TaskGroup[] {
  const order: string[] = []
  const byId = new Map<string, TaskGroup>()
  const worstByGroup = new Map<string, { score: number; label: string }>()
  // Tracks safeIds already handed out so two distinct taskIds that collapse
  // to the same slug (e.g. `pdf/extract` vs `pdf:extract`, or either
  // falling back to `unnamed-task`) end up in distinct directories.
  // Case-insensitive matching so macOS APFS default config doesn't
  // silently alias `Foo` and `foo`.
  const claimedSafeIds = new Set<string>()

  for (let i = 0; i < evidences.length; i++) {
    const ev = evidences[i]!
    let group = byId.get(ev.taskId)
    if (!group) {
      group = {
        taskId: ev.taskId,
        safeId: allocateSafeId(safeTaskSlug(ev.taskId), claimedSafeIds),
        runs: [],
        mean: null,
        status: "TAINTED",
        worstCriterion: null,
      }
      byId.set(ev.taskId, group)
      order.push(ev.taskId)
    }

    // Single pass over criteria: detect infra-taint, track worst-scoring
    // clean criterion for the summary column, and — if the run wasn't
    // tainted — compute the run's score via the canonical
    // `scoreFromCriteria` helper (which re-walks criteria, but only once
    // per run now instead of the previous three-pass structure).
    let hasInfra = false
    const criteria = ev.criteria ?? []
    for (const c of criteria) {
      if (c.infraError !== undefined) {
        hasInfra = true
        continue
      }
      const prior = worstByGroup.get(ev.taskId)
      if (prior === undefined || c.score < prior.score) {
        worstByGroup.set(ev.taskId, { score: c.score, label: c.name ?? c.id })
      }
    }
    const score = hasInfra ? null : scoreFromCriteria(criteria)
    group.runs.push({
      globalIndex: i,
      localIndex: group.runs.length,
      evidence: ev,
      infraTainted: hasInfra,
      score,
    })
  }

  for (const group of byId.values()) {
    const cleanScores: number[] = []
    for (const run of group.runs) {
      if (run.score !== null) cleanScores.push(run.score)
    }
    if (cleanScores.length > 0) {
      group.mean = cleanScores.reduce((a, b) => a + b, 0) / cleanScores.length
      group.status =
        group.mean >= STATUS_THRESHOLD_PASSING
          ? "PASSING"
          : group.mean < STATUS_THRESHOLD_FAILING
            ? "FAILING"
            : "MARGINAL"
    }
    const worst = worstByGroup.get(group.taskId)
    group.worstCriterion = worst === undefined
      ? null
      : `${worst.label} (${worst.score.toFixed(2)})`
  }

  return order.map((id) => byId.get(id)!)
}

function renderPerTaskSummary(groups: TaskGroup[]): string {
  const parts: string[] = []
  parts.push("# Per-Task Summary")
  parts.push("")
  parts.push(
    "Each row is one task from round-0 (baseline) grouped across its runs. " +
    "The `Status` column is what the selection engine's per-task regression gate " +
    "uses to decide whether your edit is allowed to win. **You must not make any " +
    "PASSING task worse than its current mean.**",
  )
  parts.push("")
  parts.push("Status buckets:")
  parts.push("- **FAILING** (mean < 0.5) — you're here to fix these.")
  parts.push("- **MARGINAL** (0.5 ≤ mean < 0.9) — fixable, but watch for regressions.")
  parts.push("- **PASSING** (mean ≥ 0.9) — leave them alone. Your edit must NOT lower these.")
  parts.push("- **TAINTED** — all runs were infra-broken; no usable score. See the Abstain section of your instructions.")
  parts.push("")

  // Sort by mean ascending so the pain points are at the top; TAINTED rows
  // last because they carry no score. Display order is for humans only —
  // the Evidence Index column gives the canonical audit identity.
  const sorted = [...groups].sort((a, b) => {
    const av = a.mean ?? Infinity
    const bv = b.mean ?? Infinity
    return av - bv
  })

  parts.push("| Status   | Task ID | Runs | Mean | Dir (relative to .optimize/) | Worst Criterion | Evidence Indices |")
  parts.push("|----------|---------|------|------|------------------------------|-----------------|------------------|")
  for (const g of sorted) {
    const mean = g.mean === null ? "n/a" : g.mean.toFixed(3)
    const dir = `tasks/${g.safeId}/`
    const worst = g.worstCriterion ?? "(none)"
    const indices = g.runs.map((r) => r.globalIndex).join(",")
    parts.push(
      `| ${g.status.padEnd(8)} | \`${g.taskId}\` | ${g.runs.length} | ${mean} | ${dir} | ${worst} | ${indices} |`,
    )
  }
  parts.push("")
  parts.push(
    "The **Evidence Indices** column is what `blockedEvidenceIds` references " +
    "if you emit an `infraBlocked` submission — it's the original flat 0..N-1 " +
    "numbering, independent of the per-task directory layout.",
  )
  parts.push("")
  return parts.join("\n")
}

function renderTaskGroupSummary(group: TaskGroup): string {
  const parts: string[] = []
  parts.push(`# Task \`${group.taskId}\` — ${group.status}`)
  parts.push("")
  parts.push(`- runs: ${group.runs.length}`)
  parts.push(`- mean score: ${group.mean === null ? "n/a" : group.mean.toFixed(3)}`)
  if (group.worstCriterion) {
    parts.push(`- worst criterion: ${group.worstCriterion}`)
  }
  parts.push("")
  parts.push(`## Per-Run Breakdown`)
  parts.push("")
  parts.push("| Local | Evidence Index | Score | Status |")
  parts.push("|-------|---------------|-------|--------|")
  for (const run of group.runs) {
    const scoreText = run.score === null ? "n/a" : run.score.toFixed(3)
    const statusText = run.infraTainted
      ? "INFRA-TAINTED"
      : run.score === null ? "no-data" : "scored"
    parts.push(`| run-${run.localIndex} | ${run.globalIndex} | ${scoreText} | ${statusText} |`)
  }
  parts.push("")
  parts.push(`See \`run-N.md\` in this directory for the full evidence of each run.`)
  parts.push("")
  return parts.join("\n")
}

function serializeEvidenceJson(ev: Evidence): object {
  return {
    taskId: ev.taskId,
    taskPrompt: ev.taskPrompt,
    criteria: ev.criteria ?? null,
    runMeta: ev.runMeta ?? null,
    conversationLogEntries: ev.conversationLog.length,
    workDirFileCount: ev.workDirSnapshot?.files.size ?? 0,
    conversationLog: ev.conversationLog,
  }
}

function renderCriterionBlock(c: EvidenceCriterion): string[] {
  const lines: string[] = []
  const icon = c.passed ? "✓" : "✗"
  const label = c.name ?? c.id
  const weightPct = (c.weight * 100).toFixed(1)
  lines.push(`### ${icon} ${label} (weight ${weightPct}%, score ${c.score.toFixed(2)})`)
  lines.push(`- **id:** \`${c.id}\``)
  lines.push(`- **method:** ${c.method}`)
  if (c.description) {
    lines.push(`- **what it tests:** ${c.description}`)
  }
  if (c.details) {
    lines.push(`- **why below max:** ${c.details}`)
  }
  lines.push("")
  return lines
}

function renderEvidenceMarkdown(
  group: TaskGroup,
  run: TaskGroupRun,
  opts: { maxConvLog: number; maxFileInline: number },
): string {
  const ev = run.evidence
  const parts: string[] = []
  parts.push(`# Task \`${group.taskId}\` — run ${run.localIndex}`)
  parts.push("")
  parts.push(`- Evidence Index (global): ${run.globalIndex}`)
  parts.push(`- Task status (across all runs): ${group.status}`)
  if (group.mean !== null) {
    parts.push(`- Task mean score: ${group.mean.toFixed(3)}`)
  }
  parts.push("")
  parts.push(`## Task`)
  parts.push("")
  parts.push("```")
  parts.push(ev.taskPrompt)
  parts.push("```")
  parts.push("")

  if (ev.criteria && ev.criteria.length > 0) {
    const failedFirst = [...ev.criteria].sort((a, b) => {
      if (a.passed !== b.passed) return a.passed ? 1 : -1
      return b.weight - a.weight
    })
    const failed = failedFirst.filter((c) => !c.passed)
    parts.push(`## Evaluation Criteria (${ev.criteria.length} total, ${failed.length} failed)`)
    parts.push("")
    parts.push(
      failed.length > 0
        ? `Failed criteria are listed first, ordered by weight (biggest impact on the overall score first). Each criterion's weight is its normalized share of the total task score.`
        : `All criteria passed. Listed in order of weight for reference.`,
    )
    parts.push("")
    for (const c of failedFirst) {
      parts.push(...renderCriterionBlock(c))
    }
  } else {
    parts.push(`## Evaluation Criteria`)
    parts.push("")
    parts.push("(no structured eval data available for this evidence)")
    parts.push("")
  }

  if (ev.runMeta) {
    parts.push(`## Run Metadata`)
    parts.push("")
    // runStatus is the canonical infra-health signal. Show it first so the
    // optimizer can see at a glance whether this evidence reflects skill
    // behavior or infrastructure failure. Values other than 'ok' mean the
    // run was not scored — the abstain path (jit-optimize-abstain-path.md)
    // will consume this to avoid hallucinating skill edits.
    if (ev.runMeta.runStatus) {
      parts.push(`- runStatus: ${ev.runMeta.runStatus}`)
      if (ev.runMeta.statusDetail) {
        parts.push(`  detail: ${ev.runMeta.statusDetail.slice(0, 300)}`)
      }
      if (ev.runMeta.runStatus !== "ok") {
        parts.push(
          `  NOTE: runStatus is not 'ok'. This run did not execute normally:` +
          ` the evaluator was NOT run against the work directory, and any` +
          ` criteria shown below are stubs carrying infraError — not real` +
          ` evaluations. See the "infraBlocked" section of your output format` +
          ` instructions for when to abstain on this kind of evidence.`,
        )
      }
    }
    parts.push(`- duration: ${ev.runMeta.durationMs}ms`)
    parts.push(`- tokens: in=${ev.runMeta.tokens.input} out=${ev.runMeta.tokens.output}`)
    if (ev.runMeta.skillLoaded === false) parts.push(`- WARNING: skill was not loaded`)
    if (ev.runMeta.adapterError) {
      const ae = ev.runMeta.adapterError
      parts.push(`- adapter error: exit ${ae.exitCode}`)
      if (ae.diagnosis) {
        parts.push(`  ${ae.diagnosis.summary}`)
        if (ae.diagnosis.hint) parts.push(`  ${ae.diagnosis.hint}`)
      } else {
        parts.push(`  stderr: ${ae.stderr.slice(0, 500)}`)
      }
    }
    parts.push("")
  }

  // Conversation — head + tail if over the limit
  parts.push(`## Conversation Log (${ev.conversationLog.length} entries)`)
  parts.push("")
  const log = ev.conversationLog
  if (log.length <= opts.maxConvLog) {
    for (let i = 0; i < log.length; i++) {
      parts.push(`### [${i}] ${log[i]!.type}`)
      parts.push("```json")
      parts.push(JSON.stringify(log[i], null, 2))
      parts.push("```")
    }
  } else {
    const head = Math.floor(opts.maxConvLog * 0.6)
    const tail = opts.maxConvLog - head
    for (let i = 0; i < head; i++) {
      parts.push(`### [${i}] ${log[i]!.type}`)
      parts.push("```json")
      parts.push(JSON.stringify(log[i], null, 2))
      parts.push("```")
    }
    parts.push("")
    parts.push(`... (${log.length - head - tail} entries elided) ...`)
    parts.push("")
    for (let i = log.length - tail; i < log.length; i++) {
      parts.push(`### [${i}] ${log[i]!.type}`)
      parts.push("```json")
      parts.push(JSON.stringify(log[i], null, 2))
      parts.push("```")
    }
  }
  parts.push("")

  if (ev.workDirSnapshot && ev.workDirSnapshot.files.size > 0) {
    const workdirPath = `.optimize/tasks/${group.safeId}/run-${run.localIndex}-workdir`
    parts.push(`## Work Directory (${ev.workDirSnapshot.files.size} files)`)
    parts.push("")
    parts.push(`Files are available under \`${workdirPath}/\`. Small files inlined below:`)
    parts.push("")
    for (const [filePath, content] of ev.workDirSnapshot.files) {
      if (content.length <= opts.maxFileInline) {
        parts.push(`### ${filePath}`)
        parts.push("```")
        parts.push(content)
        parts.push("```")
      } else {
        parts.push(`- ${filePath} (${content.length} chars — read \`${workdirPath}/${filePath}\`)`)
      }
    }
    parts.push("")
  }

  return parts.join("\n")
}

function renderHistoryMarkdown(history: HistoryEntry[]): string {
  const parts: string[] = []
  parts.push(`# Optimization History`)
  parts.push("")
  parts.push(`This skill has been optimized ${history.length} time(s) before. Do not repeat diagnoses that did not improve the score.`)
  parts.push("")
  for (const entry of history) {
    const status = entry.improved === null
      ? "pending"
      : entry.improved ? "IMPROVED" : "did NOT improve"
    parts.push(`## Round ${entry.round} — ${status}`)
    parts.push(`- timestamp: ${entry.timestamp}`)
    parts.push(`- confidence: ${entry.confidence.toFixed(2)}`)
    parts.push(`- train score: ${entry.trainScore === null ? "n/a" : entry.trainScore.toFixed(3)}`)
    if (entry.testScore !== null) {
      parts.push(`- test score: ${entry.testScore.toFixed(3)}`)
    }
    parts.push("")
    parts.push(`### Root Cause (diagnosed at the time)`)
    parts.push("")
    parts.push(entry.rootCause)
    parts.push("")
    parts.push(`### Changes`)
    parts.push("")
    parts.push(`Files changed: ${entry.changedFiles.join(", ")}`)
    const totalDelta = entry.changes.reduce(
      (sum, c) => sum + (typeof c.linesDelta === "number" ? c.linesDelta : 0),
      0,
    )
    const hasDelta = entry.changes.some((c) => typeof c.linesDelta === "number")
    if (hasDelta) {
      parts.push(`Net line delta this round: ${totalDelta >= 0 ? "+" : ""}${totalDelta}`)
    }
    parts.push("")
    for (const c of entry.changes) {
      const deltaSuffix = typeof c.linesDelta === "number"
        ? ` [Δ ${c.linesDelta >= 0 ? "+" : ""}${c.linesDelta}]`
        : ""
      parts.push(`- \`${c.file}\`${c.section ? ` (${c.section})` : ""}${deltaSuffix}: ${c.description}`)
      if (c.generality && c.generality.trim().length > 0) {
        parts.push(`  - generalized to: ${c.generality}`)
      }
    }
    parts.push("")
    parts.push(`### Reasoning`)
    parts.push("")
    parts.push(entry.reasoning)
    parts.push("")
  }
  return parts.join("\n")
}

function buildReadme(groups: TaskGroup[], historyCount: number): string {
  const taskCount = groups.length
  const runCount = groups.reduce((n, g) => n + g.runs.length, 0)
  const failing = groups.filter((g) => g.status === "FAILING").length
  const marginal = groups.filter((g) => g.status === "MARGINAL").length
  const passing = groups.filter((g) => g.status === "PASSING").length
  const tainted = groups.filter((g) => g.status === "TAINTED").length

  const dirListing = groups
    .map((g) => `  - \`tasks/${g.safeId}/\` — task \`${g.taskId}\` (${g.status}, ${g.runs.length} run${g.runs.length === 1 ? "" : "s"})`)
    .join("\n")

  return `# JIT-Optimize Workspace

Your current directory is a **complete copy of a skill folder**. You may freely
edit any file — SKILL.md, scripts, references, etc. — using your normal tools
(read, edit, write, glob, grep, bash). Your edits become the "optimized" version
of this skill.

## Where to find context

- \`.optimize/PER_TASK_SUMMARY.md\` — **READ THIS FIRST.** One row per task
  with status (FAILING / MARGINAL / PASSING / TAINTED), mean score, and
  where to find its evidence. This is the landscape you're working against.
  Counts right now: ${failing} FAILING, ${marginal} MARGINAL, ${passing} PASSING, ${tainted} TAINTED across ${taskCount} task(s) / ${runCount} run(s).
- \`.optimize/tasks/<safeTaskId>/\` — per-task directories. Each contains:
  - \`summary.md\` — the task's aggregate status and a per-run breakdown.
  - \`run-N.md\` — the full evidence for run N (conversation, criteria,
    run metadata). Files for multiple runs of the same task live in the
    same directory, so you can tell "task A failed twice the same way"
    apart from "two different tasks failed once each".
  - \`run-N.json\` — the same evidence in structured form.
  - \`run-N-workdir/\` — files the agent left in its work directory (if recorded).

  Directories for this session:
${dirListing}
${historyCount > 0 ? `- \`.optimize/history.md\` — **${historyCount} previous optimization round(s)** with their diagnoses, changes, and whether they improved the score. READ THIS before proposing changes — do not repeat diagnoses that did not work.\n` : ""}- \`.optimize/submission.template.json\` — the output format you must follow.

## What to do

1. Read \`PER_TASK_SUMMARY.md\`. Identify the FAILING and MARGINAL tasks —
   those are what you're here to fix — and the PASSING tasks — those are
   what you must **not** make worse.
2. Read the relevant \`tasks/<safeTaskId>/summary.md\` and \`run-N.md\` files
   in that order: failing first, marginal next, passing last (you read the
   passing ones only to understand what you must not break, not to fix them).
3. Read the relevant parts of this skill folder (SKILL.md is the entry point).
4. Edit files in this workspace to fix the root cause.
5. When done, write \`.optimize/submission.json\` with your structured summary
   (see \`submission.template.json\`).

## Rules

- **Task-content-agnostic**: the skill is used for MANY different tasks. Do
  NOT hard-code specific values, file names, or examples from the evidence
  into the skill. Fixes must generalize.
- **No task trade-off**: a fix that improves a FAILING task by regressing a
  PASSING task is NOT an improvement. The selection engine's per-task gate
  will reject the round. Before each edit, check \`PER_TASK_SUMMARY.md\` and
  ask "could this plausibly lower any PASSING task's score?" If yes, stop.
- **Preserve scope**: do not narrow the skill's capabilities to "just pass
  these tasks". You are fixing a tool, not overfitting to a test set.
- **Keep it concise**: every instruction the agent reads costs tokens and
  attention. Prefer trimming to adding.
- **Diagnose before prescribing**: the \`rootCause\` field in your submission
  is the *underlying problem you identified*, not a list of what you changed.
  Example of a bad rootCause: "Added a guardrail for empty input."
  Example of a good rootCause: "The skill tells the agent to call validate()
  but doesn't say what to do when validate() returns null, so the agent
  guessed wrong 5/5 times."

## If the skill is fine

If the evidence shows the skill is already working and no changes would help,
write \`{"noChanges": true}\` to submission.json and don't edit anything.

## If the evidence is infra-broken

Each \`run-N.md\` has a **Run Metadata** block whose first line is
\`runStatus: <value>\`. When that value is anything other than \`ok\` (e.g.
\`timeout\`, \`adapter-crashed\`, \`parse-failed\`, \`tainted\`), the run did not
execute normally: the agent subprocess was killed, crashed, or produced
unparseable output. The evaluator was NOT run against those runs — any
criteria you see on them are stubs carrying \`infraError\`, not real
evaluations.

If at least one run has \`runStatus !== 'ok'\` AND the remaining clean
evidence (if any) is insufficient to support a skill-level root cause, write:

\`\`\`json
{
  "infraBlocked": true,
  "blockedEvidenceIds": ["0", "2"],
  "blockedReason": "Runs with Evidence Index 0 and 2 both show runStatus=timeout with tokens=0; no LLM output was produced. The remaining clean runs are insufficient for a skill-level diagnosis."
}
\`\`\`

\`blockedEvidenceIds\` uses the **Evidence Indices** column in
\`PER_TASK_SUMMARY.md\` — the flat 0..N-1 numbering, independent of the
per-task directory layout.

\`infraBlocked\` and \`noChanges\` are mutually exclusive. \`noChanges\` says
"the skill is fine"; \`infraBlocked\` says "I cannot judge the skill from this
evidence." Pick the one that matches what you actually observed. Do not edit
any files when submitting \`infraBlocked\`.
`
}

// ---------------------------------------------------------------------------
// Diff computation
// ---------------------------------------------------------------------------

export interface WorkspaceDiff {
  added: string[]
  modified: string[]
  removed: string[]
}

/** Compute file-level diff between a workspace and the original skill directory. */
export async function computeDiff(workspaceDir: string, originalDir: string): Promise<WorkspaceDiff> {
  const wsFiles = new Map<string, string>()
  for await (const { rel, abs } of walkFiles(workspaceDir)) {
    if (rel.startsWith(".optimize/") || rel === ".optimize") continue
    try {
      wsFiles.set(rel, await Bun.file(abs).text())
    } catch {
      // unreadable → skip
    }
  }

  const origFiles = new Map<string, string>()
  for await (const { rel, abs } of walkFiles(originalDir)) {
    try {
      origFiles.set(rel, await Bun.file(abs).text())
    } catch {
      // unreadable → skip
    }
  }

  const added: string[] = []
  const modified: string[] = []
  const removed: string[] = []

  for (const [rel, content] of wsFiles) {
    const orig = origFiles.get(rel)
    if (orig === undefined) {
      added.push(rel)
    } else if (orig !== content) {
      modified.push(rel)
    }
  }
  for (const rel of origFiles.keys()) {
    if (!wsFiles.has(rel)) removed.push(rel)
  }

  return { added, modified, removed }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** Remove the .optimize/ scratch directory so the workspace contains only skill files. */
export async function stripOptimizeDir(workspaceDir: string): Promise<void> {
  await rm(path.join(workspaceDir, ".optimize"), { recursive: true, force: true })
}

export async function removeWorkspace(workspaceDir: string): Promise<void> {
  await rm(workspaceDir, { recursive: true, force: true })
}

/** Check whether a path exists. */
export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}
