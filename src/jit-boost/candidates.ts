import path from "node:path"
import { mkdir } from "node:fs/promises"
import type { BoostCandidate } from "./types.ts"
import { BoostCandidatesFileSchema, normalizeParamDef } from "./types.ts"
import { runHeadlessAgent, isHeadlessAgentError, type HeadlessAgentDriver } from "../core/headless-agent/index.ts"
import { createProviderForModel } from "../providers/registry.ts"
import { extractStructured } from "../providers/structured.ts"
import { isProviderError } from "../providers/errors.ts"
import { parseConvLog, type ExtractedToolCode } from "../core/conv-log-parser.ts"
import { estimateCost } from "../core/cost.ts"
import { createLogger } from "../core/logger.ts"
import { TIMEOUT_DEFAULTS } from "../core/timeouts.ts"

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
  const timeoutMs = opts?.timeoutMs ?? TIMEOUT_DEFAULTS.candidateGen

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
      "params": {
        "paramName": {
          "type": "string",
          "description": "what this parameter is",
          "extractPattern": "regex with ONE capture group that pulls the value out of a user prompt"
        }
      },
      "materializationType": "shell"
    }
  ]
}
\`\`\`

## Candidate Requirements

- **purposeId**: Descriptive ID for this solidifiable pattern
- **keywords**: Words in user prompts that trigger this pattern (used for matching)
- **codeSignature**: Regex that matches the generated code structure. Must be a valid regex.
- **functionTemplate**: Code with \${param} placeholders for variable parts
- **params**: Map of parameter name to {type, description, extractPattern}. extractPattern is
  REQUIRED for every param: a regex with exactly one capture group that extracts the value
  from a natural-language user prompt (e.g. "weather in ([A-Za-z ]+)\\??$" pulls the city).
  Test it mentally against the trigger keywords — at runtime, extraction failure means the
  template cannot run and the agent falls back to the LLM path.
- **materializationType**: "shell" or "python"
- **monitoredTools**: Which tool calls to monitor. OMIT this field unless you have a specific
  reason to narrow it — the default set ("execute_command", "write_file", "web_fetch") covers
  every execution path.

## Rules

- Be conservative — only identify truly fixed patterns where the code structure doesn't vary.
- The regex in codeSignature must compile and match the template when params are filled in.
- Signature robustness: agents may satisfy the same purpose through different tools — running
  \`curl\` via execute_command, or fetching the URL directly via a web_fetch tool (monitored
  content is then the JSON args, e.g. {"url":"https://..."}). Anchor codeSignature on the
  stable core pattern (the API URL shape, the library call), NOT on tool-specific invocation
  syntax like a \`curl\` prefix.
- If no solidifiable patterns exist in this skill, write {"candidates": []}.
- Focus on tool calls (shell commands, file writes) that repeat with the same structure.
- Derive purposeId from the skill's distinct purposes. Purposes that require reasoning over
  content, multi-step workflows, or variable output formats are NOT solidifiable — do not
  emit candidates for them.
- purposeId must be UNIQUE across candidates: at most one candidate per purpose. If a purpose
  has several plausible patterns, pick the single most repetitive one.
- functionTemplate must ONLY use commands, tools, and libraries that the skill's own
  documentation prescribes (if the skill teaches pypdf, the template uses pypdf — never a
  substitute like qpdf). The runtime environment is only guaranteed to provide what the
  skill documents; anything else fails at execution time and demotes the candidate.
- Every extractPattern must work for EVERY phrasing implied by the keywords: users say
  "weather in London", "forecast for Tokyo", "merge a.pdf and b.pdf into out.pdf" — cover
  the in/for/at/of variants. A promoted candidate whose extractPattern cannot pull params
  from a triggering prompt can never execute and is wasted.

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

    const validated = filterServableCandidates(parsed.candidates, { requireTemplate: true })

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
// Candidate quality gate (shared by every generator)
// ---------------------------------------------------------------------------

/**
 * Mechanical acceptance rules for generated candidates. The generation
 * prompts demand these properties, but prompt-only requirements are not
 * enforcement: a candidate that promotes at runtime yet cannot serve
 * (missing or broken extractPattern, duplicate purposeId) only wastes the
 * promotion gate. Rejections are logged with their reason.
 */
export function filterServableCandidates(
  candidates: BoostCandidate[],
  opts?: {
    /** Reject candidates with an empty functionTemplate (final artifacts). */
    requireTemplate?: boolean
  },
): BoostCandidate[] {
  const accepted: BoostCandidate[] = []
  const seen = new Set<string>()

  for (const c of candidates) {
    try {
      new RegExp(c.codeSignature, "i")
    } catch (e) {
      log.warn(`Skipping candidate ${c.purposeId}: invalid regex "${c.codeSignature}" — ${e}`)
      continue
    }
    if (seen.has(c.purposeId)) {
      log.warn(`Skipping candidate with duplicate purposeId "${c.purposeId}" — at most one candidate per purpose`)
      continue
    }
    if (opts?.requireTemplate && !c.functionTemplate) {
      log.warn(`Candidate ${c.purposeId} has empty template, skipping`)
      continue
    }
    const badParams: string[] = []
    for (const [name, value] of Object.entries(c.params)) {
      const def = normalizeParamDef(name, value)
      if (!def.extractPattern) {
        badParams.push(`${name} (no extractPattern)`)
        continue
      }
      try {
        new RegExp(def.extractPattern, "i")
      } catch {
        badParams.push(`${name} (invalid extractPattern)`)
      }
    }
    if (badParams.length > 0) {
      log.warn(`Skipping candidate ${c.purposeId}: unservable params under regex-only extraction: ${badParams.join(", ")}`)
      continue
    }
    seen.add(c.purposeId)
    accepted.push(c)
  }

  return accepted
}

// ---------------------------------------------------------------------------
// Online Candidate Refinement (from runtime miss observations)
// ---------------------------------------------------------------------------

const MAX_REFINE_OBSERVATIONS = 10
const MAX_REFINE_OBSERVATION_CHARS = 1500

/**
 * Rewrite an AOT-generated candidate using what the runtime agent ACTUALLY did.
 *
 * When a candidate keeps missing but the agent's tool calls look structurally
 * similar across runs, the AOT prediction was wrong about the surface form
 * (tool choice, flags, URL format), not about solidifiability. This grounds
 * the signature/template/keywords/extractPatterns in observed behavior.
 *
 * Guardrail: the refined codeSignature must actually match a majority of the
 * observations that triggered the refinement — otherwise the refinement is
 * rejected and the caller keeps the original candidate.
 */
export async function refineCandidateFromObservations(args: {
  candidate: BoostCandidate
  observations: { tool: string; content: string; run?: number }[]
  prompts: string[]
  model?: string
}): Promise<{ candidate: BoostCandidate | null; cost: number }> {
  const observations = args.observations.slice(-MAX_REFINE_OBSERVATIONS)
  if (observations.length === 0) return { candidate: null, cost: 0 }

  const observationBlocks = observations
    .map((o, i) => {
      const truncated = o.content.length > MAX_REFINE_OBSERVATION_CHARS
        ? o.content.slice(0, MAX_REFINE_OBSERVATION_CHARS) + "\n... (truncated)"
        : o.content
      const runTag = o.run !== undefined ? `, invocation ${o.run}` : ""
      return `### Observation ${i + 1} (tool: ${o.tool}${runTag})\n\`\`\`\n${truncated}\n\`\`\``
    })
    .join("\n\n")

  const prompt = `You maintain candidates for a JIT code-solidification system. A candidate was generated ahead-of-time from skill documentation, but at runtime its codeSignature never matches what the agent actually does, so it can never promote.

## The current (mispredicting) candidate

\`\`\`json
${JSON.stringify(args.candidate, null, 2)}
\`\`\`

## What the agent ACTUALLY did (tool calls from the non-matching runs)

${observationBlocks}

## The user prompts that triggered these runs

${args.prompts.map((p) => `- ${p}`).join("\n")}

## Your Task

Rewrite the candidate so it is grounded in the observed behavior:

- **codeSignature**: a LOOSE regex that matches the observed tool-call contents above (test it mentally against EVERY observation — including variants: agents reorder imports, rename variables, and switch between equivalent URL formats run to run). Match 2-3 distinctive API/method calls or the stable URL shape joined by [\\s\\S]*? gaps. NEVER anchor on import statements, import order, variable names, or comments. If the observations show two equivalent surface forms of the same purpose (e.g. two URL format parameters), the signature must match BOTH. For web_fetch observations the monitored content is the JSON arguments string (e.g. {"url":"https://..."}).
- **functionTemplate**: code that implements the same purpose the way the agent actually does it (same tool/library/URL format seen in the observations), with \${param} placeholders. materializationType "shell" for commands/URLs (curl the URL), "python" for python scripts.
- **keywords**: words that appear in the triggering user prompts above.
- **params**: every param needs an extractPattern (regex, ONE capture group) that works on EVERY triggering prompt above.
- Keep the same purposeId.

If the observations are structurally inconsistent with each other (genuinely not solidifiable), return {"candidates": []}.

Return {"candidates": [<the single rewritten candidate>]}.`

  const model = args.model ?? ANALYSIS_MODEL
  const provider = createProviderForModel(model)

  try {
    const { result, tokens, costUsd } = await extractStructured({
      provider,
      schema: BoostCandidatesFileSchema,
      schemaName: "refine_boost_candidate",
      schemaDescription: "Rewrite a boost candidate grounded in observed runtime behavior",
      prompt,
      maxTokens: 4096,
    })
    const cost = estimateCost(model, tokens, costUsd)

    const refined = result.candidates[0]
    if (!refined) {
      log.info(`Refinement for ${args.candidate.purposeId}: model judged the behavior not solidifiable`)
      return { candidate: null, cost }
    }

    // Identity + mechanical guardrails
    refined.purposeId = args.candidate.purposeId
    let regex: RegExp
    try {
      regex = new RegExp(refined.codeSignature, "i")
    } catch (e) {
      log.warn(`Refinement rejected for ${args.candidate.purposeId}: invalid regex "${refined.codeSignature}" — ${e}`)
      return { candidate: null, cost }
    }
    // Coverage is judged per RUN, not per tool call: each run has exactly one
    // signature-bearing call (the script / the fetch) among setup noise like
    // `pip install`, so a per-call majority would reject every good signature.
    // A signature that covers only one surface form of an alternating pattern
    // would just reproduce the miss loop it was meant to fix — require a
    // strict majority (more than half) of the observed runs.
    const runOf = (o: { run?: number }, i: number) => o.run ?? -1 - i // untagged: each its own pseudo-run
    const allRuns = new Set(observations.map(runOf))
    const matchedRuns = new Set(observations.filter((o) => regex.test(o.content)).map(runOf))
    const required = Math.min(allRuns.size, Math.max(2, Math.floor(allRuns.size / 2) + 1))
    if (matchedRuns.size < required) {
      log.warn(`Refinement rejected for ${args.candidate.purposeId}: new signature covers only ${matchedRuns.size}/${allRuns.size} observed runs`)
      return { candidate: null, cost }
    }

    // A candidate that promotes but whose extractPatterns cannot pull params
    // from the very prompts that triggered it can never serve. Serving needs
    // EVERY param from the SAME prompt, so the check is joint: a strict
    // majority of the triggering prompts must yield all params together —
    // per-param counts could each pass on a different subset of prompts
    // while no single prompt is actually servable.
    if (args.prompts.length > 0) {
      const paramRegexes: Array<[string, RegExp]> = []
      for (const [name, value] of Object.entries(refined.params)) {
        const def = normalizeParamDef(name, value)
        if (!def.extractPattern) {
          log.warn(`Refinement rejected for ${args.candidate.purposeId}: param "${name}" has no extractPattern`)
          return { candidate: null, cost }
        }
        try {
          paramRegexes.push([name, new RegExp(def.extractPattern, "i")])
        } catch (e) {
          log.warn(`Refinement rejected for ${args.candidate.purposeId}: param "${name}" has invalid extractPattern — ${e}`)
          return { candidate: null, cost }
        }
      }
      // `[].every()` is true for every prompt, so a zero-param candidate used to
      // clear this check without extracting anything — and a zero-param
      // candidate serves a CONSTANT, which is exactly the shape that answers
      // "weather in Berlin" with the London template it was refined from.
      const servablePrompts = paramRegexes.length === 0
        ? 0
        : args.prompts.filter((p) => paramRegexes.every(([, re]) => re.exec(p)?.[1])).length
      if (paramRegexes.length === 0) {
        log.warn(`Refinement rejected for ${args.candidate.purposeId}: refined candidate has no params, so it would serve a constant response to every triggering prompt`)
        return { candidate: null, cost }
      }
      const promptsRequired = Math.min(args.prompts.length, Math.floor(args.prompts.length / 2) + 1)
      if (servablePrompts < promptsRequired) {
        log.warn(`Refinement rejected for ${args.candidate.purposeId}: all params extract together from only ${servablePrompts}/${args.prompts.length} triggering prompts`)
        return { candidate: null, cost }
      }
    }

    // Every generator's output goes through the mechanical gate; a refined
    // candidate is no different, and it is the one that reaches production
    // WITHOUT a human ever seeing it. Skipping the gate here let an empty
    // template through (functionTemplate had no minimum length): it instantiates
    // to "", clears the unfilled-placeholder scan, `sh -c ""` exits 0, and the
    // empty string is served as the agent's answer.
    const [gated] = filterServableCandidates([refined], { requireTemplate: true })
    if (!gated) {
      log.warn(`Refinement rejected for ${args.candidate.purposeId}: refined candidate failed the servability gate`)
      return { candidate: null, cost }
    }

    log.info(`Refined candidate ${args.candidate.purposeId} (signature covers ${matchedRuns.size}/${allRuns.size} observed runs, cost=$${cost.toFixed(4)})`)
    return { candidate: gated, cost }
  } catch (err) {
    if (isProviderError(err) || isHeadlessAgentError(err)) throw err
    log.warn(`Candidate refinement failed: ${err}`)
    return { candidate: null, cost: 0 }
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

    // Step 5: mechanical quality gate (templates are filled in later, so
    // requireTemplate stays off here)
    const validated = filterServableCandidates(result.candidates)

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
  const timeoutMs = opts?.timeoutMs ?? TIMEOUT_DEFAULTS.candidateGen

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

    const completed = filterServableCandidates(parsed.candidates, { requireTemplate: true })

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
