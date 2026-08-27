/**
 * Verify a capability profile's cost block against the raw conversation logs.
 *
 * The profile's `cost` is an aggregate assembled through four layers (instance
 * → level → primitive → TCP). The conversation transcripts are an independent
 * record of the same calls. If the two disagree, one of them is wrong and no
 * number from that profile should be published.
 *
 * Two failure modes that must not be conflated:
 *
 * - A metric MISMATCH means the aggregate disagrees with the calls it is made
 *   of. The data is wrong; nothing from it is publishable.
 * - Incomplete COVERAGE means the provider omitted usage on some calls
 *   (observed: a gateway returning a response with no usage block at all).
 *   Those calls report zero tokens, so they perturb nothing except the count of
 *   provider-priced calls. The data is right; the dollar figure is a floor.
 *   Disclosable, not disqualifying — as long as the gap stays small enough to
 *   state.
 *
 * So mismatches always fail, while coverage fails only below `minCoverage`.
 */

import path from "node:path"
import { getProfileLogDir } from "../core/config.ts"
import type { TCP } from "../core/types.ts"

export interface ReconcileCheck {
  name: string
  profile: number
  logs: number
  diff: number
  ok: boolean
}

export interface ReconcileResult {
  ok: boolean
  model: string
  harness: string
  profiledAt: string
  logDir: string
  logFiles: number
  tolerance: number
  checks: ReconcileCheck[]
  coverage: {
    calls?: number
    callsWithCost?: number
    known: boolean
    complete: boolean
    ratio: number
    minCoverage: number
    acceptable: boolean
    costIsFloor: boolean
    logCalls: number
    logCallsWithCost: number
  }
  /** Serving fleet → call count, when the provider reports one. */
  servingBackends: Record<string, number>
  /** Set when reconciliation could not run at all (e.g. no transcripts on disk). */
  error?: string
}

interface LogTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
  calls: number
  callsWithCost: number
  backends: Record<string, number>
  files: number
  missingDir: boolean
}

function emptyLogTotals(): LogTotals {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0,
    calls: 0, callsWithCost: 0, backends: {}, files: 0, missingDir: false,
  }
}

/** Sum every `type: "response"` entry across a profile run's transcripts. */
async function sumConversationLogs(dir: string): Promise<LogTotals> {
  const totals = emptyLogTotals()
  const glob = new Bun.Glob("**/*.jsonl")
  let iter: AsyncIterable<string>
  try {
    iter = glob.scan({ cwd: dir, onlyFiles: true })
  } catch {
    totals.missingDir = true
    return totals
  }
  try {
    for await (const rel of iter) {
      totals.files++
      const text = await Bun.file(path.join(dir, rel)).text()
      for (const line of text.split("\n")) {
        if (!line.trim()) continue
        let entry: Record<string, unknown>
        try {
          entry = JSON.parse(line)
        } catch {
          continue // a truncated final line from an interrupted run
        }
        if (entry.type !== "response") continue
        const tokens = entry.tokens as Record<string, number> | undefined
        totals.calls++
        totals.input += tokens?.input ?? 0
        totals.output += tokens?.output ?? 0
        totals.cacheRead += tokens?.cacheRead ?? 0
        totals.cacheWrite += tokens?.cacheWrite ?? 0
        if (typeof entry.costUsd === "number") {
          totals.costUsd += entry.costUsd
          totals.callsWithCost++
        }
        // Providers that report a serving fleet write it here; the rest do not.
        const backend = typeof entry.servingProvider === "string" ? entry.servingProvider : "(unreported)"
        totals.backends[backend] = (totals.backends[backend] ?? 0) + 1
      }
    }
  } catch {
    // The directory disappeared mid-scan, or is not readable.
    totals.missingDir = totals.files === 0
  }
  return totals
}

function relDiff(a: number, b: number): number {
  const scale = Math.max(Math.abs(a), Math.abs(b))
  return scale === 0 ? 0 : Math.abs(a - b) / scale
}

/**
 * Which directory holds this profile's transcripts.
 *
 * `convLogDir` is recorded PER PRIMITIVE (`{runDir}/{primitiveId}`), so a
 * 26-primitive profile yields 26 distinct values — comparing the raw strings
 * meant the recorded location was never actually used, and every run silently
 * fell back to the shared per-(harness, model) directory, where stale
 * transcripts from an earlier run get summed in.
 */
export function resolveLogDir(tcp: TCP): string {
  const runDirs = new Set(
    tcp.details
      .map((d) => d.convLogDir)
      .filter((d): d is string => typeof d === "string" && d.length > 0)
      .map((d) => path.dirname(d)),
  )
  const only = [...runDirs]
  return only.length === 1 ? only[0]! : getProfileLogDir(tcp.harness, tcp.model)
}

