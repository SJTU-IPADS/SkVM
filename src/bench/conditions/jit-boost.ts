import path from "node:path"
import type { RunResult } from "../../core/types.ts"
import { emptyTokenUsage } from "../../core/types.ts"
import { evaluateAll } from "../../framework/evaluator.ts"
import { contentHash, parseSkillMeta, buildSkillBundleFromContent } from "../../core/skill-loader.ts"
import { createLogger } from "../../core/logger.ts"
import { resolveCandidateGenTimeout } from "../../core/timeouts.ts"
import type { JitRunReport, ConditionResult } from "../types.ts"
import type { ConditionRunner } from "./types.ts"
import { prepareWorkDir } from "./run-condition.ts"
import { computeWeightedScore, buildEvalDetails } from "./scoring.ts"
import { concatSkillContents, combinedSkillId } from "./staging.ts"

const log = createLogger("bench-conditions")

/**
 * Run a task with JIT-boost code solidification.
 *
 * Flow:
 * 1. Warmup run (no hooks) — collects a conv log of actual agent tool calls
 * 2. Generate boost candidates from the warmup conv log (loose regex signatures)
 * 3. Create boost hooks and run remaining iterations with solidification enabled
 *
 * No dependency on TCP, compiler, or profiler. The only condition that does
 * not go through the shared `runCondition` scaffold: it owns a multi-run loop
 * that drives the adapter directly (hooks must persist across runs) and
 * assembles its result from the final run. It also ignores `ctx.evalOptions`
 * — jit-boost never defers LLM-judge evaluation because its feedback loop
 * needs synchronous scores.
 */
