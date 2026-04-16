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
import type { TokenUsage } from "./types.ts"
import { getHeadlessAgentConfig } from "./config.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("headless-agent")

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
  const model = applyHeadlessModelPrefix(opts.model)

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

  const env = Object.keys(resolved.env).length > 0
    ? { ...process.env, ...resolved.env }
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
