import path from "node:path"
import { mkdir } from "node:fs/promises"
import type { LLMTool, LLMToolCall } from "../providers/types.ts"
import type { ToolResult } from "./agent-loop.ts"
import { runSubprocess } from "./subprocess.ts"

// ---------------------------------------------------------------------------
// Shared Tool Definitions
// ---------------------------------------------------------------------------

export const AGENT_TOOLS: LLMTool[] = [
  {
    name: "read_file",
    description: "Read the contents of a file at the given path relative to the working directory.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Relative file path" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file at the given path relative to the working directory. Creates directories as needed. You MUST read_file first before writing (unless creating a new file).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "execute_command",
    description: "Execute a shell command in the working directory. Returns stdout, stderr, and exit code.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeout_seconds: {
          type: "number",
          description: "Optional timeout in seconds for long-running commands (default 30, max 600). Raise this when a command legitimately needs more than 30s (large batch jobs, test suites).",
        },
      },
      required: ["command"],
    },
  },
]

// ---------------------------------------------------------------------------
// Command timeout resolution
// ---------------------------------------------------------------------------

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
export const MAX_COMMAND_TIMEOUT_MS = 600_000

/** Shortest timeout worth honouring — below this, nothing can finish. */
const MIN_COMMAND_TIMEOUT_MS = 1_000

/**
 * Resolve the model-provided `timeout_seconds` argument to a millisecond
 * budget. Invalid values (non-numeric, NaN, <= 0) fall back to the default
 * rather than erroring — a malformed timeout should never fail a command that
 * would otherwise run. Numeric strings are accepted, because models emit them
 * routinely and silently getting the default instead of the 60s you asked for
 * is worse than parsing the string.
 *
 * `capMs` is the caller's own remaining budget. The static 600s ceiling bounds a
 * single call, but a run has a deadline too, and the agent loop can only check
 * it BETWEEN iterations — an in-flight tool call is never interrupted. Without
 * this, `timeout_seconds: 600` inside a 120s run runs to completion and the run
 * is retroactively labelled timed-out.
 */
export function resolveCommandTimeoutMs(timeoutSeconds: unknown, capMs?: number): number {
  const raw = typeof timeoutSeconds === "string" ? Number(timeoutSeconds) : timeoutSeconds
  const ceiling = capMs !== undefined && capMs > 0
    ? Math.min(MAX_COMMAND_TIMEOUT_MS, capMs)
    : MAX_COMMAND_TIMEOUT_MS
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return Math.max(MIN_COMMAND_TIMEOUT_MS, Math.min(DEFAULT_COMMAND_TIMEOUT_MS, ceiling))
  }
  return Math.max(MIN_COMMAND_TIMEOUT_MS, Math.min(Math.round(raw * 1000), ceiling))
}

// ---------------------------------------------------------------------------
// Shared Tool Executor
// ---------------------------------------------------------------------------

export interface AgentToolExecutorOptions {
  /** Require read_file before write_file for existing files */
  requireReadBeforeWrite?: boolean
  /**
   * Milliseconds left in the caller's own budget, evaluated per call. A tool
   * call cannot be interrupted once it starts, so the run's deadline has to
   * bound the tool's timeout up front rather than after the fact.
   */
  commandTimeoutCapMs?: () => number
}

export function createAgentToolExecutor(
  workDir: string,
  opts?: AgentToolExecutorOptions,
): (call: LLMToolCall) => Promise<ToolResult> {
  const readPaths = new Set<string>()

  return async (call: LLMToolCall): Promise<ToolResult> => {
    const start = performance.now()
    const args = call.arguments

    try {
      switch (call.name) {
        case "read_file": {
          const filePath = path.resolve(workDir, args.path as string)
          const file = Bun.file(filePath)
          if (!(await file.exists())) {
            return { output: `Error: File not found: ${args.path}`, durationMs: performance.now() - start }
          }
          if (opts?.requireReadBeforeWrite) {
            readPaths.add(filePath)
          }
          return { output: await file.text(), durationMs: performance.now() - start }
        }

        case "write_file": {
          const filePath = path.resolve(workDir, args.path as string)
          if (opts?.requireReadBeforeWrite) {
            const exists = await Bun.file(filePath).exists()
            if (exists && !readPaths.has(filePath)) {
              return {
                output: `Error: You must read_file('${args.path}') before writing to it. This ensures you're editing from the current content, not generating from scratch.`,
                durationMs: performance.now() - start,
              }
            }
          }
          await mkdir(path.dirname(filePath), { recursive: true })
          await Bun.write(filePath, args.content as string)
          return { output: `File written: ${args.path}`, durationMs: performance.now() - start }
        }

        case "execute_command": {
          const cmd = args.command as string
          // Block commands that could kill the parent process (e.g. agent running `pkill bun`)
          if (/\b(pkill|killall)\b/.test(cmd)) {
            return {
              output: "Error: pkill/killall are not allowed. Use `kill <PID>` to stop a specific process.",
              durationMs: performance.now() - start,
            }
          }
          const toolTimeoutMs = resolveCommandTimeoutMs(args.timeout_seconds, opts?.commandTimeoutCapMs?.())
          const timeoutLabel = `${Math.round(toolTimeoutMs / 1000)}s`
          // Route through runSubprocess rather than spawning here: it escalates
          // SIGTERM -> reap children -> SIGKILL, and bounds its drains on child
          // exit. The hand-rolled version SIGTERM'd once and returned from its
          // catch without ever reading the pipes — which is the exact shape that
          // wedges on a SIGTERM-immune tree holding stdout open, and `sh -c`
          // forks routinely.
          const result = await runSubprocess(["sh", "-c", cmd], {
            cwd: workDir,
            timeoutMs: toolTimeoutMs,
          })
          if (result.timedOut) {
            return { output: `Error: command timed out after ${timeoutLabel}`, durationMs: performance.now() - start }
          }
          const output = [
            result.stdout ? `stdout:\n${result.stdout}` : "",
            result.stderr ? `stderr:\n${result.stderr}` : "",
            result.drainTruncated ? "(output truncated: a background process was still writing)" : "",
            `exit code: ${result.exitCode}`,
          ].filter(Boolean).join("\n")
          return { output, exitCode: result.exitCode, durationMs: performance.now() - start }
        }

        default:
          return { output: `Unknown tool: ${call.name}`, durationMs: performance.now() - start }
      }
    } catch (err) {
      return { output: `Error: ${err}`, durationMs: performance.now() - start }
    }
  }
}
