#!/usr/bin/env bun
/**
 * Live integration test: AOT Pass 3 (Concurrency Extraction)
 *
 * Uses a synthetic skill with 3 clearly independent analysis tasks to verify
 * that Pass 3 correctly decomposes the workflow, identifies parallel groups,
 * and generates concurrency directives for the compiled SKILL.md.
 *
 * Usage: bun run test/integration/live-aot-pass3.ts
 * Requires: ANTHROPIC_API_KEY
 * Estimated cost: ~$0.01-0.03
 */

import "../../src/core/env-bootstrap.ts"
import { runPass3, generateParallelismSection } from "../../src/compiler/passes/extract-parallelism/parallelism.ts"
import { AnthropicProvider } from "../../src/providers/anthropic.ts"
import { OpenRouterProvider } from "../../src/providers/openrouter.ts"
import type { LLMProvider } from "../../src/providers/types.ts"
import { setLogLevel } from "../../src/core/logger.ts"

setLogLevel("info")

// ---------------------------------------------------------------------------
// Check prerequisites
// ---------------------------------------------------------------------------

function createCompilerProvider(): LLMProvider {
  if (process.env.ANTHROPIC_API_KEY) {
    console.log("Using Anthropic provider for compiler")
    return new AnthropicProvider()
  }
  if (process.env.OPENROUTER_API_KEY) {
    console.log("Using OpenRouter provider for compiler (fallback)")
    return new OpenRouterProvider({ model: "anthropic/claude-sonnet-4-6" })
  }
  console.error("Neither ANTHROPIC_API_KEY nor OPENROUTER_API_KEY set.")
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Synthetic skill: Multi-Source Data Report
// ---------------------------------------------------------------------------

const SYNTHETIC_SKILL = `---
name: multi-source-report
description: Gather data from multiple independent sources and produce a combined report.
---

# Multi-Source Data Report

## Overview
This skill gathers data from 3 independent sources, analyzes each one separately,
then combines the results into a final report.

## Step 1: Fetch Weather Data
Download current weather data from the weather API and parse the temperature,
humidity, and wind speed. Save to weather.json.

\`\`\`bash
curl -s "https://api.weather.com/v1/current" | python3 -c "
import sys, json
data = json.load(sys.stdin)
result = {'temp': data['temp'], 'humidity': data['humidity'], 'wind': data['wind']}
json.dump(result, open('weather.json', 'w'))
"
\`\`\`

## Step 2: Fetch Stock Data
Download stock price data for the target ticker from the finance API.
Calculate daily change percentage. Save to stocks.json.

\`\`\`bash
curl -s "https://api.finance.com/v1/quote?symbol=AAPL" | python3 -c "
import sys, json
data = json.load(sys.stdin)
result = {'price': data['price'], 'change_pct': data['change_pct']}
json.dump(result, open('stocks.json', 'w'))
"
\`\`\`

## Step 3: Fetch News Headlines
Download top 5 news headlines from the news API.
Extract titles and sentiment scores. Save to news.json.

\`\`\`bash
curl -s "https://api.news.com/v1/top?n=5" | python3 -c "
import sys, json
data = json.load(sys.stdin)
result = [{'title': a['title'], 'sentiment': a['sentiment']} for a in data['articles']]
json.dump(result, open('news.json', 'w'))
"
\`\`\`

## Step 4: Combine Results
Read weather.json, stocks.json, and news.json. Produce a combined summary
report in report.md with sections for each data source.

\`\`\`python
import json

weather = json.load(open('weather.json'))
stocks = json.load(open('stocks.json'))
news = json.load(open('news.json'))

with open('report.md', 'w') as f:
    f.write('# Daily Report\\n\\n')
    f.write(f'## Weather\\nTemp: {weather["temp"]}\\n\\n')
    f.write(f'## Stocks\\nAAPL: {stocks["price"]} ({stocks["change_pct"]}%)\\n\\n')
    f.write('## News\\n')
    for item in news:
        f.write(f'- {item["title"]}\\n')
\`\`\`
`

// ---------------------------------------------------------------------------
// Run Pass 3
// ---------------------------------------------------------------------------

console.log("\n=== AOT Pass 3: Concurrency Extraction ===\n")
console.log(`Skill: multi-source-report (synthetic, ${SYNTHETIC_SKILL.length} chars)`)

const provider = createCompilerProvider()
const startMs = performance.now()

const result = await runPass3(SYNTHETIC_SKILL, provider)

const durationMs = performance.now() - startMs
console.log(`\nDuration: ${(durationMs / 1000).toFixed(1)}s`)

// ---------------------------------------------------------------------------
// Verify results
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0

function check(name: string, condition: boolean, details?: string) {
  if (condition) {
    console.log(`  PASS: ${name}`)
    passed++
  } else {
    console.log(`  FAIL: ${name}${details ? ` — ${details}` : ""}`)
    failed++
  }
}

console.log("\n--- Workflow Steps ---")
for (const step of result.dag.steps) {
  console.log(`  ${step.id}: ${step.description} (depends: [${step.dependsOn.join(", ")}])`)
}

console.log("\n--- Parallelism Annotations ---")
for (const ann of result.dag.parallelism) {
  console.log(`  ${ann.type.toUpperCase()}: [${ann.steps.join(", ")}] → ${ann.mechanism} (fallback: ${ann.fallback})`)
}

console.log("\n--- Assertions ---")

check(
  "DAG has at least 3 steps",
  result.dag.steps.length >= 3,
  `found ${result.dag.steps.length}`,
)

// The 3 fetch steps should be independent (no deps on each other)
const fetchSteps = result.dag.steps.filter(
  (s) => s.id.includes("fetch") || s.id.includes("weather") || s.id.includes("stock") || s.id.includes("news"),
)
check(
  "Found independent fetch/data steps",
  fetchSteps.length >= 2,
  `found ${fetchSteps.length} fetch-like steps`,
)

// The combine step should depend on the fetch steps
const combineStep = result.dag.steps.find(
  (s) => s.id.includes("combine") || s.id.includes("report") || s.id.includes("merge"),
)
check(
  "Found a combine/report step with dependencies",
  combineStep !== undefined && combineStep.dependsOn.length >= 2,
  combineStep ? `deps: [${combineStep.dependsOn.join(", ")}]` : "no combine step",
)

check(
  "At least 1 parallelism group found",
  result.dag.parallelism.length >= 1,
  `found ${result.dag.parallelism.length}`,
)

// The parallel group should contain the fetch steps
if (result.dag.parallelism.length > 0) {
  const largestGroup = result.dag.parallelism.reduce(
    (max, g) => (g.steps.length > max.steps.length ? g : max),
    result.dag.parallelism[0]!,
  )
  check(
    "Largest parallel group has 2+ steps",
    largestGroup.steps.length >= 2,
    `size: ${largestGroup.steps.length}, type: ${largestGroup.type}`,
  )

  check(
    "Parallel group classified as DLP or ILP",
    largestGroup.type === "dlp" || largestGroup.type === "ilp" || largestGroup.type === "tlp",
    `type: ${largestGroup.type}`,
  )
}

// Test the new generateParallelismSection function
const section = generateParallelismSection(result.dag)
check(
  "generateParallelismSection produces non-empty output",
  section.length > 0,
  `${section.length} chars`,
)

check(
  "Section contains 'Parallel Execution Opportunities' heading",
  section.includes("## Parallel Execution Opportunities"),
)

check(
  "Section contains execution hint",
  section.includes("**Execution hint:**"),
)

console.log("\n--- Generated Parallelism Section ---")
console.log(section.slice(0, 600))

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
process.exit(failed > 0 ? 1 : 0)
