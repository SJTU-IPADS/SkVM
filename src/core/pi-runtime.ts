/**
 * Pi event types and translation helpers shared by:
 *   - `src/adapters/pi.ts` (subprocess + NDJSON path, bench harness)
 *   - `src/core/headless-agent/pi-driver.ts` (in-process library path,
 *     headless tuner)
 *
 * Both paths receive the same conceptual events; one decodes them from
 * NDJSON, the other receives them as typed objects from
 * `AgentSession.subscribe()`. The result mapping is identical.
 */

import type { ProviderRoute, RunResult, AgentStep, ToolCall } from "./types.ts"
import { emptyTokenUsage } from "./types.ts"
import { createLogger } from "./logger.ts"
import { stripRoutingPrefix } from "./config.ts"

const log = createLogger("pi-runtime")

// ---------------------------------------------------------------------------
// Pi Event Types (matches pi-mono coding-agent NDJSON / AgentSessionEvent)
// ---------------------------------------------------------------------------

export interface PiTextContent {
  type: "text"
  text: string
}

export interface PiToolCallContent {
  type: "toolCall"
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface PiUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
}

export interface PiAssistantMessage {
  role: "assistant"
  content: (PiTextContent | PiToolCallContent)[]
  api: string
  provider: string
  model: string
  usage: PiUsage
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted"
  errorMessage?: string
  timestamp: number
}

export interface PiToolResultMessage {
  role: "toolResult"
  toolCallId: string
  toolName: string
  content: PiTextContent[]
  isError: boolean
  timestamp: number
}

export interface PiUserMessage {
  role: "user"
  content: PiTextContent[] | string
  timestamp: number
}

export type PiMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage

export type PiEvent =
  | { type: "session"; version: number; id: string; timestamp: string; cwd: string }
  | { type: "agent_start" }
  | { type: "agent_end"; messages: PiMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: PiMessage; toolResults: PiToolResultMessage[] }
  | { type: "message_start"; message: PiMessage }
  | { type: "message_update"; message: PiMessage }
  | { type: "message_end"; message: PiMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }

// ---------------------------------------------------------------------------
// NDJSON → events (subprocess adapter path)
// ---------------------------------------------------------------------------

export function parsePiNDJSON(output: string): PiEvent[] {
  const events: PiEvent[] = []
  for (const line of output.split("\n")) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as PiEvent)
    } catch {
      log.debug(`Skipping non-JSON line: ${line.slice(0, 100)}`)
    }
  }
  return events
}

// ---------------------------------------------------------------------------
// events → RunResult (shared by adapter + headless driver)
// ---------------------------------------------------------------------------

