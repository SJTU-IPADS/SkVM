/**
 * Wording/suggestion engine behind the declarative flag parser
 * (`src/cli/flags.ts`): the set of global flags every command accepts, and
 * typo-aware "unknown flag" error formatting shared across all commands.
 *
 * `formatUnknownFlagErrors` terminates a command with a loud error when a
 * flag is misspelled (e.g. `--adpter` instead of `--adapter`) instead of
 * silently falling through to the default — see #12 for the typo-hint
 * history.
 */

export const GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  "help",
  "verbose",
  "skvm-cache",
  "skvm-data-dir",
  "tmp-dir",
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

/**
 * Build the unknown-flag error lines for `flagKeys` against
 * `knownFlags ∪ GLOBAL_FLAGS`. Returns `[]` when every key is known.
 * Single source of truth for the wording — consumed by `src/cli/flags.ts`
 * (UsageError path).
 */
export function formatUnknownFlagErrors(
  commandLabel: string,
  flagKeys: Iterable<string>,
  knownFlags: ReadonlySet<string>,
): string[] {
  const unknown: string[] = []
  for (const key of flagKeys) {
    if (GLOBAL_FLAGS.has(key) || knownFlags.has(key)) continue
    unknown.push(key)
  }
  if (unknown.length === 0) return []

  // Suggestions are drawn from the union (global + per-command) so
  // `--vrbose` finds `--verbose` even though it's a global flag.
  const universe: string[] = [...knownFlags, ...GLOBAL_FLAGS]
  const lines: string[] = []
  for (const key of unknown) {
    const hint = suggestFlag(key, universe)
    if (hint !== null) {
      lines.push(`${commandLabel}: Unknown flag --${key}. Did you mean --${hint}?`)
    } else {
      lines.push(`${commandLabel}: Unknown flag --${key}.`)
    }
  }
  lines.push(`Run 'skvm ${commandLabel} --help' for the list of supported flags.`)
  return lines
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
