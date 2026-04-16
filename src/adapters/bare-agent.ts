import path from "node:path"
import { readdir, mkdir } from "node:fs/promises"
import type { AgentAdapter, AdapterConfig, RunResult, AgentStep, ToolCall, TokenUsage, SkillMode } from "../core/types.ts"
import { emptyTokenUsage, addTokenUsage } from "../core/types.ts"
import type { LLMProvider, LLMTool, LLMToolCall, LLMToolResult, LLMResponse, CompletionParams } from "../providers/types.ts"
import type { RuntimeHooks } from "../runtime/types.ts"
import { runAgentLoop } from "../core/agent-loop.ts"
import { AGENT_TOOLS, createAgentToolExecutor } from "../core/agent-tools.ts"
import { estimateCost } from "../core/cost.ts"
import { createLogger } from "../core/logger.ts"
import { ConversationSession, type ConversationLog } from "../core/conversation-logger.ts"
import { LoggingProvider } from "../core/logging-provider.ts"
import { TASK_FILE_DEFAULTS } from "../core/ui-defaults.ts"

const log = createLogger("bare-agent")

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

const LIST_DIRECTORY_TOOL: LLMTool = {
  name: "list_directory",
  description: "List files and directories at the given path relative to the working directory.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "Relative directory path (default: '.')" } },
  },
}

const WEB_FETCH_TOOL: LLMTool = {
  name: "web_fetch",
  description: "Fetch a URL and return the response body. Supports GET and POST.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
      method: { type: "string", description: "HTTP method (default: GET)" },
      headers: { type: "object", description: "Request headers" },
      body: { type: "string", description: "Request body (for POST)" },
    },
    required: ["url"],
  },
}

const TOOLS: LLMTool[] = [...AGENT_TOOLS, LIST_DIRECTORY_TOOL, WEB_FETCH_TOOL]

// ---------------------------------------------------------------------------
// Tool Execution
// ---------------------------------------------------------------------------

export function createToolExecutor(workDir: string) {
  const sharedExecutor = createAgentToolExecutor(workDir)

  return async (toolCall: LLMToolCall): Promise<{ output: string; exitCode?: number; durationMs: number }> => {
    // Delegate shared tools (read_file, write_file, execute_command)
    if (["read_file", "write_file", "execute_command"].includes(toolCall.name)) {
      return sharedExecutor(toolCall)
    }

    const start = performance.now()
    const args = toolCall.arguments

    try {
      switch (toolCall.name) {
        case "list_directory": {
          const dirPath = path.resolve(workDir, (args.path as string) ?? ".")
          const entries = await readdir(dirPath, { withFileTypes: true })
          const listing = entries
            .map((e) => `${e.isDirectory() ? "[dir]" : "[file]"} ${e.name}`)
            .join("\n")
          return { output: listing || "(empty directory)", durationMs: performance.now() - start }
        }

        case "web_fetch": {
          const FETCH_TIMEOUT_MS = 30_000
          const method = (args.method as string) ?? "GET"
          const headers = (args.headers as Record<string, string>) ?? {}
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
          try {
            const fetchOpts: RequestInit = { method, headers, signal: controller.signal }
            if (args.body) fetchOpts.body = args.body as string
            const res = await fetch(args.url as string, fetchOpts)
            const body = await res.text()
            return { output: `HTTP ${res.status}\n${body}`, durationMs: performance.now() - start }
          } finally {
            clearTimeout(timer)
          }
        }

        default:
          return { output: `Unknown tool: ${toolCall.name}`, durationMs: performance.now() - start }
      }
    } catch (err) {
      return { output: `Error: ${err}`, durationMs: performance.now() - start }
    }
  }
}

// ---------------------------------------------------------------------------
// Discover Mode Helpers
// ---------------------------------------------------------------------------

async function copySkillToDiscoverDir(
  task: { skillContent: string; skillMeta: { name: string; description: string } },
  workDir: string,
): Promise<void> {
  const skillDir = path.join(workDir, "skills", task.skillMeta.name)
  await mkdir(skillDir, { recursive: true })
  await Bun.write(path.join(skillDir, "SKILL.md"), task.skillContent)
}