export async function reconcileProfileCost(
  tcp: TCP,
  opts: { tolerance?: number; minCoverage?: number } = {},
): Promise<ReconcileResult> {
  const tolerance = opts.tolerance ?? 0.005
  const minCoverage = opts.minCoverage ?? 0.99
  const logDir = resolveLogDir(tcp)
  const logs = await sumConversationLogs(logDir)

  const profileTokens = tcp.cost.totalTokens
  const profileTotal = profileTokens.input + profileTokens.output + profileTokens.cacheRead + profileTokens.cacheWrite
  const logTotal = logs.input + logs.output + logs.cacheRead + logs.cacheWrite

  const checks: ReconcileCheck[] = [
    { name: "total tokens", profile: profileTotal, logs: logTotal, diff: relDiff(profileTotal, logTotal), ok: false },
    { name: "input tokens", profile: profileTokens.input, logs: logs.input, diff: relDiff(profileTokens.input, logs.input), ok: false },
    { name: "output tokens", profile: profileTokens.output, logs: logs.output, diff: relDiff(profileTokens.output, logs.output), ok: false },
    { name: "cache-read tokens", profile: profileTokens.cacheRead, logs: logs.cacheRead, diff: relDiff(profileTokens.cacheRead, logs.cacheRead), ok: false },
    { name: "cost usd", profile: tcp.cost.totalUsd, logs: logs.costUsd, diff: relDiff(tcp.cost.totalUsd, logs.costUsd), ok: false },
  ]
  for (const c of checks) c.ok = c.diff <= tolerance

  const calls = tcp.cost.llmCalls
  const callsWithCost = tcp.cost.llmCallsWithCost
  const known = calls !== undefined && callsWithCost !== undefined && calls > 0
  const complete = known && callsWithCost === calls
  const ratio = known ? callsWithCost! / calls! : 0
  const acceptable = known && ratio >= minCoverage

  // No transcripts at all cannot pass: a profile with nothing to check against
  // is unverified, and an empty log dir would otherwise agree with an empty
  // profile and report success.
  const error = logs.missingDir
    ? `no transcripts found under ${logDir} — nothing to reconcile against`
    : logs.files === 0
      ? `no .jsonl transcripts under ${logDir} — nothing to reconcile against`
      : undefined

  const mismatches = checks.filter((c) => !c.ok)
  const ok = error === undefined && mismatches.length === 0 && acceptable

  return {
    ok,
    model: tcp.model,
    harness: tcp.harness,
    profiledAt: tcp.profiledAt,
    logDir,
    logFiles: logs.files,
    tolerance,
    checks,
    coverage: {
      calls, callsWithCost, known, complete, ratio, minCoverage, acceptable,
      costIsFloor: acceptable && !complete,
      logCalls: logs.calls,
      logCallsWithCost: logs.callsWithCost,
    },
    servingBackends: logs.backends,
    ...(error ? { error } : {}),
  }
}

/** Human-readable rendering of a reconciliation result. */
export function formatReconcileResult(result: ReconcileResult, label: string): string {
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`
  const lines: string[] = []
  lines.push(`\nReconciling ${label}`)
  lines.push(`  profiled at : ${result.profiledAt}`)
  lines.push(`  transcripts : ${result.logFiles} file(s) under ${result.logDir}`)

  if (result.error) {
    lines.push(`\n  FAIL — ${result.error}\n`)
    return lines.join("\n")
  }

  lines.push(`\n  ${"metric".padEnd(20)} ${"profile".padStart(14)} ${"logs".padStart(14)}   diff`)
  for (const c of result.checks) {
    const mark = c.ok ? "ok " : "MISMATCH"
    const fmt = (n: number) => (c.name === "cost usd" ? `$${n.toFixed(6)}` : n.toLocaleString())
    lines.push(`  ${c.name.padEnd(20)} ${fmt(c.profile).padStart(14)} ${fmt(c.logs).padStart(14)}   ${pct(c.diff).padStart(7)}  ${mark}`)
  }

  const { calls, callsWithCost, known, complete, ratio, minCoverage, acceptable, costIsFloor } = result.coverage
  const coverageNote = !known
    ? "not reported (pre-coverage profile, or an adapter that does not report call counts)"
    : complete
      ? `${callsWithCost}/${calls} calls priced by the provider (complete)`
      : `${callsWithCost}/${calls} calls priced (${pct(ratio)}) — cost is a FLOOR`
  lines.push(`\n  cost coverage : ${coverageNote}`)
  lines.push(`  log coverage  : ${result.coverage.logCallsWithCost}/${result.coverage.logCalls} response entries carry a cost`)

  const backends = Object.entries(result.servingBackends).sort((a, b) => b[1] - a[1])
  lines.push(`  served by     : ${backends.map(([n, c]) => `${n} (${c})`).join(", ") || "(none recorded)"}`)
  if (backends.filter(([n]) => n !== "(unreported)").length > 1) {
    lines.push(`  NOTE: more than one serving backend — the cache split is not comparable across runs.`)
  }

  const mismatches = result.checks.filter((c) => !c.ok)
  if (mismatches.length > 0) {
    lines.push(`\n  FAIL — aggregate disagrees with the transcripts; do not publish numbers from this profile\n`)
  } else if (!acceptable) {
    lines.push(`\n  FAIL — cost coverage ${pct(ratio)} is below the ${(minCoverage * 100).toFixed(0)}% threshold\n`)
  } else if (costIsFloor) {
    lines.push(`\n  PASS (with caveat) — totals agree; ${calls! - callsWithCost!} unpriced call(s), so report cost as a floor\n`)
  } else {
    lines.push(`\n  PASS — profile agrees with its transcripts\n`)
  }
  return lines.join("\n")
}
