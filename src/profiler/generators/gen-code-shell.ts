import type { MicrobenchmarkInstance } from "../types.ts"
import { defineGenerator, pyEval, type Rng } from "../generator-toolkit.ts"

const PREFIXES = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"]
const LOG_LEVELS = ["ERROR", "WARN", "INFO", "DEBUG"]
const AGG_FUNCS = ["sum", "avg", "count"] as const
const NAMES = ["Alice", "Bob", "Carol", "Dave", "Eve", "Frank", "Grace", "Hank"]

/**
 * Shell prefix shared by all levels: run the candidate script before the
 * checkpoint script inspects result.txt.
 */
const RUN_SOLUTION_PREFIX = "bash solution.sh >/dev/null 2>&1"

/**
 * L1: Using grep, count lines in data.txt starting with PREFIX,
 * write count to result.txt. Eval: exact int match.
 */
function generateL1(rng: Rng): MicrobenchmarkInstance {
  const PREFIX = rng.randChoice(PREFIXES)
  const N = rng.randInt(15, 50)

  const lines: string[] = []
  let expectedCount = 0
  for (let i = 0; i < N; i++) {
    const pfx = rng.randChoice(PREFIXES)
    const msg = `${pfx}: something happened at line ${i}`
    lines.push(msg)
    if (pfx === PREFIX) expectedCount++
  }

  return {
    prompt: `The file data.txt already exists in the current directory. Write a shell script (bash) that uses grep to count lines in data.txt that start with "${PREFIX}", and writes just the count (as an integer, nothing else) to result.txt. Do not create or overwrite data.txt. Save the script as solution.sh and execute it with bash solution.sh.`,
    setupFiles: {
      "data.txt": lines.join("\n"),
    },
    eval: pyEval({
      shellPrefix: RUN_SOLUTION_PREFIX,
      imports: ["re", "os"],
      body: `exists = os.path.isfile('result.txt')
cp.append({"name": "script_created", "score": 1.0 if exists else 0.0,
  "reason": None if exists else "result.txt not created"})
if exists:
    text = open('result.txt').read().strip()
    nums = re.findall(r'-?\\d+', text)
    exec_ok = len(nums) > 0
    cp.append({"name": "execution_success", "score": 1.0 if exec_ok else 0.0,
      "reason": None if exec_ok else "no number found in result.txt"})
    if exec_ok:
        actual = int(nums[0])
        correct = actual == ${expectedCount}
        cp.append({"name": "output_correct", "score": 1.0 if correct else 0.0,
          "reason": None if correct else f"expected ${expectedCount}, got {actual}"})`,
    }),
  }
}

/**
 * L2: Using pipeline, find lines in scores.txt with score >= T,
 * sort descending, take top K, write to result.txt.
 */
function generateL2(rng: Rng): MicrobenchmarkInstance {
  const T = rng.randInt(50, 80)
  const K = rng.randInt(3, 7)
  const N = rng.randInt(15, 40)

  const lines: string[] = []
  const scores: Array<{ name: string; score: number }> = []
  for (let i = 0; i < N; i++) {
    const name = rng.randChoice(NAMES) + i
    const score = rng.randInt(10, 100)
    lines.push(`${name} ${score}`)
    scores.push({ name, score })
  }

  // Compute expected output: filter >= T, sort descending by score, take top K
  const filtered = scores.filter((s) => s.score >= T)
  filtered.sort((a, b) => b.score - a.score)
  const topK = filtered.slice(0, K)
  const expectedLines = topK.map((s) => `${s.name} ${s.score}`)

  return {
    prompt: `The file scores.txt already exists in the current directory (each line: "name score"). Write a shell script (bash) that reads scores.txt, filters lines where the score is >= ${T}, sorts them by score in descending order, takes the top ${K} results, and writes them to result.txt (same format, one per line). Do not create or overwrite scores.txt. Save the script as solution.sh and execute it with bash solution.sh.`,
    setupFiles: {
      "scores.txt": lines.join("\n"),
    },
    eval: pyEval({
      shellPrefix: RUN_SOLUTION_PREFIX,
      imports: ["os"],
      body: `exists = os.path.isfile('result.txt')
cp.append({"name": "script_created", "score": 1.0 if exists else 0.0,
  "reason": None if exists else "result.txt not created"})
if exists:
    expected = ${JSON.stringify(expectedLines)}
    actual = open('result.txt').read().strip().splitlines()
    actual = [l.strip() for l in actual if l.strip()]
    count_ok = len(actual) == len(expected)
    cp.append({"name": "execution_success", "score": 1.0 if count_ok else 0.0,
      "reason": None if count_ok else f"expected {len(expected)} lines, got {len(actual)}"})
    if count_ok:
        all_match = True
        mismatch = None
        for a, e in zip(actual, expected):
            a_parts = a.split()
            e_parts = e.split()
            if a_parts[-1] != e_parts[-1]:
                all_match = False
                mismatch = f"score mismatch: {a} vs {e}"
                break
        cp.append({"name": "output_correct", "score": 1.0 if all_match else 0.0,
          "reason": mismatch})`,
    }),
  }
}

