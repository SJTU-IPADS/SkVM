import path from "node:path"
import { mkdir, rm, writeFile, copyFile, readdir } from "node:fs/promises"
import { statSync } from "node:fs"
import type { AgentAdapter, AdapterConfig, RunResult, AgentStep, ToolCall, TokenUsage, SkillMode } from "../core/types.ts"
import { emptyTokenUsage } from "../core/types.ts"
import { createLogger } from "../core/logger.ts"
import { getAdapterRepoDir } from "../core/config.ts"
import { tryAcquireFileLock, withFileLock, releaseFileLock } from "../core/file-lock.ts"
import { TASK_FILE_DEFAULTS } from "../core/ui-defaults.ts"

const log = createLogger("openclaw")

const BOOTSTRAP_FILES = ["SOUL.md", "BOOTSTRAP.md", "USER.md", "IDENTITY.md", "HEARTBEAT.md", "TOOLS.md"]
const HOME = process.env.HOME ?? ""
const OPENCLAW_DIR = path.join(HOME, ".openclaw")

// ---------------------------------------------------------------------------
// Two-layer config lock: in-process mutex + cross-process file lock
// ---------------------------------------------------------------------------
//
// The cross-process side uses src/core/file-lock.ts, which handles atomic
// create, stale-holder reaping, and crash cleanup. The in-process mutex is
// still required on top: file-lock is only a cross-process primitive, and
// concurrent awaits within one process would each try to atomically create
// the same file and only one would succeed — the others would spin.
//
const CONFIG_LOCK_PATH = path.join(OPENCLAW_DIR, "openclaw.json.lock")
const CONFIG_LOCK_STALE_MS = 30_000

/** In-process async mutex (serializes concurrent awaits within one process). */
let inProcessLock: Promise<void> = Promise.resolve()

