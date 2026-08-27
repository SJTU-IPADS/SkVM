import type { AgentStep, ToolCall, TokenUsage } from "./types.ts"
import { emptyTokenUsage, addTokenUsage } from "./types.ts"
import type { LLMProvider, LLMTool, LLMToolCall, LLMToolResult, LLMResponse, LLMMessage, CompletionParams } from "../providers/types.ts"
import { isProviderError, isToolArgumentsParseError, type ToolArgumentsParseError } from "../providers/errors.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("agent-loop")

/**
 * How many *consecutive* malformed-tool-call responses the loop tolerates
 * before giving up on the run. A ToolArgumentsParseError is a recoverable
 * content failure (the model leaked reasoning into tool_call arguments, or
 * emitted JSON JSON.parse rejects): the loop feeds the parse error back and
 * lets the model retry. Only when the model can't produce a valid tool call
 * after this many attempts in a row do we stop — as a scored task failure,
 * not an adapter crash. Reset to zero on any successfully-parsed response.
 */
export const MAX_CONSECUTIVE_PARSE_FAILURES = 3

/**
 * A model reply that *names* a tool instead of calling it — e.g. the bare text
 * `[Called: execute_command]` with no tool_calls and stopReason `end_turn`.
 *
 * This is imitation, not intent: the loop used to stage past tool-call turns in history as that
 * exact string, so models learned to emit it as prose. Read literally it means "the task is
 * finished", which ends the run mid-task — silently, with exit 0 and a score of 0. The history no
 * longer contains the pattern, so this should not fire; it remains as a guard because the failure
 * mode is invisible in every log except the final score.
 */
