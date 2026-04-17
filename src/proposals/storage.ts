/**
 * Proposal storage — output of jit-optimize runs.
 *
 * Layout: {JIT_OPTIMIZE_DIR}/{harness}/{safeTargetModel}/{skillName}/{timestamp}/
 * where JIT_OPTIMIZE_DIR resolves to ~/.skvm/proposals/jit-optimize/ by default.
 *
 *   original/         — full copy of the original skill folder
 *   round-0/          — baseline (== original content)
 *   round-1/          — optimized after round 1 (full skill folder with bundle files)
 *   round-N/          — ...
 *   history.json      — HistoryEntry[] with bestRound + bestRoundReason
 *   analysis.md       — human-readable summary
 *   meta.json         — ProposalMeta (status, acceptedRound, ...)
 *   round-N-agent-logs/        — conversation logs from agent runs this round
 *   round-N-optimizer-logs/    — opencode NDJSON from the optimizer
 *
 * The model segment is the **target** model — the model the optimized skill
 * is tuned to run on. The optimizer model (the LLM that did the editing) is
 * recorded in meta.json but is intentionally NOT in the path: bench jit-optimized
 * lookups, locks, and CLI filters are all naturally target-keyed.
 *
 * Each round subdirectory is a full, usable skill folder (SKILL.md + any bundle files).
 */

import path from "node:path"
import { mkdir, readdir, stat, readFile } from "node:fs/promises"
import { tryAcquireFileLock, releaseFileLock } from "../core/file-lock.ts"
import { z } from "zod"
import { JIT_OPTIMIZE_DIR, safeModelName } from "../core/config.ts"
import {
  HistoryEntrySchema,
  RoundResultSchema,
} from "../jit-optimize/types.ts"
import type {
  HistoryEntry,
  RoundResult,
} from "../jit-optimize/types.ts"
import { copySkillDir } from "../core/fs-utils.ts"
import { createLogger } from "../core/logger.ts"

const log = createLogger("proposals")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const ProposalStatusSchema = z.enum(["pending", "accepted", "rejected", "infra-blocked"])
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>

export const SelectionConfigSchema = z.object({
  minImprovement: z.number(),
  epsilon: z.number(),
  convergenceThreshold: z.number(),
  // Optional for backward compat with proposals written before the
  // Layer 2 gate was introduced. Replay tooling falls back to
  // DEFAULT_PER_TASK_REGRESSION_TOLERANCE when absent; writers always
  // emit this field now so future sessions do not drift.
  perTaskRegressionTolerance: z.number().optional(),
  // Optional for backward compat with proposals written before the
  // cost-aware baseline gate was introduced. Replay tooling falls back
  // to DEFAULT_MIN_COST_REDUCTION_RATIO / minImprovement when absent.
  minCostReductionRatio: z.number().optional(),
  scoreEquivalenceBand: z.number().optional(),
})
export type SelectionConfig = z.infer<typeof SelectionConfigSchema>

export const ProposalMetaSchema = z.object({
  skillName: z.string(),
  skillDir: z.string(),
  harness: z.string(),
  optimizerModel: z.string(),
  targetModel: z.string(),
  source: z.string(),
  timestamp: z.string(),
  status: ProposalStatusSchema,
  acceptedRound: z.number().nullable(),
  bestRound: z.number(),
  bestRoundReason: z.string(),
  roundCount: z.number(),
  blockedReason: z.string().optional(),
  blockedEvidenceIds: z.array(z.string()).optional(),
  /**
   * Thresholds the selection engine used when picking bestRound. Absent on
   * proposals finalized before the pickBestRound hardening; historical
   * replay scripts treat that case as "legacy permissive selection".
   */
  selectionConfig: SelectionConfigSchema.optional(),
  /**
   * Rounds kicked out by the per-task regression gate in `pickBestRound`.
   * Keyed by round number (as string in JSON), value is a human-readable
   * reason citing the regressed taskId and the observed drop. Empty or
   * absent when nothing was excluded. Consumed by audit / replay tooling
   * and surfaced in analysis.md in a future doc pass.
   */
  excludedRounds: z.record(z.string(), z.string()).optional(),
})
export type ProposalMeta = z.infer<typeof ProposalMetaSchema>

