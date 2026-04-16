import path from "node:path"
import { readdir } from "node:fs/promises"
import { z } from "zod"
import type { AgentStep, EvalCheckpoint, EvalCriterion, EvalResult, RunResult, TokenUsage } from "../core/types.ts"
import { customEvaluators } from "./types.ts"
import type { LLMProvider } from "../providers/types.ts"
import { extractStructured } from "../providers/structured.ts"
import { isProviderError } from "../providers/errors.ts"
import { isHeadlessAgentError } from "../core/headless-agent.ts"
import { createLogger } from "../core/logger.ts"

const log = createLogger("evaluator")

export interface EvaluatorConfig {
  llmProvider?: LLMProvider
  /**
   * Optional usage hook called once per successful LLM judge call. Caller can
   * use it to track token/cost across multiple evaluations. Not called for
   * non-LLM evaluators (script, file-check, custom) or when the judge call
   * fails before a response is received. `costUsd` is the authoritative
   * provider-reported cost when available; callers should prefer it over
   * `estimateCost(model, tokens)` when present.
   */
  onJudgeUsage?: (tokens: TokenUsage, costUsd?: number) => void
}

export interface EvaluateAllOptions {
  /** When true, llm-judge criteria are deferred via onDefer callback. Default: false. */
  deferLLMJudge?: boolean
  /** Called for each deferred llm-judge criterion. The caller is responsible for
   *  collecting inputs and writing them to a manifest. */
  onDefer?: (criterion: Extract<EvalCriterion, { method: "llm-judge" }>, runResult: RunResult, criterionIndex: number) => Promise<void>
}

export async function evaluate(
  criterion: EvalCriterion,
  runResult: RunResult,
  config: EvaluatorConfig = {},
): Promise<EvalResult> {
  switch (criterion.method) {
    case "script":
      return evaluateScript(criterion, runResult)
    case "file-check":
      return evaluateFileCheck(criterion, runResult)
    case "llm-judge":
      return evaluateLLMJudge(criterion, runResult, config)
    case "custom":
      return evaluateCustom(criterion, runResult)
  }
}

