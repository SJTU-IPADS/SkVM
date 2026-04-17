import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { AgentAdapter, AdapterConfig, RunResult, AgentStep, ToolCall, TokenUsage, SkillMode } from "../core/types.ts"
import { emptyTokenUsage } from "../core/types.ts"
import { createLogger } from "../core/logger.ts"
import { getAdapterRepoDir, expandHome } from "../core/config.ts"
import { TASK_FILE_DEFAULTS } from "../core/ui-defaults.ts"
import { runCommand } from "./opencode.ts"

const log = createLogger("pi")

// ---------------------------------------------------------------------------
// Pi NDJSON Event Types
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
// Event Parsing
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
// Build RunResult from Pi events
// ---------------------------------------------------------------------------

export function piEventsToRunResult(
  events: PiEvent[],
  workDir: string,
  durationMs: number,
): RunResult {
  // Prefer the last agent_end.messages for the full transcript.
  const agentEndEvents = events.filter((e): e is Extract<PiEvent, { type: "agent_end" }> => e.type === "agent_end")
  const lastAgentEnd = agentEndEvents[agentEndEvents.length - 1]

  let messages: PiMessage[] = lastAgentEnd?.messages ? [...lastAgentEnd.messages] : []

  if (messages.length === 0) {
    // Fallback: collect message_end events if agent_end is missing (timeout/kill)
    const messageEnds = events.filter((e): e is Extract<PiEvent, { type: "message_end" }> => e.type === "message_end")
    for (const me of messageEnds) {
      if (me.message.role === "assistant" || me.message.role === "toolResult") {
        messages.push(me.message)
      }
    }
  }

  const steps: AgentStep[] = []
  let totalTokens = emptyTokenUsage()
  let totalCost = 0
  let finalText = ""
  const errors: string[] = []

  // Map to track tool call outputs from toolResult messages
  const toolOutputMap = new Map<string, { output: string; exitCode?: number }>()

  // First pass: collect tool results
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      const text = msg.content
        .filter((c): c is PiTextContent => c.type === "text")
        .map((c) => c.text)
        .join("")
      toolOutputMap.set(msg.toolCallId, {
        output: text,
        exitCode: msg.isError ? 1 : 0,
      })
    }
  }

  // Second pass: build steps
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const textParts = msg.content
        .filter((c): c is PiTextContent => c.type === "text")
        .map((c) => c.text)
      const text = textParts.join("")
      if (text) {
        finalText = text
      }

      const toolCalls: ToolCall[] = msg.content
        .filter((c): c is PiToolCallContent => c.type === "toolCall")
        .map((tc) => {
          const out = toolOutputMap.get(tc.id)
          return {
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
            output: out?.output,
            exitCode: out?.exitCode,
          }
        })

      steps.push({
        role: "assistant",
        text: text || undefined,
        toolCalls,
        timestamp: msg.timestamp,
      })

      // Accumulate usage
      const usage = msg.usage
      if (usage) {
        totalTokens = {
          input: totalTokens.input + (usage.input ?? 0),
          output: totalTokens.output + (usage.output ?? 0),
          cacheRead: totalTokens.cacheRead + (usage.cacheRead ?? 0),
          cacheWrite: totalTokens.cacheWrite + (usage.cacheWrite ?? 0),
        }
        totalCost += usage.cost?.total ?? 0
      }

      if (msg.stopReason === "error" && msg.errorMessage) {
        errors.push(msg.errorMessage)
      }
    } else if (msg.role === "toolResult") {
      const text = msg.content
        .filter((c): c is PiTextContent => c.type === "text")
        .map((c) => c.text)
        .join("")
      const out = toolOutputMap.get(msg.toolCallId)
      steps.push({
        role: "tool",
        toolCalls: [
          {
            id: msg.toolCallId,
            name: msg.toolName,
            input: {},
            output: text,
            exitCode: out?.exitCode,
          },
        ],
        timestamp: msg.timestamp,
      })
    }
  }

  // Determine run status based on final assistant message
  const lastAssistant = messages
    .filter((m): m is PiAssistantMessage => m.role === "assistant")
    .pop()

  let runStatus: RunResult["runStatus"] = "ok"
  let statusDetail: string | undefined

  if (!lastAgentEnd && messages.length === 0) {
    runStatus = "parse-failed"
    statusDetail = "pi produced no parseable events — telemetry only, workDir scored as-is"
  } else if (lastAssistant?.stopReason === "error") {
    statusDetail = `pi assistant stopped with error: ${lastAssistant.errorMessage ?? "unknown"}`
    // Still ok if workDir is populated; adapterError carries the details
  }

  const result: RunResult = {
    text: finalText,
    steps,
    tokens: totalTokens,
    cost: totalCost,
    durationMs,
    llmDurationMs: 0,
    workDir,
    runStatus,
    ...(statusDetail ? { statusDetail } : {}),
  }

  if (errors.length > 0) {
    result.adapterError = { exitCode: 1, stderr: errors.join("; ").slice(0, 2000) }
  }

  return result
}

