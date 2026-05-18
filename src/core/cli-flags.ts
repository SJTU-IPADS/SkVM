/**
 * Reject unknown CLI flags with a typo-aware error, and parse skill-mode flag.
 *
 * Each `runX` function in src/index.ts (and the bench mode dispatcher) calls
 * `assertKnownFlags(label, flags, KNOWN_FLAGS)` at the very top so that a
 * misspelled flag (e.g. `--adpter` instead of `--adapter`) terminates with a
 * loud error instead of silently falling through to the default. See #12.
 */

import type { SkillMode } from "./types.ts"

export const GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  "help",
  "verbose",
  "skvm-cache",
  "skvm-data-dir",
])

/**
 * Lowest Levenshtein-distance candidate among `known`. Returns null if the
 * best candidate has distance > 2 (anything further is more likely a wrong
 * flag than a typo and is noise as a "did you mean"). On ties, the
 * lexically-smallest candidate wins so the suggestion is stable.
 */
export function suggestFlag(typo: string, known: Iterable<string>): string | null {
  let best: string | null = null
  let bestDist = Infinity
  for (const candidate of known) {
    const d = levenshtein(typo, candidate)
    if (d < bestDist || (d === bestDist && best !== null && candidate < best)) {
      best = candidate
      bestDist = d
    }
  }
  return bestDist <= 2 ? best : null
}

export function assertKnownFlags(
  commandLabel: string,
  flags: Record<string, string>,
  knownFlags: ReadonlySet<string>,
): void {
  const unknown: string[] = []
  for (const key of Object.keys(flags)) {
    if (GLOBAL_FLAGS.has(key) || knownFlags.has(key)) continue
    unknown.push(key)
  }
  if (unknown.length === 0) return

  // Suggestions are drawn from the union (global + per-command) so
  // `--vrbose` finds `--verbose` even though it's a global flag.
  const universe: string[] = [...knownFlags, ...GLOBAL_FLAGS]
  for (const key of unknown) {
    const hint = suggestFlag(key, universe)
    if (hint !== null) {
      console.error(`${commandLabel}: Unknown flag --${key}. Did you mean --${hint}?`)
    } else {
      console.error(`${commandLabel}: Unknown flag --${key}.`)
    }
  }
  console.error(`Run 'skvm ${commandLabel} --help' for the list of supported flags.`)
  process.exit(1)
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  const prev = new Array(b.length + 1)
  const curr = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]
  }
  return prev[b.length]
}

/**
 * Parse the --skill-mode flag, returning the mode or undefined if not set.
 *
 * Valid values: "inject" | "discover"
 * Exits with error on invalid value.
 * Keep this module small and side-effect free except for the deliberate
 * `process.exit` on validation failure, which is the standard error path
 * used by all other CLI flag handling in src/index.ts.
 */
export function parseSkillModeFlag(flags: Record<string, string>): SkillMode | undefined {
  const v = flags["skill-mode"]
  if (v === undefined) return undefined
  if (v !== "inject" && v !== "discover") {
    console.error(`Error: unknown skill mode "${v}". Valid: inject, discover`)
    process.exit(1)
  }
  return v
}
