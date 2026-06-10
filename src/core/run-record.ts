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
  /** Defaults to "ok" — adapters override for timeout/crash paths. */
  runStatus?: RunStatus
  statusDetail?: string
  skillLoaded?: boolean
  adapterError?: RunResult["adapterError"]
}

export class RunRecordBuilder {
  private steps: AgentStep[] = []
  private tokens: TokenUsage = emptyTokenUsage()
  private totalCost = 0
  private usageSeen = false
  private explicitFinalText = ""
  private pendingCalls = new Map<string, ToolCall>()

  /** Plain assistant text. Empty text is ignored. Last non-empty wins as `RunResult.text`. */
  assistantText(text: string, timestamp: number): this {
    if (!text) return this
    this.explicitFinalText = text
    this.steps.push({ role: "assistant", text, toolCalls: [], timestamp })
    return this
  }

  /**
   * Assistant turn that requests tool calls. Registers each id so a later
   * `toolResult()` can enrich the call with its output. Accompanying text
   * does NOT set `RunResult.text` directly — it participates only in the
   * fallback scan.
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
    this.steps.push({ role: "assistant", text: opts.text, toolCalls, timestamp: opts.timestamp })
    return this
  }

  /** Completed tool invocation recorded in one shot (call and output known together). */
  toolStep(call: ToolCallSpec, timestamp: number): this {
    this.steps.push({ role: "tool", toolCalls: [specToToolCall(call)], timestamp })
    return this
  }

  /**
   * Result for a tool call. If `id` matches a call registered via
   * `assistantToolCalls()`, that call is enriched with the output/exitCode;
   * a standalone tool step is recorded either way (unknown ids included).
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

  /** Accumulate cost (USD). Calling this at all marks usage as available. */
  cost(c: number): this {
    this.usageSeen = true
    this.totalCost += c
    return this
  }

  get stepCount(): number {
    return this.steps.length
  }

  finish(opts: RunRecordFinishOptions): RunResult {
    return {
      text: this.explicitFinalText || this.fallbackText(),
      steps: this.steps,
      tokens: this.tokens,
      cost: this.totalCost,
      durationMs: opts.durationMs,
      llmDurationMs: opts.llmDurationMs ?? 0,
      workDir: opts.workDir,
      runStatus: opts.runStatus ?? "ok",
      usageAvailable: this.usageSeen,
      ...(opts.statusDetail ? { statusDetail: opts.statusDetail } : {}),
      ...(opts.skillLoaded !== undefined ? { skillLoaded: opts.skillLoaded } : {}),
      ...(opts.adapterError ? { adapterError: opts.adapterError } : {}),
    }
  }

  private fallbackText(): string {
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const s = this.steps[i]!
      if (s.role === "assistant" && s.text) return s.text
    }
    return ""
  }
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
