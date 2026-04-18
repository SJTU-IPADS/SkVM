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
 * The headless agent is a skvm implementation detail — callers just supply a
 * SkVM-namespace model id (e.g. `ipads/gpt-4o`) and the driver derives
 * everything else from `providers.routes`. Users never configure the driver's
 * provider side directly; that's what separates this from the adapter path.
 *
 * Callers (jit-optimize, jit-boost) should import only from this module, not
 * directly from adapter-specific files, so the abstraction stays intact.
 */

import path from "node:path"
import {
  parseNDJSON,
  eventsToRunResult,
  resolveHeadlessOpenCodeCmd,
} from "../adapters/opencode.ts"
import { resolveRoute, resolveRouteApiKey } from "../providers/registry.ts"
import type { TokenUsage } from "./types.ts"
import { assertNoLegacyHeadlessFields, stripRoutingPrefix } from "./config.ts"
import { createLogger } from "./logger.ts"
import { buildOpenCodeConfigContent } from "./adapter-sandbox.ts"

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
   * SkVM-namespace model id (e.g. `anthropic/claude-sonnet-4.6`,
   * `ipads/gpt-4o`, `qwen/qwen3-30b`). The driver derives the
   * opencode-namespace model id + any provider registration from the
   * matching `providers.routes` entry.
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
  // Fail loudly if the user upgraded from the old schema without migrating.
  // Otherwise the deprecated headlessAgent fields get silently ignored and
  // the caller sees a confusing "No providers.routes entry matches …" error
  // for a route they thought they'd already configured.
  assertNoLegacyHeadlessFields()

  const driver = opts.driver ?? DEFAULT_DRIVER
  if (driver === "opencode") {
    return runOpenCodeDriver(opts)
  }
  throw new Error(`Unknown headless agent driver: ${driver}`)
}

// ---------------------------------------------------------------------------
// opencode driver
// ---------------------------------------------------------------------------

async function runOpenCodeDriver(
  opts: HeadlessAgentRunOptions,
): Promise<HeadlessAgentRunResult> {
  const cwd = path.resolve(opts.cwd)
  const resolved = await resolveHeadlessOpenCodeCmd()

  // opts.model already carries a `<provider>/` prefix; opencode uses the same
  // `<provider>/<model>` shape, so the id passes through unchanged.
  const route = resolveRoute(opts.model)
  const apiKey = resolveRouteApiKey(route)

  const cmd = [
    ...resolved.cmd,
    "run",
    `IMPORTANT: Do not ask clarifying questions. Proceed directly.\n\n${opts.prompt}`,
    "--dir", cwd,
    "--model", opts.model,
    "--agent", "build",
    "--pure",
    "--format", "json",
  ]

  log.debug(`spawn: ${cmd.slice(0, 3).join(" ")} ... (cwd=${cwd}, route=${route.match}, model=${opts.model})`)

  // Env overlay: start with opencode's own resolution env (XDG isolation for
  // bundled builds), then layer on standard SDK env vars derived from the
  // matched route so opencode's built-in providers pick up the right creds.
  const envOverlay: Record<string, string> = { ...resolved.env }
  if (apiKey) {
    if (route.kind === "openrouter") envOverlay.OPENROUTER_API_KEY = apiKey
    else if (route.kind === "anthropic") envOverlay.ANTHROPIC_API_KEY = apiKey
  }

  // For openai-compatible routes, register the endpoint as an opencode
  // provider via OPENCODE_CONFIG_CONTENT so opencode knows how to reach it
  // without the user also configuring their global opencode.
  if (route.kind === "openai-compatible") {
    envOverlay.OPENCODE_CONFIG_CONTENT = buildOpenCodeConfigContent(route, stripRoutingPrefix(opts.model))
    log.info(`injecting OPENCODE_CONFIG_CONTENT for route "${route.match}" (model=${opts.model})`)
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
