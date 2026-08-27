/**
 * Unit tests for the junit-grade evaluator.
 *
 * Covers:
 *   - parseJunitXml: entity decoding, self-closing testcases, failure/error
 *     detection, nested testsuite structure (as emitted by bun test)
 *   - scoreCriterion: pipe-split alternatives, case-insensitivity, empty
 *     match semantics (1:1 with the legacy grade.py behavior)
 *   - JunitGradePayloadSchema: weight sum, duplicate ids, empty
 *     description, invalid regex
 *   - validatePayload integration with hydrateEvalPayloads (load-time
 *     failure — this is the whole reason validatePayload exists)
 *   - end-to-end run() against a real bun test fixture in a temp workDir
 */

import { describe, test, expect } from "bun:test"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import {
  junitGrade,
  parseJunitXml,
  scoreCriterion,
  splitAlternatives,
  JunitGradePayloadSchema,
  type JunitGradePayload,
} from "../../../src/bench/evaluators/junit-grade.ts"
import { hydrateEvalPayloads } from "../../../src/bench/evaluators/index.ts"
import type { EvalCriterion, RunResult } from "../../../src/core/types.ts"

const baseRunResult = (workDir: string): RunResult => ({
  text: "",
  steps: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  cost: 0,
  durationMs: 0,
  llmDurationMs: 0,
  workDir,
  runStatus: "ok",
})

// ---------------------------------------------------------------------------
// parseJunitXml
// ---------------------------------------------------------------------------

