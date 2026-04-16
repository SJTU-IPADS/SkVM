import { z } from "zod"
import type { ToolCall } from "../core/types.ts"
import type { LLMProvider } from "../providers/types.ts"
import type { BeforeLLMHook, BeforeLLMContext, BeforeLLMResult, AfterLLMHook, AfterLLMContext } from "../runtime/types.ts"
import type { BoostCandidate, ParamDef, SolidificationEntry, SolidificationState } from "./types.ts"
import { normalizeParamDef } from "./types.ts"
import { extractStructured } from "../providers/structured.ts"
import { createLogger } from "../core/logger.ts"

const log = createLogger("solidifier")

const DEFAULT_PROMOTION_THRESHOLD = 3
const DEFAULT_DEMOTION_THRESHOLD = 3

/**
 * Process-lifetime counter of runtime LLM param-extraction failures. Bumped
 * every time `extractParamsFromPrompt` catches an error from its LLM step.
 * Exposed for tests and for future metric scraping. Zero means the runtime
 * hot path has been healthy this process.
 */
export let runtimeExtractionFailureCount = 0

/** Reset the counter — intended for tests. */
export function resetRuntimeExtractionFailureCount(): void {
  runtimeExtractionFailureCount = 0
}

/** Default tools monitored for signature matching */
const DEFAULT_MONITORED_TOOLS = new Set(["execute_command", "write_file", "web_fetch"])

/**
 * Extract monitorable content from a tool call.
 * For known tools, extracts the relevant field; for others, stringifies all args.
 */
function extractMonitorableContent(tc: { name: string; arguments: Record<string, unknown> }): string {
  if (tc.name === "execute_command") return (tc.arguments.command as string) ?? ""
  if (tc.name === "write_file") return (tc.arguments.content as string) ?? ""
  return JSON.stringify(tc.arguments)
}

/**
 * Code Solidification Engine
 *
 * Stage 2 (afterLLM hook): monitors LLM responses for code signature matches
 * Stage 3 (beforeLLM hook): executes promoted templates, bypassing LLM
 */
export class Solidifier {
  private entries: Map<string, SolidificationEntry> = new Map()
  private defaultMonitoredTools: Set<string>
  private promotionThreshold: number
  private demotionThreshold: number
  private llmProvider?: LLMProvider

  constructor(
    candidates: BoostCandidate[],
    opts?: {
      savedState?: SolidificationState
      monitoredTools?: Set<string>
      promotionThreshold?: number
      demotionThreshold?: number
      llmProvider?: LLMProvider
    },
  ) {
    this.defaultMonitoredTools = opts?.monitoredTools ?? DEFAULT_MONITORED_TOOLS
    this.promotionThreshold = opts?.promotionThreshold ?? DEFAULT_PROMOTION_THRESHOLD
    this.demotionThreshold = opts?.demotionThreshold ?? DEFAULT_DEMOTION_THRESHOLD
    this.llmProvider = opts?.llmProvider

    if (opts?.savedState) {
      // Restore from persisted state
      for (const entry of opts.savedState.entries) {
        this.entries.set(entry.candidate.purposeId, {
          candidate: entry.candidate,
          state: entry.state,
          promotedAt: entry.promotedAt,
        })
      }
      log.info(`Solidifier restored ${opts.savedState.entries.length} entries from persisted state`)
    } else {
      // Initialize fresh from candidates
      for (const c of candidates) {
        this.entries.set(c.purposeId, {
          candidate: c,
          state: {
            candidateId: c.purposeId,
            hitCount: 0,
            consecutiveMatches: 0,
            promoted: false,
            fallbackCount: 0,
          },
        })
      }
      log.info(`Solidifier initialized with ${candidates.length} candidates`)
    }
  }

  /** Get current state of all entries (for persistence/debugging) */
  getEntries(): SolidificationEntry[] {
    return [...this.entries.values()]
  }

  /** Export state for persistence to disk */
  exportState(skillId: string): SolidificationState {
    return {
      skillId,
      entries: this.getEntries().map((e) => ({
        candidate: e.candidate,
        state: e.state,
        promotedAt: e.promotedAt,
      })),
      updatedAt: new Date().toISOString(),
    }
  }

  /** Import state from disk */
  importState(state: SolidificationState): void {
    this.entries.clear()
    for (const entry of state.entries) {
      this.entries.set(entry.candidate.purposeId, {
        candidate: entry.candidate,
        state: entry.state,
        promotedAt: entry.promotedAt,
      })
    }
    log.info(`Solidifier imported ${state.entries.length} entries`)
  }

