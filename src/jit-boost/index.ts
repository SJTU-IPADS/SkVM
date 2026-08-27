/**
 * JIT-boost — Code Solidification for Speed
 *
 * Identifies repetitive code patterns in skill execution and short-circuits
 * LLM calls by executing pre-computed templates directly.
 *
 * Two stages:
 * 1. Candidate generation: headless agent analyzes skill → boost-candidates.json
 *    (concrete agent backend selected via core/headless-agent.ts)
 * 2. Runtime hooks: afterLLM monitors for matches, beforeLLM executes promoted templates
 *
 * Storage: proposals/jit-boost/{skillId}/ — model/harness agnostic.
 */

import type { RuntimeHooks } from "../runtime/types.ts"
import type { LLMProvider } from "../providers/types.ts"
import type { BoostCandidate, SolidificationState, BoostStats } from "./types.ts"
import { Solidifier } from "./solidifier.ts"
import { loadBoostCandidates, loadSolidificationState } from "./persistence.ts"
import { createLogger } from "../core/logger.ts"

const log = createLogger("jit-boost")

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BoostConfig {
  /** Skill identifier — used to resolve paths in proposals/jit-boost/{skillId}/ */
  skillId: string
  /** Consecutive matches needed for promotion (default: 3) */
  promotionThreshold?: number
  /** Consecutive fallbacks before demotion (default: 3) */
  demotionThreshold?: number
  /** Model for LLM-based param extraction (e.g., "anthropic/claude-haiku-4.5"). If set, enables LLM fallback. */
  extractModel?: string
  /**
   * How consecutive matches are counted for promotion.
   *
   * `"run"` counts per agent RUN: a real transcript wraps its signature-bearing
   * call in setup noise (`pip install`, `ls`), and per-tool-call counting can
   * never accumulate a streak through that — the gate essentially never fires.
   * `"tool-call"` (the default, unchanged) counts per matching call.
   *
   * With `"run"`, the hooks close each run via the runtime's `afterRun`, so an
   * adapter that installs them needs no extra wiring.
   */
  matchGranularity?: "tool-call" | "run"
}

export interface BoostHookResult {
  /** Install these hooks in any agent adapter */
  hooks: RuntimeHooks
  /** Export current solidification state for persistence */
  exportState(): SolidificationState
  /** Get runtime stats (promoted count, hit rates, etc.) */
  getStats(): BoostStats
}

/**
 * Create JIT-boost hooks for any agent adapter.
 *
 * Loads boost candidates and solidification state from proposals/jit-boost/{skillId}/,
 * returns hooks that monitor + promote + execute code templates.
 *
 * Zero LLM calls at runtime — all analysis happens at candidate generation time.
 */
export async function createBoostHooks(config: BoostConfig): Promise<BoostHookResult> {
  const { skillId } = config

  const candidates = await loadBoostCandidates(skillId)
  const savedState = await loadSolidificationState(skillId)

  if (candidates.length === 0 && !savedState) {
    log.info(`No boost candidates for ${skillId} — returning no-op hooks`)
    return createNoopResult(skillId)
  }

  // Create LLM provider for param extraction if extractModel is specified
  let llmProvider: LLMProvider | undefined
  if (config.extractModel) {
    const { createProviderForModel } = await import("../providers/registry.ts")
    llmProvider = createProviderForModel(config.extractModel)
    log.info(`LLM param extraction enabled (model=${config.extractModel}, provider=${llmProvider.name})`)
  }

  const solidifier = new Solidifier(candidates, {
    savedState: savedState ?? undefined,
    promotionThreshold: config.promotionThreshold,
    demotionThreshold: config.demotionThreshold,
    llmProvider,
    matchGranularity: config.matchGranularity,
  })

  const hooks: RuntimeHooks = {
    beforeLLM: [solidifier.createBeforeLLMHook()],
    afterLLM: [solidifier.createAfterLLMHook()],
    // finalizeRun must happen exactly once per run, and it is a no-op unless
    // matchGranularity is "run". Owning it here is what makes the run-granular
    // gate usable from an adapter — otherwise every caller has to remember, and
    // the one production path (bench) simply never called it.
    afterRun: [async () => { solidifier.finalizeRun() }],
  }

  log.info(`Boost hooks created for ${skillId} (${candidates.length} candidates)`)

  return {
    hooks,
    exportState: () => solidifier.exportState(skillId),
    getStats: () => buildStats(solidifier),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createNoopResult(skillId: string): BoostHookResult {
  return {
    hooks: {},
    exportState: () => ({
      skillId,
      entries: [],
      updatedAt: new Date().toISOString(),
    }),
    getStats: () => ({
      totalCandidates: 0,
      promotedCount: 0,
      totalHits: 0,
      totalFallbacks: 0,
      candidates: [],
    }),
  }
}

function buildStats(solidifier: Solidifier): BoostStats {
  const entries = solidifier.getEntries()
  return {
    totalCandidates: entries.length,
    promotedCount: entries.filter((e) => e.state.promoted).length,
    totalHits: entries.reduce((sum, e) => sum + e.state.hitCount, 0),
    totalFallbacks: entries.reduce((sum, e) => sum + e.state.fallbackCount, 0),
    candidates: entries.map((e) => ({
      purposeId: e.candidate.purposeId,
      promoted: e.state.promoted,
      hitCount: e.state.hitCount,
      consecutiveMatches: e.state.consecutiveMatches,
      fallbackCount: e.state.fallbackCount,
    })),
  }
}

// Re-export key components
export { runSolidifyExperiment, invocationRecordsToCsv, SolidifyCasesFileSchema } from "./experiment.ts"
export type { InvocationRecord, SolidifyRunOptions, SolidifyRunResult, RefinementEvent } from "./experiment.ts"
export { refineCandidateFromObservations } from "./candidates.ts"
export { Solidifier } from "./solidifier.ts"
export { generateBoostCandidates, generateCandidatesFromConvLogs, generateTemplates } from "./candidates.ts"
export { loadBoostCandidates, saveBoostCandidates, loadSolidificationState, saveSolidificationState, solidificationStatePath } from "./persistence.ts"
export type { BoostCandidate, SolidificationState, SolidificationEntry, BoostStats } from "./types.ts"
export { BoostCandidateSchema, SolidificationStateSchema } from "./types.ts"
