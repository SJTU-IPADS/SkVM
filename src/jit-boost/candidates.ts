import path from "node:path"
import { mkdir } from "node:fs/promises"
import type { BoostCandidate } from "./types.ts"
import { BoostCandidatesFileSchema } from "./types.ts"
import { runHeadlessAgent, isHeadlessAgentError, type HeadlessAgentDriver } from "../core/headless-agent.ts"
import { createProviderForModel } from "../providers/registry.ts"
import { extractStructured } from "../providers/structured.ts"
import { isProviderError } from "../providers/errors.ts"
import { parseConvLog, type ExtractedToolCode } from "../core/conv-log-parser.ts"
import { estimateCost } from "../core/cost.ts"
import { createLogger } from "../core/logger.ts"
import { TASK_FILE_DEFAULTS } from "../core/ui-defaults.ts"

const log = createLogger("boost-candidates")

const DEFAULT_MODEL = "anthropic/claude-opus-4.6"

// ---------------------------------------------------------------------------
// Boost Candidate Generation via Headless Agent
// ---------------------------------------------------------------------------

/**
 * Generate boost candidates by having a headless agent analyze a skill directory.
 *
 * The agent explores the full skill folder (SKILL.md, reference files, scripts, etc.)
 * and identifies solidifiable code patterns — places where the agent will repeatedly
 * generate structurally identical code with varying parameters.
 *
 * Results are written to outputDir/boost-candidates.json. The concrete agent
 * backend is chosen via `core/headless-agent.ts`, so this module has no hard
 * dependency on any particular agent tool.
 */
export async function generateBoostCandidates(
  skillDir: string,
  outputDir: string,
  opts?: { model?: string; timeoutMs?: number; driver?: HeadlessAgentDriver },
): Promise<{ candidates: BoostCandidate[]; cost: number }> {
  const model = opts?.model ?? DEFAULT_MODEL
  const timeoutMs = opts?.timeoutMs ?? TASK_FILE_DEFAULTS.timeoutMs

  // Headless agent requires absolute paths for its working directory
  const absSkillDir = path.resolve(skillDir)
  const absOutputDir = path.resolve(outputDir)

  await mkdir(absOutputDir, { recursive: true })

  const outputFile = path.join(absOutputDir, "boost-candidates.json")

  const prompt = `You are a JIT compiler agent analyzing code patterns for solidification.

## What is Code Solidification?

Code solidification identifies patterns in agent tool calls where the code structure is fixed
but parameters vary between invocations. When a pattern is detected at runtime, the code can
be executed directly from a template — bypassing the LLM call entirely.

## Your Task

Analyze the skill in the current directory. Read SKILL.md and any reference files, scripts,
or bundled code. Identify code patterns that an agent using this skill would generate
repeatedly with the same structure but different parameters.

## Output

Write the result to: ${outputFile}

The file must be a JSON object with this structure:
\`\`\`json
{
  "candidates": [
    {
      "purposeId": "descriptive-id-for-this-pattern",
      "keywords": ["words", "in", "user", "prompts", "that", "trigger", "this"],
      "codeSignature": "regex matching the expected code structure",
      "functionTemplate": "code with \${param} placeholders",
      "params": {"paramName": "string", "anotherParam": "number"},
      "materializationType": "shell",
      "monitoredTools": ["execute_command"]
    }
  ]
}
\`\`\`

## Candidate Requirements

- **purposeId**: Descriptive ID for this solidifiable pattern
- **keywords**: Words in user prompts that trigger this pattern (used for matching)
- **codeSignature**: Regex that matches the generated code structure. Must be a valid regex.
- **functionTemplate**: Code with \${param} placeholders for variable parts
- **params**: Map of parameter name to type ("string" or "number")
- **materializationType**: "shell" or "python"
- **monitoredTools**: Which tool calls to monitor (default: ["execute_command", "write_file"])

## Rules

- Be conservative — only identify truly fixed patterns where the code structure doesn't vary.
- The regex in codeSignature must compile and match the template when params are filled in.
- If no solidifiable patterns exist in this skill, write {"candidates": []}.
- Focus on tool calls (shell commands, file writes) that repeat with the same structure.

Start by listing files in the current directory and reading SKILL.md, then any referenced files.`

  try {
    log.info(`Generating boost candidates for ${absSkillDir} with ${model}`)

    const run = await runHeadlessAgent({
      cwd: absSkillDir,
      prompt,
      model,
      timeoutMs,
      driver: opts?.driver,
    })

    const cost = run.cost

    // Read and validate the output file. Non-zero exit already threw above,
    // so a missing file here means the agent ran but didn't follow the
    // output contract — treat as an empty candidate set rather than failure.
    const file = Bun.file(outputFile)
    if (!(await file.exists())) {
      log.warn("Agent did not produce boost-candidates.json")
      return { candidates: [], cost }
    }

    const raw = await file.json()
    const parsed = BoostCandidatesFileSchema.parse(raw)

    // Validate each candidate's regex compiles
    const validated: BoostCandidate[] = []
    for (const candidate of parsed.candidates) {
      try {
        new RegExp(candidate.codeSignature)
        validated.push(candidate)
      } catch (e) {
        log.warn(`Skipping candidate ${candidate.purposeId}: invalid regex "${candidate.codeSignature}" — ${e}`)
      }
    }

    log.info(`Generated ${validated.length} boost candidates (cost=$${cost.toFixed(4)})`)

    // Re-write validated candidates (agent may have produced extras that failed validation)
    if (validated.length !== parsed.candidates.length) {
      await Bun.write(outputFile, JSON.stringify({ candidates: validated }, null, 2))
    }

    return { candidates: validated, cost }
  } catch (err) {
    if (isProviderError(err) || isHeadlessAgentError(err)) throw err
    log.warn(`Candidate generation failed: ${err}`)
    return { candidates: [], cost: 0 }
  }
}

