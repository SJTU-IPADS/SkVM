/**
 * Table rendering for `skvm proposals list`.
 *
 * Zero-dependency. Hand-written column alignment and ANSI coloring. The list
 * command loads each proposal's history.json (via `loadProposal`) to compute
 * baseline→best deltas — that's the whole point of this upgraded view, since
 * the plain meta.json line doesn't tell the user whether the proposal is
 * worth accepting.
 */

import type { LoadedProposal } from "./storage.ts"
import { summarizeProposal } from "./summary.ts"
import type { ProposalSummaryView } from "./summary.ts"
import { ANSI } from "../core/logger.ts"
import { formatElapsed } from "../core/spinner.ts"
import type { RunStatus } from "../jit-optimize/run-status.ts"

export interface ListRow {
  id: string
  status: string
  targetModel: string
  harness: string
  skill: string
  bestRound: number
  roundCount: number
  trainDelta: number | null
  testDelta: number | null
  hasTest: boolean
  summary: ProposalSummaryView
}

export function buildRow(p: LoadedProposal): ListRow {
  const summary = summarizeProposal(p)
  return {
    id: p.id,
    status: p.meta.status,
    targetModel: p.meta.targetModel,
    harness: p.meta.harness,
    skill: p.meta.skillName,
    bestRound: p.meta.bestRound,
    roundCount: p.meta.roundCount,
    trainDelta: summary.trainDelta,
    testDelta: summary.testDelta,
    hasTest: summary.best?.testScore != null,
    summary,
  }
}

// ---------------------------------------------------------------------------
// Sort / filter
// ---------------------------------------------------------------------------

export type SortKey = "recent" | "delta" | "skill" | "model"

export function sortRows(rows: ListRow[], key: SortKey): ListRow[] {
  const copy = rows.slice()
  switch (key) {
    case "recent":
      // Inputs are already newest-first from listProposals — keep stable.
      return copy
    case "delta":
      return copy.sort((a, b) => (b.trainDelta ?? -Infinity) - (a.trainDelta ?? -Infinity))
    case "skill":
      return copy.sort((a, b) => a.skill.localeCompare(b.skill) || a.targetModel.localeCompare(b.targetModel))
    case "model":
      return copy.sort((a, b) => a.targetModel.localeCompare(b.targetModel) || a.skill.localeCompare(b.skill))
  }
}