export const ProposalHistoryFileSchema = z.object({
  entries: z.array(HistoryEntrySchema),
  bestRound: z.number(),
  bestRoundReason: z.string(),
  /**
   * Full per-round snapshot (scores, token/cost buckets, baseline flag).
   * Present on proposals finalized after the pickBestRound hardening —
   * optional for forward compatibility with legacy history.json files that
   * only carry `entries`. Replay tooling treats a missing `rounds` as
   * "legacy proposal, can only replay selection from HistoryEntry scores".
   */
  rounds: z.array(RoundResultSchema).optional(),
})
export type ProposalHistoryFile = z.infer<typeof ProposalHistoryFileSchema>

export interface CreateProposalOptions {
  skillName: string
  skillDir: string
  harness: string
  optimizerModel: string
  targetModel: string
  source: string
}

export interface CreateProposalResult {
  id: string
  dir: string
  meta: ProposalMeta
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function skillProposalsDir(harness: string, targetModel: string, skillName: string): string {
  return path.join(JIT_OPTIMIZE_DIR, harness, safeModelName(targetModel), skillName)
}

export function proposalDirFromId(id: string): string {
  return path.join(JIT_OPTIMIZE_DIR, id)
}

function makeProposalId(harness: string, targetModel: string, skillName: string, timestamp: string): string {
  return path.join(harness, safeModelName(targetModel), skillName, timestamp)
}

function tsString(d: Date = new Date()): string {
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0")
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
       + `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
       + `${pad(d.getUTCMilliseconds(), 3)}Z`
}

// ---------------------------------------------------------------------------
// Create proposal — called by the loop runner before any round runs.
// Persists the original skill folder and writes initial meta.json.
// ---------------------------------------------------------------------------

export async function createProposal(opts: CreateProposalOptions): Promise<CreateProposalResult> {
  // Collision-safe directory creation: tsString gives ms precision, but
  // concurrent detached workers can still hit the same ms. mkdir without
  // `recursive` lets EEXIST surface; we retry with -1, -2, ... suffix so
  // each worker ends up with a distinct dir.
  const parentDir = skillProposalsDir(opts.harness, opts.targetModel, opts.skillName)
  await mkdir(parentDir, { recursive: true })
  const baseTimestamp = tsString()
  let timestamp = baseTimestamp
  let dir = path.join(parentDir, timestamp)
  let suffix = 0
  while (true) {
    try {
      await mkdir(dir)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      suffix += 1
      if (suffix > 100) {
        throw new Error(`createProposal: ${suffix - 1} consecutive timestamp collisions in ${parentDir}`)
      }
      timestamp = `${baseTimestamp}-${suffix}`
      dir = path.join(parentDir, timestamp)
    }
  }

  // Copy original skill folder to proposal/original/
  await copySkillDir(opts.skillDir, path.join(dir, "original"))

  const meta: ProposalMeta = {
    skillName: opts.skillName,
    skillDir: path.resolve(opts.skillDir),
    harness: opts.harness,
    optimizerModel: opts.optimizerModel,
    targetModel: opts.targetModel,
    source: opts.source,
    timestamp,
    status: "pending",
    acceptedRound: null,
    bestRound: 0,
    bestRoundReason: "",
    roundCount: 0,
  }

  await Bun.write(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2))

  const id = makeProposalId(opts.harness, opts.targetModel, opts.skillName, timestamp)
  log.info(`Created proposal ${id}`)
  return { id, dir, meta }
}

// ---------------------------------------------------------------------------
// Persist a single round's skill folder — called by the loop runner.
// The round directory name is "round-N" under the proposal directory.
// ---------------------------------------------------------------------------

export async function persistRound(
  proposalDir: string,
  round: number,
  skillFolderSrc: string,
): Promise<string> {
  const roundDir = path.join(proposalDir, `round-${round}`)
  await copySkillDir(skillFolderSrc, roundDir)
  return roundDir
}

// ---------------------------------------------------------------------------
// Finalize — write history.json, analysis.md, and update meta.json.
// Called by the loop runner after all rounds + best-round selection.
// ---------------------------------------------------------------------------

export interface FinalizeProposalOptions {
  bestRound: number
  bestRoundReason: string
  history: HistoryEntry[]
  rounds: RoundResult[]
  /**
   * Override the status written to meta.json. Defaults to "pending".
   * When "infra-blocked", callers should also pass `blockedReason` /
   * `blockedEvidenceIds` so the bench-side skip logic can cite them.
   */
  status?: ProposalStatus
  blockedReason?: string
  blockedEvidenceIds?: string[]
  /** Selection thresholds used for this session (persisted for audit / replay). */
  selectionConfig?: SelectionConfig
  /**
   * Rounds kicked out by the per-task regression gate in `pickBestRound`.
   * Keys are round numbers; values are reasons. Empty object is a legit
   * "nothing excluded" signal; `undefined` means "not yet tracked" and
   * the field is omitted from meta.json entirely.
   */
  excludedRounds?: Record<number, string>
}

export async function finalizeProposal(
  proposalDir: string,
  opts: FinalizeProposalOptions,
): Promise<void> {
  // history.json — persist the full round snapshot so replay tooling can
  // rerun pickBestRound / avgScoreByTask offline without re-executing
  // tasks. historyEntry is blanked out because the canonical copy lives
  // in `entries`; the schema allows it as any-nullable so replay
  // consumers re-merge by round number if they need it.
  const historyFile: ProposalHistoryFile = {
    entries: opts.history,
    bestRound: opts.bestRound,
    bestRoundReason: opts.bestRoundReason,
    rounds: opts.rounds.map((r) => ({ ...r, historyEntry: null })),
  }
  await Bun.write(
    path.join(proposalDir, "history.json"),
    JSON.stringify(historyFile, null, 2),
  )

  // analysis.md
  await Bun.write(
    path.join(proposalDir, "analysis.md"),
    renderAnalysis(opts.history, opts.rounds, opts.bestRound, opts.bestRoundReason),
  )

  // Update meta.json
  const metaPath = path.join(proposalDir, "meta.json")
  const meta = ProposalMetaSchema.parse(JSON.parse(await readFile(metaPath, "utf-8")))
  meta.bestRound = opts.bestRound
  meta.bestRoundReason = opts.bestRoundReason
  meta.roundCount = opts.rounds.length
  if (opts.status) meta.status = opts.status
  if (opts.blockedReason !== undefined) meta.blockedReason = opts.blockedReason
  if (opts.blockedEvidenceIds !== undefined) meta.blockedEvidenceIds = opts.blockedEvidenceIds
  if (opts.selectionConfig !== undefined) meta.selectionConfig = opts.selectionConfig
  if (opts.excludedRounds !== undefined && Object.keys(opts.excludedRounds).length > 0) {
    // Stringify round-number keys for the on-disk schema — JSON keys are
    // always strings, so store it that way explicitly rather than relying
    // on silent coercion.
    const stringified: Record<string, string> = {}
    for (const [k, v] of Object.entries(opts.excludedRounds)) stringified[String(k)] = v
    meta.excludedRounds = stringified
  }
  await Bun.write(metaPath, JSON.stringify(meta, null, 2))
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAnalysis(
  history: HistoryEntry[],
  rounds: RoundResult[],
  bestRound: number,
  bestRoundReason: string,
): string {
  const parts: string[] = []
  parts.push(`# Optimization Analysis`)
  parts.push("")
  parts.push(`## Best Round`)
  parts.push("")
  parts.push(`**Round ${bestRound}** — ${bestRoundReason}`)
  parts.push("")

  const hasTest = rounds.some((r) => r.testScore !== null)

  parts.push(`## Round Summary`)
  parts.push("")
  if (hasTest) {
    parts.push(`| Round | Train Score | Train Pass | Test Score | Test Pass | Target Agent (tokens / $) | Eval Judge (tokens / $) | Optimizer (tokens / $) |`)
    parts.push(`|------:|------------:|-----------:|-----------:|----------:|--------------------------:|------------------------:|-----------------------:|`)
  } else {
    parts.push(`| Round | Train Score | Train Pass | Target Agent (tokens / $) | Eval Judge (tokens / $) | Optimizer (tokens / $) |`)
    parts.push(`|------:|------------:|-----------:|--------------------------:|------------------------:|-----------------------:|`)
  }
  const fmtBucket = (tokens: { input: number; output: number }, costUsd: number): string =>
    `${tokens.input + tokens.output} / $${costUsd.toFixed(4)}`
  for (const r of rounds) {
    const trainScore = r.trainScore === null ? "n/a" : r.trainScore.toFixed(3)
    const trainPass = `${r.trainPassed}/${r.trainTotal}`
    const ta = fmtBucket(r.targetAgent.tokens, r.targetAgent.costUsd)
    const ej = fmtBucket(r.evalJudge.tokens, r.evalJudge.costUsd)
    const opt = r.optimizer ? fmtBucket(r.optimizer.tokens, r.optimizer.costUsd) : "—"
    const label = `${r.round}${r.isBaseline ? " (baseline)" : ""}`
    if (hasTest) {
      const testScore = r.testScore === null ? "n/a" : r.testScore.toFixed(3)
      const testPass = `${r.testPassed}/${r.testTotal}`
      parts.push(`| ${label} | ${trainScore} | ${trainPass} | ${testScore} | ${testPass} | ${ta} | ${ej} | ${opt} |`)
    } else {
      parts.push(`| ${label} | ${trainScore} | ${trainPass} | ${ta} | ${ej} | ${opt} |`)
    }
  }
  parts.push("")

  if (history.length > 0) {
    parts.push(`## Optimization Rounds`)
    parts.push("")
    for (const entry of history) {
      parts.push(`### Round ${entry.round}`)
      parts.push("")
      parts.push(`- timestamp: ${entry.timestamp}`)
      parts.push(`- confidence: ${entry.confidence.toFixed(2)}`)
      parts.push(`- train score: ${entry.trainScore === null ? "n/a" : entry.trainScore.toFixed(3)}`)
      if (entry.testScore !== null) {
        parts.push(`- test score: ${entry.testScore.toFixed(3)}`)
      }
      parts.push(`- improved: ${entry.improved === null ? "n/a" : entry.improved ? "yes" : "no"}`)
      parts.push(`- files changed: ${entry.changedFiles.length > 0 ? entry.changedFiles.join(", ") : "(none)"}`)
      parts.push("")
      parts.push(`**Root cause:** ${entry.rootCause || "(not provided)"}`)
      parts.push("")
      if (entry.reasoning) {
        parts.push(`**Reasoning:**`)
        parts.push("")
        parts.push(entry.reasoning)
        parts.push("")
      }
      if (entry.changes.length > 0) {
        parts.push(`**Changes:**`)
        parts.push("")
        for (const c of entry.changes) {
          parts.push(`- \`${c.file}\`${c.section ? ` (${c.section})` : ""}: ${c.description}`)
        }
        parts.push("")
      }
    }
  }
  return parts.join("\n")
}

// ---------------------------------------------------------------------------
// List / Show / Accept / Reject
// ---------------------------------------------------------------------------

export interface ProposalSummary {
  id: string
  meta: ProposalMeta
}

export interface ListFilter {
  harness?: string
  targetModel?: string
  skillName?: string
  status?: ProposalStatus
}

export async function listProposals(filter: ListFilter = {}): Promise<ProposalSummary[]> {
  const root = JIT_OPTIMIZE_DIR
  const out: ProposalSummary[] = []

  const safeFilter = {
    harness: filter.harness,
    targetModel: filter.targetModel ? safeModelName(filter.targetModel) : undefined,
    skillName: filter.skillName,
    status: filter.status,
  }

  async function readIfMeta(dir: string, id: string) {
    try {
      const raw = await readFile(path.join(dir, "meta.json"), "utf-8")
      const parsed = ProposalMetaSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) return
      if (safeFilter.status && parsed.data.status !== safeFilter.status) return
      out.push({ id, meta: parsed.data })
    } catch {
      // skip
    }
  }

