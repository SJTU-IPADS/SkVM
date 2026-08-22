import type { Level } from "../core/types.ts"
import { LEVEL_ORDER } from "../core/types.ts"
import type { LevelResult } from "./types.ts"
import { createLogger } from "../core/logger.ts"

const log = createLogger("calibrator")

export interface CalibrationInversion {
  primitiveId: string
  higherLevel: Exclude<Level, "L0">
  lowerLevel: Exclude<Level, "L0">
  description: string
}

/**
 * The slice of a profiling result an inversion check reads. Deliberately
 * narrower than `PrimitiveResult`: callers adapt TCP details into this shape,
 * and requiring the full result would force them to synthesize cost and
 * instance fields the check never looks at.
 */
export interface InversionCheckInput {
  primitiveId: string
  levelResults: Array<Pick<LevelResult, "level" | "passed">>
}

/**
 * Check for hierarchy inversions in profiling results.
 *
 * An inversion occurs when a higher level passes but a lower level fails
 * (e.g., L3 passed but L2 failed). This suggests the level hierarchy
 * may be miscalibrated for this model.
 */
export function detectInversions(results: InversionCheckInput[]): CalibrationInversion[] {
  const inversions: CalibrationInversion[] = []

  for (const result of results) {
    const levelMap = new Map<string, InversionCheckInput["levelResults"][number]>()
    for (const lr of result.levelResults) {
      levelMap.set(lr.level, lr)
    }

    // Check all pairs: if higher level passed but lower level failed
    const levels: Exclude<Level, "L0">[] = ["L1", "L2", "L3"]
    for (let i = 0; i < levels.length; i++) {
      for (let j = i + 1; j < levels.length; j++) {
        const lower = levels[i]!
        const higher = levels[j]!
        const lowerResult = levelMap.get(lower)
        const higherResult = levelMap.get(higher)

        if (higherResult?.passed && lowerResult && !lowerResult.passed) {
          inversions.push({
            primitiveId: result.primitiveId,
            higherLevel: higher,
            lowerLevel: lower,
            description: `${higher} passed but ${lower} failed`,
          })
          log.warn(`Inversion: ${result.primitiveId} - ${higher} passed but ${lower} failed`)
        }
      }
    }
  }

  return inversions
}

/**
 * After re-running inverted levels, resolve the final level using majority voting.
 *
 * Takes the original result and re-run results, returns the corrected highest level.
 */
export function resolveInversion(
  original: LevelResult,
  rerun: LevelResult,
): boolean {
  // Majority across both runs
  const totalPass = original.passCount + rerun.passCount
  const totalCount = original.totalCount + rerun.totalCount
  return totalPass > totalCount / 2
}
