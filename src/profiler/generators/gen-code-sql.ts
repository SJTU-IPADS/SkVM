import type { MicrobenchmarkInstance } from "../types.ts"
import { defineGenerator, pyEval, PY_EMIT_CHECKPOINTS, type Rng } from "../generator-toolkit.ts"

const NAMES = ["Alice", "Bob", "Carol", "Dave", "Eve", "Frank", "Grace", "Hank",
  "Ivy", "Jack", "Kim", "Leo", "Mia", "Nora", "Oscar", "Pat"]
const DEPTS = ["Engineering", "Marketing", "Sales", "HR", "Finance", "Operations"]

/**
 * L1: Write SQL query counting rows in "users" where score >= T.
 * Setup: setup.sql. Eval: execute via sqlite3, exact count.
 */
function generateL1(rng: Rng): MicrobenchmarkInstance {
  const T = rng.randInt(30, 70)
  const N = rng.randInt(10, 25)

  const inserts: string[] = []
  let expectedCount = 0
  for (let i = 0; i < N; i++) {
    const name = rng.randChoice(NAMES) + i
    const score = rng.randInt(0, 100)
    inserts.push(`INSERT INTO users (name, score) VALUES ('${name}', ${score});`)
    if (score >= T) expectedCount++
  }

  const setupSql = `CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, score INTEGER);
${inserts.join("\n")}`

  return {
    prompt: `Write a SQL query that counts the number of rows in the "users" table where score >= ${T}. The query should return a single integer count. Save ONLY the SQL query to a file called query.sql in the current directory.`,
    setupFiles: {
      "setup.sql": setupSql,
    },
    eval: pyEval({
      imports: ["subprocess", "os"],
      body: `
# Check query file was created
if os.path.exists('query.sql'):
    cp.append({"name": "query_created", "score": 1.0, "reason": None})
else:
    cp.append({"name": "query_created", "score": 0.0, "reason": "query.sql not found"})
    ${PY_EMIT_CHECKPOINTS}
    raise SystemExit(0)

# Setup database
subprocess.run(['sqlite3', 'test.db'], input=open('setup.sql').read(), capture_output=True, text=True)

# Execute query
proc = subprocess.run(['sqlite3', 'test.db'], input=open('query.sql').read(), capture_output=True, text=True)
if proc.returncode == 0:
    cp.append({"name": "query_valid", "score": 1.0, "reason": None})
else:
    cp.append({"name": "query_valid", "score": 0.0, "reason": f"SQL error: {proc.stderr[:200]}"})
    ${PY_EMIT_CHECKPOINTS}
    raise SystemExit(0)

# Check result correctness
text = proc.stdout.strip()
try:
    actual = int(text)
    if actual == ${expectedCount}:
        cp.append({"name": "result_correct", "score": 1.0, "reason": None})
    else:
        cp.append({"name": "result_correct", "score": 0.0, "reason": f"expected ${expectedCount}, got {actual}"})
except ValueError:
    cp.append({"name": "result_correct", "score": 0.0, "reason": f"not an integer: {text[:100]}"})`,
    }),
  }
}

/**
 * L2: Write SQL query using JOIN to find department with most employees.
 * Setup: setup.sql. Eval: compare department name.
 */
