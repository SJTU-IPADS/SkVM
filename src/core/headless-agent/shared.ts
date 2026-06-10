/**
 * Shared types + subprocess helper used by every driver in this folder.
 * One driver per file under `headless-agent/`; this module is where
 * cross-cutting concerns live.
 */

import type { TokenUsage, HeadlessAgentDriverName } from "../types.ts"
import { runSubprocess, type SubprocessResult } from "../subprocess.ts"

/**
 * Identifier for the concrete agent backend. Re-exports the canonical
 * schema-derived type so the union stays in sync with
 * `HeadlessAgentDriverSchema` automatically.
 */
export type HeadlessAgentDriver = HeadlessAgentDriverName

export interface HeadlessAgentRunOptions {
  /** Working directory the agent will operate in (its cwd). */
  cwd: string
  /** The prompt given to the agent. */
  prompt: string
  /**
   * SkVM-namespace model id, shaped as `<provider>/<model-id>` (the
   * `<provider>` prefix selects a route in `providers.routes`). The driver derives the
   * backend-namespace model id + any provider registration from the
   * matching `providers.routes` entry.
   */
  model: string
  /** Optional kill timeout. */
  timeoutMs?: number
  /** Driver selection; defaults to the system default driver. */
  driver?: HeadlessAgentDriver
  /**
   * If true (default), driver failure throws a HeadlessAgentError.
   * Set to false ONLY when the caller is prepared to interpret an empty /
   * partial result (e.g. a validator that expects some runs to crash).
   */
  throwOnError?: boolean
}

export interface HeadlessAgentRunResult {
  /** Process exit code (0 on success). Synthetic for in-process drivers. */
  exitCode: number
  /** Wall-clock duration in ms. */
  durationMs: number
  /** Whether the run was killed due to timeout. */
  timedOut: boolean
  /** USD cost extracted from the agent's structured output (0 if unavailable). */
  cost: number
  /** Token usage extracted from the agent's structured output. */
  tokens: TokenUsage
  /** Raw stdout from the agent (structured format depends on driver). */
  rawStdout: string
  /** Raw stderr. */
  rawStderr: string
  /** Driver that produced this result. */
  driver: HeadlessAgentDriver
}

/**
 * Thrown when a headless-agent driver fails (non-zero exit, timeout, or
 * library-mode throw). Infrastructure failure class.
 */
export class HeadlessAgentError extends Error {
  constructor(
    message: string,
    readonly driver: HeadlessAgentDriver,
    readonly exitCode: number,
    readonly timedOut: boolean,
    readonly stderr: string,
  ) {
    super(message)
    this.name = "HeadlessAgentError"
  }
}

export function isHeadlessAgentError(err: unknown): err is HeadlessAgentError {
  return err instanceof HeadlessAgentError
}

// ---------------------------------------------------------------------------
// Subprocess plumbing (used by opencode-driver; pi-driver is in-process)
// ---------------------------------------------------------------------------

/**
 * Run a driver subprocess via the shared `core/subprocess.ts` runner.
 *
 * On non-zero exit (or timeout), throws HeadlessAgentError unless the caller
 * opts out via `throwOnError: false`.
 */
export async function spawnDriverSubprocess(
  driver: HeadlessAgentDriver,
  cmd: string[],
  env: Record<string, string | undefined>,
  opts: { cwd: string; timeoutMs?: number; throwOnError?: boolean },
): Promise<SubprocessResult> {
  const result = await runSubprocess(cmd, { cwd: opts.cwd, timeoutMs: opts.timeoutMs, env })

  const throwOnError = opts.throwOnError ?? true
  if (throwOnError && (result.exitCode !== 0 || result.timedOut)) {
    const suffix = result.timedOut ? " (timed out)" : ""
    throw new HeadlessAgentError(
      `${driver} subprocess failed with exit=${result.exitCode}${suffix}: ${result.stderr.slice(0, 500) || "(no stderr)"}`,
      driver,
      result.exitCode,
      result.timedOut,
      result.stderr,
    )
  }
  return result
}