describe("parseJunitXml", () => {
  test("parses self-closing testcases as passed", () => {
    const xml = `
      <testsuites>
        <testsuite name="a.test.ts">
          <testcase name="one" classname="group" time="0" />
          <testcase name="two" classname="group" time="0" />
        </testsuite>
      </testsuites>`
    const cases = parseJunitXml(xml)
    expect(cases).toHaveLength(2)
    expect(cases[0]!.fullName).toBe("group > one")
    expect(cases[0]!.failed).toBe(false)
    expect(cases[1]!.failed).toBe(false)
  })

  test("detects <failure> and <error> children as failed", () => {
    const xml = `
      <testsuite name="a.test.ts">
        <testcase name="a" classname="g" time="0">
          <failure type="AssertionError" />
        </testcase>
        <testcase name="b" classname="g" time="0">
          <error message="boom">boom</error>
        </testcase>
        <testcase name="c" classname="g" time="0" />
      </testsuite>`
    const cases = parseJunitXml(xml)
    expect(cases).toHaveLength(3)
    expect(cases[0]!.failed).toBe(true)
    expect(cases[1]!.failed).toBe(true)
    expect(cases[2]!.failed).toBe(false)
  })

  test("decodes XML entities in name and classname", () => {
    const xml = `
      <testsuite>
        <testcase name="a &amp; b &lt; c" classname="foo &quot;bar&quot;" time="0" />
      </testsuite>`
    const cases = parseJunitXml(xml)
    expect(cases).toHaveLength(1)
    expect(cases[0]!.name).toBe("a & b < c")
    expect(cases[0]!.classname).toBe('foo "bar"')
    expect(cases[0]!.fullName).toBe('foo "bar" > a & b < c')
  })

  test("decodes numeric character references", () => {
    const xml = `<testsuite><testcase name="line&#10;break" classname="g" /></testsuite>`
    const cases = parseJunitXml(xml)
    expect(cases[0]!.name).toBe("line\nbreak")
  })

  test("handles empty classname: fullName falls back to name alone", () => {
    const xml = `<testsuite><testcase name="orphan" time="0" /></testsuite>`
    const cases = parseJunitXml(xml)
    expect(cases).toHaveLength(1)
    expect(cases[0]!.classname).toBe("")
    expect(cases[0]!.fullName).toBe("orphan")
  })

  test("returns empty list for xml with no testcases", () => {
    expect(parseJunitXml("<testsuites />")).toEqual([])
    expect(parseJunitXml("")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// splitAlternatives — respects backslash escapes
// ---------------------------------------------------------------------------

describe("splitAlternatives", () => {
  test("splits simple |-separated alternatives", () => {
    expect(splitAlternatives("foo|bar|baz")).toEqual(["foo", "bar", "baz"])
  })

  test("trims and drops empty alternatives", () => {
    expect(splitAlternatives("  a  | |b")).toEqual(["a", "b"])
  })

  test("treats \\| as a literal pipe (no split)", () => {
    // This is the semantic upgrade vs the old grade.py: `\|` is a literal
    // pipe and must not become an alternation boundary. Regression guard
    // for the test-generator_task_02 migration case.
    expect(splitAlternatives("Version: 1\\.0\\.0 \\| Data:|info line")).toEqual([
      "Version: 1\\.0\\.0 \\| Data:",
      "info line",
    ])
  })

  test("passes other \\X escapes through verbatim", () => {
    // `\.` `\d` `\s` etc are common inside regex alternatives and must not
    // be mangled.
    expect(splitAlternatives("a\\.b|c\\dd|e\\\\f")).toEqual([
      "a\\.b",
      "c\\dd",
      "e\\\\f",
    ])
  })

  test("single alternative with no pipe", () => {
    expect(splitAlternatives("single pattern")).toEqual(["single pattern"])
  })

  test("empty string yields empty array", () => {
    expect(splitAlternatives("")).toEqual([])
    expect(splitAlternatives("  |  ")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// scoreCriterion — 1:1 with legacy grade.py behavior
// ---------------------------------------------------------------------------

describe("scoreCriterion", () => {
  const cases = [
    { classname: "backlog.json", name: "file exists", fullName: "backlog.json > file exists", failed: false },
    { classname: "backlog.json", name: "has epic field", fullName: "backlog.json > has epic field", failed: false },
    { classname: "sprint", name: "committed_points does not exceed capacity", fullName: "sprint > committed_points does not exceed capacity", failed: true },
    { classname: "story", name: "story points valid", fullName: "story > story points valid", failed: false },
  ]

  test("single pattern, all matching tests pass → score 1.0", () => {
    const r = scoreCriterion("backlog.json > file exists", cases)
    expect(r.score).toBe(1.0)
    expect(r.matched).toBe(1)
    expect(r.failedFullNames).toEqual([])
  })

  test("pattern matches a failing test → score 0.0, failed names reported", () => {
    const r = scoreCriterion("committed_points does not exceed", cases)
    expect(r.score).toBe(0.0)
    expect(r.matched).toBe(1)
    expect(r.failedFullNames).toEqual([
      "sprint > committed_points does not exceed capacity",
    ])
  })

  test("no matches → score 0.0 with matched=0", () => {
    const r = scoreCriterion("nonexistent", cases)
    expect(r.score).toBe(0.0)
    expect(r.matched).toBe(0)
    expect(r.failedFullNames).toEqual([])
  })

  test("pipe-split alternatives tried independently (legacy behavior)", () => {
    // Pattern has two alternatives. First matches nothing, second matches
    // the passing 'story points valid' testcase.
    const r = scoreCriterion("nonexistent|story points valid", cases)
    expect(r.score).toBe(1.0)
    expect(r.matched).toBe(1)
  })

  test("case-insensitive matching", () => {
    const r = scoreCriterion("BACKLOG.JSON > FILE EXISTS", cases)
    expect(r.score).toBe(1.0)
    expect(r.matched).toBe(1)
  })

  test("multiple matching tests: mean of their pass/fail", () => {
    // Both backlog.json tests (2 passing), no failing test in the set.
    const r = scoreCriterion("backlog.json", cases)
    expect(r.matched).toBe(2)
    expect(r.score).toBe(1.0)
  })
})

// ---------------------------------------------------------------------------
// Payload schema — the real invariant enforcement
// ---------------------------------------------------------------------------

describe("JunitGradePayloadSchema", () => {
  const validCriteria = [
    { id: "a", weight: 0.4, description: "checks A", testPattern: "foo" },
    { id: "b", weight: 0.6, description: "checks B", testPattern: "bar" },
  ]

  test("accepts a valid payload", () => {
    const p = JunitGradePayloadSchema.parse({
      testFile: "t.test.ts",
      criteria: validCriteria,
    })
    expect(p.runner).toBe("bun")
    expect(p.timeoutMs).toBe(120_000)
    expect(p.criteria).toHaveLength(2)
  })

  test("rejects weight sum != 1.0", () => {
    expect(() =>
      JunitGradePayloadSchema.parse({
        testFile: "t.test.ts",
        criteria: [
          { id: "a", weight: 0.3, description: "A", testPattern: "foo" },
          { id: "b", weight: 0.3, description: "B", testPattern: "bar" },
        ],
      }),
    ).toThrow(/sum to 1\.0/)
  })

  test("rejects duplicate criterion ids", () => {
    expect(() =>
      JunitGradePayloadSchema.parse({
        testFile: "t.test.ts",
        criteria: [
          { id: "a", weight: 0.5, description: "A", testPattern: "foo" },
          { id: "a", weight: 0.5, description: "A2", testPattern: "bar" },
        ],
      }),
    ).toThrow(/duplicate criterion id/)
  })

  test("rejects empty description", () => {
    expect(() =>
      JunitGradePayloadSchema.parse({
        testFile: "t.test.ts",
        criteria: [{ id: "a", weight: 1.0, description: "", testPattern: "x" }],
      }),
    ).toThrow()
  })

  test("rejects invalid regex in testPattern", () => {
    expect(() =>
      JunitGradePayloadSchema.parse({
        testFile: "t.test.ts",
        criteria: [
          { id: "a", weight: 1.0, description: "A", testPattern: "foo(" },
        ],
      }),
    ).toThrow(/invalid regex/)
  })

  test("rejects testPattern whose pipe-split yields no non-empty alternatives", () => {
    expect(() =>
      JunitGradePayloadSchema.parse({
        testFile: "t.test.ts",
        criteria: [{ id: "a", weight: 1.0, description: "A", testPattern: "||" }],
      }),
    ).toThrow(/no non-empty alternatives/)
  })

  test("weight sum tolerance of 1e-3 is honored", () => {
    // 0.333 + 0.333 + 0.334 = 1.000 exactly in decimal; the tolerance
    // matters for floats like 0.1 + 0.2.
    const p = JunitGradePayloadSchema.parse({
      testFile: "t.test.ts",
      criteria: [
        { id: "a", weight: 0.1, description: "A", testPattern: "x" },
        { id: "b", weight: 0.2, description: "B", testPattern: "x" },
        { id: "c", weight: 0.3, description: "C", testPattern: "x" },
        { id: "d", weight: 0.4, description: "D", testPattern: "x" },
      ],
    })
    expect(p.criteria).toHaveLength(4)
  })
})

// ---------------------------------------------------------------------------
// Load-time validation via hydrateEvalPayloads
// ---------------------------------------------------------------------------

describe("validatePayload integration with hydrateEvalPayloads", () => {
  test("valid inline payload passes through hydration", async () => {
    const taskDir = await mkdtemp(path.join(tmpdir(), "junit-hydrate-ok-"))
    try {
      const criteria: EvalCriterion[] = [
        {
          method: "custom",
          evaluatorId: "junit-grade",
          payload: {
            testFile: "t.test.ts",
            criteria: [
              { id: "a", weight: 1.0, description: "A", testPattern: "x" },
            ],
          },
        },
      ]
      await hydrateEvalPayloads(criteria, taskDir)
      expect(criteria[0]!.method).toBe("custom")
    } finally {
      await rm(taskDir, { recursive: true, force: true })
    }
  })

  test("invalid inline payload throws at load time (not at run time)", async () => {
    const taskDir = await mkdtemp(path.join(tmpdir(), "junit-hydrate-bad-"))
    try {
      const criteria: EvalCriterion[] = [
        {
          method: "custom",
          evaluatorId: "junit-grade",
          payload: {
            testFile: "t.test.ts",
            criteria: [
              // weight sum 0.8, not 1.0 — must be caught here, before the
              // adapter ever runs. This is the whole reason validatePayload
              // exists on the CustomEvaluator interface.
              { id: "a", weight: 0.5, description: "A", testPattern: "x" },
              { id: "b", weight: 0.3, description: "B", testPattern: "y" },
            ],
          },
        },
      ]
      await expect(hydrateEvalPayloads(criteria, taskDir)).rejects.toThrow(
        /\[junit-grade\] payload validation failed/,
      )
      // And the specific reason is preserved inside the rejection reason.
      await expect(hydrateEvalPayloads(criteria, taskDir)).rejects.toThrow(
        /sum to 1\.0/,
      )
    } finally {
      await rm(taskDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// End-to-end run() against a real bun test file
// ---------------------------------------------------------------------------

const TEST_FILE_CONTENTS = `
import { describe, test, expect } from "bun:test"

describe("widget", () => {
  test("exists", () => {
    expect(1).toBe(1)
  })
  test("has correct label", () => {
    expect("hello").toBe("hello")
  })
  test("has failing assertion", () => {
    expect(1).toBe(2)
  })
})

describe("gadget", () => {
  test("is operational", () => {
    expect(true).toBe(true)
  })
})
`

describe("junit-grade end-to-end run()", () => {
  test("runs bun test, parses junit xml, scores criteria correctly", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "junit-grade-e2e-"))
    try {
      await Bun.write(path.join(workDir, "sample.test.ts"), TEST_FILE_CONTENTS)

      const payload: JunitGradePayload = JunitGradePayloadSchema.parse({
        testFile: "sample.test.ts",
        criteria: [
          // matches 2 widget tests (one pass, one fail) → score 0.5
          {
            id: "widget-checks",
            weight: 0.5,
            description: "widget has the right shape",
            testPattern: "widget > exists|widget > has failing assertion",
          },
          // matches 1 gadget test (pass) → score 1.0
          {
            id: "gadget-ops",
            weight: 0.5,
            description: "gadget operational",
            testPattern: "gadget > is operational",
          },
        ],
      })

      const result = await junitGrade.run({
        criterion: {
          method: "custom",
          evaluatorId: "junit-grade",
          payload,
        },
        runResult: baseRunResult(workDir),
      })

      expect(result.checkpoints).toBeDefined()
      expect(result.checkpoints).toHaveLength(2)
      const widget = result.checkpoints!.find((c) => c.name === "widget-checks")!
      const gadget = result.checkpoints!.find((c) => c.name === "gadget-ops")!
      expect(widget.score).toBe(0.5)
      expect(gadget.score).toBe(1.0)
      // weighted total: 0.5*0.5 + 1.0*0.5 = 0.75
      expect(result.score).toBeCloseTo(0.75, 5)
      expect(result.pass).toBe(true)
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  })

  test("pattern with no matching tests yields score 0 and clear reason", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "junit-grade-e2e2-"))
    try {
      await Bun.write(path.join(workDir, "sample.test.ts"), TEST_FILE_CONTENTS)

      const payload = JunitGradePayloadSchema.parse({
        testFile: "sample.test.ts",
        criteria: [
          {
            id: "nothing",
            weight: 1.0,
            description: "matches nothing",
            testPattern: "nonexistent pattern xyz",
          },
        ],
      })

      const result = await junitGrade.run({
        criterion: {
          method: "custom",
          evaluatorId: "junit-grade",
          payload,
        },
        runResult: baseRunResult(workDir),
      })

      expect(result.score).toBe(0)
      expect(result.checkpoints![0]!.reason).toMatch(/no tests matched pattern/)
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  })

  test("missing testFile: falls back to exit-code with zero score", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "junit-grade-e2e3-"))
    try {
      const payload = JunitGradePayloadSchema.parse({
        testFile: "does-not-exist.test.ts",
        criteria: [
          { id: "a", weight: 1.0, description: "A", testPattern: "x" },
        ],
      })

      const result = await junitGrade.run({
        criterion: {
          method: "custom",
          evaluatorId: "junit-grade",
          payload,
        },
        runResult: baseRunResult(workDir),
      })

      expect(result.score).toBe(0)
      expect(result.pass).toBe(false)
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// testFileFrom: "task" — taskDir-anchored test files (hidden from the agent)
// ---------------------------------------------------------------------------

const CWD_PROBE_TEST = `
import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

describe("probe", () => {
  test("workdir artifact exists", () => {
    // resolved against cwd, which must be the agent workDir
    expect(existsSync(path.resolve("artifact.txt"))).toBe(true)
  })
  test("golden file matches", () => {
    // resolved against the test file location, which must be the task dir
    const golden = readFileSync(path.join(import.meta.dirname, "expected", "golden.txt"), "utf-8").trim()
    const actual = readFileSync(path.resolve("artifact.txt"), "utf-8").trim()
    expect(actual).toBe(golden)
  })
})
`

describe("junit-grade testFileFrom: task", () => {
  test("schema defaults testFileFrom to fixtures", () => {
    const p = JunitGradePayloadSchema.parse({
      testFile: "a.test.ts",
      criteria: [{ id: "a", weight: 1.0, description: "A", testPattern: "x" }],
    })
    expect(p.testFileFrom).toBe("fixtures")
  })

  test("runs a taskDir-anchored test with cwd=workDir and expected/ next to the test", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "junit-grade-taskdir-w-"))
    const taskDir = await mkdtemp(path.join(tmpdir(), "junit-grade-taskdir-t-"))
    try {
      // agent output lives in workDir only
      await Bun.write(path.join(workDir, "artifact.txt"), "hello\n")
      // test + golden live in taskDir only (never copied to workDir)
      await Bun.write(path.join(taskDir, "probe.test.ts"), CWD_PROBE_TEST)
      await Bun.write(path.join(taskDir, "expected", "golden.txt"), "hello\n")

      const payload = JunitGradePayloadSchema.parse({
        testFile: "probe.test.ts",
        testFileFrom: "task",
        criteria: [
          { id: "artifact", weight: 0.5, description: "artifact exists", testPattern: "workdir artifact exists" },
          { id: "golden", weight: 0.5, description: "matches golden", testPattern: "golden file matches" },
        ],
      })

      const result = await junitGrade.run({
        criterion: { method: "custom", evaluatorId: "junit-grade", payload },
        runResult: baseRunResult(workDir),
        taskDir,
      })

      expect(result.score).toBeCloseTo(1.0, 5)
      expect(result.pass).toBe(true)
    } finally {
      await rm(workDir, { recursive: true, force: true })
      await rm(taskDir, { recursive: true, force: true })
    }
  })

  test("testFileFrom task without a taskDir in context fails with a clear reason", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "junit-grade-taskdir-x-"))
    try {
      const payload = JunitGradePayloadSchema.parse({
        testFile: "probe.test.ts",
        testFileFrom: "task",
        criteria: [{ id: "a", weight: 1.0, description: "A", testPattern: "x" }],
      })

      const result = await junitGrade.run({
        criterion: { method: "custom", evaluatorId: "junit-grade", payload },
        runResult: baseRunResult(workDir),
      })

      expect(result.score).toBe(0)
      expect(result.pass).toBe(false)
      expect(result.details).toMatch(/taskDir/)
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  })

  test("checkIntegrity resolves testFileFrom=task against taskDir", async () => {
    const taskDir = await mkdtemp(path.join(tmpdir(), "junit-grade-taskdir-i-"))
    try {
      await Bun.write(path.join(taskDir, "probe.test.ts"), CWD_PROBE_TEST)
      const criterion = {
        method: "custom" as const,
        evaluatorId: "junit-grade",
        payload: {
          testFile: "probe.test.ts",
          testFileFrom: "task",
          criteria: [{ id: "a", weight: 1.0, description: "A", testPattern: "x" }],
        },
      }
      const ok = await junitGrade.checkIntegrity!(criterion, {
        taskDir,
        fixturesDir: path.join(taskDir, "fixtures"),
      })
      expect(ok.ok).toBe(true)

      const missing = await junitGrade.checkIntegrity!(
        { ...criterion, payload: { ...criterion.payload, testFile: "nope.test.ts" } },
        { taskDir, fixturesDir: path.join(taskDir, "fixtures") },
      )
      expect(missing.ok).toBe(false)
    } finally {
      await rm(taskDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Grading integrity
// ---------------------------------------------------------------------------
//
// Relocating the test file hides the answer key; these cover the two routes
// that made it readable (or forgeable) anyway from inside the agent's workDir.

const INTEGRITY_TEST = `import { test, expect } from "bun:test"
test("agent wrote the answer", async () => {
  const actual = (await Bun.file("answer.txt").text()).trim()
  expect(actual).toBe("42")
})
`

const INTEGRITY_PAYLOAD = {
  testFile: "grade.test.ts",
  testFileFrom: "task" as const,
  criteria: [{ id: "answer", description: "agent wrote the answer", testPattern: "agent wrote the answer", weight: 1 }],
}

async function setupIntegrityCase(opts: { answer?: string; bunfig?: string; forgedXml?: string }) {
  const taskDir = await mkdtemp(path.join(tmpdir(), "junit-task-"))
  const workDir = await mkdtemp(path.join(tmpdir(), "junit-work-"))
  await Bun.write(path.join(taskDir, "grade.test.ts"), INTEGRITY_TEST)
  await Bun.write(path.join(taskDir, "golden.txt"), "42")
  if (opts.answer !== undefined) await Bun.write(path.join(workDir, "answer.txt"), opts.answer)
  if (opts.bunfig) await Bun.write(path.join(workDir, "bunfig.toml"), opts.bunfig)
  if (opts.forgedXml) await Bun.write(path.join(workDir, "_junit_results.xml"), opts.forgedXml)
  return { taskDir, workDir }
}

function integrityRun(workDir: string, taskDir?: string) {
  return junitGrade.run({
    criterion: { method: "custom", evaluatorId: "junit-grade", payload: INTEGRITY_PAYLOAD },
    runResult: baseRunResult(workDir),
    ...(taskDir ? { taskDir } : {}),
  } as Parameters<typeof junitGrade.run>[0])
}

describe("junit-grade grading integrity", () => {
  test("the test file and its siblings never enter the workDir", async () => {
    const { taskDir, workDir } = await setupIntegrityCase({ answer: "42" })
    try {
      const result = await integrityRun(workDir, taskDir)
      expect(result.score).toBe(1)
      expect(await Bun.file(path.join(workDir, "grade.test.ts")).exists()).toBe(false)
      expect(await Bun.file(path.join(workDir, "golden.txt")).exists()).toBe(false)
    } finally {
      await rm(taskDir, { recursive: true, force: true })
      await rm(workDir, { recursive: true, force: true })
    }
  })

  test("an agent-authored bunfig preload cannot run inside the grader", async () => {
    // Bun reads bunfig.toml from cwd and `[test] preload` executes before the
    // test file loads — with the hidden test's absolute path sitting in argv.
    const { taskDir, workDir } = await setupIntegrityCase({
      answer: "wrong",
      bunfig: `[test]\npreload = ["./exploit.ts"]\n`,
    })
    await Bun.write(
      path.join(workDir, "exploit.ts"),
      `await Bun.write("answer.txt", "42")\nawait Bun.write("pwned.txt", "ran")\n`,
    )
    try {
      const result = await integrityRun(workDir, taskDir)
      expect(await Bun.file(path.join(workDir, "pwned.txt")).exists()).toBe(false)
      expect(result.score).toBe(0)
      // The agent's own file is restored once grading is over.
      expect(await Bun.file(path.join(workDir, "bunfig.toml")).exists()).toBe(true)
    } finally {
      await rm(taskDir, { recursive: true, force: true })
      await rm(workDir, { recursive: true, force: true })
    }
  })

  test("a pre-planted results file cannot be read back as the verdict", async () => {
    // A read-only `_junit_results.xml` used to make Bun's write fail while
    // exists() stayed true, so the forged file was parsed for full marks.
    const forged = `<?xml version="1.0"?><testsuites><testsuite name="x"><testcase name="agent wrote the answer" /></testsuite></testsuites>`
    const { taskDir, workDir } = await setupIntegrityCase({ answer: "wrong", forgedXml: forged })
    chmodSync(path.join(workDir, "_junit_results.xml"), 0o444)
    try {
      const result = await integrityRun(workDir, taskDir)
      expect(result.score).toBe(0)
    } finally {
      await rm(taskDir, { recursive: true, force: true })
      await rm(workDir, { recursive: true, force: true })
    }
  })

  test("a missing taskDir is an infra error, not a model failure", async () => {
    const { taskDir, workDir } = await setupIntegrityCase({ answer: "42" })
    try {
      const result = await integrityRun(workDir)
      expect(result.infraError).toBeDefined()
    } finally {
      await rm(taskDir, { recursive: true, force: true })
      await rm(workDir, { recursive: true, force: true })
    }
  })
})
