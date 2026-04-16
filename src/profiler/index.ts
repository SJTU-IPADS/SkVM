import type { TCP, AdapterConfig, Level } from "../core/types.ts"
import type { AgentAdapter } from "../core/types.ts"
import { emptyTokenUsage } from "../core/types.ts"
import { getAllPrimitives, ALL_PRIMITIVE_IDS } from "../core/primitives.ts"
import { getGenerator, getAllGenerators } from "./generators/index.ts"
import type { MicrobenchmarkGenerator, PrimitiveResult } from "./types.ts"
import { profileTarget, profilePrimitive, type ProfileConfig } from "./runner.ts"
import { loadProfile, saveProfile, loadPartialProfile, savePartialProfile, saveFailureReports } from "./cache.ts"
import type { FailureReportsSidecar } from "./cache.ts"
import type { FailureReport } from "./failure-diagnostics.ts"
import { detectInversions } from "./calibrator.ts"
import { createLogger } from "../core/logger.ts"
import { createProgressSpinner } from "../core/spinner.ts"
import { runScheduled, createAsyncMutex, type WorkItem, type RunnerHandle } from "../core/concurrency.ts"

const log = createLogger("profiler")

export interface ProfileOptions {
  model: string
  harness: string
  adapter: AgentAdapter
  adapterConfig: AdapterConfig
  /** Comma-separated primitive IDs to profile (default: all registered) */
  primitives?: string[]
  /** Primitive IDs to skip */
  skip?: string[]
  /** Instances per level (default: 3) */
  instances?: number
  /** Force re-profile even if cached (default: false) */
  force?: boolean
  /** Path to a log file for this profile run (appended alongside console) */
  logFile?: string
  /** Directory for per-instance conversation JSONL logs */
  convLogDir?: string
  /** Number of primitives to profile in parallel (default: 1) */
  concurrency?: number
  /** Factory to create adapter instances for parallel mode. Called with pool index. */
  adapterFactory?: (index: number) => Promise<AgentAdapter>
  /** Whether to show a spinner for progress (default: true, disabled in multi-job). */
  showSpinner?: boolean
}

/**
 * Profile a model+harness target. Uses cache if available.
 */
export async function profile(opts: ProfileOptions): Promise<TCP> {
  const { model, harness, adapter, adapterConfig, force } = opts

  // Check cache
  if (!force) {
    const cached = await loadProfile(model, harness)
    if (cached) {
      log.info(`Using cached profile for ${model}--${harness}`)
      return cached
    }
  }

  // Resolve generators
  const skipSet = opts.skip ? new Set(opts.skip) : undefined
  const primitiveIds = (opts.primitives ?? getRegisteredPrimitiveIds())
    .filter(id => !skipSet?.has(id))
  const generators = primitiveIds
    .map((id) => getGenerator(id))
    .filter((g): g is NonNullable<typeof g> => g !== undefined)

  if (generators.length === 0) {
    throw new Error(`No generators found for primitives: ${primitiveIds.join(", ")}`)
  }

  const missing = primitiveIds.filter((id) => !getGenerator(id))
  if (missing.length > 0) {
    log.warn(`No generators for: ${missing.join(", ")} (skipping)`)
  }

  log.info(`Profiling ${generators.length} primitives for ${model}--${harness}`)

  const config: ProfileConfig = {
    instancesPerLevel: opts.instances ?? 3,
  }

  // Resume support: load existing details from partial or complete profile.
  // When --force + --primitives, keep results for primitives NOT being re-profiled.
  let existingDetails: TCP["details"] | undefined
  if (!force) {
    const partial = await loadPartialProfile(model, harness)
    if (partial) {
      existingDetails = partial.details
      log.info(`Resuming from partial profile: ${existingDetails.length}/${generators.length} primitives already done`)
    }
  } else if (opts.primitives) {
    // --force with explicit primitives: preserve other primitives from existing profile
    const existing = await loadProfile(model, harness) ?? await loadPartialProfile(model, harness)
    if (existing) {
      const forcedSet = new Set(primitiveIds)
      existingDetails = existing.details.filter(d => !forcedSet.has(d.primitiveId))
      log.info(`Force re-profiling ${primitiveIds.length} primitives, preserving ${existingDetails.length} existing results`)
    }
  }

  // Run profiling (with resume support and incremental checkpointing)
  const { tcp, failureReports } = await profileTarget({
    generators,
    adapter,
    adapterConfig,
    model,
    harness,
    config,
    logFile: opts.logFile,
    convLogDir: opts.convLogDir,
    existingDetails,
    onPrimitiveComplete: (partialTcp) => savePartialProfile(partialTcp),
    concurrency: opts.concurrency,
    adapterFactory: opts.adapterFactory,
    showSpinner: opts.showSpinner,
  })

  // Check for inversions
  const inversions = detectInversions(tcp.details.map((d) => ({
    primitiveId: d.primitiveId,
    highestLevel: d.highestLevel,
    levelResults: d.levelResults.map((lr) => ({
      level: lr.level,
      passed: lr.passed,
      passCount: lr.passCount,
      totalCount: lr.totalCount,
      instances: [],
      durationMs: lr.durationMs,
      costUsd: lr.costUsd,
    })),
  })))

  if (inversions.length > 0) {
    log.warn(`Detected ${inversions.length} hierarchy inversions:`)
    for (const inv of inversions) {
      log.warn(`  ${inv.primitiveId}: ${inv.description}`)
    }
    // TODO: re-run inverted levels and resolve
  }

  // Cache result
  const savedPath = await saveProfile(tcp)
  log.info(`Profile saved: ${savedPath}`)

  // Save failure reports sidecar
  if (Object.keys(failureReports.reports).length > 0) {
    await saveFailureReports(model, harness, failureReports)
  }

  return tcp
}

