#!/usr/bin/env bun
/**
 * Live integration test: verify skill injection affects agent behavior.
 *
 * Uses the document-pdf skill from skill-bench with a simplified PDF creation task.
 * Runs the same task WITH and WITHOUT the skill to compare results.
 *
 * Usage: bun run test/integration/live-skill-injection.ts
 * Requires: OPENROUTER_API_KEY, python3 with pypdf + reportlab
 */

import "../../src/core/env-bootstrap.ts"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { BareAgentAdapter } from "../../src/adapters/bare-agent.ts"
import { OpenRouterProvider } from "../../src/providers/openrouter.ts"
import { runTask } from "../../src/framework/runner.ts"
import type { Task, AdapterConfig } from "../../src/core/types.ts"
import { setLogLevel } from "../../src/core/logger.ts"

setLogLevel("info")

const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) {
  console.error("OPENROUTER_API_KEY not set")
  process.exit(1)
}

const MODEL = "qwen/qwen3-30b-a3b-instruct-2507"
const SKILL_BENCH_ROOT = path.resolve(import.meta.dirname, "../../../skill-bench")
const SKILL_PATH = path.join(SKILL_BENCH_ROOT, "skills/document-pdf/SKILL.md")

// ---------------------------------------------------------------------------
// Load skill
// ---------------------------------------------------------------------------

