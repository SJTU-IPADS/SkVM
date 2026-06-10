/**
 * RunRecordBuilder — the single owner of the events → RunResult invariants
 * shared by every harness adapter: step assembly, tool-call pairing, token
 * accumulation, cost fallback, and the final-text policy.
 *
 * Each adapter keeps its own event loop (the transcript shapes are genuinely
 * heterogeneous — NDJSON streams, session-export JSON, JSON-RPC history) and
 * feeds the builder; the builder owns everything format-independent.
 *
 * Final-text policy: the last non-empty `assistantText()` wins. If no plain
 * assistant text was ever recorded, the last assistant step with non-empty
 * text (including text accompanying `assistantToolCalls()`) is used.
 *
 * Usage availability: calling `usage()` or `cost()` at all marks telemetry
 * as available — a reported zero is a true zero. A builder that never saw
 * either finishes with `usageAvailable: false`, so consumers can render
 * "n/a" instead of a misleading $0 (e.g. harnesses that never persist usage).
 */

import { emptyTokenUsage, addTokenUsage } from "./types.ts"
import type { AgentStep, RunResult, RunStatus, TokenUsage, ToolCall } from "./types.ts"

export interface ToolCallSpec {
  id: string
  name: string
  input?: Record<string, unknown>
  output?: string
  exitCode?: number
}

export interface RunRecordFinishOptions {
  workDir: string
  durationMs: number
  llmDurationMs?: number
  /**
   * The run-level verdict. Each field, when set, beats the parser-level
   * default recorded via `parseNote()`; when absent, the parser default
   * survives (runStatus falls back to "ok").
   */
  runStatus?: RunStatus
  statusDetail?: string
  skillLoaded?: boolean
  adapterError?: RunResult["adapterError"]
}

/**
 * Parser-level verdict defaults — what the transcript alone reveals. The
 * same fields on `RunRecordFinishOptions` beat these one by one.
 */
export type ParseNote = Pick<RunRecordFinishOptions, "runStatus" | "statusDetail" | "adapterError">

/**
 * Transcript-format dialect, stated once at construction. These are
 * properties of a harness's transcript shape, not of individual turns.
 */
export interface RunRecordDialect {
  /**
   * Text on a tool-call assistant turn claims the final text (openclaw,
   * claude-code, pi). Default false: hermes-style, where only plain
   * assistant messages own the final text and tool-call turn text
   * participates in the fallback scan.
   */
  toolCallTextIsFinal?: boolean
  /**
   * Record a standalone tool step even when a result paired with a
   * registered call (hermes, jiuwenclaw). Default true; claude-code sets
   * false — results live only on the originating call.
   */
  stepForPairedToolResult?: boolean
}

export class RunRecordBuilder {
  private steps: AgentStep[] = []
  private tokens: TokenUsage = emptyTokenUsage()
  private usageTotal: TokenUsage | undefined
  private totalCost = 0
  private usageSeen = false
  private explicitFinalText = ""
  private fallbackFinalText = ""
  private note: ParseNote = {}
  private pendingCalls = new Map<string, ToolCall>()

  constructor(private readonly dialect: RunRecordDialect = {}) {}

  /** Plain assistant text. Empty text is ignored. Last non-empty wins as `RunResult.text`. */
  assistantText(text: string, timestamp: number): this {
    if (!text) return this
    this.explicitFinalText = text
    this.steps.push({ role: "assistant", text, toolCalls: [], timestamp })
    return this
  }

  /**
   * Assistant turn that requests tool calls. Registers each id so a later
   * `toolResult()` can enrich the call with its output. Whether accompanying
   * text claims the final text is the `toolCallTextIsFinal` dialect.
   */
  assistantToolCalls(
    calls: Array<Pick<ToolCallSpec, "id" | "name" | "input">>,
    opts: { text?: string; timestamp: number },
  ): this {
    const toolCalls = calls.map((c) => {
      const tc: ToolCall = { id: c.id, name: c.name, input: c.input ?? {} }
      this.pendingCalls.set(c.id, tc)
      return tc
    })
    if (this.dialect.toolCallTextIsFinal && opts.text) this.explicitFinalText = opts.text
    this.steps.push({ role: "assistant", text: opts.text, toolCalls, timestamp: opts.timestamp })
    return this
  }

  /**
   * Completed tool invocation(s) recorded in one shot (call and output known
   * together), as a single tool step.
   */
  toolStep(calls: ToolCallSpec[], timestamp: number): this {
    this.steps.push({ role: "tool", toolCalls: calls.map(specToToolCall), timestamp })
    return this
  }