// ---------------------------------------------------------------------------
// Multi-job profiling via unified scheduler
// ---------------------------------------------------------------------------

export interface ProfileMultiJob {
  model: string
  harness: string
}

export interface ProfileMultiOptions {
  jobs: ProfileMultiJob[]
  createAdapter: (harness: string) => AgentAdapter
  /** Comma-separated primitive IDs to profile (default: all registered) */
  primitives?: string[]
  /** Instances per level (default: 3) */
  instances?: number
  /** Force re-profile even if cached (default: false) */
  force?: boolean
  /** Total concurrency slots */
  concurrency: number
  /** Factory for log dir path per (harness, model) */
  logDirFactory: (harness: string, model: string) => string
}

interface ProfileAccumulator {
  model: string
  harness: string
  profiledAt: string
  startMs: number
  details: TCP["details"]
  capabilities: Record<string, Level>
  failureReportsMap: Record<string, FailureReport[]>
  completed: Set<string>
}

interface ProfileWorkPayload {
  generator: MicrobenchmarkGenerator
  logDir: string
}

/**
 * Profile multiple (model, adapter) jobs using the unified scheduler.
 * Adapter-first distribution, sequential model processing within each adapter,
 * with work-stealing when one adapter group finishes.
 */
export async function profileMulti(opts: ProfileMultiOptions): Promise<{
  results: Map<string, { tcp: TCP; failureReports: FailureReportsSidecar }>
  failures: Array<{ model: string; harness: string; error: string }>
}> {
  const config: ProfileConfig = { instancesPerLevel: opts.instances ?? 3 }

  // Resolve generators (same for all jobs)
  const primitiveIds = opts.primitives ?? getRegisteredPrimitiveIds()
  const generators = primitiveIds
    .map((id) => getGenerator(id))
    .filter((g): g is NonNullable<typeof g> => g !== undefined)

  if (generators.length === 0) {
    throw new Error(`No generators found for primitives: ${primitiveIds.join(", ")}`)
  }

  // Per-group accumulator and work items
  const groupKey = (m: string, h: string) => `${m}--${h}`
  const accumulators = new Map<string, ProfileAccumulator>()
  const allItems: WorkItem<ProfileWorkPayload>[] = []

  for (const job of opts.jobs) {
    const key = groupKey(job.model, job.harness)
    const profiledAt = new Date().toISOString()

    // Resume support: load existing partial profile
    let existingDetails: TCP["details"] | undefined
    if (!opts.force) {
      const partial = await loadPartialProfile(job.model, job.harness)
      if (partial) {
        existingDetails = partial.details
        log.info(`${job.model}--${job.harness}: resuming from ${existingDetails.length} primitives`)
      }
    } else if (opts.primitives) {
      const existing = await loadProfile(job.model, job.harness) ?? await loadPartialProfile(job.model, job.harness)
      if (existing) {
        const forcedSet = new Set(primitiveIds)
        existingDetails = existing.details.filter(d => !forcedSet.has(d.primitiveId))
      }
    }

    const acc: ProfileAccumulator = {
      model: job.model,
      harness: job.harness,
      profiledAt,
      startMs: performance.now(),
      details: [],
      capabilities: {},
      failureReportsMap: {},
      completed: new Set(),
    }

    // Pre-populate from existing details
    if (existingDetails) {
      for (const d of existingDetails) {
        acc.details.push(d)
        acc.capabilities[d.primitiveId] = d.highestLevel
        acc.completed.add(d.primitiveId)
      }
    }

    accumulators.set(key, acc)

    const logDir = opts.logDirFactory(job.harness, job.model)

    // Build work items for pending primitives
    for (const gen of generators) {
      if (acc.completed.has(gen.primitiveId)) {
        log.info(`${job.model}--${job.harness}: skip ${gen.primitiveId} (already profiled)`)
        continue
      }
      allItems.push({
        adapter: job.harness,
        model: job.model,
        payload: { generator: gen, logDir },
      })
    }
  }

  log.info(`Profile: ${allItems.length} primitives across ${opts.jobs.length} jobs (concurrency=${opts.concurrency})`)

  const withLock = createAsyncMutex()
  const failures: Array<{ model: string; harness: string; error: string }> = []
  const multiProgress = createProgressSpinner("Profiling", allItems.length)

  await runScheduled({
    concurrency: opts.concurrency,
    items: allItems,
    createRunner: async (harness, model) => {
      const adapter = opts.createAdapter(harness)
      await adapter.setup({ model, maxSteps: 25, timeoutMs: 300_000 })
      return { adapter, teardown: async () => adapter.teardown() } as { adapter: AgentAdapter } & RunnerHandle
    },
    execute: async (runner, item) => {
      const { generator, logDir } = item.payload
      log.info(`${item.model}--${item.adapter}: profiling ${generator.primitiveId}...`)

      const result = await profilePrimitive(generator, runner.adapter, config, undefined, logDir)
      const key = groupKey(item.model, item.adapter)
      const acc = accumulators.get(key)!

      await withLock(async () => {
        recordPrimitiveResult(acc, generator, result)
        multiProgress.tick(`Profiled ${allItems.length} primitives across ${opts.jobs.length} jobs`)

        // Incremental checkpoint
        const partialTcp = buildTcpFromAccumulator(acc, true)
        await savePartialProfile(partialTcp)
      })
    },
    onError: (item, err) => {
      const msg = err instanceof Error ? err.message : String(err)
      log.error(`${item.model}--${item.adapter} ${item.payload.generator.primitiveId}: ${msg}`)
      failures.push({ model: item.model, harness: item.adapter, error: msg })
      multiProgress.tick()
    },
  })

  // Finalize: build TCPs, detect inversions, save profiles
  const results = new Map<string, { tcp: TCP; failureReports: FailureReportsSidecar }>()

  for (const [key, acc] of accumulators) {
    const tcp = buildTcpFromAccumulator(acc, false)

    const inversions = detectInversions(tcp.details.map((d) => ({
      primitiveId: d.primitiveId,
      highestLevel: d.highestLevel,
      levelResults: d.levelResults.map((lr) => ({
        level: lr.level,
        passed: lr.passed,
        passCount: lr.passCount,
        totalCount: lr.totalCount,
        instances: [],
        durationMs: lr.durationMs,
        costUsd: lr.costUsd,
      })),
    })))

    if (inversions.length > 0) {
      log.warn(`${acc.model}--${acc.harness}: ${inversions.length} hierarchy inversions`)
      for (const inv of inversions) {
        log.warn(`  ${inv.primitiveId}: ${inv.description}`)
      }
    }

    const savedPath = await saveProfile(tcp)
    log.info(`${acc.model}--${acc.harness}: saved ${savedPath}`)

    const failureReports: FailureReportsSidecar = {
      profiledAt: acc.profiledAt,
      reports: acc.failureReportsMap,
    }

    if (Object.keys(failureReports.reports).length > 0) {
      await saveFailureReports(acc.model, acc.harness, failureReports)
    }

    results.set(key, { tcp, failureReports })
  }

  return { results, failures }
}