export function piEventsToRunResult(
  events: PiEvent[],
  workDir: string,
  durationMs: number,
): RunResult {
  const agentEndEvents = events.filter(
    (e): e is Extract<PiEvent, { type: "agent_end" }> => e.type === "agent_end",
  )
  const lastAgentEnd = agentEndEvents[agentEndEvents.length - 1]

  const messages: PiMessage[] = lastAgentEnd?.messages ? [...lastAgentEnd.messages] : []

  if (messages.length === 0) {
    const messageEnds = events.filter(
      (e): e is Extract<PiEvent, { type: "message_end" }> => e.type === "message_end",
    )
    for (const me of messageEnds) {
      if (me.message.role === "assistant" || me.message.role === "toolResult") {
        messages.push(me.message)
      }
    }
  }

  const steps: AgentStep[] = []
  let totalTokens = emptyTokenUsage()
  let totalCost = 0
  let finalText = ""
  const errors: string[] = []

  const toolOutputMap = new Map<string, { output: string; exitCode?: number }>()
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      const text = msg.content
        .filter((c): c is PiTextContent => c.type === "text")
        .map((c) => c.text)
        .join("")
      toolOutputMap.set(msg.toolCallId, { output: text, exitCode: msg.isError ? 1 : 0 })
    }
  }

  for (const msg of messages) {
    if (msg.role === "assistant") {
      const textParts = msg.content
        .filter((c): c is PiTextContent => c.type === "text")
        .map((c) => c.text)
      const text = textParts.join("")
      if (text) finalText = text

      const toolCalls: ToolCall[] = msg.content
        .filter((c): c is PiToolCallContent => c.type === "toolCall")
        .map((tc) => {
          const out = toolOutputMap.get(tc.id)
          return {
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
            output: out?.output,
            exitCode: out?.exitCode,
          }
        })

      steps.push({
        role: "assistant",
        text: text || undefined,
        toolCalls,
        timestamp: msg.timestamp,
      })

      const usage = msg.usage
      if (usage) {
        totalTokens = {
          input: totalTokens.input + (usage.input ?? 0),
          output: totalTokens.output + (usage.output ?? 0),
          cacheRead: totalTokens.cacheRead + (usage.cacheRead ?? 0),
          cacheWrite: totalTokens.cacheWrite + (usage.cacheWrite ?? 0),
        }
        totalCost += usage.cost?.total ?? 0
      }

      if (msg.stopReason === "error" && msg.errorMessage) {
        errors.push(msg.errorMessage)
      }
    } else if (msg.role === "toolResult") {
      const text = msg.content
        .filter((c): c is PiTextContent => c.type === "text")
        .map((c) => c.text)
        .join("")
      const out = toolOutputMap.get(msg.toolCallId)
      steps.push({
        role: "tool",
        toolCalls: [{
          id: msg.toolCallId,
          name: msg.toolName,
          input: {},
          output: text,
          exitCode: out?.exitCode,
        }],
        timestamp: msg.timestamp,
      })
    }
  }

  const lastAssistant = messages
    .filter((m): m is PiAssistantMessage => m.role === "assistant")
    .pop()

  let runStatus: RunResult["runStatus"] = "ok"
  let statusDetail: string | undefined

  if (!lastAgentEnd && messages.length === 0) {
    runStatus = "parse-failed"
    statusDetail = "pi produced no parseable events — telemetry only, workDir scored as-is"
  } else if (lastAssistant?.stopReason === "error") {
    statusDetail = `pi assistant stopped with error: ${lastAssistant.errorMessage ?? "unknown"}`
  }

  const result: RunResult = {
    text: finalText,
    steps,
    tokens: totalTokens,
    cost: totalCost,
    durationMs,
    llmDurationMs: 0,
    workDir,
    runStatus,
    ...(statusDetail ? { statusDetail } : {}),
  }

  if (errors.length > 0) {
    result.adapterError = { exitCode: 1, stderr: errors.join("; ").slice(0, 2000) }
  }

  return result
}

// ---------------------------------------------------------------------------
// Model translation (skvm route → pi provider/model id)
// ---------------------------------------------------------------------------

/**
 * Translate a skvm model id to pi's `<provider>/<model>` form. The
 * subprocess adapter passes this string to `--model`; the headless
 * library driver splits it on the first slash to call
 * `ModelRegistry.find(provider, modelId)`.
 */
export function toPiModel(model: string, route: ProviderRoute): string {
  if (route.kind === "openai-compatible") {
    return `openai/${stripRoutingPrefix(model)}`
  }
  return model
}

/**
 * Split a pi model id on the FIRST slash. Pi model ids are
 * `<provider>/<model-id>` where `<model-id>` itself can contain
 * slashes (e.g. `openrouter/qwen/qwen3-30b`).
 */
export function splitPiModel(piModel: string): { provider: string; modelId: string } {
  const i = piModel.indexOf("/")
  if (i < 0) throw new Error(`pi model id missing provider prefix: ${piModel}`)
  return { provider: piModel.slice(0, i), modelId: piModel.slice(i + 1) }
}

// ---------------------------------------------------------------------------
// models.json renderer
// ---------------------------------------------------------------------------

/**
 * Pi's `models.json` is the override / custom-model file. Pi's `ModelRegistry.find()`
 * (used by the library path) requires a model id to be in its registry to succeed;
 * pi's CLI has a relaxed fallback, but we lose that by going in-process.
 *
 * To keep parity, we always register the model id under the matching pi provider.
 * For openai-compatible routes we also override `baseUrl`. For built-in providers
 * (openai/anthropic/openrouter) custom model entries inherit api/baseUrl from
 * the built-ins, so a minimal `{id}` is enough.
 *
 * Returns the JSON string to drop into `<agentDir>/models.json`.
 */
export function renderPiModelsJson(route: ProviderRoute, modelId: string): string {
  const piProviderKey = route.kind === "openai-compatible" ? "openai" : route.kind
  const providerConfig: Record<string, unknown> = { models: [{ id: modelId }] }
  if (route.kind === "openai-compatible" && route.baseUrl) {
    providerConfig.baseUrl = route.baseUrl
  }
  const doc = { providers: { [piProviderKey]: providerConfig } }
  return JSON.stringify(doc, null, 2) + "\n"
}
