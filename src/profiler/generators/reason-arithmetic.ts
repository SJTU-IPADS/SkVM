import type { MicrobenchmarkInstance } from "../types.ts"
import { defineGenerator, pyEval, type Rng } from "../generator-toolkit.ts"

/**
 * L1: Single-step operations
 * The profiler writes LLM response to response.txt before running eval.
 */
function generateL1(rng: Rng): MicrobenchmarkInstance {
  const ops = [
    { sym: "+", fn: (a: number, b: number) => a + b },
    { sym: "-", fn: (a: number, b: number) => a - b },
    { sym: "*", fn: (a: number, b: number) => a * b },
    { sym: "% of", fn: (a: number, b: number) => (a / 100) * b },
  ]

  const op = rng.randChoice(ops)
  const A = rng.randInt(10, 9999)
  const B = rng.randInt(10, 999)
  const result = op.fn(A, B)
  const expected = Number.isInteger(result) ? String(result) : result.toFixed(2)

  const prompt = op.sym === "% of"
    ? `What is ${A}% of ${B}? Answer with just the number, nothing else.`
    : `What is ${A} ${op.sym} ${B}? Answer with just the number, nothing else.`

  return {
    prompt,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read().strip().replace(',', '')
nums = re.findall(r'-?[\\d]+\\.?\\d*', text)
cp.append({"name": "number_found", "score": 1.0 if nums else 0.0,
  "reason": None if nums else "no number found in response"})
if nums:
    actual = float(nums[-1])
    expected = float('${expected}')
    tol = max(0.01, abs(expected) * 0.001)
    ok = abs(actual - expected) <= tol
    cp.append({"name": "value_correct", "score": 1.0 if ok else 0.0,
      "reason": None if ok else f"expected ${expected}, got {actual}"})`,
    }),
  }
}

/**
 * L2: Multi-step (discount + tax)
 */
function generateL2(rng: Rng): MicrobenchmarkInstance {
  const P = rng.randInt(50, 249)
  const Q = rng.randInt(2, 6)
  const D = rng.randChoice([5, 10, 15, 20])
  const X = rng.randChoice([8, 10])

  const subtotal = P * Q
  const afterDiscount = subtotal * (1 - D / 100)
  const total = afterDiscount * (1 + X / 100)
  const expected = (Math.round(total * 100) / 100).toFixed(2)

  return {
    prompt: `A store sells an item for $${P}. A customer buys ${Q} items, gets a ${D}% discount on the total, then pays ${X}% sales tax on the discounted price. What is the final total? Answer with just the dollar amount (number with 2 decimal places), nothing else.`,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read().strip().replace(',', '')
nums = re.findall(r'[\\d]+\\.\\d{2}', text)
if not nums:
    nums = re.findall(r'[\\d]+\\.?\\d*', text)
cp.append({"name": "number_found", "score": 1.0 if nums else 0.0,
  "reason": None if nums else "no number found in response"})
if nums:
    actual = float(nums[-1])
    expected = float('${expected}')
    ok = abs(actual - expected) < 0.02
    cp.append({"name": "value_correct", "score": 1.0 if ok else 0.0,
      "reason": None if ok else f"expected ${expected}, got {actual}"})`,
    }),
  }
}

/**
 * L3: Compound interest + effective annual rate
 */
function generateL3(rng: Rng): MicrobenchmarkInstance {
  const P = rng.randInt(1000, 50000)
  const R = rng.randInt(3, 12)
  const F = rng.randChoice(["monthly", "quarterly", "annually"] as const)
  const Y = rng.randInt(2, 10)

  const periodsPerYear: Record<string, number> = { monthly: 12, quarterly: 4, annually: 1 }
  const n = periodsPerYear[F]!
  const r = R / 100

  const total = P * Math.pow(1 + r / n, n * Y)
  const expectedTotal = (Math.round(total * 100) / 100).toFixed(2)

  const ear = (Math.pow(1 + r / n, n) - 1) * 100
  const expectedEAR = (Math.round(ear * 100) / 100).toFixed(2)

  return {
    prompt: `An investment of $${P} earns ${R}% annual interest compounded ${F}. After ${Y} years:
1. What is the total value?
2. What is the effective annual rate (as a percentage)?

Answer with two numbers on separate lines:
Line 1: total value (2 decimal places)
Line 2: effective annual rate percentage (2 decimal places)
Nothing else.`,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read().strip().replace(',', '')
nums = re.findall(r'[\\d]+\\.\\d+', text)
if len(nums) < 2:
    nums = re.findall(r'[\\d]+\\.?\\d*', text)
cp.append({"name": "numbers_found", "score": 1.0 if len(nums) >= 2 else 0.0,
  "reason": None if len(nums) >= 2 else f"need 2 numbers, found {len(nums)}"})
if len(nums) >= 2:
    total = float(nums[0])
    ear = float(nums[1])
    exp_t = float('${expectedTotal}')
    exp_e = float('${expectedEAR}')
    t_ok = abs(total - exp_t) / exp_t < 0.002
    e_ok = abs(ear - exp_e) < 0.05
    cp.append({"name": "total_correct", "score": 1.0 if t_ok else 0.0,
      "reason": None if t_ok else f"expected {exp_t}, got {total}"})
    cp.append({"name": "ear_correct", "score": 1.0 if e_ok else 0.0,
      "reason": None if e_ok else f"expected {exp_e}%, got {ear}%"})`,
    }),
  }
}

export default defineGenerator({
  primitiveId: "reason.arithmetic",
  descriptions: {
    L1: "Compute a single arithmetic operation (addition, subtraction, multiplication, or percentage)",
    L2: "Compute a multi-step word problem involving discount and sales tax on a purchase",
    L3: "Compute compound interest total value and effective annual rate given principal, rate, compounding frequency, and duration",
  },
  levels: { L1: generateL1, L2: generateL2, L3: generateL3 },
})
