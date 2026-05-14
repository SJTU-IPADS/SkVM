/**
 * Resolve effective `timeoutMs` and `maxSteps` for a single task run.
 *
 * Precedence (highest first):
 *   1. Absolute CLI override (`overrides.timeoutMs` / `overrides.maxSteps`)
 *   2. Per-task value × multiplier (`task.timeoutMs * (overrides.timeoutMult ?? 1)`)
 *   3. Per-task value (when no multiplier)
 *
 * The multiplier branch is used by `skvm bench`'s `--timeout-mult`. Other
 * commands pass `timeoutMult` undefined, in which case rule (2) collapses to
 * rule (3).
 */
export interface TaskRuntimeOverrides {
  timeoutMs?: number
  maxSteps?: number
  timeoutMult?: number
}

export interface ResolvedTaskRuntime {
  timeoutMs: number
  maxSteps: number
}

export function resolveTaskRuntime(
  task: { timeoutMs: number; maxSteps: number },
  overrides: TaskRuntimeOverrides = {},
): ResolvedTaskRuntime {
  const mult = overrides.timeoutMult ?? 1
  return {
    timeoutMs: overrides.timeoutMs ?? Math.round(task.timeoutMs * mult),
    maxSteps: overrides.maxSteps ?? task.maxSteps,
  }
}
