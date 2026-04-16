import { z } from "zod"
import type { ConversationLog } from "./conversation-logger.ts"
import { TASK_FILE_DEFAULTS, EVAL_DEFAULTS, HEADLESS_AGENT_DEFAULTS } from "./ui-defaults.ts"

// ---------------------------------------------------------------------------
// Primitive Capabilities
// ---------------------------------------------------------------------------

export const PRIMITIVE_CATEGORIES = ["generation", "reasoning", "tool_use", "instruction_following"] as const
export type PrimitiveCategory = (typeof PRIMITIVE_CATEGORIES)[number]

export const LEVELS = ["L0", "L1", "L2", "L3"] as const
export type Level = (typeof LEVELS)[number]

export const LEVEL_ORDER: Record<Level, number> = { L0: 0, L1: 1, L2: 2, L3: 3 }

export function compareLevel(a: Level, b: Level): number {
  return LEVEL_ORDER[a] - LEVEL_ORDER[b]
}

export const PrimitiveIdSchema = z.string().regex(/^(gen|reason|tool|follow)\.\w+(\.\w+)?$/)
export type PrimitiveId = string

export interface PrimitiveDefinition {
  id: PrimitiveId
  category: PrimitiveCategory
  description: string
  levels: {
    L1: string
    L2: string
    L3: string
  }
  /** How to lower a skill's requirement by one level (compiler guidance). null = no feasible degradation. */
  degradations: {
    "L3->L2": string | null
    "L2->L1": string | null
  }
}

// ---------------------------------------------------------------------------
// Token Usage & Cost
// ---------------------------------------------------------------------------

export const TokenUsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number().default(0),
  cacheWrite: z.number().default(0),
})

export type TokenUsage = z.infer<typeof TokenUsageSchema>

export function emptyTokenUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

export function sumTokenUsages(list: readonly TokenUsage[]): TokenUsage {
  return list.reduce(addTokenUsage, emptyTokenUsage())
}

// ---------------------------------------------------------------------------
// Agent Step (from adapter runs)
// ---------------------------------------------------------------------------

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
  output: z.string().optional(),
  durationMs: z.number().optional(),
  exitCode: z.number().optional(),
})

export type ToolCall = z.infer<typeof ToolCallSchema>

export const AgentStepSchema = z.object({
  role: z.enum(["assistant", "tool"]),
  text: z.string().optional(),
  toolCalls: z.array(ToolCallSchema).default([]),
  timestamp: z.number(),
})

export type AgentStep = z.infer<typeof AgentStepSchema>

// ---------------------------------------------------------------------------
// Task (test framework)
// ---------------------------------------------------------------------------

export const FileCheckModeSchema = z.enum(["exact", "contains", "regex", "json-schema"])

/** Common fields shared by all eval criteria */
const EvalCriterionBase = {
  id: z.string().optional(),
  name: z.string().optional(),
  weight: z.number().optional(),
}

/**
 * Top-level eval methods are FROZEN at four: script, file-check, llm-judge,
 * custom. Any new evaluation strategy (docker-grader, http-test, visual-diff,
 * …) should register under `custom` with a new `evaluatorId` and carry its
 * per-task data via `payload`, not by adding a fifth variant here.
 *
 * Rationale: this discriminated union gives `switch(criterion.method)` in
 * `framework/evaluator.ts` compile-time exhaustiveness checking. Every new
 * variant would force updates to the dispatcher, the evidence flattener, and
 * the reporter. The `custom` variant is the designated extensibility point;
 * see `framework/types.ts:CustomEvaluator` and `bench/evaluators/index.ts`.
 */
export const EvalCriterionSchema = z.discriminatedUnion("method", [
  z.object({
    ...EvalCriterionBase,
    method: z.literal("script"),
    command: z.string(),
    expectedExitCode: z.number().default(EVAL_DEFAULTS.scriptExpectedExitCode),
    expectedOutput: z.string().optional(),
  }),
  z.object({
    ...EvalCriterionBase,
    method: z.literal("file-check"),
    path: z.string(),
    glob: z.string().optional(),
    mode: FileCheckModeSchema,
    expected: z.string(),
  }),
  z.object({
    ...EvalCriterionBase,
    method: z.literal("llm-judge"),
    rubric: z.union([z.string(), z.record(z.string(), z.string())]),
    maxScore: z.number().default(EVAL_DEFAULTS.llmJudgeMaxScore),
  }),
  z.object({
    ...EvalCriterionBase,
    method: z.literal("custom"),
    evaluatorId: z.string(),
    /**
     * Per-task data for the evaluator (e.g. grade.py source, Docker image
     * tag, JSON config). Hydrated at load time by the evaluator's
     * `loadPayload` hook via `hydrateEvalPayloads`. The evaluator's `run`
     * function is responsible for type-narrowing.
     */
    payload: z.unknown().optional(),
  }),
])

