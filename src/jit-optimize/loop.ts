/**
 * JIT-Optimize loop runner.
 *
 * Orchestrates the multi-round optimization flow:
 *   - resolve task source into train + test sets (unless log source)
 *   - run both sets per round, collect evidence
 *   - call the optimizer with TRAIN evidence only (test stays held out)
 *   - snapshot the result into a proposal round
 *   - repeat until rounds/convergence
 *   - pick best round by test score (fallback: train score)
 *   - optionally auto-apply best round to the original skill folder
 *
 * The optimizer is agent-based; the concrete backend is chosen via
 * core/headless-agent.ts.
 */

import path from "node:path"
import { mkdir, rm, copyFile, readdir, stat } from "node:fs/promises"
import type { EvaluatorConfig } from "../framework/evaluator.ts"
import { evaluateAll } from "../framework/evaluator.ts"
// Side-effect import: ensures every custom evaluator (python-grade, ...) is
// registered before any task is evaluated.
import "../bench/evaluators/index.ts"
import type { AdapterConfig, TokenUsage, AgentAdapter } from "../core/types.ts"
import { emptyTokenUsage, addTokenUsage, sumTokenUsages } from "../core/types.ts"
import { estimateCost } from "../core/cost.ts"
import type {
  JitOptimizeConfig,
  JitOptimizeResult,
  RoundResult,
  Evidence,
  HistoryEntry,
  TaskSource,
  CostSlice,
} from "./types.ts"
import { emptyCostSlice } from "./types.ts"
import { runOptimizer } from "./optimizer.ts"
import {
  resolveTrainTestTasks,
  resolveSyntheticTasks,
  loadEvidencesFromLogs,
  copyFixturesInto,
  type RunnableTask,
} from "./task-source.ts"
import {
  snapshotWorkDir,
  buildEvidenceCriteria,
  buildRunMeta,
  readConversationLog,
  buildConversationLogFromSteps,
} from "./evidence.ts"
import { removeWorkspace } from "./workspace.ts"
import { copySkillDir } from "../core/fs-utils.ts"
import { loadSkill, copySkillBundle, type ResolvedSkill } from "../core/skill-loader.ts"
import { createProposal, finalizeProposal } from "../proposals/storage.ts"
import { createProviderForModel } from "../providers/registry.ts"
import { isProviderError } from "../providers/errors.ts"
import { isHeadlessAgentError } from "../core/headless-agent.ts"
import { type AdapterName, createAdapter } from "../adapters/registry.ts"
import { TASK_FILE_DEFAULTS } from "../core/ui-defaults.ts"
import { ConversationLog } from "../core/conversation-logger.ts"
import { createLogger } from "../core/logger.ts"
import { createSpinner } from "../core/spinner.ts"
import { Pool } from "../core/concurrency.ts"

const log = createLogger("jit-optimize-loop")

// ---------------------------------------------------------------------------
// Infra-blocked termination signal
// ---------------------------------------------------------------------------

/**
 * Internal control-flow exception. Thrown by `assertRoundNotAllInfraTainted`
 * when every evidence in a round comes back tainted (adapter timeout / crash
 * on every task). Caught by the main round loop, which converts it into a
 * graceful `meta.json.status = 'infra-blocked'` termination instead of a
 * bare throw that would leave the proposal half-finalized on disk. See
 * `docs/skvm/jit-optimize-abstain-path.md` for the termination contract.
 */
export class InfraBlockedRoundError extends Error {
  readonly roundLabel: string
  readonly reason: string
  readonly blockedIds: string[]
  /**
   * Evidences collected before `assertRoundNotAllInfraTainted` fired. Each
   * one carries `runMeta` with the target-agent spend from the (tainted)
   * run, so catch sites can preserve real cost via `sumTargetAgentStats`
   * instead of zeroing the round's spend. Always present; empty array
   * when no partial data was available.
   */
  readonly partialEvidence: Evidence[]
  constructor(
    roundLabel: string,
    reason: string,
    blockedIds: string[],
    partialEvidence: Evidence[],
  ) {
    super(`${roundLabel}: every evidence was infrastructure-tainted — ${reason}`)
    this.name = "InfraBlockedRoundError"
    this.roundLabel = roundLabel
    this.reason = reason
    this.blockedIds = blockedIds
    this.partialEvidence = partialEvidence
  }
}

// ---------------------------------------------------------------------------
// Selection tuning constants
// ---------------------------------------------------------------------------

/**
 * Default minimum primary-score improvement a non-baseline round must clear
 * to beat round 0. Rationale: with runsPerTask=1 and N=2 tasks, empirical
 * std on stable skills is 0.03–0.08, so 0.02 is a permissive floor that
 * still blocks floating-point wins. Overridable via `LoopConfig.minImprovement`.
 */
export const DEFAULT_MIN_IMPROVEMENT = 0.02

/**
 * Primary-score difference below which two rounds are treated as tied in
 * `pickBestRound`. Strictly tighter than `DEFAULT_MIN_IMPROVEMENT` so the
 * epsilon band never leaks past the baseline gate. Not exposed to config
 * because tuning this without simultaneously tuning MIN_IMPROVEMENT creates
 * incoherent selection.
 */
export const SELECTION_EPSILON = 0.005

/**
 * Max per-task score drop tolerated from round 0 before `pickBestRound`
 * excludes a non-baseline round. Rationale: at runsPerTask=1 single-task
 * scoring noise is typically 0.1–0.15; 0.2 is the "this is definitely a
 * real regression, not noise" threshold. Overridable via
 * `LoopConfig.perTaskRegressionTolerance`.
 */
export const DEFAULT_PER_TASK_REGRESSION_TOLERANCE = 0.2

/**
 * Default minimum fractional drop in `targetAgent.costUsd` that counts as
 * a meaningful cost reduction when primary scores are within the score
 * equivalence band of baseline. 15% is wide enough to ignore adapter
 * cost-estimation noise (typically 5–10% between runs on the same skill)
 * and tight enough to admit real cost wins from optimizer edits that
 * trim redundant tool calls / context. Overridable via
 * `LoopConfig.minCostReductionRatio`.
 */
export const DEFAULT_MIN_COST_REDUCTION_RATIO = 0.15

// ---------------------------------------------------------------------------
// Per-round evidence pair (train + test)
// ---------------------------------------------------------------------------

