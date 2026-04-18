import path from "node:path"
import { mkdir, rm, copyFile, readdir } from "node:fs/promises"
import type { AgentAdapter, AdapterConfig, AdapterConfigMode, RunResult, AgentStep, ToolCall, SkillMode, ProviderRoute } from "../core/types.ts"
import { emptyTokenUsage } from "../core/types.ts"
import { createLogger } from "../core/logger.ts"
import { getAdapterRepoDir, getAdapterSettings, getProvidersConfig, routingPrefix, stripRoutingPrefix } from "../core/config.ts"
import { HEADLESS_AGENT_DEFAULTS, TASK_FILE_DEFAULTS } from "../core/ui-defaults.ts"
import {
  createSandbox,
  ensureDir,
  copyFileIfExists,
  symlinkIfExists,
  type Sandbox,
} from "../core/adapter-sandbox.ts"
import { resolveRoute, resolveRouteApiKey } from "../providers/registry.ts"

const log = createLogger("openclaw")

const BOOTSTRAP_FILES = ["SOUL.md", "BOOTSTRAP.md", "USER.md", "IDENTITY.md", "HEARTBEAT.md", "TOOLS.md"]
const HOME = process.env.HOME ?? ""
const USER_OPENCLAW_DIR = path.join(HOME, ".openclaw")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function normalizeAgentId(id: string): string {
  return id.replace(/[:./]/g, "-").toLowerCase()
}

async function runCommand(
  cmd: string[],
  opts?: { cwd?: string; timeout?: number; env?: Record<string, string | undefined> },
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const env = opts?.env && Object.keys(opts.env).length > 0
    ? mergeEnv(process.env, opts.env)
    : process.env
  const proc = Bun.spawn(cmd, {
    cwd: opts?.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
  })

  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  if (opts?.timeout) {
    timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, opts.timeout)
  }

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited.then((code) => { if (timer) clearTimeout(timer); return code }),
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { stdout, stderr, exitCode, timedOut }
}

function mergeEnv(
  base: NodeJS.ProcessEnv,
  overlay: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (typeof v === "string") out[k] = v
  for (const [k, v] of Object.entries(overlay)) {
    if (v === undefined) delete out[k]
    else out[k] = v
  }
  return out
}

// ---------------------------------------------------------------------------
// CLI Resolution
// ---------------------------------------------------------------------------

async function resolveOpenClawCmd(): Promise<string[]> {
  const repoDir = getAdapterRepoDir("openclaw")
  if (repoDir) {
    const entryPoint = path.join(repoDir, "openclaw.mjs")
    try {
      const entryExists = await Bun.file(entryPoint).exists()
      if (entryExists) {
        const distDir = path.join(repoDir, "dist")
        const distEntries = await readdir(distDir)
        if (distEntries.length > 0) {
          log.info(`Using local OpenClaw dev: ${repoDir}`)
          return ["node", entryPoint]
        }
      }
    } catch { /* not found */ }
    throw new Error(
      `openclaw entry point not found at ${repoDir}/openclaw.mjs (ensure dist/ is built)`,
    )
  }

  const { exitCode, stdout } = await runCommand(["which", "openclaw"])
  if (exitCode === 0 && stdout.trim()) {
    log.info(`Using global openclaw: ${stdout.trim()}`)
    return [stdout.trim()]
  }

  throw new Error(
    "openclaw not found. Either install it globally or set adapters.openclaw in skvm.config.json",
  )
}

// ---------------------------------------------------------------------------
// Transcript Parsing
// ---------------------------------------------------------------------------

interface OpenClawTranscriptEntry {
  type: string
  message?: {
    role: string
    content: unknown
    toolCallId?: string
    toolName?: string
    usage?: {
      input?: number
      output?: number
      cacheRead?: number
      cacheWrite?: number
      totalTokens?: number
      cost?: { total?: number }
    }
  }
}

function parseTranscript(lines: string[]): OpenClawTranscriptEntry[] {
  const entries: OpenClawTranscriptEntry[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      log.warn(`Failed to parse transcript line: ${line.slice(0, 100)}`)
    }
  }
  return entries
}