function generateL2(rng: Rng): MicrobenchmarkInstance {
  const N = rng.randInt(12, 30)
  const deptCount: Record<string, number> = {}

  const empInserts: string[] = []
  for (let i = 0; i < N; i++) {
    const name = rng.randChoice(NAMES) + i
    const dept = rng.randChoice(DEPTS)
    const salary = rng.randInt(40, 150) * 1000
    empInserts.push(
      `INSERT INTO employees (name, department_id, salary) VALUES ('${name}', (SELECT id FROM departments WHERE name = '${dept}'), ${salary});`
    )
    deptCount[dept] = (deptCount[dept] || 0) + 1
  }

  // Find department with most employees
  let maxDept = ""
  let maxCount = 0
  for (const [dept, count] of Object.entries(deptCount)) {
    if (count > maxCount) {
      maxCount = count
      maxDept = dept
    }
  }

  const deptInserts = DEPTS.map(
    (d) => `INSERT INTO departments (name) VALUES ('${d}');`
  ).join("\n")

  const setupSql = `CREATE TABLE departments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
CREATE TABLE employees (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, department_id INTEGER, salary INTEGER, FOREIGN KEY (department_id) REFERENCES departments(id));
${deptInserts}
${empInserts.join("\n")}`

  return {
    prompt: `Write a SQL query that uses a JOIN between "employees" and "departments" tables to find the department with the most employees. Return only the department name. Save ONLY the SQL query to a file called query.sql in the current directory.

Schema:
- departments(id INTEGER PRIMARY KEY, name TEXT)
- employees(id INTEGER PRIMARY KEY, name TEXT, department_id INTEGER, salary INTEGER)`,
    setupFiles: {
      "setup.sql": setupSql,
    },
    eval: pyEval({
      imports: ["subprocess", "os"],
      body: `
# Check query file was created
if os.path.exists('query.sql'):
    cp.append({"name": "query_created", "score": 1.0, "reason": None})
else:
    cp.append({"name": "query_created", "score": 0.0, "reason": "query.sql not found"})
    ${PY_EMIT_CHECKPOINTS}
    raise SystemExit(0)

# Setup database
subprocess.run(['sqlite3', 'test.db'], input=open('setup.sql').read(), capture_output=True, text=True)

# Execute query
proc = subprocess.run(['sqlite3', 'test.db'], input=open('query.sql').read(), capture_output=True, text=True)
if proc.returncode == 0:
    cp.append({"name": "query_valid", "score": 1.0, "reason": None})
else:
    cp.append({"name": "query_valid", "score": 0.0, "reason": f"SQL error: {proc.stderr[:200]}"})
    ${PY_EMIT_CHECKPOINTS}
    raise SystemExit(0)

# Check result correctness
text = proc.stdout.strip()
if text == '${maxDept}':
    cp.append({"name": "result_correct", "score": 1.0, "reason": None})
else:
    cp.append({"name": "result_correct", "score": 0.0, "reason": f"expected '${maxDept}', got '{text}'"})`,
    }),
  }
}

/**
 * L3: Using CTE and window functions, rank employees by salary within each department,
 * return top-K earners per department. Setup: setup.sql. Eval: compare ranked rows.
 */
