import type { MicrobenchmarkInstance } from "../types.ts"
import { defineGenerator, fisherYatesShuffle, pyEval, type Rng } from "../generator-toolkit.ts"

/**
 * L1: Tasks with dependency edges, list valid execution order (topological sort)
 */
function generateL1(rng: Rng): MicrobenchmarkInstance {
  const N = rng.randChoice([4, 5, 6])
  const tasks = Array.from({ length: N }, (_, i) => String.fromCharCode(65 + i))

  // Build a DAG: for each node, randomly add edges from earlier nodes
  const edges: [string, string][] = []
  for (let i = 1; i < N; i++) {
    // Each node depends on at least one earlier node (to ensure connectivity)
    const numDeps = rng.randInt(1, Math.min(2, i))
    const possibleSources = tasks.slice(0, i)
    const sources = fisherYatesShuffle(rng, possibleSources).slice(0, numDeps)
    for (const src of sources) {
      edges.push([src, tasks[i]!])
    }
  }

  const edgeCount = edges.length
  const edgesStr = edges.map(([a, b]) => `${a} -> ${b}`).join(", ")
  const edgesJson = JSON.stringify(edges)

  const prompt = `Tasks: ${tasks.join(", ")}
Dependencies (${edgeCount} edges): ${edgesStr}
(X -> Y means X must complete before Y starts)

List a valid execution order. Answer with just the task letters separated by commas (e.g., A,B,C,D), nothing else.`

  return {
    prompt,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read().strip()
order = [x.strip() for x in re.findall(r'[A-Z]', text)]
edges = json.loads('${edgesJson}')
tasks = set('${tasks.join("")}')
cp.append({"name": "tasks_complete", "score": 1.0 if set(order) == tasks else 0.0,
  "reason": None if set(order) == tasks else f"expected {tasks}, got {set(order)}"})
cp.append({"name": "no_duplicates", "score": 1.0 if len(order) == len(tasks) else 0.0,
  "reason": None if len(order) == len(tasks) else f"expected {len(tasks)} tasks, got {len(order)}"})
if set(order) == tasks and len(order) == len(tasks):
    pos = {t: i for i, t in enumerate(order)}
    bad = [f"{a} before {b}" for a, b in edges if pos[a] >= pos[b]]
    ok = len(bad) == 0
    cp.append({"name": "order_valid", "score": 1.0 if ok else 0.0,
      "reason": None if ok else f"violated: {', '.join(bad)}"})`,
    }),
  }
}

/**
 * L2: Tasks with dependencies - which tasks can run in parallel at a given stage?
 */
function generateL2(rng: Rng): MicrobenchmarkInstance {
  // Build a known DAG with specific parallel opportunities
  const tasks = ["A", "B", "C", "D", "E"]

  // A has no deps, B depends on A, C depends on A, D depends on B, E depends on C
  // So after A completes: B and C can run in parallel
  // After B and C complete: D and E can run in parallel
  const patterns = [
    {
      edges: [["A", "B"], ["A", "C"], ["B", "D"], ["C", "E"]] as [string, string][],
      question: "After A completes, which tasks can run in parallel?",
      answer: ["B", "C"],
    },
    {
      edges: [["A", "C"], ["B", "C"], ["C", "D"], ["C", "E"]] as [string, string][],
      question: "After both A and B complete, which tasks can run in parallel? (List only tasks whose ALL dependencies are met.)",
      answer: ["C"],
    },
    {
      edges: [["A", "B"], ["A", "C"], ["B", "D"], ["C", "D"], ["A", "E"]] as [string, string][],
      question: "After A completes, which tasks can run in parallel?",
      answer: ["B", "C", "E"],
    },
  ]

  const pattern = rng.randChoice(patterns)
  const answerSorted = [...pattern.answer].sort()
  const answerJson = JSON.stringify(answerSorted)

  const edgesStr = pattern.edges.map(([a, b]) => `${a} -> ${b}`).join(", ")

  const prompt = `Tasks: ${tasks.join(", ")}
Dependencies: ${edgesStr}
(X -> Y means X must complete before Y starts)

${pattern.question}

Answer with just the task letters separated by commas (alphabetical order), nothing else.`

  return {
    prompt,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read().strip()
found = sorted(set(re.findall(r'[A-E]', text)))
expected = json.loads('${answerJson}')
ok = found == expected
cp = [{"name": "tasks_correct", "score": 1.0 if ok else 0.0,
  "reason": None if ok else f"expected {expected}, got {found}"}]`,
    }),
  }
}