function transcriptToRunResult(
  entries: OpenClawTranscriptEntry[],
  workDir: string,
  durationMs: number,
): RunResult {
  const steps: AgentStep[] = []
  let totalTokens = emptyTokenUsage()
  let totalCost = 0
  let finalText = ""

  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue
    const msg = entry.message

    if (msg.usage) {
      totalTokens = {
        input: totalTokens.input + (msg.usage.input ?? 0),
        output: totalTokens.output + (msg.usage.output ?? 0),
        cacheRead: totalTokens.cacheRead + (msg.usage.cacheRead ?? 0),
        cacheWrite: totalTokens.cacheWrite + (msg.usage.cacheWrite ?? 0),
      }
      totalCost += msg.usage.cost?.total ?? 0
    }

    if (msg.role === "assistant") {
      const toolCalls: ToolCall[] = []
      let text = ""

      const contentItems = Array.isArray(msg.content)
        ? msg.content
        : typeof msg.content === "string"
          ? [{ type: "text", text: msg.content }]
          : []

      for (const item of contentItems as Record<string, unknown>[]) {
        if (item.type === "text" && typeof item.text === "string") {
          text += item.text
        } else if (item.type === "toolCall" || item.type === "tool_use") {
          toolCalls.push({
            id: (item.id as string) ?? `tc-${Date.now()}`,
            name: (item.name as string) ?? "",
            input: (item.arguments ?? item.params ?? item.input ?? {}) as Record<string, unknown>,
            output: undefined,
          })
        }
      }

      steps.push({
        role: "assistant",
        text: text || undefined,
        toolCalls,
        timestamp: Date.now(),
      })

      if (text) finalText = text
    } else if (msg.role === "toolResult" || msg.role === "tool") {
      const contentItems = Array.isArray(msg.content)
        ? msg.content
        : typeof msg.content === "string"
          ? [{ type: "text", text: msg.content }]
          : []

      const toolCalls: ToolCall[] = []
      for (const item of contentItems as Record<string, unknown>[]) {
        const output = typeof item.text === "string" ? item.text
          : typeof item.output === "string" ? item.output
          : typeof item.content === "string" ? item.content
          : ""
        toolCalls.push({
          id: msg.toolCallId ?? (item.toolCallId as string) ?? (item.id as string) ?? "",
          name: msg.toolName ?? "",
          input: {},
          output,
        })
      }

      if (toolCalls.length > 0) {
        steps.push({
          role: "tool",
          toolCalls,
          timestamp: Date.now(),
        })
      }
    }
  }

  return {
    text: finalText,
    steps,
    tokens: totalTokens,
    cost: totalCost,
    durationMs,
    llmDurationMs: 0,
    workDir,
    runStatus: "ok",
  }
}

// ---------------------------------------------------------------------------
// Managed-mode provider synthesis from providers.routes
// ---------------------------------------------------------------------------

/**
 * Translate skvm `providers.routes` into openclaw `models.providers` entries
 * for the top-level `openclaw.json`. openclaw's resolver requires a non-empty
 * `models[]` array on each provider block (see
 * `src/agents/pi-embedded-runner/model.ts:251-399 buildInlineProviderModels`);
 * attach a synthetic entry only on the active provider — the rest stay
 * auth-only since openclaw won't route to them in this run.
 *
 * Pricing field is zero — skvm doesn't own cost metering for custom
 * endpoints; accurate numbers come from the underlying SDK or the user's
 * own models.json.
 */
export interface OpenclawModelEntry {
  id: string
  name: string
  reasoning: boolean
  input: readonly string[]
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow: number
  maxTokens: number
}

export interface OpenclawProviderEntry {
  baseUrl: string
  api: string
  apiKey?: string
  models: OpenclawModelEntry[]
}

// Pricing placeholder — not to be confused with `emptyTokenUsage()` which
// tracks observed counts at runtime.
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

function buildDefaultModelEntry(bareId: string): OpenclawModelEntry {
  return {
    id: bareId,
    name: bareId,
    reasoning: false,
    input: ["text"] as const,
    cost: ZERO_COST,
    contextWindow: HEADLESS_AGENT_DEFAULTS.contextLimit,
    maxTokens: HEADLESS_AGENT_DEFAULTS.outputLimit,
  }
}

