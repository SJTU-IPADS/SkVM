/**
 * Auto-probe verdict logic and Anthropic-shape baseUrl inference.
 *
 * Pure functions consumed by `runProbe` (probe.ts) and `AutoProbeProvider`
 * (auto-probe.ts). Splitting these out keeps the LLM-touching probe call
 * independently testable from the wrapper's retry orchestration.
 *
 * Spec: docs/skvm/2026-05-19-provider-auto-probe.md (Section "Verdict mapping").
 */
import type { LLMProvider, LLMToolCall } from "./types.ts"
import { isToolArgumentsParseError } from "./errors.ts"

export type ProbeVerdict = "clean" | "polluted" | "indeterminate"

/** Markers that prove the argument string is not pure JSON. */
const POLLUTION_PATTERNS = [
  /<think\b/i,
  /<\/think>/i,
  /\bACHI\b/,
  /<tool_call\b/i,
  /<arg_key>/i,
  /<arg_value>/i,
]

/**
 * Classify a raw `tool_calls[0].function.arguments` string against the
 * expected probe response object. Returns:
 *   - "clean": parses as JSON and exactly equals `expected`
 *   - "polluted": fails to parse, OR contains a known pollution marker,
 *     OR parses but fields don't match
 *   - "indeterminate" is not produced here — that's reserved for
 *     network/transport failures in `runProbe`.
 */
export function classifyArguments(
  raw: string,
  expected: Record<string, unknown>,
): Exclude<ProbeVerdict, "indeterminate"> {
  for (const re of POLLUTION_PATTERNS) {
    if (re.test(raw)) return "polluted"
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return "polluted"
  }
  if (!parsed || typeof parsed !== "object") return "polluted"
  for (const [k, v] of Object.entries(expected)) {
    if ((parsed as Record<string, unknown>)[k] !== v) return "polluted"
  }
  return "clean"
}

/**
 * Given an OpenAI-compatible baseUrl, return the most likely
 * Anthropic-shaped baseUrl on the same host. The Anthropic SDK appends
 * `/v1/messages` itself, so we strip a trailing `/v1` (with or without
 * trailing slash) and pass the bare host+path back.
 *
 * Returns null when the input is unusable (empty, malformed URL).
 */
export function inferAnthropicBaseUrl(openaiBaseUrl: string): string | null {
  if (!openaiBaseUrl) return null
  let url: URL
  try {
    url = new URL(openaiBaseUrl)
  } catch {
    return null
  }
  const stripped = url.pathname.replace(/\/v1\/?$/, "")
  url.pathname = stripped
  // URL.toString() may append a trailing "/" — strip to match SDK conventions.
  return url.toString().replace(/\/$/, "")
}

// ---------------------------------------------------------------------------
// runProbe: synthetic tool-use call → verdict
// ---------------------------------------------------------------------------

const PROBE_EXPECTED = { name: "probe", score: 42 } as const

const PROBE_TOOL = {
  name: "extract_probe",
  description: "Return the probe values exactly as requested.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "person's name" },
      score: { type: "number", description: "score value" },
    },
    required: ["name", "score"],
  } as Record<string, unknown>,
}

const PROBE_SYSTEM = "Extract a probe value. Call the tool with exactly the requested arguments."
const PROBE_USER = `Call extract_probe with name="probe" and score=42.`

export interface ProbeVerdictResult {
  primary: ProbeVerdict
  alt?: ProbeVerdict
}

export interface RunProbeOpts {
  primary: LLMProvider
  /** Lazy alt-provider constructor; only invoked if primary is polluted. */
  alt: () => LLMProvider
}

/**
 * Send a deterministic synthetic tool-use call to `primary`, classify the
 * verdict. If the primary verdict is `polluted`, also invoke `alt` and
 * classify its verdict. Returns both classifications.
 *
 * 30-second hard timeout per call. Caller is responsible for deciding what
 * to write to config based on the returned verdicts.
 */
export async function runProbe(opts: RunProbeOpts): Promise<ProbeVerdictResult> {
  const primary = await probeOnce(opts.primary)
  if (primary !== "polluted") return { primary }
  const alt = await probeOnce(opts.alt())
  return { primary, alt }
}

async function probeOnce(provider: LLMProvider): Promise<ProbeVerdict> {
  const PROBE_TIMEOUT_MS = 30_000
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"indeterminate">((resolve) => {
    timer = setTimeout(() => resolve("indeterminate"), PROBE_TIMEOUT_MS)
  })
  const work = (async (): Promise<ProbeVerdict> => {
    try {
      const res = await provider.complete({
        messages: [{ role: "user", content: PROBE_USER }],
        system: PROBE_SYSTEM,
        tools: [PROBE_TOOL],
        toolChoice: { name: PROBE_TOOL.name },
        temperature: 0,
        maxTokens: 256,
      })
      const tc: LLMToolCall | undefined = res.toolCalls[0]
      if (!tc) return "polluted"
      const raw = JSON.stringify(tc.arguments)
      return classifyArguments(raw, PROBE_EXPECTED)
    } catch (err) {
      if (isToolArgumentsParseError(err)) {
        // The provider already classified this as parse-failure on the wire.
        return "polluted"
      }
      // Anything else (network, 4xx, 5xx) is indeterminate.
      return "indeterminate"
    }
  })()
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
