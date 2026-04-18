import { z } from "zod"
import { EvalCriterionSchema } from "../core/types.ts"
import type { Task, EvalCheckpoint, EvalCriterion, TokenUsage, SkillMode, RunStatus } from "../core/types.ts"
import type { AdapterName } from "../adapters/registry.ts"
import { TASK_FILE_DEFAULTS, BENCH_CONFIG_DEFAULTS } from "../core/ui-defaults.ts"

// ---------------------------------------------------------------------------
// Bench Config
// ---------------------------------------------------------------------------

export const BenchConfigFileSchema = z.object({
  excludedTasks: z.array(z.string()).default(() => [...BENCH_CONFIG_DEFAULTS.excludedTasks]),
  defaultConditions: z.array(z.string()).default(() => [...BENCH_CONFIG_DEFAULTS.defaultConditions]),
  defaultJitRuns: z.number().default(BENCH_CONFIG_DEFAULTS.defaultJitRuns),
  defaultTimeoutMult: z.number().default(BENCH_CONFIG_DEFAULTS.defaultTimeoutMult),
  defaultMaxSteps: z.number().default(BENCH_CONFIG_DEFAULTS.defaultMaxSteps),
  models: z.array(z.string()).default(() => [...BENCH_CONFIG_DEFAULTS.models]),
})

export type BenchConfigFile = z.infer<typeof BenchConfigFileSchema>

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export const OriginSchema = z.object({
  source: z.string(),                   // "pinchbench", "clawhub", "manual", "generated"
  repo: z.string().optional(),          // git repo URL
  url: z.string().optional(),           // web URL (clawhub skill page, etc.)
  file: z.string().optional(),          // original file path within repo
  importedAt: z.string().optional(),    // ISO timestamp
  notes: z.string().optional(),
})

export type Origin = z.infer<typeof OriginSchema>

// ---------------------------------------------------------------------------
// BenchTask (extends SkVM Task with bench metadata)
// ---------------------------------------------------------------------------

export interface BenchTask extends Task {
  category: string
  gradingType: "automated" | "llm_judge" | "hybrid"
  gradingWeights?: { automated: number; llmJudge: number }
  /**
   * Path(s) to the skill directory, relative to taskDir or absolute.
   * `null` = no-skill task. `undefined` = no binding configured.
   */
  skill?: string | string[] | null
  /** Where this task came from */
  origin?: Origin
  /** Path to task directory (set by loader) */
  taskDir?: string
  /** Whether the task can run on the host without Docker */
  hostReady?: boolean
  /** Task difficulty from source benchmark */
  difficulty?: "easy" | "medium" | "hard"
}

/**
 * Zod schema for task.json files in skvm-data/tasks/<name>/task.json.
 * The directory name must equal the `id` field; the loader enforces this.
 * The `skill` field holds path(s) to the skill directory, relative to the
 * task directory or absolute — not a registry ID.
 */
export const BenchTaskFileSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  category: z.string().default(TASK_FILE_DEFAULTS.category),
  gradingType: z.enum(["automated", "llm_judge", "hybrid"]).default(TASK_FILE_DEFAULTS.gradingType),
  prompt: z.string(),
  timeoutMs: z.number().default(TASK_FILE_DEFAULTS.timeoutMs),
  maxSteps: z.number().default(TASK_FILE_DEFAULTS.maxSteps),
  eval: z.array(z.any()).min(1),
  fixtures: z.record(z.string()).optional(),
  gradingWeights: z.object({ automated: z.number(), llmJudge: z.number() }).optional(),
  skill: z.union([z.string(), z.array(z.string()), z.null()]).optional(),
  origin: OriginSchema.optional(),
  hostReady: z.boolean().default(TASK_FILE_DEFAULTS.hostReady),
  difficulty: z.enum(["easy", "medium", "hard"]).optional(),
})

// ---------------------------------------------------------------------------
// Bench Conditions
// ---------------------------------------------------------------------------

/** Standard conditions shown in help text and used as defaults. */
export const BENCH_CONDITIONS = ["no-skill", "original", "aot-compiled", "jit-optimized", "jit-boost"] as const

/**
 * Condition identifier. Fixed values: "no-skill", "original", "aot-compiled", "jit-optimized", "jit-boost".
 * AOT variants use dynamic naming: "aot-compiled" (= all passes), "aot-compiled-p1", "aot-compiled-p12", "aot-compiled-p23", etc.
 */