/**
 * Emit the single `models.providers` entry for the active model's prefix.
 * Shape matches openclaw's `ModelProviderSchema` at
 * `src/config/zod-schema.core.ts:250-263`: `{baseUrl, api, apiKey?, models[]}`.
 * `baseUrl` is required (min 1 char) and `models[]` is required — we can't
 * emit auth-only blocks for other routes.
 */
export function renderOpenclawProviderEntries(
  routes: readonly ProviderRoute[],
  model: string,
): Record<string, OpenclawProviderEntry> {
  const activePrefix = routingPrefix(model)
  const bareModel = stripRoutingPrefix(model)
  const route = routes.find((r) => routingPrefix(r.match) === activePrefix)
  if (!route) return {}
  const baseUrl = route.baseUrl ?? defaultBaseUrl(route.kind)
  if (!baseUrl) {
    throw new Error(
      `openclaw (managed): route "${route.match}" (kind=${route.kind}) is missing baseUrl; ` +
      `add it to providers.routes in skvm.config.json.`,
    )
  }
  const resolvedKey = resolveRouteApiKey(route) ?? route.apiKeyEnv ?? ""
  return {
    [activePrefix]: {
      api: route.kind === "anthropic" ? "anthropic-messages" : "openai-completions",
      baseUrl,
      ...(resolvedKey ? { apiKey: resolvedKey } : {}),
      models: [buildDefaultModelEntry(bareModel)],
    },
  }
}

function defaultBaseUrl(kind: ProviderRoute["kind"]): string | undefined {
  switch (kind) {
    case "openrouter": return "https://openrouter.ai/api/v1"
    case "anthropic":  return "https://api.anthropic.com/v1"
    case "openai-compatible": return undefined
  }
}

// ---------------------------------------------------------------------------
// Sandbox + pool
// ---------------------------------------------------------------------------

interface PoolAgent {
  agentId: string
  agentDir: string       // <sandbox>/agents/<agentId>/agent
  sessionsDir: string    // <sandbox>/agents/<agentId>/sessions
  workspaceDir: string   // <sandbox>/agents/<agentId>/workspace
}

const NATIVE_IDENTITY_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "BOOTSTRAP.md",
  "HEARTBEAT.md",
  "TOOLS.md",
  "USER.md",
]

const NATIVE_COPY_FILES = [
  "models.json",
  "auth-profiles.json",
  "auth.json",
]

class OpenclawSandboxPool {
  private sandbox: Sandbox | undefined
  private cmdPrefix: string[] = []
  private mode: AdapterConfigMode = "managed"
  private poolCap = 1
  private agents: PoolAgent[] = []
  private heldByThisProcess = new Set<string>()
  private nativeSourceAgent = "main"
  private initModel = ""
  private initialized = false
  private initPromise: Promise<void> | null = null

  /**
   * Initialize the sandbox + pool. `poolSize` is the managed-mode pool size;
   * native mode is always serialized (concurrency=1) since it clones a single
   * user source agent and running two sessions against the same agent dir is
   * unsafe.
   */
  async init(config: {
    mode: AdapterConfigMode
    nativeSourceAgent: string
    poolSize: number
    model: string
  }): Promise<void> {
    if (this.initialized) return
    if (this.initPromise) { await this.initPromise; return }
    this.initPromise = this._init(config)
    try { await this.initPromise } finally { this.initPromise = null }
  }

  private async _init(config: {
    mode: AdapterConfigMode
    nativeSourceAgent: string
    poolSize: number
    model: string
  }): Promise<void> {
    this.mode = config.mode
    this.nativeSourceAgent = config.nativeSourceAgent
    this.initModel = config.model
    this.cmdPrefix = await resolveOpenClawCmd()
    log.info(`openclaw command: ${this.cmdPrefix.join(" ")}`)

    this.sandbox = createSandbox("openclaw")
    const root = this.sandbox.root
    ensureDir(path.join(root, "agents"))

    this.poolCap = config.mode === "native" ? 1 : config.poolSize
    if (config.mode === "native") {
      await this.provisionNativeAgent(root, config.nativeSourceAgent)
    } else {
      await this.provisionManagedAgent(root, 0)
    }

    await this.writeOpenclawJson(root)
    this.initialized = true
    log.info(`openclaw sandbox ready (${config.mode}) at ${root}, ${this.agents.length} agent(s)`)
  }

