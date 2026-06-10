import type { MicrobenchmarkInstance } from "../types.ts"
import { defineGenerator, pyEval, pyRunSolution, PY_EMIT_CHECKPOINTS, requirePyModule, type Rng } from "../generator-toolkit.ts"

const NAMES = ["Alice", "Bob", "Carol", "Dave", "Eve", "Frank", "Grace", "Hank"]
const DEPTS = ["Engineering", "Marketing", "Sales", "HR"]
const REGIONS = ["North", "South", "East", "West"]
const CATEGORIES = ["Electronics", "Clothing", "Food", "Books"]
const QUARTERS = ["Q1", "Q2", "Q3", "Q4"]

/**
 * Python fragment shared by all levels: verify solution.py exists and run it,
 * early-exiting with a failed checkpoint on either problem.
 */
const PY_RUN_SOLUTION = pyRunSolution("solution.py", ["python3", "solution.py"])

/**
 * L1: Basic syntax, file I/O
 * Write a Python script that reads input.txt (lines in "name:number" format),
 * counts lines with number >= T, and prints the count.
 */
function generateL1(rng: Rng): MicrobenchmarkInstance {
  const T = rng.randInt(25, 74)
  const N = rng.randInt(5, 24)

  const lines: string[] = []
  let expectedCount = 0
  for (let i = 0; i < N; i++) {
    const name = rng.randChoice(NAMES)
    const value = rng.randInt(0, 99)
    lines.push(`${name}:${value}`)
    if (value >= T) expectedCount++
  }

  return {
    prompt: `The file input.txt already exists in the current directory (each line is in "name:number" format). Write a Python script that reads input.txt, counts the lines where the number is >= ${T}, and writes just the count (as an integer, nothing else) to result.txt. Do not create or overwrite input.txt. Save the script as solution.py and execute it with python3 solution.py.`,
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
 * L2: Standard library (csv, json, re)
 * Write a Python script that reads data.csv (name, score, department),
 * computes average score, and writes result.json with average_score and total_employees.
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
  // Round to match Python's default json.dump precision
  const expectedAvg = Math.round(avgScore * 100) / 100

  return {
    prompt: `The file data.csv already exists in the current directory (columns: name, score, department). Write a Python script that reads data.csv, computes the average score across all employees, and writes a JSON file result.json with two fields: "average_score" (rounded to 2 decimal places) and "total_employees" (integer count). Do not create or overwrite data.csv. Save the script as solution.py and execute it with python3 solution.py.`,
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
 * L3: Third-party libraries — randomly picks one of three variants.
 */
function generateL3(rng: Rng): MicrobenchmarkInstance {
  return rng.randChoice([generateL3Pandas, generateL3Numpy, generateL3Openpyxl])(rng)
}

/**
 * L3a: pandas — group by column, aggregate, write sorted CSV.
 */
function generateL3Pandas(rng: Rng): MicrobenchmarkInstance {
  const COL = rng.randChoice(["region", "category", "quarter"] as const)
  const AGG = rng.randChoice(["sum", "mean", "count"] as const)
  const N = rng.randInt(50, 200)

  const colValues: Record<string, string[]> = {
    region: REGIONS,
    category: CATEGORIES,
    quarter: QUARTERS,
  }

  const values = colValues[COL]!
  const rows: string[] = [`${COL},amount`]
  const groupTotals: Record<string, number[]> = {}

  for (let i = 0; i < N; i++) {
    const group = rng.randChoice(values)
    const amount = rng.randInt(10, 1000)
    rows.push(`${group},${amount}`)
    if (!groupTotals[group]) groupTotals[group] = []
    groupTotals[group]!.push(amount)
  }

  const expected: { group: string; value: number }[] = []
  for (const [group, amounts] of Object.entries(groupTotals)) {
    let val: number
    switch (AGG) {
      case "sum":
        val = amounts.reduce((a, b) => a + b, 0)
        break
      case "mean":
        val = amounts.reduce((a, b) => a + b, 0) / amounts.length
        break
      case "count":
        val = amounts.length
        break
    }
    expected.push({ group, value: Math.round(val * 100) / 100 })
  }
  expected.sort((a, b) => a.group.localeCompare(b.group))

  return {
    prompt: `The file sales.csv already exists in the current directory (columns: ${COL}, amount). Write a Python script using pandas that reads sales.csv, groups rows by "${COL}", computes the ${AGG} of "amount" per group, sorts the result alphabetically by "${COL}", and writes the output to result.csv with columns "${COL}" and "${AGG}_amount". Do not include the index in the CSV output. Do not create or overwrite sales.csv. Save the script as solution.py and execute it with python3 solution.py.`,
    setupFiles: {
      "sales.csv": rows.join("\n"),
    },
    eval: pyEval({
      preamble: requirePyModule("pandas", "gen.code.python L3"),
      imports: ["subprocess", "os", "csv"],
      body: `${PY_RUN_SOLUTION}

# Check result file exists
if not os.path.exists('result.csv'):
    cp.append({"name": "output_format", "score": 0.0, "reason": "result.csv not found"})
    ${PY_EMIT_CHECKPOINTS}
    raise SystemExit(0)

try:
    rows = list(csv.DictReader(open('result.csv')))
    cp.append({"name": "output_format", "score": 1.0, "reason": None})
except Exception as e:
    cp.append({"name": "output_format", "score": 0.0, "reason": f"invalid CSV: {e}"})
    ${PY_EMIT_CHECKPOINTS}
    raise SystemExit(0)

expected = ${JSON.stringify(expected)}

# Check row count
if len(rows) == len(expected):
    cp.append({"name": "row_count", "score": 1.0, "reason": None})
else:
    cp.append({"name": "row_count", "score": 0.0, "reason": f"expected {len(expected)} rows, got {len(rows)}"})
    ${PY_EMIT_CHECKPOINTS}
    raise SystemExit(0)

# Check each group value
for i, (r, e) in enumerate(zip(rows, expected)):
    group_key = '${COL}'
    val_key = [k for k in r if k != group_key][0]
    group_ok = r[group_key] == e['group']
    actual = round(float(r[val_key]), 1)
    expected_val = round(e['value'], 1)
    value_ok = actual == expected_val
    if group_ok and value_ok:
        cp.append({"name": f"group_{i}_correct", "score": 1.0, "reason": None})
    else:
        reasons = []
        if not group_ok:
            reasons.append(f"group: expected {e['group']}, got {r[group_key]}")
        if not value_ok:
            reasons.append(f"value: expected {expected_val}, got {actual}")
        cp.append({"name": f"group_{i}_correct", "score": 0.0, "reason": "; ".join(reasons)})`,
    }),
  }
}

/**
 * L3b: numpy — compute per-column statistics on numeric data, write JSON.
 */
function generateL3Numpy(rng: Rng): MicrobenchmarkInstance {
  const COLS = rng.randChoice([
    ["temperature", "humidity", "pressure"],
    ["height", "weight", "age"],
    ["latency", "throughput", "error_rate"],
  ] as const)
  const N = rng.randInt(30, 100)

  const header = COLS.join(",")
  const dataRows: number[][] = []
  for (let i = 0; i < N; i++) {
    const row = COLS.map(() => Math.round((rng.random() * 200 - 50) * 100) / 100)
    dataRows.push(row)
  }

  const csvRows = [header, ...dataRows.map((r) => r.join(","))]

  // Compute expected statistics per column
  const expected: Record<string, { mean: number; std: number; min: number; max: number }> = {}
  for (let c = 0; c < COLS.length; c++) {
    const vals = dataRows.map((r) => r[c]!)
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length
    const variance = vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length
    const std = Math.sqrt(variance)
    expected[COLS[c]!] = {
      mean: Math.round(mean * 1000) / 1000,
      std: Math.round(std * 1000) / 1000,
      min: Math.min(...vals),
      max: Math.max(...vals),
    }
  }

  return {
    prompt: `The file measurements.csv already exists in the current directory (columns: ${COLS.join(", ")}). Write a Python script using numpy that reads measurements.csv. For each column, compute the mean, standard deviation (population, not sample), min, and max. Write the results to result.json as a dict mapping column name to {"mean": ..., "std": ..., "min": ..., "max": ...}, with all values rounded to 3 decimal places. Do not create or overwrite measurements.csv. Save the script as solution.py and execute it with python3 solution.py.`,
    setupFiles: {
      "measurements.csv": csvRows.join("\n"),
    },
    eval: pyEval({
      preamble: requirePyModule("numpy", "gen.code.python L3"),
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

expected = json.loads('${JSON.stringify(expected)}')

# Check each column's statistics
for col in expected:
    if col not in result:
        cp.append({"name": f"col_{col}_present", "score": 0.0, "reason": f"missing column: {col}"})
        continue
    cp.append({"name": f"col_{col}_present", "score": 1.0, "reason": None})
    all_stats_ok = True
    stat_errors = []
    for stat in ['mean', 'std', 'min', 'max']:
        try:
            actual = round(float(result[col][stat]), 2)
            exp = round(float(expected[col][stat]), 2)
            if abs(actual - exp) >= 0.1:
                all_stats_ok = False
                stat_errors.append(f"{stat}: expected {exp}, got {actual}")
        except (KeyError, TypeError, ValueError) as e:
            all_stats_ok = False
            stat_errors.append(f"{stat}: {e}")
    if all_stats_ok:
        cp.append({"name": f"col_{col}_values", "score": 1.0, "reason": None})
    else:
        cp.append({"name": f"col_{col}_values", "score": 0.0, "reason": "; ".join(stat_errors)})`,
    }),
  }
}

/**
 * L3c: openpyxl — read CSV, write Excel with headers and a summary total row.
 */
function generateL3Openpyxl(rng: Rng): MicrobenchmarkInstance {
  const N = rng.randInt(5, 15)
  const rows: { name: string; department: string; salary: number }[] = []

  for (let i = 0; i < N; i++) {
    rows.push({
      name: rng.randChoice(NAMES) + i,
      department: rng.randChoice(DEPTS),
      salary: rng.randInt(3, 12) * 10000,
    })
  }

  const totalSalary = rows.reduce((s, r) => s + r.salary, 0)
  const csvRows = ["name,department,salary", ...rows.map((r) => `${r.name},${r.department},${r.salary}`)]

  return {
    prompt: `The file employees.csv already exists in the current directory (columns: name, department, salary). Write a Python script using openpyxl that reads employees.csv and creates an Excel file result.xlsx. The worksheet should have headers in row 1 ("name", "department", "salary"), the data rows starting from row 2, and a summary row at the end with "Total" in the name column and the sum of all salaries in the salary column. Do not create or overwrite employees.csv. Save the script as solution.py and execute it with python3 solution.py.`,
    setupFiles: {
      "employees.csv": csvRows.join("\n"),
    },
    eval: pyEval({
      preamble: requirePyModule("openpyxl", "gen.code.python L3"),
      imports: ["subprocess", "os"],
      body: `${PY_RUN_SOLUTION}

# Check result file exists
if not os.path.exists('result.xlsx'):
    cp.append({"name": "output_format", "score": 0.0, "reason": "result.xlsx not found"})
    ${PY_EMIT_CHECKPOINTS}
    raise SystemExit(0)

try:
    from openpyxl import load_workbook
    wb = load_workbook('result.xlsx')
    ws = wb.active
    cp.append({"name": "output_format", "score": 1.0, "reason": None})
except Exception as e:
    cp.append({"name": "output_format", "score": 0.0, "reason": f"cannot read xlsx: {e}"})
    ${PY_EMIT_CHECKPOINTS}
    raise SystemExit(0)

# Check headers
header_ok = True
header_errors = []
if ws.cell(1, 1).value != 'name':
    header_ok = False
    header_errors.append(f'A1: expected "name", got {ws.cell(1, 1).value}')
if ws.cell(1, 3).value != 'salary':
    header_ok = False
    header_errors.append(f'C1: expected "salary", got {ws.cell(1, 3).value}')
if header_ok:
    cp.append({"name": "headers_correct", "score": 1.0, "reason": None})
else:
    cp.append({"name": "headers_correct", "score": 0.0, "reason": "; ".join(header_errors)})

# Check summary row label
expected_rows = ${N}
total_row = expected_rows + 2
label = ws.cell(total_row, 1).value
if label == 'Total':
    cp.append({"name": "summary_label", "score": 1.0, "reason": None})
else:
    cp.append({"name": "summary_label", "score": 0.0, "reason": f'expected "Total", got {label}'})

# Check total salary value
total_salary = ws.cell(total_row, 3).value
try:
    if int(total_salary) == ${totalSalary}:
        cp.append({"name": "value_correct", "score": 1.0, "reason": None})
    else:
        cp.append({"name": "value_correct", "score": 0.0, "reason": f"expected ${totalSalary}, got {total_salary}"})
except (TypeError, ValueError):
    cp.append({"name": "value_correct", "score": 0.0, "reason": f"not a number: {total_salary}"})`,
    }),
  }
}

export default defineGenerator({
  primitiveId: "gen.code.python",
  descriptions: {
    L1: "Write a Python script using basic syntax and file I/O to read a text file, filter lines matching a numeric condition, and write the count",
    L2: "Write a Python script using standard library modules (csv, json) to read structured CSV data, compute an aggregation, and write JSON output",
    L3: "Write a Python script using third-party libraries (pandas/numpy/openpyxl) to process data and produce structured output",
  },
  levels: { L1: generateL1, L2: generateL2, L3: generateL3 },
})
