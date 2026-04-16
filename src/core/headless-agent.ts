/**
 * Headless agent runner — minimal one-shot agent invocation for internal
 * tooling (JIT-optimize optimizer, JIT-boost candidate generation).
 *
 * Unlike AgentAdapter (which is benchmark-focused, conversational, and has
 * skill-injection modes), this is a fire-and-forget wrapper:
 *   - point it at a working directory
 *   - give it a prompt and a model
 *   - get back exit code, token usage, cost, and raw output
 *
 * A "driver" plugs in the concrete backend. The current default driver is
 * `opencode`, but any agent tool that can be invoked headlessly (spawn a
 * process, run a prompt inside a directory, produce structured output) can
 * be added as a new driver without touching callers.
 *
 * Callers (jit-optimize, jit-boost) should import only from this module, not
 * directly from adapter-specific files, so the abstraction stays intact.
 */

import path from "node:path"
import {
  parseNDJSON,
  eventsToRunResult,
  resolveOpenCodeCmd,
} from "../adapters/opencode.ts"
import { stripRoutingPrefix } from "../providers/registry.ts"
import type { TokenUsage, ProviderOverride } from "./types.ts"
import { getHeadlessAgentConfig } from "./config.ts"
import { HEADLESS_AGENT_DEFAULTS } from "./ui-defaults.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("headless-agent")

/**
 * Build an OPENCODE_CONFIG_CONTENT JSON string that registers a custom
 * OpenAI-compatible provider so the opencode subprocess can reach an
 * endpoint that isn't in models.dev. Not exported — tightly coupled to
 * opencode's config schema and only used by `runOpenCodeDriver`.
 */
function buildOpenCodeConfigContent(
  override: ProviderOverride,
  modelId: string,
): string {
  const apiKey =
    override.apiKey
    ?? (override.apiKeyEnv ? process.env[override.apiKeyEnv] : undefined)
    // Empty string is intentional: allows auth-free local endpoints (vLLM
    // without --api-key). opencode will still send the Authorization header
    // but the server can ignore it.
    ?? ""

  if (!apiKey) {
    log.warn(
      `providerOverride: no API key found (apiKeyEnv=${override.apiKeyEnv ?? "(unset)"}). ` +
      `The opencode subprocess may fail to authenticate.`,
    )
  }

  const injected: Record<string, unknown> = {
    provider: {
      [override.name]: {
        // Explicit npm package so opencode knows which SDK adapter to use
        // for a provider ID that doesn't exist in models.dev.
        npm: "@ai-sdk/openai-compatible",
        options: {
          apiKey,
          baseURL: override.baseUrl,
        },
        models: {
          [modelId]: {
            limit: {
              context: override.contextLimit ?? HEADLESS_AGENT_DEFAULTS.contextLimit,
              output: override.outputLimit ?? HEADLESS_AGENT_DEFAULTS.outputLimit,
            },
          },
        },
      },
    },
  }

  // Merge with any pre-existing OPENCODE_CONFIG_CONTENT from the parent
  // environment (CI wrappers, plugin configs, etc.) so we don't clobber it.
  const existing = process.env.OPENCODE_CONFIG_CONTENT
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as Record<string, unknown>
      // Shallow-merge top-level keys; deep-merge the provider map so both
      // the inherited providers and our injected one coexist.
      const mergedProviders = {
        ...((parsed.provider as Record<string, unknown>) ?? {}),
        ...((injected.provider as Record<string, unknown>) ?? {}),
      }
      return JSON.stringify({ ...parsed, ...injected, provider: mergedProviders })
    } catch {
      log.warn("existing OPENCODE_CONFIG_CONTENT is not valid JSON; overwriting")
    }
  }

  return JSON.stringify(injected)
}

/**
 * Thrown when a headless-agent driver subprocess fails (non-zero exit or
 * timeout). Infrastructure failure class — callers that want to treat a
 * subprocess failure as valid empty output must opt in via `throwOnError: false`.
 */
export class HeadlessAgentError extends Error {
  constructor(
    message: string,
    readonly driver: HeadlessAgentDriver,
    readonly exitCode: number,
    readonly timedOut: boolean,
    readonly stderr: string,
  ) {
    super(message)
    this.name = "HeadlessAgentError"
  }
}