let skillContent: string
try {
  skillContent = await readFile(SKILL_PATH, "utf-8")
  console.log(`Loaded skill: ${SKILL_PATH} (${skillContent.length} chars)`)
} catch {
  console.error(`Could not load skill from ${SKILL_PATH}`)
  console.error("Make sure skill-bench is at ~/Projects/skill-bench/")
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Task: Create a simple PDF from data
// ---------------------------------------------------------------------------

const EMPLOYEES_JSON = JSON.stringify([
  { name: "Alice Chen", department: "Engineering", salary: 95000 },
  { name: "Bob Martinez", department: "Engineering", salary: 105000 },
  { name: "Carol Singh", department: "Marketing", salary: 88000 },
  { name: "David Kim", department: "Sales", salary: 72000 },
], null, 2)

const task: Task = {
  id: "pdf-create-simple",
  name: "Create a PDF report from employee data",
  prompt: `Read employees.json which contains 4 employees (name, department, salary).
Create a PDF file called report.pdf that contains:
1. A title "Employee Report"
2. A table listing all employees with their name, department, and salary
3. The total headcount: 4

Use Python to create the PDF.`,
  fixtures: {
    "employees.json": EMPLOYEES_JSON,
  },
  eval: [
    {
      method: "script",
      command: `python3 << 'PYEOF'
import os
if not os.path.exists('report.pdf'):
    print('report.pdf not found'); exit(1)
size = os.path.getsize('report.pdf')
if size < 100:
    print('report.pdf too small: %d bytes' % size); exit(1)

# Verify it's a valid PDF
from pypdf import PdfReader
try:
    reader = PdfReader('report.pdf')
    pages = len(reader.pages)
    if pages < 1:
        print('PDF has no pages'); exit(1)
    text = ''
    for page in reader.pages:
        text += page.extract_text() or ''
    # Check key content
    checks = []
    if 'Alice' in text: checks.append('Alice')
    if 'Bob' in text or 'Martinez' in text: checks.append('Bob')
    if 'Engineering' in text: checks.append('Engineering')
    if '4' in text: checks.append('headcount')
    print('ok (pages=%d, found=%s)' % (pages, ','.join(checks)))
except Exception as e:
    print('PDF parse error: %s' % e); exit(1)
PYEOF`,
      expectedExitCode: 0,
      expectedOutput: undefined, // don't check output content, just exit code
    },
    {
      method: "script",
      command: `python3 << 'PYEOF'
from pypdf import PdfReader
reader = PdfReader('report.pdf')
text = ''
for page in reader.pages:
    text += page.extract_text() or ''
found = 0
for name in ['Alice', 'Bob', 'Carol', 'David']:
    if name in text: found += 1
if found >= 3: print('ok')
else: print('only %d/4 names found' % found); exit(1)
PYEOF`,
      expectedExitCode: 0,
      expectedOutput: "ok",
    },
  ],
  timeoutMs: 120_000,
  maxSteps: 15,
}

// ---------------------------------------------------------------------------
// Run: WITHOUT skill, then WITH skill
// ---------------------------------------------------------------------------

const adapterConfig: AdapterConfig = {
  model: MODEL,
  apiKey,
  maxSteps: 15,
  timeoutMs: 120_000,
}

function createAdapter() {
  return new BareAgentAdapter((config) =>
    new OpenRouterProvider({ apiKey: config.apiKey, model: config.model })
  )
}

console.log(`\n${"=".repeat(60)}`)
console.log(`Model: ${MODEL}`)
console.log(`Task: ${task.id}`)
console.log(`${"=".repeat(60)}`)

// Run WITHOUT skill
console.log(`\n--- Run 1: WITHOUT skill ---`)
const resultNoSkill = await runTask({
  task,
  adapter: createAdapter(),
  adapterConfig,
})

console.log(`  Result: ${resultNoSkill.overallPass ? "PASS" : "FAIL"} (score=${resultNoSkill.overallScore.toFixed(2)})`)
console.log(`  Steps: ${resultNoSkill.runResult.steps.length}`)
console.log(`  Tokens: in=${resultNoSkill.runResult.tokens.input} out=${resultNoSkill.runResult.tokens.output}`)
console.log(`  Duration: ${(resultNoSkill.runResult.durationMs / 1000).toFixed(1)}s`)
for (const e of resultNoSkill.evalResults) {
  const method = e.criterion.method
  console.log(`  [${method}] ${e.pass ? "PASS" : "FAIL"}: ${e.details.slice(0, 120)}`)
}

// Show what tools were used
const toolsUsedNoSkill = new Set<string>()
for (const step of resultNoSkill.runResult.steps) {
  for (const tc of step.toolCalls) {
    toolsUsedNoSkill.add(tc.name)
  }
}
console.log(`  Tools used: ${[...toolsUsedNoSkill].join(", ")}`)

// Run WITH skill
console.log(`\n--- Run 2: WITH document-pdf skill ---`)
const resultWithSkill = await runTask({
  task,
  adapter: createAdapter(),
  adapterConfig,
  skill: { content: skillContent, meta: { name: "document-pdf", description: "" }, mode: "inject" },
})

console.log(`  Result: ${resultWithSkill.overallPass ? "PASS" : "FAIL"} (score=${resultWithSkill.overallScore.toFixed(2)})`)
console.log(`  Steps: ${resultWithSkill.runResult.steps.length}`)
console.log(`  Tokens: in=${resultWithSkill.runResult.tokens.input} out=${resultWithSkill.runResult.tokens.output}`)
console.log(`  Duration: ${(resultWithSkill.runResult.durationMs / 1000).toFixed(1)}s`)
for (const e of resultWithSkill.evalResults) {
  const method = e.criterion.method
  console.log(`  [${method}] ${e.pass ? "PASS" : "FAIL"}: ${e.details.slice(0, 120)}`)
}

const toolsUsedWithSkill = new Set<string>()
for (const step of resultWithSkill.runResult.steps) {
  for (const tc of step.toolCalls) {
    toolsUsedWithSkill.add(tc.name)
  }
}
console.log(`  Tools used: ${[...toolsUsedWithSkill].join(", ")}`)

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(60)}`)
console.log(`COMPARISON:`)
console.log(`  Without skill: ${resultNoSkill.overallPass ? "PASS" : "FAIL"} (score=${resultNoSkill.overallScore.toFixed(2)}, ${(resultNoSkill.runResult.durationMs / 1000).toFixed(1)}s)`)
console.log(`  With skill:    ${resultWithSkill.overallPass ? "PASS" : "FAIL"} (score=${resultWithSkill.overallScore.toFixed(2)}, ${(resultWithSkill.runResult.durationMs / 1000).toFixed(1)}s)`)
console.log(`${"=".repeat(60)}`)