  async function walk(level: "harness" | "model" | "skill" | "timestamp", base: string, prefix: string) {
    let entries: import("node:fs").Dirent[]
    try {
      entries = await readdir(base, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const name = entry.name
      const full = path.join(base, name)
      const id = prefix ? `${prefix}/${name}` : name

      if (level === "harness") {
        if (safeFilter.harness && name !== safeFilter.harness) continue
        await walk("model", full, id)
      } else if (level === "model") {
        if (safeFilter.targetModel && name !== safeFilter.targetModel) continue
        await walk("skill", full, id)
      } else if (level === "skill") {
        if (safeFilter.skillName && name !== safeFilter.skillName) continue
        await walk("timestamp", full, id)
      } else {
        await readIfMeta(full, id)
      }
    }
  }

  await walk("harness", root, "")
  out.sort((a, b) => (a.meta.timestamp < b.meta.timestamp ? 1 : -1))
  return out
}

export interface LoadedProposal {
  id: string
  dir: string
  meta: ProposalMeta
  history: ProposalHistoryFile | null
  analysis: string
}

export async function loadProposal(id: string): Promise<LoadedProposal> {
  const dir = proposalDirFromId(id)
  const metaRaw = await readFile(path.join(dir, "meta.json"), "utf-8")
  const meta = ProposalMetaSchema.parse(JSON.parse(metaRaw))

  let history: ProposalHistoryFile | null = null
  try {
    const raw = await readFile(path.join(dir, "history.json"), "utf-8")
    history = ProposalHistoryFileSchema.parse(JSON.parse(raw))
  } catch {
    // history.json may not exist yet
  }

  let analysis = ""
  try {
    analysis = await readFile(path.join(dir, "analysis.md"), "utf-8")
  } catch {
    // analysis.md may not exist yet
  }

  return { id, dir, meta, history, analysis }
}

/**
 * Read the SKILL.md of a specific round inside a proposal.
 * Returns null if the round directory or SKILL.md is missing.
 */
export async function readRoundSkillContent(
  proposalDir: string,
  round: number,
): Promise<string | null> {
  const file = path.join(proposalDir, `round-${round}`, "SKILL.md")
  try {
    return await Bun.file(file).text()
  } catch {
    return null
  }
}

/** Path to a round directory inside a proposal, for readers that need bundle files. */
export function roundDirPath(proposalDir: string, round: number): string {
  return path.join(proposalDir, `round-${round}`)
}

export async function updateStatus(
  id: string,
  status: ProposalStatus,
  acceptedRound?: number,
): Promise<void> {
  const dir = proposalDirFromId(id)
  const metaPath = path.join(dir, "meta.json")
  const raw = await readFile(metaPath, "utf-8")
  const meta = ProposalMetaSchema.parse(JSON.parse(raw))
  // `infra-blocked` is a terminal status set by the loop when evidence was
  // infra-broken. Accepting one would serve a round whose skill content is
  // just a copy of the original (bestRound=0) as if it were an optimization.
  // Refuse the transition so operators fix the infra and rerun instead.
  if (meta.status === "infra-blocked" && status === "accepted") {
    throw new Error(
      `Proposal ${id} is infra-blocked — accepting it would serve round-0 as a real optimization. ` +
      `Rerun jit-optimize after fixing the underlying infra issue.`,
    )
  }
  meta.status = status
  meta.acceptedRound = status === "accepted" ? (acceptedRound ?? meta.bestRound) : null
  await Bun.write(metaPath, JSON.stringify(meta, null, 2))
  log.info(`Proposal ${id} → ${status}${status === "accepted" ? ` (round ${meta.acceptedRound})` : ""}`)
}

// ---------------------------------------------------------------------------
// Latest-best lookup — used by bench's jit-optimized condition
// ---------------------------------------------------------------------------

export type LatestProposalState = "has-usable" | "only-blocked" | "none"

export interface LatestProposalLookup {
  state: LatestProposalState
  /** Absolute path to the latest usable proposal's best-round directory; set iff state === 'has-usable'. */
  bestDir?: string
}

/**
 * Walk the proposal tree for `(harness, targetModel, skillName)` newest-first
 * and classify the result in one pass. Proposals whose
 * `meta.json.status === 'infra-blocked'` are skipped and noted so bench's
 * jit-optimized condition can fall through to an older non-blocked proposal,
 * or distinguish "nothing at all" (operator bug → throw) from "only blocked"
 * (graceful skip).
 */
export async function lookupLatestProposal(
  harness: string,
  targetModel: string,
  skillName: string,
): Promise<LatestProposalLookup> {
  const skillDir = skillProposalsDir(harness, targetModel, skillName)
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(skillDir, { withFileTypes: true })
  } catch {
    return { state: "none" }
  }
  const timestamps = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse()

