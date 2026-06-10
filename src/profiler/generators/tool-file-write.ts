import type { MicrobenchmarkInstance } from "../types.ts"
import { defineGenerator, pyEval, type Rng } from "../generator-toolkit.ts"

const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"]

/**
 * L1: Create output.txt with exact multi-line content.
 */
function generateL1(rng: Rng): MicrobenchmarkInstance {
  const lineCount = rng.randInt(3, 6)
  const lines: string[] = []
  for (let i = 0; i < lineCount; i++) {
    const word = rng.randChoice(WORDS)
    const num = rng.randInt(100, 999)
    lines.push(`${word} ${num}`)
  }
  const content = lines.join("\n")
  const contentJson = JSON.stringify(content)

  return {
    prompt: `Create a file called output.txt with the following exact content (${lineCount} lines):

${content}

Write exactly this content, nothing more, nothing less. The file should be in the current directory.`,
    eval: pyEval({
      imports: ["os"],
      body: `exists = os.path.isfile('output.txt')
cp.append({"name": "file_exists", "score": 1.0 if exists else 0.0,
  "reason": None if exists else "output.txt not found"})
if exists:
    expected = json.loads(${JSON.stringify(contentJson)})
    actual = open('output.txt').read().strip()
    ok = actual == expected
    cp.append({"name": "content_match", "score": 1.0 if ok else 0.0,
      "reason": None if ok else "content mismatch"})`,
    }),
  }
}

/**
 * L2: Create output.txt with a numbered list 1 to N.
 */
function generateL2(rng: Rng): MicrobenchmarkInstance {
  const N = rng.randInt(15, 50)

  return {
    prompt: `Create a file called output.txt containing a numbered list from 1 to ${N}. Each line should be formatted as "NUMBER. WORD" where the words cycle through: ${WORDS.join(", ")}. For example:
1. alpha
2. bravo
...and so on up to ${N}.

Do not truncate. All ${N} lines must be present. The file should be in the current directory.`,
    eval: pyEval({
      imports: ["os"],
      body: `exists = os.path.isfile('output.txt')
cp.append({"name": "file_exists", "score": 1.0 if exists else 0.0,
  "reason": None if exists else "output.txt not found"})
if exists:
    words = json.loads(${JSON.stringify(JSON.stringify(WORDS))})
    N = ${N}
    lines = open('output.txt').read().strip().split('\\n')
    lines = [l.strip() for l in lines if l.strip()]
    count_ok = len(lines) == N
    cp.append({"name": "line_count", "score": 1.0 if count_ok else 0.0,
      "reason": None if count_ok else f"expected {N} lines, got {len(lines)}"})
    if count_ok:
        mismatches = []
        for i in range(N):
            expected = f'{i+1}. {words[i % len(words)]}'
            if lines[i] != expected:
                mismatches.append(f"line {i+1}: expected [{expected}], got [{lines[i]}]")
        ok = len(mismatches) == 0
        cp.append({"name": "content_match", "score": 1.0 if ok else 0.0,
          "reason": None if ok else "; ".join(mismatches[:3])})`,
    }),
  }
}

/**
 * L3: Create K files each with specified content.
 */
function generateL3(rng: Rng): MicrobenchmarkInstance {
  const K = rng.randInt(3, 6)
  const files: Record<string, string> = {}
  const descriptions: string[] = []

  for (let i = 1; i <= K; i++) {
    const fname = `part${i}.txt`
    const lineCount = rng.randInt(2, 4)
    const lines: string[] = []
    for (let j = 0; j < lineCount; j++) {
      lines.push(`${rng.randChoice(WORDS)}_${rng.randInt(10, 99)}`)
    }
    const content = lines.join("\n")
    files[fname] = content
    descriptions.push(`${fname}:\n${lines.map(l => `  ${l}`).join("\n")}`)
  }

  const filesJson = JSON.stringify(files)

  return {
    prompt: `Create ${K} files with the following exact content:

${descriptions.join("\n\n")}

Create each file with exactly the content shown. All files should be in the current directory.`,
    eval: pyEval({
      imports: ["os"],
      body: `expected = json.loads(${JSON.stringify(filesJson)})
for fname, content in expected.items():
    exists = os.path.isfile(fname)
    cp.append({"name": f"{fname}_exists", "score": 1.0 if exists else 0.0,
      "reason": None if exists else f"{fname} not found"})
    if exists:
        actual = open(fname).read().strip()
        ok = actual == content.strip()
        cp.append({"name": f"{fname}_content", "score": 1.0 if ok else 0.0,
          "reason": None if ok else f"{fname}: content mismatch"})`,
    }),
  }
}

export default defineGenerator({
  primitiveId: "tool.file.write",
  descriptions: {
    L1: "Create a single file with exact multi-line content as specified",
    L2: "Create a file containing a long numbered list (15-50 items) with cycling word patterns",
    L3: "Create multiple files at once, each with distinct specified content",
  },
  levels: { L1: generateL1, L2: generateL2, L3: generateL3 },
})
