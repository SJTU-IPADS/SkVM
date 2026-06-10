/**
 * Shared run-level verdict for the CLI-wrapping adapters: translates the
 * subprocess outcome (timeout / non-zero exit) into the `finish()` fields
 * that beat any parser-level note, attaching the adapter's failure
 * diagnosis when the subprocess crashed. This is adapter knowledge — it
 * lives next to diagnose-failure.ts, not in core.
 */

import type { RunRecordFinishOptions } from "../core/run-record.ts"
import type { FailureDiagnosis } from "./diagnose-failure.ts"

export type SubprocessVerdict = Pick<
  RunRecordFinishOptions,
  "runStatus" | "statusDetail" | "adapterError"
>

export async function subprocessVerdict(opts: {
  /** Harness label used in verdict messages, e.g. "openclaw". */
  label: string
  /** Subject of the timeout message when it differs (hermes: "hermes chat"). */
  timeoutLabel?: string
  timedOut: boolean
  exitCode: number
  timeoutMs: number
  stderr: string
  /** Per-adapter diagnosis, attached on non-zero exit. */
  diagnose?: () => Promise<FailureDiagnosis | null | undefined>
  /** Sink for the diagnosis warning (the adapter's own log.warn). */
  warn?: (msg: string) => void
}): Promise<SubprocessVerdict> {
  const verdict: SubprocessVerdict = {}
  if (opts.timedOut) {
    verdict.runStatus = "timeout"
    verdict.statusDetail = `${opts.timeoutLabel ?? opts.label} subprocess killed after ${opts.timeoutMs}ms`
  } else if (opts.exitCode !== 0) {
    verdict.runStatus = "adapter-crashed"
    verdict.statusDetail = `${opts.label} exited with code ${opts.exitCode}`
  }
  if (opts.exitCode !== 0) {
    const adapterError: NonNullable<SubprocessVerdict["adapterError"]> = {
      exitCode: opts.exitCode,
      stderr: opts.stderr.slice(0, 2000),
    }
    const diagnosis = await opts.diagnose?.()
    if (diagnosis) {
      adapterError.diagnosis = diagnosis
      opts.warn?.(`${diagnosis.summary}${diagnosis.hint ? `\n  ${diagnosis.hint}` : ""}`)
    }
    verdict.adapterError = adapterError
  }
  return verdict
}