  let sawBlocked = false
  for (const ts of timestamps) {
    const proposalDir = path.join(skillDir, ts)
    try {
      const meta = ProposalMetaSchema.parse(
        JSON.parse(await readFile(path.join(proposalDir, "meta.json"), "utf-8")),
      )
      if (meta.status === "infra-blocked") {
        sawBlocked = true
        continue
      }
      const bestDir = path.join(proposalDir, `round-${meta.bestRound}`)
      if (await dirExists(bestDir)) return { state: "has-usable", bestDir }
    } catch {
      continue
    }
  }
  return { state: sawBlocked ? "only-blocked" : "none" }
}

/**
 * Find the latest usable proposal's best-round directory. Returns null if
 * none exists (either because no proposals exist at all or all are
 * infra-blocked). Callers that need to distinguish those two cases should
 * use `lookupLatestProposal` directly.
 */
export async function getLatestBestRoundDir(
  harness: string,
  targetModel: string,
  skillName: string,
): Promise<string | null> {
  const { state, bestDir } = await lookupLatestProposal(harness, targetModel, skillName)
  return state === "has-usable" ? bestDir! : null
}

/**
 * Classify what `getLatestBestRoundDir` would return for a given tuple. Lets
 * bench's `runJitOptimized` distinguish "no proposals at all" (operator bug,
 * should throw) from "only infra-blocked proposals" (graceful skip with a
 * visible note in report.md).
 */