interface RoundEvidences {
  train: Evidence[]
  test: Evidence[]
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function runLoop(config: JitOptimizeConfig): Promise<JitOptimizeResult> {
  const rounds = config.loop?.rounds ?? 1
  const runsPerTask = config.loop?.runsPerTask ?? 1
  const requestedTaskConcurrency = Math.max(1, config.loop?.taskConcurrency ?? 1)
  const convergenceThreshold = config.loop?.convergence ?? 0.95
  const minImprovement = config.loop?.minImprovement ?? DEFAULT_MIN_IMPROVEMENT
  const perTaskRegressionTolerance =
    config.loop?.perTaskRegressionTolerance ?? DEFAULT_PER_TASK_REGRESSION_TOLERANCE
  const minCostReductionRatio =
    config.loop?.minCostReductionRatio ?? DEFAULT_MIN_COST_REDUCTION_RATIO
  const scoreEquivalenceBand =
    config.loop?.scoreEquivalenceBand ?? minImprovement
  const keepAllRounds = config.delivery?.keepAllRounds ?? true
  const autoApply = config.delivery?.autoApply ?? false

  const skillDir = path.resolve(config.skillDir)
  const skillName = resolveSkillName(skillDir)

  const optimizerModel = config.optimizer.model
  const targetModel = config.targetAdapter.model
  const harness = config.targetAdapter.harness

  const proposal = await createProposal({
    skillName,
    skillDir,
    harness,
    optimizerModel,
    targetModel,
    source: describeSource(config.taskSource),
  })
  log.info(`Proposal: ${proposal.id}`)
  log.info(`Proposal dir: ${proposal.dir}`)

  // Effective concurrency = requested, then clamp for two cases that can't
  // benefit from > 1:
  //   - jiuwenclaw: one per-machine sidecar. Spawning N adapter instances
  //     just forces them to take turns on the same file lock while paying
  //     sidecar start/stop overhead.
  //   - config.adapter override (test path): only one adapter instance is
  //     available, so we can't hand distinct instances to concurrent workers.
  //     The whole point of the refactor is per-worker adapter isolation.
  let taskConcurrency = requestedTaskConcurrency
  if (taskConcurrency > 1 && harness === "jiuwenclaw") {
    log.warn(
      `jiuwenclaw has a single per-machine sidecar; clamping ` +
      `--task-concurrency from ${taskConcurrency} to 1.`,
    )
    taskConcurrency = 1
  }
  if (taskConcurrency > 1 && config.adapter !== undefined) {
    log.warn(
      `config.adapter override supplies a single instance; clamping ` +
      `--task-concurrency from ${taskConcurrency} to 1.`,
    )
    taskConcurrency = 1
  }

  // Eval provider drives LLM-judge calls and synthetic task generation. Judge
  // cost is estimated via the pricing table because providers don't surface
  // dollar cost on complete() responses. evalJudgeModel defaults to the
  // optimizer model since by default the eval provider uses the same backend.
  const evalLLMProvider = config.evalProvider ?? createProviderForModel(optimizerModel)
  const judgeModelForCost = config.evalJudgeModel ?? optimizerModel

  // Execution-log branch: no task running, single optimizer call
  if (config.taskSource.kind === "execution-log") {
    return runLogOnly(config, proposal)
  }

  // Synthetic / real branch: multi-round with task execution.
  // (targetAdapter is now required at the type level for every source.)

  // Resolve train + test tasks once (stable across rounds).
  // Cost of synthesizing tasks (if any) is the "setup cost" — it's attributed
  // to the session, not to any round.
  const taskResSp = createSpinner(
    config.taskSource.kind === "synthetic-task"
      ? "Generating synthetic tasks..."
      : "Resolving tasks...",
  )
  let resolved: Awaited<ReturnType<typeof resolveTrainTestTasks>>
  try {
    resolved = await resolveTrainTestTasks(config.taskSource, {
      skillDir,
      optimizerModel,
      proposalDir: proposal.dir,
      runLabel: "run-0",
    })
    taskResSp.succeed(
      `Resolved ${resolved.train.length} train + ${resolved.test.length} test task(s)`,
    )
  } catch (err) {
    taskResSp.fail("Task resolution failed")
    throw err
  }
  const { test: testTasks, testIsSeparate } = resolved
  // `currentTrainTasks` is mutable because the synthetic-task source can
  // swap in a fresh train probe between rounds (problem-2 no-edit → regen
  // path). The test set is frozen for the entire session — cross-round
  // score comparisons in pickBestRound depend on it. `runBoth` /
  // `runTrainOnly` read this variable through closure, so a re-assignment
  // takes effect on the next call.
  let currentTrainTasks: RunnableTask[] = resolved.train
  if (currentTrainTasks.length === 0) {
    throw new Error("jit-optimize: no train tasks resolved from source")
  }
  // `setupCost` absorbs every probe-provisioning LLM spend: the initial
  // task-gen call, any regeneration task-gen calls, and the re-eval
  // target-agent + judge calls that follow a regeneration. All of these
  // are "between rounds" — attributing them to any one round would
  // distort per-round cost accounting.
  const setupCost: CostSlice & { calls: number } = { ...resolved.genCost }
  // Running list of every synthetic prompt shown to the generator in this
  // session (initial round + any regenerations). Passed back to
  // `resolveSyntheticTasks` so each regeneration is told to produce
  // something genuinely different. Includes test prompts too so the fresh
  // train probe does not merely duplicate the frozen test set.
  const priorPrompts: string[] = [
    ...currentTrainTasks.map((t) => t.prompt),
    ...(testIsSeparate ? testTasks.map((t) => t.prompt) : []),
  ]
  // Cumulative count of no-edit rounds seen this session. Not reset on a
  // successful edit — the budget is total, not consecutive. When it
  // reaches 2, the next no-edit round exits the loop regardless of source.
  let totalNoEditCount = 0
  // Set to true once the synthetic source swaps in a fresh train probe.
  // From that point on, `trainScore` values across rounds come from
  // different batches and are no longer comparable — `pickBestRound`
  // must skip its train-score tiebreak.
  let trainRegenerated = false
  log.info(
    `Resolved ${currentTrainTasks.length} train task(s) and ${testTasks.length} test task(s)` +
      (testIsSeparate ? " (separate test set)" : " (no separate test set — test reuses train)"),
  )
  if (setupCost.calls > 0) {
    log.info(
      `Setup cost (task generation): ${setupCost.calls} call(s), tokens=${setupCost.tokens.input}/${setupCost.tokens.output}, $${setupCost.costUsd.toFixed(4)}`,
    )
  }

  // Build a pool of target adapters. Each concurrent worker checks out
  // its own instance — the AgentAdapter contract does not require
  // setup/run/teardown to be reentrant, so sharing one instance across
  // concurrent jobs would violate the same invariant bench/orchestrator
  // and profiler already uphold. Pool size matches the (post-clamp)
  // concurrency bound and naturally doubles as the concurrency limiter.
  const adapterInstances: AgentAdapter[] = config.adapter
    ? [config.adapter]
    : Array.from({ length: taskConcurrency }, () => createAdapter(harness))
  const adapterPool = new Pool(adapterInstances)
  const adapterConfig: AdapterConfig = {
    model: config.targetAdapter.model,
    maxSteps: config.targetAdapter.adapterConfig?.maxSteps ?? TASK_FILE_DEFAULTS.maxSteps,
    timeoutMs: config.targetAdapter.adapterConfig?.timeoutMs ?? 300_000,
    apiKey: config.targetAdapter.adapterConfig?.apiKey,
    providerOptions: config.targetAdapter.adapterConfig?.providerOptions,
  }

  /**
   * Evaluation config factory — shared between `runBoth` (per-round train +
   * test) and `runTrainOnly` (between-rounds re-evaluation on a fresh
   * synthetic train probe). The judge-cost accumulator is passed in so the
   * caller decides whether the cost lands in a round's `evalJudge` slice
   * or in the session-level `setupCost`.
   */
  const makeRoundEvalConfig = (
    judgeAcc: CostSlice & { calls: number },
  ): EvaluatorConfig => ({
    llmProvider: evalLLMProvider,
    onJudgeUsage: (tokens, costUsd) => {
      judgeAcc.tokens = addTokenUsage(judgeAcc.tokens, tokens)
      judgeAcc.costUsd += estimateCost(judgeModelForCost, tokens, costUsd)
      judgeAcc.calls += 1
    },
  })

  /**
   * Run both train and test sets once, capturing judge-cost events into the
   * provided accumulator. Each round gets its own accumulator so per-round
   * bucket totals are independent. Reads `currentTrainTasks` through
   * closure so mid-session probe swaps take effect immediately.
   */
  const runBoth = async (
    skillDirForRun: string,
    roundLabel: string,
    judgeAcc: CostSlice & { calls: number },
  ): Promise<RoundEvidences> => {
    const roundEvalConfig = makeRoundEvalConfig(judgeAcc)
    const skillForRun = await loadSkill(skillDirForRun)
    // The shared adapterPool doubles as the concurrency limiter: when
    // testIsSeparate, train and test both drain the same pool via
    // Promise.all, so the union of in-flight runs never exceeds
    // taskConcurrency across both sets.
    const runSet = (tasks: RunnableTask[], setLabel: "train" | "test") =>
      runTasksForRound({
        tasks,
        skill: skillForRun,
        runsPerTask,
        adapterPool,
        adapterConfig,
        evalConfig: roundEvalConfig,
        logDir: path.join(proposal.dir, `${roundLabel}-agent-logs`, setLabel),
        setLabel,
      })
    if (!testIsSeparate) {
      // If the test set is the same as train (by reference), skip rerun and reuse.
      // Judge cost for the "reused" test evaluation is a duplicate of train's; we
      // do NOT re-run evaluateAll here, so judgeAcc already captures all calls.
      const trainEv = await runSet(currentTrainTasks, "train")
      assertRoundNotAllInfraTainted(roundLabel, trainEv, trainEv)
      return { train: trainEv, test: trainEv }
    }
    const [trainEv, testEv] = await Promise.all([
      runSet(currentTrainTasks, "train"),
      runSet(testTasks, "test"),
    ])
    assertRoundNotAllInfraTainted(roundLabel, trainEv, testEv)
    return { train: trainEv, test: testEv }
  }

  /**
   * Re-evaluate the given skill dir on `currentTrainTasks` only. Used by
   * the synthetic-regen path to feed the next round's optimizer with
   * evidence from the fresh probe. Fails loud if the entire probe batch
   * comes back infra-tainted, consistent with `runBoth`.
   */
  const runTrainOnly = async (
    skillDirForRun: string,
    roundLabel: string,
    judgeAcc: CostSlice & { calls: number },
  ): Promise<Evidence[]> => {
    const skillForRun = await loadSkill(skillDirForRun)
    const trainEv = await runTasksForRound({
      tasks: currentTrainTasks,
      skill: skillForRun,
      runsPerTask,
      adapterPool,
      adapterConfig,
      evalConfig: makeRoundEvalConfig(judgeAcc),
      logDir: path.join(proposal.dir, `${roundLabel}-agent-logs`, "train"),
      setLabel: "train",
    })
    assertRoundNotAllInfraTainted(roundLabel, trainEv, [])
    return trainEv
  }

  // Set when the session cannot produce a usable proposal and should
  // finalize with `meta.json.status = 'infra-blocked'` instead of running
  // `pickBestRound`. See `docs/skvm/jit-optimize-abstain-path.md`.
  let infraBlocked: null | {
    roundLabel: string
    reason: string
    blockedIds: string[]
  } = null

  // --- Round 0: baseline evaluation with original skill ---
  log.info(`\n=== Round 0 (baseline): evaluating original skill ===`)
  const round0JudgeCost: CostSlice & { calls: number } = { ...emptyCostSlice(), calls: 0 }
  const allRounds: RoundResult[] = []
  const roundTrainEvidences: Evidence[][] = []
  const history: HistoryEntry[] = []
  let currentSkillDir = skillDir

  // Persist round 0 as a full skill folder snapshot unconditionally — even
  // an infra-blocked session needs round-0 to exist so `skvm proposals`
  // tooling can readdir it.
  const round0Dir = path.join(proposal.dir, "round-0")
  await copySkillDir(skillDir, round0Dir)

  const baselineSp = createSpinner("Round 0 (baseline) — evaluating original skill...")

  try {
    const round0 = await runBoth(skillDir, "round-0", round0JudgeCost)
    const round0TrainScored = scoreEvidences(round0.train)
    const round0TestScored = testIsSeparate
      ? scoreEvidences(round0.test)
      : round0TrainScored
    const round0TrainScore = round0TrainScored.aggregate
    const round0TestScore = round0TestScored.aggregate
    const round0TrainPerTask = round0TrainScored.perTask
    const round0TestPerTask = round0TestScored.perTask
    const round0TrainPassTotal = passTotals(round0.train)
    const round0TestPassTotal = testIsSeparate ? passTotals(round0.test) : round0TrainPassTotal
    const round0TargetAgent = sumTargetAgentStats(
      round0.train,
      testIsSeparate ? round0.test : [],
    )

    allRounds.push({
      round: 0,
      isBaseline: true,
      trainScore: round0TrainScore,
      testScore: testIsSeparate ? round0TestScore : null,
      trainPassed: round0TrainPassTotal.passed,
      trainTotal: round0TrainPassTotal.total,
      testPassed: testIsSeparate ? round0TestPassTotal.passed : 0,
      testTotal: testIsSeparate ? round0TestPassTotal.total : 0,
      perTaskTrainScores: round0TrainPerTask,
      perTaskTestScores: round0TestPerTask,
      targetAgent: round0TargetAgent,
      evalJudge: round0JudgeCost,
      optimizer: null,
      historyEntry: null,
    })
    roundTrainEvidences.push(round0.train)
    baselineSp.succeed(`Round 0 (baseline): train=${round0TrainScore?.toFixed(3) ?? "n/a"}${testIsSeparate ? ` test=${round0TestScore?.toFixed(3) ?? "n/a"}` : ""}`)
    logRoundLine(0, round0TrainScore, testIsSeparate ? round0TestScore : null, null, null, true)
  } catch (err) {
    if (err instanceof InfraBlockedRoundError) {
      baselineSp.fail("Round 0 (baseline): infra-blocked")
      log.warn(
        `Round 0 baseline evidence is entirely infra-tainted: ${err.reason}. ` +
        `Finalizing proposal with status=infra-blocked and skipping optimization.`,
      )
      infraBlocked = { roundLabel: err.roundLabel, reason: err.reason, blockedIds: err.blockedIds }
      const blockedRound0Entry: HistoryEntry = {
        timestamp: new Date().toISOString(),
        round: 0,
        rootCause: "",
        reasoning: `all-tainted: ${err.reason}`,
        changes: [],
        changedFiles: [],
        confidence: 0,
        trainScore: null,
        testScore: null,
        improved: null,
        infraBlocked: true,
        blockedEvidenceIds: err.blockedIds,
        blockedReason: err.reason,
      }
      history.push(blockedRound0Entry)
      // Push a null-scored round-0 marker so finalize sees a non-empty
      // rounds array (renderAnalysis + meta.roundCount both assume it).
      // Preserve whatever target-agent tokens were already spent on the
      // tainted runs — assertRoundNotAllInfraTainted hands them back via
      // err.partialEvidence so cost accounting stays honest.
      allRounds.push(unscoredRound({
        round: 0,
        isBaseline: true,
        optimizer: null,
        historyEntry: blockedRound0Entry,
        targetAgent: sumTargetAgentStats(err.partialEvidence, []),
        evalJudge: round0JudgeCost,
      }))
    } else {
      baselineSp.fail("Round 0 (baseline): failed")
      throw err
    }
  }

  const round0Result = allRounds[0]
  const primaryScore0 = round0Result
    ? (testIsSeparate ? round0Result.testScore : round0Result.trainScore)
    : null
  const alreadyConverged = primaryScore0 !== null && primaryScore0 >= convergenceThreshold

  if (infraBlocked) {
    log.info(`Skipping optimization rounds (round 0 infra-blocked).`)
  } else if (alreadyConverged) {
    log.info(`Baseline already above convergence threshold (${convergenceThreshold}); skipping optimization`)
  } else {
    // --- Rounds 1..N ---
    for (let round = 1; round <= rounds; round++) {
      log.info(`\n=== Round ${round}/${rounds} ===`)

      const roundOptSp = createSpinner(`Round ${round}/${rounds} — optimizing skill...`)
      const prevTrainEvidences = roundTrainEvidences[round - 1]!
      const optimizerLogDir = path.join(proposal.dir, `round-${round}-optimizer-logs`)
      let optimizeResult: Awaited<ReturnType<typeof runOptimizer>>
      try {
        optimizeResult = await runOptimizer(
          {
            skillDir: currentSkillDir,
            evidences: prevTrainEvidences,
            history: history.length > 0 ? history : undefined,
          },
          {
            model: optimizerModel,
            logDir: optimizerLogDir,
            timeoutMs: 600_000,
          },
        )
        roundOptSp.succeed(`Round ${round}/${rounds} — optimizer: ${optimizeResult.changed ? `${optimizeResult.actualChangedFiles.length} file(s) changed` : "no changes"}`)
      } catch (err) {
        roundOptSp.fail(`Round ${round}/${rounds} — optimizer failed`)
        throw err
      }

      const historyEntry: HistoryEntry = {
        timestamp: new Date().toISOString(),
        round,
        rootCause: optimizeResult.submission.rootCause,
        reasoning: optimizeResult.submission.reasoning,
        changes: optimizeResult.submission.changes ?? [],
        changedFiles: optimizeResult.actualChangedFiles,
        confidence: optimizeResult.submission.confidence,
        trainScore: null,
        testScore: null,
        improved: null,
      }
      const optimizerSlice: CostSlice = {
        tokens: optimizeResult.tokens,
        costUsd: optimizeResult.cost,
      }
      const prevRound = allRounds[allRounds.length - 1]!

      // Optimizer explicit abstain — treated as terminal infra-blocked.
      // Retry policy: 0 (user decision). The loop does NOT re-run evidence
      // or re-call the optimizer; it finalizes with status=infra-blocked
      // and lets the next jit-optimize invocation (or a manual bench
      // rerun) handle the actual infra fix.
      if (optimizeResult.submission.infraBlocked) {
        await removeWorkspace(optimizeResult.workspaceDir)
        const reason = optimizeResult.submission.blockedReason ?? "(no reason provided)"
        const ids = optimizeResult.submission.blockedEvidenceIds ?? []
        log.warn(
          `Round ${round}: optimizer abstained (infraBlocked). Reason: ${reason}. ` +
          `Finalizing proposal with status=infra-blocked.`,
        )
        historyEntry.infraBlocked = true
        historyEntry.blockedEvidenceIds = ids
        historyEntry.blockedReason = reason
        history.push(historyEntry)

        // Sidecar directory for audit: submission.json + README.md, but no
        // round-{N}/ main directory (bestRound stays at 0).
        const blockedDir = path.join(proposal.dir, `round-${round}-blocked`)
        await mkdir(blockedDir, { recursive: true })
        await Promise.all([
          Bun.write(
            path.join(blockedDir, "submission.json"),
            JSON.stringify(optimizeResult.submission, null, 2),
          ),
          Bun.write(
            path.join(blockedDir, "README.md"),
            `# Round ${round} — optimizer abstained\n\n` +
            `The optimizer emitted \`infraBlocked: true\` and did not edit the skill.\n\n` +
            `**Reason:** ${reason}\n\n` +
            `**Blocked evidence ids:** ${ids.length > 0 ? ids.join(", ") : "(none listed)"}\n\n` +
            `This proposal's \`meta.json.status\` is set to \`infra-blocked\`; bench's\n` +
            `\`jit-optimized\` condition will skip this proposal and fall through to the\n` +
            `next non-blocked one (or skip the skill entirely if none exists).\n`,
          ),
        ])

        // Preserve the optimizer spend for this abstain round so it shows
        // up in analysis.md and totalCost. No target-agent/judge cost here
        // — the abstain happened at submission time, before any eval ran.
        allRounds.push(unscoredRound({
          round,
          isBaseline: false,
          optimizer: optimizerSlice,
          historyEntry,
        }))

        infraBlocked = {
          roundLabel: `round-${round}`,
          reason,
          blockedIds: ids,
        }
        break
      }

      if (!optimizeResult.changed) {
        // Unscored attempt: the optimizer produced no file edits — either
        // because it explicitly declared `noChanges: true`, or because the
        // subprocess finished without writing a usable submission.json.
        // Record a null-scored round (no eval ran, no new evidence) so
        // pickBestRound's existing null filter excludes it naturally. Do
        // NOT fabricate evidence from the previous round; that would
        // silently inject stale scores and let a failed round displace
        // round-0.
        //
        // The round directory IS materialized — contents are a copy of
        // currentSkillDir (unchanged from the previous round). Every
        // entry in allRounds must have an addressable on-disk
        // counterpart: `skvm proposals accept --round=N` lets users
        // override the engine's bestRound pick, and `deployProposal`
        // readdir's `round-N/` unconditionally. An unpopulated round
        // directory would turn that path into an ENOENT. Disk cost is
        // negligible (skills are small) and the duplicated content is
        // semantically correct: a user who manually deploys this round
        // receives the same skill they would have without the session.
        await removeWorkspace(optimizeResult.workspaceDir)

        if (optimizeResult.submission.noChanges) {
          log.info(`Round ${round}: optimizer declared noChanges`)
        } else {
          log.info(
            `Round ${round}: optimizer produced no file changes ` +
            `(check round-${round}-optimizer-logs/ — likely failed)`,
          )
        }

        const roundDir = path.join(proposal.dir, `round-${round}`)
        await copySkillDir(currentSkillDir, roundDir)

        history.push(historyEntry)
        allRounds.push(unscoredRound({
          round,
          isBaseline: false,
          optimizer: optimizerSlice,
          historyEntry,
        }))

        logRoundLine(
          round,
          null,
          null,
          prevRound.trainScore,
          testIsSeparate ? prevRound.testScore : null,
          testIsSeparate,
        )

        totalNoEditCount += 1

        if (shouldRegenerateSyntheticTrain(
          config.taskSource,
          optimizeResult,
          totalNoEditCount,
          testIsSeparate,
        )) {
          // `--rounds N` is an independent hard cap. If we regenerate on
          // the final iteration, `continue` exits the for loop without
          // any subsequent round consuming the fresh probe — the
          // optimizer never sees it, so the regen is a no-op. Refuse to
          // spend a round on a probe nobody will look at; fall through
          // to the normal termination path instead.
          if (round >= rounds) {
            log.info(
              `Round ${round}: would regenerate synthetic probe but ` +
              `--rounds=${rounds} leaves no retry slot; stopping`,
            )
            break
          }

          // Narrow for the static type checker — shouldRegenerateSyntheticTrain
          // already guarantees the kind.
          const syntheticSource = config.taskSource as Extract<
            TaskSource,
            { kind: "synthetic-task" }
          >
          log.info(
            `Round ${round}: synthetic source + explicit noChanges — ` +
            `regenerating train probe (cumulative no-edit count=${totalNoEditCount}/2)`,
          )

          // 1. Generate a fresh synthetic train batch. Diversity constraint
          //    is weak: priorPrompts is shown to the generator with a
          //    "don't repeat these" instruction. The agent-backed generator
          //    retries once on failure internally and throws loudly if both
          //    attempts produce nothing — no silent empty-return footgun.
          const regenTaskSp = createSpinner(`Round ${round}/${rounds} — regenerating synthetic tasks...`)
          let regen: Awaited<ReturnType<typeof resolveSyntheticTasks>>
          try {
            regen = await resolveSyntheticTasks(
              syntheticSource.trainCount,
              {
                skillDir,
                optimizerModel,
                proposalDir: proposal.dir,
                runLabel: `run-regen-round-${round}`,
              },
              priorPrompts,
            )
            regenTaskSp.succeed(`Round ${round}/${rounds} — regenerated ${regen.tasks.length} synthetic task(s)`)
          } catch (err) {
            regenTaskSp.fail(`Round ${round}/${rounds} — synthetic task regeneration failed`)
            throw err
          }
          if (regen.tasks.length === 0) {
            // Unreachable in practice — the generator throws on empty result.
            // Kept as a defensive break so a future signature change can't
            // silently convert into an infinite no-edit loop.
            log.warn(
              `Round ${round}: regeneration produced 0 tasks; cannot continue`,
            )
            break
          }
          setupCost.tokens = addTokenUsage(setupCost.tokens, regen.genCost.tokens)
          setupCost.costUsd += regen.genCost.costUsd
          setupCost.calls += regen.genCost.calls

          currentTrainTasks = regen.tasks
          trainRegenerated = true
          for (const t of regen.tasks) priorPrompts.push(t.prompt)

          // 2. Re-evaluate the current skill (whichever currentSkillDir
          //    points at — original or last edited round) on the fresh
          //    train probe. Judge cost lands directly in setupCost.
          const regenEvalSp = createSpinner(`Round ${round}/${rounds} — re-evaluating on fresh probe...`)
          let newTrainEv: Evidence[]
          try {
            newTrainEv = await runTrainOnly(
              currentSkillDir,
              `round-${round}-regen`,
              setupCost,
            )
            regenEvalSp.succeed(`Round ${round}/${rounds} — re-evaluation complete`)
          } catch (err) {
            if (err instanceof InfraBlockedRoundError) {
              regenEvalSp.fail(`Round ${round}/${rounds} — re-evaluation infra-blocked`)
              log.warn(
                `Round ${round} regen: all evidence infra-tainted: ${err.reason}. ` +
                `Finalizing proposal with status=infra-blocked.`,
              )
              // Fold target-agent spend from tainted regen runs into
              // setupCost — the normal happy-path folds re-eval cost
              // into setupCost a few lines down, so the infra-blocked
              // exit must do the same or the tainted tokens vanish
              // from the session total.
              const taintedReEval = sumTargetAgentStats(err.partialEvidence, [])
              setupCost.tokens = addTokenUsage(setupCost.tokens, taintedReEval.tokens)
              setupCost.costUsd += taintedReEval.costUsd
              infraBlocked = { roundLabel: err.roundLabel, reason: err.reason, blockedIds: err.blockedIds }
              break
            }
            regenEvalSp.fail(`Round ${round}/${rounds} — re-evaluation failed`)
            throw err
          }

          // 3. Fold re-eval target-agent cost into setupCost. The next
          //    round's runBoth will run its own target-agent pass on the
          //    new edit — that cost is attributed to that round's
          //    targetAgent slice, not here. No double counting.
          const reEvalTargetAgent = sumTargetAgentStats(newTrainEv, [])
          setupCost.tokens = addTokenUsage(setupCost.tokens, reEvalTargetAgent.tokens)
          setupCost.costUsd += reEvalTargetAgent.costUsd

          // 4. Feed fresh evidence forward so the next round's optimizer
          //    sees evidence from the new probe, not the stale one.
          roundTrainEvidences.push(newTrainEv)
          continue
        }

        log.info(`Round ${round}: no changes, stopping`)
        break
      }

      // Edit path: snapshot the workspace and evaluate the new skill on
      // both train and test sets. Each round has its own judge cost
      // accumulator, populated inside runBoth.
      const roundDir = path.join(proposal.dir, `round-${round}`)
      await copySkillDir(optimizeResult.workspaceDir, roundDir)
      await removeWorkspace(optimizeResult.workspaceDir)

      log.info(`Round ${round}: optimizer changed ${optimizeResult.actualChangedFiles.length} file(s)`)

      const roundJudgeCost: CostSlice & { calls: number } = { ...emptyCostSlice(), calls: 0 }
      let newEvidences: RoundEvidences
      const roundEvSp = createSpinner(`Round ${round}/${rounds} — collecting evidence...`)
      try {
        newEvidences = await runBoth(roundDir, `round-${round}`, roundJudgeCost)
        roundEvSp.succeed(`Round ${round}/${rounds} — evidence collected`)
      } catch (err) {
        roundEvSp.fail(`Round ${round}/${rounds} — evidence collection failed`)
        if (err instanceof InfraBlockedRoundError) {
          log.warn(
            `Round ${round}: all evidence infra-tainted while evaluating the optimizer's edit: ${err.reason}. ` +
            `Finalizing proposal with status=infra-blocked; the edit from this round is preserved in round-${round}/.`,
          )
          historyEntry.infraBlocked = true
          historyEntry.blockedEvidenceIds = err.blockedIds
          historyEntry.blockedReason = err.reason
          history.push(historyEntry)
          // Preserve the already-spent optimizer, target-agent, and
          // partial judge cost for this round so sumAllRounds() doesn't
          // silently drop it from analysis.md and the returned totalCost.
          // trainScore/testScore stay null so pickBestRound ignores this
          // round, but its cost buckets must still be accounted for —
          // target-agent spend comes from err.partialEvidence's runMeta,
          // which carries tokens from the tainted runs.
          allRounds.push(unscoredRound({
            round,
            isBaseline: false,
            optimizer: optimizerSlice,
            historyEntry,
            targetAgent: sumTargetAgentStats(err.partialEvidence, []),
            evalJudge: roundJudgeCost,
          }))
          infraBlocked = { roundLabel: err.roundLabel, reason: err.reason, blockedIds: err.blockedIds }
          break
        }
        throw err
      }

      const newTrainScored = scoreEvidences(newEvidences.train)
      const newTestScored = testIsSeparate
        ? scoreEvidences(newEvidences.test)
        : newTrainScored
      const newTrainScore = newTrainScored.aggregate
      const newTestScore = newTestScored.aggregate
      const newTrainPerTask = newTrainScored.perTask
      const newTestPerTask = newTestScored.perTask
      const trainPT = passTotals(newEvidences.train)
      const testPT = testIsSeparate ? passTotals(newEvidences.test) : trainPT
      const newTargetAgent = sumTargetAgentStats(
        newEvidences.train,
        testIsSeparate ? newEvidences.test : [],
      )

      historyEntry.trainScore = newTrainScore
      historyEntry.testScore = testIsSeparate ? newTestScore : null

      // Improvement: compare primary score (test if available, else
      // train) to the most recent SCORED round's primary. A no-edit
      // regen placeholder may sit immediately before this edit in
      // allRounds; comparing against it would leave `improved` unset
      // and wipe the anti-oscillation signal from the next optimizer
      // pass's history view. Walk back to the last real score instead.
      // Round 0 is always scored, so the walk is guaranteed to find
      // something; the `?? prevRound` fall-through is defensive.
      //
      // The threshold is the same `minImprovement` used by pickBestRound so
      // the "you improved, keep going" signal fed to the next optimizer
      // round and the "round N wins" signal used at selection time never
      // disagree. Pure `>` allowed noise-level wins through and drove the
      // optimizer into random walks — see the pickBestRound hardening doc.
      const lastScored = findLastScoredRound(allRounds, testIsSeparate) ?? prevRound
      const prevPrimary = testIsSeparate ? lastScored.testScore : lastScored.trainScore
      const newPrimary = testIsSeparate ? newTestScore : newTrainScore
      if (prevPrimary !== null && newPrimary !== null) {
        historyEntry.improved = newPrimary >= prevPrimary + minImprovement
      }

      history.push(historyEntry)
      roundTrainEvidences.push(newEvidences.train)

      allRounds.push({
        round,
        isBaseline: false,
        trainScore: newTrainScore,
        testScore: testIsSeparate ? newTestScore : null,
        trainPassed: trainPT.passed,
        trainTotal: trainPT.total,
        testPassed: testIsSeparate ? testPT.passed : 0,
        testTotal: testIsSeparate ? testPT.total : 0,
        perTaskTrainScores: newTrainPerTask,
        perTaskTestScores: newTestPerTask,
        targetAgent: newTargetAgent,
        evalJudge: roundJudgeCost,
        optimizer: optimizerSlice,
        historyEntry,
      })

      // Print line showing train and test scores with delta
      logRoundLine(
        round,
        newTrainScore,
        testIsSeparate ? newTestScore : null,
        lastScored.trainScore,
        testIsSeparate ? lastScored.testScore : null,
        testIsSeparate,
      )

      const primaryForConvergence = testIsSeparate ? newTestScore : newTrainScore
      if (primaryForConvergence !== null && primaryForConvergence >= convergenceThreshold) {
        log.info(
          `Converged: round ${round} ${testIsSeparate ? "test" : "train"} score ${primaryForConvergence.toFixed(3)} >= ${convergenceThreshold}`,
        )
        break
      }

      currentSkillDir = roundDir
    }
  }

  // --- Best round selection ---
  let bestRound: number
  let reason: string
  let excludedRounds: Record<number, string> = {}
  if (infraBlocked) {
    bestRound = 0
    reason = `infra-blocked at ${infraBlocked.roundLabel}: ${infraBlocked.reason}`
    log.warn(`\nProposal finalized as infra-blocked. bestRound=0, reason: ${reason}`)
  } else {
    const pick = pickBestRound(allRounds, {
      hasTest: testIsSeparate,
      trainScoresComparable: !trainRegenerated,
      convergenceThreshold,
      minImprovement,
      perTaskRegressionTolerance,
      minCostReductionRatio,
      scoreEquivalenceBand,
    })
    bestRound = pick.bestRound
    reason = pick.reason
    excludedRounds = pick.excludedRounds
    log.info(`\nBest round: ${bestRound} — ${reason}`)
    if (Object.keys(excludedRounds).length > 0) {
      for (const [round, why] of Object.entries(excludedRounds)) {
        log.info(`  excluded round ${round}: ${why}`)
      }
    }
  }

  if (!keepAllRounds && !infraBlocked) {
    for (const r of allRounds) {
      if (r.round === bestRound) continue
      await rm(path.join(proposal.dir, `round-${r.round}`), { recursive: true, force: true })
    }
    log.info(`Pruned non-best rounds (keepAllRounds=false)`)
  }

  await finalizeProposal(proposal.dir, {
    bestRound,
    bestRoundReason: reason,
    history,
    rounds: allRounds,
    selectionConfig: {
      minImprovement,
      epsilon: SELECTION_EPSILON,
      convergenceThreshold,
      perTaskRegressionTolerance,
      minCostReductionRatio,
      scoreEquivalenceBand,
    },
    excludedRounds,
    ...(infraBlocked
      ? {
          status: "infra-blocked" as const,
          blockedReason: infraBlocked.reason,
          blockedEvidenceIds: infraBlocked.blockedIds,
        }
      : {}),
  })

  // Never auto-apply from an infra-blocked session — the proposal tree is
  // explicitly marked "do not serve", and overwriting the live skill with
  // round-0 (the baseline copy) would be a no-op at best and destructive
  // at worst.
  if (autoApply && !infraBlocked) {
    const bestDir = path.join(proposal.dir, `round-${bestRound}`)
    if (await dirExists(bestDir)) {
      await applyBestToSkillDir(bestDir, skillDir)
      log.info(`Auto-applied round ${bestRound} → ${skillDir}`)
    }
  }

  const totalCost = sumAllRounds(allRounds, setupCost)

  return {
    proposalId: proposal.id,
    proposalDir: proposal.dir,
    bestRound,
    bestRoundReason: reason,
    rounds: allRounds,
    setupCost,
    totalCost,
  }
}

// ---------------------------------------------------------------------------
// Execution-log branch (no train/test, no evaluation)
// ---------------------------------------------------------------------------

async function runLogOnly(
  config: JitOptimizeConfig,
  proposal: { id: string; dir: string },
): Promise<JitOptimizeResult> {
  const skillDir = path.resolve(config.skillDir)
  const keepAllRounds = config.delivery?.keepAllRounds ?? true
  const autoApply = config.delivery?.autoApply ?? false

  const preEvidences = await loadEvidencesFromLogs(config.taskSource)
  if (preEvidences.length === 0) {
    throw new Error("jit-optimize: no evidences loaded from execution logs")
  }
  log.info(`Loaded ${preEvidences.length} evidence(s) from execution log(s)`)

  const logOptSp = createSpinner("Optimizing skill from execution logs...")
  const optimizerLogDir = path.join(proposal.dir, "round-1-optimizer-logs")
  let optimizeResult: Awaited<ReturnType<typeof runOptimizer>>
  try {
    optimizeResult = await runOptimizer(
      { skillDir, evidences: preEvidences },
      {
        model: config.optimizer.model,
        logDir: optimizerLogDir,
        timeoutMs: 600_000,
      },
    )
    logOptSp.succeed(`Optimizer: ${optimizeResult.changed ? `${optimizeResult.actualChangedFiles.length} file(s) changed` : "no changes"}`)
  } catch (err) {
    logOptSp.fail("Optimizer failed")
    throw err
  }

  // Persist round 0 (original) and round 1 (optimized)
  const round0Dir = path.join(proposal.dir, "round-0")
  await copySkillDir(skillDir, round0Dir)

  const roundDir = path.join(proposal.dir, "round-1")
  await copySkillDir(optimizeResult.workspaceDir, roundDir)
  await removeWorkspace(optimizeResult.workspaceDir)

  const historyEntry: HistoryEntry = {
    timestamp: new Date().toISOString(),
    round: 1,
    rootCause: optimizeResult.submission.rootCause,
    reasoning: optimizeResult.submission.reasoning,
    changes: optimizeResult.submission.changes ?? [],
    changedFiles: optimizeResult.actualChangedFiles,
    confidence: optimizeResult.submission.confidence,
    trainScore: null,
    testScore: null,
    improved: null,
  }

  const optimizerSlice: CostSlice = {
    tokens: optimizeResult.tokens,
    costUsd: optimizeResult.cost,
  }

  const allRounds: RoundResult[] = [
    unscoredRound({ round: 0, isBaseline: true, optimizer: null, historyEntry: null }),
    unscoredRound({ round: 1, isBaseline: false, optimizer: optimizerSlice, historyEntry }),
  ]

  const bestRound = optimizeResult.changed && !optimizeResult.submission.noChanges ? 1 : 0
  const reason = bestRound === 1
    ? "optimized version (log-only source — no evaluation)"
    : "no changes were made"

  if (!keepAllRounds && bestRound !== 0) {
    await rm(path.join(proposal.dir, "round-0"), { recursive: true, force: true })
  }
  if (!keepAllRounds && bestRound !== 1) {
    await rm(path.join(proposal.dir, "round-1"), { recursive: true, force: true })
  }

  await finalizeProposal(proposal.dir, {
    bestRound,
    bestRoundReason: reason,
    history: [historyEntry],
    rounds: allRounds,
  })

  if (autoApply && bestRound === 1) {
    await applyBestToSkillDir(path.join(proposal.dir, "round-1"), skillDir)
    log.info(`Auto-applied round 1 → ${skillDir}`)
  }

  // Log-only has no task gen and no eval
  const setupCost = { ...emptyCostSlice(), calls: 0 }
  const totalCost = sumAllRounds(allRounds, setupCost)

  return {
    proposalId: proposal.id,
    proposalDir: proposal.dir,
    bestRound,
    bestRoundReason: reason,
    rounds: allRounds,
    setupCost,
    totalCost,
  }
}

// ---------------------------------------------------------------------------
// Task execution helpers
// ---------------------------------------------------------------------------

export interface RunTasksParams {
  tasks: RunnableTask[]
  /** Resolved skill — used to read skillContent and copy bundle files into each run's workDir. */
  skill: ResolvedSkill
  runsPerTask: number
  /**
   * Pool of adapter instances. Each (task, runIdx) job checks out its
   * own adapter instance, uses it for the full setup→run→teardown cycle,
   * then releases it back. The pool's size doubles as the concurrency
   * limiter, and sharing one pool across multiple `runTasksForRound`
   * calls (e.g. train + test under `runBoth`) bounds their total
   * in-flight runs. Pass a 1-instance pool for strict serial behavior.
   *
   * Rationale: the `AgentAdapter` contract does not guarantee that
   * setup/run/teardown are reentrant, so concurrent jobs must not share
   * a single instance. bench/orchestrator.ts and profiler/index.ts hold
   * the same invariant.
   */
  adapterPool: Pool<AgentAdapter>
  adapterConfig: AdapterConfig
  evalConfig: EvaluatorConfig
  logDir: string
  setLabel: "train" | "test"
}

// Exported for unit tests of the runStatus gate (sweep G1) and task
// concurrency. Production callers go through `runLoop`.
export async function runTasksForRound(params: RunTasksParams): Promise<Evidence[]> {
  const { tasks, skill, runsPerTask, adapterPool, adapterConfig, evalConfig, logDir, setLabel } = params
  await mkdir(logDir, { recursive: true })

  const skillContent = skill.skillContent

  // Stable output index per (task, runIdx) pair lets concurrent jobs fill
  // `evidences` by slot while preserving input order — downstream pass/avg
  // computations and log file naming depend on that ordering.
  interface Job { task: RunnableTask; runIdx: number; outIdx: number }
  const jobs: Job[] = []
  let outIdx = 0
  for (const task of tasks) {
    for (let r = 0; r < runsPerTask; r++) {
      jobs.push({ task, runIdx: r, outIdx: outIdx++ })
    }
  }
  const evidences: Evidence[] = new Array(jobs.length)

  const runOne = async (job: Job, adapter: AgentAdapter): Promise<void> => {
    const { task, runIdx: r, outIdx } = job
    const runWorkDir = await createRunWorkDir(task)
    await copySkillBundle(skill, runWorkDir)
    try {
      const convLogPath = path.join(logDir, `${task.id}-run${r}.jsonl`)
      const convLog = new ConversationLog(convLogPath)

      await adapter.setup(adapterConfig)
      const result = await adapter.run({
        prompt: task.prompt,
        workDir: runWorkDir,
        skillContent,
        convLog,
        timeoutMs: adapterConfig.timeoutMs,
      })
      await adapter.teardown()
      await convLog.finalize()

      // Adapter-level gate: when the run wasn't 'ok' (timeout, crash, etc.),
      // we cannot trust the workDir as a proxy for agent behavior. Running
      // evaluateAll here would feed the optimizer per-criterion failure
      // scores derived from a contaminated workspace — exactly the
      // smoking-gun scenario in docs/skvm/jit-optimize-abstain-path.md.
      // Mirror the runner gate: skip eval and emit Evidence with a single
      // runtime-error criterion carrying infraError, the same shape the
      // catch block below produces. isInfraTaintedEvidence then picks it
      // up downstream.
      if (result.runStatus !== "ok") {
        const detail = result.statusDetail ?? `adapter runStatus=${result.runStatus}`
        log.warn(`[${setLabel}] task ${task.id} run ${r} adapter runStatus=${result.runStatus}, skipping eval`)
        const conversationLog = (await readConversationLog(convLogPath))
          ?? buildConversationLogFromSteps(result.steps, task.prompt)
        const workDirSnapshot = await snapshotWorkDir(runWorkDir)
        evidences[outIdx] = {
          taskId: task.id,
          taskPrompt: task.prompt,
          conversationLog,
          workDirSnapshot,
          criteria: [{
            id: "runtime-error",
            name: "runtime-error",
            method: "custom",
            weight: 1,
            score: 0,
            passed: false,
            details: detail,
            infraError: detail,
          }],
          runMeta: buildRunMeta(result),
        }
        return
      }

      const evalResults = await evaluateAll(
        task.eval,
        { ...result, workDir: runWorkDir },
        evalConfig,
      )

      const conversationLog = (await readConversationLog(convLogPath))
        ?? buildConversationLogFromSteps(result.steps, task.prompt)
      const workDirSnapshot = await snapshotWorkDir(runWorkDir)

      const criteria = buildEvidenceCriteria(evalResults)
      evidences[outIdx] = {
        taskId: task.id,
        taskPrompt: task.prompt,
        conversationLog,
        workDirSnapshot,
        criteria: criteria.length > 0 ? criteria : undefined,
        runMeta: buildRunMeta(result),
      }
    } catch (err) {
      const infra = isProviderError(err) || isHeadlessAgentError(err)
      const errMsg = err instanceof Error ? err.message : String(err)
      if (infra) {
        log.error(`[${setLabel}] task ${task.id} run ${r} infrastructure failure: ${errMsg}`)
      } else {
        log.warn(`[${setLabel}] task ${task.id} run ${r} failed: ${err}`)
      }
      evidences[outIdx] = {
        taskId: task.id,
        taskPrompt: task.prompt,
        conversationLog: [],
        workDirSnapshot: { files: new Map() },
        criteria: [{
          id: "runtime-error",
          name: "runtime-error",
          method: "custom",
          weight: 1,
          score: 0,
          passed: false,
          details: errMsg,
          ...(infra ? { infraError: errMsg } : {}),
        }],
      }
    } finally {
      await rm(runWorkDir, { recursive: true, force: true })
    }
  }

  await Promise.all(jobs.map(async (job) => {
    const adapter = await adapterPool.acquire()
    try {
      await runOne(job, adapter)
    } finally {
      adapterPool.release(adapter)
    }
  }))

  return evidences
}

async function createRunWorkDir(task: RunnableTask): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const dir = await mkdtemp(path.join(tmpdir(), `jit-optimize-run-${task.id}-`))
  await copyFixturesInto(dir, task.fixturesDir)
  return dir
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/**
 * An evidence is "infra-tainted" if ANY of its criteria could not run
 * because of an infrastructure failure (provider down, auth, headless
 * subprocess crash). One bad criterion is enough to poison the whole
 * run — the aggregate score is meaningless if part of the evaluation
 * couldn't actually execute. Also treat a run whose adapter errored as
 * tainted when the underlying error was infra, which manifests as a
 * `runtime-error` criterion carrying `infraError`.
 */
export function isInfraTaintedEvidence(ev: Evidence): boolean {
  if (!ev.criteria) return false
  return ev.criteria.some((c) => c.infraError !== undefined)
}

/**
 * Throw `InfraBlockedRoundError` when every evidence in a round is
 * infra-tainted. The main round loop catches this and converts it into a
 * graceful `infra-blocked` proposal finalization. Without this check the
 * loop would pretend the round "scored 0" and feed hallucinated evidence
 * to the optimizer — which then spirals trying to "fix" infrastructure
 * problems by editing the skill.
 */
export function assertRoundNotAllInfraTainted(
  roundLabel: string,
  trainEv: Evidence[],
  testEv: Evidence[],
): void {
  // When !testIsSeparate, runBoth passes the same array twice; dedupe so
  // blockedEvidenceIds enumerates distinct Evidence instances only. Set
  // identity is correct here — each Evidence object is constructed exactly
  // once by runTasksForRound.
  const seen = new Set<Evidence>()
  const all: Evidence[] = []
  for (const ev of [...trainEv, ...testEv]) {
    if (seen.has(ev)) continue
    seen.add(ev)
    all.push(ev)
  }
  if (all.length === 0) return
  const allTainted = all.every(isInfraTaintedEvidence)
  if (!allTainted) return
  const firstInfra = all
    .flatMap((ev) => ev.criteria ?? [])
    .find((c) => c.infraError !== undefined)
  const reason = firstInfra?.infraError ?? "unknown infrastructure error"
  // Engine-assigned indices match positions in `all`, which reflects
  // distinct Evidence instances. Optimizer-produced blockedEvidenceIds use
  // the same flat 0..N-1 numbering — surfaced to the optimizer through
  // the "Evidence Index" column in PER_TASK_SUMMARY.md and the header
  // of every task-first run-N.md.
  const blockedIds: string[] = []
  for (let i = 0; i < all.length; i++) {
    if (isInfraTaintedEvidence(all[i]!)) blockedIds.push(String(i))
  }
  throw new InfraBlockedRoundError(roundLabel, reason, blockedIds, all)
}

/**
 * Task-grouped scoring of an evidence set in one pass. Returns both the
 * cross-task aggregate (equal weight per task) and the per-task mean map.
 * Callers in `runLoop` need both at round-construction time — computing
 * them separately would group the same evidences twice.
 *
 * Procedure: group evidences by `taskId`; within each group, drop
 * infra-tainted runs and average the remaining `scoreFromCriteria` values
 * into a per-task mean. Tasks whose runs are all tainted or all score null
 * are omitted from both the per-task map and the aggregate denominator —
 * partial survival still represents the task, but doesn't let "task with
 * more surviving runs" count more than once across tasks.
 *
 * This is the semantic fix that makes `pickBestRound`'s per-task gate
 * honest: without task-first grouping, a round with one hot task and one
 * cold task can score the same as one with two lukewarm tasks, and the
 * optimizer's bias toward rewriting the hot one looks like free improvement.
 */
export function scoreEvidences(
  evidences: Evidence[],
): { aggregate: number | null; perTask: Record<string, number> } {
  const perTask: Record<string, number> = {}
  for (const [taskId, runs] of groupByTask(evidences)) {
    const mean = meanOfCleanRuns(runs)
    if (mean !== null) perTask[taskId] = mean
  }
  const taskIds = Object.keys(perTask)
  if (taskIds.length === 0) return { aggregate: null, perTask }
  let total = 0
  for (const id of taskIds) total += perTask[id]!
  return { aggregate: total / taskIds.length, perTask }
}

/** Thin wrapper for callers that only need the cross-task aggregate. */
export function avgScore(evidences: Evidence[]): number | null {
  return scoreEvidences(evidences).aggregate
}

/** Thin wrapper for callers that only need the per-task mean map. */
export function avgScoreByTask(evidences: Evidence[]): Record<string, number> {
  return scoreEvidences(evidences).perTask
}

function groupByTask(evidences: Evidence[]): Map<string, Evidence[]> {
  const groups = new Map<string, Evidence[]>()
  for (const ev of evidences) {
    const bucket = groups.get(ev.taskId)
    if (bucket) bucket.push(ev)
    else groups.set(ev.taskId, [ev])
  }
  return groups
}

function meanOfCleanRuns(runs: Evidence[]): number | null {
  let total = 0
  let count = 0
  for (const ev of runs) {
    if (isInfraTaintedEvidence(ev)) continue
    const score = scoreFromCriteria(ev.criteria)
    if (score === null) continue
    total += score
    count++
  }
  return count > 0 ? total / count : null
}

export function scoreFromCriteria(criteria: Evidence["criteria"]): number | null {
  if (!criteria) return null
  if (criteria.length === 0) return null
  // Drop infra-tainted criteria; reweight the rest so the remaining scores
  // still sum to 1.0 of their collective effective weight.
  const clean = criteria.filter((c) => c.infraError === undefined)
  if (clean.length === 0) return null
  const totalWeight = clean.reduce((s, c) => s + c.weight, 0)
  if (totalWeight <= 0) return null
  let total = 0
  for (const c of clean) total += c.score * (c.weight / totalWeight)
  return total
}

function passTotals(evidences: Evidence[]): { passed: number; total: number } {
  let passed = 0
  let total = 0
  for (const ev of evidences) {
    if (!ev.criteria || ev.criteria.length === 0) continue
    if (isInfraTaintedEvidence(ev)) continue  // excluded from both numerator and denominator
    total += 1
    if (ev.criteria.every((c) => c.passed)) passed += 1
  }
  return { passed, total }
}

/**
 * Build a `RoundResult` for a round that was never scored — abstain, no-edit,
 * infra-blocked eval, or log-only placeholders. Centralises the "every
 * null/empty field every such round must have" so individual push sites
 * can't drift (forgetting `perTaskTestScores: {}` once was the exact risk
 * the Layer 2 gate's no-op fallback documents).
 *
 * `targetAgent` defaults to an empty slice but can be overridden by callers
 * that have real partial spend to preserve — notably the infra-blocked eval
 * catch sites, where `InfraBlockedRoundError.partialEvidence` carries the
 * target-agent tokens already paid for tainted runs. Zeroing them silently
 * would under-report session cost in exactly the cases an audit cares about.
 * `evalJudge` is similarly optional for paths that accrued partial judge
 * spend before the abort.
 */
function unscoredRound(opts: {
  round: number
  isBaseline: boolean
  optimizer: CostSlice | null
  historyEntry: HistoryEntry | null
  targetAgent?: CostSlice & { runs: number; durationMs: number }
  evalJudge?: CostSlice & { calls: number }
}): RoundResult {
  return {
    round: opts.round,
    isBaseline: opts.isBaseline,
    trainScore: null,
    testScore: null,
    trainPassed: 0,
    trainTotal: 0,
    testPassed: 0,
    testTotal: 0,
    perTaskTrainScores: {},
    perTaskTestScores: {},
    targetAgent: opts.targetAgent ?? { ...emptyCostSlice(), runs: 0, durationMs: 0 },
    evalJudge: opts.evalJudge ?? { ...emptyCostSlice(), calls: 0 },
    optimizer: opts.optimizer,
    historyEntry: opts.historyEntry,
  }
}

/**
 * Sum target-agent stats from train + test evidences into one bucket.
 * Pulls tokens/cost from `ev.runMeta` (populated by `buildRunMeta` from
 * RunResult.cost). `runMeta.costUsd` is 0 for adapters that don't report cost
 * (e.g. jiuwenclaw) — the total will be an underestimate in that case.
 */
function sumTargetAgentStats(
  trainEvidences: Evidence[],
  testEvidences: Evidence[],
): CostSlice & { runs: number; durationMs: number } {
  let tokens = emptyTokenUsage()
  let costUsd = 0
  let runs = 0
  let durationMs = 0
  for (const ev of [...trainEvidences, ...testEvidences]) {
    if (ev.runMeta) {
      tokens = addTokenUsage(tokens, ev.runMeta.tokens)
      costUsd += ev.runMeta.costUsd
      runs++
      durationMs += ev.runMeta.durationMs
    }
  }
  return { tokens, costUsd, runs, durationMs }
}

/**
 * Grand total across all rounds (sum of targetAgent + evalJudge + optimizer)
 * plus the one-time setup cost. Represents the full LLM spend of the session.
 */
function sumAllRounds(
  rounds: readonly RoundResult[],
  setupCost: CostSlice,
): CostSlice {
  const tokensList: TokenUsage[] = [setupCost.tokens]
  let costUsd = setupCost.costUsd
  for (const r of rounds) {
    tokensList.push(r.targetAgent.tokens, r.evalJudge.tokens)
    costUsd += r.targetAgent.costUsd + r.evalJudge.costUsd
    if (r.optimizer) {
      tokensList.push(r.optimizer.tokens)
      costUsd += r.optimizer.costUsd
    }
  }
  return { tokens: sumTokenUsages(tokensList), costUsd }
}

function formatScore(score: number | null): string {
  return score === null ? "n/a" : score.toFixed(3)
}

function formatDelta(prev: number | null, curr: number | null): string {
  if (prev === null || curr === null) return ""
  const d = curr - prev
  const sign = d >= 0 ? "+" : ""
  return ` Δ=${sign}${d.toFixed(3)}`
}

function logRoundLine(
  round: number,
  trainScore: number | null,
  testScore: number | null,
  prevTrain: number | null,
  prevTest: number | null,
  hasTest: boolean,
): void {
  const tag = round === 0 ? " (baseline)" : ""
  const trainPart = `train=${formatScore(trainScore)}${formatDelta(prevTrain, trainScore)}`
  if (hasTest) {
    const testPart = `test=${formatScore(testScore)}${formatDelta(prevTest, testScore)}`
    log.info(`Round ${round}${tag}: ${trainPart}  ${testPart}`)
  } else {
    log.info(`Round ${round}${tag}: ${trainPart}  (test = train)`)
  }
}

// ---------------------------------------------------------------------------
// No-edit round regeneration (synthetic-task source only)
// ---------------------------------------------------------------------------

/**
 * Decide whether a no-edit round should trigger a fresh synthetic train
 * probe. Returns true only when ALL of:
 *   - the task source is synthetic-task (real and log sources terminate
 *     immediately on no-edit)
 *   - a separate frozen test set exists (`testIsSeparate === true`). When
 *     `testCount === 0` in the synthetic source there is no held-out
 *     test set, so pickBestRound's cross-round comparison falls back to
 *     trainScore. Regenerating currentTrainTasks in that mode would mean
 *     later rounds are scored on a different synthetic probe than round
 *     0, making scores incomparable — the regen heuristic cannot
 *     improve scores if the score itself has become meaningless. Refuse.
 *   - the optimizer explicitly declared `noChanges: true` — a legitimate
 *     semantic signal that "I saw the evidence and there's nothing to
 *     fix". Missing / malformed submissions (where `submission.noChanges`
 *     is falsy) are NOT eligible: the "swap the probe and retry"
 *     heuristic only helps when the optimizer actually reasoned about
 *     the evidence, not when the subprocess failed to produce output.
 *   - the optimizer left no file edits (defensive — if it edited anyway
 *     we're on the edit path, not here)
 *   - the cumulative no-edit count (including the current round) is
 *     still under the session budget of 2. The second no-edit round in
 *     a session exits the loop regardless.
 *
 * Pass the POST-INCREMENT no-edit count: after incrementing the counter
 * for the current no-edit round, call this helper. A session pattern of
 * "no-edit → edit → no-edit" exits at the second no-edit because the
 * counter is cumulative, not consecutive.
 *
 * Exported for unit testing; the loop body is the only real caller.
 */
export function shouldRegenerateSyntheticTrain(
  source: TaskSource,
  optimizeResult: { submission: { noChanges?: boolean }; changed: boolean },
  totalNoEditCount: number,
  testIsSeparate: boolean,
): boolean {
  if (source.kind !== "synthetic-task") return false
  if (!testIsSeparate) return false
  if (optimizeResult.submission.noChanges !== true) return false
  if (optimizeResult.changed) return false
  return totalNoEditCount < 2
}

/**
 * Walk `allRounds` backward and return the most recent round whose
 * primary score is non-null. Used in the edit path to compute
 * improvement deltas against a real comparison round when a no-edit
 * regen placeholder sits between the baseline and the current edit —
 * comparing against the placeholder would leave `historyEntry.improved`
 * unset and wipe the anti-oscillation signal the next optimizer pass
 * relies on to avoid repeating failed diagnoses.
 *
 * Exported for unit testing.
 */
export function findLastScoredRound(
  rounds: readonly RoundResult[],
  hasTest: boolean,
): RoundResult | undefined {
  for (let i = rounds.length - 1; i >= 0; i--) {
    const r = rounds[i]!
    if (hasTest ? r.testScore !== null : r.trainScore !== null) return r
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Best round selection
// ---------------------------------------------------------------------------

export interface PickBestRoundOptions {
  /** True when a separate held-out test set exists; primary = testScore. */
  hasTest: boolean
  /**
   * False iff the synthetic-task source regenerated the train probe
   * mid-session. In that mode, different rounds' trainScore values are
   * computed on different probes and cannot be compared — using them as a
   * tiebreak would let a later round win purely because its regenerated
   * batch was easier, even when the frozen held-out test set says the
   * rounds are equivalent.
   */
  trainScoresComparable: boolean
  /** Engine convergence threshold; baseline at or above this triggers early return. */
  convergenceThreshold: number
  /**
   * Minimum primary-score margin a non-baseline round must exceed to be
   * considered an improvement over round 0. Below this, the round is
   * dropped and selection returns baseline.
   */
  minImprovement: number
  /**
   * Max per-task score drop permitted relative to round 0. If a surviving
   * non-baseline round has any task in the intersection whose score fell
   * by more than this value, the round is excluded — aggregate primary
   * improvement does not buy the right to regress a specific task by this
   * much. Defaults to `DEFAULT_PER_TASK_REGRESSION_TOLERANCE`.
   */
  perTaskRegressionTolerance?: number
  /**
   * Minimum fractional drop in `targetAgent.costUsd` (per deployment run)
   * that qualifies as a meaningful cost reduction at equivalent score.
   * Defaults to `DEFAULT_MIN_COST_REDUCTION_RATIO`. Only baseline→candidate
   * cost comparisons pass this gate; adapters whose baseline reports
   * `$0` disable cost-based admission automatically.
   */
  minCostReductionRatio?: number
  /**
   * Score delta window inside which two rounds are "equivalent on
   * quality" for selection. Enables the cost-based gate branch and the
   * cost-based tiebreak. Defaults to `minImprovement`.
   */
  scoreEquivalenceBand?: number
}

export interface PickBestRoundResult {
  bestRound: number
  reason: string
  /**
   * Round-number → human-readable reason for any round kicked out by the
   * per-task monotonicity gate. Empty when nothing was excluded. Persisted
   * to `meta.json.excludedRounds` so audits can explain why a round with
   * a higher aggregate primary did NOT win selection.
   */
  excludedRounds: Record<number, string>
}

/**
 * Pick the best round with baseline protection, noise tolerance, per-task
 * monotonicity, and convergence short-circuit.
 *
 * Ordering of guards (first hit wins):
 *  1. **Convergence short-circuit.** If round 0's primary ≥
 *     `convergenceThreshold`, return round 0 unconditionally. This matches
 *     the `alreadyConverged` check that already skips optimization entirely
 *     — selection must agree or a mid-session regression could displace a
 *     baseline the engine never tried to improve.
 *  2. **Baseline gate.** Drop any non-baseline round whose primary does not
 *     exceed `round0.primary + minImprovement`. Rationale: at runsPerTask=1
 *     / N=2 the empirical score std is 0.03–0.08, so a floating-point-sized
 *     win is indistinguishable from noise. If the baseline gate empties the
 *     candidate pool, return round 0.
 *  3. **Per-task monotonicity gate (Layer 2).** For each round that cleared
 *     the baseline gate, walk round 0's task set and compare each task
 *     against the candidate's `perTaskTestScores` (or `perTaskTrainScores`
 *     when there is no separate test set). A task is excluded when either
 *     it dropped by more than `perTaskRegressionTolerance`, OR the
 *     candidate has no clean runs for it at all (maximum uncertainty,
 *     conservative rejection). Tasks new in the candidate but absent from
 *     round 0 are ignored — synthetic regen is allowed to introduce tasks
 *     without triggering the gate. A higher aggregate primary does not
 *     buy the right to tank a specific task.
 *  4. **Epsilon-aware sort.** Within the surviving pool, compare primary
 *     scores. Differences under `SELECTION_EPSILON` are treated as ties and
 *     defer directly to round-number ascending — prefer the round closer to
 *     baseline so a no-op rerun cannot displace round 0.
 *  5. Final tiebreaks (rarely reached): train-score when comparable, then
 *     target-agent tokens, then duration.
 *
 * Weak-monotonicity note: when `hasTest` is false, the per-task gate runs
 * on the training set — i.e., the exact tasks the optimizer was reading
 * evidence from. This is weaker protection than a true holdout but still
 * catches catastrophic per-task collapses (task A went from 1.0 to 0.3
 * while task B went from 0.5 to 1.0 and the mean ticked up). Users who
 * want the strong version pass `--test-tasks` so `hasTest=true`.
 */
export function pickBestRound(
  rounds: RoundResult[],
  opts: PickBestRoundOptions,
): PickBestRoundResult {
  const {
    hasTest,
    trainScoresComparable,
    convergenceThreshold,
    minImprovement,
  } = opts
  const perTaskRegressionTolerance =
    opts.perTaskRegressionTolerance ?? DEFAULT_PER_TASK_REGRESSION_TOLERANCE
  const minCostReductionRatio =
    opts.minCostReductionRatio ?? DEFAULT_MIN_COST_REDUCTION_RATIO
  const scoreEquivalenceBand =
    opts.scoreEquivalenceBand ?? minImprovement
  const label = hasTest ? "test" : "train"
  const primaryOf = (r: RoundResult): number | null =>
    hasTest ? r.testScore : r.trainScore
  const perTaskOf = (r: RoundResult): Record<string, number> =>
    hasTest ? r.perTaskTestScores : r.perTaskTrainScores

  const round0 = rounds.find((r) => r.isBaseline)
  const round0Primary = round0 ? primaryOf(round0) : null
  // Cost comparison requires (1) the adapter actually reports a dollar
  // figure (Jiuwenclaw → $0 disables it) AND (2) cross-round costs are
  // apples-to-apples. `targetAgent.costUsd` in `sumTargetAgentStats`
  // mixes train + test evidences into a single bucket, so when the
  // synthetic-task source regenerates the train probe mid-session
  // (`trainScoresComparable=false`), round N's bucket covers a
  // different train batch than round 0's — the deltas reflect probe
  // churn, not optimization. Mirror the existing trainScore guard.
  const baselineCost = round0?.targetAgent.costUsd ?? 0
  const costComparable = trainScoresComparable && baselineCost > 0
  const costCutsBaseline = (r: RoundResult): boolean => {
    if (!costComparable) return false
    const rCost = r.targetAgent.costUsd
    if (rCost <= 0) return false
    return rCost <= baselineCost * (1 - minCostReductionRatio)
  }
  const formatCostDelta = (roundCost: number): string => {
    if (!costComparable || roundCost <= 0) return ""
    const pct = ((baselineCost - roundCost) / baselineCost) * 100
    return (
      `target-agent cost $${baselineCost.toFixed(4)} -> ` +
      `$${roundCost.toFixed(4)} (-${pct.toFixed(1)}%)`
    )
  }

  // Convergence short-circuit: baseline already at/above threshold.
  if (round0 && round0Primary !== null && round0Primary >= convergenceThreshold) {
    return {
      bestRound: round0.round,
      reason: `baseline already at convergence threshold (${round0Primary.toFixed(3)} >= ${convergenceThreshold})`,
      excludedRounds: {},
    }
  }

  const scored = rounds.filter((r) => primaryOf(r) !== null)
  if (scored.length === 0) {
    return { bestRound: 0, reason: "no rounds had evaluatable scores", excludedRounds: {} }
  }

  // Baseline gate: keep baseline always, drop non-baseline rounds that
  // don't clear the noise floor over round 0. When we have no baseline
  // primary to compare against (round 0 was null-scored or absent), fall
  // through with zero floor — this only happens on degenerate sessions
  // and the null-filter at the top of this function already covers the
  // "nothing scored" case.
  //
  // Two admission branches:
  //  (a) Score win: primary >= baseline + minImprovement (existing noise-
  //      floor rule).
  //  (b) Cost win at equivalent score: primary >= baseline -
  //      scoreEquivalenceBand AND target-agent cost cut by >=
  //      minCostReductionRatio. Rationale: a round that ties baseline
  //      on score but halves the deployment cost is a legitimate
  //      optimization. Layer-2 per-task monotonicity still gates below,
  //      so cost is never an excuse to ship a per-task regression.
  const floor = round0Primary ?? -Infinity
  const afterBaselineGate = scored.filter((r) => {
    if (r.isBaseline) return true
    const p = primaryOf(r)!
    if (p >= floor + minImprovement) return true
    if (p >= floor - scoreEquivalenceBand && costCutsBaseline(r)) return true
    return false
  })

  // Layer 2: per-task monotonicity gate. Only consulted when round 0 has
  // per-task data to compare against — a degenerate round with no per-task
  // scores cannot exclude anything, and the gate becomes a no-op.
  //
  // Iterate the BASELINE task set rather than the candidate's. When a
  // baseline task is missing from a candidate round entirely (all runs
  // infra-tainted or null-scored), the candidate has no data to prove
  // non-regression for that task — conservative semantics is to exclude
  // the round. Iterating the candidate's keys instead would silently let
  // a round that vaporised a baseline task win selection. Tasks new in
  // the candidate (synthetic regen) are naturally skipped because they
  // don't appear in `round0PerTask`, which is the correct behaviour.
  const excludedRounds: Record<number, string> = {}
  const round0PerTask = round0 ? perTaskOf(round0) : {}
  const round0TaskCount = Object.keys(round0PerTask).length
  const survivors = afterBaselineGate.filter((r) => {
    if (r.isBaseline) return true
    if (round0TaskCount === 0) return true
    const rPerTask = perTaskOf(r)
    for (const [taskId, baseScore] of Object.entries(round0PerTask)) {
      const roundScore = rPerTask[taskId]
      if (roundScore === undefined) {
        excludedRounds[r.round] =
          `task '${taskId}' has no clean runs in round ${r.round} ` +
          `(baseline=${baseScore.toFixed(3)}) — cannot verify non-regression`
        return false
      }
      const drop = baseScore - roundScore
      if (drop > perTaskRegressionTolerance) {
        excludedRounds[r.round] =
          `task '${taskId}' regressed from ${baseScore.toFixed(3)} to ` +
          `${roundScore.toFixed(3)} (drop=${drop.toFixed(3)} > tolerance=${perTaskRegressionTolerance})`
        return false
      }
    }
    return true
  })

  const nonBaselineTotal = scored.filter((r) => !r.isBaseline).length
  const nonBaselineSurvivors = survivors.filter((r) => !r.isBaseline).length

  if (nonBaselineSurvivors === 0) {
    if (round0 && round0Primary !== null) {
      let reason: string
      if (nonBaselineTotal === 0) {
        reason = `only baseline scored (${round0Primary.toFixed(3)})`
      } else if (Object.keys(excludedRounds).length > 0 && afterBaselineGate.length > 1) {
        // Some rounds made it past the baseline gate but all got axed by
        // per-task monotonicity. Surface that explicitly so "why did
        // baseline win" is debuggable from meta.json alone.
        reason =
          `all improving rounds regressed on at least one task by > ` +
          `${perTaskRegressionTolerance} (baseline=${round0Primary.toFixed(3)})`
      } else {
        const costClause = costComparable
          ? ` nor cut target-agent cost by >= ${(minCostReductionRatio * 100).toFixed(0)}% at equivalent score`
          : ""
        reason =
          `no round beat baseline by >= ${minImprovement} on ${label}${costClause} ` +
          `(noise floor; baseline=${round0Primary.toFixed(3)})`
      }
      return { bestRound: round0.round, reason, excludedRounds }
    }
  }

  const pool = nonBaselineSurvivors === 0 ? scored : survivors

  pool.sort((a, b) => {
    const pa = primaryOf(a)!
    const pb = primaryOf(b)!
    // Outside the score equivalence band, primary score decides.
    if (Math.abs(pa - pb) > scoreEquivalenceBand) return pb - pa
    // Within the equivalence band: target-agent cost is the primary
    // tiebreak. Only compare when cost is comparable across rounds
    // (see `costComparable` — gated on trainScoresComparable and a
    // non-zero baseline) and both rounds report non-zero cost.
    if (costComparable) {
      const costA = a.targetAgent.costUsd
      const costB = b.targetAgent.costUsd
      if (costA > 0 && costB > 0 && costA !== costB) return costA - costB
    }
    // Baseline preference on cost ties (round 0 wins ultimate ties).
    if (a.round !== b.round) return a.round - b.round
    // Secondary score axis (only resolves sub-equivalence-band diffs).
    if (hasTest && trainScoresComparable) {
      const ta = a.trainScore ?? 0
      const tb = b.trainScore ?? 0
      if (Math.abs(ta - tb) >= SELECTION_EPSILON) return tb - ta
    }
    // Token fallback: adapters that don't report cost still surface
    // token counts, so keep this as a last-resort signal.
    const tokA = a.targetAgent.tokens.input + a.targetAgent.tokens.output
    const tokB = b.targetAgent.tokens.input + b.targetAgent.tokens.output
    if (tokA !== tokB) return tokA - tokB
    if (a.targetAgent.durationMs !== b.targetAgent.durationMs) {
      return a.targetAgent.durationMs - b.targetAgent.durationMs
    }
    return 0
  })

  const winner = pool[0]!
  const winnerPrimary = primaryOf(winner)!
  let reason: string
  if (winner.isBaseline) {
    reason = pool.length === 1
      ? `only baseline scored (${winnerPrimary.toFixed(3)})`
      : `baseline ${label} score ${winnerPrimary.toFixed(3)} wins tiebreak at equivalence band`
  } else if (round0Primary !== null) {
    const delta = winnerPrimary - round0Primary
    const scoreWon = delta >= minImprovement
    const costWon = costCutsBaseline(winner)
    const costClause = formatCostDelta(winner.targetAgent.costUsd)
    if (scoreWon && costWon) {
      reason =
        `round ${winner.round} beats baseline by +${delta.toFixed(3)} on ${label} ` +
        `(${round0Primary.toFixed(3)} -> ${winnerPrimary.toFixed(3)}) ` +
        `AND cuts ${costClause}`
    } else if (costWon) {
      reason =
        `round ${winner.round} ties baseline within \u00b1${scoreEquivalenceBand} ${label} ` +
        `(${round0Primary.toFixed(3)} vs ${winnerPrimary.toFixed(3)}) ` +
        `but cuts ${costClause}`
    } else {
      reason = `round ${winner.round} beats baseline by +${delta.toFixed(3)} on ${label} (${round0Primary.toFixed(3)} -> ${winnerPrimary.toFixed(3)})`
    }
  } else {
    reason = `highest ${label} score ${winnerPrimary.toFixed(3)} (no baseline reference)`
  }
  return { bestRound: winner.round, reason, excludedRounds }
}

// ---------------------------------------------------------------------------
// Skill dir utilities
// ---------------------------------------------------------------------------

function resolveSkillName(skillDir: string): string {
  const dirName = path.basename(skillDir)
  return /^v\d/.test(dirName) ? path.basename(path.dirname(skillDir)) : dirName
}

function describeSource(source: TaskSource): string {
  if (source.kind === "synthetic-task") {
    return `synthetic-task (train=${source.trainCount}, test=${source.testCount})`
  }
  if (source.kind === "real-task") {
    const testPart = source.testTasks && source.testTasks.length > 0
      ? `, test=${source.testTasks.length}`
      : ""
    return `real-task (train=${source.trainTasks.length}${testPart})`
  }
  return `execution-log (${source.logs.length} log(s))`
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p)
    return s.isDirectory()
  } catch {
    return false
  }
}

/** Copy the contents of srcDir into destDir, overwriting matching files. */
async function applyBestToSkillDir(srcDir: string, destDir: string): Promise<void> {
  const entries = await readdir(srcDir, { withFileTypes: true, recursive: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const src = path.join(entry.parentPath ?? srcDir, entry.name)
    const rel = path.relative(srcDir, src)
    if (rel.startsWith(".")) continue
    const dest = path.join(destDir, rel)
    await mkdir(path.dirname(dest), { recursive: true })
    await copyFile(src, dest)
  }
}

