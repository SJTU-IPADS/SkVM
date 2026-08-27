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

/** A template execution served in place of an LLM call. */
export interface ServeEvent {
  purposeId: string
  /** Template execution time only. */
  durationMs: number
  /** Param-extraction time (regex or LLM) spent before the template ran. */
  extractionMs: number
  extractionMethod: "regex" | "llm"
  /** LLM tokens spent on extraction; zeros for regex extraction. */
  extractionTokens: { input: number; output: number }
}

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

/** Cap on the per-candidate miss-observation buffer (most recent kept) */
const MAX_MISS_OBSERVATIONS = 24

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
  private matchGranularity: "tool-call" | "run"
  /** purposeIds that matched at least once during the current run (run granularity only) */
  private runMatched = new Set<string>()
  /**
   * Template executions served since the last drain (for experiment drivers).
   * Carries the FULL serve-path cost: template execution plus the param
   * extraction that preceded it — LLM-assisted extraction spends real time
   * and tokens, and hiding it would overstate the saving.
   */
  private serveEvents: ServeEvent[] = []
  /** Monitored tool-call contents seen during the current run (run granularity only) */
  private runObservations: { tool: string; content: string }[] = []
  /** Monotonic run index stamped onto observations (run granularity only) */
  private runCounter = 0
  /**
   * Per-candidate refinement evidence: cumulative count of non-matching runs
   * (NOT reset by an interleaved match — alternating match/miss is precisely
   * the "signature covers only half the pattern space" case refinement fixes)
   * plus a rolling buffer of recent observations from matched AND missed runs,
   * so a refiner sees every behavior variant. Each observation is tagged with
   * its run index so a validator can reason per run, not per tool call.
   */
  private missLog = new Map<string, { missRuns: number; observations: { tool: string; content: string; run: number }[] }>()

  constructor(
    candidates: BoostCandidate[],
    opts?: {
      savedState?: SolidificationState
      monitoredTools?: Set<string>
      promotionThreshold?: number
      demotionThreshold?: number
      llmProvider?: LLMProvider
      /**
       * "tool-call" (default): every monitored tool call increments/resets the
       * consecutive counter — promotion can happen mid-run.
       * "run": afterLLM only marks candidates as matched; the driver calls
       * finalizeRun() once per agent run to fold marks into the counters.
       * Gives per-invocation promotion semantics.
       */
      matchGranularity?: "tool-call" | "run"
    },
  ) {
    this.defaultMonitoredTools = opts?.monitoredTools ?? DEFAULT_MONITORED_TOOLS
    this.promotionThreshold = opts?.promotionThreshold ?? DEFAULT_PROMOTION_THRESHOLD
    this.demotionThreshold = opts?.demotionThreshold ?? DEFAULT_DEMOTION_THRESHOLD
    this.llmProvider = opts?.llmProvider
    this.matchGranularity = opts?.matchGranularity ?? "tool-call"

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
   * Fold the current run's matches into the promotion counters.
   * Only meaningful in "run" granularity — a no-op otherwise. Call once after
   * each agent run; a run with zero matches resets the consecutive counter.
   */
  /**
   * Close one agent run: fold this run's marks into the counters.
   *
   * Call it EXACTLY once per run. A run with no marks is a real miss (the agent
   * made no monitored tool call) and must reset the streak, so this cannot infer
   * from emptiness whether a run happened — skipping it credits this run's marks
   * to the next one, and calling it twice invents an empty run that breaks any
   * retro-promotion streak spanning it. `createBoostHooks` wires it to the
   * runtime's `afterRun` hook so callers do not have to remember; drivers that
   * construct a Solidifier directly own the call.
   */
  finalizeRun(): void {
    if (this.matchGranularity !== "run") return
    this.runCounter++
    for (const [purposeId, entry] of this.entries) {
      if (entry.state.promoted) continue
      const miss = this.missLog.get(purposeId) ?? { missRuns: 0, observations: [] }
      miss.observations.push(...this.runObservations.map((o) => ({ ...o, run: this.runCounter })))
      if (miss.observations.length > MAX_MISS_OBSERVATIONS) {
        miss.observations.splice(0, miss.observations.length - MAX_MISS_OBSERVATIONS)
      }
      if (this.runMatched.has(purposeId)) {
        entry.state.hitCount++
        entry.state.consecutiveMatches++
        log.debug(`Run match: ${purposeId} (consecutive=${entry.state.consecutiveMatches})`)
        if (entry.state.consecutiveMatches >= this.promotionThreshold) {
          entry.state.promoted = true
          entry.promotedAt = new Date().toISOString()
          log.info(`PROMOTED: ${purposeId} after ${entry.state.consecutiveMatches} consecutive matched runs`)
        }
      } else {
        if (entry.state.consecutiveMatches > 0) {
          log.debug(`Consecutive reset: ${purposeId} (was ${entry.state.consecutiveMatches})`)
        }
        entry.state.consecutiveMatches = 0
        miss.missRuns++
      }
      this.missLog.set(purposeId, miss)
    }
    this.runMatched.clear()
    this.runObservations = []
  }

  /**
   * Refinement evidence for a candidate: how many runs its signature has
   * missed in total, and the agent's recent tool-call contents (from matched
   * and missed runs alike — a refiner needs to see every behavior variant).
   */
  getMissInfo(purposeId: string): { missRuns: number; observations: { tool: string; content: string; run: number }[] } {
    const miss = this.missLog.get(purposeId)
    return miss ? { missRuns: miss.missRuns, observations: [...miss.observations] } : { missRuns: 0, observations: [] }
  }

  /**
   * Swap in a refined candidate.
   *
   * Default: promotion state is reset — the new signature must re-earn its
   * consecutive matches. With `creditObservedRuns`, the gate is REPLAYED
   * against the recorded runs instead: the trailing consecutive runs the new
   * signature covers count as matches (they are real executions — the same
   * evidence the gate collects prospectively), so a signature that already
   * covers the last N observed runs promotes immediately. Template-execution
   * risk is unchanged either way: serving is still guarded by the
   * fallback/demotion path.
   */
  replaceCandidate(
    purposeId: string,
    candidate: BoostCandidate,
    opts?: { creditObservedRuns?: boolean },
  ): void {
    const entry = this.entries.get(purposeId)
    if (!entry) {
      log.warn(`replaceCandidate: no entry for ${purposeId}`)
      return
    }

    let credited = 0
    if (opts?.creditObservedRuns) {
      const observations = this.missLog.get(purposeId)?.observations ?? []
      try {
        const regex = new RegExp(candidate.codeSignature, "i")
        // Same tool filter the live gate applies in afterLLM. Without it the
        // replay is MORE permissive than the gate it replays: a candidate that
        // only monitors execute_command could be credited for matches found in
        // web_fetch calls, promoting on evidence its own live path rejects.
        const monitored = candidate.monitoredTools?.length
          ? new Set(candidate.monitoredTools)
          : this.defaultMonitoredTools
        const coveredByRun = new Map<number, boolean>()
        for (const o of observations) {
          const covered = monitored.has(o.tool) && regex.test(o.content)
          coveredByRun.set(o.run, (coveredByRun.get(o.run) ?? false) || covered)
        }
        // Credit only a gap-free streak of covered runs ending at the most
        // recent completed run. A run with no observations (the agent made no
        // monitored tool calls) was a miss, and the consecutive gate must not
        // step over it — otherwise runs 1 and 3 would count as a 2-run streak.
        let expected = this.runCounter
        const runsDescending = [...coveredByRun.keys()].sort((a, b) => b - a)
        for (const run of runsDescending) {
          if (run !== expected || !coveredByRun.get(run)) break
          credited++
          expected--
        }
      } catch {
        // Invalid regex — no credit; the caller's validation should have caught this.
      }
    }

    entry.candidate = candidate
    entry.state.consecutiveMatches = credited
    // hitCount is not incremented here: those runs were already counted as they
    // happened (finalizeRun), and adding them again double-counts the same
    // executions in the stat the driver reports.
    entry.state.promoted = false
    entry.state.fallbackCount = 0
    entry.promotedAt = undefined
    if (credited >= this.promotionThreshold) {
      entry.state.promoted = true
      entry.promotedAt = new Date().toISOString()
      log.info(`PROMOTED (retroactive): ${purposeId} — refined signature covers the last ${credited} observed runs`)
    } else if (credited > 0) {
      log.info(`Candidate refined for ${purposeId} with ${credited} retroactive matches (threshold ${this.promotionThreshold})`)
    }
    this.missLog.delete(purposeId)
    log.info(`Candidate refined for ${purposeId}: signature="${candidate.codeSignature.slice(0, 80)}"`)
  }

  /** Return and clear the template executions served since the last drain. */
  drainServeEvents(): ServeEvent[] {
    const events = this.serveEvents
    this.serveEvents = []
    return events
  }

  /**
   * Stage 2: afterLLM hook — monitor tool calls for code signature matches.
   */
  createAfterLLMHook(): AfterLLMHook {
    return async (ctx: AfterLLMContext) => {
      for (const tc of ctx.response.toolCalls) {
        const content = extractMonitorableContent(tc)

        if (this.matchGranularity === "run" && content) {
          this.runObservations.push({ tool: tc.name, content: content.slice(0, 2000) })
        }

        for (const [purposeId, entry] of this.entries) {
          const candidateTools = entry.candidate.monitoredTools
            ? new Set(entry.candidate.monitoredTools)
            : this.defaultMonitoredTools
          if (!candidateTools.has(tc.name)) continue
          if (entry.state.promoted) continue

          try {
            const regex = new RegExp(entry.candidate.codeSignature, "i")
            if (regex.test(content)) {
              if (this.matchGranularity === "run") {
                this.runMatched.add(purposeId)
                continue
              }
              entry.state.hitCount++
              entry.state.consecutiveMatches++
              log.debug(`Signature match: ${purposeId} (consecutive=${entry.state.consecutiveMatches})`)

              if (entry.state.consecutiveMatches >= this.promotionThreshold) {
                entry.state.promoted = true
                entry.promotedAt = new Date().toISOString()
                log.info(`PROMOTED: ${purposeId} after ${entry.state.consecutiveMatches} consecutive matches`)
              }
            } else {
              // In run granularity a miss on one tool call must not erase a hit
              // from another call in the same run — resets happen in finalizeRun().
              if (this.matchGranularity === "run") continue
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
          const extractStart = performance.now()
          const extraction = await extractParamsFromPrompt(ctx.prompt, entry.candidate, {
            llmProvider: this.llmProvider,
          })
          const extractionMs = performance.now() - extractStart

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
            this.serveEvents.push({
              purposeId,
              durationMs: result.durationMs,
              extractionMs,
              extractionMethod: extraction.method === "llm" ? "llm" : "regex",
              extractionTokens: extraction.tokens ?? { input: 0, output: 0 },
            })
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
  /** LLM tokens spent on extraction; absent when no LLM call was made. */
  tokens?: { input: number; output: number }
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
      const llm = await extractViaLLM(prompt, defs, opts.llmProvider)
      if (llm.params && Object.keys(llm.params).length === paramEntries.length) {
        return { params: llm.params, complete: true, method: "llm", tokens: llm.tokens }
      }
      // A failed extraction still called the model. Returning its tokens keeps
      // that spend on the record instead of charging it to nobody — the whole
      // point of accounting the serve path is that it is not free.
      return { params: {}, complete: false, method: "llm", tokens: llm.tokens }
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
      // A whitespace-only capture is not an extraction. `match[1]` is truthy for
      // "  ", and trimming it afterwards produced an empty param that still
      // counted as complete — so `search for  in the repo` served
      // `grep -r '' .` and dumped unrelated files as the answer.
      const value = match?.[1]?.trim()
      if (value) {
        params[name] = value
      }
    } catch {
      // Invalid regex, skip
    }
  }

  return params
}

/**
 * Step 2: Extract params by calling a small LLM with param descriptions.
 * `params` is null if the LLM can't determine all values; `tokens` reports
 * what the call cost either way.
 */
async function extractViaLLM(
  prompt: string,
  defs: Record<string, ParamDef>,
  provider: LLMProvider,
): Promise<{ params: Record<string, string> | null; tokens: { input: number; output: number } }> {
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

  const { result, tokens } = await extractStructured({
    provider,
    schema,
    schemaName: "extract_params",
    schemaDescription: "Extract parameter values from a user prompt",
    prompt: extractPrompt,
    maxTokens: 256,
  })
  const spent = { input: tokens.input, output: tokens.output }

  // Check all params are non-null
  const params: Record<string, string> = {}
  for (const [name] of Object.entries(defs)) {
    const value = (result as Record<string, unknown>)[name]
    if (value === null || value === undefined) return { params: null, tokens: spent }
    // Same rule as the regex path: an empty or whitespace-only value is not an
    // extraction, and serving a template with one substitutes nothing where a
    // real argument belonged.
    const text = String(value).trim()
    if (text.length === 0) return { params: null, tokens: spent }
    params[name] = text
  }

  return { params, tokens: spent }
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