export async function describeLatestProposalState(
  harness: string,
  targetModel: string,
  skillName: string,
): Promise<LatestProposalState> {
  const { state } = await lookupLatestProposal(harness, targetModel, skillName)
  return state
}

// ---------------------------------------------------------------------------
// Lock helpers — thin wrappers over src/core/file-lock.ts
// ---------------------------------------------------------------------------

// 30 min is a crash-recovery ceiling, not a run-length ceiling: a live
// jit-optimize process refreshes the lock file's mtime every OPTIMIZE_LOCK_HEARTBEAT_MS,
// so only abandoned locks can trip the staleness check. Optimize runs with
// many rounds routinely exceed 30 minutes and must not be stolen mid-run.
const OPTIMIZE_LOCK_STALE_MS = 30 * 60 * 1000
const OPTIMIZE_LOCK_HEARTBEAT_MS = 5 * 60 * 1000

function lockPath(harness: string, targetModel: string, skillName: string): string {
  return path.join(skillProposalsDir(harness, targetModel, skillName), ".optimize.lock")
}

export async function acquireOptimizeLock(
  harness: string,
  targetModel: string,
  skillName: string,
): Promise<boolean> {
  const file = lockPath(harness, targetModel, skillName)
  await mkdir(path.dirname(file), { recursive: true })
  return tryAcquireFileLock(file, {
    staleMs: OPTIMIZE_LOCK_STALE_MS,
    heartbeatMs: OPTIMIZE_LOCK_HEARTBEAT_MS,
  })
}

export async function releaseOptimizeLock(
  harness: string,
  targetModel: string,
  skillName: string,
): Promise<void> {
  releaseFileLock(lockPath(harness, targetModel, skillName))
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p)
    return s.isDirectory()
  } catch {
    return false
  }
}
