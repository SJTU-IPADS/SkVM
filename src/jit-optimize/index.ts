/**
 * JIT-Optimize — skill content improvement.
 *
 * Design axes:
 *  - task source: synthetic-task / real-task / execution-log (all support multiple inputs)
 *  - loop: rounds, runsPerTask, convergence, baseline, holdoutTestSet
 *  - delivery: single kind (proposal) with {keepAllRounds, autoApply}
 *
 * Evidence is a unified schema fed to the optimizer regardless of source —
 * fields are "fill what you have". The optimizer runs as a headless agent
 * inside a temp workspace (a copy of the skill folder); its edits become the
 * optimized version, which is snapshotted into the proposal as round-N/. The
 * concrete agent backend is selected through `core/headless-agent.ts`, so
 * jit-optimize has no hard dependency on any particular agent tool.
 *
 * No dependency on compiler, profiler, TCP, or SCR.
 */

import { runLoop } from "./loop.ts"
import type {
  JitOptimizeConfig,
  JitOptimizeResult,
} from "./types.ts"
import { createLogger } from "../core/logger.ts"

const log = createLogger("jit-optimize")

/**
 * Entry point: run an optimization session and return the resulting proposal.
 *
 * ```ts
 * const result = await jitOptimize({
 *   skillDir: "skvm-data/skills/powerpoint-pptx",
 *   optimizer: { model: "<provider>/<model-id>" },
 *   taskSource: { kind: "real-task", tasks: ["powerpoint-pptx_task_02"] },
 *   targetAdapter: { model: "<provider>/<model-id>", harness: "openclaw" },
 *   loop: { rounds: 3 },
 *   delivery: { keepAllRounds: true, autoApply: false },
 * })
 * console.log(result.proposalId, result.bestRound, result.bestRoundReason)
 * ```
 */
export async function jitOptimize(
  config: JitOptimizeConfig,
  opts?: import("./loop.ts").RunLoopOptions,
): Promise<JitOptimizeResult> {
  log.info(`jit-optimize: source=${config.taskSource.kind} rounds=${config.loop?.rounds ?? 1}`)
  return runLoop(config, opts)
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type {
  JitOptimizeConfig,
  JitOptimizeResult,
  RoundResult,
  Evidence,
  HistoryEntry,
  OptimizationChange,
  OptimizeInput,
  OptimizeConfig,
  OptimizeResult,
  OptimizeSubmission,
  TaskSource,
  LoopConfig,
  DeliveryConfig,
  EvidenceCriterion,
  RunMeta,
  WorkDirSnapshot,
  ConversationLogEntry,
  ExecutionLogInput,
  CostSlice,
} from "./types.ts"

export {
  HistoryEntrySchema,
  OptimizationChangeSchema,
  OptimizeSubmissionSchema,
  EvidenceCriterionSchema,
  emptyCostSlice,
} from "./types.ts"

export { runOptimizer } from "./optimizer.ts"
export { runLoop } from "./loop.ts"
export {
  resolveTrainTestTasks,
  loadEvidencesFromLogs,
  copyFixturesInto,
} from "./task-source.ts"
export type { RunnableTask, ResolvedTasks } from "./task-source.ts"
export {
  snapshotWorkDir,
  buildEvidenceCriteria,
  readConversationLog,
  buildConversationLogFromSteps,
  parseConvLogFile,
  buildRunMeta,
  scoreFromCriteria,
  countCriteria,
  buildEvidenceFromRun,
} from "./evidence.ts"
export type { ParsedConvLogFile } from "./evidence.ts"
export {
  createWorkspace,
  serializeContext,
  computeDiff,
  stripOptimizeDir,
  removeWorkspace,
} from "./workspace.ts"
export type { Workspace, WorkspaceDiff } from "./workspace.ts"
