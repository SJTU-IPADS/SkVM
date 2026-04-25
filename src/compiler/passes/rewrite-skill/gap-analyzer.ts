import type { SCR, TCP, CapabilityGap, Level } from "../../../core/types.ts"
import { LEVEL_ORDER } from "../../../core/types.ts"

/**
 * Analyze gaps between a skill's capability requirements (SCR) and
 * a target's capability profile (TCP).
 *
 * For each primitive requirement in the SCR's current path:
 * - If TCP level >= required level → no gap
 * - If TCP level < required level but > L0 → "weak" gap
 * - If TCP level = L0 (capability absent) → "missing" gap
 *
 * Pure computation, no LLM calls.
 */
export function analyzeGaps(scr: SCR, tcp: TCP): CapabilityGap[] {
  const gaps: CapabilityGap[] = []

  for (const purpose of scr.purposes) {
    for (const prim of purpose.currentPath.primitives) {
      const modelLevel = (tcp.capabilities[prim.id] ?? "L0") as Level
      const requiredLevel = prim.minLevel as Level

      if (LEVEL_ORDER[modelLevel] < LEVEL_ORDER[requiredLevel]) {
        gaps.push({
          purposeId: purpose.id,
          primitiveId: prim.id,
          requiredLevel: requiredLevel as "L1" | "L2" | "L3",
          modelLevel: modelLevel as "L0" | "L1" | "L2" | "L3",
          gapType: modelLevel === "L0" ? "missing" : "weak",
        })
      }
    }
  }

  return gaps
}

/**
 * Filter gaps to only those worth compensating.
 *
 * Drops single-level weak gaps (e.g., L2 required, L1 actual) — these are
 * marginal and compensation often introduces more noise than value.
 * Missing gaps and multi-level weak gaps are always kept.
 */
export function filterCompensableGaps(gaps: CapabilityGap[]): CapabilityGap[] {
  return gaps.filter((gap) => {
    if (gap.gapType === "missing") return true
    const gapSize = LEVEL_ORDER[gap.requiredLevel] - LEVEL_ORDER[gap.modelLevel]
    return gapSize > 1
  })
}