  // -------------------------------------------------------------------------
  // Provisioning
  // -------------------------------------------------------------------------

  private async provisionNativeAgent(
    root: string,
    sourceAgent: string,
  ): Promise<void> {
    const srcAgentRoot = path.join(USER_OPENCLAW_DIR, "agents", sourceAgent)
    const srcAgentDir = path.join(srcAgentRoot, "agent")
    try { await readdir(srcAgentDir) } catch {
      throw new Error(
        `openclaw native mode: source agent directory not found at ${srcAgentDir}. ` +
        `Run \`skvm config init --adapter=openclaw\` to pick a valid agent, or set ` +
        `adapters.openclaw.nativeSourceAgent in skvm.config.json.`,
      )
    }

    const dstAgentRoot = path.join(root, "agents", sourceAgent)
    const dstAgentDir = path.join(dstAgentRoot, "agent")
    const dstSessionsDir = path.join(dstAgentRoot, "sessions")
    const dstWorkspaceDir = path.join(dstAgentRoot, "workspace")
    ensureDir(dstAgentDir)
    ensureDir(dstSessionsDir)
    ensureDir(dstWorkspaceDir)

    for (const f of [...NATIVE_COPY_FILES, ...NATIVE_IDENTITY_FILES]) {
      copyFileIfExists(path.join(srcAgentDir, f), path.join(dstAgentDir, f))
    }

    const sandboxWorkspace = path.join(root, "workspace")
    ensureDir(sandboxWorkspace)
    symlinkIfExists(
      path.join(USER_OPENCLAW_DIR, "workspace", "skills"),
      path.join(sandboxWorkspace, "skills"),
    )
    symlinkIfExists(path.join(USER_OPENCLAW_DIR, "plugins"), path.join(root, "plugins"))

    this.agents.push({
      agentId: sourceAgent,
      agentDir: dstAgentDir,
      sessionsDir: dstSessionsDir,
      workspaceDir: dstWorkspaceDir,
    })
  }

  private async provisionManagedAgent(
    root: string,
    index: number,
  ): Promise<PoolAgent> {
    const agentId = `skvm-${index}`
    const agentRoot = path.join(root, "agents", agentId)
    const agentDir = path.join(agentRoot, "agent")
    const sessionsDir = path.join(agentRoot, "sessions")
    const workspaceDir = path.join(agentRoot, "workspace")
    ensureDir(agentDir)
    ensureDir(sessionsDir)
    ensureDir(workspaceDir)

    const agent: PoolAgent = { agentId, agentDir, sessionsDir, workspaceDir }
    this.agents.push(agent)
    return agent
  }

  private async writeOpenclawJson(root: string): Promise<void> {
    const list = this.agents.map((a) => ({
      id: a.agentId,
      name: a.agentId,
      workspace: a.workspaceDir,
      agentDir: a.agentDir,
      // Object form + empty fallbacks stops openclaw cascading to its
      // hardcoded DEFAULT_MODEL (anthropic/claude-opus-4-6); the string form
      // still inherits `agents.defaults.model.fallbacks`.
      model: { primary: this.initModel, fallbacks: [] },
    }))
    const doc: Record<string, unknown> = { agents: { list } }
    if (this.mode === "managed") {
      const routes = getProvidersConfig().routes
      doc.models = { providers: renderOpenclawProviderEntries(routes, this.initModel) }
    }
    await Bun.write(path.join(root, "openclaw.json"), JSON.stringify(doc, null, 2))
  }

  // -------------------------------------------------------------------------
  // In-process acquire / release
  // -------------------------------------------------------------------------

  async acquire(): Promise<PoolAgent> {
    if (!this.initialized) throw new Error("OpenclawSandboxPool not initialized")
    const start = Date.now()
    while (true) {
      for (const agent of this.agents) {
        if (this.heldByThisProcess.has(agent.agentId)) continue
        this.heldByThisProcess.add(agent.agentId)
        return agent
      }
      if (this.mode === "managed" && this.agents.length < this.poolCap) {
        const idx = this.agents.length
        const next = await this.provisionManagedAgent(this.sandbox!.root, idx)
        await this.writeOpenclawJson(this.sandbox!.root)
        this.heldByThisProcess.add(next.agentId)
        return next
      }
      if (Date.now() - start > 600_000) {
        throw new Error(`Timed out waiting for an available openclaw agent (pool size=${this.agents.length})`)
      }
      await Bun.sleep(250)
    }
  }

