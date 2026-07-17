/**
 * Guard: validates compiled skill output.
 *
 * The guard catches BROKEN artifacts, not structural drift. Aggressive
 * compression and restructuring are the compiler's core value — a distilled
 * variant is routinely a small fraction of the original's size — so the
 * guard must never require code blocks or headings to survive verbatim.
 *
 * Checks:
 * 1. Expansion ceiling — net added lines within a tiered budget (compression
 *    is unlimited; bloat is the failure mode).
 * 2. Non-degenerate output — the compiled skill retains a minimal amount of
 *    real content relative to the original.
 * 3. Frontmatter identity — if the original had frontmatter, the compiled
 *    skill must still open with a frontmatter block; its `name:` value must
 *    match the original's, and its `description:` must survive as something
 *    a harness can still route on. Wording may change; identity may not.
 * 4. Reference integrity — a bundle-relative path the compiled skill INVENTS
 *    (scripts/…, plus any directory actually shipped in the bundle) must
 *    exist in the shipped bundle. Hallucinated file references break the
 *    skill at runtime. References the original already carried are not this
 *    pass's doing and are left alone, so a verbatim-preserved skill always
 *    passes.
 */

export interface GuardResult {
  passed: boolean
  violations: string[]
}

export interface GuardOptions {
  /**
   * Relative paths of the files shipped alongside SKILL.md. When provided,
   * bundle-style references in the compiled skill are checked against it;
   * when omitted the reference check is skipped (callers without directory
   * context, e.g. pure-text tests).
   */
  bundlePaths?: string[]
}