// ---------------------------------------------------------------------------
// Command Resolution
// ---------------------------------------------------------------------------

export async function resolvePiCmd(): Promise<string[]> {
  // 1. Custom path from skvm.config.json
  const repoDir = getAdapterRepoDir("pi")
  if (repoDir) {
    const pkgDir = path.join(repoDir, "packages/pi-coding-agent")
    const entryPoint = path.join(pkgDir, "src/index.ts")
    if (await Bun.file(entryPoint).exists()) {
      log.info(`Using pi from source: ${repoDir}`)
      return ["bun", "run", "--cwd", pkgDir, "src/index.ts", "--"]
    }
    const binaryPath = path.join(repoDir, "bin", "pi")
    if (await Bun.file(binaryPath).exists()) {
      log.info(`Using pi binary from repo: ${binaryPath}`)
      return [binaryPath]
    }
    throw new Error(`pi not found at ${repoDir} (no src/index.ts or bin/pi)`)
  }

  // 2. Global install
  const { exitCode, stdout } = await runCommand(["which", "pi"])
  if (exitCode === 0 && stdout.trim()) {
    log.info(`Using global pi: ${stdout.trim()}`)
    return [stdout.trim()]
  }

  // 3. npx fallback
  log.info("Falling back to npx pi")
  return ["npx", "-y", "@mariozechner/pi-coding-agent"]
}

// ---------------------------------------------------------------------------
// Model Translation
// ---------------------------------------------------------------------------

/**
 * Translate SkVM model ID to pi --model format.
 *
 * Pi accepts:
 *   --model provider/id       (e.g., openrouter/anthropic/claude-sonnet-4.6)
 *   --model id:thinking       (e.g., sonnet:high)
 *
 * SkVM bench config uses OpenRouter-style identifiers like:
 *   anthropic/claude-sonnet-4.6
 *   qwen/qwen3-30b-a3b-instruct-2507
 *
 * If the model already contains a "/", pi interprets the first segment as the
 * provider name. So "anthropic/claude-sonnet-4.6" is valid pi syntax.
 * If the model has NO "/", we prepend "openrouter/" so pi can resolve it.
 */
export function toPiModel(model: string): string {
  if (model.includes("/")) return model
  return `openrouter/${model}`
}

// ---------------------------------------------------------------------------
// Pi Adapter
// ---------------------------------------------------------------------------

export class PiAdapter implements AgentAdapter {
  readonly name = "pi"
  private model = ""
  private timeoutMs: number = TASK_FILE_DEFAULTS.timeoutMs
  private cmdPrefix: string[] = []