  /**
   * Result for a tool call. If `id` matches a call registered via
   * `assistantToolCalls()`, that call is enriched with the output/exitCode.
   * Whether a paired result ALSO records a standalone tool step is the
   * `stepForPairedToolResult` dialect; unpaired ids always get a step.
   */
  toolResult(
    id: string,
    result: { name?: string; output?: string; exitCode?: number },
    timestamp: number,
  ): this {
    const pending = this.pendingCalls.get(id)
    if (pending) {
      if (result.output !== undefined) pending.output = result.output
      if (result.exitCode !== undefined) pending.exitCode = result.exitCode
      if (this.dialect.stepForPairedToolResult === false) return this
    }
    this.steps.push({
      role: "tool",
      toolCalls: [specToToolCall({
        id,
        name: result.name ?? pending?.name ?? "unknown",
        output: result.output,
        exitCode: result.exitCode,
      })],
      timestamp,
    })
    return this
  }

  /** Accumulate token usage. Calling this at all marks usage as available. */
  usage(u: Partial<TokenUsage>): this {
    this.usageSeen = true
    this.tokens = addTokenUsage(this.tokens, {
      input: u.input ?? 0,
      output: u.output ?? 0,
      cacheRead: u.cacheRead ?? 0,
      cacheWrite: u.cacheWrite ?? 0,
    })
    return this
  }

  /**
   * Authoritative end-of-run token aggregate. When set (and non-zero), it
   * beats whatever `usage()` accumulated — for harnesses whose final result
   * event includes server-side accounting that per-message sums miss
   * (claude-code). A zero total is ignored: the accumulated sums are the
   * safer number for partial/interrupted runs.
   */
  usageTotalOverride(t: TokenUsage): this {
    this.usageSeen = true
    const total = t.input + t.output + t.cacheRead + t.cacheWrite
    if (total > 0) this.usageTotal = t
    return this
  }

  /**
   * Final-text fallback of last resort — used when no explicit final text
   * was recorded and no assistant step carries text. For harnesses whose
   * final answer can live outside the step stream (claude-code's result
   * event, jiuwenclaw's stream deltas).
   */
  textFallback(text: string): this {
    if (text) this.fallbackFinalText = text
    return this
  }

  /**
   * Parser-level verdict defaults — what the transcript alone reveals
   * (e.g. "no parseable events", error events with no output). Each field
   * survives unless the same field is set in `finish()`'s options, where the
   * run-level verdict (timeout, non-zero exit) takes precedence.
   */
  parseNote(note: ParseNote): this {
    this.note = { ...this.note, ...note }
    return this
  }

  /** Accumulate cost (USD). Calling this at all marks usage as available. */
  cost(c: number): this {
    this.usageSeen = true
    this.totalCost += c
    return this
  }

  get stepCount(): number {
    return this.steps.length
  }

  /** Read-only view of the accumulated steps (skill-detection scans, tests). */
  get stepsSoFar(): readonly AgentStep[] {
    return this.steps
  }

  /** The final text as it would resolve if `finish()` were called now. */
  previewText(): string {
    return this.explicitFinalText || this.stepScanText() || this.fallbackFinalText
  }

  finish(opts: RunRecordFinishOptions): RunResult {
    const statusDetail = opts.statusDetail ?? this.note.statusDetail
    const adapterError = opts.adapterError ?? this.note.adapterError
    return {
      text: this.previewText(),
      steps: this.steps,
      tokens: this.usageTotal ?? this.tokens,
      cost: this.totalCost,
      durationMs: opts.durationMs,
      llmDurationMs: opts.llmDurationMs ?? 0,
      workDir: opts.workDir,
      runStatus: opts.runStatus ?? this.note.runStatus ?? "ok",
      usageAvailable: this.usageSeen,
      ...(statusDetail ? { statusDetail } : {}),
      ...(opts.skillLoaded !== undefined ? { skillLoaded: opts.skillLoaded } : {}),
      ...(adapterError ? { adapterError } : {}),
    }
  }

  private stepScanText(): string {
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const s = this.steps[i]!
      if (s.role === "assistant" && s.text) return s.text
    }
    return ""
  }
}

/**
 * Minimal record for reduced-telemetry paths: a single block of assistant
 * text, no usage — finishes with usageAvailable: false rather than a fake
 * $0. `statusDetail` is a parser-level note; the `finish()` verdict beats it.
 */
export function minimalRecord(text: string, statusDetail?: string): RunRecordBuilder {
  const builder = new RunRecordBuilder()
  if (text) builder.assistantText(text, Date.now())
  if (statusDetail) builder.parseNote({ statusDetail })
  return builder
}

/**
 * Read `RunResult.usageAvailable` through this accessor. Absent means the
 * result came from an adapter not yet migrated to RunRecordBuilder and is
 * treated as available; only an explicit `false` means the harness reported
 * no usage telemetry at all.
 */
export function hasUsageTelemetry(r: Pick<RunResult, "usageAvailable">): boolean {
  return r.usageAvailable !== false
}

function specToToolCall(call: ToolCallSpec): ToolCall {
  return {
    id: call.id,
    name: call.name,
    input: call.input ?? {},
    ...(call.output !== undefined ? { output: call.output } : {}),
    ...(call.exitCode !== undefined ? { exitCode: call.exitCode } : {}),
  }
}