export function filterByMinDelta(rows: ListRow[], min: number): ListRow[] {
  return rows.filter((r) => (r.trainDelta ?? -Infinity) >= min)
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------


function paint(s: string, code: string, color: boolean): string {
  return color ? `${code}${s}${ANSI.reset}` : s
}

function formatDelta(delta: number | null, color: boolean): string {
  if (delta == null) return paint("——".padStart(7), ANSI.gray, color)
  const sign = delta >= 0 ? "+" : ""
  const text = `${sign}${delta.toFixed(3)}`.padStart(7)
  if (delta >= 0.05) return paint(text, ANSI.green, color)
  if (delta <= -0.02) return paint(text, ANSI.red, color)
  return paint(text, ANSI.yellow, color)
}

function formatStatus(status: string, color: boolean): string {
  const padded = status.padEnd(8)
  if (!color) return padded
  switch (status) {
    case "accepted": return paint(padded, ANSI.green, color)
    case "rejected": return paint(padded, ANSI.red, color)
    case "infra-blocked": return paint(padded, ANSI.gray, color)
    default: return padded
  }
}

/**
 * One-line header describing the execution phase of a detached run.
 * Returns null for proposals that lack a run-status.json (sync / legacy).
 */
export function formatRunPhaseLine(
  run: RunStatus | null,
  proposalDir: string,
  color: boolean,
): string | null {
  if (run === null) return null
  const start = Date.parse(run.startedAt)
  const ageSuffix = Number.isNaN(start) ? "" : ` (${formatElapsed(Date.now() - start)} ago)`
  switch (run.phase) {
    case "running":
      return paint(`run: RUNNING  pid=${run.pid}, started ${run.startedAt}${ageSuffix}`, ANSI.yellow, color)
    case "done":
      return paint(`run: DONE  finished ${run.finishedAt}`, ANSI.green, color)
    case "failed":
      return paint(`run: FAILED  finished ${run.finishedAt} — see ${proposalDir}/run.log`, ANSI.red, color)
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + "…"
}

interface Column {
  header: string
  width: number
  align: "left" | "right"
  render: (r: ListRow, color: boolean) => string
}

function computeColumns(rows: ListRow[]): Column[] {
  const idMax = Math.max(2, ...rows.map((r) => r.id.length))
  const modelMax = Math.max(5, ...rows.map((r) => r.targetModel.length))
  const skillMax = Math.max(5, ...rows.map((r) => r.skill.length))
  const harnessMax = Math.max(7, ...rows.map((r) => r.harness.length))

  return [
    {
      header: "status",
      width: 8,
      align: "left",
      render: (r, c) => formatStatus(r.status, c),
    },
    {
      header: "harness",
      width: Math.min(harnessMax, 12),
      align: "left",
      render: (r) => truncate(r.harness, 12).padEnd(Math.min(harnessMax, 12)),
    },
    {
      header: "target-model",
      width: Math.min(modelMax, 28),
      align: "left",
      render: (r) => truncate(r.targetModel, 28).padEnd(Math.min(modelMax, 28)),
    },
    {
      header: "skill",
      width: Math.min(skillMax, 28),
      align: "left",
      render: (r) => truncate(r.skill, 28).padEnd(Math.min(skillMax, 28)),
    },
    {
      header: "best",
      width: 5,
      align: "right",
      render: (r, c) => {
        const s = `r-${r.bestRound}`.padStart(5)
        return r.bestRound === 0 ? paint(s, ANSI.dim, c) : s
      },
    },
    {
      header: "Δtrain",
      width: 7,
      align: "right",
      render: (r, c) => formatDelta(r.trainDelta, c),
    },
    {
      header: "rounds",
      width: 6,
      align: "right",
      render: (r) => `${r.bestRound}/${r.roundCount}`.padStart(6),
    },
    {
      header: "id",
      width: Math.min(idMax, 80),
      align: "left",
      render: (r, c) => paint(truncate(r.id, 80), ANSI.dim, c),
    },
  ]
}

export function renderTable(rows: ListRow[], opts: { color: boolean }): string {
  if (rows.length === 0) return "No proposals found."
  const cols = computeColumns(rows)
  const out: string[] = []

  const header = cols
    .map((c) => {
      const h = c.header.padEnd(c.width)
      return opts.color ? `${ANSI.bold}${h}${ANSI.reset}` : h
    })
    .join("  ")
  out.push(header)

  for (const row of rows) {
    out.push(cols.map((c) => c.render(row, opts.color)).join("  "))
  }
  out.push("")
  out.push(`${rows.length} proposal(s)`)
  return out.join("\n")
}

// ---------------------------------------------------------------------------
// Group-by aggregation
// ---------------------------------------------------------------------------

export type GroupKey = "skill" | "model"

export interface GroupedRow {
  key: string
  count: number
  avgDelta: number | null
  wins: number
  losses: number
  noChange: number
}

export function aggregate(rows: ListRow[], groupBy: GroupKey): GroupedRow[] {
  const groups = new Map<string, ListRow[]>()
  for (const r of rows) {
    const k = groupBy === "skill" ? r.skill : r.targetModel
    const arr = groups.get(k) ?? []
    arr.push(r)
    groups.set(k, arr)
  }
  const out: GroupedRow[] = []
  for (const [key, items] of groups) {
    const deltas = items.map((r) => r.trainDelta).filter((d): d is number => d != null)
    const avgDelta = deltas.length === 0 ? null : deltas.reduce((a, b) => a + b, 0) / deltas.length
    const wins = items.filter((r) => (r.trainDelta ?? 0) >= 0.05).length
    const losses = items.filter((r) => (r.trainDelta ?? 0) <= -0.02).length
    const noChange = items.length - wins - losses
    out.push({ key, count: items.length, avgDelta, wins, losses, noChange })
  }
  out.sort((a, b) => (b.avgDelta ?? -Infinity) - (a.avgDelta ?? -Infinity))
  return out
}

export function renderGroupTable(
  groups: GroupedRow[],
  groupBy: GroupKey,
  opts: { color: boolean },
): string {
  if (groups.length === 0) return "No proposals found."
  const out: string[] = []
  const header = [
    (groupBy === "skill" ? "skill" : "target-model").padEnd(32),
    "count".padStart(6),
    "avgΔ".padStart(8),
    "wins".padStart(5),
    "losses".padStart(7),
    "flat".padStart(5),
  ].join("  ")
  out.push(opts.color ? `${ANSI.bold}${header}${ANSI.reset}` : header)
  for (const g of groups) {
    out.push(
      [
        truncate(g.key, 32).padEnd(32),
        String(g.count).padStart(6),
        formatDelta(g.avgDelta, opts.color),
        String(g.wins).padStart(5),
        String(g.losses).padStart(7),
        String(g.noChange).padStart(5),
      ].join("  "),
    )
  }
  out.push("")
  out.push(`${groups.length} ${groupBy}(s), ${groups.reduce((s, g) => s + g.count, 0)} proposal(s)`)
  return out.join("\n")
}

// ---------------------------------------------------------------------------
// Show-command helpers
// ---------------------------------------------------------------------------

export function renderShowSummary(p: LoadedProposal, opts: { color: boolean }): string {
  const s = summarizeProposal(p)
  const out: string[] = []

  out.push("")
  const hasTest = s.rounds.some((r) => r.testScore != null)
  const headerCols = hasTest
    ? ["round", "score", "test", "Δ", "pass", "cost", "changed"]
    : ["round", "score", "Δ", "pass", "cost", "changed"]
  out.push(opts.color ? `${ANSI.bold}rounds:${ANSI.reset}` : "rounds:")
  const headerLine = hasTest
    ? `  ${"round".padEnd(8)}  ${"train".padStart(6)}  ${"test".padStart(6)}  ${"Δ".padStart(7)}  ${"pass".padStart(7)}  ${"cost $".padStart(8)}  changed`
    : `  ${"round".padEnd(8)}  ${"train".padStart(6)}  ${"Δ".padStart(7)}  ${"pass".padStart(7)}  ${"cost $".padStart(8)}  changed`
  out.push(opts.color ? paint(headerLine, ANSI.dim, opts.color) : headerLine)
  for (const r of s.rounds) {
    const label = r.isBest
      ? paint(`r-${r.round}*`.padEnd(8), ANSI.green, opts.color)
      : r.isBaseline
        ? paint(`r-${r.round}`.padEnd(8), ANSI.dim, opts.color)
        : `r-${r.round}`.padEnd(8)
    const train = (r.trainScore == null ? "——" : r.trainScore.toFixed(3)).padStart(6)
    const test = (r.testScore == null ? "——" : r.testScore.toFixed(3)).padStart(6)
    const delta = formatDelta(r.isBaseline ? null : r.deltaVsBaseline, opts.color)
    const pass = `${r.trainPassed}/${r.trainTotal}`.padStart(7)
    const cost = `$${r.costTotalUsd.toFixed(3)}`.padStart(8)
    const files = r.changedFiles.length === 0 ? "" : r.changedFiles.join(", ")
    if (hasTest) {
      out.push(`  ${label}  ${train}  ${test}  ${delta}  ${pass}  ${cost}  ${truncate(files, 40)}`)
    } else {
      out.push(`  ${label}  ${train}  ${delta}  ${pass}  ${cost}  ${truncate(files, 40)}`)
    }
  }

  if (s.perTaskDeltas.length > 0) {
    out.push("")
    out.push(opts.color ? `${ANSI.bold}per-task at best round (vs baseline):${ANSI.reset}` : "per-task at best round (vs baseline):")
    const nameWidth = Math.max(
      20,
      ...s.perTaskDeltas.map((d) => d.taskId.length),
    )
    for (const d of s.perTaskDeltas) {
      const b = d.baseline == null ? "——" : d.baseline.toFixed(3)
      const best = d.best == null ? "——" : d.best.toFixed(3)
      const delta = formatDelta(d.delta, opts.color)
      out.push(`  ${d.taskId.padEnd(nameWidth)}  ${b.padStart(6)} → ${best.padStart(6)}  ${delta}`)
    }
  }

  if (s.bestRoundRootCause) {
    out.push("")
    out.push(opts.color ? `${ANSI.bold}best round root cause:${ANSI.reset}` : "best round root cause:")
    for (const line of wrap(s.bestRoundRootCause, 100)) out.push(`  ${line}`)
  }

  out.push("")
  out.push(
    opts.color
      ? paint(`total cost: $${s.totalCostUsd.toFixed(3)} (optimizer: $${s.totalOptimizerCostUsd.toFixed(3)})`, ANSI.dim, opts.color)
      : `total cost: $${s.totalCostUsd.toFixed(3)} (optimizer: $${s.totalOptimizerCostUsd.toFixed(3)})`,
  )
  return out.join("\n")
}

function wrap(s: string, width: number): string[] {
  const words = s.split(/\s+/)
  const lines: string[] = []
  let current = ""
  for (const w of words) {
    if (current.length === 0) {
      current = w
    } else if (current.length + 1 + w.length <= width) {
      current += " " + w
    } else {
      lines.push(current)
      current = w
    }
  }
  if (current) lines.push(current)
  return lines
}
