/**
 * junit-grade — declarative grader for bun-test + regex-matched criteria.
 *
 * Replaces the 184-file dict-returning grade.py boilerplate (see
 * docs/todo/fix-grade-py-dict-return.md) with a structured payload that lives
 * directly in task.json. Zero Python, zero cookie-cutter code duplication, and
 * Zod-enforced invariants (unique ids, weights sum to 1.0, non-empty
 * descriptions, compilable regex patterns).
 *
 * Payload shape (inline in task.json under the `custom` criterion):
 *
 *   {
 *     "method": "custom",
 *     "evaluatorId": "junit-grade",
 *     "weight": 0.7,
 *     "payload": {
 *       "testFile": "agile-product-owner_task_01.test.ts",
 *       "criteria": [
 *         { "id": "backlog-exists", "weight": 0.06,
 *           "description": "...", "testPattern": "backlog.json > file exists" },
 *         ...
 *       ]
 *     }
 *   }
 *
 * At runtime this evaluator spawns `bun test <testFile> --reporter=junit`
 * from workDir (which already contains the task's fixtures), parses the
 * emitted junit.xml, and maps each testcase's `classname > name` full-name
 * against each criterion's `testPattern`. The score for a criterion is the
 * mean of its matching testcases' pass/fail (1.0 if all matching tests
 * passed, 0.0 if none passed, fractional otherwise). Criteria with no
 * matching tests score 0.0 with an explicit "no tests matched pattern" note.
 *
 * This 1:1 reproduces the behavior of the old python-grade boilerplate so the
 * migration is behaviorally pure — scores for any given task + workDir are
 * identical before and after.
 */

import { z } from "zod"
import { createLogger } from "../../core/logger.ts"
import {
  registerCustomEvaluator,
  type CustomEvaluator,
} from "../../framework/types.ts"
import { TASK_FILE_DEFAULTS } from "../../core/ui-defaults.ts"

const log = createLogger("junit-grade")

// ---------------------------------------------------------------------------
// Payload schema
// ---------------------------------------------------------------------------

const JunitGradeCriterionSchema = z.object({
  id: z.string().min(1, "criterion id must be non-empty"),
  weight: z.number().nonnegative("criterion weight must be non-negative"),
  description: z.string().min(1, "criterion description must be non-empty"),
  /**
   * Case-insensitive regex applied to each testcase's `classname > name`
   * full-name. Pipe (`|`) at the top level splits alternatives that are
   * tried independently — this matches the historical grade.py boilerplate
   * so migrated patterns preserve their exact match semantics.
   */
  testPattern: z.string().min(1, "criterion testPattern must be non-empty"),
})