async function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = inProcessLock
  let resolveInProcess!: () => void
  inProcessLock = new Promise<void>((r) => { resolveInProcess = r })
  await prev

  try {
    return await withFileLock(
      CONFIG_LOCK_PATH,
      { staleMs: CONFIG_LOCK_STALE_MS, timeoutMs: 5000 },
      fn,
    )
  } finally {
    resolveInProcess()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function normalizeAgentId(id: string): string {
  return id.replace(/[:./]/g, "-").toLowerCase()
}

async function runCommand(
  cmd: string[],
  opts?: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts?.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
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

// ---------------------------------------------------------------------------
// CLI Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve openclaw CLI command.
 * Priority: custom path from skvm.config.json → globally installed `openclaw`.
 */
async function resolveOpenClawCmd(): Promise<string[]> {
  // 1. Custom path from config
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

  // 2. Global install
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

    // Accumulate tokens
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

      // Content can be string or array of content blocks
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
      // Tool results — openclaw puts toolCallId and toolName at the message level
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
// Shared OpenClaw Agent Pool (cross-process safe)
// ---------------------------------------------------------------------------
//
// Multiple bun processes (profile, bench, jit-optimize) may run concurrently,
// each with their own in-memory OpenClawPool singleton. Cross-process safety
// is achieved via per-agent file locks:
//
//   ~/.openclaw/agents/skvm-{i}/run.lock
//
// acquire() atomically creates run.lock (O_CREAT|O_EXCL). Only the process
// holding the lock may use that agent's workspace and sessions directory.
// release() deletes the lock. Stale locks from crashed processes are cleaned
// up after STALE_RUN_LOCK_MS.
// ---------------------------------------------------------------------------

interface PoolAgent {
  agentId: string
  agentDir: string      // ~/.openclaw/agents/{agentId}/agent
  sessionsDir: string   // ~/.openclaw/agents/{agentId}/sessions
  workspaceDir: string  // /tmp/skvm-openclaw/{agentId}
}

const DEFAULT_POOL_SIZE = 8
const MAX_POOL_SIZE = 16
// 5 min is now a crash-recovery ceiling, not a run-length ceiling: a live
// holder refreshes the lock file's mtime every RUN_LOCK_HEARTBEAT_MS, so only
// abandoned locks can trip the staleness check. A run that legitimately takes
// longer than this (even if it exceeds ACQUIRE_TIMEOUT_MS) is no longer at
// risk of being stolen mid-execution.
const STALE_RUN_LOCK_MS = 300_000
const RUN_LOCK_HEARTBEAT_MS = 60_000
const ACQUIRE_TIMEOUT_MS = 600_000  // 10 min max wait for a free agent
const ACQUIRE_POLL_MS = 1_000       // poll interval when all agents busy

class OpenClawPool {
  private agents: PoolAgent[] = []
  private heldByThisProcess = new Set<string>()  // agentIds currently held
  private cmdPrefix: string[] = []
  private modelsTemplate: Record<string, unknown> = { providers: {} }
  private initPromise: Promise<void> | null = null
  private initialized = false

  /** Initialize pool (idempotent within this process; safe across processes). */
  async init(model: string, poolSize: number = DEFAULT_POOL_SIZE): Promise<void> {
    if (this.initialized) return
    if (this.initPromise) { await this.initPromise; return }
    this.initPromise = this._init(model, poolSize)
    await this.initPromise
  }

  private async _init(model: string, poolSize: number): Promise<void> {
    this.cmdPrefix = await resolveOpenClawCmd()
    log.info(`openclaw command: ${this.cmdPrefix.join(" ")}`)

    // Read and cache main agent's models.json as template
    const mainModelsPath = path.join(OPENCLAW_DIR, "agents", "main", "agent", "models.json")
    try {
      this.modelsTemplate = JSON.parse(await Bun.file(mainModelsPath).text())
    } catch {
      this.modelsTemplate = { providers: {} }
    }

    // Ensure openrouter provider exists in template
    const providers = (this.modelsTemplate.providers ?? {}) as Record<string, Record<string, unknown>>
    if (!providers.openrouter) {
      providers.openrouter = {
        baseUrl: "https://openrouter.ai/api/v1",
        api: "openai-completions",
        models: [],
        apiKey: "OPENROUTER_API_KEY",
      }
    }

    // Provision initial agents and register in openclaw.json (under config lock)
    const openclawConfigPath = path.join(OPENCLAW_DIR, "openclaw.json")
    await withConfigLock(async () => {
      let config: Record<string, unknown>
      try {
        config = JSON.parse(await Bun.file(openclawConfigPath).text())
      } catch {
        config = {}
      }
      if (!config.agents) config.agents = {}
      const agentsConfig = config.agents as Record<string, unknown>
      if (!agentsConfig.list) agentsConfig.list = []
      const agentsList = agentsConfig.list as Record<string, unknown>[]

      let configChanged = false

      for (let i = 0; i < poolSize; i++) {
        const { agent, registered } = await this.provisionAgent(i, model, agentsList)
        this.agents.push(agent)
        if (registered) configChanged = true
      }

      if (configChanged) {
        await Bun.write(openclawConfigPath, JSON.stringify(config, null, 2))
      }
    })

    // Also discover agents created by other processes (e.g. prior run with larger pool)
    this.discoverAgents()

    this.initialized = true
    log.info(`OpenClaw pool initialized: ${this.agents.length} agents (pid=${process.pid})`)
  }

  /**
   * Acquire an agent via cross-process file lock.
   * Scans all known agents, tries to create run.lock atomically.
   * If all busy, expands the pool on-demand up to MAX_POOL_SIZE.
   * Polls with ACQUIRE_POLL_MS interval when at max capacity.
   */
  async acquire(model: string): Promise<PoolAgent> {
    if (!this.initialized) throw new Error("OpenClawPool not initialized")

    const start = Date.now()

    while (true) {
      // Try all known agents
      for (const agent of this.agents) {
        if (this.heldByThisProcess.has(agent.agentId)) continue

        if (this.tryAcquireRunLock(agent)) {
          this.heldByThisProcess.add(agent.agentId)
          try {
            // Post-acquire setup can fail (models.json write, withConfigLock
            // timeout, etc.). Release the lock on any failure so a transient
            // error doesn't permanently remove this slot from the pool — the
            // heartbeat would otherwise keep the leaked lock fresh for the
            // lifetime of this process.
            await this.ensureAgentModel(agent, model)
          } catch (err) {
            this.releaseRunLock(agent)
            this.heldByThisProcess.delete(agent.agentId)
            throw err
          }
          return agent
        }
      }

      // All known agents busy — try expanding the pool
      if (this.agents.length < MAX_POOL_SIZE) {
        // First discover agents other processes may have already created
        this.discoverAgents()

        // Still under max? Create a new one
        if (this.agents.length < MAX_POOL_SIZE) {
          await this.expandPool(model)
          continue // retry immediately — new agent should be free
        }
        // discoverAgents found more agents — loop back to try them
        continue
      }

      // At max capacity, all busy — poll
      if (Date.now() - start > ACQUIRE_TIMEOUT_MS) {
        throw new Error(
          `Timed out waiting for an available openclaw agent ` +
          `(all ${this.agents.length} busy for ${ACQUIRE_TIMEOUT_MS / 1000}s, pid=${process.pid})`,
        )
      }

      log.debug(`All ${this.agents.length} agents busy, waiting... (pid=${process.pid})`)
      await Bun.sleep(ACQUIRE_POLL_MS)
    }
  }

  /** Release an agent: delete run.lock so other processes can acquire it. */
  release(agent: PoolAgent): void {
    this.releaseRunLock(agent)
    this.heldByThisProcess.delete(agent.agentId)
  }

  get resolvedCmdPrefix(): string[] {
    return this.cmdPrefix
  }

  // -------------------------------------------------------------------------
  // Pool expansion
  // -------------------------------------------------------------------------

  /**
   * Provision a single agent: create dirs, write models.json if missing,
   * register in agentsList if not present.
   * Returns the PoolAgent and whether a new entry was added to agentsList.
   */
  private async provisionAgent(
    index: number,
    model: string,
    agentsList: Record<string, unknown>[],
  ): Promise<{ agent: PoolAgent; registered: boolean }> {
    const agentId = `skvm-${index}`
    const agentDir = path.join(OPENCLAW_DIR, "agents", agentId, "agent")
    const sessionsDir = path.join(OPENCLAW_DIR, "agents", agentId, "sessions")
    const workspaceDir = path.join("/tmp", "skvm-openclaw", agentId)

    await mkdir(agentDir, { recursive: true })
    await mkdir(sessionsDir, { recursive: true })
    await mkdir(workspaceDir, { recursive: true })

    // Write models.json only if it doesn't exist yet
    const modelsJsonPath = path.join(agentDir, "models.json")
    if (!await Bun.file(modelsJsonPath).exists()) {
      const agentModelsJson = this.buildModelsJson(this.modelsTemplate, model)
      await Bun.write(modelsJsonPath, JSON.stringify(agentModelsJson, null, 2))
    }

    // Register in openclaw.json if not already present
    let registered = false
    if (!agentsList.find((a) => a.id === agentId)) {
      agentsList.push({
        id: agentId,
        name: agentId,
        workspace: workspaceDir,
        agentDir,
        model: `openrouter/${model}`,
      })
      registered = true
    }

    return { agent: { agentId, agentDir, sessionsDir, workspaceDir }, registered }
  }

  /**
   * Expand pool by one agent. Called when all current agents are busy
   * and we're below MAX_POOL_SIZE.
   */
  private async expandPool(model: string): Promise<void> {
    const nextIndex = this.agents.length

    const openclawConfigPath = path.join(OPENCLAW_DIR, "openclaw.json")
    await withConfigLock(async () => {
      let config: Record<string, unknown>
      try {
        config = JSON.parse(await Bun.file(openclawConfigPath).text())
      } catch {
        config = {}
      }
      if (!config.agents) config.agents = {}
      const agentsConfig = config.agents as Record<string, unknown>
      if (!agentsConfig.list) agentsConfig.list = []
      const agentsList = agentsConfig.list as Record<string, unknown>[]

      const { agent, registered } = await this.provisionAgent(nextIndex, model, agentsList)
      this.agents.push(agent)

      if (registered) {
        await Bun.write(openclawConfigPath, JSON.stringify(config, null, 2))
      }
    })

    log.info(`Pool expanded to ${this.agents.length}/${MAX_POOL_SIZE} agents (pid=${process.pid})`)
  }

  /**
   * Discover agents created by other processes that this process doesn't know about.
   * Scans ~/.openclaw/agents/skvm-{i}/ directories beyond our current list.
   */
  private discoverAgents(): void {
    const knownIds = new Set(this.agents.map(a => a.agentId))

    for (let i = 0; i < MAX_POOL_SIZE; i++) {
      const agentId = `skvm-${i}`
      if (knownIds.has(agentId)) continue

      const agentDir = path.join(OPENCLAW_DIR, "agents", agentId, "agent")
      try {
        statSync(agentDir)
      } catch {
        continue // dir doesn't exist
      }

      // Agent exists but we didn't know about it
      this.agents.push({
        agentId,
        agentDir,
        sessionsDir: path.join(OPENCLAW_DIR, "agents", agentId, "sessions"),
        workspaceDir: path.join("/tmp", "skvm-openclaw", agentId),
      })
      log.debug(`Discovered agent ${agentId} created by another process`)
    }
  }

  // -------------------------------------------------------------------------
  // Per-agent run lock (cross-process) — delegates to src/core/file-lock.ts
  // -------------------------------------------------------------------------

  private runLockPath(agent: PoolAgent): string {
    // agent.agentDir = ~/.openclaw/agents/{agentId}/agent
    // lock at ~/.openclaw/agents/{agentId}/run.lock
    return path.join(path.dirname(agent.agentDir), "run.lock")
  }

  private tryAcquireRunLock(agent: PoolAgent): boolean {
    return tryAcquireFileLock(this.runLockPath(agent), {
      staleMs: STALE_RUN_LOCK_MS,
      heartbeatMs: RUN_LOCK_HEARTBEAT_MS,
      // The spawned `openclaw agent` child can outlive the parent on
      // SIGTERM/SIGHUP or a fatal process.exit. Skipping automatic release
      // on parent exit leaves the lock on disk so it still protects the
      // workspace/sessions dir until heartbeat-death + staleMs reaps it,
      // preventing a concurrent skvm from colliding with the orphaned child.
      releaseOnProcessExit: false,
    })
  }

  private releaseRunLock(agent: PoolAgent): void {
    releaseFileLock(this.runLockPath(agent))
  }

  // -------------------------------------------------------------------------
  // Model management (per-agent, only when holding run.lock)
  // -------------------------------------------------------------------------

  /** Ensure agent is configured for the requested model. Only writes if needed. */
  private async ensureAgentModel(agent: PoolAgent, model: string): Promise<void> {
    // 1. Check if model already in agent's models.json
    const modelsJsonPath = path.join(agent.agentDir, "models.json")
    let needsModelsWrite = false
    try {
      const current = JSON.parse(await Bun.file(modelsJsonPath).text())
      const orModels = ((current.providers?.openrouter?.models) ?? []) as { id: string }[]
      if (!orModels.some(m => m.id === model)) {
        needsModelsWrite = true
      }
    } catch {
      needsModelsWrite = true
    }

    if (needsModelsWrite) {
      const updated = this.buildModelsJson(this.modelsTemplate, model)
      await Bun.write(modelsJsonPath, JSON.stringify(updated, null, 2))
    }

    // 2. Ensure openclaw.json model field is correct
    const openclawConfigPath = path.join(OPENCLAW_DIR, "openclaw.json")
    await withConfigLock(async () => {
      try {
        const config = JSON.parse(await Bun.file(openclawConfigPath).text())
        const agentsList = (config.agents?.list ?? []) as Record<string, unknown>[]
        const entry = agentsList.find((a) => a.id === agent.agentId)
        if (entry && entry.model !== `openrouter/${model}`) {
          entry.model = `openrouter/${model}`
          await Bun.write(openclawConfigPath, JSON.stringify(config, null, 2))
        }
      } catch (err) {
        log.warn(`Failed to update agent model in openclaw.json: ${err}`)
      }
    })

    log.debug(`${agent.agentId} configured for model ${model}`)
  }

  private buildModelsJson(template: Record<string, unknown>, model: string): Record<string, unknown> {
    const result = JSON.parse(JSON.stringify(template)) // deep clone
    const providers = (result.providers ?? {}) as Record<string, Record<string, unknown>>

    if (!providers.openrouter) {
      providers.openrouter = {
        baseUrl: "https://openrouter.ai/api/v1",
        api: "openai-completions",
        models: [],
        apiKey: "OPENROUTER_API_KEY",
      }
    }

    const orModels = (providers.openrouter.models ?? []) as { id: string }[]
    if (!orModels.some(m => m.id === model)) {
      orModels.push({
        id: model,
        name: model,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } as any)
    }
    providers.openrouter.models = orModels
    result.providers = providers
    return result
  }
}

/** Shared singleton pool for all OpenClaw usage (profile + bench). */
const openclawPool = new OpenClawPool()

// ---------------------------------------------------------------------------
// OpenClaw Adapter
// ---------------------------------------------------------------------------

export class OpenClawAdapter implements AgentAdapter {
  readonly name = "openclaw"
  private model = ""
  private timeoutMs: number = TASK_FILE_DEFAULTS.timeoutMs

  async setup(config: AdapterConfig): Promise<void> {
    this.model = config.model
    this.timeoutMs = config.timeoutMs

    const poolSize = (config.providerOptions?.poolSize as number) ?? DEFAULT_POOL_SIZE
    await openclawPool.init(this.model, poolSize)
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
    const agent = await openclawPool.acquire(this.model)
    try {
      return await this.runWithAgent(agent, task)
    } finally {
      openclawPool.release(agent)
    }
  }

  async teardown(): Promise<void> {
    // No-op: pool persists for reuse across profile + bench
  }

  // -------------------------------------------------------------------------
  // Private: run logic using a pool agent
  // -------------------------------------------------------------------------

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
    const ws = agent.workspaceDir
    const skillMode = task.skillMode ?? "inject"
    let skillLoaded: boolean | undefined

    // 1. Clean agent workspace and sessions
    await rm(ws, { recursive: true, force: true })
    await mkdir(ws, { recursive: true })
    await rm(agent.sessionsDir, { recursive: true, force: true })
    await mkdir(agent.sessionsDir, { recursive: true })

    // 2. Copy task workDir contents into agent workspace
    await runCommand(["cp", "-a", `${task.workDir}/.`, ws])

    // 3. Prepare workspace: preserve bootstrap files
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

    // Restore bootstrap files
    for (const [fname, content] of Object.entries(savedBootstrap)) {
      await Bun.write(path.join(ws, fname), content)
    }

    if (task.skillContent) {
      if (skillMode === "inject") {
        // Inject mode: write skill content to BOOTSTRAP.md (append to existing if present)
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
        // Discover mode: copy to skills/<name>/
        const skillName = task.skillMeta?.name ?? "bench-skill"
        const skillDir = path.join(ws, "skills", skillName)
        await mkdir(skillDir, { recursive: true })
        await Bun.write(path.join(skillDir, "SKILL.md"), task.skillContent)
        skillLoaded = false
      }
    }

    // Copy skills from main workspace
    const mainSkillsDir = path.join(HOME, ".openclaw", "workspace", "skills")
    try {
      const entries = await readdir(mainSkillsDir, { withFileTypes: true })
      const destSkillsDir = path.join(ws, "skills")
      await mkdir(destSkillsDir, { recursive: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          await runCommand(["cp", "-r", path.join(mainSkillsDir, entry.name), path.join(destSkillsDir, entry.name)])
        }
      }
    } catch { /* no main skills */ }

    // 4. Execute task in agent workspace
    const startMs = performance.now()
    const sessionId = `bench_${Date.now()}`

    const { stdout, stderr, exitCode, timedOut } = await runCommand(
      [
        ...openclawPool.resolvedCmdPrefix, "agent",
        "--agent", agent.agentId,
        "--session-id", sessionId,
        "--message", task.prompt,
      ],
      { cwd: ws, timeout: task.timeoutMs ?? this.timeoutMs },
    )

    const durationMs = performance.now() - startMs

    if (exitCode !== 0 && stderr) {
      log.warn(`openclaw exited with code ${exitCode}: ${stderr.slice(0, 200)}`)
    }

    // 5. Copy agent workspace back to task workDir (for eval to find agent-created files)
    await runCommand(["cp", "-a", `${ws}/.`, task.workDir])

    // 6. Load transcript and save raw JSONL to convLog path if available
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

    // 7. Verify skill was actually loaded from transcript
    if (task.skillContent && skillLoaded === false) {
      const skillName = task.skillMeta?.name ?? "bench-skill"

      if (skillMode === "inject") {
        const hasAssistantMessage = transcript.some(
          e => e.type === "message" && e.message?.role === "assistant",
        )
        if (hasAssistantMessage) {
          skillLoaded = true
        }
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
      // Best-effort telemetry miss, NOT a workDir taint: the agent workspace
      // was already copied back to task.workDir at the `cp -a` line above
      // BEFORE we attempted to load the transcript. `loadTranscript` retries
      // 10 times waiting for the JSONL file to flush, and it can still come
      // up empty if the file is late-written or its format changed. Mirror
      // hermes/jiuwenclaw round-3 narrowing: clean exit + missing telemetry
      // ⇒ 'ok' so the runner gate evaluates the workDir as-is. See round-5
      // Codex review.
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

    // Strategy: find the most recently modified .jsonl file
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
          // Pick the most recently modified
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

      // Wait for OpenClaw to flush
      await Bun.sleep(1000)
    }

    log.warn(`No transcript found for session ${sessionId}`)
    return { transcript: [] }
  }
}