export type EvalCriterion = z.infer<typeof EvalCriterionSchema>

export const TaskSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  prompt: z.string(),
  fixtures: z.record(z.string()).optional(),
  eval: z.array(EvalCriterionSchema).min(1),
  timeoutMs: z.number().default(TASK_FILE_DEFAULTS.timeoutMs),
  maxSteps: z.number().default(TASK_FILE_DEFAULTS.maxSteps),
})

export type Task = z.infer<typeof TaskSchema>

// ---------------------------------------------------------------------------
// Run Result (adapter output)
// ---------------------------------------------------------------------------

/**
 * RunStatus — canonical signal for "did the adapter actually produce a
 * trustworthy result?". Required on every RunResult. Consumers (runner,
 * bench aggregator, jit-optimize evidence) gate on this; never on the
 * display-only `adapterError` field.
 *
 * - 'ok'              → natural completion with full accounting
 * - 'timeout'         → subprocess killed by the adapter's timeout
 * - 'adapter-crashed' → subprocess exited non-zero for a non-timeout reason
 * - 'parse-failed'    → subprocess exited 0 but structured output was not
 *                       extractable (recoverable-ish; workDir may be fine)
 * - 'tainted'         → set post-hoc by runner/conditions to mark a run
 *                       whose adapter was fine but whose evaluation cannot
 *                       be trusted for external reasons. Adapters never set
 *                       this directly.
 */
export const RunStatusSchema = z.enum([
  "ok",
  "timeout",
  "adapter-crashed",
  "parse-failed",
  "tainted",
])
export type RunStatus = z.infer<typeof RunStatusSchema>

export const RunResultSchema = z.object({
  text: z.string(),
  steps: z.array(AgentStepSchema),
  tokens: TokenUsageSchema,
  cost: z.number(),
  durationMs: z.number(),
  llmDurationMs: z.number().default(0),
  workDir: z.string(),
  skillLoaded: z.boolean().optional(),
  runStatus: RunStatusSchema,
  statusDetail: z.string().optional(),
  /** Display-only: human-debug stderr snippet. NOT a status signal — check runStatus instead. */
  adapterError: z.object({
    exitCode: z.number(),
    stderr: z.string(),
  }).optional(),
})

export type RunResult = z.infer<typeof RunResultSchema>

// ---------------------------------------------------------------------------
// Eval Checkpoint & Result
// ---------------------------------------------------------------------------

export const EvalCheckpointSchema = z.object({
  name: z.string(),
  score: z.number().min(0).max(1),
  /** Relative weight within the parent EvalResult; inner weights sum to 1 when set. */
  weight: z.number().optional(),
  /** What this sub-criterion tests — shown to reporters and to the jit-optimize optimizer. */
  description: z.string().optional(),
  reason: z.string().optional(),
})

export type EvalCheckpoint = z.infer<typeof EvalCheckpointSchema>

export const EvalResultSchema = z.object({
  pass: z.boolean(),
  score: z.number().min(0).max(1),
  details: z.string(),
  criterion: EvalCriterionSchema,
  checkpoints: z.array(EvalCheckpointSchema).optional(),
  /**
   * Set when the evaluator could not actually run because of an
   * infrastructure failure (provider down, auth, rate-limit exhausted,
   * headless agent subprocess crash). The `score` / `pass` fields are
   * meaningless when `infraError` is set — downstream aggregators
   * (jit-optimize avgScore) MUST exclude these results rather than
   * averaging them in, or the quality signal will be dominated by
   * infra flakiness masquerading as agent failures.
   */
  infraError: z.string().optional(),
})

export type EvalResult = z.infer<typeof EvalResultSchema>

// ---------------------------------------------------------------------------
// TCP (Target Capability Profile)
// ---------------------------------------------------------------------------

