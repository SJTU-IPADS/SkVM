/**
 * Ground-truth eval tests for all 5 reasoning primitives at L1.
 *
 * For each generator we call generate("L1"), write the correct answer to
 * response.txt, run the eval script, and verify pass=true. Then we repeat
 * with a wrong answer and verify pass=false.
 *
 * NOTE: Several generators embed json.loads('...') containing escape
 * sequences like \n inside the Python source passed to python3 -c "...".
 * When the Python code is extracted and written to a .py file, Python
 * interprets \n as a real newline inside string literals, breaking
 * json.loads. We fix this by converting json.loads(' to json.loads(r'
 * (raw strings) so \n stays literal. This lets us test the eval logic
 * correctly while bypassing shell quoting issues.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import type { EvalCriterion } from "../../src/core/types.ts"
import { makeWorkDir, removeWorkDir, writeSetupFiles } from "../helpers/eval-ground-truth.ts"
import reasonArithmeticGen from "../../src/profiler/generators/reason-arithmetic.ts"
import reasonLogicGen from "../../src/profiler/generators/reason-logic.ts"
import reasonSpatialGen from "../../src/profiler/generators/reason-spatial.ts"
import reasonPlanningGen from "../../src/profiler/generators/reason-planning.ts"
import reasonAnalysisGen from "../../src/profiler/generators/reason-analysis.ts"

let workDir: string

beforeEach(async () => {
  workDir = await makeWorkDir("reason")
})
afterEach(async () => {
  await removeWorkDir(workDir)
})

/**
 * Run an eval criterion's Python script in the given workDir.
 *
 * Extracts the Python code from `python3 -c "CODE"`, writes it to a temp .py
 * file, and runs it with python3. To preserve escape sequences like \n inside
 * json.loads() calls (which Python would otherwise interpret as newlines in
 * source), we convert json.loads(' to json.loads(r' (raw strings).
 */
