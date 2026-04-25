#!/usr/bin/env bun
/**
 * Live integration test: AOT Pass 2 (Environment Binding)
 *
 * Tests that Pass 2 correctly identifies Python dependencies in the
 * document-pdf skill and generates a valid env-binding script.
 *
 * Usage: bun run test/integration/live-aot-pass2.ts
 * Requires: ANTHROPIC_API_KEY
 * Estimated cost: ~$0.01-0.03
 */

import "../../src/core/env-bootstrap.ts"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { runPass2 } from "../../src/compiler/passes/bind-env/runner.ts"
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
// Load skill
// ---------------------------------------------------------------------------

const SKILL_PATH = path.resolve(
  import.meta.dirname,
  "../../skvm-data/skills/document-pdf/SKILL.md",
)

let skillContent: string
try {
  skillContent = await readFile(SKILL_PATH, "utf-8")
  console.log(`Loaded skill: ${SKILL_PATH} (${skillContent.length} chars)`)
} catch {
  console.error(`Could not load skill from ${SKILL_PATH}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Run Pass 2
// ---------------------------------------------------------------------------

console.log("\n=== AOT Pass 2: Environment Binding ===\n")

const provider = createCompilerProvider()
const startMs = performance.now()

const skillDir = path.dirname(SKILL_PATH)
const result = await runPass2(skillContent, skillDir, provider)

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

console.log("\n--- Dependencies ---")
for (const dep of result.dependencies) {
  console.log(`  ${dep.name} (${dep.type}): check: ${dep.checkCommand}`)
}

console.log("\n--- Assertions ---")

check(
  "Found at least 2 dependencies",
  result.dependencies.length >= 2,
  `found ${result.dependencies.length}`,
)

// Document-pdf skill references reportlab, pypdf, pdfplumber at minimum
const depNames = result.dependencies.map((d) => d.name.toLowerCase())
const expectedPips = ["reportlab", "pypdf", "pdfplumber"]
for (const pkg of expectedPips) {
  const found = depNames.some((n) => n.includes(pkg))
  check(`Detected "${pkg}" dependency`, found, `deps: [${depNames.join(", ")}]`)
}

// document-pdf references both pip packages and system tools
const pipDeps = result.dependencies.filter((d) => d.type === "pip")
check(
  "Most dependencies are pip type",
  pipDeps.length >= 3,
  `pip: ${pipDeps.length}, system: ${result.dependencies.length - pipDeps.length}`,
)

check(
  "Binding script is non-empty",
  result.bindingScript.length > 10,
)

check(
  "Binding script starts with shebang",
  result.bindingScript.startsWith("#!/bin/bash"),
)

// Script should either install missing packages or report all satisfied
const isValidScript =
  result.bindingScript.includes("pip install") ||
  result.bindingScript.includes("pip3 install") ||
  result.bindingScript.includes("No dependencies") ||
  result.bindingScript.includes("All dependencies")
check("Binding script has install commands or all-satisfied", isValidScript)

console.log("\n--- Binding Script Preview ---")
console.log(result.bindingScript.slice(0, 500))

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
process.exit(failed > 0 ? 1 : 0)