export type BenchCondition = string

export const BenchConditionSchema = z.string()

const AOT_PASS_RE = /^aot-compiled-p([123]+)$/

/**
 * Parse passes from an AOT condition name. Returns null for non-AOT conditions.
 * Examples: "aot-compiled" → [1,2,3], "aot-compiled-p1" → [1], "aot-compiled-p12" → [1,2], "aot-compiled-p23" → [2,3]
 */
export function parseAotPasses(condition: BenchCondition): number[] | null {
  if (condition === "aot-compiled") return [1, 2, 3]
  const m = AOT_PASS_RE.exec(condition)
  if (!m) return null
  // Dedupe and sort: "p12" → [1,2], "p321" → [1,2,3]
  return [...new Set(m[1]!.split("").map(Number))].sort()
}

/** Check whether a condition is an AOT variant. */
export function isAotCondition(condition: BenchCondition): boolean {
  return parseAotPasses(condition) !== null
}

/** Validate a condition string. */
export function isValidCondition(condition: string): boolean {
  return ["no-skill", "original", "jit-optimized", "jit-boost"].includes(condition) || isAotCondition(condition)
}

// ---------------------------------------------------------------------------
// Condition Result
// ---------------------------------------------------------------------------

export interface JitRunReport {
  runIndex: number
  score: number
  durationMs: number
  llmDurationMs: number
  tokens: TokenUsage
  promotions: number
}

export interface EvalDetail {
  id?: string
  name?: string
  method: string
  score: number
  weight?: number
  details: string
  checkpoints?: EvalCheckpoint[]
}

export interface ConditionResult {
  condition: BenchCondition
  score: number
  pass: boolean
  /** Per-criterion details; llm-judge entries carry the judge's reasoning */
  evalDetails: EvalDetail[]
  /** Separate score components when gradingWeights is used */
  automatedScore?: number
  llmJudgeScore?: number
  /** Hybrid grading weights, persisted so async-judge merge can recompute with the same strategy */
  gradingWeights?: { automated: number; llmJudge: number }
  tokens: TokenUsage
  cost: number
  durationMs: number
  llmDurationMs: number
  steps: number
  skillId?: string
  skillPath?: string
  skillPaths?: string[]
  skillContentHash?: string
  skillMode?: SkillMode
  skillLoaded?: boolean
  jitRuns?: JitRunReport[]
  jitPromotions?: number
  /** Individual run scores when runsPerTask > 1 */
  runScores?: number[]
  error?: string
  /**
   * Canonical signal for "was this run evaluable?".
   *   - 'ok'                                    → normal row, included in aggregates
   *   - 'timeout' | 'adapter-crashed' | 'parse-failed' → tainted, excluded from avgScore/passRate
   *   - 'tainted'                               → post-hoc marker (reserved)
   * Older bench reports without this field are treated as 'ok' by the reporter
   * for backwards compat; see src/bench/reporter.ts.
   */
  runStatus?: RunStatus
  /** Optional human-readable explanation when runStatus !== 'ok'. */
  statusDetail?: string
}

// ---------------------------------------------------------------------------
// Task Report
// ---------------------------------------------------------------------------

export interface TaskReport {
  taskId: string
  taskName: string
  category: string
  gradingType: string
  conditions: ConditionResult[]
}

// ---------------------------------------------------------------------------
// Summary Report
// ---------------------------------------------------------------------------

export interface ConditionSummary {
  /**
   * Average score over evaluable (runStatus === 'ok') rows.
   * `null` when *every* row for this condition is tainted — distinct from
   * `0`, which means "evaluated and scored zero". Readers must treat `null`
   * as "no comparable data" (skip, don't plug zero into deltas or rankings).
   */
  avgScore: number | null
  passRate: number | null
  avgTokens: number
  avgCost: number
  avgDurationMs: number
  avgLlmDurationMs: number
  /** Rows counted in the avgScore / passRate denominators (runStatus === 'ok'). */
  evaluableCount?: number
  /** Rows excluded from avgScore / passRate due to runStatus !== 'ok'. */
  taintedCount?: number
  /** Counts per runStatus value for this condition. */
  byStatus?: Partial<Record<RunStatus, number>>
}

