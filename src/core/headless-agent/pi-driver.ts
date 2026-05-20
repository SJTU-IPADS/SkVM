/**
 * Pi driver — runs pi-coding-agent in-process via `createAgentSession`.
 *
 * Unlike the opencode driver this is library-mode: no subprocess fork,
 * no NDJSON parse step, typed event objects directly from
 * `session.subscribe()`. Tool execution still spawns child processes
 * for bash etc., but those child processes use stdio: ["ignore",
 * "pipe", "pipe"] internally and never touch skvm's stdout.
 */

import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  readTool, bashTool, editTool, writeTool,
  grepTool, findTool, lsTool,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent"
import {
  piEventsToRunResult,
  toPiModel,
  splitPiModel,
  renderPiBaseUrlOverride,
  renderPiModelRegistration,
  type PiEvent,
} from "../pi-runtime.ts"
import { resolveRoute, resolveRouteApiKey } from "../../providers/registry.ts"
import {
  HeadlessAgentError,
  type HeadlessAgentRunOptions,
  type HeadlessAgentRunResult,
} from "./shared.ts"
import { emptyTokenUsage } from "../types.ts"
import { createLogger } from "../logger.ts"

const log = createLogger("headless-agent")

export async function runPiDriver(
  opts: HeadlessAgentRunOptions,
): Promise<HeadlessAgentRunResult> {
  const cwd = path.resolve(opts.cwd)
  const route = resolveRoute(opts.model)
  const piModel = toPiModel(opts.model, route)
  const { provider: piProvider, modelId: piModelId } = splitPiModel(piModel)

  // Per-call temp agentDir so SettingsManager / models.json are sandboxed.
  // In a fresh tmpdir none exist so all pi defaults apply.
  const agentDir = await mkdtemp(path.join(tmpdir(), "skvm-headless-pi-"))

  // Hoist mutable handles so the outer finally can clean them up regardless
  // of which step threw (model-not-found, SettingsManager.create,
  // resourceLoader.reload, createAgentSession, or session.prompt).
  let timer: ReturnType<typeof setTimeout> | undefined
  let unsubscribe: (() => void) | undefined
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined
  let timedOut = false

  try {
    // Credentials via AuthStorage runtime overrides (same path as pi's
    // --api-key CLI flag). NOT process.env — concurrent calls would race.
    const authStorage = AuthStorage.inMemory()
    const apiKey = resolveRouteApiKey(route)
    if (apiKey) authStorage.setRuntimeApiKey(piProvider, apiKey)

    // Probe pi's built-in catalogue (no models.json). If the id is already
    // known, we must NOT register a {id} stub — that would clobber the
    // built-in's reasoning/contextWindow/maxTokens. We only register the
    // model when pi doesn't know it; for catalogued openai-compatible ids we
    // still need the baseUrl override (which preserves built-in metadata).
    const probe = ModelRegistry.inMemory(authStorage)
    const isCatalogued = probe.find(piProvider, piModelId) !== undefined
    const modelsJson = isCatalogued
      ? renderPiBaseUrlOverride(route)
      : renderPiModelRegistration(route, piModelId)
    const modelsPath = path.join(agentDir, "models.json")
    if (modelsJson) await Bun.write(modelsPath, modelsJson)

    const modelRegistry = ModelRegistry.create(authStorage, modelsPath)
    const model = modelRegistry.find(piProvider, piModelId)
    if (!model) {
      throw new HeadlessAgentError(
        `pi could not resolve model "${piModel}" (route=${route.match}). ` +
        `Check providers.routes maps to a pi-supported provider.`,
        "pi", 1, false, "",
      )
    }

    const settingsManager = SettingsManager.create(cwd, agentDir)
    const sessionManager = SessionManager.inMemory(cwd)
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    })
    await resourceLoader.reload()

    const created = await createAgentSession({
      cwd, agentDir,
      authStorage, modelRegistry,
      model,
      sessionManager, settingsManager,
      resourceLoader,
      tools: [readTool, bashTool, editTool, writeTool, grepTool, findTool, lsTool],
    })
    session = created.session

    const events: AgentSessionEvent[] = []
    unsubscribe = session.subscribe(e => events.push(e))

    if (opts.timeoutMs) {
      // session is assigned above; the ! is safe — if the timer fires, session exists.
      timer = setTimeout(() => { timedOut = true; void session!.abort() }, opts.timeoutMs)
    }

    log.debug(`pi-driver start: cwd=${cwd} model=${piProvider}/${piModelId}`)
    const start = Date.now()
    try {
      await session.prompt(
        `IMPORTANT: Do not ask clarifying questions. Proceed directly ` +
        `with implementation.\n\n${opts.prompt}`,
      )
    } catch (err) {
      const durationMs = Date.now() - start
      if (err instanceof HeadlessAgentError) throw err
      if (opts.throwOnError ?? true) {
        throw new HeadlessAgentError(
          `pi session threw: ${(err as Error).message ?? err}`,
          "pi", 1, timedOut, String((err as Error).stack ?? ""),
        )
      }
      return {
        exitCode: 1, durationMs, timedOut,
        cost: 0, tokens: emptyTokenUsage(),
        rawStdout: "", rawStderr: String(err), driver: "pi",
      }
    }

    const durationMs = Date.now() - start

    if (timedOut && (opts.throwOnError ?? true)) {
      throw new HeadlessAgentError(
        `pi session timed out after ${opts.timeoutMs}ms`,
        "pi", 1, true, "",
      )
    }

    // AgentSessionEvent is a superset of our NDJSON PiEvent; the extra
    // event types (queue_update, compaction_*, auto_retry_*) are not
    // matched by piEventsToRunResult and get filtered out for free.
    const runStats = piEventsToRunResult(events as unknown as PiEvent[], cwd, durationMs)

    // Translate pi-reported agent errors (auth, rate limit, provider 5xx, etc.)
    // into HeadlessAgentError so callers can distinguish "infra failed" from
    // "agent produced an empty result". Subprocess driver gets this for free
    // via exit codes; the library path has to do it explicitly.
    if (runStats.adapterError) {
      if (opts.throwOnError ?? true) {
        throw new HeadlessAgentError(
          `pi agent_end stopReason=error: ${runStats.adapterError.stderr}`,
          "pi", 1, false, runStats.adapterError.stderr,
        )
      }
      // throwOnError: false — mirror the catch-block shape so callers see
      // exitCode=1 and rawStderr populated rather than silent success.
      return {
        exitCode: 1,
        durationMs,
        timedOut,
        cost: runStats.cost,
        tokens: runStats.tokens,
        rawStdout: JSON.stringify(events),
        rawStderr: runStats.adapterError.stderr,
        driver: "pi",
      }
    }

    return {
      exitCode: timedOut ? 1 : 0,
      durationMs,
      timedOut,
      cost: runStats.cost,
      tokens: runStats.tokens,
      rawStdout: JSON.stringify(events),
      rawStderr: "",
      driver: "pi",
    }
  } finally {
    if (timer) clearTimeout(timer)
    unsubscribe?.()
    session?.dispose()
    await rm(agentDir, { recursive: true, force: true })
  }
}
