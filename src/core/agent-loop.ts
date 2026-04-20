import type { AgentStep, ToolCall, TokenUsage } from "./types.ts"
import { emptyTokenUsage, addTokenUsage } from "./types.ts"
import type { LLMProvider, LLMTool, LLMToolCall, LLMToolResult, LLMResponse, LLMMessage, CompletionParams } from "../providers/types.ts"
import { isProviderError } from "../providers/errors.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("agent-loop")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolResult {
  output: string
  exitCode?: number
  durationMs: number
}

export interface AgentLoopConfig {
  provider: LLMProvider
  model: string
  tools: LLMTool[]
  executeTool: (call: LLMToolCall) => Promise<ToolResult>
  system: string
  maxIterations: number
  timeoutMs: number
  maxTokens?: number
  temperature?: number

  /** Called after each LLM response (for monitoring, e.g. solidification skeleton matching) */
  onAfterLLM?: (response: LLMResponse, iteration: number) => Promise<void> | void

  /** Called after each tool execution (for tracking) */
  onAfterTool?: (completedCall: ToolCall, iteration: number) => Promise<void> | void

  /**
   * ILP dispatch: when the LLM returns multiple tool_use blocks in a single
   * response, execute them concurrently instead of serially.
   *
   * This materializes the pass3 ILP annotation: compilation tells the model to
   * batch independent tool calls in one turn; the runtime then dispatches them
   * in parallel. Tool-result ordering is preserved by index so the downstream
   * `completeWithToolResults` contract (one tool_result per tool_use id) stays
   * intact.
   *
   * Default `false` preserves legacy per-call serialization. Adapters whose
   * `executeTool` is safe to run concurrently (shell subprocesses, CLI fan-out)
   * should opt in.
   */
  parallelToolExecution?: boolean
}

export interface AgentLoopResult {
  text: string
  steps: AgentStep[]
  tokens: TokenUsage
  /**
   * Authoritative total USD cost summed across every LLM call in the loop,
   * when every response returned a `costUsd`. Left undefined if any response
   * lacked it so the caller knows to fall back to `estimateCost` on tokens.
   */
  totalCostUsd?: number
  llmDurationMs: number
  iterations: number
  allToolCalls: ToolCall[]
  error?: Error
  /** True if the loop broke because it exceeded `timeoutMs`. */
  timedOut?: boolean
}

// ---------------------------------------------------------------------------
// Agent Loop
// ---------------------------------------------------------------------------

/**
 * Generic agentic loop: multi-turn LLM conversation with tool execution.
 *
 * Extracted from BareAgentAdapter to be reused by compiler agents, JIT agents, etc.
 * The loop handles:
 * - Multi-turn conversation via complete() / completeWithToolResults()
 * - Tool dispatch via config.executeTool
 * - Loop detection (same action signature 3x → break)
 * - Deferred conversation history (pendingHistory pattern)
 * - Token accumulation
 * - Timeout enforcement
 */
