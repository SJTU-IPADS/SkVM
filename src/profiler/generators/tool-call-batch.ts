import type { MicrobenchmarkInstance } from "../types.ts"
import { defineGenerator, pyEval, type Rng } from "../generator-toolkit.ts"

const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"]

/**
 * L1: Read F1 and F2, combine content into result.txt.
 */
function generateL1(rng: Rng): MicrobenchmarkInstance {
  const content1 = Array.from({ length: rng.randInt(2, 4) }, () =>
    `${rng.randChoice(WORDS)}_${rng.randInt(10, 99)}`
  ).join("\n")

  const content2 = Array.from({ length: rng.randInt(2, 4) }, () =>
    `${rng.randChoice(WORDS)}_${rng.randInt(10, 99)}`
  ).join("\n")

  return {
    prompt: `Read the files part1.txt and part2.txt. Combine their contents (part1 first, then part2) and write the result to result.txt in the current directory. Each file's content should be on its own lines, with part2 starting on a new line after part1.`,
    setupFiles: {
      "part1.txt": content1,
      "part2.txt": content2,
    },
    eval: pyEval({
      imports: ["os"],
      body: `exists = os.path.isfile('result.txt')
cp.append({"name": "file_exists", "score": 1.0 if exists else 0.0,
  "reason": None if exists else "result.txt not found"})
if exists:
    p1 = open('part1.txt').read().strip()
    p2 = open('part2.txt').read().strip()
    expected = p1 + '\\n' + p2
    actual = open('result.txt').read().strip()
    ok = actual == expected
    cp.append({"name": "content_correct", "score": 1.0 if ok else 0.0,
      "reason": None if ok else "concatenated content mismatch"})`,
    }),
  }
}

/**
 * L2: Read K files, write summary "filename: first_word" per file.
 */
function generateL2(rng: Rng): MicrobenchmarkInstance {
  const K = 5
  const setupFiles: Record<string, string> = {}
  const expectedLines: string[] = []

  for (let i = 1; i <= K; i++) {
    const fname = `data${i}.txt`
    const firstWord = rng.randChoice(WORDS)
    const content = `${firstWord} ${rng.randInt(100, 999)} extra content here`
    setupFiles[fname] = content
    expectedLines.push(`${fname}: ${firstWord}`)
  }

  const fileList = Object.keys(setupFiles).join(", ")
  const expectedJson = JSON.stringify(expectedLines)

  return {
    prompt: `Read these ${K} files: ${fileList}. For each file, extract the first word of its content. Write a summary to result.txt in the current directory with one line per file in the format "filename: first_word", in the order listed above.`,
    setupFiles,
    eval: pyEval({
      imports: ["os"],
      body: `exists = os.path.isfile('result.txt')
cp.append({"name": "file_exists", "score": 1.0 if exists else 0.0,
  "reason": None if exists else "result.txt not found"})
if exists:
    expected = json.loads(${JSON.stringify(expectedJson)})
    actual = open('result.txt').read().strip().split('\\n')
    actual = [l.strip() for l in actual if l.strip()]
    count_ok = len(actual) == len(expected)
    cp.append({"name": "format_correct", "score": 1.0 if count_ok else 0.0,
      "reason": None if count_ok else f"expected {len(expected)} lines, got {len(actual)}"})
    if count_ok:
        mismatches = []
        for exp, act in zip(expected, actual):
            if exp != act:
                mismatches.append(f"expected [{exp}], got [{act}]")
        ok = len(mismatches) == 0
        cp.append({"name": "content_correct", "score": 1.0 if ok else 0.0,
          "reason": None if ok else "; ".join(mismatches[:3])})`,
    }),
  }
}

/**
 * L3: Read K data files with numbers, compute aggregate across all, write result.
 */
function generateL3(rng: Rng): MicrobenchmarkInstance {
  const K = rng.randInt(3, 6)
  const agg = rng.randChoice(["sum", "max", "min"] as const)
  const setupFiles: Record<string, string> = {}
  const allNumbers: number[] = []

  for (let i = 1; i <= K; i++) {
    const fname = `values${i}.txt`
    const nums = Array.from({ length: rng.randInt(3, 6) }, () => rng.randInt(1, 500))
    setupFiles[fname] = nums.join("\n")
    allNumbers.push(...nums)
  }

  let expected: number
  switch (agg) {
    case "sum":
      expected = allNumbers.reduce((a, b) => a + b, 0)
      break
    case "max":
      expected = Math.max(...allNumbers)
      break
    case "min":
      expected = Math.min(...allNumbers)
      break
  }

  const fileList = Object.keys(setupFiles).join(", ")

  return {
    prompt: `Read these ${K} files: ${fileList}. Each file contains numbers, one per line. Compute the ${agg} across ALL numbers from ALL files and write just the result (a single number) to result.txt in the current directory.`,
    setupFiles,
    eval: pyEval({
      imports: ["os"],
      body: `exists = os.path.isfile('result.txt')
cp.append({"name": "file_exists", "score": 1.0 if exists else 0.0,
  "reason": None if exists else "result.txt not found"})
if exists:
    actual = open('result.txt').read().strip()
    expected = ${expected}
    match = False
    try:
        if abs(float(actual) - float(expected)) < 0.01:
            match = True
    except ValueError:
        pass
    if not match:
        match = actual == str(expected)
    cp.append({"name": "aggregation_correct", "score": 1.0 if match else 0.0,
      "reason": None if match else f"expected {expected}, got {actual}"})`,
    }),
  }
}

export default defineGenerator({
  primitiveId: "tool.call.batch",
  descriptions: {
    L1: "Read two files and concatenate their contents into a single output file",
    L2: "Read multiple files, extract the first word from each, and write a per-file summary",
    L3: "Read numbers from multiple files and compute a cross-file aggregate (sum, max, or min)",
  },
  levels: { L1: generateL1, L2: generateL2, L3: generateL3 },
})
