import { resolveTaskTimeout } from "./timeouts.ts"

/**
 * Resolve effective `timeoutMs` and `maxSteps` for a single task run.
 *
 * Precedence (highest first):
 *   1. Absolute CLI override (`overrides.timeoutMs` / `overrides.maxSteps`)
 *   2. Per-task value × multiplier (`task.timeoutMs * (overrides.timeoutMult ?? 1)`)
 *   3. Per-task value (when no multiplier)
 *
 * The multiplier branch is used by custom-plan YAML's group-level
 * `timeout-mult` (the CLI `--timeout-mult` flag no longer exists). Other
 * commands pass `timeoutMult` undefined, in which case rule (2) collapses to
 * rule (3). Timeout resolution itself is delegated to
 * `src/core/timeouts.ts::resolveTaskTimeout`.
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
  return {
    timeoutMs: resolveTaskTimeout({
      cli: overrides.timeoutMs,
      task: { timeoutMs: task.timeoutMs },
      multiplier: overrides.timeoutMult,
    }),
    maxSteps: overrides.maxSteps ?? task.maxSteps,
  }
}