/**
 * L3: Deployment pipeline with failure handling
 */
function generateL3(rng: Rng): MicrobenchmarkInstance {
  const steps = ["Build", "Test", "Lint", "Deploy", "Notify"]
  const N = 5

  // Define a pipeline with a failing step
  const failStep = rng.randChoice(["Test", "Lint"] as const)
  const deps: Record<string, string[]> = {
    Build: [],
    Test: ["Build"],
    Lint: ["Build"],
    Deploy: ["Test", "Lint"],
    Notify: ["Deploy"],
  }

  // Compute what can execute before failure
  const completed = new Set<string>()
  const skipped = new Set<string>()

  // Simulate execution
  // Build always runs first
  completed.add("Build")

  // Test and Lint can run after Build
  if (failStep === "Test") {
    skipped.add("Test")
    completed.add("Lint")
  } else {
    completed.add("Test")
    skipped.add("Lint")
  }

  // Deploy depends on Test AND Lint - one failed, so Deploy is skipped
  skipped.add("Deploy")
  // Notify depends on Deploy - skipped too
  skipped.add("Notify")

  const executionOrder = ["Build"]
  if (failStep === "Test") {
    executionOrder.push("Lint")
  } else {
    executionOrder.push("Test")
  }

  const skippedSorted = [...skipped].sort()
  const skippedJson = JSON.stringify(skippedSorted)
  const executedJson = JSON.stringify(executionOrder)

  const depsStr = steps.map(s =>
    `${s}: depends on [${deps[s]!.join(", ") || "nothing"}]`
  ).join("\n")

  const prompt = `A deployment pipeline has ${N} steps:
${depsStr}

Step "${failStep}" fails. Steps whose dependencies include a failed or skipped step are also skipped.

1. Which steps complete successfully? List them in execution order.
2. Which steps are skipped?

Answer in exactly two lines:
Line 1: completed steps (comma-separated)
Line 2: skipped steps (comma-separated, alphabetical)
Nothing else.`

  return {
    prompt,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read().strip()
lines = [l.strip() for l in text.split('\\n') if l.strip()]
cp.append({"name": "lines_found", "score": 1.0 if len(lines) >= 2 else 0.0,
  "reason": None if len(lines) >= 2 else f"need 2 lines, got {len(lines)}"})
if len(lines) >= 2:
    completed = [c.title() for c in re.findall(r'[A-Za-z]+', lines[0])]
    skipped_raw = [s.title() for s in re.findall(r'[A-Za-z]+', lines[1])]
    exp_completed = json.loads('${executedJson}')
    exp_skipped = json.loads('${skippedJson}')
    c_ok = completed == exp_completed
    cp.append({"name": "completed_correct", "score": 1.0 if c_ok else 0.0,
      "reason": None if c_ok else f"expected {exp_completed}, got {completed}"})
    s_ok = sorted(skipped_raw) == sorted(exp_skipped)
    cp.append({"name": "skipped_correct", "score": 1.0 if s_ok else 0.0,
      "reason": None if s_ok else f"expected {exp_skipped}, got {sorted(skipped_raw)}"})`,
    }),
  }
}

export default defineGenerator({
  primitiveId: "reason.planning",
  descriptions: {
    L1: "Produce a valid topological ordering of tasks given a dependency DAG",
    L2: "Identify which tasks can execute in parallel at a given stage of a dependency graph",
    L3: "Trace execution through a deployment pipeline with a failing step to determine which steps complete and which are skipped",
  },
  levels: { L1: generateL1, L2: generateL2, L3: generateL3 },
})