async function runEval(
  criterion: EvalCriterion,
  dir: string,
): Promise<{ pass: boolean; stdout: string; stderr: string; exitCode: number }> {
  if (criterion.method !== "script") {
    throw new Error(`Unsupported eval method: ${criterion.method}`)
  }

  // Extract Python code from either `python3 -c "CODE"` or `python3 << 'PYEOF'\nCODE\nPYEOF`
  let pyCode: string
  const inlineMatch = criterion.command.match(/^python3\s+-c\s+"([\s\S]+)"$/)
  const heredocMatch = criterion.command.match(/python3\s+<<\s*'PYEOF'\n([\s\S]+?)\nPYEOF$/)
  if (inlineMatch) {
    pyCode = inlineMatch[1]!
    pyCode = pyCode.replace(/json\.loads\('/g, "json.loads(r'")
  } else if (heredocMatch) {
    pyCode = heredocMatch[1]!
  } else {
    throw new Error("Could not extract Python code from eval command")
  }

  const scriptPath = path.join(dir, "_gt_eval.py")
  await writeFile(scriptPath, pyCode)

  const proc = Bun.spawn(["python3", scriptPath], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  })

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  const exitCodeMatch = exitCode === criterion.expectedExitCode

  // For checkpoint-based output, derive pass from checkpoint scores
  let outputMatch = true
  const stdoutTrimmed = stdout.trim()
  if (criterion.expectedOutput !== undefined) {
    outputMatch = stdoutTrimmed === criterion.expectedOutput.trim()
  } else {
    // Try to parse checkpoint JSON
    try {
      const parsed = JSON.parse(stdoutTrimmed)
      if (Array.isArray(parsed.checkpoints)) {
        outputMatch = parsed.checkpoints.every((c: { score: number }) => c.score >= 0.5)
      }
    } catch { /* not JSON, treat as pass if exit code matched */ }
  }

  return {
    pass: exitCodeMatch && outputMatch,
    stdout: stdoutTrimmed,
    stderr: stderr.trim(),
    exitCode,
  }
}

// ---------------------------------------------------------------------------
// reason.arithmetic L1
// ---------------------------------------------------------------------------

describe("reason.arithmetic L1", () => {
  test("passes with correct answer", async () => {
    const inst = reasonArithmeticGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    // Extract the expected numeric value from the eval command.
    // The command has: expected = float('${expected}')
    const expectedMatch = inst.eval.method === "script"
      ? inst.eval.command.match(/expected\s*=\s*float\('([^']+)'\)/)
      : null
    expect(expectedMatch).not.toBeNull()
    const expected = expectedMatch![1]!

    await writeFile(path.join(workDir, "response.txt"), expected)
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(true)
  })

  test("fails with wrong answer", async () => {
    const inst = reasonArithmeticGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    await writeFile(path.join(workDir, "response.txt"), "9999999")
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// reason.logic L1
// ---------------------------------------------------------------------------

describe("reason.logic L1", () => {
  test("passes with correct answer", async () => {
    const inst = reasonLogicGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    // The eval checks: text.startswith(expected) where expected = 'yes' or 'no'
    const expectedMatch = inst.eval.method === "script"
      ? inst.eval.command.match(/expected\s*=\s*'(yes|no)'/)
      : null
    expect(expectedMatch).not.toBeNull()
    const expected = expectedMatch![1]!

    const answer = expected === "yes" ? "Yes" : "No"
    await writeFile(path.join(workDir, "response.txt"), answer)
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(true)
  })

  test("fails with wrong answer", async () => {
    const inst = reasonLogicGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    const expectedMatch = inst.eval.method === "script"
      ? inst.eval.command.match(/expected\s*=\s*'(yes|no)'/)
      : null
    expect(expectedMatch).not.toBeNull()
    const expected = expectedMatch![1]!
    const wrong = expected === "yes" ? "No" : "Yes"

    await writeFile(path.join(workDir, "response.txt"), wrong)
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// reason.spatial L1
// ---------------------------------------------------------------------------

describe("reason.spatial L1", () => {
  test("passes with correct answer", async () => {
    const inst = reasonSpatialGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    // Extract expected distance: expected = float('${expectedStr}')
    const expectedMatch = inst.eval.method === "script"
      ? inst.eval.command.match(/expected\s*=\s*float\('([^']+)'\)/)
      : null
    expect(expectedMatch).not.toBeNull()
    const expected = expectedMatch![1]!

    await writeFile(path.join(workDir, "response.txt"), expected)
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(true)
  })

  test("fails with wrong answer", async () => {
    const inst = reasonSpatialGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    await writeFile(path.join(workDir, "response.txt"), "99999.0")
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// reason.planning L1
// ---------------------------------------------------------------------------

describe("reason.planning L1", () => {
  test("passes with correct topological order", async () => {
    const inst = reasonPlanningGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    // Extract edges and tasks from the eval command.
    const edgesMatch = inst.eval.method === "script"
      ? inst.eval.command.match(/edges\s*=\s*json\.loads\('(\[.+?\])'\)/)
      : null
    expect(edgesMatch).not.toBeNull()
    const edges: [string, string][] = JSON.parse(edgesMatch![1]!)

    const tasksMatch = inst.eval.method === "script"
      ? inst.eval.command.match(/tasks\s*=\s*set\('([A-Z]+)'\)/)
      : null
    expect(tasksMatch).not.toBeNull()
    const taskLetters = tasksMatch![1]!.split("")

    // Compute a valid topological sort via Kahn's algorithm
    const inDeg = new Map<string, number>()
    const adj = new Map<string, string[]>()
    for (const t of taskLetters) {
      inDeg.set(t, 0)
      adj.set(t, [])
    }
    for (const [a, b] of edges) {
      adj.get(a)!.push(b)
      inDeg.set(b, (inDeg.get(b) ?? 0) + 1)
    }
    const queue: string[] = taskLetters
      .filter((t) => inDeg.get(t) === 0)
      .sort()
    const order: string[] = []
    while (queue.length > 0) {
      const node = queue.shift()!
      order.push(node)
      for (const nb of adj.get(node) ?? []) {
        inDeg.set(nb, inDeg.get(nb)! - 1)
        if (inDeg.get(nb) === 0) {
          // Insert in sorted position for determinism
          const idx = queue.findIndex((x) => nb < x)
          if (idx === -1) queue.push(nb)
          else queue.splice(idx, 0, nb)
        }
      }
    }

    await writeFile(path.join(workDir, "response.txt"), order.join(","))
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(true)
  })

  test("fails with reversed order", async () => {
    const inst = reasonPlanningGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    // Reverse the task letters -- this violates dependency ordering
    const tasksMatch = inst.eval.method === "script"
      ? inst.eval.command.match(/tasks\s*=\s*set\('([A-Z]+)'\)/)
      : null
    expect(tasksMatch).not.toBeNull()
    const taskLetters = tasksMatch![1]!.split("")
    const reversed = [...taskLetters].reverse()

    await writeFile(path.join(workDir, "response.txt"), reversed.join(","))
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// reason.analysis L1
// ---------------------------------------------------------------------------

describe("reason.analysis L1", () => {
  test("passes with response containing keyword", async () => {
    const inst = reasonAnalysisGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    // Extract keyword from: keyword = '${fn.keyword}'
    const kwMatch = inst.eval.method === "script"
      ? inst.eval.command.match(/keyword\s*=\s*'([^']+)'/)
      : null
    expect(kwMatch).not.toBeNull()
    const keyword = kwMatch![1]!

    await writeFile(
      path.join(workDir, "response.txt"),
      `This function does ${keyword} operations`,
    )
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(true)
  })

  test("fails with response missing keyword", async () => {
    const inst = reasonAnalysisGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    // None of the possible keywords (even, reverse, range, sum, unique,
    // uppercase, sort, key) appear in this text.
    await writeFile(
      path.join(workDir, "response.txt"),
      "This function does something with data",
    )
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(false)
  })
})