export const PrimitiveProfileDetailSchema = z.object({
  primitiveId: z.string(),
  highestLevel: z.enum(["L0", "L1", "L2", "L3"]),
  levelResults: z.array(z.object({
    level: z.enum(["L1", "L2", "L3"]),
    passed: z.boolean(),
    passCount: z.number(),
    totalCount: z.number(),
    durationMs: z.number(),
    costUsd: z.number(),
    /** What this profiling level tests (from generator descriptions) */
    testDescription: z.string().default(""),
    /** Failure details from failed instances */
    failureDetails: z.array(z.string()).default([]),
    /** Paths to conversation logs and eval scripts for failed instances */
    failureArtifacts: z.array(z.object({
      convLog: z.string(),
      evalScript: z.string(),
    })).optional(),
  })),
  calibrationNote: z.string().optional(),
  /** Base directory containing conversation logs and eval scripts for this primitive */
  convLogDir: z.string().optional(),
})

export type PrimitiveProfileDetail = z.infer<typeof PrimitiveProfileDetailSchema>

export const TCPSchema = z.object({
  version: z.literal("1.0"),
  model: z.string(),
  harness: z.string(),
  profiledAt: z.string(),
  capabilities: z.record(z.enum(["L0", "L1", "L2", "L3"])),
  details: z.array(PrimitiveProfileDetailSchema),
  cost: z.object({
    totalUsd: z.number(),
    totalTokens: TokenUsageSchema,
    durationMs: z.number(),
  }),
  /** True when this profile is incomplete (interrupted mid-run). Defaults to false for backward compat. */
  isPartial: z.boolean().default(false),
})

export type TCP = z.infer<typeof TCPSchema>

// ---------------------------------------------------------------------------
// SCR (Skill Capability Requirement)
// ---------------------------------------------------------------------------

export const SCRPrimitiveSchema = z.object({
  id: z.string(),
  minLevel: z.enum(["L1", "L2", "L3"]),
  evidence: z.string(),
})

export const SCRPathSchema = z.object({
  primitives: z.array(SCRPrimitiveSchema),
  note: z.string().optional(),
})

export const SCRPurposeSchema = z.object({
  id: z.string(),
  description: z.string(),
  currentPath: SCRPathSchema,
  alternativePaths: z.array(SCRPathSchema).default([]),
})

export const SCRSchema = z.object({
  skillName: z.string(),
  purposes: z.array(SCRPurposeSchema).min(1),
})

export type SCR = z.infer<typeof SCRSchema>
export type SCRPurpose = z.infer<typeof SCRPurposeSchema>
export type SCRPrimitive = z.infer<typeof SCRPrimitiveSchema>
export type SCRPath = z.infer<typeof SCRPathSchema>

// ---------------------------------------------------------------------------
// Compilation Types
// ---------------------------------------------------------------------------

export const TransformActionSchema = z.enum([
  "insert_before", "insert_after", "prepend_rule", "add_example", "replace",
])

export const TransformSchema = z.object({
  type: z.enum(["compensation", "substitution", "elimination"]),
  purposeId: z.string(),
  primitiveId: z.string(),
  targetSection: z.string(),
  action: TransformActionSchema,
  description: z.string(),
  content: z.string(),
  original: z.string().optional(),
})

export type Transform = z.infer<typeof TransformSchema>

export const CapabilityGapSchema = z.object({
  purposeId: z.string(),
  primitiveId: z.string(),
  requiredLevel: z.enum(["L1", "L2", "L3"]),
  modelLevel: z.enum(["L0", "L1", "L2", "L3"]),
  gapType: z.enum(["missing", "weak"]),
})

export type CapabilityGap = z.infer<typeof CapabilityGapSchema>

export const DependencyEntrySchema = z.object({
  name: z.string(),
  type: z.enum(["pip", "npm", "system", "service"]),
  checkCommand: z.string(),
  installCommand: z.string().optional(),
  required: z.boolean().default(true),
  source: z.enum(["python-import", "shell-command", "comment", "inferred", "model"]).default("model"),
  confidence: z.number().min(0).max(1).default(0.7),
  pythonModules: z.array(z.string()).optional(),
})

export type DependencyEntry = z.infer<typeof DependencyEntrySchema>

export const WorkflowStepSchema = z.object({
  id: z.string(),
  description: z.string(),
  primitives: z.array(z.string()),
  dependsOn: z.array(z.string()).default([]),
})

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>

