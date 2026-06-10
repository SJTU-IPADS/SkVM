import type { MicrobenchmarkInstance } from "../types.ts"
import { defineGenerator, pyEval, pyRunSolution, PY_EMIT_CHECKPOINTS, type Rng } from "../generator-toolkit.ts"

const CHARS = "abcdefghijklmnopqrstuvwxyz"
const NAMES = ["Alice", "Bob", "Carol", "Dave", "Eve", "Frank", "Grace", "Hank"]
const DEPTS = ["Engineering", "Marketing", "Sales", "HR", "Finance"]

/**
 * Python fragment shared by all levels: verify solution.js exists and run it,
 * early-exiting with a failed checkpoint on either problem.
 */
const PY_RUN_SOLUTION = pyRunSolution("solution.js", ["node", "solution.js"])

/**
 * L1: Read input.txt, count lines containing char C, print count.
 * Setup: input.txt with N lines. Eval: execute script, exact int match.
 */
function generateL1(rng: Rng): MicrobenchmarkInstance {
  const C = rng.randChoice([...CHARS])
  const N = rng.randInt(8, 30)

  const words = [
    "apple", "banana", "cherry", "date", "elderberry",
    "fig", "grape", "honeydew", "kiwi", "lemon",
    "mango", "nectarine", "orange", "papaya", "quince",
    "raspberry", "strawberry", "tangerine", "watermelon", "blueberry",
  ]

  const lines: string[] = []
  let expectedCount = 0
  for (let i = 0; i < N; i++) {
    const word = rng.randChoice(words) + " " + rng.randInt(1, 999)
    lines.push(word)
    if (word.includes(C)) expectedCount++
  }

  return {
    prompt: `The file input.txt already exists in the current directory. Write a JavaScript (Node.js) script that reads input.txt, counts how many lines contain the character "${C}" (case-sensitive), and writes just the count (as an integer, nothing else) to result.txt. Do not create or overwrite input.txt. Save the script as solution.js and execute it with node solution.js.`,
    setupFiles: {
      "input.txt": lines.join("\n"),
    },
    eval: pyEval({
      imports: ["subprocess", "os"],
      body: `${PY_RUN_SOLUTION}

# Check result file exists
if os.path.exists('result.txt'):
    cp.append({"name": "output_format", "score": 1.0, "reason": None})
else:
    cp.append({"name": "output_format", "score": 0.0, "reason": "result.txt not found"})
    ${PY_EMIT_CHECKPOINTS}
    raise SystemExit(0)

# Check value correctness
text = open('result.txt').read().strip()
try:
    actual = int(text)
    if actual == ${expectedCount}:
        cp.append({"name": "value_correct", "score": 1.0, "reason": None})
    else:
        cp.append({"name": "value_correct", "score": 0.0, "reason": f"expected ${expectedCount}, got {actual}"})
except ValueError:
    cp.append({"name": "value_correct", "score": 0.0, "reason": f"not an integer: {text[:100]}"})`,
    }),
  }
}

/**
 * L2: Read data.csv (name,score,department), compute avg score,
 * write result.json with average_score and total_employees.
 */
function generateL2(rng: Rng): MicrobenchmarkInstance {
  const N = rng.randInt(5, 12)

  const rows: string[] = ["name,score,department"]
  let totalScore = 0
  for (let i = 0; i < N; i++) {
    const name = rng.randChoice(NAMES) + i
    const score = rng.randInt(1, 100)
    const dept = rng.randChoice(DEPTS)
    rows.push(`${name},${score},${dept}`)
    totalScore += score
  }

  const avgScore = totalScore / N
  const expectedAvg = Math.round(avgScore * 100) / 100

  return {
    prompt: `The file data.csv already exists in the current directory (columns: name, score, department). Write a JavaScript (Node.js) script that reads data.csv, computes the average score across all employees, and writes a JSON file result.json with two fields: "average_score" (rounded to 2 decimal places) and "total_employees" (integer count). Do not create or overwrite data.csv. Save the script as solution.js and execute it with node solution.js.`,
    setupFiles: {
      "data.csv": rows.join("\n"),
    },
    eval: pyEval({
      imports: ["subprocess", "os"],
      body: `${PY_RUN_SOLUTION}

# Check result file exists and is valid JSON
if not os.path.exists('result.json'):
    cp.append({"name": "output_format", "score": 0.0, "reason": "result.json not found"})
    ${PY_EMIT_CHECKPOINTS}
    raise SystemExit(0)

try:
    d = json.load(open('result.json'))
    cp.append({"name": "output_format", "score": 1.0, "reason": None})
except Exception as e:
    cp.append({"name": "output_format", "score": 0.0, "reason": f"invalid JSON: {e}"})
    ${PY_EMIT_CHECKPOINTS}
    raise SystemExit(0)

# Check total_employees
try:
    total = d['total_employees']
    if total == ${N}:
        cp.append({"name": "total_correct", "score": 1.0, "reason": None})
    else:
        cp.append({"name": "total_correct", "score": 0.0, "reason": f"expected ${N}, got {total}"})
except KeyError:
    cp.append({"name": "total_correct", "score": 0.0, "reason": "missing total_employees field"})

# Check average_score
try:
    avg = round(d['average_score'], 2)
    if avg == ${expectedAvg}:
        cp.append({"name": "value_correct", "score": 1.0, "reason": None})
    else:
        cp.append({"name": "value_correct", "score": 0.0, "reason": f"expected ${expectedAvg}, got {avg}"})
except KeyError:
    cp.append({"name": "value_correct", "score": 0.0, "reason": "missing average_score field"})`,
    }),
  }
}

