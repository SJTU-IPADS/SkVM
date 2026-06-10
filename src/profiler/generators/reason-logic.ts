import type { MicrobenchmarkInstance } from "../types.ts"
import { defineGenerator, fisherYatesShuffle, pyEval, type Rng } from "../generator-toolkit.ts"

/**
 * L1: Syllogism - If all A are B, and X is A, is X B?
 */
function generateL1(rng: Rng): MicrobenchmarkInstance {
  const categories = [
    { A: "dogs", B: "mammals", name: "Rex" },
    { A: "cats", B: "animals", name: "Whiskers" },
    { A: "roses", B: "flowers", name: "Bella" },
    { A: "sparrows", B: "birds", name: "Tweety" },
    { A: "salmon", B: "fish", name: "Finley" },
    { A: "oaks", B: "trees", name: "Woody" },
    { A: "pythons", B: "snakes", name: "Slither" },
    { A: "eagles", B: "birds", name: "Sky" },
  ]

  const cat = rng.randChoice(categories)
  // Randomly decide if the pet is actually an A (answer=Yes) or not (answer=No)
  const isA = rng.random() < 0.5
  const petType = isA ? cat.A.slice(0, -1) : "hamster" // singular form
  const expected = isA ? "Yes" : "No"

  const prompt = `If all ${cat.A} are ${cat.B}, and ${cat.name}'s pet is a ${petType}. Is ${cat.name}'s pet a ${cat.B.slice(0, -1)}? Answer with just Yes or No, nothing else.`

  return {
    prompt,
    eval: pyEval({
      body: `text = open('response.txt').read().strip().lower()
expected = '${expected.toLowerCase()}'
ok = text.startswith(expected)
cp = [{"name": "answer_correct", "score": 1.0 if ok else 0.0,
  "reason": None if ok else f"expected ${expected}, got {text}"}]`,
    }),
  }
}

/**
 * L2: Seating arrangement - K people, 3-4 constraints, who sits at position P?
 */
function generateL2(rng: Rng): MicrobenchmarkInstance {
  const names = fisherYatesShuffle(rng, ["Alice", "Bob", "Carol", "Dave", "Eve"])
  const K = rng.randChoice([4, 5])
  const people = names.slice(0, K)

  // Generate a valid arrangement
  const arrangement = fisherYatesShuffle(rng, people)

  // Pick a target position
  const targetPos = rng.randInt(1, K)
  const answer = arrangement[targetPos - 1]!

  // Generate constraints that uniquely determine the arrangement
  const constraints: string[] = []
  // Fix at least 3 positions via constraints
  const fixedIndices = fisherYatesShuffle(rng, [...Array(K).keys()]).slice(0, Math.min(K, 4))

  for (const idx of fixedIndices) {
    const person = arrangement[idx]!
    const pos = idx + 1
    const constraintType = rng.randChoice(["direct", "adjacent", "not"] as const)

    if (constraintType === "direct" || constraints.length < 2) {
      constraints.push(`${person} sits at position ${pos}.`)
    } else if (constraintType === "adjacent" && idx < K - 1) {
      constraints.push(`${person} sits immediately before ${arrangement[idx + 1]!}.`)
    } else {
      // "not at" a wrong position
      const wrongPos = ((idx + rng.randInt(1, K - 1)) % K) + 1
      constraints.push(`${person} does not sit at position ${wrongPos}.`)
      // Also add the correct position
      constraints.push(`${person} sits at position ${pos}.`)
    }
  }

  const prompt = `${K} people sit at positions 1 to ${K}: ${people.join(", ")}.

Constraints:
${constraints.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Who sits at position ${targetPos}? Answer with just the name, nothing else.`

  return {
    prompt,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read().strip()
words = re.findall(r'[A-Za-z]+', text)
expected = '${answer}'.lower()
found = any(w.lower() == expected for w in words)
cp = [{"name": "answer_correct", "score": 1.0 if found else 0.0,
  "reason": None if found else f"expected ${answer}, got {text}"}]`,
    }),
  }
}

/**
 * L3: Assignment problem - N tasks to M workers with cost matrix, find min cost
 */
function generateL3(rng: Rng): MicrobenchmarkInstance {
  const N = rng.randChoice([3, 4])
  const tasks = Array.from({ length: N }, (_, i) => String.fromCharCode(65 + i)) // A, B, C, ...
  const workers = Array.from({ length: N }, (_, i) => `W${i + 1}`)

  // Generate cost matrix with known optimal solution
  const costs: number[][] = []
  for (let i = 0; i < N; i++) {
    const row: number[] = []
    for (let j = 0; j < N; j++) {
      row.push(rng.randInt(1, 20))
    }
    costs.push(row)
  }

  // Compute optimal assignment using brute force (N is small)
  function permutations(arr: number[]): number[][] {
    if (arr.length <= 1) return [arr]
    const result: number[][] = []
    for (let i = 0; i < arr.length; i++) {
      const rest = [...arr.slice(0, i), ...arr.slice(i + 1)]
      for (const perm of permutations(rest)) {
        result.push([arr[i]!, ...perm])
      }
    }
    return result
  }

  const indices = Array.from({ length: N }, (_, i) => i)
  let minCost = Infinity
  for (const perm of permutations(indices)) {
    let totalCost = 0
    for (let i = 0; i < N; i++) {
      totalCost += costs[i]![perm[i]!]!
    }
    if (totalCost < minCost) minCost = totalCost
  }

  const matrixStr = costs.map((row, i) => `  ${tasks[i]}: [${row.join(", ")}]`).join("\n")

  const prompt = `Assign ${N} tasks to ${N} workers to minimize total cost. Each worker does exactly one task, each task assigned to exactly one worker.

Cost matrix (rows = tasks, columns = workers ${workers.join(", ")}):
${matrixStr}

What is the minimum total cost? Answer with just the number, nothing else.`

  // Serialize cost matrix for the eval script
  const costsJson = JSON.stringify(costs)

  return {
    prompt,
    eval: pyEval({
      imports: ["re", "itertools"],
      body: `text = open('response.txt').read().strip()
nums = re.findall(r'\\d+', text)
cp.append({"name": "number_found", "score": 1.0 if nums else 0.0,
  "reason": None if nums else "no number found in response"})
if nums:
    actual = int(nums[-1])
    costs = json.loads('${costsJson}')
    n = len(costs)
    min_cost = min(sum(costs[i][p[i]] for i in range(n)) for p in itertools.permutations(range(n)))
    ok = actual == min_cost
    cp.append({"name": "cost_correct", "score": 1.0 if ok else 0.0,
      "reason": None if ok else f"expected {min_cost}, got {actual}"})`,
    }),
  }
}

export default defineGenerator({
  primitiveId: "reason.logic",
  descriptions: {
    L1: "Evaluate a syllogism to determine if a conclusion follows from categorical premises",
    L2: "Solve a seating arrangement puzzle with positional constraints to identify who sits at a given position",
    L3: "Solve a task-to-worker assignment problem with a cost matrix to find the minimum total cost",
  },
  levels: { L1: generateL1, L2: generateL2, L3: generateL3 },
})
