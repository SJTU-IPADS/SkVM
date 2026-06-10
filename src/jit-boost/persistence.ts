import path from "node:path"
import { mkdir } from "node:fs/promises"
import type { BoostCandidate, SolidificationState } from "./types.ts"
import { BoostCandidatesFileSchema, SolidificationStateSchema } from "./types.ts"
import { getJitBoostDir } from "../proposals/storage.ts"
import { createLogger } from "../core/logger.ts"

const log = createLogger("jit-boost-persistence")

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function candidatesPath(skillId: string): string {
  return path.join(getJitBoostDir(skillId), "boost-candidates.json")
}

/** Solidification-state file inside the skill's jit-boost tree (exported for the bench runner's stale-state reset). */
export function solidificationStatePath(skillId: string): string {
  return path.join(getJitBoostDir(skillId), "solidification-state.json")
}

// ---------------------------------------------------------------------------
// Boost Candidates
// ---------------------------------------------------------------------------

/**
 * Load boost candidates for a skill.
 * Returns empty array if file is missing.
 */
export async function loadBoostCandidates(skillId: string): Promise<BoostCandidate[]> {
  const filePath = candidatesPath(skillId)
  const file = Bun.file(filePath)

  if (!(await file.exists())) {
    log.debug(`No boost-candidates.json for skill ${skillId}`)
    return []
  }

  try {
    const raw = await file.json()
    const parsed = BoostCandidatesFileSchema.parse(raw)
    log.info(`Loaded ${parsed.candidates.length} boost candidates for ${skillId}`)
    return parsed.candidates
  } catch (err) {
    log.warn(`Failed to load boost-candidates.json for ${skillId}: ${err}`)
    return []
  }
}

/**
 * Save boost candidates for a skill.
 */
export async function saveBoostCandidates(
  skillId: string,
  candidates: BoostCandidate[],
): Promise<void> {
  const dir = getJitBoostDir(skillId)
  await mkdir(dir, { recursive: true })
  const data = BoostCandidatesFileSchema.parse({ candidates })
  await Bun.write(candidatesPath(skillId), JSON.stringify(data, null, 2))
  log.info(`Saved ${candidates.length} boost candidates for ${skillId}`)
}

// ---------------------------------------------------------------------------
// Solidification State
// ---------------------------------------------------------------------------

/**
 * Load persisted solidification state for a skill.
 * Returns null if file is missing (fresh start).
 */
export async function loadSolidificationState(
  skillId: string,
): Promise<SolidificationState | null> {
  const filePath = solidificationStatePath(skillId)
  const file = Bun.file(filePath)

  if (!(await file.exists())) return null

  try {
    const raw = await file.json()
    return SolidificationStateSchema.parse(raw)
  } catch (err) {
    log.warn(`Failed to load solidification-state.json for ${skillId}: ${err}`)
    return null
  }
}

/**
 * Save solidification state for a skill.
 */
export async function saveSolidificationState(
  skillId: string,
  state: SolidificationState,
): Promise<void> {
  const dir = getJitBoostDir(skillId)
  await mkdir(dir, { recursive: true })
  const validated = SolidificationStateSchema.parse(state)
  await Bun.write(solidificationStatePath(skillId), JSON.stringify(validated, null, 2))
  log.debug(`Saved solidification state for ${skillId}`)
}