  release(agent: PoolAgent): void {
    this.heldByThisProcess.delete(agent.agentId)
  }

  get cmdPrefixValue(): string[] { return this.cmdPrefix }
  get sandboxRoot(): string { return this.sandbox?.root ?? "" }
  get sandboxMode(): AdapterConfigMode { return this.mode }

  teardown(): void {
    if (!this.sandbox) return
    const sb = this.sandbox
    this.sandbox = undefined
    this.initialized = false
    this.agents = []
    sb.teardown()
  }
}

// ---------------------------------------------------------------------------
// OpenClaw Adapter
// ---------------------------------------------------------------------------

export class OpenClawAdapter implements AgentAdapter {
  readonly name = "openclaw"
  private model = ""
  private timeoutMs: number = TASK_FILE_DEFAULTS.timeoutMs
  private pool: OpenclawSandboxPool | undefined
  private extraCliArgs: string[] = []

  async setup(config: AdapterConfig): Promise<void> {
    this.model = config.model
    this.timeoutMs = config.timeoutMs

    const mode = config.mode ?? "managed"
    const settings = getAdapterSettings("openclaw")
    const nativeSourceAgent = config.nativeSourceAgent ?? settings.nativeSourceAgent ?? "main"
    this.extraCliArgs = config.extraCliArgs ?? settings.extraCliArgs ?? []

    // Fail-fast model resolution: throw here rather than wait 13 s for
    // openclaw to emit "Unknown model" on stderr.
    if (mode === "managed") {
      try {
        resolveRoute(this.model)
      } catch (err) {
        throw new Error(
          `openclaw (managed): ${(err as Error).message} ` +
          `Add a route via \`skvm config init\`, or switch to --adapter-config=native to use your openclaw models.json directly.`,
        )
      }
    } else {
      // Native mode: model must be resolvable in the source agent's models.json.
      const modelsJsonPath = path.join(
        USER_OPENCLAW_DIR, "agents", nativeSourceAgent, "agent", "models.json",
      )
      try {
        const raw = await Bun.file(modelsJsonPath).text()
        const doc = JSON.parse(raw) as { providers?: Record<string, unknown> }
        const prefix = routingPrefix(this.model)
        const provs = Object.keys(doc.providers ?? {})
        if (!prefix || !provs.includes(prefix)) {
          throw new Error(
            `openclaw (native): provider prefix "${prefix}/" from model "${this.model}" is not in ` +
            `${modelsJsonPath} (providers: ${provs.join(", ") || "(none)"}). ` +
            `Add it to your openclaw models.json, or switch to --adapter-config=managed.`,
          )
        }
      } catch (err) {
        const e = err as Error
        if (e.message.startsWith("openclaw (native)")) throw e
        throw new Error(
          `openclaw (native): failed to read source agent models.json at ${modelsJsonPath}: ${e.message}`,
        )
      }
    }

    const poolSize = mode === "native" ? 1 : (config.providerOptions?.poolSize as number) ?? 8

    this.pool = new OpenclawSandboxPool()
    await this.pool.init({
      mode,
      nativeSourceAgent,
      poolSize,
      model: this.model,
    })
  }

  async run(task: {
    prompt: string
    workDir: string
    skillContent?: string
    skillMode?: SkillMode
    skillMeta?: { name: string; description: string }
    taskId?: string
    convLog?: import("../core/conversation-logger.ts").ConversationLog
    timeoutMs?: number
  }): Promise<RunResult> {
    if (!this.pool) throw new Error("OpenClawAdapter: setup() not called")
    const agent = await this.pool.acquire()
    try {
      return await this.runWithAgent(agent, task)
    } finally {
      this.pool.release(agent)
    }
  }

  async teardown(): Promise<void> {
    this.pool?.teardown()
    this.pool = undefined
  }

