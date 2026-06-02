/**
 * Per-round inspection — exposes the durable evidence record + optimizer
 * step record (introduced with PROPOSAL_SCHEMA_VERSION=1) through the CLI.
 *
 * Used by `skvm proposals show <id> --round=<n>`. Reads, never writes.
 */

import path from "node:path"
import { stat } from "node:fs/promises"
import { listRunDirs, readEvidenceRecord } from "../jit-optimize/record.ts"
import type { Evidence } from "../jit-optimize/types.ts"

export interface RoundShowResult {
  round: number
  proposalDir: string
  /** True when the proposal predates PROPOSAL_SCHEMA_VERSION=1; readers fall back to a header-only summary. */
  legacy: boolean
  text: string
}

export async function renderRoundShow(
  proposalDir: string,
  round: number,
): Promise<RoundShowResult> {
  const evidenceRoot = path.join(proposalDir, `round-${round}-evidence`)
  const optimizerDir = path.join(proposalDir, `round-${round}-optimizer`)

  const evidencePresent = await dirExists(evidenceRoot)
  const optimizerPresent = await dirExists(optimizerDir)
  if (!evidencePresent && !optimizerPresent) {
    return {
      round,
      proposalDir,
      legacy: true,
      text:
        `# Round ${round}\n` +
        `(no durable record found — this proposal likely predates schemaVersion=1)\n`,
    }
  }

  const parts: string[] = []
  parts.push(`# Round ${round}`)
  parts.push("")

  if (evidencePresent) {
    parts.push(...(await renderEvidenceSection(evidenceRoot)))
  } else {
    parts.push("## Evidence")
    parts.push("(no evidence directory — round was unscored or aborted)")
    parts.push("")
  }

  if (optimizerPresent) {
    parts.push(...(await renderOptimizerSection(optimizerDir)))
  } else if (round > 0) {
    parts.push("## Optimizer step")
    parts.push("(no optimizer record — round was baseline-only or schema is pre-v1)")
    parts.push("")
  }

  return {
    round,
    proposalDir,
    legacy: false,
    text: parts.join("\n"),
  }
}

async function renderEvidenceSection(evidenceRoot: string): Promise<string[]> {
  const runs = await listRunDirs(evidenceRoot)
  if (runs.length === 0) {
    return ["## Evidence", "(directory exists but no run records inside)", ""]
  }

  // Group by set for a stable, scan-friendly layout. listRunDirs preserves
  // filesystem (dirent) order, which is not deterministic across platforms,
  // so sort explicitly: sets by a fixed rank (train, test, then any others
  // alphabetically), runs within a set by (taskId-slug, runIdx) with the run
  // index compared NUMERICALLY so run10 sorts after run2.
  const bySet = new Map<string, Array<{ runDir: string; basename: string }>>()
  for (const { setLabel, runDir } of runs) {
    const arr = bySet.get(setLabel) ?? []
    arr.push({ runDir, basename: path.basename(runDir) })
    bySet.set(setLabel, arr)
  }
  for (const arr of bySet.values()) {
    arr.sort((a, b) => compareRunBasenames(a.basename, b.basename))
  }

  const out: string[] = ["## Evidence"]
  const setLabels = [...bySet.keys()].sort(compareSetLabels)
  for (const setLabel of setLabels) {
    const entries = bySet.get(setLabel)!
    out.push("")
    out.push(`### Set: ${setLabel} (${entries.length} run${entries.length === 1 ? "" : "s"})`)
    out.push("")
    out.push("| Run | Status | Score | Passed | Failed | Tokens (in/out) | Duration |")
    out.push("|-----|--------|-------|--------|--------|-----------------|----------|")
    for (const { runDir, basename } of entries) {
      // The run dir is created before its evidence.json is written, so an
      // interrupted/crashed session can leave a dir whose sidecar is missing
      // or corrupt. Inspecting exactly those sessions is a core use case —
      // surface an "unreadable" row instead of aborting the whole render.
      let ev: Evidence
      try {
        ev = await readEvidenceRecord(runDir)
      } catch {
        out.push(`| \`${basename}\` | unreadable | — | — | — | — | — |`)
        continue
      }
      out.push(formatEvidenceRow(basename, ev))
    }
  }
  out.push("")
  return out
}

/** Known sets first in a fixed order, then any others alphabetically. */
function compareSetLabels(a: string, b: string): number {
  const rank = (s: string) => (s === "train" ? 0 : s === "test" ? 1 : 2)
  const ra = rank(a)
  const rb = rank(b)
  return ra !== rb ? ra - rb : a.localeCompare(b)
}

