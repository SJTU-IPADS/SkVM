import type { AgentAdapter, AdapterConfig, TCP, SkillMode } from "../../core/types.ts"
import type { LLMProvider } from "../../providers/types.ts"
import type { EvaluatorConfig, EvaluateAllOptions } from "../../framework/evaluator.ts"
import type { ConversationLog } from "../../core/conversation-logger.ts"
import type { ResolvedSkill } from "../../core/skill-loader.ts"
import type { BenchTask, BenchCondition, ConditionResult } from "../types.ts"

/**
 * The five dispatchable condition families. Concrete `BenchCondition` strings
 * map onto these via `resolveConditionKind` — the four fixed names map to
 * themselves and every AOT pass-glob (`aot-compiled`, `aot-compiled-p12`, …)
 * maps to `aot-variant`.
 */
export type ConditionKind =
  | "no-skill"
  | "original"
  | "jit-optimized"
  | "jit-boost"
  | "aot-variant"

/**
 * Everything a condition runner may need for one (task, condition) bench
 * cell. The orchestrator builds this once per work item; each runner picks
 * the slice it actually uses.
 */
export interface ConditionContext {
  /** Concrete condition label being run (e.g. "original", "aot-compiled-p12"). */
  condition: BenchCondition
  task: BenchTask
  adapter: AgentAdapter
  /** Per-task adapter config — `timeoutMs` is already resolved by the orchestrator. */
  adapterConfig: AdapterConfig
  /** Skills resolved for the task. Non-empty for every condition except no-skill. */
  skills: ResolvedSkill[]
  skillMode?: SkillMode
  evaluatorConfig?: EvaluatorConfig
  /**
   * Lazily create a conversation log under the session's per-task log dir
   * (`<benchLogDir>/<taskId>/<label>.jsonl`). The only way runners obtain
   * conv logs — the directory layout is the orchestrator's.
   */
  createConvLog: (label: string) => Promise<ConversationLog>
  /**
   * Deferred LLM-judge options (`--async-judge`). Runners that need
   * synchronous eval results (jit-boost's feedback loop) ignore this.
   */
  evalOptions?: EvaluateAllOptions
  /** Skill TCP profile; set when the orchestrator scheduled an AOT condition. */
  tcp?: TCP
  /** Compiler provider; set when the condition set contains an AOT condition. */
  compilerProvider?: LLMProvider
  /** Number of jit-boost runs (1 warmup + N-1 with hooks). */
  jitRuns: number
  /** Absolute CLI timeout override; feeds jit-boost candidate-gen timeout resolution. */
  cliTimeoutMs?: number
}

/** A bench condition implementation, dispatched via `CONDITION_RUNNERS`. */
export interface ConditionRunner {
  run(ctx: ConditionContext): Promise<ConditionResult>
}