  private async runWithAgent(
    agent: PoolAgent,
    task: {
      prompt: string
      workDir: string
      skillContent?: string
      skillMode?: SkillMode
      skillMeta?: { name: string; description: string }
      taskId?: string
      convLog?: import("../core/conversation-logger.ts").ConversationLog
      timeoutMs?: number
    },
  ): Promise<RunResult> {
    const pool = this.pool!
    const ws = agent.workspaceDir
    const skillMode = task.skillMode ?? "inject"
    let skillLoaded: boolean | undefined

    // 1. Clean workspace + sessions
    await rm(ws, { recursive: true, force: true })
    await mkdir(ws, { recursive: true })
    await rm(agent.sessionsDir, { recursive: true, force: true })
    await mkdir(agent.sessionsDir, { recursive: true })

    // 2. Copy task workDir contents into agent workspace
    await runCommand(["cp", "-a", `${task.workDir}/.`, ws])

    // 3. Preserve bootstrap files
    const savedBootstrap: Record<string, Buffer> = {}
    for (const fname of BOOTSTRAP_FILES) {
      const fpath = path.join(ws, fname)
      try {
        const file = Bun.file(fpath)
        if (await file.exists()) {
          savedBootstrap[fname] = Buffer.from(await file.arrayBuffer())
        }
      } catch { /* skip */ }
    }
    for (const [fname, content] of Object.entries(savedBootstrap)) {
      await Bun.write(path.join(ws, fname), content)
    }

    if (task.skillContent) {
      if (skillMode === "inject") {
        const bootstrapPath = path.join(ws, "BOOTSTRAP.md")
        let existing = ""
        try {
          const file = Bun.file(bootstrapPath)
          if (await file.exists()) {
            existing = await file.text()
          }
        } catch { /* no existing file */ }
        const separator = existing ? "\n\n" : ""
        await Bun.write(bootstrapPath, existing + separator + task.skillContent)
        skillLoaded = false
      } else {
        const skillName = task.skillMeta?.name ?? "bench-skill"
        const skillDir = path.join(ws, "skills", skillName)
        await mkdir(skillDir, { recursive: true })
        await Bun.write(path.join(skillDir, "SKILL.md"), task.skillContent)
        skillLoaded = false
      }
    }

    if (pool.sandboxMode === "native") {
      const userSkillsDir = path.join(USER_OPENCLAW_DIR, "workspace", "skills")
      symlinkIfExists(userSkillsDir, path.join(ws, "skills"))
    }

    const startMs = performance.now()
    const sessionId = `bench_${Date.now()}`

    // Only OPENCLAW_STATE_DIR — not OPENCLAW_HOME, which is the user's
    // homedir; child processes (bash, git, ...) still need real HOME for
    // ~/.ssh, ~/.gitconfig, etc.
    const spawnEnv: Record<string, string | undefined> = {
      OPENCLAW_STATE_DIR: pool.sandboxRoot,
    }

    const cmd = [
      ...pool.cmdPrefixValue, "agent",
      "--agent", agent.agentId,
      "--session-id", sessionId,
      "--message", task.prompt,
      // Managed mode has no gateway token; `--local` skips the failing
      // remote-gateway probe. Native users may run their own gateway.
      ...(pool.sandboxMode === "managed" ? ["--local"] : []),
      ...this.extraCliArgs,
    ]

    const { stderr, exitCode, timedOut } = await runCommand(
      cmd,
      {
        cwd: ws,
        timeout: task.timeoutMs ?? this.timeoutMs,
        env: spawnEnv,
      },
    )

    const durationMs = performance.now() - startMs

    if (exitCode !== 0 && stderr) {
      log.warn(`openclaw exited with code ${exitCode}: ${stderr.slice(0, 2000)}`)
    }

    // 5. Copy sandbox workspace back to original task workDir for eval
    await runCommand(["cp", "-a", `${ws}/.`, task.workDir])

    // 6. Load transcript
    const { transcript, rawJsonlPath } = await this.loadTranscript(agent, sessionId)
    if (rawJsonlPath && task.convLog) {
      try {
        const destDir = path.dirname(task.convLog.filePath)
        await mkdir(destDir, { recursive: true })
        await copyFile(rawJsonlPath, task.convLog.filePath)
        log.debug(`Saved openclaw transcript to ${task.convLog.filePath}`)
      } catch (err) {
        log.warn(`Failed to save openclaw transcript: ${err}`)
      }
    }

    // 7. Verify skill load
    if (task.skillContent && skillLoaded === false) {
      const skillName = task.skillMeta?.name ?? "bench-skill"

      if (skillMode === "inject") {
        const hasAssistantMessage = transcript.some(
          e => e.type === "message" && e.message?.role === "assistant",
        )
        if (hasAssistantMessage) skillLoaded = true
      }

      if (!skillLoaded) {
        for (const entry of transcript) {
          if (entry.type !== "message" || !entry.message) continue
          const msg = entry.message
          if (msg.role === "assistant") {
            const contentItems = Array.isArray(msg.content)
              ? msg.content
              : typeof msg.content === "string"
                ? [{ type: "text", text: msg.content }]
                : []
            for (const item of contentItems as Record<string, unknown>[]) {
              if (item.type === "toolCall" || item.type === "tool_use") {
                const toolName = (item.name as string) ?? ""
                if (toolName === "skill" || toolName === "load_skill") {
                  skillLoaded = true
                  break
                }
              }
              if (item.type === "text" && typeof item.text === "string") {
                if (item.text.includes(`skills/${skillName}/SKILL.md`)) {
                  skillLoaded = true
                  break
                }
              }
            }
            if (skillLoaded) break
          }
          if (msg.role === "toolResult" || msg.role === "tool") {
            const contentItems = Array.isArray(msg.content)
              ? msg.content
              : typeof msg.content === "string"
                ? [{ type: "text", text: msg.content }]
                : []
            for (const item of contentItems as Record<string, unknown>[]) {
              const output = typeof item.text === "string" ? item.text
                : typeof item.output === "string" ? item.output
                : typeof item.content === "string" ? item.content
                : ""
              if (output.length > 100 && task.skillContent && output.includes(task.skillContent.slice(0, 50))) {
                skillLoaded = true
                break
              }
            }
            if (skillLoaded) break
          }
        }
      }
    }

    const result = transcriptToRunResult(transcript, task.workDir, durationMs)
    if (skillLoaded !== undefined) {
      result.skillLoaded = skillLoaded
    }
    if (timedOut) {
      result.runStatus = "timeout"
      result.statusDetail = `openclaw subprocess killed after ${task.timeoutMs ?? this.timeoutMs}ms`
    } else if (exitCode !== 0) {
      result.runStatus = "adapter-crashed"
      result.statusDetail = `openclaw exited with code ${exitCode}`
    } else if (transcript.length === 0) {
      result.runStatus = "ok"
      result.statusDetail =
        "openclaw produced no parseable transcript entries — telemetry unavailable, workDir scored as-is"
    }
    if (exitCode !== 0) {
      result.adapterError = { exitCode, stderr: stderr.slice(0, 2000) }
    }
    return result
  }