/**
 * Order run-record basenames `{slug}-run{K}` by slug, then by K numerically
 * (so `...-run10` follows `...-run2`). Basenames that don't match the pattern
 * fall back to a plain lexicographic compare.
 */
function compareRunBasenames(a: string, b: string): number {
  const pa = parseRunBasename(a)
  const pb = parseRunBasename(b)
  if (pa && pb) {
    return pa.slug !== pb.slug ? pa.slug.localeCompare(pb.slug) : pa.runIdx - pb.runIdx
  }
  return a.localeCompare(b)
}

function parseRunBasename(basename: string): { slug: string; runIdx: number } | null {
  const m = /^(.*)-run(\d+)$/.exec(basename)
  if (!m) return null
  return { slug: m[1]!, runIdx: Number(m[2]) }
}

function formatEvidenceRow(basename: string, ev: Evidence): string {
  const criteria = ev.criteria ?? []
  const realCriteria = criteria.filter((c) => c.infraError === undefined)
  const passed = realCriteria.filter((c) => c.passed).length
  const failed = realCriteria.length - passed
  const score = realCriteria.length === 0
    ? "n/a"
    : (realCriteria.reduce((sum, c) => sum + c.score * c.weight, 0) /
        realCriteria.reduce((sum, c) => sum + c.weight, 0)).toFixed(3)
  const status = ev.runMeta?.runStatus ?? (realCriteria.length === 0 ? "tainted" : "ok")
  const tokens = ev.runMeta
    ? `${ev.runMeta.tokens.input}/${ev.runMeta.tokens.output}`
    : "—"
  const duration = ev.runMeta ? `${ev.runMeta.durationMs}ms` : "—"
  return `| \`${basename}\` | ${status} | ${score} | ${passed} | ${failed} | ${tokens} | ${duration} |`
}

async function renderOptimizerSection(optimizerDir: string): Promise<string[]> {
  const out: string[] = ["## Optimizer step"]
  out.push("")

  const submissionPath = path.join(optimizerDir, "submission.json")
  const submission = await tryReadJson(submissionPath)
  if (submission && typeof submission === "object") {
    const sub = submission as Record<string, unknown>
    if (sub.infraBlocked) {
      out.push("- status: **infra-blocked** (optimizer abstained)")
      if (typeof sub.blockedReason === "string") {
        out.push(`- blockedReason: ${sub.blockedReason}`)
      }
      if (Array.isArray(sub.blockedEvidenceIds) && sub.blockedEvidenceIds.length > 0) {
        out.push(`- blockedEvidenceIds: ${sub.blockedEvidenceIds.join(", ")}`)
      }
    } else if (sub.noChanges) {
      out.push("- status: **noChanges** (optimizer judged the skill fine as-is)")
    } else {
      out.push(`- confidence: ${typeof sub.confidence === "number" ? sub.confidence.toFixed(2) : "?"}`)
      if (Array.isArray(sub.changedFiles)) {
        out.push(`- changedFiles: ${sub.changedFiles.length === 0 ? "(none)" : sub.changedFiles.join(", ")}`)
      }
    }
    if (typeof sub.rootCause === "string" && sub.rootCause.length > 0) {
      out.push("")
      out.push("**rootCause:**")
      out.push("")
      out.push(sub.rootCause)
    }
  } else {
    out.push("- submission.json: missing or unreadable")
  }

  const diff = await tryReadJson(path.join(optimizerDir, "diff.json"))
  if (diff && typeof diff === "object") {
    const d = diff as Record<string, unknown>
    const counts = ["added", "modified", "removed"].map((k) => {
      const v = d[k]
      return `${k}=${Array.isArray(v) ? v.length : 0}`
    }).join(" ")
    out.push("")
    out.push(`**diff:** ${counts}`)
  }

  out.push("")
  out.push("Artifacts in optimizer dir:")
  for (const name of ["prompt.md", "submission.json", "diff.json", "stdout.log", "stderr.log", "optimize-context"]) {
    const present = await pathExists(path.join(optimizerDir, name))
    out.push(`- ${name}: ${present ? "✓" : "—"}`)
  }
  out.push("")
  return out
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p)
    return s.isDirectory()
  } catch {
    return false
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function tryReadJson(p: string): Promise<unknown> {
  try {
    return await Bun.file(p).json()
  } catch {
    return null
  }
}

