/**
 * Regression tests for the profiler eval-logic false negatives reported in
 * issue #35: correct model outputs were being scored as failures.
 *
 * Each test generates a real instance and runs its eval through the framework
 * evaluator. `Math.random` is pinned to 0 so randChoice picks scenario[0] and
 * randInt returns its minimum, making the embedded ground truth deterministic.
 */
import { test, expect, describe } from "bun:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { MicrobenchmarkInstance } from "../../src/profiler/types.ts"
import type { EvalCriterion, EvalResult } from "../../src/core/types.ts"
import { evaluate } from "../../src/framework/evaluator.ts"
import { baseResult } from "../helpers/eval-ground-truth.ts"
import reasonAnalysisGen from "../../src/profiler/generators/reason-analysis.ts"
import followStyleGen from "../../src/profiler/generators/follow-style.ts"
import followConstraintGen from "../../src/profiler/generators/follow-constraint.ts"
import toolExecGen from "../../src/profiler/generators/tool-exec.ts"
import genCodePythonGen from "../../src/profiler/generators/gen-code-python.ts"

/** Run an instance's eval with extra files written into a throwaway workDir. */
async function evalWith(inst: MicrobenchmarkInstance, files: Record<string, string>): Promise<EvalResult> {
  const wd = await mkdtemp(path.join(tmpdir(), "skvm-bugfix-"))
  try {
    for (const [n, c] of Object.entries(inst.setupFiles ?? {})) await writeFile(path.join(wd, n), c)
    for (const [n, c] of Object.entries(files)) await writeFile(path.join(wd, n), c)
    return await evaluate(inst.eval, baseResult(wd))
  } finally {
    await rm(wd, { recursive: true, force: true })
  }
}

/** Run a raw eval criterion in a fresh empty workDir. */
async function evalRaw(criterion: EvalCriterion): Promise<EvalResult> {
  const wd = await mkdtemp(path.join(tmpdir(), "skvm-bugfix-"))
  try {
    return await evaluate(criterion, baseResult(wd))
  } finally {
    await rm(wd, { recursive: true, force: true })
  }
}

const cp = (r: EvalResult, name: string) => r.checkpoints?.find((c) => c.name === name)

/** Run `fn` with Math.random pinned to 0, then restore it. */
async function withSeed0<T>(fn: () => Promise<T>): Promise<T> {
  const orig = Math.random
  Math.random = () => 0
  try {
    return await fn()
  } finally {
    Math.random = orig
  }
}

/** Whether a python module is importable in the current test environment. */
async function moduleInstalled(name: string): Promise<boolean> {
  const code = `import importlib.util, sys; sys.exit(0 if importlib.util.find_spec(${JSON.stringify(name)}) else 1)`
  const proc = Bun.spawn(["python3", "-c", code], { stdout: "ignore", stderr: "ignore" })
  return (await proc.exited) === 0
}

describe("issue #35: reason.analysis L3 — answer after reasoning preamble", () => {
  test("a correct answer preceded by reasoning lines passes", async () => {
    await withSeed0(async () => {
      const inst = reasonAnalysisGen.generate("L3") // scenario[0]: utils.py, line 3
      const r = await evalWith(inst, {
        "response.txt": "Let me trace the crash.\nint() fails on '30.5'.\nutils.py\n3",
      })
      expect(r.pass).toBe(true)
    })
  })

  test("a wrong answer (even after reasoning) still fails", async () => {
    await withSeed0(async () => {
      const inst = reasonAnalysisGen.generate("L3")
      const r = await evalWith(inst, { "response.txt": "some reasoning\ncalc.py\n99" })
      expect(r.pass).toBe(false)
    })
  })

  test("extraction is preamble-invariant (uses the last two lines)", async () => {
    const inst = reasonAnalysisGen.generate("L3")
    const clean = await evalWith(inst, { "response.txt": "main.py\n6" })
    const pre = await evalWith(inst, { "response.txt": "line A\nline B\nmain.py\n6" })
    expect(cp(pre, "file_correct")?.score).toBe(cp(clean, "file_correct")?.score)
    expect(cp(pre, "line_correct")?.score).toBe(cp(clean, "line_correct")?.score)
    // The filename was read from the answer line, not a preamble line.
    expect(cp(pre, "file_correct")?.reason ?? "").not.toContain("no .py file found")
  })
})