export const jitBoostRunner: ConditionRunner = {
  async run(ctx): Promise<ConditionResult> {
    const { task, adapter, adapterConfig, skills, evaluatorConfig, jitRuns, cliTimeoutMs } = ctx
    const skillContent = concatSkillContents(skills)
    const skillId = combinedSkillId(skills)
    const skillDir = skills[0]!.skillDir

    const { createBoostHooks, generateCandidatesFromConvLogs, generateBoostCandidates, saveSolidificationState, solidificationStatePath } = await import("../../jit-boost/index.ts")
    const { getJitBoostDir } = await import("../../proposals/storage.ts")

    log.info(`[jit-boost] ${task.id} with skill ${skillId} (${jitRuns} runs)`)

    if (jitRuns < 2) {
      log.warn(`[jit-boost] jitRuns=${jitRuns} is too low — need at least 2 (1 warmup + 1 with hooks)`)
    }

    const jitRunReports: JitRunReport[] = []
    let lastRunResult: RunResult | null = null
    const outputDir = getJitBoostDir(skillId)

    const jitBoostSkillBundle = buildSkillBundleFromContent(
      skillContent,
      parseSkillMeta(skillContent, skillDir),
      ctx.skillMode,
    )

    // -----------------------------------------------------------------------
    // Step 1: Warmup run (no hooks) — collect conv log of actual agent code
    // -----------------------------------------------------------------------
    let warmupLogPath: string
    {
      log.info(`[jit-boost] ${task.id} warmup run (no hooks)`)
      const workDir = await prepareWorkDir(task)
      const convLog = await ctx.createConvLog("jit-boost-warmup")
      warmupLogPath = convLog.filePath

      try {
        // Clear any existing hooks for warmup
        if ("setHooks" in adapter && typeof adapter.setHooks === "function") {
          adapter.setHooks({})
        }
        await adapter.setup(adapterConfig)
        const runResult = await adapter.run({
          prompt: task.prompt,
          workDir,
          skill: jitBoostSkillBundle,
          convLog,
          timeoutMs: adapterConfig.timeoutMs,
        })
        await adapter.teardown()

        lastRunResult = { ...runResult, workDir }

        const evalResults = await evaluateAll(task.eval, { ...runResult, workDir }, evaluatorConfig)
        const { overallScore: score } = computeWeightedScore(buildEvalDetails(evalResults), task.gradingWeights)

        jitRunReports.push({
          runIndex: 0,
          score,
          durationMs: runResult.durationMs,
          llmDurationMs: runResult.llmDurationMs ?? 0,
          tokens: runResult.tokens,
          promotions: 0,
        })
      } catch (err) {
        log.error(`[jit-boost] ${task.id} warmup failed: ${err}`)
        // Synchronize lastRunResult with the failed attempt — otherwise the
        // final ConditionResult would inherit a stale 'ok' from a prior
        // successful run (or from `null`, which falls back to 'adapter-crashed'
        // — in this case correctly, since warmup is the first attempt).
        lastRunResult = {
          text: "",
          steps: [],
          tokens: emptyTokenUsage(),
          cost: 0,
          durationMs: 0,
          llmDurationMs: 0,
          workDir,
          runStatus: "adapter-crashed",
          statusDetail: `jit-boost warmup threw: ${String(err).slice(0, 200)}`,
        }
        jitRunReports.push({
          runIndex: 0,
          score: 0,
          durationMs: 0,
          llmDurationMs: 0,
          tokens: emptyTokenUsage(),
          promotions: 0,
        })
      }
    }

    // -----------------------------------------------------------------------
    // Step 2: Generate candidates from warmup conv log
    // -----------------------------------------------------------------------
    const candidateGenTimeoutMs = resolveCandidateGenTimeout({ cli: cliTimeoutMs })

    // Phase 1: Identify patterns from conv log
    log.info(`[jit-boost] Phase 1: Identifying patterns from warmup conv log...`)
    const genResult = await generateCandidatesFromConvLogs([warmupLogPath], outputDir)

    if (genResult.candidates.length > 0) {
      log.info(`[jit-boost] Phase 1: ${genResult.candidates.length} patterns identified (cost=$${genResult.cost.toFixed(4)})`)

      // Phase 2: Generate templates with full skill context
      log.info(`[jit-boost] Phase 2: Generating templates with skill context...`)
      const { generateTemplates } = await import("../../jit-boost/candidates.ts")
      const templateResult = await generateTemplates(genResult.candidates, genResult.snippets, skillDir, outputDir, { timeoutMs: candidateGenTimeoutMs })
      log.info(`[jit-boost] Phase 2: ${templateResult.candidates.length} templates generated (cost=$${templateResult.cost.toFixed(4)})`)
    } else {
      // Fallback to doc-based generation
      log.warn(`[jit-boost] No candidates from conv log — falling back to doc-based generation`)
      const fallback = await generateBoostCandidates(skillDir, outputDir, { timeoutMs: candidateGenTimeoutMs })
      log.info(`[jit-boost] Fallback generated ${fallback.candidates.length} candidates (cost=$${fallback.cost.toFixed(4)})`)
    }

    // Delete stale solidification state so hooks start fresh with new candidates
    try { await (await import("node:fs/promises")).unlink(solidificationStatePath(skillId)) } catch { /* not found is fine */ }

    // -----------------------------------------------------------------------
    // Step 3: Create boost hooks and run remaining iterations
    // -----------------------------------------------------------------------
    const boost = await createBoostHooks({ skillId, extractModel: adapterConfig.model })

    for (let i = 1; i < jitRuns; i++) {
      log.info(`[jit-boost] ${task.id} run ${i + 1}/${jitRuns} (with hooks)`)
      const workDir = await prepareWorkDir(task)
      const convLog = await ctx.createConvLog(`jit-boost-run-${i}`)

      try {
        if ("setHooks" in adapter && typeof adapter.setHooks === "function") {
          adapter.setHooks(boost.hooks)
        }
        await adapter.setup(adapterConfig)
        const runResult = await adapter.run({
          prompt: task.prompt,
          workDir,
          skill: jitBoostSkillBundle,
          convLog,
          timeoutMs: adapterConfig.timeoutMs,
        })
        await adapter.teardown()

        lastRunResult = { ...runResult, workDir }

        const evalResults = await evaluateAll(task.eval, { ...runResult, workDir }, evaluatorConfig)
        const { overallScore: score } = computeWeightedScore(buildEvalDetails(evalResults), task.gradingWeights)

        jitRunReports.push({
          runIndex: i,
          score,
          durationMs: runResult.durationMs,
          llmDurationMs: runResult.llmDurationMs ?? 0,
          tokens: runResult.tokens,
          promotions: boost.getStats().promotedCount,
        })
      } catch (err) {
        log.error(`[jit-boost] ${task.id} run ${i + 1} failed: ${err}`)
        // Synchronize lastRunResult with the failed attempt. Without this, a
        // late-iteration crash would leave lastRunResult pointing at the prior
        // successful run, and the final ConditionResult would inherit
        // runStatus='ok' — making the row look evaluable when it should be
        // tainted. See round-5 Codex review.
        lastRunResult = {
          text: "",
          steps: [],
          tokens: emptyTokenUsage(),
          cost: 0,
          durationMs: 0,
          llmDurationMs: 0,
          workDir,
          runStatus: "adapter-crashed",
          statusDetail: `jit-boost run ${i + 1}/${jitRuns} threw: ${String(err).slice(0, 200)}`,
        }
        jitRunReports.push({
          runIndex: i,
          score: 0,
          durationMs: 0,
          llmDurationMs: 0,
          tokens: emptyTokenUsage(),
          promotions: 0,
        })
      }
    }

    // Persist solidification state
    await saveSolidificationState(skillId, boost.exportState())

    // jit-boost does NOT go through runTask(), so it skips the runner gate.
    // Enforce the same invariant here: when the final run's adapter didn't
    // return 'ok', we cannot trust the score (it was computed by evaluateAll on
    // a possibly-timed-out workDir). Zero the score so every downstream reader
    // — per-task markdown table, console summary, multi-model ranking — sees
    // the taint, not an inflated residual pass.
    const lastStatus = lastRunResult?.runStatus ?? "adapter-crashed"
    const finalRun = jitRunReports[jitRunReports.length - 1]
    const finalScore = lastStatus === "ok" ? (finalRun?.score ?? 0) : 0

    return {
      condition: "jit-boost",
      score: finalScore,
      pass: lastStatus === "ok" && finalScore >= 0.5,
      evalDetails: [],
      tokens: lastRunResult?.tokens ?? emptyTokenUsage(),
      cost: lastRunResult?.cost ?? 0,
      durationMs: jitRunReports.reduce((sum, r) => sum + r.durationMs, 0),
      llmDurationMs: jitRunReports.reduce((sum, r) => sum + r.llmDurationMs, 0),
      steps: lastRunResult?.steps.length ?? 0,
      skillId,
      skillContentHash: contentHash(skillContent),
      jitRuns: jitRunReports,
      jitPromotions: boost.getStats().promotedCount,
      runStatus: lastStatus,
      ...(lastRunResult?.statusDetail ? { statusDetail: lastRunResult.statusDetail } : {}),
    }
  },
}
