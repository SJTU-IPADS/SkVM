import path from "node:path"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import type { AgentAdapter, AdapterConfig, Level, TCP, TokenUsage } from "../core/types.ts"
import { emptyTokenUsage, addTokenUsage, LEVEL_ORDER } from "../core/types.ts"
import type { MicrobenchmarkGenerator, MicrobenchmarkInstance, LevelResult, PrimitiveResult, InstanceResult } from "./types.ts"
import type { FailureReport } from "./failure-diagnostics.ts"
import type { FailureReportsSidecar } from "./cache.ts"
import { evaluate } from "../framework/evaluator.ts"
import { createLogger, formatLogMsg, appendLogLine } from "../core/logger.ts"
import { createProgressSpinner } from "../core/spinner.ts"
import { ConversationLog } from "../core/conversation-logger.ts"
import { buildFailureDiagnostics } from "./failure-diagnostics.ts"
import { Pool, createAsyncMutex } from "../core/concurrency.ts"

const consoleLog = createLogger("profiler")

/** Create a logger that writes to both console and an optional log file. */
function createTeeLogger(logFile?: string | null) {
  const write = (level: "info" | "warn" | "debug" | "error", msg: string) => {
    consoleLog[level](msg)
    appendLogLine(logFile, formatLogMsg(level, "profiler", msg))
  }
  return {
    info: (msg: string) => write("info", msg),
    warn: (msg: string) => write("warn", msg),
    debug: (msg: string) => write("debug", msg),
    error: (msg: string) => write("error", msg),
    /** Write to log file only (no console output) */
    fileOnly: (msg: string) => appendLogLine(logFile, formatLogMsg("debug", "profiler", msg)),
  }
}

type TeeLogger = ReturnType<typeof createTeeLogger>

export interface ProfileConfig {
  /** Instances to generate per level (default: 3) */
  instancesPerLevel: number
  /** Pass threshold: how many must pass to consider level passed (default: all) */
  passThreshold?: number
}

const DEFAULT_CONFIG: ProfileConfig = {
  instancesPerLevel: 3,
}

/**
 * Profile a single primitive capability against a target.
 * Runs all levels (L1, L2, L3) and records the highest passing level.
 */
export async function profilePrimitive(
  generator: MicrobenchmarkGenerator,
  adapter: AgentAdapter,
  config: ProfileConfig = DEFAULT_CONFIG,
  log: TeeLogger = { ...consoleLog, fileOnly: () => {} },
  convLogDir?: string,
): Promise<PrimitiveResult> {
  const levels: Exclude<Level, "L0">[] = ["L1", "L2", "L3"]
  const levelResults: LevelResult[] = []
  let highestLevel: Level = "L0"

  for (const level of levels) {
    log.info(`  ${generator.primitiveId} ${level}: running ${config.instancesPerLevel} instances`)
    const result = await runLevel(generator, level, adapter, config.instancesPerLevel, log, convLogDir)
    levelResults.push(result)

    if (result.passed) {
      highestLevel = level
    }
  }

  log.info(`  ${generator.primitiveId}: highest level = ${highestLevel}`)
  return { primitiveId: generator.primitiveId, highestLevel, levelResults }
}

/**
 * Run all instances for one level of one primitive.
 */
async function runLevel(
  generator: MicrobenchmarkGenerator,
  level: Exclude<Level, "L0">,
  adapter: AgentAdapter,
  instanceCount: number,
  log: TeeLogger = { ...consoleLog, fileOnly: () => {} },
  convLogDir?: string,
): Promise<LevelResult> {
  const instances: InstanceResult[] = []
  let passCount = 0
  let totalDurationMs = 0
  let totalCostUsd = 0

  for (let i = 0; i < instanceCount; i++) {
    const inst = generator.generate(level)
    const result = await runInstance(inst, adapter, generator.primitiveId, level, i, log, convLogDir)
    instances.push(result)
    if (result.passed) passCount++
    totalDurationMs += result.durationMs
  }

  return {
    level,
    passed: passCount === instanceCount, // all must pass
    passCount,
    totalCount: instanceCount,
    instances,
    durationMs: totalDurationMs,
    costUsd: totalCostUsd,
  }
}

