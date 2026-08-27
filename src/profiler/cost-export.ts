/**
 * Export profiling cost data as a CSV: one row per (model, harness, primitive),
 * aggregated across the levels that ran.
 *
 * Column choices worth knowing:
 *
 * - `model` and `harness` come from the TCP itself, as full ids. Profiling cost
 *   varies by nearly 20x across harnesses for the same model, so a row naming
 *   only the model is ambiguous, and same-named models from different providers
 *   would otherwise collide.
 * - `levels_run` reflects exactly the levels present in the TCP details (the
 *   profiler always runs L1-L3).
 * - `profiled_at` lets repeat runs of the same (model, harness) coexist in one
 *   file, so per-cell variance is computable.
 * - `total_tokens` sums every bucket. A provider reports `input` as the *fresh*
 *   prompt only, so a run served with a warm cache shifts tokens from `input` to
 *   `cache_read`, and an input+output total can swing by 3x between otherwise
 *   identical runs. The sum is the quantity that stays stable.
 * - `cost_source` says whether the provider priced every call, so a
 *   pricing-table fallback (or a $0) can never be read as a measurement.
 */

import type { TCP } from "../core/types.ts"

export const COST_CSV_HEADER =
  "model,harness,profiled_at,primitive,level,levels_run,templates_run,templates_skipped," +
  "duration_ms,duration_s,cost_usd,cost_source,llm_calls,llm_calls_with_cost," +
  "input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens"

/** Round to at most 6 decimals without trailing-zero noise. */
function usd(n: number): string {
  return String(Math.round(n * 1e6) / 1e6)
}

/**
 * How trustworthy a row's `cost_usd` is.
 *
 * - `measured`  — the provider priced every call. A level that made no calls at
 *                 all (every instance skipped by the environment gate) is also
 *                 measured: its $0 is a fact, not an absence of data.
 * - `partial`   — some calls were priced, some were not; the figure is a floor,
 *                 carrying only the priced calls.
 * - `estimated` — no call was priced; the figure came from the local pricing
 *                 table, or is $0 because the table had no entry.
 * - `unknown`   — coverage was not reported (a profile predating coverage
 *                 tracking, or an adapter that does not report call counts).
 */
function costSource(calls: number | undefined, withCost: number | undefined): string {
  if (calls === undefined || withCost === undefined) return "unknown"
  if (withCost === calls) return "measured"
  if (withCost === 0) return "estimated"
  return "partial"
}

/**
 * CSV-quote a field that could contain a comma or a quote. Model ids and harness
 * names are free-form strings; one comma in an id shifts every column after it,
 * silently, in a file whose whole purpose is being read by something else.
 */
function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export function profileCostCsv(tcps: TCP[]): string {
  const rows: string[] = [COST_CSV_HEADER]

  for (const tcp of tcps) {
    for (const d of tcp.details) {
      let durationMs = 0
      let costUsd = 0
      let input = 0
      let output = 0
      let cacheRead = 0
      let cacheWrite = 0
      let run = 0
      let skipped = 0
      let llmCalls: number | undefined
      let llmCallsWithCost: number | undefined
      const levelsRun: string[] = []

      for (const lr of d.levelResults) {
        levelsRun.push(lr.level)
        durationMs += lr.durationMs
        costUsd += lr.costUsd
        input += lr.tokens.input
        output += lr.tokens.output
        cacheRead += lr.tokens.cacheRead
        cacheWrite += lr.tokens.cacheWrite
        run += lr.totalCount - lr.skipCount
        skipped += lr.skipCount
        // Absent on pre-coverage profiles; summing only when present keeps
        // "not reported" distinct from a measured zero.
        if (lr.llmCalls !== undefined) llmCalls = (llmCalls ?? 0) + lr.llmCalls
        if (lr.llmCallsWithCost !== undefined) llmCallsWithCost = (llmCallsWithCost ?? 0) + lr.llmCallsWithCost
      }

      rows.push([
        csvField(tcp.model),
        csvField(tcp.harness),
        csvField(tcp.profiledAt),
        csvField(d.primitiveId),
        d.highestLevel,
        `"${levelsRun.join(",")}"`,
        String(run),
        String(skipped),
        String(Math.round(durationMs)),
        (durationMs / 1000).toFixed(1),
        usd(costUsd),
        costSource(llmCalls, llmCallsWithCost),
        llmCalls === undefined ? "" : String(llmCalls),
        llmCallsWithCost === undefined ? "" : String(llmCallsWithCost),
        String(input),
        String(output),
        String(cacheRead),
        String(cacheWrite),
        String(input + output + cacheRead + cacheWrite),
      ].join(","))
    }
  }

  return rows.join("\n") + "\n"
}
