import type { MicrobenchmarkInstance } from "../types.ts"
import { defineGenerator, pyEval, type Rng } from "../generator-toolkit.ts"

/**
 * L1: Run a command on data.txt, write result to result.txt.
 */
function generateL1(rng: Rng): MicrobenchmarkInstance {
  const lineCount = rng.randInt(5, 15)
  const lines: string[] = []
  for (let i = 0; i < lineCount; i++) {
    lines.push(`item_${rng.randInt(100, 999)}`)
  }
  // Trailing newline so `wc -l` (which counts newline characters) reports the
  // true line count instead of lineCount-1.
  const content = lines.join("\n") + "\n"

  const commands = [
    {
      cmd: "wc -l < data.txt",
      description: `Count the number of lines in data.txt using \`wc -l\``,
      expected: String(lineCount),
    },
    {
      cmd: "sort data.txt",
      description: `Sort the lines of data.txt alphabetically using the \`sort\` command`,
      expected: [...lines].sort().join("\n"),
    },
    {
      cmd: "head -3 data.txt",
      description: `Extract the first 3 lines of data.txt using \`head -3\``,
      expected: lines.slice(0, 3).join("\n"),
    },
  ]

  const cmdInfo = rng.randChoice(commands)

  return {
    prompt: `${cmdInfo.description} and write the result to result.txt in the current directory.`,
    setupFiles: {
      "data.txt": content,
    },
    eval: pyEval({
      imports: ["os", "re"],
      body: `exists = os.path.isfile('result.txt')
cp.append({"name": "file_exists", "score": 1.0 if exists else 0.0,
  "reason": None if exists else "result.txt not found"})
if exists:
    actual = open('result.txt').read().strip()
    expected = ${JSON.stringify(cmdInfo.expected)}.strip()
    match = False
    if expected.isdigit():
        nums = re.findall(r'\\d+', actual.split('\\n')[0])
        if nums and nums[0] == expected:
            match = True
    if not match:
        match = actual == expected
    cp.append({"name": "output_correct", "score": 1.0 if match else 0.0,
      "reason": None if match else f"expected [{expected[:50]}], got [{actual[:50]}]"})`,
    }),
  }
}

/**
 * L2: Write a Python script computing an expression from input, execute it, write output.
 */
function generateL2(rng: Rng): MicrobenchmarkInstance {
  const scenarios = [
    (rng: Rng) => {
      const nums = Array.from({ length: rng.randInt(3, 6) }, () => rng.randInt(1, 50))
      const expected = nums.reduce((a, b) => a + b, 0)
      return {
        description: `Write a Python script called compute.py that reads numbers from input.txt (one per line), computes their sum, and writes the result to result.txt.`,
        inputContent: nums.join("\n"),
        expected: String(expected),
      }
    },
    (rng: Rng) => {
      const nums = Array.from({ length: rng.randInt(3, 6) }, () => rng.randInt(2, 20))
      const expected = nums.reduce((a, b) => a * b, 1)
      return {
        description: `Write a Python script called compute.py that reads numbers from input.txt (one per line), computes their product, and writes the result to result.txt.`,
        inputContent: nums.join("\n"),
        expected: String(expected),
      }
    },
    (rng: Rng) => {
      const nums = Array.from({ length: rng.randInt(4, 8) }, () => rng.randInt(1, 100))
      const sorted = [...nums].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      const median = sorted.length % 2 === 0
        ? (sorted[mid - 1]! + sorted[mid]!) / 2
        : sorted[mid]!
      const expected = Number.isInteger(median) ? String(median) : median.toFixed(1)
      return {
        description: `Write a Python script called compute.py that reads numbers from input.txt (one per line), computes the median, and writes the result to result.txt.`,
        inputContent: nums.join("\n"),
        expected,
      }
    },
  ]

  const scenario = rng.randChoice(scenarios)(rng)

  return {
    prompt: `${scenario.description} Then execute the script. All files should be in the current directory.`,
    setupFiles: {
      "input.txt": scenario.inputContent,
    },
    eval: pyEval({
      imports: ["os"],
      body: `script_exists = os.path.isfile('compute.py')
cp.append({"name": "file_exists", "score": 1.0 if script_exists else 0.0,
  "reason": None if script_exists else "compute.py not found"})
result_exists = os.path.isfile('result.txt')
cp.append({"name": "execution_correct", "score": 1.0 if result_exists else 0.0,
  "reason": None if result_exists else "result.txt not found"})
if result_exists:
    actual = open('result.txt').read().strip()
    expected = '${scenario.expected}'
    match = False
    try:
        if abs(float(actual) - float(expected)) < 0.01:
            match = True
    except ValueError:
        pass
    if not match:
        match = actual == expected
    cp.append({"name": "output_correct", "score": 1.0 if match else 0.0,
      "reason": None if match else f"expected {expected}, got {actual}"})`,
    }),
  }
}

/**
 * L3: Three-step pipeline using shell commands.
 */
function generateL3(rng: Rng): MicrobenchmarkInstance {
  const lineCount = rng.randInt(8, 15)
  const lines: string[] = []
  const words = ["apple", "banana", "cherry", "date", "elderberry"]
  for (let i = 0; i < lineCount; i++) {
    const word = rng.randChoice(words)
    const num = rng.randInt(1, 100)
    lines.push(`${word} ${num}`)
  }
  const content = lines.join("\n")

  // Pipeline: sort -> grep for a word -> count lines
  const targetWord = rng.randChoice(words)
  const matchingLines = lines.filter(l => l.startsWith(targetWord))
  const expectedCount = matchingLines.length

  return {
    prompt: `Perform a three-step pipeline on data.txt:

Step 1: Sort data.txt alphabetically and write to intermediate.txt
Step 2: From intermediate.txt, extract only lines starting with "${targetWord}" and write to processed.txt
Step 3: Count the number of lines in processed.txt and write just the count to result.txt

Use shell commands (sort, grep, wc) to accomplish each step. All files should be in the current directory.`,
    setupFiles: {
      "data.txt": content,
    },
    eval: pyEval({
      imports: ["os", "re"],
      body: `int_exists = os.path.isfile('intermediate.txt')
cp.append({"name": "intermediate_exists", "score": 1.0 if int_exists else 0.0,
  "reason": None if int_exists else "intermediate.txt not found"})
proc_exists = os.path.isfile('processed.txt')
cp.append({"name": "processed_exists", "score": 1.0 if proc_exists else 0.0,
  "reason": None if proc_exists else "processed.txt not found"})
result_exists = os.path.isfile('result.txt')
cp.append({"name": "file_exists", "score": 1.0 if result_exists else 0.0,
  "reason": None if result_exists else "result.txt not found"})
if result_exists:
    result = open('result.txt').read().strip()
    expected = '${expectedCount}'
    nums = re.findall(r'\\d+', result.split('\\n')[0])
    ok = result == expected or (nums and nums[0] == expected)
    cp.append({"name": "output_correct", "score": 1.0 if ok else 0.0,
      "reason": None if ok else f"expected {expected}, got {result}"})`,
    }),
  }
}

export default defineGenerator({
  primitiveId: "tool.exec",
  descriptions: {
    L1: "Run a single shell command (wc, sort, or head) on a data file and write the output to a result file",
    L2: "Write a Python script that reads input, computes an aggregate (sum, product, or median), execute it, and write the result",
    L3: "Execute a three-step shell pipeline (sort, grep, wc) producing intermediate files at each stage",
  },
  levels: { L1: generateL1, L2: generateL2, L3: generateL3 },
})