/**
 * Run a single microbenchmark instance.
 *
 * For tool-use primitives (gen.code.*): the agent runs with tools and writes files.
 * For text-only primitives (reason.*, gen.text.*, follow.*): the LLM response text
 * is written to response.txt before running the eval script.
 */
async function runInstance(
  inst: MicrobenchmarkInstance,
  adapter: AgentAdapter,
  primitiveId: string,
  level: string,
  index: number,
  log: TeeLogger = { ...consoleLog, fileOnly: () => {} },
  convLogDir?: string,
): Promise<InstanceResult> {
  const workDir = await mkdtemp(path.join(tmpdir(), `skvm-profile-${primitiveId}-${level}-`))
  const startMs = performance.now()
  let passed = false

  // Create per-instance conversation log and save eval script if convLogDir is set
  let convLog: ConversationLog | undefined
  if (convLogDir) {
    const instanceDir = path.join(convLogDir, primitiveId, level)
    await mkdir(instanceDir, { recursive: true })
    convLog = new ConversationLog(path.join(instanceDir, `instance-${index}.jsonl`))
    // Save eval script to disk for compiler to inspect later
    if (inst.eval.method === "script") {
      await writeFile(path.join(instanceDir, `instance-${index}-eval.sh`), inst.eval.command)
    }
  }

  try {
    // Write setup files
    if (inst.setupFiles) {
      for (const [name, content] of Object.entries(inst.setupFiles)) {
        const filePath = path.join(workDir, name)
        await mkdir(path.dirname(filePath), { recursive: true })
        await writeFile(filePath, content)
      }
    }

    // Run agent and write response.txt for eval scripts
    const runResult = await adapter.run({ prompt: inst.prompt, workDir, taskId: `${primitiveId}-${level}-${index}`, convLog })
    await writeFile(path.join(workDir, "response.txt"), runResult.text)

    // Adapter-level gate (mirrors src/framework/runner.ts): when the run
    // didn't complete cleanly, the workDir is not a trustworthy proxy for
    // agent capability. Scoring residual artifacts here would let a
    // timeout-killed L3 microbenchmark falsely raise a model's TCP profile.
    if (runResult.runStatus !== "ok") {
      const detail = runResult.statusDetail ?? `adapter runStatus=${runResult.runStatus}`
      const durationMs = performance.now() - startMs
      log.warn(`    instance ${index}: TAINTED (${(durationMs / 1000).toFixed(1)}s) runStatus=${runResult.runStatus} — ${detail}`)
      return {
        instance: index,
        passed: false,
        details: `tainted: ${detail}`,
        durationMs,
      }
    }

    // Run eval
    const evalResult = await evaluate(inst.eval, { ...runResult, workDir })
    const durationMs = performance.now() - startMs
    passed = evalResult.pass

    if (evalResult.pass) {
      log.info(`    instance ${index}: PASS (${(durationMs / 1000).toFixed(1)}s, ${runResult.steps.length} steps)`)
      return { instance: index, passed: true, details: evalResult.details, durationMs, checkpoints: evalResult.checkpoints }
    }

    // Build rich failure diagnostics
    const diagnostics = await buildFailureDiagnostics({
      runResult,
      evalDetails: evalResult.details,
      setupFiles: inst.setupFiles,
      primitiveId,
      level,
      instanceIndex: index,
      workDir,
      durationMs,
    })

    log.info(`    instance ${index}: FAIL (${(durationMs / 1000).toFixed(1)}s, ${runResult.steps.length} steps) ${evalResult.details.slice(0, 120)} ${diagnostics.consoleHint}`)
    // Write detailed diagnostics to log file only
    for (const line of diagnostics.logBlock.split("\n")) {
      log.fileOnly(line)
    }

    // Write structured failure report alongside conversation log
    if (convLogDir) {
      const reportPath = path.join(convLogDir, primitiveId, level, `instance-${index}-failure.json`)
      await mkdir(path.dirname(reportPath), { recursive: true })
      await writeFile(reportPath, JSON.stringify(diagnostics.report, null, 2))
    }

    return { instance: index, passed: false, details: diagnostics.enrichedDetails, durationMs, failureReport: diagnostics.report, checkpoints: evalResult.checkpoints }
  } catch (err) {
    const durationMs = performance.now() - startMs
    log.warn(`    instance ${index}: ERROR - ${err}`)
    return { instance: index, passed: false, details: `Error: ${err}`, durationMs }
  } finally {
    if (convLog) await convLog.finalize()
    if (passed) {
      await rm(workDir, { recursive: true, force: true })
    } else {
      log.warn(`    Preserved failed workDir: ${workDir}`)
    }
  }
}

