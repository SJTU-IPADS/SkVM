import type { MicrobenchmarkInstance } from "../types.ts"
import { defineGenerator, pyEval, type Rng } from "../generator-toolkit.ts"

/**
 * L1: MUST write Python script to compute product of NUMS, save as compute.py, execute, write result.
 */
function generateL1(rng: Rng): MicrobenchmarkInstance {
  const count = rng.randInt(3, 6)
  const nums = Array.from({ length: count }, () => rng.randInt(2, 20))
  const product = nums.reduce((a, b) => a * b, 1)

  const numsStr = nums.join(", ")

  return {
    prompt: `You MUST write a Python script called compute.py that computes the product of these numbers: ${numsStr}. Execute the script and write just the result (a single number) to result.txt.

You MUST create the compute.py script file. Do NOT compute this mentally. All files should be in the current directory.`,
    eval: pyEval({
      imports: ["os"],
      body: `
# Check compute.py exists and is non-trivial
if not os.path.exists('compute.py'):
    cp.append({"name": "script_exists", "score": 0.0, "reason": "compute.py not found"})
else:
    content = open('compute.py').read().strip()
    ok = len(content) >= 10
    cp.append({"name": "script_exists", "score": 1.0 if ok else 0.0,
      "reason": None if ok else "compute.py seems too short to be a real script"})

# Check result
try:
    result = open('result.txt').read().strip()
    expected = '${product}'
    ok = result == expected
    cp.append({"name": "result_correct", "score": 1.0 if ok else 0.0,
      "reason": None if ok else f"expected ${product}, got {result}"})
except FileNotFoundError:
    cp.append({"name": "result_correct", "score": 0.0, "reason": "result.txt not found"})`,
    }),
  }
}

/**
 * L2: Read orders.csv, compute AGG using a script.
 */
function generateL2(rng: Rng): MicrobenchmarkInstance {
  const agg = rng.randChoice(["sum", "average", "max"] as const)
  const N = rng.randInt(5, 12)
  const rows: string[] = ["item,quantity,price"]
  const items = ["Widget", "Gadget", "Gizmo", "Doohickey", "Thingamajig"]
  const totals: number[] = []

  for (let i = 0; i < N; i++) {
    const item = rng.randChoice(items)
    const qty = rng.randInt(1, 10)
    const price = rng.randInt(5, 50)
    rows.push(`${item},${qty},${price}`)
    totals.push(qty * price)
  }

  let expected: number
  switch (agg) {
    case "sum":
      expected = totals.reduce((a, b) => a + b, 0)
      break
    case "average":
      expected = Math.round((totals.reduce((a, b) => a + b, 0) / totals.length) * 100) / 100
      break
    case "max":
      expected = Math.max(...totals)
      break
  }

  const expectedStr = Number.isInteger(expected) ? String(expected) : expected.toFixed(2)

  return {
    prompt: `Read orders.csv (columns: item, quantity, price). For each row compute the line total (quantity * price). Then compute the ${agg} of all line totals.

You MUST write a script (Python) to do this computation. Save the script as compute.py, execute it, and write just the result to result.txt.

Do NOT compute this in your head. You MUST use a script. All files should be in the current directory.`,
    setupFiles: {
      "orders.csv": rows.join("\n"),
    },
    eval: pyEval({
      imports: ["os"],
      body: `
# Check compute.py exists
exists = os.path.exists('compute.py')
cp.append({"name": "script_exists", "score": 1.0 if exists else 0.0,
  "reason": None if exists else "compute.py not found"})

# Check result
try:
    result = open('result.txt').read().strip()
    expected = float('${expectedStr}')
    actual = float(result)
    ok = abs(actual - expected) <= 0.02
    cp.append({"name": "result_correct", "score": 1.0 if ok else 0.0,
      "reason": None if ok else f"expected ${expectedStr}, got {result}"})
except FileNotFoundError:
    cp.append({"name": "result_correct", "score": 0.0, "reason": "result.txt not found"})
except ValueError:
    cp.append({"name": "result_correct", "score": 0.0, "reason": f"result is not a number: {result}"})`,
    }),
  }
}

/**
 * L3: Compute EXPR that looks simple but has floating-point subtlety. MUST use script.
 */
function generateL3(rng: Rng): MicrobenchmarkInstance {
  // Always use a floating-point-subtlety expression for reliability, but
  // randomize the wrapper
  const wrappers = [
    { expr: "0.1 + 0.2", expected: "0.3" },
    { expr: "0.1 + 0.2 - 0.3", expected: "0.0" },
    { expr: "1.0 - 0.9 - 0.1", expected: "0.0" },
  ]

  const w = rng.randChoice(wrappers)

  return {
    prompt: `Compute the result of: ${w.expr}

The answer should be mathematically exact (not a floating-point approximation). You MUST write a Python script called compute.py that uses the \`decimal\` module (or similar) for exact arithmetic. Execute it and write just the result to result.txt.

Do NOT compute this in your head. You MUST create and execute a script. All files should be in the current directory.`,
    eval: pyEval({
      imports: ["os"],
      body: `
# Check compute.py exists
if not os.path.exists('compute.py'):
    cp.append({"name": "script_exists", "score": 0.0, "reason": "compute.py not found"})
    cp.append({"name": "correct_module", "score": 0.0, "reason": "compute.py not found"})
else:
    cp.append({"name": "script_exists", "score": 1.0, "reason": None})
    content = open('compute.py').read()
    uses_exact = 'decimal' in content.lower() or 'Decimal' in content or 'fractions' in content.lower()
    cp.append({"name": "correct_module", "score": 1.0 if uses_exact else 0.0,
      "reason": None if uses_exact else "compute.py should use decimal or fractions module"})

# Check result
try:
    result = open('result.txt').read().strip()
    expected = float('${w.expected}')
    actual = float(result)
    ok = abs(actual - expected) <= 1e-9
    cp.append({"name": "result_correct", "score": 1.0 if ok else 0.0,
      "reason": None if ok else f"expected ${w.expected}, got {result}"})
except FileNotFoundError:
    cp.append({"name": "result_correct", "score": 0.0, "reason": "result.txt not found"})
except ValueError as e:
    cp.append({"name": "result_correct", "score": 0.0, "reason": f"result is not a number: {e}"})`,
    }),
  }
}

export default defineGenerator({
  primitiveId: "follow.delegation",
  descriptions: {
    L1: "Write and execute a Python script to compute the product of a list of numbers instead of computing it mentally",
    L2: "Write and execute a Python script to read CSV data, compute line totals, and aggregate them instead of computing mentally",
    L3: "Write and execute a Python script using the decimal module for exact arithmetic on a floating-point expression instead of computing mentally",
  },
  levels: { L1: generateL1, L2: generateL2, L3: generateL3 },
})