const LOAD_SKILL_RE = /<?load-skill>\s*(.*?)\s*<\/load-skill>/

// ---------------------------------------------------------------------------
// Bare Agent Adapter
// ---------------------------------------------------------------------------

export class BareAgentAdapter implements AgentAdapter {
  readonly name = "bare-agent"
  private provider!: LLMProvider
  private model = ""
  private maxSteps: number = TASK_FILE_DEFAULTS.maxSteps
  private timeoutMs: number = TASK_FILE_DEFAULTS.timeoutMs
  private hooks: RuntimeHooks = {}

  constructor(
    private providerFactory: (config: AdapterConfig) => LLMProvider,
    hooks?: RuntimeHooks,
  ) {
    if (hooks) this.hooks = hooks
  }

  /** Update hooks at runtime (e.g., after solidification state changes) */
  setHooks(hooks: RuntimeHooks) {
    this.hooks = hooks
  }

  async setup(config: AdapterConfig): Promise<void> {
    this.provider = this.providerFactory(config)
    this.model = config.model
    this.maxSteps = config.maxSteps
    this.timeoutMs = config.timeoutMs
  }

  async run(task: {
    prompt: string
    workDir: string
    skillContent?: string
    skillMode?: SkillMode
    skillMeta?: { name: string; description: string }
    taskId?: string
    convLog?: ConversationLog
    timeoutMs?: number
  }): Promise<RunResult> {
    const startMs = performance.now()
    const skillMode = task.skillMode ?? "inject"

    // Wrap provider with logging if conversation logging is enabled
    // Prefer explicitly-provided convLog (e.g. from bench/profiler) over session singleton
    let activeProvider: LLMProvider = this.provider
    const convLog = task.convLog ?? ConversationSession.get()?.createLog(task.taskId ?? task.prompt.slice(0, 40)) ?? null
    if (convLog) {
      activeProvider = new LoggingProvider(this.provider, convLog)
    }

    let skillLoaded = false

    // Build system prompt
    let system = "You are a helpful assistant that completes tasks by using tools. Work in the provided directory."

    if (task.skillContent && skillMode === "inject") {
      // Inject mode: embed full skill content in system prompt
      system += `\n\n<skill>\n${task.skillContent}\n</skill>`
      skillLoaded = true
    } else if (task.skillContent && skillMode === "discover" && task.skillMeta) {
      // Discover mode: copy skill dir to workDir, show only name+description in prompt
      await copySkillToDiscoverDir(
        { skillContent: task.skillContent, skillMeta: task.skillMeta },
        task.workDir,
      )
      const skillName = task.skillMeta.name
      system += `\n\n## Available Skills

You have access to domain-specific skills. To load a skill, respond with EXACTLY:

<load-skill>${skillName}</load-skill>

IMPORTANT: Replace "${skillName}" with the exact skill name from the list below. The opening <load-skill> and closing </load-skill> tags are both required.

Available skills:
- **${skillName}**: ${task.skillMeta.description}`
    }

    // --- Hook: beforeLLM (short-circuit support) ---
    // The agent loop doesn't know about hooks. We wrap the provider to intercept
    // the first call and check for solidification short-circuits.
    // For afterLLM/afterTool, we use the loop's callbacks.
    const beforeLLMHooks = this.hooks.beforeLLM
    const allToolCalls: ToolCall[] = []

    // Discover-mode state that needs to be maintained across iterations
    let discoverSkillLoaded = skillLoaded

    // Create a wrapper provider that handles beforeLLM hooks and discover mode
    const wrappedProvider: LLMProvider = {
      name: activeProvider.name,

      complete: async (params) => {
        // Check beforeLLM hooks for short-circuit
        if (beforeLLMHooks) {
          for (const hook of beforeLLMHooks) {
            const result = await hook({
              prompt: task.prompt,
              workDir: task.workDir,
              iteration: 0, // will be overridden — but hooks rarely use this
              previousToolCalls: allToolCalls,
            })
            if (result.action === "replace") {
              // Return a synthetic response with the solidified results
              // The loop will see toolCalls=[] and end_turn, so it will stop
              return {
                text: result.text ?? "",
                toolCalls: [],
                tokens: emptyTokenUsage(),
                durationMs: 0,
                stopReason: "end_turn" as const,
              }
            }
          }
        }
        return activeProvider.complete(params)
      },

      completeWithToolResults: async (params, toolResults, prevResponse) => {
        // Check beforeLLM hooks
        if (beforeLLMHooks) {
          for (const hook of beforeLLMHooks) {
            const result = await hook({
              prompt: task.prompt,
              workDir: task.workDir,
              iteration: 0,
              previousToolCalls: allToolCalls,
            })
            if (result.action === "replace") {
              return {
                text: result.text ?? "",
                toolCalls: [],
                tokens: emptyTokenUsage(),
                durationMs: 0,
                stopReason: "end_turn" as const,
              }
            }
          }
        }
        return activeProvider.completeWithToolResults(params, toolResults, prevResponse)
      },
    }

    const loopResult = await runAgentLoop(
      {
        provider: wrappedProvider,
        model: this.model,
        tools: TOOLS,
        executeTool: createToolExecutor(task.workDir),
        system,
        maxIterations: this.maxSteps,
        timeoutMs: task.timeoutMs ?? this.timeoutMs,
        maxTokens: 16384,
        onAfterLLM: async (response, iteration) => {
          if (skillMode === "discover" && task.skillContent && task.skillMeta && !discoverSkillLoaded) {
            const skillMatch = response.text.match(LOAD_SKILL_RE)
            if (skillMatch) {
              const requestedName = (skillMatch[1] ?? "").trim()
              if (requestedName === task.skillMeta.name) {
                discoverSkillLoaded = true
                skillLoaded = true
              }
            }
          }
          if (this.hooks.afterLLM) {
            for (const hook of this.hooks.afterLLM) {
              await hook({ response, iteration, workDir: task.workDir })
            }
          }
        },
        onAfterTool: this.hooks.afterTool
          ? async (completedCall, iteration) => {
              allToolCalls.push(completedCall)
              for (const hook of this.hooks.afterTool!) {
                await hook({ toolCall: completedCall, workDir: task.workDir, iteration })
              }
            }
          : (completedCall) => { allToolCalls.push(completedCall) },
      },
      [{ role: "user", content: task.prompt }],
    )

    const durationMs = performance.now() - startMs

    const runStatus: RunResult["runStatus"] = loopResult.timedOut
      ? "timeout"
      : loopResult.error
        ? "adapter-crashed"
        : "ok"
    const statusDetail = loopResult.timedOut
      ? `bare-agent loop exceeded timeout ${task.timeoutMs ?? this.timeoutMs}ms after ${loopResult.iterations} iterations`
      : loopResult.error
        ? loopResult.error.message.slice(0, 200)
        : undefined

    const runResult: RunResult = {
      text: loopResult.text,
      steps: loopResult.steps,
      tokens: loopResult.tokens,
      cost: estimateCost(this.model, loopResult.tokens, loopResult.totalCostUsd),
      durationMs,
      llmDurationMs: loopResult.llmDurationMs,
      workDir: task.workDir,
      skillLoaded: task.skillContent ? skillLoaded : undefined,
      runStatus,
      ...(statusDetail ? { statusDetail } : {}),
      ...(loopResult.error ? { adapterError: { exitCode: 1, stderr: loopResult.error.message } } : {}),
    }

    // --- Hook: afterRun ---
    if (this.hooks.afterRun) {
      for (const hook of this.hooks.afterRun) {
        await hook({ result: runResult, success: loopResult.text.length > 0 })
      }
    }

    // Flush conversation log
    if (convLog) await convLog.finalize()

    return runResult
  }

  async teardown(): Promise<void> {
    // nothing to clean up
  }
}
