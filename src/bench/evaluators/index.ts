/**
 * Evaluator barrel.
 *
 * Adding a new custom evaluator is two edits:
 *
 *   1. Create `src/bench/evaluators/<new-evaluator>.ts` whose module top
 *      calls `registerCustomEvaluator("<id>", <evaluator>)`.
 *   2. Add `import "./<new-evaluator>.ts"` below.
 *
 * Nothing else changes — the loaders in `src/bench/loader.ts`,
 * `src/bench/custom-plan.ts`, and `src/jit-optimize/task-source.ts` all
 * import `hydrateEvalPayloads` / `persistEvalPayloads` from THIS barrel,
 * which transitively loads every evaluator listed here before any task is
 * loaded. Registration is structurally unforgettable: a new evaluator is
 * registered iff its side-effect import appears below, and the compile step
 * will flag a typo immediately.
 */

// --- registered evaluators (one side-effect import per evaluator) ---
import "./python-grade.ts"
import "./junit-grade.ts"
import "./tb-grade.ts"
// import "./docker-grader.ts"   // example of future addition
// import "./js-grader.ts"       // example of future addition

// --- re-exports so loaders import from one place ---
export { hydrateEvalPayloads, persistEvalPayloads } from "../../framework/payload.ts"