  /**
   * Stage 2: afterLLM hook — monitor tool calls for code signature matches.
   */
  createAfterLLMHook(): AfterLLMHook {
    return async (ctx: AfterLLMContext) => {
      for (const tc of ctx.response.toolCalls) {
        const content = extractMonitorableContent(tc)

        for (const [purposeId, entry] of this.entries) {
          const candidateTools = entry.candidate.monitoredTools
            ? new Set(entry.candidate.monitoredTools)
            : this.defaultMonitoredTools
          if (!candidateTools.has(tc.name)) continue
          if (entry.state.promoted) continue

          try {
            const regex = new RegExp(entry.candidate.codeSignature, "i")
            if (regex.test(content)) {
              entry.state.hitCount++
              entry.state.consecutiveMatches++
              log.debug(`Signature match: ${purposeId} (consecutive=${entry.state.consecutiveMatches})`)

              if (entry.state.consecutiveMatches >= this.promotionThreshold) {
                entry.state.promoted = true
                entry.promotedAt = new Date().toISOString()
                log.info(`PROMOTED: ${purposeId} after ${entry.state.consecutiveMatches} consecutive matches`)
              }
            } else {
              if (entry.state.consecutiveMatches > 0) {
                log.debug(`Consecutive reset: ${purposeId} (was ${entry.state.consecutiveMatches})`)
              }
              entry.state.consecutiveMatches = 0
            }
          } catch {
            // Invalid regex, skip
          }
        }
      }
    }
  }

  /**
   * Stage 3: beforeLLM hook — execute promoted templates.
   *
   * If the user prompt matches a promoted candidate's keywords,
   * extract parameters and execute the template directly.
   */
  createBeforeLLMHook(): BeforeLLMHook {
    return async (ctx: BeforeLLMContext): Promise<BeforeLLMResult> => {
      for (const [purposeId, entry] of this.entries) {
        if (!entry.state.promoted) continue

        // Check keywords
        const promptLower = ctx.prompt.toLowerCase()
        const keywordMatch = entry.candidate.keywords.some((kw) =>
          promptLower.includes(kw.toLowerCase())
        )
        if (!keywordMatch) continue

        try {
          const extraction = await extractParamsFromPrompt(ctx.prompt, entry.candidate, {
            llmProvider: this.llmProvider,
          })

          if (!extraction.complete) {
            log.info(`Solidified ${purposeId}: param extraction failed (${extraction.method}), falling back to agent`)
            continue
          }

          const code = instantiateTemplate(entry.candidate.functionTemplate, extraction.params)

          // Safety check: if any ${param} placeholder is still unfilled, fall back
          if (/\$\{[^}]+\}/.test(code)) {
            log.info(`Solidified ${purposeId}: unfilled params after ${extraction.method}, falling back to agent`)
            continue
          }

          log.info(`Solidified execution: ${purposeId} (params via ${extraction.method}, params=${JSON.stringify(extraction.params)})`)
          log.debug(`Solidified code:\n${code.slice(0, 300)}`)

          const result = await executeTemplate(
            code,
            entry.candidate.materializationType,
            ctx.workDir,
          )

          if (result.success) {
            const toolCall: ToolCall = {
              id: `boost-${purposeId}-${Date.now()}`,
              name: "execute_command",
              input: { command: code },
              output: result.output,
              durationMs: result.durationMs,
              exitCode: 0,
            }
            return {
              action: "replace",
              toolResults: [toolCall],
              text: result.output,
            }
          } else {
            // Fallback: execution failed, let LLM handle it
            entry.state.fallbackCount++
            log.warn(`Solidified execution failed for ${purposeId} (fallback #${entry.state.fallbackCount}): ${result.output.slice(0, 800).replace(/\n/g, " | ")}`)

            if (entry.state.fallbackCount >= this.demotionThreshold) {
              entry.state.promoted = false
              entry.state.consecutiveMatches = 0
              log.warn(`Demoted ${purposeId} after ${entry.state.fallbackCount} fallbacks`)
            }
          }
        } catch (err) {
          entry.state.fallbackCount++
          log.warn(`Solidification error for ${purposeId}: ${err}`)
        }
      }

      return { action: "passthrough" }
    }
  }
}

// ---------------------------------------------------------------------------
// Dual-method param extraction: regex → LLM → fail
// ---------------------------------------------------------------------------

interface ExtractionResult {
  params: Record<string, string>
  complete: boolean
  method: "regex" | "llm" | "none"
}

/**
 * Extract parameters from a user prompt using a two-step pipeline:
 * 1. Regex: use per-param extractPattern from the candidate definition
 * 2. LLM: call a small model with param descriptions (if provider available)
 * Returns { complete: false } if neither method can fill all params.
 */
