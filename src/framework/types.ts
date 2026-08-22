import type { Task, RunResult, EvalResult, EvalCriterion, AdapterConfig, AgentAdapter } from "../core/types.ts"

export type { Task, RunResult, EvalResult, EvalCriterion, AdapterConfig, AgentAdapter }

/**
 * Context passed to a custom evaluator's `run` hook.
 *
 * The criterion carries its own per-task `payload` (grade.py source, Docker
 * image tag, JSON config, …) that was populated at load time by the
 * evaluator's `loadPayload` hook via `hydrateEvalPayloads`. The evaluator's
 * `run` function is responsible for type-narrowing `payload` to whatever
 * shape it expects.
 */
export interface CustomEvalContext {
  criterion: Extract<EvalCriterion, { method: "custom" }>
  runResult: RunResult
  /**
   * Directory of the task definition (where task.json lives), when the
   * caller knows it. Lets evaluators reference grading assets that live
   * next to the task instead of inside the agent-visible workDir — e.g.
   * junit-grade's `testFileFrom: "task"` keeps test files and expected/
   * golden outputs hidden from the agent.
   */
  taskDir?: string
}

/**
 * Filesystem context for `checkIntegrity`. `taskDir` is where `task.json`
 * lives; `fixturesDir` is `<taskDir>/fixtures`, the subtree that gets copied
 * into the eval workDir before a run.
 */
export interface IntegrityCheckContext {
  taskDir: string
  fixturesDir: string
}

/**
 * Contract for a registered custom evaluator.
 *
 * Design notes:
 * - `run` returns everything EXCEPT `criterion`. The framework
 *   (`evaluateCustom` in `framework/evaluator.ts`) owns criterion attachment
 *   so that `id`, `name`, and `weight` declared on the task-level criterion
 *   always flow through. A custom evaluator that tries to fabricate its own
 *   criterion gets a compile error.
 * - `loadPayload` and `savePayload` are OPTIONAL sibling-file conventions.
 *   For evaluators whose payload fits comfortably inline in task.json (e.g.
 *   a small JSON config), both can be omitted and the payload round-trips
 *   through the JSON. For evaluators whose payload is large or better
 *   authored as a standalone file (e.g. `grade.py`), implement both and the
 *   loader/writer pair will move the payload in and out of the sidecar.
 * - `validatePayload` is OPTIONAL and runs at load time (inside
 *   `hydrateEvalPayloads`) after any sidecar hydration. Evaluators whose
 *   payload is structured (e.g. `junit-grade` with its declarative criteria
 *   list) should implement this to catch authoring errors before a task is
 *   ever run — failing fast saves LLM tokens on downstream bench runs. The
 *   hook MUST throw with a descriptive `Error` on invalid input; returning
 *   is treated as valid. Re-throwing `ZodError` is idiomatic.
 * - `checkIntegrity` is OPTIONAL and runs at load time after
 *   `hydrateEvalPayloads` for callers that opt in (currently only the
 *   jit-optimize synthetic task loader). It's for catching the class of
 *   authoring bug where the payload shape is valid but a required file on
 *   disk is missing — e.g. a `junit-grade` criterion whose `testFile` does
 *   not exist under `fixtures/`, or a `python-grade` criterion that was
 *   hydrated with no `grade.py` sibling. Returning `{ok:false, reason}`
 *   causes the caller to drop the task before it enters the evaluation
 *   batch instead of letting it run and score 0.
 */
export interface CustomEvaluator {
  run(ctx: CustomEvalContext): Promise<Omit<EvalResult, "criterion">>
  loadPayload?(taskDir: string): Promise<unknown | undefined>
  savePayload?(taskDir: string, payload: unknown): Promise<void>
  validatePayload?(payload: unknown): void
  checkIntegrity?(
    criterion: Extract<EvalCriterion, { method: "custom" }>,
    ctx: IntegrityCheckContext,
  ): Promise<{ ok: true } | { ok: false; reason: string }>
}

/**
 * Registry of custom evaluators. Bridges self-register at module load via
 * side-effect statements (see `src/bench/evaluators/python-grade.ts` for the
 * canonical pattern). The barrel at `src/bench/evaluators/index.ts` aggregates
 * every bridge so importing it guarantees every evaluator is registered
 * before any task loads.
 */
export const customEvaluators = new Map<string, CustomEvaluator>()

export function registerCustomEvaluator(id: string, evaluator: CustomEvaluator) {
  customEvaluators.set(id, evaluator)
}

/** Result of a full test run (task + evaluation) */
export interface TestResult {
  task: Task
  runResult: RunResult
  evalResults: EvalResult[]
  overallPass: boolean
  overallScore: number
  timestamp: string
}