/**
 * L3: Concurrently process K data sets using Promise.all, merge JSON by KEY,
 * write deduplicated union to result.json.
 * (Simplified: uses local JSON files instead of HTTP server.)
 */
function generateL3(rng: Rng): MicrobenchmarkInstance {
  const K = rng.randInt(2, 4)
  const KEY = "id"

  // Generate K JSON files, each with some overlapping records
  const allRecords: Map<number, { id: number; name: string; source: string }> = new Map()
  const setupFiles: Record<string, string> = {}

  for (let f = 0; f < K; f++) {
    const fileRecords: Array<{ id: number; name: string; source: string }> = []
    const count = rng.randInt(3, 6)
    for (let j = 0; j < count; j++) {
      // Use overlapping ID ranges to create duplicates
      const id = rng.randInt(1, K * 4)
      const name = rng.randChoice(NAMES)
      const record = { id, name, source: `file${f}` }
      fileRecords.push(record)
      allRecords.set(id, record) // last-write-wins for dedup
    }
    setupFiles[`data${f}.json`] = JSON.stringify(fileRecords, null, 2)
  }

  const expectedCount = allRecords.size

  const fileList = Array.from({ length: K }, (_, i) => `data${i}.json`).join(", ")

  return {
    prompt: `The files ${fileList} already exist in the current directory. Write a JavaScript (Node.js) script that uses Promise.all to concurrently read these ${K} JSON files. Each file contains an array of objects with an "${KEY}" field. Merge all arrays into a single array, deduplicate by "${KEY}" (keep the last occurrence), and write the deduplicated array to result.json. Do not create or overwrite the input JSON files. Save the script as solution.js and execute it with node solution.js.`,
    setupFiles,
    eval: pyEval({
      imports: ["subprocess", "os"],
      body: `${PY_RUN_SOLUTION}

# Check result file exists and is valid JSON
if not os.path.exists('result.json'):
    cp.append({"name": "output_format", "score": 0.0, "reason": "result.json not found"})
    ${PY_EMIT_CHECKPOINTS}
    raise SystemExit(0)

try:
    result = json.load(open('result.json'))
    cp.append({"name": "output_format", "score": 1.0, "reason": None})
except Exception as e:
    cp.append({"name": "output_format", "score": 0.0, "reason": f"invalid JSON: {e}"})
    ${PY_EMIT_CHECKPOINTS}
    raise SystemExit(0)

# Check result is an array
if isinstance(result, list):
    cp.append({"name": "result_is_array", "score": 1.0, "reason": None})
else:
    cp.append({"name": "result_is_array", "score": 0.0, "reason": f"expected array, got {type(result).__name__}"})
    ${PY_EMIT_CHECKPOINTS}
    raise SystemExit(0)

# Check no duplicates
ids = [r['${KEY}'] for r in result]
if len(ids) == len(set(ids)):
    cp.append({"name": "no_duplicates", "score": 1.0, "reason": None})
else:
    cp.append({"name": "no_duplicates", "score": 0.0, "reason": f"found duplicate ids in result"})

# Check record count
if len(result) == ${expectedCount}:
    cp.append({"name": "value_correct", "score": 1.0, "reason": None})
else:
    cp.append({"name": "value_correct", "score": 0.0, "reason": f"expected ${expectedCount} records, got {len(result)}"})`,
    }),
  }
}

export default defineGenerator({
  primitiveId: "gen.code.javascript",
  descriptions: {
    L1: "Write a Node.js script that reads a text file, counts lines containing a specific character, and writes the count to a file",
    L2: "Write a Node.js script that reads CSV data, computes an average, and writes structured JSON output",
    L3: "Write a Node.js script using Promise.all to concurrently read multiple JSON files, merge and deduplicate records by key, and write the result",
  },
  levels: { L1: generateL1, L2: generateL2, L3: generateL3 },
})
