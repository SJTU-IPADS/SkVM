import type { MicrobenchmarkInstance } from "../types.ts"
import { defineGenerator, pyEval, type Rng } from "../generator-toolkit.ts"

/**
 * L1: 1. Write START. 2. List numbers 1-N. 3. Write END.
 */
function generateL1(rng: Rng): MicrobenchmarkInstance {
  const N = rng.randInt(4, 10)

  const expectedLines = ["START"]
  for (let i = 1; i <= N; i++) {
    expectedLines.push(String(i))
  }
  expectedLines.push("END")

  const expectedJson = JSON.stringify(expectedLines)

  const prompt = `Follow these steps exactly and respond with the result:
1. The word "START" on its own line
2. The numbers 1 through ${N}, each on its own line
3. The word "END" on its own line

Provide only the result, nothing else.`

  return {
    prompt,
    eval: pyEval({
      body: `text = open('response.txt').read().strip()
actual = [l.strip() for l in text.splitlines() if l.strip()]
expected = json.loads(${JSON.stringify(expectedJson)})

ok_count = len(actual) == len(expected)
cp.append({"name": "line_count", "score": 1.0 if ok_count else 0.0,
  "reason": None if ok_count else f"expected {len(expected)} lines, got {len(actual)}"})

for i, exp_line in enumerate(expected):
    if i < len(actual):
        ok = actual[i] == exp_line
        cp.append({"name": f"line_{i+1}", "score": 1.0 if ok else 0.0,
          "reason": None if ok else f"expected [{exp_line}], got [{actual[i]}]"})
    else:
        cp.append({"name": f"line_{i+1}", "score": 0.0, "reason": "line missing"})`,
    }),
  }
}

/**
 * L2: 6 steps with conditional branch based on N even/odd.
 */
function generateL2(rng: Rng): MicrobenchmarkInstance {
  const N = rng.randInt(10, 50)
  const isEven = N % 2 === 0

  const expectedLines = [
    `INPUT: ${N}`,
    `CHECK: ${isEven ? "EVEN" : "ODD"}`,
    isEven ? `HALF: ${N / 2}` : `TRIPLE: ${N * 3}`,
    `SQUARED: ${isEven ? (N / 2) ** 2 : (N * 3) ** 2}`,
    `TAG: ${isEven ? "EVEN_PATH" : "ODD_PATH"}`,
    "DONE",
  ]

  const expectedJson = JSON.stringify(expectedLines)

  const prompt = `Follow these 6 steps exactly for N = ${N} and respond with the result:
1. "INPUT: N" (replacing N with the value)
2. Check if N is even or odd: "CHECK: EVEN" or "CHECK: ODD"
3. If N is even: "HALF: N/2". If N is odd: "TRIPLE: N*3"
4. Take the result from step 3 and square it: "SQUARED: result"
5. "TAG: EVEN_PATH" if N was even, or "TAG: ODD_PATH" if N was odd
6. "DONE"

Each step is exactly one line. Provide only these 6 lines, nothing else.`

  return {
    prompt,
    eval: pyEval({
      body: `text = open('response.txt').read().strip()
actual = [l.strip() for l in text.split('\\n') if l.strip()]
expected = json.loads(${JSON.stringify(expectedJson)})

ok_count = len(actual) == 6
cp.append({"name": "line_count", "score": 1.0 if ok_count else 0.0,
  "reason": None if ok_count else f"expected 6 lines, got {len(actual)}"})

step_names = ["input", "check", "branch", "squared", "tag", "done"]
for i, exp_line in enumerate(expected):
    name = step_names[i] if i < len(step_names) else f"line_{i+1}"
    if i < len(actual):
        ok = actual[i] == exp_line
        cp.append({"name": name, "score": 1.0 if ok else 0.0,
          "reason": None if ok else f"expected [{exp_line}], got [{actual[i]}]"})
    else:
        cp.append({"name": name, "score": 0.0, "reason": "line missing"})`,
    }),
  }
}

/**
 * L3: Loop R times generating words from POOL, count starting with C.
 */
function generateL3(rng: Rng): MicrobenchmarkInstance {
  const pool = ["apple", "avocado", "banana", "blueberry", "cherry", "coconut", "apricot", "blackberry"]
  const R = rng.randInt(5, 8)
  const letter = rng.randChoice(["a", "b", "c"] as const)

  // Pre-select the words for each round so we know the expected output
  const selectedWords: string[] = []
  for (let i = 0; i < R; i++) {
    selectedWords.push(pool[rng.randInt(0, pool.length - 1)]!)
  }

  const count = selectedWords.filter(w => w.startsWith(letter)).length

  const expectedLines: string[] = []
  for (let i = 0; i < R; i++) {
    expectedLines.push(`Round ${i + 1}: ${selectedWords[i]}`)
  }
  expectedLines.push(`Count: ${count}`)

  const expectedJson = JSON.stringify(expectedLines)
  const poolStr = pool.join(", ")

  const prompt = `Follow this procedure exactly:

Word pool: [${poolStr}]
Target letter: "${letter}"

For each round from 1 to ${R}:
  Pick the following word for each round (in order): ${selectedWords.join(", ")}
  Respond with "Round N: WORD" (N is the round number, WORD is the picked word)

After all rounds, count how many of the picked words start with "${letter}" and respond with "Count: X" where X is the count.

Provide exactly ${R + 1} lines total (${R} round lines + 1 count line), nothing else.`

  return {
    prompt,
    eval: pyEval({
      body: `text = open('response.txt').read().strip()
actual = [l.strip() for l in text.split('\\n') if l.strip()]
expected = json.loads(${JSON.stringify(expectedJson)})

ok_count = len(actual) == len(expected)
cp.append({"name": "line_count", "score": 1.0 if ok_count else 0.0,
  "reason": None if ok_count else f"expected {len(expected)} lines, got {len(actual)}"})

for i, exp_line in enumerate(expected):
    if i < len(expected) - 1:
        name = f"round_{i+1}"
    else:
        name = "count_line"
    if i < len(actual):
        ok = actual[i] == exp_line
        cp.append({"name": name, "score": 1.0 if ok else 0.0,
          "reason": None if ok else f"expected [{exp_line}], got [{actual[i]}]"})
    else:
        cp.append({"name": name, "score": 0.0, "reason": "line missing"})`,
    }),
  }
}

export default defineGenerator({
  primitiveId: "follow.procedure",
  descriptions: {
    L1: "Follow a 3-step procedure: write a start marker, list numbers 1 through N, write an end marker",
    L2: "Follow a 6-step procedure with a conditional branch based on whether a number is even or odd, producing computed values at each step",
    L3: "Follow a loop procedure: iterate over a word pool for R rounds, output each round's word, then count words starting with a target letter",
  },
  levels: { L1: generateL1, L2: generateL2, L3: generateL3 },
})