// ---------------------------------------------------------------------------
// Boost Candidate Generation from Conversation Logs (Option A)
// ---------------------------------------------------------------------------

const ANALYSIS_MODEL = "anthropic/claude-sonnet-4.6"
const MIN_CODE_LENGTH = 20
const MAX_SNIPPETS = 10
const MAX_SNIPPET_CHARS = 2000

/**
 * Generate boost candidates by analyzing actual agent tool calls from conv logs.
 *
 * Instead of predicting code patterns from skill documentation, this function
 * reads real agent-generated code from conversation logs and asks an LLM to
 * identify structural patterns with loose regex signatures.
 *
 * Results are written to outputDir/boost-candidates.json.
 */
export async function generateCandidatesFromConvLogs(
  convLogPaths: string[],
  outputDir: string,
  opts?: { model?: string },
): Promise<{ candidates: BoostCandidate[]; snippets: ExtractedToolCode[]; cost: number }> {
  // Step 1: Parse all conv logs and collect code snippets
  const allSnippets: ExtractedToolCode[] = []
  for (const logPath of convLogPaths) {
    try {
      const snippets = await parseConvLog(logPath)
      allSnippets.push(...snippets)
    } catch (err) {
      log.warn(`Failed to parse conv log ${logPath}: ${err}`)
    }
  }

  // Step 2: Filter and prioritize snippets
  const filtered = allSnippets
    .filter((s) => s.code.length >= MIN_CODE_LENGTH)
    .sort((a, b) => b.code.length - a.code.length) // longer snippets first
    .slice(0, MAX_SNIPPETS)

  if (filtered.length === 0) {
    log.warn("No tool call code found in conv logs — cannot generate candidates")
    return { candidates: [], snippets: [], cost: 0 }
  }

  log.info(`Extracted ${filtered.length} code snippets from ${convLogPaths.length} conv log(s)`)

  // Step 3: Build prompt with actual code
  const snippetBlocks = filtered
    .map((s, i) => {
      const truncated = s.code.length > MAX_SNIPPET_CHARS
        ? s.code.slice(0, MAX_SNIPPET_CHARS) + "\n... (truncated)"
        : s.code
      return `### Snippet ${i + 1} (${s.toolName})\n\`\`\`\n${truncated}\n\`\`\``
    })
    .join("\n\n")

  const prompt = `You are analyzing actual agent-generated code to identify solidifiable patterns for a JIT code solidification system.

## What is Code Solidification?

Code solidification identifies patterns in agent tool calls where the code structure is fixed but parameters vary between invocations. When a pattern is detected at runtime, the code can be executed directly from a template — bypassing the LLM call entirely.

## Code Snippets from Agent Runs

Below are code blocks that an agent actually produced when executing tasks with a skill. Each block is the content of a tool call (execute_command or write_file).

${snippetBlocks}

## Your Task

Identify structural CODE PATTERNS from these snippets that would repeat if the same skill were used for similar tasks. For each pattern:

1. **codeSignature** — a LOOSE regex that matches the essential API calls:
   - Use [\\s\\S]*? between key function calls — DO NOT match line-by-line
   - Match core function/method names, NOT exact variable names or import lists
   - Example: \`pdfplumber\\.open\\(.*?\\)[\\s\\S]*?\\.extract_text\\(\\)\`
   - Account for agents adding try/except, loops, extra imports, different variable names
   - The regex is tested with \`new RegExp(codeSignature, "i")\` against the full code string

2. **functionTemplate** — set to empty string "" (templates will be generated separately with full skill context)

3. **keywords** — words from user prompts that would trigger this pattern

4. **params** — map of parameter name to an object with:
   - **type**: "string" or "number"
   - **description**: what this param represents (e.g., "The input PDF file path")
   - **extractPattern**: a regex with ONE capture group to extract this value from a user prompt
     - For an input PDF file: \`(\\\\S+\\\\.pdf)\`
     - For an output text file: \`(\\\\S+\\\\.txt)\`
     - For a city name: \`(?:in|for)\\\\s+([A-Za-z][A-Za-z\\\\s]+)\`
     - For a URL: \`(https?://\\\\S+)\`

   Example params:
   \`\`\`json
   {
     "inputPdf": { "type": "string", "description": "The input PDF file to process", "extractPattern": "(\\\\S+\\\\.pdf)" },
     "outputTxt": { "type": "string", "description": "The output text file path", "extractPattern": "(\\\\S+\\\\.txt)" }
   }
   \`\`\`

5. **purposeId** — descriptive kebab-case ID for this pattern

6. **materializationType** — always "shell" (templates are executed via sh -c)

7. **monitoredTools** — which tool calls to monitor: ["execute_command"] and/or ["write_file"]

## Rules

- Only identify patterns where the STRUCTURE is fixed but PARAMETERS vary
- The codeSignature regex MUST be loose: match 2-3 key API calls with [\\s\\S]*? gaps
- Do NOT create line-by-line structural regexes
- If a snippet is a one-off with no repeatable pattern, skip it
- Focus on the most important and frequently-used patterns (max 10)
- Each regex must be valid JavaScript RegExp syntax
- Each param MUST have a description and an extractPattern — the extractPattern is critical for runtime`

  // Step 4: Call extractStructured via the provider registry
  const model = opts?.model ?? ANALYSIS_MODEL
  const provider = createProviderForModel(model)

  try {
    await mkdir(outputDir, { recursive: true })
    const outputFile = path.join(outputDir, "boost-candidates.json")

    const { result, tokens, costUsd } = await extractStructured({
      provider,
      schema: BoostCandidatesFileSchema,
      schemaName: "generate_boost_candidates",
      schemaDescription: "Generate boost candidates from observed agent code patterns",
      prompt,
      maxTokens: 8192,
    })

    const cost = estimateCost(model, tokens, costUsd)

    // Step 5: Validate each candidate's regex compiles
    const validated: BoostCandidate[] = []
    for (const candidate of result.candidates) {
      try {
        new RegExp(candidate.codeSignature, "i")
        validated.push(candidate)
      } catch (e) {
        log.warn(`Skipping candidate ${candidate.purposeId}: invalid regex "${candidate.codeSignature}" — ${e}`)
      }
    }

    log.info(`Generated ${validated.length} boost candidates from conv logs (cost=$${cost.toFixed(4)})`)

    // Write validated candidates
    await Bun.write(outputFile, JSON.stringify({ candidates: validated }, null, 2))

    return { candidates: validated, snippets: filtered, cost }
  } catch (err) {
    if (isProviderError(err) || isHeadlessAgentError(err)) throw err
    log.warn(`Conv-log candidate generation failed: ${err}`)
    return { candidates: [], snippets: [], cost: 0 }
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Generate Templates via Headless Agent with Skill Context
// ---------------------------------------------------------------------------

/**
 * Generate working functionTemplates for candidates by giving a headless agent
 * full access to the skill directory.
 *
 * Phase 1 produces candidates with codeSignature/params/keywords but empty
 * functionTemplate. This function fills in the templates by having an agent
 * read the skill documentation, reference scripts, and original code snippets.
 */
export async function generateTemplates(
  candidates: BoostCandidate[],
  snippets: ExtractedToolCode[],
  skillDir: string,
  outputDir: string,
  opts?: { model?: string; timeoutMs?: number; driver?: HeadlessAgentDriver },
): Promise<{ candidates: BoostCandidate[]; cost: number }> {
  if (candidates.length === 0) {
    return { candidates: [], cost: 0 }
  }

  const model = opts?.model ?? DEFAULT_MODEL
  const timeoutMs = opts?.timeoutMs ?? 180_000

  const absSkillDir = path.resolve(skillDir)
  const absOutputDir = path.resolve(outputDir)
  await mkdir(absOutputDir, { recursive: true })
  const outputFile = path.join(absOutputDir, "boost-candidates.json")

  // Build per-candidate context: pattern info + matched code snippet
  const candidateBlocks = candidates.map((c, i) => {
    // Find the best matching snippet for this candidate
    let matchedSnippet = ""
    try {
      const re = new RegExp(c.codeSignature, "i")
      const match = snippets.find((s) => re.test(s.code))
      if (match) matchedSnippet = match.code.slice(0, MAX_SNIPPET_CHARS)
    } catch { /* invalid regex */ }

    const paramDesc = Object.entries(c.params)
      .map(([name, def]) => {
        if (typeof def === "string") return `  - \${${name}} (${def})`
        return `  - \${${name}}: ${def.description} (${def.type})`
      })
      .join("\n")

    return `### Candidate ${i + 1}: ${c.purposeId}
Parameters:
${paramDesc}

Original agent code:
\`\`\`
${matchedSnippet || "(no matching snippet)"}
\`\`\``
  }).join("\n\n")

  const prompt = `You are generating reusable code templates for a JIT code solidification system.

## Context

Code solidification replaces LLM calls with pre-computed templates at runtime.
Below are code patterns identified from actual agent runs. For each pattern,
you need to generate a working, TASK-AGNOSTIC functionTemplate.

First, read SKILL.md and any reference files in the current directory to understand
the skill's APIs, tools, and conventions.

## Candidates

${candidateBlocks}

## Your Task

For each candidate above, generate a functionTemplate and write the completed
candidates to: ${outputFile}

The output file must contain:
\`\`\`json
{
  "candidates": [
    {
      "purposeId": "...",
      "keywords": [...],
      "codeSignature": "...",
      "functionTemplate": "THE TEMPLATE YOU GENERATE",
      "params": {...},
      "materializationType": "shell",
      "monitoredTools": [...]
    }
  ]
}
\`\`\`

## Template Rules (CRITICAL)

1. **Shell command format**: The template is always executed via \`sh -c <template>\`.
   For Python code, use heredoc: \`python3 << 'EOF'\\n...python code...\\nEOF\`

2. **Task-agnostic**: The template must work for ANY task matching this pattern,
   not just the specific task shown in "Original agent code". Do NOT hardcode
   filenames, paths, or task-specific logic.

3. **Self-contained**: The template must NOT depend on files created by previous
   agent steps. It runs standalone in a fresh workDir.

4. **Use \${param} placeholders**: Replace variable parts with \${param} syntax.
   Ensure proper quoting around placeholders in the code, e.g., open("\${inputPdf}")

5. **Keep all other fields unchanged**: Copy purposeId, keywords, codeSignature,
   params, monitoredTools exactly from the input. Only fill in functionTemplate
   and set materializationType to "shell".

Start by reading SKILL.md, then generate templates.`

  try {
    log.info(`Generating templates for ${candidates.length} candidates in ${absSkillDir} with ${model}`)

    const run = await runHeadlessAgent({
      cwd: absSkillDir,
      prompt,
      model,
      timeoutMs,
      driver: opts?.driver,
    })

    const cost = run.cost

    // Read and validate output. Non-zero exit already threw; a missing file
    // here means the agent ignored the output contract — return originals.
    const file = Bun.file(outputFile)
    if (!(await file.exists())) {
      log.warn("Agent did not produce boost-candidates.json with templates")
      return { candidates, cost } // return original candidates unchanged
    }

    const raw = await file.json()
    const parsed = BoostCandidatesFileSchema.parse(raw)

    // Validate: ensure templates are non-empty and regexes still compile
    const completed: BoostCandidate[] = []
    for (const c of parsed.candidates) {
      if (!c.functionTemplate) {
        log.warn(`Candidate ${c.purposeId} has empty template, skipping`)
        continue
      }
      try {
        new RegExp(c.codeSignature, "i")
        completed.push(c)
      } catch (e) {
        log.warn(`Skipping candidate ${c.purposeId}: invalid regex — ${e}`)
      }
    }

    log.info(`Generated templates for ${completed.length} candidates (cost=$${cost.toFixed(4)})`)

    // Write completed candidates
    await Bun.write(outputFile, JSON.stringify({ candidates: completed }, null, 2))

    return { candidates: completed, cost }
  } catch (err) {
    if (isProviderError(err) || isHeadlessAgentError(err)) throw err
    log.warn(`Template generation failed: ${err}`)
    return { candidates, cost: 0 } // return original candidates unchanged
  }
}