export const ParallelismAnnotationSchema = z.object({
  type: z.enum(["dlp", "ilp", "tlp"]),
  steps: z.array(z.string()),
  mechanism: z.string(),
  fallback: z.string(),
})

export type ParallelismAnnotation = z.infer<typeof ParallelismAnnotationSchema>

export const WorkflowDAGSchema = z.object({
  steps: z.array(WorkflowStepSchema),
  parallelism: z.array(ParallelismAnnotationSchema),
})

export type WorkflowDAG = z.infer<typeof WorkflowDAGSchema>

// ---------------------------------------------------------------------------
// Adapter Config
// ---------------------------------------------------------------------------

export const AdapterConfigSchema = z.object({
  model: z.string(),
  apiKey: z.string().optional(),
  maxSteps: z.number().default(TASK_FILE_DEFAULTS.maxSteps),
  timeoutMs: z.number().default(TASK_FILE_DEFAULTS.timeoutMs),
  providerOptions: z.record(z.unknown()).optional(),
})

export type AdapterConfig = z.infer<typeof AdapterConfigSchema>

// ---------------------------------------------------------------------------
// Provider Routing (direct LLMProvider path)
// ---------------------------------------------------------------------------

export const ProviderKindSchema = z.enum(["openrouter", "anthropic", "openai-compatible"])
export type ProviderKind = z.infer<typeof ProviderKindSchema>

export const ProviderRouteSchema = z.object({
  match: z.string(),
  kind: ProviderKindSchema,
  apiKeyEnv: z.string(),
  baseUrl: z.string().optional(),
})
export type ProviderRoute = z.infer<typeof ProviderRouteSchema>

export const ProvidersConfigSchema = z.object({
  routes: z.array(ProviderRouteSchema).default([]),
})
export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>

// ---------------------------------------------------------------------------
// Headless Agent Config (jit-optimize / jit-boost agent runs)
// ---------------------------------------------------------------------------

export const HeadlessAgentDriverSchema = z.enum(["opencode"])
export type HeadlessAgentDriverName = z.infer<typeof HeadlessAgentDriverSchema>

/**
 * Override for the opencode subprocess provider. Parallel to `ProviderRoute`
 * (which routes SkVM's in-process LLM calls) but targets the opencode
 * subprocess via OPENCODE_CONFIG_CONTENT injection.
 */
export const ProviderOverrideSchema = z.object({
  name: z.string(),
  baseUrl: z.string(),
  apiKeyEnv: z.string().optional(),
  /** Takes precedence over apiKeyEnv. */
  apiKey: z.string().optional(),
  contextLimit: z.number().optional(),
  outputLimit: z.number().optional(),
})
export type ProviderOverride = z.infer<typeof ProviderOverrideSchema>

export const HeadlessAgentConfigSchema = z.object({
  driver: HeadlessAgentDriverSchema.default(HEADLESS_AGENT_DEFAULTS.driver),
  modelPrefix: z.string().default(HEADLESS_AGENT_DEFAULTS.modelPrefix),
  /**
   * When set, skvm injects OPENCODE_CONFIG_CONTENT into the opencode subprocess
   * to register a custom OpenAI-compatible provider. This avoids modifying the
   * user's global opencode config. The provider `name` must match the first
   * segment of `modelPrefix` (e.g. modelPrefix="custom/" → name="custom").
   */
  providerOverride: ProviderOverrideSchema.optional(),
})
export type HeadlessAgentConfig = z.infer<typeof HeadlessAgentConfigSchema>

// ---------------------------------------------------------------------------
// Skill Loading Modes
// ---------------------------------------------------------------------------

export type SkillMode = "inject" | "discover"

// ---------------------------------------------------------------------------
// Agent Adapter Interface
// ---------------------------------------------------------------------------

export interface AgentAdapter {
  readonly name: string
  setup(config: AdapterConfig): Promise<void>
  run(task: {
    prompt: string
    workDir: string
    skillContent?: string
    skillMode?: SkillMode
    skillMeta?: { name: string; description: string }
    taskId?: string
    convLog?: ConversationLog
    /** Per-task timeout override (ms). Falls back to adapter setup timeout. */
    timeoutMs?: number
  }): Promise<RunResult>
  teardown(): Promise<void>
}