export async function runAgentLoop(
  config: AgentLoopConfig,
  initialMessages: LLMMessage[],
): Promise<AgentLoopResult> {
  const { provider, tools, executeTool, system, maxIterations, timeoutMs } = config

  const startMs = performance.now()
  const deadline = startMs + timeoutMs

  const params: CompletionParams = {
    messages: [...initialMessages],
    system,
    tools,
    maxTokens: config.maxTokens ?? 16384,
    temperature: config.temperature,
  }

  const steps: AgentStep[] = []
  let totalTokens = emptyTokenUsage()
  // All-or-nothing cost accumulator: if every response reports costUsd we sum
  // them; if any response omits it, totalCostUsd becomes undefined so the
  // caller falls back to estimateCost on totalTokens.
  let totalCostUsd: number | undefined = 0
  let llmDurationMs = 0
  let finalText = ""
  const allToolCalls: ToolCall[] = []

  let response: LLMResponse | undefined
  let iteration = 0
  let loopError: Error | undefined
  let timedOut = false
  let pendingHistory: Array<{ role: "system" | "user" | "assistant"; content: string }> | undefined
  let lastActionSig = ""
  let repeatCount = 0

  try {
    while (iteration < maxIterations) {
      if (performance.now() > deadline) {
        log.warn(`Timeout after ${iteration} iterations`)
        timedOut = true
        break
      }

      iteration++

      // --- LLM call ---
      if (!response) {
        response = await provider.complete(params)
        llmDurationMs += response.durationMs
      }
      // (else: response was already set by completeWithToolResults at end of previous iteration)

      totalTokens = addTokenUsage(totalTokens, response.tokens)
      if (totalCostUsd !== undefined && response.costUsd !== undefined) {
        totalCostUsd += response.costUsd
      } else {
        totalCostUsd = undefined
      }

      // --- After-LLM callback ---
      if (config.onAfterLLM) {
        await config.onAfterLLM(response, iteration)
      }

      // Record assistant step
      const toolCalls: ToolCall[] = response.toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        input: tc.arguments,
      }))

      steps.push({
        role: "assistant",
        text: response.text || undefined,
        toolCalls,
        timestamp: Date.now(),
      })

      // If no tool calls or end_turn, we're done
      if (response.toolCalls.length === 0 || response.stopReason === "end_turn") {
        finalText = response.text
        break
      }

      // Execute tool calls. When ILP dispatch is enabled and the LLM batched
      // multiple independent tool_use blocks in this turn, fan them out with
      // Promise.all so wall-clock time equals the slowest call rather than the
      // sum. Output order is preserved by indexing back into the original
      // `response.toolCalls` array — matters both for human-readable traces
      // and for any adapter that assumes stable ordering.
      const toolResults: LLMToolResult[] = []
      const toolStepCalls: ToolCall[] = []

      const dispatchOne = async (tc: LLMToolCall): Promise<{ tr: LLMToolResult; completed: ToolCall }> => {
        log.debug(`Tool: ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 100)})`)
        const result = await executeTool(tc)
        return {
          tr: { toolCallId: tc.id, content: result.output },
          completed: {
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
            output: result.output,
            durationMs: result.durationMs,
            exitCode: result.exitCode,
          },
        }
      }

      const ilpEnabled = config.parallelToolExecution === true && response.toolCalls.length > 1
      const dispatched = ilpEnabled
        ? await Promise.all(response.toolCalls.map(dispatchOne))
        : await (async () => {
            const out: Array<{ tr: LLMToolResult; completed: ToolCall }> = []
            for (const tc of response.toolCalls) {
              out.push(await dispatchOne(tc))
            }
            return out
          })()

      if (ilpEnabled) {
        log.debug(`ILP dispatch: ${response.toolCalls.length} tool calls executed in parallel`)
      }

      for (const { tr, completed } of dispatched) {
        toolResults.push(tr)
        toolStepCalls.push(completed)
        allToolCalls.push(completed)
        // After-tool callbacks still run sequentially to preserve ordering
        // guarantees expected by JIT boost / monitoring consumers.
        if (config.onAfterTool) {
          await config.onAfterTool(completed, iteration)
        }
      }

      // Record tool results step
      steps.push({
        role: "tool",
        toolCalls: toolStepCalls,
        timestamp: Date.now(),
      })

      // Accumulate conversation history so the model sees prior turns.
      // completeWithToolResults appends the LATEST exchange with proper tool_calls format,
      // so we push the PREVIOUS exchange here (deferred by one iteration).
      if (pendingHistory) {
        params.messages.push(...pendingHistory)
      }
      // Stage current exchange for next iteration
      const actionSig = response.toolCalls.map(tc => `${tc.name}(${JSON.stringify(tc.arguments)})`).sort().join("|")
      pendingHistory = [
        { role: "assistant", content: response.text || `[Called: ${response.toolCalls.map(tc => tc.name).join(", ")}]` },
        { role: "user", content: toolResults.map(tr => tr.content.slice(0, 2000)).join("\n---\n") },
      ]

      // Loop detection: break if the same action signature repeats 3+ times consecutively
      if (actionSig === lastActionSig) {
        repeatCount++
        if (repeatCount >= 3) {
          log.warn(`Loop detected: same action repeated ${repeatCount} times, breaking`)
          finalText = response.text
          break
        }
      } else {
        lastActionSig = actionSig
        repeatCount = 1
      }

      // Next LLM call with tool results
      response = await provider.completeWithToolResults(params, toolResults, response)
      llmDurationMs += response.durationMs
    }
  } catch (err) {
    // Infrastructure errors (provider down, auth, rate-limit exhausted)
    // must propagate so upstream classification can distinguish them from
    // content failures (bad tool call, parse error, tool execution error).
    // If we capture them into loopError they get flattened into a stringy
    // adapterError.stderr field and downstream can't tell the difference.
    if (isProviderError(err)) throw err
    loopError = err instanceof Error ? err : new Error(String(err))
    log.warn(`Agent loop error after ${iteration} iterations: ${loopError.message.slice(0, 200)}`)
  }

  // Post-loop deadline check. The in-loop check at the top of each iteration
  // only fires BEFORE a new iteration starts. If `provider.complete()`,
  // `completeWithToolResults()`, or a tool execution runs past `timeoutMs`
  // and then returns a final response (end_turn / loop detection / max
  // iterations), the loop exits naturally and the in-loop check never runs.
  // Without this post-loop sweep, the run would be reported as `timedOut:false`
  // even though the wall-clock budget was violated — letting bare-agent
  // produce a `runStatus: 'ok'` for an over-time run, which recreates the
  // false-positive class the runStatus contract is supposed to prevent.
  if (!timedOut && performance.now() > deadline) {
    timedOut = true
    log.warn(`Agent loop overran deadline by ${Math.round(performance.now() - deadline)}ms (post-loop detection)`)
  }

  return {
    text: finalText,
    steps,
    tokens: totalTokens,
    totalCostUsd,
    llmDurationMs,
    iterations: iteration,
    allToolCalls,
    error: loopError,
    timedOut,
  }
}