/**
 * L3: Using awk, parse log file (format: [timestamp] LEVEL: msg key=val),
 * extract key-values where LEVEL is L, compute AGG of numeric values,
 * write to result.txt.
 */
function generateL3(rng: Rng): MicrobenchmarkInstance {
  const L = rng.randChoice(LOG_LEVELS)
  const AGG = rng.randChoice(AGG_FUNCS)
  const N = rng.randInt(20, 60)
  const targetKey = rng.randChoice(["latency", "duration", "count", "size"])

  const logLines: string[] = []
  const matchingValues: number[] = []

  for (let i = 0; i < N; i++) {
    const level = rng.randChoice(LOG_LEVELS)
    const ts = `2024-01-${String(rng.randInt(1, 28)).padStart(2, "0")}T${String(rng.randInt(0, 23)).padStart(2, "0")}:${String(rng.randInt(0, 59)).padStart(2, "0")}:${String(rng.randInt(0, 59)).padStart(2, "0")}`
    const val = rng.randInt(1, 500)
    const msg = `request processed ${targetKey}=${val}`
    logLines.push(`[${ts}] ${level}: ${msg}`)
    if (level === L) {
      matchingValues.push(val)
    }
  }

  let expectedResult: number
  switch (AGG) {
    case "sum":
      expectedResult = matchingValues.reduce((a, b) => a + b, 0)
      break
    case "avg":
      expectedResult =
        matchingValues.length > 0
          ? Math.round((matchingValues.reduce((a, b) => a + b, 0) / matchingValues.length) * 100) / 100
          : 0
      break
    case "count":
      expectedResult = matchingValues.length
      break
  }

  const aggDescription =
    AGG === "sum" ? "sum" : AGG === "avg" ? "average (rounded to 2 decimal places)" : "count"

  return {
    prompt: `The file app.log already exists in the current directory. Each line has the format: [timestamp] LEVEL: message key=value. Write a shell script (bash) that uses awk to parse app.log, extract the numeric value of "${targetKey}" from lines where the level is "${L}", compute the ${aggDescription} of those values, and write the result to result.txt (just the number, nothing else). Do not create or overwrite app.log. Save the script as solution.sh and execute it with bash solution.sh.`,
    setupFiles: {
      "app.log": logLines.join("\n"),
    },
    eval: pyEval({
      shellPrefix: RUN_SOLUTION_PREFIX,
      imports: ["re", "os"],
      body: `exists = os.path.isfile('result.txt')
cp.append({"name": "script_created", "score": 1.0 if exists else 0.0,
  "reason": None if exists else "result.txt not created"})
if exists:
    text = open('result.txt').read().strip()
    nums = re.findall(r'-?[\\d]+\\.?\\d*', text)
    exec_ok = len(nums) > 0
    cp.append({"name": "execution_success", "score": 1.0 if exec_ok else 0.0,
      "reason": None if exec_ok else "no number found in result.txt"})
    if exec_ok:
        actual = float(nums[0])
        expected = float('${expectedResult}')
        tol = max(0.01, abs(expected) * 0.01)
        correct = abs(actual - expected) <= tol
        cp.append({"name": "output_correct", "score": 1.0 if correct else 0.0,
          "reason": None if correct else f"expected ${expectedResult}, got {actual}"})`,
    }),
  }
}

export default defineGenerator({
  primitiveId: "gen.code.shell",
  descriptions: {
    L1: "Write a bash script using grep to count lines in a file that start with a given prefix",
    L2: "Write a bash script using a pipeline (filter, sort, head) to extract top-scoring entries from a file",
    L3: "Write a bash script using awk to parse a structured log file, extract key-value pairs by log level, and compute an aggregate",
  },
  levels: { L1: generateL1, L2: generateL2, L3: generateL3 },
})