export async function extractParamsFromPrompt(
  prompt: string,
  candidate: BoostCandidate,
  opts?: { llmProvider?: LLMProvider },
): Promise<ExtractionResult> {
  const paramEntries = Object.entries(candidate.params)
  if (paramEntries.length === 0) {
    return { params: {}, complete: true, method: "regex" }
  }

  // Normalize all param defs
  const defs: Record<string, ParamDef> = {}
  for (const [name, value] of paramEntries) {
    defs[name] = normalizeParamDef(name, value)
  }

  // Step 1: Regex extraction
  const regexParams = extractViaRegex(prompt, defs)
  if (Object.keys(regexParams).length === paramEntries.length) {
    return { params: regexParams, complete: true, method: "regex" }
  }

  // Step 2: LLM extraction (if provider available).
  //
  // This is a **runtime hot path** — it runs during user inference. If the
  // provider is unreachable we intentionally degrade to passthrough (let the
  // agent handle the request normally) rather than hard-failing, because the
  // user's request would otherwise crash. But we log at `error` level so
  // infra failures are observable, and bump a counter so misconfigurations
  // don't hide silently behind `log.warn`.
  if (opts?.llmProvider) {
    try {
      const llmParams = await extractViaLLM(prompt, defs, opts.llmProvider)
      if (llmParams && Object.keys(llmParams).length === paramEntries.length) {
        return { params: llmParams, complete: true, method: "llm" }
      }
    } catch (err) {
      runtimeExtractionFailureCount++
      log.error(`LLM param extraction failed (runtime): ${err} — total failures: ${runtimeExtractionFailureCount}`)
    }
  }

  return { params: {}, complete: false, method: "none" }
}

/**
 * Step 1: Extract params via per-param regex patterns.
 * Only extracts params that have extractPattern defined.
 */
function extractViaRegex(
  prompt: string,
  defs: Record<string, ParamDef>,
): Record<string, string> {
  const params: Record<string, string> = {}

  for (const [name, def] of Object.entries(defs)) {
    if (!def.extractPattern) continue
    try {
      const match = prompt.match(new RegExp(def.extractPattern, "i"))
      if (match?.[1]) {
        params[name] = match[1].trim()
      }
    } catch {
      // Invalid regex, skip
    }
  }

  return params
}

/**
 * Step 2: Extract params by calling a small LLM with param descriptions.
 * Returns null if the LLM can't determine all values.
 */
async function extractViaLLM(
  prompt: string,
  defs: Record<string, ParamDef>,
  provider: LLMProvider,
): Promise<Record<string, string> | null> {
  // Build dynamic Zod schema from param definitions
  const schemaShape: Record<string, z.ZodType> = {}
  const paramDescriptions: string[] = []

  for (const [name, def] of Object.entries(defs)) {
    schemaShape[name] = def.type === "number" ? z.number().nullable() : z.string().nullable()
    paramDescriptions.push(`- ${name}: ${def.description} (${def.type})`)
  }

  const schema = z.object(schemaShape)

  const extractPrompt = `Given this user request:

"${prompt}"

Extract the following parameters. Return null for any parameter you cannot determine from the request.

Parameters:
${paramDescriptions.join("\n")}`

  const { result } = await extractStructured({
    provider,
    schema,
    schemaName: "extract_params",
    schemaDescription: "Extract parameter values from a user prompt",
    prompt: extractPrompt,
    maxTokens: 256,
  })

  // Check all params are non-null
  const params: Record<string, string> = {}
  for (const [name] of Object.entries(defs)) {
    const value = (result as Record<string, unknown>)[name]
    if (value === null || value === undefined) return null
    params[name] = String(value)
  }

  return params
}

/**
 * Replace ${param} placeholders in a template with extracted values.
 */
export function instantiateTemplate(
  template: string,
  params: Record<string, string>,
): string {
  let result = template
  for (const [key, value] of Object.entries(params)) {
    result = result.replaceAll(`\${${key}}`, value)
  }
  return result
}

/**
 * Execute a solidified code template.
 */
async function executeTemplate(
  code: string,
  type: "shell" | "python",
  workDir: string,
): Promise<{ success: boolean; output: string; durationMs: number }> {
  const start = performance.now()

  try {
    let proc: ReturnType<typeof Bun.spawn>

    if (type === "shell") {
      proc = Bun.spawn(["sh", "-c", code], {
        cwd: workDir,
        stdout: "pipe",
        stderr: "pipe",
      })
    } else {
      const scriptPath = `${workDir}/_boost_solidified.py`
      await Bun.write(scriptPath, code)
      proc = Bun.spawn(["python3", scriptPath], {
        cwd: workDir,
        stdout: "pipe",
        stderr: "pipe",
      })
    }

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ])
    const durationMs = performance.now() - start

    return {
      success: exitCode === 0,
      output: stdout + (stderr ? `\nstderr: ${stderr}` : ""),
      durationMs,
    }
  } catch (err) {
    return {
      success: false,
      output: `Error: ${err}`,
      durationMs: performance.now() - start,
    }
  }
}
