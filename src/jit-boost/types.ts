import { z } from "zod"

// ---------------------------------------------------------------------------
// Param definitions (per-parameter extraction config)
// ---------------------------------------------------------------------------

/** Rich param definition with extraction hints */
export const ParamDefSchema = z.object({
  type: z.enum(["string", "number"]),
  /** Human-readable description of what this param is (used for LLM extraction) */
  description: z.string(),
  /** Regex with ONE capture group to extract this param from a user prompt */
  extractPattern: z.string().optional(),
})

export type ParamDef = z.infer<typeof ParamDefSchema>

/** Backward compatible: accepts "string"/"number" (old format) or ParamDef (new format) */
export const ParamValueSchema = z.union([z.string(), ParamDefSchema])

/** Normalize a param value to the rich ParamDef format */
export function normalizeParamDef(paramName: string, value: string | ParamDef): ParamDef {
  if (typeof value === "string") {
    return { type: value as "string" | "number", description: paramName }
  }
  return value
}

// ---------------------------------------------------------------------------
// Boost Candidate (generated at AOT / compile time)
// ---------------------------------------------------------------------------

export const BoostCandidateSchema = z.object({
  purposeId: z.string(),
  keywords: z.array(z.string()).min(1),
  /** Regex pattern matching LLM-generated code structure */
  codeSignature: z.string(),
  /** Executable code with ${param} placeholders */
  // Non-empty: an empty template instantiates to "", passes the
  // unfilled-placeholder scan, exits 0 under `sh -c`, and serves the empty
  // string as the agent's answer.
  functionTemplate: z.string().min(1),
  /** Input/output parameter definitions: param name → type string or rich ParamDef */
  params: z.record(ParamValueSchema),
  materializationType: z.enum(["shell", "python"]),
  /** Tool types to monitor for signature matches (per-candidate override) */
  monitoredTools: z.array(z.string()).optional(),
})

export type BoostCandidate = z.infer<typeof BoostCandidateSchema>

// ---------------------------------------------------------------------------
// Monitor State (runtime tracking per candidate)
// ---------------------------------------------------------------------------

export const MonitorStateSchema = z.object({
  candidateId: z.string(),
  hitCount: z.number().default(0),
  consecutiveMatches: z.number().default(0),
  promoted: z.boolean().default(false),
  fallbackCount: z.number().default(0),
})

export type MonitorState = z.infer<typeof MonitorStateSchema>

// ---------------------------------------------------------------------------
// Solidification State (persisted per variant)
// ---------------------------------------------------------------------------

export const SolidificationEntrySchema = z.object({
  candidate: BoostCandidateSchema,
  state: MonitorStateSchema,
  promotedAt: z.string().optional(),
})

export type SolidificationEntry = z.infer<typeof SolidificationEntrySchema>

export const SolidificationStateSchema = z.object({
  skillId: z.string(),
  entries: z.array(SolidificationEntrySchema),
  updatedAt: z.string(),
})

export type SolidificationState = z.infer<typeof SolidificationStateSchema>

// ---------------------------------------------------------------------------
// Boost Candidates File (written by compiler, read at runtime)
// ---------------------------------------------------------------------------

export const BoostCandidatesFileSchema = z.object({
  candidates: z.array(BoostCandidateSchema),
})

export type BoostCandidatesFile = z.infer<typeof BoostCandidatesFileSchema>

// ---------------------------------------------------------------------------
// Boost Stats (runtime introspection)
// ---------------------------------------------------------------------------

export interface BoostStats {
  totalCandidates: number
  promotedCount: number
  totalHits: number
  totalFallbacks: number
  candidates: {
    purposeId: string
    promoted: boolean
    hitCount: number
    consecutiveMatches: number
    fallbackCount: number
  }[]
}