export function validateGuard(
  original: string,
  compiled: string,
  opts?: GuardOptions,
): GuardResult {
  const violations: string[] = []

  // 1. Expansion ceiling: tiered threshold based on original size.
  //    Short skills (<100 lines) get generous expansion — they may need more
  //    compensation relative to their size. Long skills get tight limits —
  //    expansion there is almost certainly noise. Shrinking is never capped.
  const origLines = original.split("\n").length
  const compLines = compiled.split("\n").length
  const addedLines = compLines - origLines
  const expansionFactor = origLines < 100 ? 2.0 : origLines < 200 ? 1.0 : 0.5
  const maxAdded = Math.ceil(origLines * expansionFactor)
  if (addedLines > maxAdded) {
    violations.push(
      `Length: added ${addedLines} lines (max ${maxAdded}, ${origLines} original)`
    )
  }

  // 2. Non-degenerate output: 5% of the original's non-empty BODY lines, capped
  //    at ten. Measured on the body because frontmatter is boilerplate the
  //    compiler always reproduces — counting it, a four-key frontmatter alone
  //    cleared the floor for any original under ~80 lines, so `---\nname: x\n---`
  //    plus one line of prose passed as a compiled skill.
  const nonEmpty = (text: string) => stripFrontmatter(text).split("\n").filter((l) => l.trim().length > 0).length
  const compNonEmpty = nonEmpty(compiled)
  const floor = Math.min(10, Math.ceil(nonEmpty(original) * 0.05))
  if (compNonEmpty < floor) {
    violations.push(
      `Degenerate output: ${compNonEmpty} non-empty body lines (floor ${floor})`
    )
  }

  // 3. Frontmatter identity
  const origFrontmatter = extractFrontmatter(original)
  if (origFrontmatter !== null) {
    const compFrontmatter = extractFrontmatter(compiled)
    const origName = extractFrontmatterName(origFrontmatter)
    if (compFrontmatter === null) {
      violations.push("Frontmatter dropped (original had one)")
    } else {
      if (origName !== null) {
        const compName = extractFrontmatterName(compFrontmatter)
        if (compName === null) {
          violations.push("Frontmatter lost its name: key")
        } else if (compName !== origName) {
          violations.push(`Frontmatter name changed: "${origName}" → "${compName}"`)
        }
      }
      // `description:` is what a harness routes on: skill-loader substitutes a
      // generic placeholder when it is missing, and that placeholder is written
      // into the deployed frontmatter and the system prompt. A skill whose
      // description was dropped or reduced to a word still "works" and never
      // gets selected, which is indistinguishable from the compiler making the
      // skill useless. Wording is free to change; presence and substance are not.
      const origDescription = extractFrontmatterValue(origFrontmatter, "description")
      if (origDescription !== null && origDescription.length >= MIN_DESCRIPTION_CHARS) {
        const compDescription = extractFrontmatterValue(compFrontmatter, "description")
        if (compDescription === null) {
          violations.push("Frontmatter lost its description: key")
        } else if (compDescription.length < MIN_DESCRIPTION_CHARS) {
          violations.push(
            `Frontmatter description gutted: ${compDescription.length} chars ` +
            `(min ${MIN_DESCRIPTION_CHARS}, ${origDescription.length} original)`
          )
        }
      }
    }
  }

  // 4. Reference integrity (only when the caller supplied the bundle listing)
  if (opts?.bundlePaths !== undefined) {
    const normalized = opts.bundlePaths.map(normalizePath)
    const bundle = new Set(normalized)
    // Check the conventional bundle directories plus every top-level
    // directory the bundle actually ships — a dropped references/foo.md must
    // be caught even though "references" is not a conventional name.
    const dirs = new Set(BUNDLE_DIR_PREFIXES)
    for (const p of normalized) {
      const slash = p.indexOf("/")
      if (slash > 0) dirs.add(p.slice(0, slash))
    }
    // Only references the compilation INTRODUCED are this pass's responsibility.
    // A skill that already mentioned a file its bundle never shipped is broken
    // upstream of the compiler, and flagging it here made validateGuard(x, x)
    // fail on a verbatim-preserved skill while inflating the guard-failure count.
    const preExisting = new Set(extractBundleRefs(original, dirs).map(normalizePath))
    for (const ref of extractBundleRefs(compiled, dirs)) {
      const normalizedRef = normalizePath(ref)
      if (preExisting.has(normalizedRef)) continue
      if (!bundle.has(normalizedRef)) {
        violations.push(`Dangling reference: "${ref}" not in skill bundle`)
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  }
}

/** Directories whose mention in a skill implies a shipped bundle file. */
const BUNDLE_DIR_PREFIXES = ["scripts", "assets", "templates", "tools", "bin"]

/**
 * Extract bundle-relative file references like `scripts/helper.py` from the
 * compiled text. Only paths under the given directories (the conventional
 * bundle names plus directories the bundle actually ships) are considered —
 * bare filenames and absolute paths are ambiguous (outputs, fixtures, system
 * binaries) and produce false positives.
 */
function extractBundleRefs(text: string, dirs: ReadonlySet<string>): string[] {
  const refs = new Set<string>()
  const prefix = [...dirs].map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  const regex = new RegExp(`(?:^|[\\s\`'"(=])((?:${prefix})/[A-Za-z0-9_\\-./]+)`, "gm")
  let match
  while ((match = regex.exec(text)) !== null) {
    // Strip trailing punctuation that markdown/prose attaches to paths.
    const cleaned = match[1]!.replace(/[.,;:)\]}>]+$/, "")
    // Directory-style mentions ("scripts/") carry no file claim to verify.
    if (cleaned.endsWith("/")) continue
    refs.add(cleaned)
  }
  return [...refs]
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\\/g, "/")
}

/** CRLF-tolerant: a Windows-authored skill must not silently skip check 3. */
function extractFrontmatter(text: string): string | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return match ? match[1]! : null
}

/** Everything after the frontmatter block — the part a compiled skill is judged on. */
function stripFrontmatter(text: string): string {
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return match ? text.slice(match[0].length) : text
}

/**
 * Shortest description that can still route a skill. Well under any real one —
 * this catches "description: skill", not terseness.
 */
const MIN_DESCRIPTION_CHARS = 20

/** The trimmed, unquoted value of a frontmatter block's `name:` key. */
function extractFrontmatterName(frontmatter: string): string | null {
  return extractFrontmatterValue(frontmatter, "name")
}

/** The trimmed, unquoted value of a top-level frontmatter key. */
function extractFrontmatterValue(frontmatter: string, key: string): string | null {
  const match = frontmatter.match(new RegExp(`^${key}\\s*:\\s*(.*)$`, "m"))
  if (!match) return null
  const value = match[1]!.trim().replace(/^(["'])([\s\S]*)\1$/, "$2").trim()
  return value.length > 0 ? value : null
}
