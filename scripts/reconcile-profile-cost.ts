#!/usr/bin/env bun
/**
 * Verify a capability profile's cost block against the raw conversation logs.
 *
 * The profile's `cost` is an aggregate assembled through four layers (instance
 * -> level -> primitive -> TCP). The conversation transcripts are an
 * independent record of the same calls. If the two disagree, one of them is
 * wrong and no number from that profile should be published.
 *
 * This is the gate for the D5 profiling-cost measurement: run it after every
 * profile, and treat a mismatch as a failed run rather than a rounding quirk.
 *
 * Usage:
 *   bun run scripts/reconcile-profile-cost.ts --model=<id> --adapter=<name> [--json]
 *   bun run scripts/reconcile-profile-cost.ts --profile=<path/to/latest.json> [--json]
 *
 * Exit code is non-zero when the profile and its logs disagree beyond
 * --tolerance (default 0.5%), or when cost coverage is incomplete.
 */

import path from "node:path"
import { loadProfile } from "../src/profiler/index.ts"
import { getProfileLogDir, PROFILES_DIR } from "../src/core/config.ts"
import { TCPSchema, type TCP } from "../src/core/types.ts"
import { setLogLevel } from "../src/core/logger.ts"

interface LogTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
  calls: number
  callsWithCost: number
  providers: Record<string, number>
  files: number
}

function emptyLogTotals(): LogTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, calls: 0, callsWithCost: 0, providers: {}, files: 0 }
}

/** Sum every `type: "response"` entry across a profile run's transcripts. */
async function sumConversationLogs(dir: string): Promise<LogTotals> {
  const totals = emptyLogTotals()
  const glob = new Bun.Glob("**/*.jsonl")
  for await (const rel of glob.scan({ cwd: dir, onlyFiles: true })) {
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
      const provider = typeof entry.providerName === "string" ? entry.providerName : "(unreported)"
      totals.providers[provider] = (totals.providers[provider] ?? 0) + 1
    }
  }
  return totals
}

