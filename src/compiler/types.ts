import { z } from "zod"
import type {
  SCR, TCP, CapabilityGap, TokenUsage,
  WorkflowDAG, DependencyEntry,
} from "../core/types.ts"
import type { ArtifactBag, PassRunMeta } from "./artifacts.ts"

// ---------------------------------------------------------------------------
// Failure Context (used by rewrite-skill for JIT recompilation)
// ---------------------------------------------------------------------------

export const FailureContextSchema = z.object({
  classification: z.enum(["task-specific", "systematic"]),
  patterns: z.array(z.object({
    toolName: z.string(),
    frequency: z.number(),
    category: z.enum(["tool-error", "logic-error", "timeout", "api-error"]),
    sampleErrors: z.array(z.string()),
  })),
  recoveryTraces: z.array(z.object({
    failedStep: z.number(),
    failedToolName: z.string(),
    failedError: z.string(),
    recoveredAtStep: z.number(),
    recoveryAction: z.string(),
  })),
  sourceVariantId: z.string(),
  runCount: z.number(),
  failureRate: z.number(),
})

export type FailureContext = z.infer<typeof FailureContextSchema>

// ---------------------------------------------------------------------------
// Internal pass return types
//
// These are the raw results of `runPass1Agentic` / `runPass2` / `runPass3`.
// They are wrapped by the CompilerPass implementations under
// `src/compiler/passes/<id>/` and never appear in `CompilationResult`.
// ---------------------------------------------------------------------------

export interface Pass1Result {
  scr: SCR
  gaps: CapabilityGap[]
  compiledSkill: string
}

export interface Pass2Result {
  dependencies: DependencyEntry[]
  bindingScript: string
  simulation: {
    attemptCount: number
    success: boolean
    failureReason?: string
    finalScriptValidated: boolean
  }
}

export interface Pass3Result {
  dag: WorkflowDAG
}

// ---------------------------------------------------------------------------
// Compilation Result & Options (public surface)
// ---------------------------------------------------------------------------

export interface CompilationResult {
  skillName: string
  model: string
  harness: string
  compiledAt: string

  /** Final compiled SKILL.md text (after every pass and skillPatch was applied). */
  compiledSkill: string

  /** Intermediate per-key artifacts produced by passes. Same payload that lives under `_artifacts/{key}.json`. */
  artifacts: Partial<ArtifactBag>
  /** Per-pass execution metadata (status, tokens, duration, errors). Keyed by pass id. */
  passRuns: Record<string, PassRunMeta>

  guardPassed: boolean
  guardViolations: string[]

  /** Sum of `passRuns[*].tokens` for the run. */
  tokens: TokenUsage

  /** Numeric ids of passes that actually ran. Drives `passTag` and storage path. */
  passes: number[]

  costUsd: number
  durationMs: number
}

export interface CompileOptions {
  skillPath: string
  skillContent: string
  /** Path to skill directory containing SKILL.md and bundle files. */
  skillDir?: string
  /** Explicit skill name for output directory (default: derived from skillPath). */
  skillName?: string
  tcp: TCP
  model: string
  harness: string
  /**
   * Which passes to run, as raw CLI tokens (numeric or string ids; mixed
   * allowed). Resolved against the registry. Default: every registered pass.
   */
  passes?: string[]
  /** Dry run: compute plan without writing the variant to disk. */
  dryRun?: boolean
  /** Structured failure context surfaced into rewrite-skill's prompt for JIT recompilation. */
  failureContext?: FailureContext
}