  async setup(config: AdapterConfig): Promise<void> {
    this.model = toPiModel(config.model)
    this.timeoutMs = config.timeoutMs ?? TASK_FILE_DEFAULTS.timeoutMs
    this.cmdPrefix = await resolvePiCmd()
    log.info(`pi command: ${this.cmdPrefix.join(" ")}`)
    log.info(`pi model: ${this.model} (from ${config.model})`)
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
    const skillMode = task.skillMode ?? "inject"
    let skillLoaded: boolean | undefined
    let skillPath: string | undefined

    if (task.skillContent) {
      if (skillMode === "inject") {
        // Pi auto-discovers AGENTS.md in the current directory and parent dirs.
        // Write skill content to AGENTS.md in workDir so pi loads it as context.
        await Bun.write(path.join(task.workDir, "AGENTS.md"), task.skillContent)
        skillLoaded = false
      } else {
        // Discover mode: write skill to a file and pass --skill <path>
        const skillName = task.skillMeta?.name ?? "bench-skill"
        const skillDir = path.join(task.workDir, ".pi-skills", skillName)
        await mkdir(skillDir, { recursive: true })
        await Bun.write(path.join(skillDir, "SKILL.md"), task.skillContent)
        skillPath = skillDir
        skillLoaded = false
      }
    }

    const startMs = performance.now()

    // Prepend directive to suppress clarification questions in non-interactive bench mode
    const prompt = `IMPORTANT: Do not ask clarifying questions. Proceed directly with implementation. Execute all steps immediately without waiting for user input.\n\n${task.prompt}`

    const cmd = [
      ...this.cmdPrefix,
      "-p", prompt,
      "--mode", "json",
      "--no-session",
      "--model", this.model,
      "--tools", "read,bash,edit,write",
      "--no-extensions",
    ]

    if (task.skillContent) {
      if (skillMode === "discover") {
        if (skillPath) {
          cmd.push("--skill", skillPath)
        }
        cmd.push("--no-skills", "--no-context-files")
      }
      // For inject mode, do NOT pass --no-context-files so AGENTS.md is loaded
    } else {
      // No skill at all — disable context files and skills for clean bench
      cmd.push("--no-context-files", "--no-skills")
    }

    const { stdout, stderr, exitCode, timedOut } = await runCommand(cmd, {
      cwd: task.workDir,
      timeout: task.timeoutMs ?? this.timeoutMs,
    })

    const durationMs = performance.now() - startMs

    if (exitCode !== 0 && stderr) {
      log.warn(`pi exited with code ${exitCode}: ${stderr.slice(0, 200)}`)
    }

    // Save raw NDJSON to convLog path if available
    if (task.convLog && stdout.trim()) {
      try {
        const destDir = path.dirname(task.convLog.filePath)
        await mkdir(destDir, { recursive: true })
        await Bun.write(task.convLog.filePath, stdout)
        log.debug(`Saved pi NDJSON to ${task.convLog.filePath}`)
      } catch (err) {
        log.warn(`Failed to save pi NDJSON: ${err}`)
      }
    }

    const events = parsePiNDJSON(stdout)
    const result = piEventsToRunResult(events, task.workDir, durationMs)

    // Verify skill was actually loaded
    if (task.skillContent && skillLoaded === false) {
      const skillSnippet = task.skillContent.replace(/^#.*\n/m, "").trim().slice(0, 60)

      if (skillMode === "inject") {
        // Inject: if agent produced any steps, skill was loaded (it's in AGENTS.md)
        if (result.steps.length > 0) {
          skillLoaded = true
        }
      }

      // Check if any assistant text references skill content
      if (!skillLoaded && skillSnippet.length > 20) {
        for (const step of result.steps) {
          if (step.role === "assistant" && step.text?.includes(skillSnippet)) {
            skillLoaded = true
            break
          }
        }
      }
    }

    if (skillLoaded !== undefined) {
      result.skillLoaded = skillLoaded
    }

    // Subprocess-level failure overrides
    if (timedOut) {
      result.runStatus = "timeout"
      result.statusDetail = `pi subprocess killed after ${task.timeoutMs ?? this.timeoutMs}ms`
    } else if (exitCode !== 0) {
      result.runStatus = "adapter-crashed"
      result.statusDetail = `pi exited with code ${exitCode}`
    }
    if (exitCode !== 0) {
      result.adapterError = { exitCode, stderr: stderr.slice(0, 2000) }
    }

    return result
  }

  async teardown(): Promise<void> {
    // No persistent state to clean up
  }
}