export function isHeadlessAgentError(err: unknown): err is HeadlessAgentError {
  return err instanceof HeadlessAgentError
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Identifier for the concrete agent backend. Extend as more are added. */
export type HeadlessAgentDriver = "opencode"

export interface HeadlessAgentRunOptions {
  /** Working directory the agent will operate in (its cwd). */
  cwd: string
  /** The prompt given to the agent. */
  prompt: string
  /**
   * LLM model id to pass to the driver. This is a string in the *driver's*
   * namespace, not the SkVM `LLMProvider` namespace. For opencode, if the id
   * does not already start with the `headlessAgent.modelPrefix` configured
   * in `skvm.config.json` (default `"openrouter/"`), the prefix is prepended
   * before spawn. Users who want to route to opencode's Anthropic / local
   * providers should set `modelPrefix` accordingly (or to `""` for fully
   * qualified ids).
   */
  model: string
  /** Optional kill timeout. */
  timeoutMs?: number
  /** Driver selection; defaults to the system default driver. */
  driver?: HeadlessAgentDriver
  /**
   * If true (default), non-zero exit / timeout throws a HeadlessAgentError.
   * Set to false ONLY when the caller is prepared to interpret an empty /
   * partial result (e.g. a validator that expects some runs to crash).
   */
  throwOnError?: boolean
}

export interface HeadlessAgentRunResult {
  /** Process exit code (0 on success). */
  exitCode: number
  /** Wall-clock duration in ms. */
  durationMs: number
  /** Whether we killed the process due to timeout. */
  timedOut: boolean
  /** USD cost extracted from the agent's structured output (0 if unavailable). */
  cost: number
  /** Token usage extracted from the agent's structured output. */
  tokens: TokenUsage
  /** Raw stdout from the agent (structured format depends on driver). */
  rawStdout: string
  /** Raw stderr. */
  rawStderr: string
  /** Driver that produced this result. */
  driver: HeadlessAgentDriver
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const DEFAULT_DRIVER: HeadlessAgentDriver = "opencode"

/**
 * Run a headless agent with the given prompt inside a working directory and
 * wait for it to complete. Returns exit status, tokens, cost, and raw output.
 */
export async function runHeadlessAgent(
  opts: HeadlessAgentRunOptions,
): Promise<HeadlessAgentRunResult> {
  const driver = opts.driver ?? DEFAULT_DRIVER
  if (driver === "opencode") {
    return runOpenCodeDriver(opts)
  }
  throw new Error(`Unknown headless agent driver: ${driver}`)
}

/**
 * Apply `headlessAgent.modelPrefix` from config to a model id for driver spawn.
 */
export function applyHeadlessModelPrefix(model: string): string {
  return prefixModel(model, getHeadlessAgentConfig().modelPrefix)
}

/**
 * Pure prefix-joining helper, exposed for tests. Idempotent — if `model`
 * already starts with `prefix`, returns it unchanged. Empty prefix means
 * pass-through (fully qualified driver-namespace ids).
 */
export function prefixModel(model: string, prefix: string): string {
  if (!prefix) return model
  if (model.startsWith(prefix)) return model
  return `${prefix}${model}`
}

// ---------------------------------------------------------------------------
// opencode driver
// ---------------------------------------------------------------------------

async function runOpenCodeDriver(
  opts: HeadlessAgentRunOptions,
): Promise<HeadlessAgentRunResult> {
  const cwd = path.resolve(opts.cwd)
  const resolved = await resolveOpenCodeCmd()
  const config = getHeadlessAgentConfig()
  const model = prefixModel(opts.model, config.modelPrefix)

  const cmd = [
    ...resolved.cmd,
    "run",
    `IMPORTANT: Do not ask clarifying questions. Proceed directly.\n\n${opts.prompt}`,
    "--dir", cwd,
    "--model", model,
    "--agent", "build",
    "--pure",
    "--format", "json",
  ]

  log.debug(`spawn: ${cmd.slice(0, 3).join(" ")} ... (cwd=${cwd})`)

  // Build env overlay: start with opencode resolution env (XDG isolation for
  // bundled builds), then layer on OPENCODE_CONFIG_CONTENT when a
  // providerOverride is configured.
  const envOverlay: Record<string, string> = { ...resolved.env }

  if (config.providerOverride) {
    const modelIdInProvider = stripRoutingPrefix(model)
    const content = buildOpenCodeConfigContent(config.providerOverride, modelIdInProvider)
    envOverlay.OPENCODE_CONFIG_CONTENT = content
    log.info(`injecting OPENCODE_CONFIG_CONTENT for provider "${config.providerOverride.name}" (model=${modelIdInProvider})`)
  }

  const env = Object.keys(envOverlay).length > 0
    ? { ...process.env, ...envOverlay }
    : process.env

  const start = Date.now()
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  if (opts.timeoutMs) {
    timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, opts.timeoutMs)
  }

  // Read stdout/stderr concurrently with waiting for exit to avoid pipe
  // deadlock — if the child's output exceeds the OS pipe buffer (~64 KB on
  // macOS) while the parent is blocked on `proc.exited`, neither side can
  // make progress.
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited.then((code) => { if (timer) clearTimeout(timer); return code }),
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const durationMs = Date.now() - start

  const throwOnError = opts.throwOnError ?? true
  if (throwOnError && (exitCode !== 0 || timedOut)) {
    const suffix = timedOut ? " (timed out)" : ""
    throw new HeadlessAgentError(
      `opencode subprocess failed with exit=${exitCode}${suffix}: ${stderr.slice(0, 500) || "(no stderr)"}`,
      "opencode",
      exitCode,
      timedOut,
      stderr,
    )
  }

  // Extract cost + tokens from the structured output. opencode emits NDJSON;
  // other drivers would parse their own format here.
  const events = parseNDJSON(stdout)
  const runStats = eventsToRunResult(events, cwd, durationMs)

  return {
    exitCode,
    durationMs,
    timedOut,
    cost: runStats.cost,
    tokens: runStats.tokens,
    rawStdout: stdout,
    rawStderr: stderr,
    driver: "opencode",
  }
}
