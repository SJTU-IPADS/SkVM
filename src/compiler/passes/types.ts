import type { LLMProvider } from "../../providers/types.ts"
import type { TCP } from "../../core/types.ts"
import type { ArtifactBag, ArtifactKey, ArtifactStore } from "../artifacts.ts"
import type { FailureContext } from "../types.ts"

/**
 * A skill-source mutation produced by a pass. Applied to `workDir/SKILL.md`
 * and the orchestrator's in-memory copy after the pass returns.
 *
 * - `rewrite` replaces SKILL.md entirely (used by rewrite-skill, which has
 *   already written the file via its agent loop — the orchestrator uses this
 *   payload as the canonical compiledSkill going forward).
 * - `append` concatenates onto the existing SKILL.md (used by extract-
 *   parallelism to add the parallel-execution hints section).
 */
export type SkillPatch =
  | { kind: "rewrite"; content: string }
  | { kind: "append"; content: string }

export interface PassContext {
  skillName: string
  /** Per-job working directory the pass operates on (already populated). */
  workDir: string
  /** Current canonical SKILL.md text. Reflects all skillPatches applied so far. */
  skillContent: string
  tcp: TCP
  model: string
  harness: string
  /** Provider already wrapped with a per-pass logger that also tracks token usage. */
  provider: LLMProvider
  failureContext?: FailureContext
  artifacts: ArtifactStore
}

export interface PassOutput {
  /** Artifacts produced by this run; merged into the store and persisted. */
  artifacts: Partial<ArtifactBag>
  /** Optional SKILL.md mutation. If present, applied after the run. */
  skillPatch?: SkillPatch
  /** Iterations used (when applicable, e.g. agent-loop passes). */
  iterations?: number
}

/**
 * A self-contained unit of compile work. The orchestrator topologically sorts
 * enabled passes by their consumes/produces relations and dispatches them in
 * order.
 */
export interface CompilerPass {
  /** Stable string id used by `--pass=<id>`, registry lookup, and log files. */
  id: string
  /**
   * Numeric id used by `--pass=1,2,3` and as a segment of `passTag`. Numbers
   * are appended sequentially as new passes are added; once assigned a number
   * is never reused.
   */
  number: number
  description: string
  consumes: ArtifactKey[]
  produces: ArtifactKey[]
  run(ctx: PassContext): Promise<PassOutput>
}
