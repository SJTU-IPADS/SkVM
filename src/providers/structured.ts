import { z, type ZodType } from "zod"
import type { LLMProvider } from "./types.ts"
import type { TokenUsage } from "../core/types.ts"
import { emptyTokenUsage, addTokenUsage } from "../core/types.ts"
import { isProviderError, isToolChoiceUnsupportedError } from "./errors.ts"
import { createLogger } from "../core/logger.ts"

const log = createLogger("structured")

/**
 * Two-layer structured extraction:
 *
 * 1. **tool_use** (preferred) — define a single-tool schema container, force
 *    the model to call it via `toolChoice: { name }`, read typed args from
 *    `response.toolCalls[0]`. The "tool" is never executed: it's just a
 *    structured-output channel that the platform validates.
 * 2. **prompt+parse** (fallback) — embed the JSON schema in the prompt, ask
 *    for raw JSON, parse the response text. Used only when tool_use can't
 *    work for the current (provider × model) combo.
 *
 * Layer 1 is attempted unconditionally. If the **content** side fails — model
 * returned no tool_call, schema validation rejected the args, the provider
 * doesn't actually honor `tools` for this model — Layer 2 takes over to
 * empirically discover capability.
 *
 * Provider-origin errors (`ProviderError` / `HeadlessAgentError`) are NOT
 * swallowed here: they propagate unchanged. Retrying the same broken provider
 * via a different extraction strategy just masks the real failure and corrupts
 * downstream signals (jit-optimize's evidence most of all). The one exception
 * is a 400 that rejects Layer 1's forced `tool_choice` (thinking-mode models
 * do this): that's a capability signal, not infra — Layer 2 sends no
 * `tool_choice`, so it's handled like a content miss and the fallback runs.
 *
 * Callers pass a Zod schema and get back validated typed data.
 */
export async function extractStructured<T>(opts: {
  provider: LLMProvider
  schema: ZodType<T>
  schemaName: string
  schemaDescription: string
  prompt: string
  system?: string
  maxRetries?: number
  maxTokens?: number
}): Promise<{ result: T; rawResponse: string; tokens: TokenUsage; costUsd?: number }> {
  const { provider, schema, schemaName, schemaDescription, prompt, system, maxRetries = 3, maxTokens } = opts

  // Layer 1: tool_use, forced via toolChoice so the model can't decline.
  try {
    return await extractViaToolUse({ provider, schema, schemaName, schemaDescription, prompt, system, maxTokens })
  } catch (err) {
    // A 400 that rejects our forced tool_choice (thinking-mode models do this)
    // is a capability limit, not an infra failure — Layer 2 sends no
    // tool_choice, so prompt+parse on the same provider can still succeed.
    if (isToolChoiceUnsupportedError(err)) {
      log.warn(`provider rejected forced tool_choice (likely a thinking-mode model); falling back to prompt+parse`)
    } else if (isProviderError(err)) {
      // Other infrastructure errors propagate. They mean "the provider itself
      // is broken"; retrying via prompt+parse on the same provider will just
      // fail again with a more confusing error.
      throw err
    } else {
      log.warn(`tool_use extraction failed, falling back to prompt+parse: ${err}`)
    }
  }

  // Layer 2: prompt + parse fallback.
  return await extractViaPromptParse({ provider, schema, schemaName, prompt, system, maxRetries, maxTokens })
}

async function extractViaToolUse<T>(opts: {
  provider: LLMProvider
  schema: ZodType<T>
  schemaName: string
  schemaDescription: string
  prompt: string
  system?: string
  maxTokens?: number
}): Promise<{ result: T; rawResponse: string; tokens: TokenUsage; costUsd?: number }> {
  const { provider, schema, schemaName, schemaDescription, prompt, system, maxTokens } = opts

  // Convert Zod schema to JSON Schema for tool definition
  const jsonSchema = zodToJsonSchema(schema)

  const response = await provider.complete({
    messages: [{ role: "user", content: prompt }],
    system,
    tools: [{
      name: schemaName,
      description: schemaDescription,
      inputSchema: jsonSchema,
    }],
    // Force the model to call our schema container — without this, models
    // are free to respond with prose ("I cannot use tools", etc.) and we'd
    // bounce to the slower prompt+parse path on every call.
    toolChoice: { name: schemaName },
    temperature: 0,
    maxTokens,
  })

  const toolCall = response.toolCalls[0]
  if (!toolCall) {
    throw new Error(`LLM did not make a tool call. Response text: ${response.text.slice(0, 200)}`)
  }

  const result = schema.parse(toolCall.arguments)
  return { result, rawResponse: JSON.stringify(toolCall.arguments), tokens: response.tokens, costUsd: response.costUsd }
}

