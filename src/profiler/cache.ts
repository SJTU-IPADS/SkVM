import path from "node:path"
import { mkdir } from "node:fs/promises"
import type { TCP } from "../core/types.ts"
import { TCPSchema } from "../core/types.ts"
import { PROFILES_DIR, safeModelName } from "../core/config.ts"
import { createLogger } from "../core/logger.ts"
import type { FailureReport } from "./failure-diagnostics.ts"

const log = createLogger("cache")

// ---------------------------------------------------------------------------
// Path helpers — new layout: {harness}/{safeModel}/
// ---------------------------------------------------------------------------

/** Directory for a model-harness pair: harness/safeModel/ */
function profileDir(model: string, harness: string): string {
  return path.join(PROFILES_DIR, harness, safeModelName(model))
}

/** Path to the latest profile for a model-harness pair */
function latestPath(model: string, harness: string): string {
  return path.join(profileDir(model, harness), "latest.json")
}

/** Path to a versioned profile snapshot */
function versionPath(model: string, harness: string, profiledAt: string): string {
  return path.join(profileDir(model, harness), `v_${sanitizeTimestamp(profiledAt)}.json`)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Convert ISO timestamp to filesystem-safe format: 20260403T113957Z */
export function sanitizeTimestamp(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace(/\.\d+\+/, "+")
}

/**
 * Load a cached TCP for a (model, harness) pair.
 */
export async function loadProfile(model: string, harness: string): Promise<TCP | null> {
  const latest = latestPath(model, harness)
  const loaded = await tryLoadProfile(latest)
  if (loaded !== null) {
    if (loaded.isPartial) {
      log.info(`Skipping partial profile: ${latest}`)
      return null
    }
    return loaded
  }
  return null
}

/**
 * Save a TCP to the versioned cache.
 * Creates both a timestamped archive and a latest.json.
 */
export async function saveProfile(tcp: TCP): Promise<string> {
  const dir = profileDir(tcp.model, tcp.harness)
  await mkdir(dir, { recursive: true })

  const json = JSON.stringify(tcp, null, 2)

  // Write versioned snapshot
  const vPath = versionPath(tcp.model, tcp.harness, tcp.profiledAt)
  await Bun.write(vPath, json)

  // Write/overwrite latest
  const lPath = latestPath(tcp.model, tcp.harness)
  await Bun.write(lPath, json)

  log.info(`Saved profile: ${lPath} (archived: ${path.basename(vPath)})`)
  return lPath
}

/**
 * Save a partial (in-progress) TCP to latest.json only (no versioned snapshot).
 * Used for incremental checkpointing during profiling so interrupted runs can resume.
 */
export async function savePartialProfile(tcp: TCP): Promise<void> {
  const partial = { ...tcp, isPartial: true }
  const dir = profileDir(tcp.model, tcp.harness)
  await mkdir(dir, { recursive: true })
  const lPath = latestPath(tcp.model, tcp.harness)
  await Bun.write(lPath, JSON.stringify(partial, null, 2))
  log.info(`Saved partial profile (${tcp.details.length} primitives): ${lPath}`)
}

/**
 * Load a partial (in-progress) profile for resuming an interrupted run.
 * Returns null if latest.json doesn't exist or is a complete profile.
 */
export async function loadPartialProfile(model: string, harness: string): Promise<TCP | null> {
  const lPath = latestPath(model, harness)
  try {
    const file = Bun.file(lPath)
    if (!(await file.exists())) return null
    const data = await file.json()
    const tcp = TCPSchema.parse(data)
    if (tcp.isPartial) {
      log.info(`Found partial profile (${tcp.details.length} primitives done): ${lPath}`)
      return tcp
    }
  } catch (err) {
    log.warn(`Failed to load partial profile ${lPath}: ${err}`)
  }
  return null
}

/**
 * Check if a cached profile exists for a (model, harness) pair.
 * Returns false if the latest profile is partial (incomplete), so interrupted jobs get re-queued.
 */
export async function hasProfile(model: string, harness: string): Promise<boolean> {
  const lPath = latestPath(model, harness)
  return isCompleteProfile(lPath)
}

/**
 * List all cached profiles (latest version of each model-harness pair).
 */
export async function listProfiles(): Promise<Array<{ model: string; harness: string; profiledAt: string }>> {
  const results: Array<{ model: string; harness: string; profiledAt: string }> = []
  const seen = new Set<string>()

  // Scan layout: harness/safeModel/latest.json
  const glob = new Bun.Glob("*/*/latest.json")
  try {
    for await (const file of glob.scan(PROFILES_DIR)) {
      try {
        const data = await Bun.file(path.join(PROFILES_DIR, file)).json()
        const tcp = TCPSchema.parse(data)
        const key = `${tcp.model}::${tcp.harness}`
        if (seen.has(key)) continue
        seen.add(key)
        results.push({ model: tcp.model, harness: tcp.harness, profiledAt: tcp.profiledAt })
      } catch { /* skip invalid */ }
    }
  } catch { /* PROFILES_DIR doesn't exist yet (fresh cache) → no profiles */ }

  return results
}

/**
 * List all archived versions for a model-harness pair, sorted newest first.
 */
export async function listProfileVersions(
  model: string,
  harness: string,
): Promise<Array<{ version: string; profiledAt: string; path: string }>> {
  const dir = profileDir(model, harness)
  const glob = new Bun.Glob("v_*.json")
  const versions: Array<{ version: string; profiledAt: string; path: string }> = []

  await scanVersions(dir, glob, versions)

  return versions.sort((a, b) => b.version.localeCompare(a.version))
}

/**
 * Load a specific archived version of a profile.
 */
export async function loadProfileVersion(
  model: string,
  harness: string,
  version: string,
): Promise<TCP | null> {
  const filePath = path.join(profileDir(model, harness), `v_${version}.json`)
  try {
    const file = Bun.file(filePath)
    if (!(await file.exists())) return null
    const data = await file.json()
    return TCPSchema.parse(data)
  } catch (err) {
    log.warn(`Failed to load profile version ${filePath}: ${err}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function tryLoadProfile(filePath: string): Promise<TCP | null> {
  try {
    const file = Bun.file(filePath)
    if (!(await file.exists())) return null
    const data = await file.json()
    const tcp = TCPSchema.parse(data)
    log.info(`Loaded profile: ${filePath}`)
    return tcp
  } catch (err) {
    log.warn(`Failed to load profile ${filePath}: ${err}`)
    return null
  }
}

async function isCompleteProfile(filePath: string): Promise<boolean> {
  try {
    const file = Bun.file(filePath)
    if (!(await file.exists())) return false
    const data = await file.json()
    const tcp = TCPSchema.parse(data)
    return !tcp.isPartial
  } catch {
    return false
  }
}

async function scanVersions(
  dir: string,
  glob: InstanceType<typeof Bun.Glob>,
  versions: Array<{ version: string; profiledAt: string; path: string }>,
): Promise<void> {
  try {
    for await (const file of glob.scan(dir)) {
      const fullPath = path.join(dir, file)
      try {
        const data = await Bun.file(fullPath).json()
        const tcp = TCPSchema.parse(data)
        const version = file.replace(/^v_/, "").replace(/\.json$/, "")
        versions.push({ version, profiledAt: tcp.profiledAt, path: fullPath })
      } catch { /* skip invalid */ }
    }
  } catch { /* directory doesn't exist */ }
}

// ---------------------------------------------------------------------------
// Failure Reports Sidecar
// ---------------------------------------------------------------------------

/** Sidecar file stored alongside TCP profiles with full failure diagnostics */
export interface FailureReportsSidecar {
  profiledAt: string
  /** Keyed by "primitiveId/level", e.g. "gen.code.python/L2" */
  reports: Record<string, FailureReport[]>
}

/** Path to the failure reports sidecar for a model-harness pair */
function failureReportsPath(model: string, harness: string): string {
  return path.join(profileDir(model, harness), "failure-reports.json")
}

/**
 * Save failure reports sidecar alongside the TCP profile.
 */
export async function saveFailureReports(
  model: string,
  harness: string,
  sidecar: FailureReportsSidecar,
): Promise<void> {
  const dir = profileDir(model, harness)
  await mkdir(dir, { recursive: true })
  const fPath = failureReportsPath(model, harness)
  await Bun.write(fPath, JSON.stringify(sidecar, null, 2))
  const reportCount = Object.values(sidecar.reports).reduce((sum, arr) => sum + arr.length, 0)
  log.info(`Saved ${reportCount} failure reports: ${fPath}`)
}

/**
 * Load failure reports sidecar for a model-harness pair.
 * Returns null if the sidecar doesn't exist (backward compatible).
 */
export async function loadFailureReports(
  model: string,
  harness: string,
): Promise<FailureReportsSidecar | null> {
  const fPath = failureReportsPath(model, harness)
  try {
    const file = Bun.file(fPath)
    if (!(await file.exists())) return null
    const data = await file.json()
    return data as FailureReportsSidecar
  } catch (err) {
    log.warn(`Failed to load failure reports ${fPath}: ${err}`)
    return null
  }
}