export interface BenchSummary {
  taskCount: number
  perCondition: Partial<Record<BenchCondition, ConditionSummary>>
  perCategory: Record<string, Partial<Record<BenchCondition, number>>>
  delta: {
    originalVsBaseline: number | null
    aotVsOriginal: number | null
    jitVsAot: number | null
  }
}

// ---------------------------------------------------------------------------
// Bench Report (top-level output)
// ---------------------------------------------------------------------------

export interface BenchReport {
  sessionId: string
  model: string
  adapter: string
  timestamp: string
  completedAt?: string
  runsPerTask?: number
  tasks: TaskReport[]
  summary: BenchSummary
}

// ---------------------------------------------------------------------------
// Progress (for resumability)
// ---------------------------------------------------------------------------

export interface ProgressEntry {
  taskId: string
  condition: BenchCondition
  result: ConditionResult
}

export interface BenchProgress {
  sessionId: string
  model: string
  adapter: string
  startedAt: string
  entries: ProgressEntry[]
}

// ---------------------------------------------------------------------------
// Bench Run Config (runtime config passed to orchestrator)
// ---------------------------------------------------------------------------

export interface BenchRunConfig {
  model: string
  adapter: AdapterName
  conditions: BenchCondition[]
  tasks?: string[]
  /** Filter tasks by origin.source(s) (e.g. "pinchbench", "skillsbench,clawhub") */
  source?: string | string[]
  skillMode?: SkillMode
  jitRuns: number
  timeoutMult: number
  maxSteps: number
  /** LLM judge model via OpenRouter (default: anthropic/claude-sonnet-4.6) */
  judgeModel?: string
  /** Model for AOT/JIT compiler via OpenRouter (default: anthropic/claude-sonnet-4.6) */
  compilerModel?: string
  tcpPath?: string
  resumeSession?: string
  keepWorkDirs: boolean
  verbose: boolean
  /** Number of concurrent task runs (default 1 = sequential) */
  concurrency?: number
  /** Run LLM-judge evaluations asynchronously in a post-run batch. Default: false. */
  asyncJudge?: boolean
  /** Runs per task-condition pair, averaged to reduce variance (default: 1) */
  runsPerTask?: number
  /**
   * Adapter-config mode to pass through to every adapter.setup() call. When
   * undefined, adapters treat it as `managed`. The CLI resolves this from
   * `--adapter-config` > `defaults.adapterConfigMode` > `"managed"`.
   */
  adapterConfigMode?: import("../core/types.ts").AdapterConfigMode
}

// ---------------------------------------------------------------------------
// Multi-Model Report
// ---------------------------------------------------------------------------

export interface MultiModelReport {
  sessionId: string
  timestamp: string
  completedAt: string
  models: string[]
  reports: BenchReport[]
  comparison: ModelComparison
}

export interface ModelComparison {
  scoreMatrix: Record<string, Partial<Record<BenchCondition, number>>>
  tokenMatrix: Record<string, Partial<Record<BenchCondition, number>>>
  taskMatrix: Record<string, Record<string, number>>
  /**
   * Ranked by average score descending. `avgScore`/`passRate` are `null` when
   * the model had zero evaluable rows (every attempted task was tainted) —
   * mirrors the `ConditionSummary` null sentinel so all-tainted reports are
   * not collapsed into a fake 0.00 ranking entry.
   */
  ranking: { model: string; avgScore: number | null; passRate: number | null }[]
}

// ---------------------------------------------------------------------------
// Multi-Adapter Report
// ---------------------------------------------------------------------------

export interface MultiAdapterReport {
  sessionId: string
  timestamp: string
  completedAt: string
  model: string
  adapters: string[]
  reports: BenchReport[]
  comparison: AdapterComparison
}

export interface AdapterComparison {
  /** adapter -> condition -> avg score */
  scoreMatrix: Record<string, Partial<Record<BenchCondition, number>>>
  /** adapter -> condition -> avg tokens */
  tokenMatrix: Record<string, Partial<Record<BenchCondition, number>>>
  /** taskId -> adapter -> best score */
  taskMatrix: Record<string, Record<string, number>>
  /**
   * Ranked by average score descending. `avgScore`/`passRate` are `null` when
   * the adapter had zero evaluable rows (every task tainted) — same null
   * sentinel as `ConditionSummary`.
   */
  ranking: { adapter: string; avgScore: number | null; passRate: number | null }[]
}
