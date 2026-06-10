import type { MicrobenchmarkInstance } from "../types.ts"
import { defineGenerator, pyEval, type Rng } from "../generator-toolkit.ts"

const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"]

/**
 * L1: Read data.txt, copy content to result.txt exactly.
 */
function generateL1(rng: Rng): MicrobenchmarkInstance {
  const lineCount = rng.randInt(3, 8)
  const lines: string[] = []
  for (let i = 0; i < lineCount; i++) {
    const word = rng.randChoice(WORDS)
    const num = rng.randInt(100, 999)
    lines.push(`${word}-${num}`)
  }
  const content = lines.join("\n")

  return {
    prompt: `Read the file data.txt and copy its content exactly to a new file called result.txt in the current directory. Do not modify the content in any way.`,
    setupFiles: {
      "data.txt": content,
    },
    eval: pyEval({
      imports: ["os"],
      body: `exists = os.path.isfile('result.txt')
cp.append({"name": "file_exists", "score": 1.0 if exists else 0.0,
  "reason": None if exists else "result.txt not found"})
if exists:
    expected = open('data.txt').read().strip()
    actual = open('result.txt').read().strip()
    ok = actual == expected
    cp.append({"name": "content_correct", "score": 1.0 if ok else 0.0,
      "reason": None if ok else "content mismatch"})`,
    }),
  }
}

/**
 * L2: Read files F1..FK, write "filename: content" per file, or "filename: NOT_FOUND".
 * Setup: only K-1 files exist.
 */
function generateL2(rng: Rng): MicrobenchmarkInstance {
  const K = rng.randInt(3, 5)
  const fileNames: string[] = []
  for (let i = 1; i <= K; i++) {
    fileNames.push(`file${i}.txt`)
  }

  // One file will be missing
  const missingIdx = rng.randInt(0, K - 1)
  const setupFiles: Record<string, string> = {}
  const expectedLines: string[] = []

  for (let i = 0; i < K; i++) {
    const fname = fileNames[i]!
    if (i === missingIdx) {
      expectedLines.push(`${fname}: NOT_FOUND`)
    } else {
      const content = `${rng.randChoice(WORDS)}_${rng.randInt(10, 99)}`
      setupFiles[fname] = content
      expectedLines.push(`${fname}: ${content}`)
    }
  }

  const fileList = fileNames.join(", ")

  return {
    prompt: `Read these files: ${fileList}. For each file, write one line to result.txt in the format "filename: content". If a file does not exist, write "filename: NOT_FOUND" instead. One file per line, in the order listed. All files should be in the current directory.`,
    setupFiles,
    eval: pyEval({
      imports: ["os"],
      body: `exists = os.path.isfile('result.txt')
cp.append({"name": "file_exists", "score": 1.0 if exists else 0.0,
  "reason": None if exists else "result.txt not found"})
if exists:
    expected_lines = json.loads(${JSON.stringify(JSON.stringify(expectedLines))})
    actual = open('result.txt').read().strip().split('\\n')
    actual = [l.strip() for l in actual if l.strip()]
    count_ok = len(actual) == len(expected_lines)
    cp.append({"name": "format_correct", "score": 1.0 if count_ok else 0.0,
      "reason": None if count_ok else f"expected {len(expected_lines)} lines, got {len(actual)}"})
    if count_ok:
        mismatches = []
        for exp, act in zip(expected_lines, actual):
            if exp != act:
                mismatches.append(f"expected [{exp}], got [{act}]")
        ok = len(mismatches) == 0
        cp.append({"name": "content_correct", "score": 1.0 if ok else 0.0,
          "reason": None if ok else "; ".join(mismatches[:3])})`,
    }),
  }
}

/**
 * L3: Read data.txt starting from line S, return exactly L lines, write to result.txt.
 */
function generateL3(rng: Rng): MicrobenchmarkInstance {
  const totalLines = rng.randInt(20, 40)
  const lines: string[] = []
  for (let i = 0; i < totalLines; i++) {
    lines.push(`line${i + 1}: ${rng.randChoice(WORDS)}_${rng.randInt(100, 999)}`)
  }

  const startLine = rng.randInt(5, totalLines - 10)
  const numLines = rng.randInt(3, Math.min(8, totalLines - startLine + 1))

  const expectedLines = lines.slice(startLine - 1, startLine - 1 + numLines)
  const expectedJson = JSON.stringify(expectedLines)

  return {
    prompt: `Read data.txt starting from line ${startLine} (1-indexed), extract exactly ${numLines} lines, and write them to result.txt in the current directory. Preserve the content exactly.`,
    setupFiles: {
      "data.txt": lines.join("\n"),
    },
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
        for i, (exp, act) in enumerate(zip(expected, actual)):
            if exp != act:
                mismatches.append(f"line {i+1} mismatch")
        ok = len(mismatches) == 0
        cp.append({"name": "content_correct", "score": 1.0 if ok else 0.0,
          "reason": None if ok else "; ".join(mismatches[:3])})`,
    }),
  }
}

export default defineGenerator({
  primitiveId: "tool.file.read",
  descriptions: {
    L1: "Read a single file and copy its content exactly to a new file",
    L2: "Read multiple files (some missing) and write a per-file summary indicating content or NOT_FOUND",
    L3: "Read a specific line range from a file (by start line and count) and write the extracted lines to a new file",
  },
  levels: { L1: generateL1, L2: generateL2, L3: generateL3 },
})