export async function evaluateAll(
  criteria: EvalCriterion[],
  runResult: RunResult,
  config: EvaluatorConfig = {},
  options: EvaluateAllOptions = {},
): Promise<EvalResult[]> {
  const results: EvalResult[] = []
  for (let i = 0; i < criteria.length; i++) {
    const c = criteria[i]!
    if (options.deferLLMJudge && c.method === "llm-judge" && options.onDefer) {
      await options.onDefer(c, runResult, i)
      results.push({
        pass: false,
        score: 0,
        details: "LLM judge deferred",
        criterion: c,
      })
    } else {
      results.push(await evaluate(c, runResult, config))
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// Script evaluation
// ---------------------------------------------------------------------------

/**
 * Convert `python3 -c "..."` at the end of an eval command to a heredoc,
 * avoiding shell double-quote conflicts (e.g. JSON.stringify output).
 */
function fixInlinePython(command: string): string {
  // Match: optional prefix ; python3 -c "...code..." at end
  const match = command.match(/^([\s\S]*?)python3\s+-c\s+"([\s\S]+)"$/)
  if (!match) return command
  const prefix = match[1]!
  const pyCode = match[2]!
  return `${prefix}python3 << 'PYEOF'\n${pyCode}\nPYEOF`
}

/** Try to extract checkpoint JSON from the last JSON line of stdout */
function tryParseCheckpoints(stdout: string): EvalCheckpoint[] | null {
  const lines = stdout.trim().split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line.startsWith("{")) continue
    try {
      const parsed = JSON.parse(line)
      if (Array.isArray(parsed.checkpoints) && parsed.checkpoints.length > 0) {
        return parsed.checkpoints.map((cp: Record<string, unknown>) => ({
          name: String(cp.name ?? `check_${i}`),
          score: Math.max(0, Math.min(1, Number(cp.score) || 0)),
          reason: cp.reason != null ? String(cp.reason) : undefined,
        }))
      }
    } catch { /* not valid JSON, continue */ }
  }
  return null
}

async function evaluateScript(
  criterion: Extract<EvalCriterion, { method: "script" }>,
  runResult: RunResult,
): Promise<EvalResult> {
  try {
    const command = fixInlinePython(criterion.command)
    const proc = Bun.spawn(["sh", "-c", command], {
      cwd: runResult.workDir,
      stdout: "pipe",
      stderr: "pipe",
    })

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    const exitCodeMatch = exitCode === criterion.expectedExitCode

    // Exit code mismatch is a total failure
    if (!exitCodeMatch) {
      return {
        pass: false,
        score: 0.0,
        details: `Exit code: ${exitCode} (expected ${criterion.expectedExitCode})${stderr ? `, stderr: ${stderr.slice(0, 200)}` : ""}`,
        criterion,
      }
    }

    // Try structured checkpoint output
    const checkpoints = tryParseCheckpoints(stdout)
    if (checkpoints) {
      const score = checkpoints.reduce((sum, cp) => sum + cp.score, 0) / checkpoints.length
      const pass = checkpoints.every(cp => cp.score >= 0.5)
      const summary = checkpoints
        .map(cp => `${cp.name}: ${cp.score.toFixed(2)}${cp.reason ? ` (${cp.reason})` : ""}`)
        .join("; ")
      return { pass, score, details: summary, criterion, checkpoints }
    }

    // Fallback: binary logic with expectedOutput
    let outputMatch = true
    if (criterion.expectedOutput !== undefined) {
      outputMatch = stdout.trim() === criterion.expectedOutput.trim()
    }

    const pass = outputMatch
    return {
      pass,
      score: pass ? 1.0 : 0.0,
      details: pass
        ? "Script passed"
        : `Output mismatch: got "${stdout.trim().slice(0, 200)}"${stderr ? `, stderr: ${stderr.slice(0, 200)}` : ""}`,
      criterion,
    }
  } catch (err) {
    return {
      pass: false,
      score: 0.0,
      details: `Script execution error: ${err}`,
      criterion,
    }
  }
}

// ---------------------------------------------------------------------------
// File check evaluation
// ---------------------------------------------------------------------------

async function evaluateFileCheck(
  criterion: Extract<EvalCriterion, { method: "file-check" }>,
  runResult: RunResult,
): Promise<EvalResult> {
  let filePath: string

  if (criterion.glob) {
    const glob = new Bun.Glob(criterion.glob)
    const matches = [...glob.scanSync({ cwd: runResult.workDir })]
    if (matches.length === 0) {
      return {
        pass: false,
        score: 0.0,
        details: `No files matched glob: ${criterion.glob}`,
        criterion,
      }
    }
    filePath = path.resolve(runResult.workDir, matches[0]!)
  } else {
    filePath = path.resolve(runResult.workDir, criterion.path)
  }

  try {
    const file = Bun.file(filePath)
    const exists = await file.exists()

    if (!exists) {
      return {
        pass: false,
        score: 0.0,
        details: `File not found: ${criterion.path}`,
        criterion,
      }
    }

    const content = await file.text()

    switch (criterion.mode) {
      case "exact": {
        const pass = content.trim() === criterion.expected.trim()
        return {
          pass,
          score: pass ? 1.0 : 0.0,
          details: pass ? "Exact match" : `Expected "${criterion.expected.slice(0, 100)}", got "${content.trim().slice(0, 100)}"`,
          criterion,
        }
      }

      case "contains": {
        const pass = content.includes(criterion.expected)
        return {
          pass,
          score: pass ? 1.0 : 0.0,
          details: pass ? "Contains expected string" : `File does not contain "${criterion.expected.slice(0, 100)}"`,
          criterion,
        }
      }

      case "regex": {
        const regex = new RegExp(criterion.expected)
        const pass = regex.test(content)
        return {
          pass,
          score: pass ? 1.0 : 0.0,
          details: pass ? "Regex match" : `File does not match pattern: ${criterion.expected}`,
          criterion,
        }
      }

      case "json-schema": {
        try {
          const parsed = JSON.parse(content)
          const schema = JSON.parse(criterion.expected)
          // Basic JSON schema validation: check required keys exist
          const pass = validateJsonSchema(parsed, schema)
          return {
            pass,
            score: pass ? 1.0 : 0.0,
            details: pass ? "JSON schema match" : "JSON does not match schema",
            criterion,
          }
        } catch (parseErr) {
          return {
            pass: false,
            score: 0.0,
            details: `JSON parse error: ${parseErr}`,
            criterion,
          }
        }
      }
    }
  } catch (err) {
    return {
      pass: false,
      score: 0.0,
      details: `File check error: ${err}`,
      criterion,
    }
  }
}

function validateJsonSchema(data: unknown, schema: Record<string, unknown>): boolean {
  if (schema.type === "object" && typeof data === "object" && data !== null) {
    const required = schema.required as string[] | undefined
    if (required) {
      for (const key of required) {
        if (!(key in data)) return false
      }
    }
    return true
  }
  if (schema.type === "array" && Array.isArray(data)) return true
  if (schema.type === "string" && typeof data === "string") return true
  if (schema.type === "number" && typeof data === "number") return true
  if (schema.type === "boolean" && typeof data === "boolean") return true
  return false
}

// ---------------------------------------------------------------------------
// Trace formatting (shared with profiler failure diagnostics)
// ---------------------------------------------------------------------------

/**
 * Format agent execution steps into a human-readable trace string.
 */
export function formatAgentTrace(
  steps: AgentStep[],
  opts?: { maxInputLen?: number; maxOutputLen?: number },
): string {
  const maxInput = opts?.maxInputLen ?? 200
  const maxOutput = opts?.maxOutputLen ?? 500
  return steps
    .map((s, i) => {
      const parts = [`Step ${i + 1} (${s.role}):`]
      if (s.text) parts.push(s.text)
      for (const tc of s.toolCalls) {
        parts.push(`  Tool: ${tc.name}(${JSON.stringify(tc.input).slice(0, maxInput)})`)
        if (tc.output) parts.push(`  Output: ${tc.output.slice(0, maxOutput)}`)
      }
      return parts.join("\n")
    })
    .join("\n\n")
}

// ---------------------------------------------------------------------------
// LLM Judge evaluation
// ---------------------------------------------------------------------------

/** Files to exclude when collecting workDir artifacts for the judge */
const JUDGE_EXCLUDED_FILES = new Set([
  "SOUL.md", "BOOTSTRAP.md", "USER.md", "IDENTITY.md", "HEARTBEAT.md",
  "TOOLS.md", "AGENTS.md",
])
const JUDGE_EXCLUDED_DIRS = new Set([".git", ".openclaw", "skills", "node_modules"])

/**
 * Collect text file contents from workDir for the LLM judge.
 * Skips harness files, hidden dirs, and binary files.
 * Limits total output to ~30k chars to stay within context.
 */
export async function collectWorkDirFiles(workDir: string): Promise<string> {
  const MAX_TOTAL = 30_000
  const MAX_PER_FILE = 10_000
  const sections: string[] = []
  let totalLen = 0

  try {
    const entries = await readdir(workDir, { withFileTypes: true, recursive: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (totalLen >= MAX_TOTAL) break

      // Build relative path
      const rel = entry.parentPath
        ? path.relative(workDir, path.join(entry.parentPath, entry.name))
        : entry.name

      // Skip excluded files and dirs
      if (JUDGE_EXCLUDED_FILES.has(entry.name)) continue
      const topDir = rel.split(path.sep)[0]
      if (topDir && JUDGE_EXCLUDED_DIRS.has(topDir)) continue
      if (entry.name.startsWith(".")) continue

      // Skip likely binary files
      const ext = path.extname(entry.name).toLowerCase()
      if ([".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip", ".tar", ".gz", ".bin", ".exe", ".wasm"].includes(ext)) continue

      try {
        const fullPath = entry.parentPath
          ? path.join(entry.parentPath, entry.name)
          : path.join(workDir, entry.name)
        const content = await Bun.file(fullPath).text()
        const trimmed = content.length > MAX_PER_FILE
          ? content.slice(0, MAX_PER_FILE) + `\n... (truncated, ${content.length} total chars)`
          : content
        sections.push(`### ${rel}\n\`\`\`\n${trimmed}\n\`\`\``)
        totalLen += trimmed.length
      } catch { /* skip unreadable files */ }
    }
  } catch { /* workDir may not exist */ }

  return sections.join("\n\n")
}

/**
 * Shared Zod schema for llm-judge responses. The judge is structurally identical
 * across `evaluateLLMJudge` (sync path) and `runDeferredJudge` (async-batch
 * path) — both route through `callJudge`, which routes through
 * `extractStructured`. Layer 1 uses tool_use with this schema (Anthropic,
 * OpenRouter models that advertise tool support); Layer 2 falls back to
 * prompt+parse with retries. That removes the "sonnet answered with prose,
 * JSON.parse threw, silently recorded score=0" failure mode that was tripping
 * llm-judge on ~20% of deferred evaluations.
 */
export const JudgeResponseSchema = z.object({
  // z.coerce.number() runs Number(x) before validation so open-weight models
  // whose function-calling adapter emits `"score": "0.85"` (string) in
  // tool_use arguments still pass schema validation. Anthropic/OpenAI models
  // that honor JSON schema types are unaffected — a real number passes
  // through z.coerce.number() unchanged. Without this the judge call on glm /
  // qwen / yi / deepseek lands in the prompt+parse fallback every call,
  // doubling latency and spamming "tool_use extraction failed" warnings.
  score: z.coerce.number(),
  reasoning: z.string(),
})

export type JudgeResponse = z.infer<typeof JudgeResponseSchema>

export interface JudgeCallResult {
  normalizedScore: number
  reasoning: string
  tokens: TokenUsage
  /** Authoritative cost from the provider, when available. */
  costUsd?: number
}

/**
 * Render a rubric value (string or score-level record) to the prompt-ready
 * flat string form the judge expects. Both the sync and deferred paths format
 * identically so results are reproducible across execution modes.
 */
export function renderRubric(rubric: string | Record<string, string>): string {
  if (typeof rubric === "string") return rubric
  return Object.entries(rubric)
    .sort(([a], [b]) => parseFloat(b) - parseFloat(a))
    .map(([score, desc]) => `Score ${score}: ${desc}`)
    .join("\n")
}

export async function callJudge(opts: {
  llmProvider: LLMProvider
  rubric: string
  maxScore: number
  trace: string
  finalOutput: string
  workDirFiles: string
}): Promise<JudgeCallResult> {
  const { llmProvider, rubric, maxScore, trace, finalOutput, workDirFiles } = opts

  const prompt = `You are an evaluation judge. Score the following agent execution on a scale of 0.0 to ${maxScore}.

## Rubric
${rubric}

## Agent Execution Trace
${trace}

## Final Output
${finalOutput}
${workDirFiles ? `\n## Files Created in Working Directory\n${workDirFiles}` : ""}`

  const { result, tokens, costUsd } = await extractStructured({
    provider: llmProvider,
    schema: JudgeResponseSchema,
    schemaName: "submit_score",
    schemaDescription: "Submit a numeric score and a 1-2 sentence reasoning for the agent execution.",
    prompt,
    // 2048 leaves room for the score field plus 1-2 sentences of reasoning
    // through tool_use envelope overhead. The previous 512 occasionally
    // truncated reasoning mid-string when the prompt+parse fallback was
    // active, surfacing as "Unterminated string in JSON" parse failures.
    maxTokens: 2048,
  })

  const clamped = Math.max(0, Math.min(maxScore, result.score))
  const normalizedScore = maxScore > 0 ? clamped / maxScore : 0
  return { normalizedScore, reasoning: result.reasoning || "No reasoning provided", tokens, costUsd }
}

async function evaluateLLMJudge(
  criterion: Extract<EvalCriterion, { method: "llm-judge" }>,
  runResult: RunResult,
  config: EvaluatorConfig,
): Promise<EvalResult> {
  if (!config.llmProvider) {
    return {
      pass: false,
      score: 0.0,
      details: "LLM judge requires an llmProvider in config",
      criterion,
    }
  }

  const trace = formatAgentTrace(runResult.steps, { maxInputLen: 500, maxOutputLen: 1000 })
  const fileContents = runResult.workDir ? await collectWorkDirFiles(runResult.workDir) : ""
  log.debug(`LLM judge: workDir=${runResult.workDir}, fileContents=${fileContents.length} chars, trace=${trace.length} chars`)

  try {
    const { normalizedScore, reasoning, tokens, costUsd } = await callJudge({
      llmProvider: config.llmProvider,
      rubric: renderRubric(criterion.rubric),
      maxScore: criterion.maxScore,
      trace,
      finalOutput: runResult.text,
      workDirFiles: fileContents,
    })

    config.onJudgeUsage?.(tokens, costUsd)
    log.debug(`LLM judge: normalized=${normalizedScore}`)

    // Monolithic-rubric llm-judge emits a single top-level score; no
    // checkpoints. Future multi-sub-criterion llm-judge would populate
    // `checkpoints` with real sub-scores — until then, leaving checkpoints
    // unset avoids fake noise flowing into jit-optimize evidence.
    return {
      pass: normalizedScore >= 0.5,
      score: normalizedScore,
      details: reasoning,
      criterion,
    }
  } catch (err) {
    // Infrastructure failures (provider down, auth, rate limit, headless
    // agent crash) are flagged via `infraError`. Downstream aggregators
    // (jit-optimize avgScore, round-abort check) exclude these rather than
    // averaging score=0 into the quality signal — otherwise a flaky provider
    // would look like a broken skill and send jit-optimize into a spiral.
    if (isProviderError(err) || isHeadlessAgentError(err)) {
      log.error(`LLM judge infrastructure error: ${err}`)
      return {
        pass: false,
        score: 0.0,
        details: `LLM judge infrastructure error: ${err instanceof Error ? err.message : String(err)}`,
        infraError: err instanceof Error ? err.message : String(err),
        criterion,
      }
    }
    log.warn(`LLM judge error: ${err}`)
    return {
      pass: false,
      score: 0.0,
      details: `LLM judge error: ${err}`,
      criterion,
    }
  }
}

// ---------------------------------------------------------------------------
// Custom evaluation
// ---------------------------------------------------------------------------

async function evaluateCustom(
  criterion: Extract<EvalCriterion, { method: "custom" }>,
  runResult: RunResult,
): Promise<EvalResult> {
  const evaluator = customEvaluators.get(criterion.evaluatorId)
  if (!evaluator) {
    return {
      pass: false,
      score: 0.0,
      details: `Custom evaluator not found: ${criterion.evaluatorId}. Did you forget a side-effect import in src/bench/evaluators/index.ts?`,
      criterion,
    }
  }

  // The evaluator's `run` returns everything except `criterion`. The
  // framework owns criterion attachment so id/name/weight/payload declared
  // on the task-level criterion always flow through to downstream consumers.
  const result = await evaluator.run({ criterion, runResult })
  return { ...result, criterion }
}
