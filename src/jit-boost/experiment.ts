/**
 * Code-solidification experiment driver.
 *
 * Drives a sequence of *varying* prompts ("invocations") per case against a
 * hook-capable adapter with a per-case Solidifier, and records one CSV row
 * per invocation for downstream analysis.
 *
 * Each case gets a fresh Solidifier loaded with ONLY the candidate matching
 * its purposeId — two cases sharing a skill must not short-circuit each other
 * (their keywords overlap). No solidification state is persisted; the whole
 * experiment is reproducible from boost-candidates.json alone.
 */

import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { z } from "zod"
import type { AgentAdapter } from "../core/types.ts"
import type { RuntimeHooks } from "../runtime/types.ts"
import type { LLMProvider } from "../providers/types.ts"
import type { BoostCandidate } from "./types.ts"
import { getTmpDir } from "../core/config.ts"
import { copyDirRecursive } from "../core/fs-utils.ts"
import { loadSkill, buildSkillBundle, copySkillBundle } from "../core/skill-loader.ts"
import { TASK_FILE_DEFAULTS } from "../core/ui-defaults.ts"
import { Solidifier } from "./solidifier.ts"
import { loadBoostCandidates } from "./persistence.ts"
import { createLogger } from "../core/logger.ts"

const log = createLogger("solidify-experiment")

// ---------------------------------------------------------------------------
// Case spec
// ---------------------------------------------------------------------------

export const SolidifyCaseSchema = z.object({
  /** Row label in the output CSV (e.g. "weather-current") */
  id: z.string(),
  /** Candidate purposeId this case exercises (must match boost-candidates.json) */
  purposeId: z.string(),
  /** Skill directory, absolute or relative to the spec file */
  skill: z.string(),
  /** One prompt per invocation — vary them; that's the point of the experiment */
  prompts: z.array(z.string()).min(1),
  /** Optional fixtures dir (relative to the spec file) copied into each fresh workDir; an _setup.sh inside is executed */
  fixturesDir: z.string().optional(),
})

export const SolidifyCasesFileSchema = z.object({
  cases: z.array(SolidifyCaseSchema).min(1),
})

export type SolidifyCasesFile = z.infer<typeof SolidifyCasesFileSchema>
export type SolidifyCaseSpec = z.infer<typeof SolidifyCaseSchema>

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface InvocationRecord {
  case: string
  invocation: number
  method: "LLM" | "JIT"
  /** LLM rows: adapter run time. JIT rows: param extraction + template execution. */
  latency_ms: number
  /** LLM rows: adapter run tokens. JIT rows: param-extraction tokens (0 for regex). */
  tokens_in: number
  tokens_out: number
  purpose: string
  skill: string
  /** RunResult.runStatus for LLM-path rows; "ok" for served rows */
  runStatus: string
  /** Whether the case's candidate was promoted at the END of this invocation */
  promoted: boolean
}

export interface SolidifyRunOptions {
  specPath: string
  model: string
  adapter: AgentAdapter
  maxSteps?: number
  timeoutMs?: number
  /** Cap invocations per case (default: all prompts) */
  invocations?: number
  promotionThreshold?: number
  demotionThreshold?: number
  matchGranularity?: "tool-call" | "run"
  /** Optional model for LLM param extraction. Leave unset for regex-only (served rows stay 0-token). */
  extractModel?: string
  keepWorkDirs?: boolean
  /**
   * Online candidate refinement: when a candidate has missed `refineAfterMisses`
   * runs in total but the agent's tool calls were observable, rewrite the
   * candidate from those observations (matched-run variants included, so an
   * alternating pattern is seen whole). Promotion is re-earned from zero after
   * a refinement (the Solidifier resets the counters), so the safety gate is
   * never bypassed.
   */
  onlineRefine?: boolean
  /** Model for the refinement rewrite (default: candidates.ts ANALYSIS_MODEL) */
  refineModel?: string
  /** Total missed runs before a refinement attempt (default: 3) */
  refineAfterMisses?: number
  /** Maximum refinements per case (default: 1) */
  maxRefines?: number
  /**
   * Credit the refined signature's coverage of already-observed runs toward
   * promotion (trailing consecutive runs; the gate replayed against history).
   * A signature that covers the last N observed runs promotes immediately.
   */
  retroPromote?: boolean
  /** Test seam: replaces the LLM-backed refinement call */
  refineFn?: (args: {
    candidate: BoostCandidate
    observations: { tool: string; content: string; run?: number }[]
    prompts: string[]
  }) => Promise<{ candidate: BoostCandidate | null; costUsd: number }>
}

export interface RefinementEvent {
  case: string
  purposeId: string
  /** Invocation after which the refinement was applied (1-based) */
  invocation: number
  /** The rewritten candidate now in effect */
  candidate: BoostCandidate
  /** What the refinement LLM call cost. */
  costUsd: number
}