/** Record a primitive result into an accumulator. */
function recordPrimitiveResult(
  acc: ProfileAccumulator,
  gen: MicrobenchmarkGenerator,
  result: PrimitiveResult,
): void {
  acc.capabilities[gen.primitiveId] = result.highestLevel
  acc.details.push({
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
    })),
    calibrationNote: result.calibrationNote,
  })

  for (const lr of result.levelResults) {
    const reports = lr.instances
      .filter((i) => !i.passed && i.failureReport)
      .map((i) => i.failureReport!)
    if (reports.length > 0) {
      const mapKey = `${gen.primitiveId}/${lr.level}`
      acc.failureReportsMap[mapKey] = reports
    }
  }

  acc.completed.add(gen.primitiveId)
}

/** Build a TCP from an accumulator. */
function buildTcpFromAccumulator(acc: ProfileAccumulator, isPartial: boolean): TCP {
  return {
    version: "1.0",
    model: acc.model,
    harness: acc.harness,
    profiledAt: acc.profiledAt,
    capabilities: { ...acc.capabilities },
    details: [...acc.details],
    cost: {
      totalUsd: 0,
      totalTokens: emptyTokenUsage(),
      durationMs: performance.now() - acc.startMs,
    },
    isPartial,
  }
}

function getRegisteredPrimitiveIds(): string[] {
  return getAllGenerators().map((g) => g.primitiveId)
}

export { loadProfile, saveProfile, savePartialProfile, loadPartialProfile, hasProfile, listProfiles, listProfileVersions, loadProfileVersion, saveFailureReports, loadFailureReports } from "./cache.ts"
export type { FailureReportsSidecar } from "./cache.ts"