function relDiff(a: number, b: number): number {
  const scale = Math.max(Math.abs(a), Math.abs(b))
  return scale === 0 ? 0 : Math.abs(a - b) / scale
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`
}

async function main() {
  const args = new Map<string, string>()
  for (const arg of process.argv.slice(2)) {
    const [k, v = "true"] = arg.replace(/^--/, "").split("=")
    args.set(k!, v)
  }

  const asJson = args.get("json") === "true"
  const tolerance = Number(args.get("tolerance") ?? "0.005")

  // Loading a profile logs at info level to stdout, which would corrupt the
  // machine-readable contract. --json means JSON on stdout and nothing else.
  if (asJson) setLogLevel("error")

  let tcp: TCP | null = null
  let label = ""
  const profilePath = args.get("profile")
  if (profilePath) {
    tcp = TCPSchema.parse(await Bun.file(profilePath).json())
    label = profilePath
  } else {
    const model = args.get("model")
    const adapter = args.get("adapter") ?? "bare-agent"
    if (!model) {
      console.error("reconcile: pass --model=<id> [--adapter=<name>] or --profile=<path>")
      process.exit(2)
    }
    tcp = await loadProfile(model, adapter)
    label = `${model} -- ${adapter}`
    if (!tcp) {
      console.error(`reconcile: no cached profile for ${label} (looked under ${PROFILES_DIR})`)
      process.exit(2)
    }
  }

  // Conversation logs live under the profile run's log dir, keyed by the same
  // model/harness pair. Prefer the convLogDir recorded in the profile, since a
  // rerun would otherwise mix transcripts from different runs.
  const recordedDirs = [...new Set(tcp.details.map(d => d.convLogDir).filter((d): d is string => !!d))]
  const logDir = recordedDirs.length === 1
    ? path.dirname(recordedDirs[0]!)
    : getProfileLogDir(tcp.harness, tcp.model)

  const logs = await sumConversationLogs(logDir)

  const profileTokens = tcp.cost.totalTokens
  const profileTotal = profileTokens.input + profileTokens.output + profileTokens.cacheRead + profileTokens.cacheWrite
  const logTotal = logs.input + logs.output + logs.cacheRead + logs.cacheWrite

  const checks: Array<{ name: string; profile: number; logs: number; diff: number; ok: boolean }> = [
    { name: "total tokens", profile: profileTotal, logs: logTotal, diff: relDiff(profileTotal, logTotal), ok: false },
    { name: "input tokens", profile: profileTokens.input, logs: logs.input, diff: relDiff(profileTokens.input, logs.input), ok: false },
    { name: "output tokens", profile: profileTokens.output, logs: logs.output, diff: relDiff(profileTokens.output, logs.output), ok: false },
    { name: "cache-read tokens", profile: profileTokens.cacheRead, logs: logs.cacheRead, diff: relDiff(profileTokens.cacheRead, logs.cacheRead), ok: false },
    { name: "cost usd", profile: tcp.cost.totalUsd, logs: logs.costUsd, diff: relDiff(tcp.cost.totalUsd, logs.costUsd), ok: false },
  ]
  for (const c of checks) c.ok = c.diff <= tolerance

  // Coverage is reported by the profile itself; the logs corroborate it.
  const calls = tcp.cost.llmCalls
  const callsWithCost = tcp.cost.llmCallsWithCost
  const coverageKnown = calls !== undefined && callsWithCost !== undefined && calls > 0
  const coverageComplete = coverageKnown && callsWithCost === calls

  const mismatches = checks.filter(c => !c.ok)
  const ok = mismatches.length === 0 && coverageComplete

  if (asJson) {
    console.log(JSON.stringify({
      ok, label, model: tcp.model, harness: tcp.harness, profiledAt: tcp.profiledAt,
      logDir, logFiles: logs.files, tolerance,
      checks, coverage: { calls, callsWithCost, complete: coverageComplete, logCalls: logs.calls, logCallsWithCost: logs.callsWithCost },
      servingBackends: logs.providers,
    }, null, 2))
  } else {
    console.log(`\nReconciling ${label}`)
    console.log(`  profiled at : ${tcp.profiledAt}`)
    console.log(`  transcripts : ${logs.files} file(s) under ${logDir}`)
    console.log(`\n  ${"metric".padEnd(20)} ${"profile".padStart(14)} ${"logs".padStart(14)}   diff`)
    for (const c of checks) {
      const mark = c.ok ? "ok " : "MISMATCH"
      const fmt = (n: number) => (c.name === "cost usd" ? `$${n.toFixed(6)}` : n.toLocaleString())
      console.log(`  ${c.name.padEnd(20)} ${fmt(c.profile).padStart(14)} ${fmt(c.logs).padStart(14)}   ${pct(c.diff).padStart(7)}  ${mark}`)
    }
    console.log(`\n  cost coverage : ${coverageKnown ? `${callsWithCost}/${calls} calls priced by the provider` : "not reported (pre-coverage profile)"}`)
    console.log(`  log coverage  : ${logs.callsWithCost}/${logs.calls} response entries carry a cost`)
    const backends = Object.entries(logs.providers).sort((a, b) => b[1] - a[1])
    console.log(`  served by     : ${backends.map(([n, c]) => `${n} (${c})`).join(", ") || "(none recorded)"}`)
    if (backends.length > 1) {
      console.log(`  NOTE: more than one serving backend — the cache split is not comparable across runs.`)
      console.log(`        Pin SKVM_OPENROUTER_PROVIDER before a measurement run.`)
    }
    console.log(`\n  ${ok ? "PASS — profile agrees with its transcripts" : "FAIL — do not publish numbers from this profile"}\n`)
  }

  process.exit(ok ? 0 : 1)
}

await main()