export interface SolidifyRunResult {
  records: InvocationRecord[]
  refinements: RefinementEvent[]
  /**
   * Cases that threw. Their records up to the failure are still in `records`;
   * the run is partial, and the caller must not report it as a clean sweep.
   */
  failures: Array<{ case: string; error: string }>
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export async function runSolidifyExperiment(opts: SolidifyRunOptions): Promise<SolidifyRunResult> {
  const specPath = path.resolve(opts.specPath)
  const specDir = path.dirname(specPath)
  const spec = SolidifyCasesFileSchema.parse(await Bun.file(specPath).json())

  const refineFn = opts.refineFn ?? (async (args: {
    candidate: BoostCandidate
    observations: { tool: string; content: string; run?: number }[]
    prompts: string[]
  }) => {
    const { refineCandidateFromObservations } = await import("./candidates.ts")
    const result = await refineCandidateFromObservations({ ...args, model: opts.refineModel })
    return { candidate: result.candidate, costUsd: result.cost }
  })

  const adapterConfig = {
    model: opts.model,
    maxSteps: opts.maxSteps ?? TASK_FILE_DEFAULTS.maxSteps,
    timeoutMs: opts.timeoutMs ?? TASK_FILE_DEFAULTS.timeoutMs,
  }

  let llmProvider: LLMProvider | undefined
  if (opts.extractModel) {
    const { createProviderForModel } = await import("../providers/registry.ts")
    llmProvider = createProviderForModel(opts.extractModel)
    log.info(`LLM param extraction enabled (model=${opts.extractModel})`)
  }

  const records: InvocationRecord[] = []
  const refinements: RefinementEvent[] = []

  // One failing case must not discard the ones that already ran. A non-zero
  // `_setup.sh`, or a 429 on a refinement call at invocation 3 of 5, used to
  // throw straight out of this function — ending a multi-hour run with no CSV
  // written at all. Failures are recorded and the remaining cases still run;
  // the caller decides what a partial result is worth.
  const failures: Array<{ case: string; error: string }> = []

  for (const caseSpec of spec.cases) {
    try {
      await runCase(caseSpec)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(`[${caseSpec.id}] case failed: ${message}`)
      failures.push({ case: caseSpec.id, error: message })
    }
  }

  return { records, refinements, failures }

  async function runCase(caseSpec: SolidifyCaseSpec): Promise<void> {
    const skillDir = path.resolve(specDir, caseSpec.skill)
    const skill = await loadSkill(skillDir)
    const candidates = await loadBoostCandidates(skill.skillId)
    const candidate = candidates.find((c) => c.purposeId === caseSpec.purposeId)
    let refinesUsed = 0

    if (!candidate) {
      log.warn(
        `[${caseSpec.id}] no boost candidate for purposeId "${caseSpec.purposeId}" in skill "${skill.skillId}" ` +
        `(available: ${candidates.map((c) => c.purposeId).join(", ") || "none"}) — running the whole case on the LLM path. ` +
        `This is the promotion-gate "not solidifiable" branch; fix the purposeId in the spec if it's a mismatch.`,
      )
    }

    const solidifier = candidate
      ? new Solidifier([candidate], {
          promotionThreshold: opts.promotionThreshold,
          demotionThreshold: opts.demotionThreshold,
          matchGranularity: opts.matchGranularity ?? "run",
          llmProvider,
        })
      : null

    const hooks: RuntimeHooks = solidifier
      ? { beforeLLM: [solidifier.createBeforeLLMHook()], afterLLM: [solidifier.createAfterLLMHook()] }
      : {}

    const prompts = opts.invocations ? caseSpec.prompts.slice(0, opts.invocations) : caseSpec.prompts

    for (let i = 0; i < prompts.length; i++) {
      const workDir = await mkdtemp(path.join(getTmpDir(), `skvm-solidify-${caseSpec.id}-`))
      try {
        // Stage the skill's bundle files (scripts/, references/, …) exactly
        // like a bench run would — SKILL.md alone is not the skill, and both
        // the LLM baseline and any template may rely on shipped files.
        await copySkillBundle(skill, workDir)
        if (caseSpec.fixturesDir) {
          await copyDirRecursive(path.resolve(specDir, caseSpec.fixturesDir), workDir)
          const setupScript = path.join(workDir, "_setup.sh")
          if (await Bun.file(setupScript).exists()) {
            const proc = Bun.spawn(["bash", "_setup.sh"], { cwd: workDir, stdout: "pipe", stderr: "pipe" })
            const [exitCode, stderr] = await Promise.all([
              proc.exited,
              new Response(proc.stderr as ReadableStream).text(),
            ])
            if (exitCode !== 0) {
              throw new Error(`[${caseSpec.id}] _setup.sh failed (exit ${exitCode}): ${stderr.slice(0, 400)}`)
            }
          }
        }

        if ("setHooks" in opts.adapter && typeof (opts.adapter as { setHooks?: unknown }).setHooks === "function") {
          (opts.adapter as unknown as { setHooks(h: RuntimeHooks): void }).setHooks(hooks)
        }
        await opts.adapter.setup(adapterConfig)
        let runResult: Awaited<ReturnType<typeof opts.adapter.run>>
        try {
          runResult = await opts.adapter.run({
            prompt: prompts[i]!,
            workDir,
            skill: buildSkillBundle(skill, "inject"),
            taskId: `${caseSpec.id}-${i + 1}`,
            timeoutMs: adapterConfig.timeoutMs,
          })
        } finally {
          // A thrown run must not leak adapter setup into the next invocation.
          await opts.adapter.teardown()
        }

        const serves = solidifier?.drainServeEvents() ?? []
        solidifier?.finalizeRun()
        const promoted = solidifier?.getEntries()[0]?.state.promoted ?? false
        const serve = serves[0]
        // Served rows carry the FULL serve path: param extraction (regex or LLM)
        // plus template execution — anything less overstates the saving.
        //
        // And they ADD to the run's own usage rather than replacing it. The hook
        // fires before every provider call, so a serve can land at step k > 0,
        // after the loop has already spent tokens (an extraction that misses,
        // then a tool call that creates the file the template needed, then a
        // serve). Reporting only the extraction cost there credited the run with
        // a saving it did not make: one probe recorded 4 tokens for a run that
        // really cost 1000 in / 50 out. For a first-call serve the run's own
        // usage is zero, so summing is always right.
        const latencyMs = Math.round(
          serve ? runResult.durationMs + serve.durationMs + serve.extractionMs : runResult.durationMs,
        )

        records.push({
          case: caseSpec.id,
          invocation: i + 1,
          method: serve ? "JIT" : "LLM",
          latency_ms: latencyMs,
          tokens_in: runResult.tokens.input + (serve?.extractionTokens.input ?? 0),
          tokens_out: runResult.tokens.output + (serve?.extractionTokens.output ?? 0),
          purpose: caseSpec.purposeId,
          skill: skill.skillId,
          runStatus: runResult.runStatus ?? "ok",
          promoted,
        })
        log.info(
          `[${caseSpec.id}] invocation ${i + 1}/${prompts.length}: ${serve ? "JIT" : "LLM"} ` +
          `${latencyMs}ms promoted=${promoted}`,
        )

        // Online refinement: the candidate keeps missing but we observed what
        // the agent did instead — rewrite it from those observations.
        if (
          opts.onlineRefine && solidifier && !promoted &&
          refinesUsed < (opts.maxRefines ?? 1)
        ) {
          const currentCandidate = solidifier.getEntries()[0]!.candidate
          const miss = solidifier.getMissInfo(caseSpec.purposeId)
          if (miss.missRuns >= (opts.refineAfterMisses ?? 3) && miss.observations.length > 0) {
            log.info(`[${caseSpec.id}] refining candidate after ${miss.missRuns} missed runs (${miss.observations.length} observations)`)
            const refined = await refineFn({
              candidate: currentCandidate,
              observations: miss.observations,
              prompts: prompts.slice(0, i + 1),
            })
            refinesUsed++
            if (refined.candidate) {
              solidifier.replaceCandidate(caseSpec.purposeId, refined.candidate, { creditObservedRuns: opts.retroPromote })
              refinements.push({ case: caseSpec.id, purposeId: caseSpec.purposeId, invocation: i + 1, candidate: refined.candidate, costUsd: refined.costUsd })
              log.info(`[${caseSpec.id}] candidate refined ($${refined.costUsd.toFixed(4)}) — ${opts.retroPromote ? "gate replayed against observed runs" : "promotion counters reset, gate re-armed"}`)
            } else {
              log.info(`[${caseSpec.id}] refinement rejected or judged not solidifiable ($${refined.costUsd.toFixed(4)}) — keeping original candidate`)
            }
          }
        }
      } finally {
        if (!opts.keepWorkDirs) await rm(workDir, { recursive: true, force: true })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CSV output
// ---------------------------------------------------------------------------

export function invocationRecordsToCsv(records: InvocationRecord[]): string {
  const header = "case,invocation,method,latency_ms,tokens_in,tokens_out,purpose,skill,run_status,promoted"
  const rows = records.map((r) =>
    [r.case, r.invocation, r.method, r.latency_ms, r.tokens_in, r.tokens_out, r.purpose, r.skill, r.runStatus, r.promoted].join(","),
  )
  return [header, ...rows].join("\n") + "\n"
}
