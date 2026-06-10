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

import type { ProviderRoute } from "./types.ts"
import { RunRecordBuilder } from "./run-record.ts"
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

export function piEventsToRunRecord(events: PiEvent[]): RunRecordBuilder {
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

  // Pi dialect: text on a tool-call turn claims the final text; conversation
  // order pairs outputs back via toolResult(), which also records the
  // standalone tool step pi transcripts carry.
  const builder = new RunRecordBuilder({ toolCallTextIsFinal: true })
  const errors: string[] = []

  for (const msg of messages) {
    if (msg.role === "assistant") {
      const text = msg.content
        .filter((c): c is PiTextContent => c.type === "text")
        .map((c) => c.text)
        .join("")

      const calls = msg.content
        .filter((c): c is PiToolCallContent => c.type === "toolCall")
        .map((tc) => ({ id: tc.id, name: tc.name, input: tc.arguments }))

      builder.assistantToolCalls(calls, { text: text || undefined, timestamp: msg.timestamp })

      const usage = msg.usage
      if (usage) {
        builder.usage(usage)
        builder.cost(usage.cost?.total ?? 0)
      }

      if (msg.stopReason === "error" && msg.errorMessage) {
        errors.push(msg.errorMessage)
      }
    } else if (msg.role === "toolResult") {
      const text = msg.content
        .filter((c): c is PiTextContent => c.type === "text")
        .map((c) => c.text)
        .join("")
      builder.toolResult(
        msg.toolCallId,
        { name: msg.toolName, output: text, exitCode: msg.isError ? 1 : 0 },
        msg.timestamp,
      )
    }
  }

  const lastAssistant = messages
    .filter((m): m is PiAssistantMessage => m.role === "assistant")
    .pop()

  builder.parseNote({
    ...(!lastAgentEnd && messages.length === 0
      ? {
          runStatus: "parse-failed",
          statusDetail: "pi produced no parseable events — telemetry only, workDir scored as-is",
        }
      : lastAssistant?.stopReason === "error"
        ? { statusDetail: `pi assistant stopped with error: ${lastAssistant.errorMessage ?? "unknown"}` }
        : {}),
    ...(errors.length > 0
      ? { adapterError: { exitCode: 1, stderr: errors.join("; ").slice(0, 2000) } }
      : {}),
  })

  return builder
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
// models.json renderers
// ---------------------------------------------------------------------------

/**
 * baseUrl-only override for openai-compatible routes. Preserves pi's built-in
 * model metadata (reasoning / contextWindow / maxTokens) while redirecting the
 * endpoint. Returns null for routes that need no override (openrouter / anthropic
 * use pi's built-in endpoints). Used by the subprocess adapter and by the
 * library driver when the model id is already in pi's catalogue.
 */
export function renderPiBaseUrlOverride(route: ProviderRoute): string | null {
  if (route.kind !== "openai-compatible" || !route.baseUrl) return null
  const doc = { providers: { openai: { baseUrl: route.baseUrl } } }
  return JSON.stringify(doc, null, 2) + "\n"
}

/**
 * Full models.json that REGISTERS a custom model id so pi's strict
 * ModelRegistry.find() (library path) resolves it. Use only when the id is NOT
 * in pi's built-in catalogue — registering a built-in id with a bare {id}
 * stub would clobber its metadata (reasoning / contextWindow / maxTokens).
 * For openai-compatible routes the baseUrl override is included too.
 *
 * For openai-compatible routes the model entry pins `api: "openai-completions"`.
 * Pi's built-in `openai` provider defaults custom models to its API
 * (`openai-responses` — the newer Responses endpoint pi uses for real OpenAI
 * models). Non-OpenAI openai-compatible backends (DeepSeek, vLLM, any
 * OpenAI-proxy frontend) almost never implement Responses; they only speak
 * the `/chat/completions` Completions API. Without this override pi POSTs to
 * `{baseUrl}/responses` and the backend returns 404. Confirmed against
 * pi-ai's own `models.generated.js`: every non-OpenAI deepseek-* / qwen3-* /
 * etc. entry registered under the openai provider sets
 * `api: "openai-completions"` explicitly for the same reason.
 *
 * Other route kinds (openrouter, anthropic) already inherit a correct `api`
 * default from pi's built-in provider definitions, so no override needed.
 */
export function renderPiModelRegistration(route: ProviderRoute, modelId: string): string {
  const piProviderKey = route.kind === "openai-compatible" ? "openai" : route.kind
  const modelEntry: Record<string, unknown> = { id: modelId }
  if (route.kind === "openai-compatible") {
    modelEntry.api = "openai-completions"
  }
  const providerConfig: Record<string, unknown> = { models: [modelEntry] }
  if (route.kind === "openai-compatible" && route.baseUrl) {
    providerConfig.baseUrl = route.baseUrl
  }
  const doc = { providers: { [piProviderKey]: providerConfig } }
  return JSON.stringify(doc, null, 2) + "\n"
}
