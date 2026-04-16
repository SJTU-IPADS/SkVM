import path from "node:path"
import { mkdtemp, mkdir, readdir, copyFile, cp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { copyDirRecursive } from "../core/fs-utils.ts"
import type { AgentAdapter, AdapterConfig, TCP, RunResult } from "../core/types.ts"
import type { LLMProvider } from "../providers/types.ts"
import { runTask } from "../framework/runner.ts"
import type { EvaluatorConfig, EvaluateAllOptions } from "../framework/evaluator.ts"
import { evaluateAll } from "../framework/evaluator.ts"
import { compileSkill, writeVariant } from "../compiler/index.ts"
import { AOT_COMPILE_DIR, toPassTag, safeModelName } from "../core/config.ts"
import type { BenchTask, BenchCondition, ConditionResult, JitRunReport, EvalDetail } from "./types.ts"
import { contentHash } from "../core/skill-loader.ts"
import type { ResolvedSkill } from "../core/skill-loader.ts"
import { createLogger } from "../core/logger.ts"
import { ConversationLog } from "../core/conversation-logger.ts"

const log = createLogger("bench-conditions")

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Create workDir and copy fixture files from the task's fixtures/ directory */
async function prepareWorkDir(task: BenchTask): Promise<string> {
  const workDir = await mkdtemp(path.join(tmpdir(), `skvm-bench-${task.id}-`))

  // Copy files and directories from task's fixtures/ directory if it exists
  if (task.taskDir) {
    const fixturesDir = path.join(task.taskDir, "fixtures")
    try {
      const entries = await readdir(fixturesDir, { withFileTypes: true })
      for (const entry of entries) {
        const srcPath = path.join(fixturesDir, entry.name)
        const destPath = path.join(workDir, entry.name)
        if (entry.isDirectory()) {
          await copyDirRecursive(srcPath, destPath)
        } else {
          await copyFile(srcPath, destPath)
        }
      }
    } catch { /* no fixtures dir */ }

    // Run optional setup script (e.g. for git repo creation, fixture generation)
    const setupScript = path.join(workDir, "_setup.sh")
    try {
      const f = Bun.file(setupScript)
      if (await f.exists()) {
        log.debug(`Running _setup.sh for task ${task.id}`)
        const proc = Bun.spawn(["bash", "_setup.sh"], {
          cwd: workDir,
          stdout: "pipe",
          stderr: "pipe",
        })
        await proc.exited
      }
    } catch { /* no setup script or execution failed */ }
  }

  return workDir
}

/** Copy skill bundle files (scripts, templates) into workDir so the agent can use them */
async function copySkillBundle(skill: ResolvedSkill, workDir: string): Promise<void> {
  if (skill.bundleFiles.length === 0) return
  for (const relPath of skill.bundleFiles) {
    const src = path.join(skill.skillDir, relPath)
    const dest = path.join(workDir, relPath)
    await mkdir(path.dirname(dest), { recursive: true })
    await copyFile(src, dest)
  }
  log.debug(`Copied ${skill.bundleFiles.length} skill bundle files to workDir`)
}

/** Copy bundle files for multiple skills */
async function copySkillBundles(skills: ResolvedSkill[], workDir: string): Promise<void> {
  for (const skill of skills) {
    await copySkillBundle(skill, workDir)
  }
}

/** Copy all non-SKILL.md files from a skill-shaped directory into a workDir. */
async function copyBundleFromDir(srcDir: string, workDir: string): Promise<void> {
  try {
    const entries = await readdir(srcDir, { withFileTypes: true, recursive: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const full = path.join(entry.parentPath ?? srcDir, entry.name)
      const rel = path.relative(srcDir, full)
      if (rel === "SKILL.md" || rel.startsWith(".") || rel.startsWith("_meta.json") || rel === "LICENSE.txt") continue
      const dest = path.join(workDir, rel)
      await mkdir(path.dirname(dest), { recursive: true })
      await copyFile(full, dest)
    }
  } catch { /* no bundle files */ }
}

/** Concatenate multiple skill contents into a single string */
function concatSkillContents(skills: ResolvedSkill[]): string {
  if (skills.length === 1) return skills[0]!.skillContent
  return skills.map(s => s.skillContent).join("\n\n---\n\n")
}

/** Build combined skill metadata for multi-skill condition results */
function buildSkillMeta(skills: ResolvedSkill[]): { skillId: string; skillContentHash: string } {
  return {
    skillId: skills.map(s => s.skillId).join("+"),
    skillContentHash: contentHash(concatSkillContents(skills)),
  }
}

/** Minimal shape consumed by computeWeightedScore — both EvalDetail and mapped EvalResult satisfy it. */
export interface WeightedEntry {
  method: string
  score: number
  weight?: number
}

/** Classify an eval criterion as automated (script/file-check/custom) or llm-judge */
function isAutomated(e: WeightedEntry): boolean {
  return e.method === "script" || e.method === "file-check" || e.method === "custom"
}

/**
 * Compute weighted score from per-criterion entries.
 *
 * Scoring strategy (in priority order):
 * 1. Per-criterion weights: if any entry has an explicit `weight` field,
 *    use per-criterion weighted average.
 * 2. Legacy gradingWeights: if the task has `gradingWeights`, split entries
 *    into automated vs llm-judge groups and combine with group weights.
 * 3. Flat average: all entries weighted equally.
 *
 * This function is the single source of truth for condition scoring — both
 * the sync evaluation path and the async-judge merge call it on the same
 * `EvalDetail[]`, guaranteeing identical results regardless of path.
 */
export function computeWeightedScore(
  entries: WeightedEntry[],
  gradingWeights?: { automated: number; llmJudge: number },
): { overallScore: number; automatedScore?: number; llmJudgeScore?: number } {
  if (entries.length === 0) return { overallScore: 0 }

  const automated = entries.filter(isAutomated)
  const llmJudge = entries.filter(e => !isAutomated(e))
  const autoAvg = automated.length > 0
    ? automated.reduce((sum, e) => sum + e.score, 0) / automated.length
    : undefined
  const judgeAvg = llmJudge.length > 0
    ? llmJudge.reduce((sum, e) => sum + e.score, 0) / llmJudge.length
    : undefined

  // Strategy 1: per-criterion weights
  const hasPerCriterionWeights = entries.some(e => e.weight != null)
  if (hasPerCriterionWeights) {
    const defaultWeight = 1.0 / entries.length
    let totalWeight = 0
    let weightedSum = 0
    for (const e of entries) {
      const w = e.weight ?? defaultWeight
      totalWeight += w
      weightedSum += e.score * w
    }
    const overallScore = totalWeight > 0 ? weightedSum / totalWeight : 0
    return { overallScore, automatedScore: autoAvg, llmJudgeScore: judgeAvg }
  }

  // Strategy 2: legacy gradingWeights
  if (gradingWeights) {
    let overallScore: number
    if (autoAvg !== undefined && judgeAvg !== undefined) {
      const totalWeight = gradingWeights.automated + gradingWeights.llmJudge
      overallScore = (autoAvg * gradingWeights.automated + judgeAvg * gradingWeights.llmJudge) / totalWeight
    } else if (autoAvg !== undefined) {
      overallScore = autoAvg
    } else if (judgeAvg !== undefined) {
      overallScore = judgeAvg
    } else {
      overallScore = 0
    }
    return { overallScore, automatedScore: autoAvg, llmJudgeScore: judgeAvg }
  }

  // Strategy 3: flat average
  const overallScore = entries.reduce((sum, e) => sum + e.score, 0) / entries.length
  return { overallScore }
}

/** Build per-criterion detail entries with optional checkpoint breakdown */
export function buildEvalDetails(
  evalResults: { pass: boolean; score: number; details: string; criterion?: { method: string; id?: string; name?: string; weight?: number }; checkpoints?: { name: string; score: number; reason?: string }[] }[],
): EvalDetail[] {
  return evalResults.map((r) => ({
    id: r.criterion?.id,
    name: r.criterion?.name,
    method: r.criterion?.method ?? "unknown",
    score: r.score,
    weight: r.criterion?.weight,
    details: r.details,
    ...(r.checkpoints?.length ? { checkpoints: r.checkpoints } : {}),
  }))
}

/** Convert TestResult to ConditionResult */
function toConditionResult(
  condition: BenchCondition,
  runResult: RunResult,
  evalResults: { pass: boolean; score: number; details: string; criterion?: { method: string } }[],
  opts?: {
    skillId?: string
    skillPath?: string
    skillPaths?: string[]
    skillContentHash?: string
    gradingWeights?: { automated: number; llmJudge: number }
  },
): ConditionResult {
  const evalDetails = buildEvalDetails(evalResults)
  const { overallScore, automatedScore, llmJudgeScore } = computeWeightedScore(
    evalDetails, opts?.gradingWeights,
  )

  // Propagate adapter errors so they show up in bench reports
  let error: string | undefined
  if (runResult.adapterError) {
    const ae = runResult.adapterError
    error = ae.stderr || `adapter exit code ${ae.exitCode}`
  } else if (runResult.runStatus !== "ok" && runResult.statusDetail) {
    // Non-ok runs that don't carry a noisy stderr snippet still deserve a
    // visible error string in report.md.
    error = runResult.statusDetail
  }

  return {
    condition,
    score: overallScore,
    pass: overallScore >= 0.5,
    evalDetails,
    automatedScore,
    llmJudgeScore,
    ...(opts?.gradingWeights ? { gradingWeights: opts.gradingWeights } : {}),
    tokens: runResult.tokens,
    cost: runResult.cost,
    durationMs: runResult.durationMs,
    llmDurationMs: runResult.llmDurationMs ?? 0,
    steps: runResult.steps.length,
    skillId: opts?.skillId,
    skillPath: opts?.skillPath,
    skillPaths: opts?.skillPaths,
    skillContentHash: opts?.skillContentHash,
    ...(runResult.skillLoaded !== undefined ? { skillLoaded: runResult.skillLoaded } : {}),
    ...(error ? { error } : {}),
    runStatus: runResult.runStatus,
    ...(runResult.statusDetail ? { statusDetail: runResult.statusDetail } : {}),
  }
}

// ---------------------------------------------------------------------------
// Condition: no-skill
// ---------------------------------------------------------------------------

export async function runNoSkill(
  task: BenchTask,
  adapter: AgentAdapter,
  adapterConfig: AdapterConfig,
  evaluatorConfig?: EvaluatorConfig,
  convLog?: ConversationLog,
  evalOptions?: EvaluateAllOptions,
): Promise<ConditionResult> {
  log.info(`[no-skill] ${task.id}`)
  const workDir = await prepareWorkDir(task)

  try {
    const result = await runTask({
      task,
      adapter,
      adapterConfig,
      evaluatorConfig,
      convLog,
      workDir,
      keepWorkDir: true,
      evalOptions,
    })

    return toConditionResult("no-skill", result.runResult, result.evalResults, {
      gradingWeights: task.gradingWeights,
    })
  } catch (err) {
    log.error(`[no-skill] ${task.id} failed: ${err}`)
    return {
      condition: "no-skill",
      score: 0, pass: false, evalDetails: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0, durationMs: 0, llmDurationMs: 0, steps: 0,
      error: String(err),
      runStatus: "adapter-crashed",
      statusDetail: `bench orchestration threw: ${String(err).slice(0, 200)}`,
    }
  }
}

// ---------------------------------------------------------------------------
// Condition: original skill
// ---------------------------------------------------------------------------

export async function runOriginal(
  task: BenchTask,
  adapter: AgentAdapter,
  adapterConfig: AdapterConfig,
  skill: ResolvedSkill | ResolvedSkill[],
  evaluatorConfig?: EvaluatorConfig,
  convLog?: ConversationLog,
  evalOptions?: EvaluateAllOptions,
): Promise<ConditionResult> {
  const skills = Array.isArray(skill) ? skill : [skill]
  const meta = buildSkillMeta(skills)
  const skillPaths = skills.map((s) => s.skillPath)
  log.info(`[original] ${task.id} with skill(s) ${meta.skillId}`)
  const workDir = await prepareWorkDir(task)
  await copySkillBundles(skills, workDir)

  try {
    const result = await runTask({
      task,
      adapter,
      adapterConfig,
      evaluatorConfig,
      convLog,
      skillContent: concatSkillContents(skills),
      workDir,
      keepWorkDir: true,
      evalOptions,
    })

    return toConditionResult("original", result.runResult, result.evalResults, {
      ...meta,
      skillPath: skillPaths[0],
      skillPaths,
      gradingWeights: task.gradingWeights,
    })
  } catch (err) {
    log.error(`[original] ${task.id} failed: ${err}`)
    return {
      condition: "original",
      score: 0, pass: false, evalDetails: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0, durationMs: 0, llmDurationMs: 0, steps: 0,
      ...meta,
      skillPath: skillPaths[0],
      skillPaths,
      error: String(err),
      runStatus: "adapter-crashed",
      statusDetail: `bench orchestration threw: ${String(err).slice(0, 200)}`,
    }
  }
}

// ---------------------------------------------------------------------------
// Condition: jit-optimized (latest best variant from jit-optimize proposals)
// ---------------------------------------------------------------------------

export async function runJitOptimized(
  task: BenchTask,
  adapter: AgentAdapter,
  adapterConfig: AdapterConfig,
  skill: ResolvedSkill | ResolvedSkill[],
  harness: string,
  model: string,
  evaluatorConfig?: EvaluatorConfig,
  convLog?: ConversationLog,
  evalOptions?: EvaluateAllOptions,
): Promise<ConditionResult> {
  const skills = Array.isArray(skill) ? skill : [skill]
  const meta = buildSkillMeta(skills)
  const skillPaths = skills.map((s) => s.skillPath)
  log.info(`[jit-optimized] ${task.id} with skill(s) ${meta.skillId}`)

  // Load latest best-round skill folder from the proposals tree, keyed by
  // (harness, target model, skillName). `lookupLatestProposal` skips
  // `infra-blocked` proposals and distinguishes "nothing at all" (operator
  // bug → throw) from "only infra-blocked" (graceful skip: return a tainted
  // ConditionResult so the skill shows in report.md's Tainted runs table).
  const { lookupLatestProposal } = await import("../proposals/storage.ts")
  const jitOptimizedContents: string[] = []
  const jitOptimizedBundleDirs: string[] = []
  for (const s of skills) {
    const { state, bestDir } = await lookupLatestProposal(harness, model, s.skillId)
    if (state === "only-blocked") {
      const detail = `skill ${s.skillId}: latest jit-optimize proposal is infra-blocked and no non-blocked fallback exists`
      log.warn(`[jit-optimized] Skipping ${task.id}: ${detail}`)
      return {
        condition: "jit-optimized",
        score: 0, pass: false, evalDetails: [],
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0, durationMs: 0, llmDurationMs: 0, steps: 0,
        ...meta,
        skillPath: skillPaths[0],
        skillPaths,
        runStatus: "tainted",
        statusDetail: `skipped: only infra-blocked proposals available (${detail})`,
      }
    }
    if (state === "none" || !bestDir) {
      throw new Error(`No jit-optimized proposals found for skill ${s.skillId} on ${harness}/${model}`)
    }
    const bestSkillMd = path.join(bestDir, "SKILL.md")
    jitOptimizedContents.push(await Bun.file(bestSkillMd).text())
    jitOptimizedBundleDirs.push(bestDir)
    log.info(`[jit-optimized] Loaded ${s.skillId} from ${bestDir}`)
  }
  const skillContent = jitOptimizedContents.length === 1
    ? jitOptimizedContents[0]!
    : jitOptimizedContents.join("\n\n---\n\n")

  const workDir = await prepareWorkDir(task)
  // Copy bundle files from the jit-optimized best-round directories (instead of the original skill dir)
  for (const bundleDir of jitOptimizedBundleDirs) {
    await copyBundleFromDir(bundleDir, workDir)
  }

  try {
    const result = await runTask({
      task,
      adapter,
      adapterConfig,
      evaluatorConfig,
      convLog,
      skillContent,
      workDir,
      keepWorkDir: true,
      evalOptions,
    })

    return toConditionResult("jit-optimized", result.runResult, result.evalResults, {
      ...meta,
      skillPath: skillPaths[0],
      skillPaths,
      gradingWeights: task.gradingWeights,
    })
  } catch (err) {
    log.error(`[jit-optimized] ${task.id} failed: ${err}`)
    return {
      condition: "jit-optimized",
      score: 0, pass: false, evalDetails: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0, durationMs: 0, llmDurationMs: 0, steps: 0,
      ...meta,
      skillPath: skillPaths[0],
      skillPaths,
      error: String(err),
      runStatus: "adapter-crashed",
      statusDetail: `bench orchestration threw: ${String(err).slice(0, 200)}`,
    }
  }
}

// ---------------------------------------------------------------------------
// Condition: AOT compiled (supports per-pass variants)
// ---------------------------------------------------------------------------

/**
 * Run an AOT variant with specific passes.
 * Checks cache at <skill>/<passTag>/SKILL.md, compiles if missing.
 */
export async function runAOTVariant(
  task: BenchTask,
  adapter: AgentAdapter,
  adapterConfig: AdapterConfig,
  skillContent: string,
  skillId: string,
  skillPath: string,
  tcp: TCP,
  compilerProvider: LLMProvider,
  condition: BenchCondition,
  passes: number[],
  evaluatorConfig?: EvaluatorConfig,
  convLog?: ConversationLog,
  evalOptions?: EvaluateAllOptions,
): Promise<ConditionResult> {
  const passTag = toPassTag(passes)
  log.info(`[${condition}] ${task.id} with skill ${skillId} (passes=${passes}, tag=${passTag})`)

  const harness = adapter.name
  const compiledPath = path.join(AOT_COMPILE_DIR, harness, safeModelName(adapterConfig.model), skillId, passTag, "SKILL.md")

  let compiledContent: string
  let loadedSkillPath = compiledPath

  try {
    const existing = Bun.file(compiledPath)
    if (await existing.exists()) {
      compiledContent = await existing.text()
      loadedSkillPath = compiledPath
      log.info(`[${condition}] Using cached ${passTag} variant for ${skillId}`)
    } else if (passTag === "p1p2p3") {
      // Check legacy flat path (backward compatibility)
      const legacyPath = path.join(AOT_COMPILE_DIR, harness, safeModelName(adapterConfig.model), skillId, "SKILL.md")
      const legacyFile = Bun.file(legacyPath)
      if (await legacyFile.exists()) {
        compiledContent = await legacyFile.text()
        loadedSkillPath = legacyPath
        log.info(`[${condition}] Using legacy cached variant for ${skillId}`)
      } else {
        throw new Error("not cached")
      }
    } else {
      throw new Error("not cached")
    }
  } catch {
    // Compile with the requested passes
    log.info(`[${condition}] Compiling ${skillId} for ${adapterConfig.model} (passes=${passes})`)
    try {
      const result = await compileSkill({
        skillPath,
        skillDir: path.dirname(skillPath),
        skillName: skillId,
        skillContent,
        tcp,
        model: adapterConfig.model,
        harness,
        passes,
      }, compilerProvider, { showSpinner: false })
      compiledContent = result.compiledSkill
      await writeVariant(result)
    } catch (err) {
      log.error(`[${condition}] Compilation failed for ${skillId}: ${err}`)
      return {
        condition,
        score: 0, pass: false, evalDetails: [],
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0, durationMs: 0, llmDurationMs: 0, steps: 0,
        skillId, skillPath, error: `Compilation failed: ${err}`,
        runStatus: "adapter-crashed",
        statusDetail: `compiler failed: ${String(err).slice(0, 200)}`,
      }
    }
  }

  const workDir = await prepareWorkDir(task)

  // Copy compiled bundled files to workDir (if the compiled variant has them)
  const compiledDir = path.dirname(compiledPath)
  try {
    const { readdir: readdirAsync } = await import("node:fs/promises")
    const entries = await readdirAsync(compiledDir, { withFileTypes: true, recursive: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const fullPath = path.join(entry.parentPath ?? compiledDir, entry.name)
      const relPath = path.relative(compiledDir, fullPath)
      // Skip compiler metadata files
      if (["SKILL.md", "compilation-plan.json", "meta.json", "env-setup.sh", "jit-candidates.json"].includes(relPath)) continue
      const dest = path.join(workDir, relPath)
      await mkdir(path.dirname(dest), { recursive: true })
      await copyFile(fullPath, dest)
    }
  } catch { /* no bundled files in compiled variant */ }

  try {
    const result = await runTask({
      task,
      adapter,
      adapterConfig,
      evaluatorConfig,
      convLog,
      skillContent: compiledContent,
      workDir,
      keepWorkDir: true,
      evalOptions,
    })

    return toConditionResult(condition, result.runResult, result.evalResults, {
      skillId,
      skillPath: loadedSkillPath,
      skillContentHash: contentHash(compiledContent),
      gradingWeights: task.gradingWeights,
    })
  } catch (err) {
    log.error(`[${condition}] ${task.id} execution failed: ${err}`)
    return {
      condition,
      score: 0, pass: false, evalDetails: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0, durationMs: 0, llmDurationMs: 0, steps: 0,
      skillId, skillPath: loadedSkillPath, skillContentHash: contentHash(compiledContent),
      error: String(err),
      runStatus: "adapter-crashed",
      statusDetail: `bench orchestration threw: ${String(err).slice(0, 200)}`,
    }
  }
}

/** Run full 3-pass AOT compilation (backward-compatible wrapper). */
export async function runAOT(
  task: BenchTask,
  adapter: AgentAdapter,
  adapterConfig: AdapterConfig,
  skillContent: string,
  skillId: string,
  skillPath: string,
  tcp: TCP,
  compilerProvider: LLMProvider,
  evaluatorConfig?: EvaluatorConfig,
  convLog?: ConversationLog,
  evalOptions?: EvaluateAllOptions,
): Promise<ConditionResult> {
  return runAOTVariant(
    task, adapter, adapterConfig, skillContent, skillId, skillPath,
    tcp, compilerProvider, "aot-compiled", [1, 2, 3], evaluatorConfig, convLog, evalOptions,
  )
}

// ---------------------------------------------------------------------------
// Condition: JIT-boost
// ---------------------------------------------------------------------------

/**
 * Run a task with JIT-boost code solidification.
 *
 * Flow:
 * 1. Warmup run (no hooks) — collects a conv log of actual agent tool calls
 * 2. Generate boost candidates from the warmup conv log (loose regex signatures)
 * 3. Create boost hooks and run remaining iterations with solidification enabled
 *
 * No dependency on TCP, compiler, or profiler.
 */
export async function runJITBoost(
  task: BenchTask,
  adapter: AgentAdapter,
  adapterConfig: AdapterConfig,
  skillContent: string,
  skillId: string,
  skillDir: string,
  jitRuns: number,
  evaluatorConfig?: EvaluatorConfig,
  convLogDir?: string,
): Promise<ConditionResult> {
  const { createBoostHooks, generateCandidatesFromConvLogs, generateBoostCandidates, saveBoostCandidates, saveSolidificationState } = await import("../jit-boost/index.ts")
  const { getJitBoostDir } = await import("../core/config.ts")

  log.info(`[jit-boost] ${task.id} with skill ${skillId} (${jitRuns} runs)`)

  if (jitRuns < 2) {
    log.warn(`[jit-boost] jitRuns=${jitRuns} is too low — need at least 2 (1 warmup + 1 with hooks)`)
  }

  const jitRunReports: JitRunReport[] = []
  let lastRunResult: RunResult | null = null
  const outputDir = getJitBoostDir(skillId)

  // -----------------------------------------------------------------------
  // Step 1: Warmup run (no hooks) — collect conv log of actual agent code
  // -----------------------------------------------------------------------
  let warmupLogPath: string | undefined
  {
    log.info(`[jit-boost] ${task.id} warmup run (no hooks)`)
    const workDir = await prepareWorkDir(task)

    let convLog: ConversationLog | undefined
    if (convLogDir) {
      warmupLogPath = path.join(convLogDir, task.id, "jit-boost-warmup.jsonl")
      await mkdir(path.dirname(warmupLogPath), { recursive: true })
      convLog = new ConversationLog(warmupLogPath)
    }

    try {
      // Clear any existing hooks for warmup
      if ("setHooks" in adapter && typeof adapter.setHooks === "function") {
        adapter.setHooks({})
      }
      await adapter.setup(adapterConfig)
      const runResult = await adapter.run({
        prompt: task.prompt,
        workDir,
        skillContent,
        convLog,
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
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        promotions: 0,
      })
    }
  }

  // -----------------------------------------------------------------------
  // Step 2: Generate candidates from warmup conv log
  // -----------------------------------------------------------------------
  if (warmupLogPath) {
    // Phase 1: Identify patterns from conv log
    log.info(`[jit-boost] Phase 1: Identifying patterns from warmup conv log...`)
    const genResult = await generateCandidatesFromConvLogs([warmupLogPath], outputDir)

    if (genResult.candidates.length > 0) {
      log.info(`[jit-boost] Phase 1: ${genResult.candidates.length} patterns identified (cost=$${genResult.cost.toFixed(4)})`)

      // Phase 2: Generate templates with full skill context
      log.info(`[jit-boost] Phase 2: Generating templates with skill context...`)
      const { generateTemplates } = await import("../jit-boost/candidates.ts")
      const templateResult = await generateTemplates(genResult.candidates, genResult.snippets, skillDir, outputDir)
      log.info(`[jit-boost] Phase 2: ${templateResult.candidates.length} templates generated (cost=$${templateResult.cost.toFixed(4)})`)
    } else {
      // Fallback to doc-based generation
      log.warn(`[jit-boost] No candidates from conv log — falling back to doc-based generation`)
      const fallback = await generateBoostCandidates(skillDir, outputDir)
      log.info(`[jit-boost] Fallback generated ${fallback.candidates.length} candidates (cost=$${fallback.cost.toFixed(4)})`)
    }

    // Delete stale solidification state so hooks start fresh with new candidates
    const { getJitBoostDir: getDir } = await import("../core/config.ts")
    const stateFile = path.join(getDir(skillId), "solidification-state.json")
    try { await (await import("node:fs/promises")).unlink(stateFile) } catch { /* not found is fine */ }
  } else {
    // No convLogDir — use doc-based generation as before
    const { loadBoostCandidates } = await import("../jit-boost/index.ts")
    let candidates = await loadBoostCandidates(skillId)
    if (candidates.length === 0) {
      log.info(`[jit-boost] No conv log dir — generating candidates from docs...`)
      await generateBoostCandidates(skillDir, outputDir)
    }
  }

  // -----------------------------------------------------------------------
  // Step 3: Create boost hooks and run remaining iterations
  // -----------------------------------------------------------------------
  const boost = await createBoostHooks({ skillId, extractModel: adapterConfig.model })

  for (let i = 1; i < jitRuns; i++) {
    log.info(`[jit-boost] ${task.id} run ${i + 1}/${jitRuns} (with hooks)`)
    const workDir = await prepareWorkDir(task)

    let convLog: ConversationLog | undefined
    if (convLogDir) {
      const logPath = path.join(convLogDir, task.id, `jit-boost-run-${i}.jsonl`)
      await mkdir(path.dirname(logPath), { recursive: true })
      convLog = new ConversationLog(logPath)
    }

    try {
      if ("setHooks" in adapter && typeof adapter.setHooks === "function") {
        adapter.setHooks(boost.hooks)
      }
      await adapter.setup(adapterConfig)
      const runResult = await adapter.run({
        prompt: task.prompt,
        workDir,
        skillContent,
        convLog,
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
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
    tokens: lastRunResult?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
}

// ---------------------------------------------------------------------------
// Condition: custom skill (arbitrary skill directory)
// ---------------------------------------------------------------------------

export async function runCustomSkill(
  task: BenchTask,
  adapter: AgentAdapter,
  adapterConfig: AdapterConfig,
  conditionLabel: string,
  skillDir: string,
  evaluatorConfig?: EvaluatorConfig,
  convLog?: ConversationLog,
  evalOptions?: EvaluateAllOptions,
): Promise<ConditionResult> {
  log.info(`[${conditionLabel}] ${task.id} with skill dir ${skillDir}`)

  const skillContent = await Bun.file(path.join(skillDir, "SKILL.md")).text()
  const skillId = path.basename(skillDir)

  const workDir = await prepareWorkDir(task)

  // Copy bundle files from the custom skill directory
  try {
    const entries = await readdir(skillDir, { withFileTypes: true, recursive: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const fullPath = path.join(entry.parentPath ?? skillDir, entry.name)
      const relPath = path.relative(skillDir, fullPath)
      if (relPath === "SKILL.md" || relPath.startsWith(".")) continue
      const dest = path.join(workDir, relPath)
      await mkdir(path.dirname(dest), { recursive: true })
      await copyFile(fullPath, dest)
    }
  } catch { /* no bundle files */ }

  try {
    const result = await runTask({
      task,
      adapter,
      adapterConfig,
      evaluatorConfig,
      convLog,
      skillContent,
      workDir,
      keepWorkDir: true,
      evalOptions,
    })

    return toConditionResult(conditionLabel, result.runResult, result.evalResults, {
      skillId,
      skillPath: path.join(skillDir, "SKILL.md"),
      skillContentHash: contentHash(skillContent),
      gradingWeights: task.gradingWeights,
    })
  } catch (err) {
    log.error(`[${conditionLabel}] ${task.id} failed: ${err}`)
    return {
      condition: conditionLabel,
      score: 0, pass: false, evalDetails: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0, durationMs: 0, llmDurationMs: 0, steps: 0,
      skillId,
      skillPath: path.join(skillDir, "SKILL.md"),
      skillContentHash: contentHash(skillContent),
      error: String(err),
      runStatus: "adapter-crashed",
      statusDetail: `bench orchestration threw: ${String(err).slice(0, 200)}`,
    }
  }
}
