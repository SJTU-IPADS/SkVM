import type { EvalCheckpoint, EvalCriterion, Level } from "../core/types.ts"
import type { FailureReport } from "./failure-diagnostics.ts"

/** A difficulty level a generator actually runs ("L0" is never generated). */
export type GeneratorLevel = Exclude<Level, "L0">

/** A single microbenchmark test instance produced by a generator */
export interface MicrobenchmarkInstance {
  prompt: string
  setupFiles?: Record<string, string>
  eval: EvalCriterion
}

/** Generator for a single primitive capability */
export interface MicrobenchmarkGenerator {
  readonly primitiveId: string
  /** Human-readable description of what each level tests */
  readonly descriptions: Record<GeneratorLevel, string>
  generate(level: GeneratorLevel): MicrobenchmarkInstance
}

/** Result of evaluating one instance */
export interface InstanceResult {
  instance: number
  passed: boolean
  details: string
  durationMs: number
  /** True when the instance was skipped for an environment reason (e.g. a
   *  missing dependency) and must NOT count as a pass or a failure. */
  skipped?: boolean
  /** Full failure diagnostics (present when instance failed) */
  failureReport?: FailureReport
  /** Per-checkpoint scoring breakdown (present when eval script outputs structured JSON) */
  checkpoints?: EvalCheckpoint[]
}

/** Result of profiling one level of one primitive */
export interface LevelResult {
  level: GeneratorLevel
  passed: boolean
  passCount: number
  totalCount: number
  /** Instances skipped for environment reasons; excluded from the pass/total
   *  pass decision so a missing dependency does not fail the level. */
  skipCount: number
  instances: InstanceResult[]
  durationMs: number
  costUsd: number
}

/** Result of profiling one primitive (all levels) */
export interface PrimitiveResult {
  primitiveId: string
  highestLevel: Level
  levelResults: LevelResult[]
  calibrationNote?: string
}