describe("issue #35: follow.style L2 — jargon word-boundary matching", () => {
  test("a jargon word embedded in a longer word is not flagged", async () => {
    await withSeed0(async () => {
      const inst = followStyleGen.generate("L2")
      // "paradigms" contains the jargon word "paradigm" but is a different word.
      const r = await evalWith(inst, {
        "response.txt": "Gravity is so fun! It pulls things down! The paradigms of play are wild! Wow!",
      })
      expect(cp(r, "no_jargon")?.score).toBe(1)
    })
  })

  test("a standalone jargon word is still flagged", async () => {
    await withSeed0(async () => {
      const inst = followStyleGen.generate("L2")
      const r = await evalWith(inst, {
        "response.txt": "Gravity is fun! This paradigm is key! So cool! Yay!",
      })
      expect(cp(r, "no_jargon")?.score).toBe(0)
    })
  })
})

describe("issue #35: follow.style L3 — graded style consistency", () => {
  test("one section without a listed marker no longer zeroes the checkpoint", async () => {
    await withSeed0(async () => {
      const inst = followStyleGen.generate("L3") // scenario[0]: pirate
      const r = await evalWith(inst, {
        "response.txt":
          "## Ahoy\nArr matey, the coffee be strong like the sea! Ahoy!\n" +
          "## The Brew\nThis fine beverage warms the soul on a chilly morn.\n" +
          "## Treasure\nArr, the booty of caffeine awaits ye, matey!",
      })
      const sc = cp(r, "style_consistent")
      expect(sc?.score).toBeGreaterThanOrEqual(0.5)
      expect(sc?.score).toBeLessThan(1) // graded, not all-or-nothing
      expect(r.pass).toBe(true)
    })
  })
})

describe("issue #35: follow.constraint L3 — hedging word-boundary matching", () => {
  test("a hedging word embedded in a longer word is not flagged", async () => {
    await withSeed0(async () => {
      const inst = followConstraintGen.generate("L3")
      const claim = inst.prompt.match(/state as fact that "([^"]+)"/)?.[1] ?? ""
      // "mighty" contains the hedging word "might" but is a different word.
      const r = await evalWith(inst, {
        "response.txt": `The mighty truth is plain: ${claim}. A mighty fact indeed.`,
      })
      expect(cp(r, "no_hedging")?.score).toBe(1)
    })
  })
})

describe("issue #35: tool.exec L1 — wc -l off-by-one", () => {
  test("wc -l on the provided file matches the expected line count", async () => {
    await withSeed0(async () => {
      const inst = toolExecGen.generate("L1") // lineCount=5, command = wc -l
      const data = inst.setupFiles!["data.txt"]!
      // Run wc the way a correct model would, then feed its output to the eval.
      const wd = await mkdtemp(path.join(tmpdir(), "skvm-wc-"))
      await writeFile(path.join(wd, "data.txt"), data)
      const wc = (await new Response(
        Bun.spawn(["sh", "-c", "wc -l < data.txt"], { cwd: wd, stdout: "pipe" }).stdout,
      ).text()).trim()
      await rm(wd, { recursive: true, force: true })
      const r = await evalWith(inst, { "result.txt": wc })
      expect(r.pass).toBe(true)
    })
  })
})

describe("issue #35: gen.code.python L3 — missing dependency is a skip, not a failure", () => {
  test("a missing required library yields infraError", async () => {
    await withSeed0(async () => {
      const inst = genCodePythonGen.generate("L3") // pandas variant
      const ev = inst.eval
      if (ev.method !== "script") throw new Error("expected a script eval")
      const missing: EvalCriterion = {
        ...ev,
        command: ev.command.replace('find_spec("pandas")', 'find_spec("nonexistent_pkg_xyz")'),
      }
      const r = await evalRaw(missing)
      expect(r.infraError).toBeDefined()
      expect(r.infraError).toContain("pandas")
      expect(r.pass).toBe(false)
    })
  })

  test("an installed required library does not trigger a skip", async () => {
    if (!(await moduleInstalled("pandas"))) return // environment without pandas: nothing to assert
    await withSeed0(async () => {
      const inst = genCodePythonGen.generate("L3")
      // pandas present + no solution.py -> ordinary checkpoint failure, never infraError.
      const r = await evalWith(inst, {})
      expect(r.infraError).toBeUndefined()
    })
  })
})