  private async loadTranscript(
    agent: PoolAgent,
    sessionId: string,
  ): Promise<{ transcript: OpenClawTranscriptEntry[]; rawJsonlPath?: string }> {
    const sessionsDir = agent.sessionsDir

    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const entries = await readdir(sessionsDir, { withFileTypes: true, recursive: true })
        const jsonlFiles = entries
          .filter(e => e.isFile() && (e.name.endsWith(".jsonl") || e.name.endsWith(".ndjson")))
          .map(e => {
            const fullPath = e.parentPath
              ? path.join(e.parentPath, e.name)
              : path.join(sessionsDir, e.name)
            return fullPath
          })

        if (jsonlFiles.length > 0) {
          let bestPath = jsonlFiles[0]!
          let bestMtime = 0
          for (const f of jsonlFiles) {
            const file = Bun.file(f)
            try {
              const stat = file.lastModified
              if (stat > bestMtime) {
                bestMtime = stat
                bestPath = f
              }
            } catch { /* skip */ }
          }

          const content = await Bun.file(bestPath).text()
          const lines = content.split("\n")
          return { transcript: parseTranscript(lines), rawJsonlPath: bestPath }
        }
      } catch { /* retry */ }

      await Bun.sleep(1000)
    }

    log.warn(`No transcript found for session ${sessionId}`)
    return { transcript: [] }
  }
}
