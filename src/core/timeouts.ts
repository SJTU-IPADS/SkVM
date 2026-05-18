import { TASK_FILE_DEFAULTS } from "./ui-defaults.ts"

/**
 * Built-in defaults per actor (ms). Single source of truth for "how long
 * should X reasonably take if the user hasn't said otherwise."
 *
 * - taskExec: target adapter solving one task (mirrors TASK_FILE_DEFAULTS so
 *   the schema default and the actor default stay synchronized).
 * - compiler: compiler Pass 1 (rewrite-skill) agent loop.
 * - optimizer: jit-optimize per-round skill rewriter.
 * - taskGen: jit-optimize synthetic task-generation agent.
 * - candidateGen: jit-boost candidate-extraction agent.
 * - syntheticTaskExec: default execution timeout for tasks synthesized by
 *   jit-optimize --task-source=synthetic. Higher than taskExec (300s vs 120s)
 *   because LLM-generated tasks are open-ended and frequently require more
 *   agent steps than curated bench tasks with bounded scopes.
 */
export const TIMEOUT_DEFAULTS = {
  taskExec:          TASK_FILE_DEFAULTS.timeoutMs,
  compiler:          300_000,
  optimizer:         600_000,
  taskGen:           900_000,
  candidateGen:      180_000,
  /** Default per-task execution timeout for LLM-synthesized tasks (ms). */
  syntheticTaskExec: 300_000,
} as const

/**
 * Resolve the effective timeout for one task-execution run.
 *
 * Precedence: CLI absolute > task.timeoutMs × multiplier > task.timeoutMs.
 * `multiplier` is sourced from custom-plan YAML's group-level `timeout-mult`
 * (the CLI `--timeout-mult` flag has been removed). When `cli` is given, the
 * multiplier is ignored — absolute beats relative.
 */
export function resolveTaskTimeout(opts: {
  cli?: number
  task: { timeoutMs: number }
  multiplier?: number
}): number {
  if (opts.cli !== undefined) return opts.cli
  return Math.round(opts.task.timeoutMs * (opts.multiplier ?? 1))
}

export function resolveCompilerTimeout(opts: { cli?: number }): number {
  return opts.cli ?? TIMEOUT_DEFAULTS.compiler
}

export function resolveOptimizerTimeout(opts: { cli?: number }): number {
  return opts.cli ?? TIMEOUT_DEFAULTS.optimizer
}

export function resolveTaskGenTimeout(opts: { cli?: number }): number {
  return opts.cli ?? TIMEOUT_DEFAULTS.taskGen
}

export function resolveCandidateGenTimeout(opts: { cli?: number }): number {
  return opts.cli ?? TIMEOUT_DEFAULTS.candidateGen
}

export function resolveSyntheticTaskTimeout(opts: { cli?: number }): number {
  return opts.cli ?? TIMEOUT_DEFAULTS.syntheticTaskExec
}
