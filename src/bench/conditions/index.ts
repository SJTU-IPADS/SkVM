import type { BenchCondition } from "../types.ts"
import { parseAotPasses } from "../types.ts"
import type { ConditionKind, ConditionRunner } from "./types.ts"
import { noSkillRunner } from "./no-skill.ts"
import { originalRunner } from "./original.ts"
import { jitOptimizedRunner } from "./jit-optimized.ts"
import { jitBoostRunner } from "./jit-boost.ts"
import { aotVariantRunner } from "./aot-variant.ts"

/**
 * Static, exhaustively type-checked condition registry. Adding a
 * `ConditionKind` without a runner here is a compile error — deliberately
 * NOT the self-registration pattern used by custom evaluators, whose
 * registration silently depends on a barrel side-effect import.
 */
export const CONDITION_RUNNERS = {
  "no-skill": noSkillRunner,
  "original": originalRunner,
  "jit-optimized": jitOptimizedRunner,
  "jit-boost": jitBoostRunner,
  "aot-variant": aotVariantRunner,
} satisfies Record<ConditionKind, ConditionRunner>

/**
 * Map a concrete condition string to its runner kind. The four fixed names
 * map to themselves; AOT pass-globs ("aot-compiled", "aot-compiled-p12", …)
 * resolve to "aot-variant". Returns null for unknown conditions.
 */
export function resolveConditionKind(condition: BenchCondition): ConditionKind | null {
  switch (condition) {
    case "no-skill":
    case "original":
    case "jit-optimized":
    case "jit-boost":
      return condition
    default:
      return parseAotPasses(condition) !== null ? "aot-variant" : null
  }
}

// Beyond the registry, the barrel re-exports only what external consumers
// actually import (custom-plan); internals import their siblings directly.
export type { ConditionKind, ConditionRunner, ConditionContext } from "./types.ts"
export { runCondition } from "./run-condition.ts"
export { runCustomSkill } from "./custom-skill.ts"