async function extractViaPromptParse<T>(opts: {
  provider: LLMProvider
  schema: ZodType<T>
  schemaName: string
  prompt: string
  system?: string
  maxRetries: number
  maxTokens?: number
}): Promise<{ result: T; rawResponse: string; tokens: TokenUsage; costUsd?: number }> {
  const { provider, schema, schemaName, prompt, system, maxRetries, maxTokens } = opts

  const jsonSchema = zodToJsonSchema(schema)
  const schemaStr = JSON.stringify(jsonSchema, null, 2)

  const extractionPrompt = `${prompt}

You MUST respond with a valid JSON object conforming to this schema:

\`\`\`json
${schemaStr}
\`\`\`

Output ONLY the JSON object, nothing else. No markdown fences, no explanation.`

  let lastError: unknown
  let totalTokens = emptyTokenUsage()
  // All-or-nothing cost accumulator across retry attempts
  let totalCostUsd: number | undefined = 0
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const response = await provider.complete({
      messages: [{ role: "user", content: extractionPrompt }],
      system,
      temperature: 0,
      maxTokens,
    })
    totalTokens = addTokenUsage(totalTokens, response.tokens)
    if (totalCostUsd !== undefined && response.costUsd !== undefined) {
      totalCostUsd += response.costUsd
    } else {
      totalCostUsd = undefined
    }

    const raw = response.text.trim()
    try {
      // Strip markdown fences if present
      const jsonStr = raw.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim()
      const parsed = JSON.parse(jsonStr)
      const result = schema.parse(parsed)
      return { result, rawResponse: raw, tokens: totalTokens, costUsd: totalCostUsd }
    } catch (err) {
      lastError = err
      log.warn(`Attempt ${attempt + 1}/${maxRetries} parse failed: ${err}`)
    }
  }

  throw new Error(`Structured extraction failed after ${maxRetries} attempts: ${lastError}`)
}

/**
 * Convert a Zod schema to a JSON Schema object.
 * Handles common Zod types used in our system.
 */
function zodToJsonSchema(schema: ZodType<unknown>): Record<string, unknown> {
  // Use Zod's built-in JSON schema generation if available,
  // otherwise do a basic manual conversion
  const def = (schema as any)._def

  if (!def) return { type: "object" }

  return zodDefToJsonSchema(def)
}

function zodDefToJsonSchema(def: any): Record<string, unknown> {
  const typeName = def.typeName

  switch (typeName) {
    case "ZodObject": {
      const shape = def.shape?.()
      const properties: Record<string, unknown> = {}
      const required: string[] = []

      if (shape) {
        for (const [key, value] of Object.entries(shape)) {
          properties[key] = zodToJsonSchema(value as ZodType<unknown>)
          // Check if field is optional
          const fieldDef = (value as any)?._def
          if (fieldDef?.typeName !== "ZodOptional" && fieldDef?.typeName !== "ZodDefault") {
            required.push(key)
          }
        }
      }

      return { type: "object", properties, required: required.length ? required : undefined }
    }

    case "ZodString":
      return { type: "string" }

    case "ZodNumber":
      return { type: "number" }

    case "ZodBoolean":
      return { type: "boolean" }

    case "ZodArray":
      return {
        type: "array",
        items: zodToJsonSchema(def.type),
      }

    case "ZodEnum":
      return { type: "string", enum: def.values }

    case "ZodLiteral":
      return { type: typeof def.value, const: def.value }

    case "ZodOptional":
      return zodDefToJsonSchema(def.innerType._def)

    case "ZodDefault":
      return zodDefToJsonSchema(def.innerType._def)

    case "ZodRecord":
      return {
        type: "object",
        additionalProperties: zodToJsonSchema(def.valueType),
      }

    case "ZodUnion":
    case "ZodDiscriminatedUnion":
      return {
        anyOf: def.options.map((opt: ZodType<unknown>) => zodToJsonSchema(opt)),
      }

    default:
      return { type: "object" }
  }
}
