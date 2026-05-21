import path from "node:path"
import {
  parseNDJSON,
  eventsToRunResult,
  resolveHeadlessOpenCodeCmd,
} from "../../adapters/opencode.ts"
import { resolveRoute, resolveRouteApiKey } from "../../providers/registry.ts"
import { stripRoutingPrefix } from "../config.ts"
import { createLogger } from "../logger.ts"
import { buildOpenCodeConfigContent } from "../adapter-sandbox.ts"
import {
  spawnDriverSubprocess,
  type HeadlessAgentRunOptions,
  type HeadlessAgentRunResult,
} from "./shared.ts"

const log = createLogger("headless-agent")

export async function runOpenCodeDriver(
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

  const { exitCode, stdout, stderr, durationMs, timedOut } =
    await spawnDriverSubprocess("opencode", cmd, env, {
      cwd, timeoutMs: opts.timeoutMs, throwOnError: opts.throwOnError,
    })

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