export const JunitGradePayloadSchema = z
  .object({
    /** Path to the bun test file, relative to workDir. */
    testFile: z.string().min(1, "testFile must be non-empty"),
    /** Reserved for future runners (pytest, jest, …). Only "bun" is wired today. */
    runner: z.enum(["bun"]).default("bun"),
    /** Timeout for the test subprocess in milliseconds. */
    timeoutMs: z.number().int().positive().default(TASK_FILE_DEFAULTS.timeoutMs),
    criteria: z
      .array(JunitGradeCriterionSchema)
      .min(1, "criteria must be a non-empty array"),
  })
  .superRefine((val, ctx) => {
    // Weight sum must normalize to 1.0 (within floating-point tolerance).
    // This mirrors the python-grade GRADE_RUNNER_TEMPLATE's WEIGHT_TOLERANCE
    // so both evaluators share the same protocol surface.
    const sum = val.criteria.reduce((a, c) => a + c.weight, 0)
    if (Math.abs(sum - 1.0) > 1e-3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `criterion weights must sum to 1.0 ± 1e-3, got ${sum.toFixed(6)}`,
      })
    }

    // Unique ids.
    const seen = new Set<string>()
    for (const c of val.criteria) {
      if (seen.has(c.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate criterion id: ${JSON.stringify(c.id)}`,
        })
      }
      seen.add(c.id)

      // Each pipe-split alternative must be a compilable regex. We validate
      // the split alternatives rather than the joined pattern so authoring
      // bugs surface at the split boundary the runtime will actually use.
      const alts = splitAlternatives(c.testPattern)
      if (alts.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `criterion ${c.id}: testPattern has no non-empty alternatives`,
        })
      }
      for (const alt of alts) {
        try {
          // eslint-disable-next-line no-new
          new RegExp(alt, "i")
        } catch (e) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `criterion ${c.id}: invalid regex alternative ${JSON.stringify(alt)}: ${(e as Error).message}`,
          })
        }
      }
    }
  })

export type JunitGradePayload = z.infer<typeof JunitGradePayloadSchema>

// ---------------------------------------------------------------------------
// Pattern alternation split
// ---------------------------------------------------------------------------

/**
 * Split a pattern on top-level `|` alternation, respecting backslash
 * escapes. `\|` is a literal pipe (inside a regex as well as here) and does
 * not act as a separator; every other `\X` sequence is passed through
 * verbatim.
 *
 * The old grade.py boilerplate used `pattern.split("|")`, which silently
 * broke any pattern containing an escaped pipe. One of the 184 migrated
 * files (test-generator_task_02) relies on `\|` matching a literal pipe in
 * a CLI tool's output — preserving the naive split would migrate a
 * landmine forward. Handling escapes here fixes the latent bug and matches
 * what a human reading the pattern would expect.
 */
export function splitAlternatives(pattern: string): string[] {
  const out: string[] = []
  let current = ""
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]!
    if (ch === "\\" && i + 1 < pattern.length) {
      current += ch + pattern[i + 1]!
      i += 2
      continue
    }
    if (ch === "|") {
      out.push(current)
      current = ""
      i++
      continue
    }
    current += ch
    i++
  }
  out.push(current)
  return out.map((s) => s.trim()).filter(Boolean)
}

// ---------------------------------------------------------------------------
// Junit XML parser (intentionally dependency-free)
// ---------------------------------------------------------------------------

export interface JunitTestCase {
  classname: string
  name: string
  /** "classname > name" if classname is non-empty, else just name. */
  fullName: string
  failed: boolean
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
}

function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (_m, ent: string) => {
    if (ent.startsWith("#x") || ent.startsWith("#X")) {
      const cp = parseInt(ent.slice(2), 16)
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : _m
    }
    if (ent.startsWith("#")) {
      const cp = parseInt(ent.slice(1), 10)
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : _m
    }
    return XML_ENTITIES[ent] ?? _m
  })
}

/**
 * Parse a junit-format XML document (as emitted by `bun test --reporter=junit`)
 * into a flat list of testcases. We only care about name/classname and whether
 * the element has a `<failure>` or `<error>` child — everything else (time,
 * assertions, hostname, nested testsuite structure) is ignored.
 *
 * Regex-based. Bun's junit output is generator-produced and always uses
 * quoted attributes with proper entity escaping for `"`, `<`, `>`, `&`, so a
 * full XML parser is overkill; the regex approach keeps this file
 * dependency-free. Name/classname attribute values are entity-decoded before
 * being handed to criterion matching.
 */
export function parseJunitXml(xml: string): JunitTestCase[] {
  const cases: JunitTestCase[] = []
  // Match both self-closing and paired <testcase> forms. `[\s\S]` handles
  // attribute values that span newlines (bun emits literal \n in some
  // attribute values — see test fixtures).
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase\s*>)/g
  for (const m of xml.matchAll(re)) {
    const attrs = m[1] ?? ""
    const body = m[3] ?? "" // empty string when self-closing
    const name = decodeXmlEntities(extractAttr(attrs, "name") ?? "")
    const classname = decodeXmlEntities(extractAttr(attrs, "classname") ?? "")
    // A testcase is failed if its body contains a <failure> or <error> tag.
    // Self-closing testcases have an empty body and therefore never fail.
    const failed = /<(failure|error)\b/.test(body)
    const fullName = classname ? `${classname} > ${name}` : name
    cases.push({ classname, name, fullName, failed })
  }
  return cases
}

function extractAttr(attrs: string, name: string): string | undefined {
  // `[\s\S]` rather than `.` so attribute values can contain literal newlines.
  const re = new RegExp(`\\b${name}="([\\s\\S]*?)"`)
  const m = attrs.match(re)
  return m?.[1]
}

// ---------------------------------------------------------------------------
// Pattern matching (1:1 port of grade.py boilerplate behavior)
// ---------------------------------------------------------------------------

/**
 * Score a single criterion against the test results.
 *
 * Behavior mirrors the original Python grade.py boilerplate:
 *
 *   matching = {}
 *   for test_name, score in test_results.items():
 *       for p in split_alternatives(pattern):
 *           if re.search(p, test_name, re.IGNORECASE):
 *               matching[test_name] = score
 *               break
 *   score = sum(matching.values()) / len(matching) if matching else 0.0
 *
 * One deliberate divergence: the Python used `pattern.split("|")` which
 * mis-splits `\|` (escaped pipe). We use `splitAlternatives` so escaped
 * pipes are treated as literal — matches the regex author's intent and
 * fixes a latent bug in the original boilerplate. See the helper's docs.
 *
 * Returns `{ score, matched, failedFullNames }` so the evaluator can build
 * informative checkpoint details without a second pass.
 */
export function scoreCriterion(
  pattern: string,
  cases: JunitTestCase[],
): { score: number; matched: number; failedFullNames: string[] } {
  const alts = splitAlternatives(pattern).map((p) => new RegExp(p, "i"))
  const matching: JunitTestCase[] = []
  for (const tc of cases) {
    for (const re of alts) {
      if (re.test(tc.fullName)) {
        matching.push(tc)
        break
      }
    }
  }
  if (matching.length === 0) {
    return { score: 0.0, matched: 0, failedFullNames: [] }
  }
  const passed = matching.filter((tc) => !tc.failed).length
  return {
    score: passed / matching.length,
    matched: matching.length,
    failedFullNames: matching.filter((tc) => tc.failed).map((tc) => tc.fullName),
  }
}

// ---------------------------------------------------------------------------
// Evaluator implementation
// ---------------------------------------------------------------------------

export const junitGrade: CustomEvaluator = {
  validatePayload(payload) {
    JunitGradePayloadSchema.parse(payload)
  },

  async checkIntegrity(criterion, { fixturesDir }) {
    // validatePayload already guarantees payload shape; checkIntegrity only
    // catches the "shape is fine but the test file is not on disk" class of
    // authoring mistake. Without this, the junit runner spawns bun against
    // a missing file and scores the criterion 0 deterministically.
    const parsed = JunitGradePayloadSchema.safeParse(criterion.payload)
    if (!parsed.success) {
      return {
        ok: false,
        reason: `junit-grade payload invalid: ${parsed.error.message}`,
      }
    }
    const { testFile } = parsed.data
    const label = criterion.id ? `"${criterion.id}"` : "(unnamed)"
    const fs = await import("node:fs/promises")
    const pathMod = await import("node:path")
    if (pathMod.isAbsolute(testFile) || testFile.split(/[\\/]/).includes("..")) {
      return {
        ok: false,
        reason: `junit-grade criterion ${label}: testFile must be a relative path inside fixtures/`,
      }
    }
    const testPath = pathMod.join(fixturesDir, testFile)
    try {
      const s = await fs.stat(testPath)
      if (!s.isFile()) {
        return {
          ok: false,
          reason: `junit-grade criterion ${label}: testFile ${JSON.stringify(testFile)} is not a regular file under fixtures/`,
        }
      }
    } catch {
      return {
        ok: false,
        reason: `junit-grade criterion ${label}: testFile ${JSON.stringify(testFile)} not found under fixtures/`,
      }
    }
    return { ok: true }
  },

  async run({ criterion, runResult }) {
    // Payload was already validated at load time via validatePayload, but we
    // re-parse here to narrow the `unknown` type for the rest of this fn.
    // This is cheap (<1ms for any realistic criteria count).
    const parsed = JunitGradePayloadSchema.safeParse(criterion.payload)
    if (!parsed.success) {
      return {
        pass: false,
        score: 0.0,
        details: `junit-grade payload invalid: ${parsed.error.message}`,
      }
    }
    const payload = parsed.data
    const workDir = runResult.workDir

    const junitFile = "_junit_results.xml"
    const proc = Bun.spawn(
      [
        "bun",
        "test",
        payload.testFile,
        "--reporter=junit",
        `--reporter-outfile=${junitFile}`,
      ],
      {
        cwd: workDir,
        stdout: "pipe",
        stderr: "pipe",
      },
    )

    // Enforce the payload's timeout. Bun.spawn has no built-in timeout knob,
    // so we race proc.exited against a sleep and SIGKILL on expiry.
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        proc.kill("SIGKILL")
      } catch {
        /* already exited */
      }
    }, payload.timeoutMs)

    const [exitCode, stderr] = await Promise.all([
      proc.exited.then((code) => { clearTimeout(timer); return code }),
      new Response(proc.stderr).text(),
    ])
    if (stderr) log.debug(`bun test stderr: ${stderr.slice(0, 500)}`)

    if (timedOut) {
      return zeroAll(
        payload,
        `bun test timed out after ${payload.timeoutMs}ms`,
      )
    }

    // Read the junit XML. If it's missing, fall back to the exit-code
    // interpretation (matches the legacy grade.py fallback path).
    const xmlFile = Bun.file(`${workDir}/${junitFile}`)
    if (!(await xmlFile.exists())) {
      const overall = exitCode === 0 ? 1.0 : 0.0
      return uniformAll(
        payload,
        overall,
        `junit xml not produced (exitCode=${exitCode})`,
      )
    }

    let xml: string
    try {
      xml = await xmlFile.text()
    } catch (e) {
      return zeroAll(payload, `failed to read junit xml: ${(e as Error).message}`)
    }

    let cases: JunitTestCase[]
    try {
      cases = parseJunitXml(xml)
    } catch (e) {
      return zeroAll(payload, `failed to parse junit xml: ${(e as Error).message}`)
    }

    if (cases.length === 0) {
      // Empty testsuite: mirror grade.py's fallback — overall pass=exit_code_0.
      const overall = exitCode === 0 ? 1.0 : 0.0
      return uniformAll(
        payload,
        overall,
        `junit xml contained no testcases (exitCode=${exitCode})`,
      )
    }

    // Per-criterion scoring.
    const checkpoints = payload.criteria.map((c) => {
      const { score, matched, failedFullNames } = scoreCriterion(
        c.testPattern,
        cases,
      )
      const reason =
        score >= 1.0
          ? undefined
          : matched === 0
            ? `no tests matched pattern ${JSON.stringify(c.testPattern)}`
            : `failed: ${failedFullNames.slice(0, 3).join(", ")}${failedFullNames.length > 3 ? ` (+${failedFullNames.length - 3} more)` : ""}`
      return {
        name: c.id,
        score,
        weight: c.weight,
        description: c.description,
        reason,
      }
    })

    const weightedScore = checkpoints.reduce(
      (acc, cp) => acc + cp.score * cp.weight,
      0,
    )
    const breakdown = checkpoints
      .map((cp) => `${cp.name}: ${cp.score.toFixed(2)}`)
      .join(", ")

    return {
      pass: weightedScore >= 0.5,
      score: weightedScore,
      details: `${breakdown} (avg=${weightedScore.toFixed(2)})`,
      checkpoints,
    }
  },
}

/** Emit one checkpoint per criterion with score=0 and the given reason. */
function zeroAll(payload: JunitGradePayload, reason: string) {
  return uniformAll(payload, 0.0, reason)
}

function uniformAll(
  payload: JunitGradePayload,
  score: number,
  reason: string,
) {
  const checkpoints = payload.criteria.map((c) => ({
    name: c.id,
    score,
    weight: c.weight,
    description: c.description,
    reason: score >= 1.0 ? undefined : reason,
  }))
  const weightedScore = checkpoints.reduce(
    (acc, cp) => acc + cp.score * cp.weight,
    0,
  )
  return {
    pass: weightedScore >= 0.5,
    score: weightedScore,
    details: `${reason} (avg=${weightedScore.toFixed(2)})`,
    checkpoints,
  }
}

// Module-top side-effect registration. Importing this module (directly or via
// the `bench/evaluators/index.ts` barrel) is sufficient to register the
// evaluator.
registerCustomEvaluator("junit-grade", junitGrade)
