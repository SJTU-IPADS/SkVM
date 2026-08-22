import path from "node:path"
import { mkdir } from "node:fs/promises"
import type { LLMTool, LLMToolCall } from "../providers/types.ts"
import type { ToolResult } from "./agent-loop.ts"

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

/**
 * Resolve the model-provided `timeout_seconds` argument to a millisecond
 * budget. Invalid values (non-number, NaN, <= 0) fall back to the default
 * rather than erroring — a malformed timeout should never fail a command
 * that would otherwise run.
 */
export function resolveCommandTimeoutMs(timeoutSeconds: unknown): number {
  if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return DEFAULT_COMMAND_TIMEOUT_MS
  }
  return Math.min(Math.round(timeoutSeconds * 1000), MAX_COMMAND_TIMEOUT_MS)
}

// ---------------------------------------------------------------------------
// Shared Tool Executor
// ---------------------------------------------------------------------------

export interface AgentToolExecutorOptions {
  /** Require read_file before write_file for existing files */
  requireReadBeforeWrite?: boolean
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
          const toolTimeoutMs = resolveCommandTimeoutMs(args.timeout_seconds)
          const timeoutLabel = `${Math.round(toolTimeoutMs / 1000)}s`
          const READ_TIMEOUT_MS = 2_000
          const proc = Bun.spawn(["sh", "-c", cmd], {
            cwd: workDir,
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, HOME: process.env.HOME },
          })
          const timeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`command timed out after ${timeoutLabel}`)), toolTimeoutMs),
          )
          try {
            const exitCode = await Promise.race([proc.exited, timeout])
            const readWithTimeout = <T>(p: Promise<T>, fallback: T): Promise<T> =>
              Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), READ_TIMEOUT_MS))])
            const stdout = await readWithTimeout(new Response(proc.stdout).text(), "")
            const stderr = await readWithTimeout(new Response(proc.stderr).text(), "")
            const output = [
              stdout ? `stdout:\n${stdout}` : "",
              stderr ? `stderr:\n${stderr}` : "",
              `exit code: ${exitCode}`,
            ].filter(Boolean).join("\n")
            return { output, exitCode, durationMs: performance.now() - start }
          } catch {
            proc.kill()
            return { output: `Error: command timed out after ${timeoutLabel}`, durationMs: performance.now() - start }
          }
        }

        default:
          return { output: `Unknown tool: ${call.name}`, durationMs: performance.now() - start }
      }
    } catch (err) {
      return { output: `Error: ${err}`, durationMs: performance.now() - start }
    }
  }
}