/**
 * Profile multiple primitives and assemble a TCP.
 *
 * When `concurrency > 1` and `adapterFactory` is provided, primitives are
 * profiled in parallel using a bounded adapter pool.
 */
export async function profileTarget(opts: {
  generators: MicrobenchmarkGenerator[]
  adapter: AgentAdapter
  adapterConfig: AdapterConfig
  model: string
  harness: string
  config?: ProfileConfig
  logFile?: string
  /** Directory for per-instance conversation JSONL logs */
  convLogDir?: string
  /** Pre-existing details from a partial profile, for resume support */
  existingDetails?: TCP["details"]
  /** Called after each primitive completes, for incremental checkpointing */
  onPrimitiveComplete?: (tcp: TCP) => Promise<void>
  /** Number of primitives to profile in parallel (default: 1) */
  concurrency?: number
  /** Factory to create adapter instances for parallel mode. Called with pool index. */
  adapterFactory?: (index: number) => Promise<AgentAdapter>
  /** Whether to show a spinner for progress (default: true, disabled in multi-job). */
  showSpinner?: boolean
}): Promise<{ tcp: TCP; failureReports: FailureReportsSidecar }> {
  const config = opts.config ?? DEFAULT_CONFIG
  const log = createTeeLogger(opts.logFile)
  const startMs = performance.now()
  let totalTokens = emptyTokenUsage()

  const details: TCP["details"] = []
  const capabilities: Record<string, Level> = {}
  const failureReportsMap: Record<string, FailureReport[]> = {}

  // Resume support: pre-populate from existing partial profile
  const completed = new Set<string>()
  if (opts.existingDetails) {
    for (const d of opts.existingDetails) {
      details.push(d)
      capabilities[d.primitiveId] = d.highestLevel
      completed.add(d.primitiveId)
    }
  }

  // Filter to generators that still need profiling
  const pendingGens = opts.generators.filter((gen) => {
    if (completed.has(gen.primitiveId)) {
      log.info(`Skipping ${gen.primitiveId} (already profiled: ${capabilities[gen.primitiveId]})`)
      return false
    }
    return true
  })

  // Use a stable timestamp for the entire run
  const profiledAt = new Date().toISOString()

  const concurrency = opts.concurrency ?? 1

  /** Record one primitive result (used by both sequential and parallel paths). */
  const recordResult = (gen: MicrobenchmarkGenerator, result: PrimitiveResult) => {
    capabilities[gen.primitiveId] = result.highestLevel
    details.push({
      primitiveId: result.primitiveId,
      highestLevel: result.highestLevel,
      levelResults: result.levelResults.map((lr) => ({
        level: lr.level,
        passed: lr.passed,
        passCount: lr.passCount,
        totalCount: lr.totalCount,
        durationMs: lr.durationMs,
        costUsd: lr.costUsd,
        testDescription: gen.descriptions[lr.level],
        failureDetails: lr.instances
          .filter((i) => !i.passed)
          .map((i) => i.details),
        failureArtifacts: opts.convLogDir
          ? lr.instances
              .filter((i) => !i.passed)
              .map((i) => ({
                convLog: path.join(opts.convLogDir!, result.primitiveId, lr.level, `instance-${i.instance}.jsonl`),
                evalScript: path.join(opts.convLogDir!, result.primitiveId, lr.level, `instance-${i.instance}-eval.sh`),
              }))
          : undefined,
      })),
      calibrationNote: result.calibrationNote,
      convLogDir: opts.convLogDir
        ? path.join(opts.convLogDir, result.primitiveId)
        : undefined,
    })

    // Collect failure reports for the sidecar
    for (const lr of result.levelResults) {
      const reports = lr.instances
        .filter((i) => !i.passed && i.failureReport)
        .map((i) => i.failureReport!)
      if (reports.length > 0) {
        const key = `${gen.primitiveId}/${lr.level}`
        failureReportsMap[key] = reports
      }
    }
  }

  /** Build a partial TCP snapshot for checkpointing. */
  const buildPartialTcp = (): TCP => ({
    version: "1.0",
    model: opts.model,
    harness: opts.harness,
    profiledAt,
    capabilities: { ...capabilities },
    details: [...details],
    cost: {
      totalUsd: 0,
      totalTokens: { ...totalTokens },
      durationMs: performance.now() - startMs,
    },
    isPartial: true,
  })

  const progress = opts.showSpinner !== false
    ? createProgressSpinner("Profiling", pendingGens.length)
    : { tick() {}, stop() {} }

  if (concurrency > 1 && opts.adapterFactory && pendingGens.length > 1) {
    // ---- Parallel path ----
    const poolSize = Math.min(concurrency, pendingGens.length)
    const poolAdapters: AgentAdapter[] = []

    try {
      for (let i = 0; i < poolSize; i++) {
        poolAdapters.push(await opts.adapterFactory(i))
      }
    } catch (err) {
      // Teardown any already-created adapters on failure
      for (const a of poolAdapters) {
        try { await a.teardown() } catch { /* ignore */ }
      }
      progress.stop()
      throw err
    }

    const pool = new Pool(poolAdapters)
    const withLock = createAsyncMutex()

    log.info(`Profiling ${pendingGens.length} primitives (concurrency=${poolSize})`)

    await Promise.allSettled(pendingGens.map(async (gen) => {
      const adapter = await pool.acquire()
      try {
        log.info(`Profiling ${gen.primitiveId}...`)
        const result = await profilePrimitive(gen, adapter, config, log, opts.convLogDir)

        await withLock(async () => {
          recordResult(gen, result)
          progress.tick(`Profiled ${pendingGens.length} primitives`)
          if (opts.onPrimitiveComplete) {
            await opts.onPrimitiveComplete(buildPartialTcp())
          }
        })
      } catch (err) {
        log.error(`${gen.primitiveId}: ERROR - ${err}`)
        progress.tick()
      } finally {
        pool.release(adapter)
      }
    }))

    // Teardown pool adapters
    for (const a of poolAdapters) {
      try { await a.teardown() } catch { /* ignore */ }
    }
  } else {
    // ---- Sequential path (original behavior) ----
    await opts.adapter.setup(opts.adapterConfig)

    for (const gen of pendingGens) {
      log.info(`Profiling ${gen.primitiveId}...`)
      const result = await profilePrimitive(gen, opts.adapter, config, log, opts.convLogDir)
      recordResult(gen, result)
      progress.tick(`Profiled ${pendingGens.length} primitives`)

      if (opts.onPrimitiveComplete) {
        await opts.onPrimitiveComplete(buildPartialTcp())
      }
    }

    await opts.adapter.teardown()
  }

  const durationMs = performance.now() - startMs

  const tcp: TCP = {
    version: "1.0",
    model: opts.model,
    harness: opts.harness,
    profiledAt,
    capabilities,
    details,
    cost: {
      totalUsd: 0,
      totalTokens,
      durationMs,
    },
    isPartial: false,
  }

  const failureReports: FailureReportsSidecar = {
    profiledAt,
    reports: failureReportsMap,
  }

  return { tcp, failureReports }
}