export const GHOST_TOOL_CALL = /^\[Called:[^\]]*\]/
/** How many ghost turns to correct before accepting that the model is done. */
export const MAX_GHOST_RETRIES = 2

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
  // See the "ghost tool call" guard below.
  let ghostTurns = 0
  const allToolCalls: ToolCall[] = []

  let response: LLMResponse | undefined
  let iteration = 0
  let loopError: Error | undefined
  let timedOut = false
  let pendingHistory: LLMMessage[] | undefined
  let lastActionSig = ""
  let repeatCount = 0
  let consecutiveParseFailures = 0

  // Feed a malformed-tool-call parse error back to the model so it can retry,
  // instead of aborting the whole run. The offending response never became a
  // valid LLMResponse, so we can't continue it via completeWithToolResults;
  // we drop back to a plain complete() with the parse error appended as a
  // corrective user turn. Any exchange staged in `pendingHistory` is committed
  // first (that continuation path is being abandoned). Returns whether the
  // caller should retry the turn or give up on the run.
  const feedBackParseError = (err: ToolArgumentsParseError): "retry" | "giveup" => {
    if (pendingHistory) {
      params.messages.push(...pendingHistory)
      pendingHistory = undefined
    }
    // The rejected turn was billed before it failed to parse (the provider throws after a 200 OK),
    // so its spend belongs in the run totals. Cost follows the same all-or-nothing rule as a
    // successful response: one unpriced call makes the run's dollar figure an estimate.
    if (err.usage) {
      totalTokens = addTokenUsage(totalTokens, err.usage.tokens)
      llmDurationMs += err.usage.durationMs
      totalCostUsd = totalCostUsd !== undefined && err.usage.costUsd !== undefined
        ? totalCostUsd + err.usage.costUsd
        : undefined
    }
    // Replay the model's own malformed output as the assistant turn it was, then correct it. Two
    // reasons this is not folded into a single user message: consecutive user turns are invalid on
    // some providers, and a correction that says "your previous reply" has to have a previous reply
    // in the history to refer to — otherwise, on the tool-results path, the model reads it as being
    // about the successful call whose output it can see.
    params.messages.push(
      { role: "assistant", content: err.rawArguments },
      {
        role: "user",
        content:
          `That reply was rejected: the tool call's arguments were not valid JSON ` +
          `(${err.message}). Respond again with a valid tool call, emitting well-formed JSON ` +
          `for the arguments.`,
      },
    )
    // Record the rejected attempt so it counts as a step and shows in the trace. The text is the
    // model's raw output, not a harness-authored sentence — a transcript reader (or a grader
    // scanning assistant text) should never see the harness impersonating the model.
    steps.push({
      role: "assistant",
      text: err.rawArguments.slice(0, 2000),
      toolCalls: [],
      timestamp: Date.now(),
    })
    consecutiveParseFailures++
    if (consecutiveParseFailures >= MAX_CONSECUTIVE_PARSE_FAILURES) {
      log.warn(`Giving up after ${consecutiveParseFailures} consecutive malformed tool calls`)
      return "giveup"
    }
    log.debug(`Malformed tool call (attempt ${consecutiveParseFailures}); feeding parse error back for retry`)
    return "retry"
  }

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
        try {
          response = await provider.complete(params)
        } catch (err) {
          if (!isToolArgumentsParseError(err)) throw err
          if (feedBackParseError(err) === "giveup") break
          response = undefined
          continue
        }
        consecutiveParseFailures = 0
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

      // A "ghost" turn: the model echoed our own history placeholder as prose instead of calling
      // the tool. Historically we staged tool-call turns as the literal text `[Called: <tool>]`
      // (see below), and models learned to reply with exactly that — no tool call, stopReason
      // end_turn. Taking it at face value ends the run silently, mid-task, with the deliverable
      // unwritten. The history no longer contains that pattern, so this should not fire; it stays
      // as a guard because the failure is invisible (exit 0, runStatus ok, score 0) and any future
      // history flattening could reintroduce it.
      if (response.toolCalls.length === 0 && GHOST_TOOL_CALL.test(response.text.trim())) {
        ghostTurns++
        log.warn(`Ghost tool call: model wrote "${response.text.trim().slice(0, 60)}" as text instead of calling the tool`)
        if (ghostTurns <= MAX_GHOST_RETRIES) {
          // Same shape as the parse-error retry: commit the staged exchange, append the
          // correction, and drop back to a plain complete() so the model actually sees it.
          if (pendingHistory) {
            params.messages.push(...pendingHistory)
            pendingHistory = undefined
          }
          params.messages.push(
            { role: "assistant", content: response.text },
            {
              role: "user",
              content:
                "That was not a tool call — it was text. Do not describe or name the tool; " +
                "actually invoke it. Continue the task.",
            },
          )
          response = undefined
          continue
        }
        log.warn(`Ghost tool call repeated ${ghostTurns}x — ending run`)
      }

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
      // Stage current exchange for next iteration.
      //
      // The assistant turn carries its tool calls STRUCTURALLY (providers serialize them as a real
      // tool-call turn). It used to be flattened to the literal string `[Called: write_file]` when
      // the model returned no prose — which qwen-class models do on nearly every step. The model
      // then saw a history in which every assistant turn was that string, imitated it, and emitted
      // `[Called: execute_command]` as TEXT with no tool call. The loop reads a text-only reply as
      // "task finished", so the run ended having written the script but never run it. Skills that
      // say "write a script, then execute it" made the dropped call the one that produced the
      // deliverable, so they scored 0 while the same task passed without the skill.
      const actionSig = response.toolCalls.map(tc => `${tc.name}(${JSON.stringify(tc.arguments)})`).sort().join("|")
      pendingHistory = [
        {
          role: "assistant",
          content: response.text,
          toolCalls: response.toolCalls,
          // Thinking-mode models require this echoed back on any turn that issued tool calls, and
          // every staged turn now issues them.
          ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
        },
        ...toolResults.map((tr): LLMMessage => ({
          role: "tool",
          content: tr.content.slice(0, 2000),
          toolCallId: tr.toolCallId,
        })),
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
      try {
        response = await provider.completeWithToolResults(params, toolResults, response)
      } catch (err) {
        if (!isToolArgumentsParseError(err)) throw err
        if (feedBackParseError(err) === "giveup") break
        // Abandon the tool-result continuation; next iteration restarts with a
        // plain complete() carrying the flushed history + corrective message.
        response = undefined
        continue
      }
      consecutiveParseFailures = 0
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
