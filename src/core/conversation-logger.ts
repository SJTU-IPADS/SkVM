import { mkdir } from "node:fs/promises"
import path from "node:path"
import { LOGS_DIR } from "./config.ts"
import type { CompletionParams, LLMResponse, LLMToolResult } from "../providers/types.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("conv-log")

// ---------------------------------------------------------------------------
// Session ID Generation
// ---------------------------------------------------------------------------

export function generateSessionId(argv: string[]): string {
  const now = new Date()
  const ts = [
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("")

  const context = extractContext(argv)
  return `${ts}-${context}`
}

function extractContext(argv: string[]): string {
  // Look for test file/directory argument
  const testArg = argv.find((a) => a.startsWith("test/") || a.includes("/test/"))
  if (testArg) {
    const parts = testArg
      .replace(/^.*?test\//, "")
      .replace(/\.test\.ts$/, "")
      .split("/")
      .filter(Boolean)
    if (parts.length > 0) {
      return sanitize(parts.join("-"))
    }
  }

  // Check --test-name-pattern
  const patIdx = argv.findIndex((a) => a === "--test-name-pattern" || a.startsWith("--test-name-pattern="))
  if (patIdx >= 0) {
    let pattern: string | undefined
    const arg = argv[patIdx]!
    if (arg.includes("=")) {
      pattern = arg.split("=")[1]
    } else {
      pattern = argv[patIdx + 1]
    }
    if (pattern) return sanitize(`pat-${pattern}`)
  }

  // Check for subcommands like "profile", "aot-compile", "bench"
  const subcommands = ["profile", "aot-compile", "bench", "run", "pipeline"]
  for (const a of argv) {
    if (subcommands.includes(a)) return a
  }

  return "all"
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 30)
}

// ---------------------------------------------------------------------------
// Conversation Log (one per adapter.run() call)
// ---------------------------------------------------------------------------

interface LogEntry {
  type: "request" | "response"
  ts: string
  [key: string]: unknown
}

export class ConversationLog {
  private entries: LogEntry[] = []

  constructor(readonly filePath: string) {}

  logRequest(
    params: CompletionParams,
    method: "complete" | "completeWithToolResults",
    toolResults?: LLMToolResult[],
  ): void {
    const entry: LogEntry = {
      type: "request",
      ts: new Date().toISOString(),
      method,
      system: params.system,
      messages: [...params.messages],
      tools: params.tools?.map((t) => ({ name: t.name, description: t.description })),
      maxTokens: params.maxTokens,
      temperature: params.temperature,
    }
    if (toolResults) entry.toolResults = toolResults
    this.entries.push(entry)
  }

  logResponse(response: LLMResponse): void {
    this.entries.push({
      type: "response",
      ts: new Date().toISOString(),
      text: response.text,
      toolCalls: response.toolCalls,
      tokens: response.tokens,
      durationMs: response.durationMs,
      stopReason: response.stopReason,
      // The fleet that served this call, when the provider reports one. Written here because a
      // serving path that is not in the transcript is not diagnosable after the fact — which is
      // the entire point of recording it. Absent for providers that do not report a fleet.
      ...(response.servingProvider !== undefined ? { servingProvider: response.servingProvider } : {}),
    })
  }

  async finalize(): Promise<void> {
    if (this.entries.length === 0) return
    const content = this.entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
    await Bun.write(this.filePath, content)
    log.debug(`Wrote ${this.entries.length} entries to ${this.filePath}`)
  }
}

// ---------------------------------------------------------------------------
// Conversation Session (singleton, one per process)
// ---------------------------------------------------------------------------

let instance: ConversationSession | null | undefined

export class ConversationSession {
  private counter = 0

  private constructor(
    readonly sessionId: string,
    readonly sessionDir: string,
  ) {}

  static get(): ConversationSession {
    if (instance !== undefined && instance !== null) return instance

    const sessionId = generateSessionId(process.argv)
    const sessionDir = path.join(LOGS_DIR, sessionId)
    instance = new ConversationSession(sessionId, sessionDir)

    // Fire-and-forget: write session metadata
    instance.init().catch((err) => log.error(`Failed to init session: ${err}`))

    log.info(`Conversation logging enabled: ${sessionDir}`)
    return instance
  }

  /** Reset singleton (for testing) */
  static reset(): void {
    instance = undefined
  }

  private async init(): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true })
    const meta = {
      sessionId: this.sessionId,
      startedAt: new Date().toISOString(),
      argv: process.argv,
    }
    await Bun.write(path.join(this.sessionDir, "session.json"), JSON.stringify(meta, null, 2))
  }

  createLog(label: string): ConversationLog {
    this.counter++
    const num = String(this.counter).padStart(3, "0")
    const safeLabel = sanitize(label).slice(0, 40)
    const fileName = `conv-${num}-${safeLabel}.jsonl`
    return new ConversationLog(path.join(this.sessionDir, fileName))
  }
}