function generateL3(rng: Rng): MicrobenchmarkInstance {
  const K = rng.randInt(1, 3)
  const N = rng.randInt(15, 35)

  const employees: Array<{ name: string; dept: string; salary: number }> = []
  for (let i = 0; i < N; i++) {
    const name = rng.randChoice(NAMES) + i
    const dept = rng.randChoice(DEPTS)
    const salary = rng.randInt(40, 200) * 1000
    employees.push({ name, dept, salary })
  }

  const deptInserts = DEPTS.map(
    (d) => `INSERT INTO departments (name) VALUES ('${d}');`
  ).join("\n")

  const empInserts = employees
    .map(
      (e) =>
        `INSERT INTO employees (name, department_id, salary) VALUES ('${e.name}', (SELECT id FROM departments WHERE name = '${e.dept}'), ${e.salary});`
    )
    .join("\n")

  const setupSql = `CREATE TABLE departments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
CREATE TABLE employees (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, department_id INTEGER, salary INTEGER, FOREIGN KEY (department_id) REFERENCES departments(id));
${deptInserts}
${empInserts}`

  // Compute expected results: top-K earners per department, sorted by dept then salary desc
  const byDept: Record<string, Array<{ name: string; salary: number }>> = {}
  for (const e of employees) {
    if (!byDept[e.dept]) byDept[e.dept] = []
    byDept[e.dept]!.push({ name: e.name, salary: e.salary })
  }

  const expectedRows: Array<{ dept: string; name: string; salary: number; rank: number }> = []
  for (const [dept, emps] of Object.entries(byDept)) {
    emps.sort((a, b) => b.salary - a.salary)
    const topK = emps.slice(0, K)
    topK.forEach((e, idx) => {
      expectedRows.push({ dept, name: e.name, salary: e.salary, rank: idx + 1 })
    })
  }
  expectedRows.sort((a, b) => a.dept.localeCompare(b.dept) || a.rank - b.rank)

  const expectedCount = expectedRows.length

  return {
    prompt: `Write a SQL query using a CTE (Common Table Expression) and window functions that ranks employees by salary within each department (highest salary = rank 1), then returns the top ${K} earner(s) per department. The result should include columns: department_name, employee_name, salary, and salary_rank. Order by department_name, then salary_rank. Save ONLY the SQL query to a file called query.sql in the current directory.

Schema:
- departments(id INTEGER PRIMARY KEY, name TEXT)
- employees(id INTEGER PRIMARY KEY, name TEXT, department_id INTEGER, salary INTEGER)`,
    setupFiles: {
      "setup.sql": setupSql,
    },
    eval: pyEval({
      imports: ["subprocess", "os"],
      body: `
# Check query file was created
if os.path.exists('query.sql'):
    cp.append({"name": "query_created", "score": 1.0, "reason": None})
else:
    cp.append({"name": "query_created", "score": 0.0, "reason": "query.sql not found"})
    ${PY_EMIT_CHECKPOINTS}
    raise SystemExit(0)

# Setup database
subprocess.run(['sqlite3', 'test.db'], input=open('setup.sql').read(), capture_output=True, text=True)

# Execute query
proc = subprocess.run(['sqlite3', '-separator', '|', 'test.db'], input=open('query.sql').read(), capture_output=True, text=True)
if proc.returncode == 0:
    cp.append({"name": "query_valid", "score": 1.0, "reason": None})
else:
    cp.append({"name": "query_valid", "score": 0.0, "reason": f"SQL error: {proc.stderr[:200]}"})
    ${PY_EMIT_CHECKPOINTS}
    raise SystemExit(0)

rows = proc.stdout.strip().splitlines()
rows = [r.strip() for r in rows if r.strip()]

# Check row count
if len(rows) == ${expectedCount}:
    cp.append({"name": "row_count", "score": 1.0, "reason": None})
else:
    cp.append({"name": "row_count", "score": 0.0, "reason": f"expected ${expectedCount} rows, got {len(rows)}"})
    ${PY_EMIT_CHECKPOINTS}
    raise SystemExit(0)

expected_depts = ${JSON.stringify(expectedRows.map((r) => r.dept))}
expected_salaries = ${JSON.stringify(expectedRows.map((r) => r.salary))}

# Check each row
for i, row in enumerate(rows):
    parts = row.split('|')
    if len(parts) < 3:
        cp.append({"name": f"row_{i}_correct", "score": 0.0, "reason": f"too few columns: {row}"})
        continue
    dept = parts[0]
    try:
        salary = int(parts[2])
    except ValueError:
        cp.append({"name": f"row_{i}_correct", "score": 0.0, "reason": f"salary not integer: {parts[2]}"})
        continue
    dept_ok = dept == expected_depts[i]
    salary_ok = salary == expected_salaries[i]
    if dept_ok and salary_ok:
        cp.append({"name": f"row_{i}_correct", "score": 1.0, "reason": None})
    else:
        reasons = []
        if not dept_ok:
            reasons.append(f"dept: expected {expected_depts[i]}, got {dept}")
        if not salary_ok:
            reasons.append(f"salary: expected {expected_salaries[i]}, got {salary}")
        cp.append({"name": f"row_{i}_correct", "score": 0.0, "reason": "; ".join(reasons)})`,
    }),
  }
}

export default defineGenerator({
  primitiveId: "gen.code.sql",
  descriptions: {
    L1: "Write a SQL query that counts rows in a single table matching a numeric condition",
    L2: "Write a SQL query using JOIN and GROUP BY to find the department with the most employees",
    L3: "Write a SQL query using a CTE and window functions to rank employees by salary within each department and return the top earners",
  },
  levels: { L1: generateL1, L2: generateL2, L3: generateL3 },
})
