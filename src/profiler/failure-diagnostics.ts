import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import type { AgentStep, RunResult } from "../core/types.ts"
import { formatAgentTrace } from "../framework/evaluator.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCallSummary {
  totalCalls: number
  byTool: Record<string, number>
  errors: { step: number; tool: string; exitCode?: number; output?: string }[]
}

export interface FileChanges {
  created: string[]
  modified: string[]
  deleted: string[]
}

export interface FailureReport {
  primitiveId: string
  level: string
  instance: number
  evalDetails: string
  agentText: string
  adapterError?: { exitCode: number; stderr: string }
  steps: {
    index: number
    role: "assistant" | "tool"
    text?: string
    toolCalls: { name: string; input: string; output?: string; exitCode?: number }[]
  }[]
  toolCallSummary: ToolCallSummary
  fileChanges: FileChanges
  durationMs: number
}

export interface FailureDiagnostics {
  consoleHint: string
  logBlock: string
  report: FailureReport
  enrichedDetails: string
}

// ---------------------------------------------------------------------------
// Tool call summary
// ---------------------------------------------------------------------------

export function summarizeToolCalls(steps: AgentStep[]): ToolCallSummary {
  const byTool: Record<string, number> = {}
  const errors: ToolCallSummary["errors"] = []
  let totalCalls = 0

  for (let i = 0; i < steps.length; i++) {
    for (const tc of steps[i]!.toolCalls) {
      totalCalls++
      byTool[tc.name] = (byTool[tc.name] ?? 0) + 1
      if (tc.exitCode !== undefined && tc.exitCode !== 0) {
        errors.push({ step: i, tool: tc.name, exitCode: tc.exitCode, output: tc.output?.slice(0, 200) })
      }
    }
  }

  return { totalCalls, byTool, errors }
}

// ---------------------------------------------------------------------------
// File changes
// ---------------------------------------------------------------------------

export async function computeFileChanges(
  workDir: string,
  setupFiles?: Record<string, string>,
): Promise<FileChanges> {
  const setupKeys = new Set(Object.keys(setupFiles ?? {}))
  // response.txt is always written by the profiler, not the agent
  setupKeys.add("response.txt")

  const created: string[] = []
  const modified: string[] = []
  const deleted: string[] = []

  let entries: string[] = []
  try {
    entries = await listFilesRecursive(workDir)
  } catch {
    return { created, modified, deleted }
  }

  for (const rel of entries) {
    if (rel === "response.txt") continue
    if (!setupKeys.has(rel)) {
      created.push(rel)
    } else if (setupFiles && rel in setupFiles) {
      try {
        const current = await readFile(path.join(workDir, rel), "utf-8")
        if (current !== setupFiles[rel]) modified.push(rel)
      } catch {
        // can't read — treat as unmodified
      }
    }
  }

  if (setupFiles) {
    for (const key of Object.keys(setupFiles)) {
      if (!entries.includes(key)) deleted.push(key)
    }
  }

  return { created, modified, deleted }
}

async function listFilesRecursive(dir: string, prefix = ""): Promise<string[]> {
  const result: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) {
      result.push(...await listFilesRecursive(path.join(dir, e.name), rel))
    } else {
      result.push(rel)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Console hint
// ---------------------------------------------------------------------------

export function buildConsoleHint(
  summary: ToolCallSummary,
  fileChanges: FileChanges,
  adapterError?: { exitCode: number; stderr: string },
  stepCount?: number,
): string {
  if (stepCount === 0) {
    if (adapterError) return `(0 steps, adapter exit=${adapterError.exitCode})`
    return "(0 steps, no response)"
  }

  if (summary.errors.length > 0) {
    const e = summary.errors[0]!
    const exitPart = e.exitCode !== undefined ? ` exit=${e.exitCode}` : ""
    return `(${summary.totalCalls} calls, error: ${e.tool}${exitPart})`
  }

  const writes = summary.byTool["write_file"] ?? summary.byTool["write"] ?? 0
  return `(${summary.totalCalls} calls, ${writes} writes, ${fileChanges.created.length} files created)`
}

// ---------------------------------------------------------------------------
// Full diagnostics builder
// ---------------------------------------------------------------------------

export async function buildFailureDiagnostics(opts: {
  runResult: RunResult
  evalDetails: string
  setupFiles?: Record<string, string>
  primitiveId: string
  level: string
  instanceIndex: number
  workDir: string
  durationMs: number
}): Promise<FailureDiagnostics> {
  const { steps, text, adapterError } = opts.runResult
  const summary = summarizeToolCalls(steps)
  const fileChanges = await computeFileChanges(opts.workDir, opts.setupFiles)
  const consoleHint = buildConsoleHint(summary, fileChanges, adapterError, steps.length)

  // Build report steps
  const reportSteps = steps.map((s, i) => ({
    index: i,
    role: s.role,
    text: s.text?.slice(0, 500),
    toolCalls: s.toolCalls.map((tc) => ({
      name: tc.name,
      input: JSON.stringify(tc.input).slice(0, 300),
      output: tc.output?.slice(0, 500),
      exitCode: tc.exitCode,
    })),
  }))

  const report: FailureReport = {
    primitiveId: opts.primitiveId,
    level: opts.level,
    instance: opts.instanceIndex,
    evalDetails: opts.evalDetails,
    agentText: text,
    adapterError,
    steps: reportSteps,
    toolCallSummary: summary,
    fileChanges,
    durationMs: opts.durationMs,
  }

  // Log block for file output
  const lines: string[] = []
  lines.push(`--- Failure diagnostics for ${opts.primitiveId} ${opts.level} instance ${opts.instanceIndex} ---`)
  lines.push(`Eval: ${opts.evalDetails}`)

  if (adapterError) {
    if (adapterError.diagnosis) {
      lines.push(`Adapter error: ${adapterError.diagnosis.summary} (source=${adapterError.diagnosis.source})`)
      if (adapterError.diagnosis.hint) lines.push(`  ${adapterError.diagnosis.hint}`)
    } else {
      lines.push(`Adapter error: exit=${adapterError.exitCode}, stderr: ${adapterError.stderr.slice(0, 500)}`)
    }
  }

  if (steps.length === 0) {
    lines.push("Agent returned 0 steps (no conversation recorded)")
    if (text) {
      lines.push(`Agent final text: ${text.slice(0, 500)}`)
    }
  } else {
    const toolParts = Object.entries(summary.byTool).map(([k, v]) => `${k}: ${v}`).join(", ")
    lines.push(`Tool calls: ${summary.totalCalls} total${toolParts ? ` (${toolParts})` : ""}${summary.errors.length ? `, ${summary.errors.length} error(s)` : ""}`)

    if (fileChanges.created.length || fileChanges.modified.length || fileChanges.deleted.length) {
      lines.push(`Files: created=[${fileChanges.created.join(", ")}] modified=[${fileChanges.modified.join(", ")}] deleted=[${fileChanges.deleted.join(", ")}]`)
    } else {
      lines.push("Files: no changes")
    }

    lines.push(formatAgentTrace(steps, { maxInputLen: 300, maxOutputLen: 300 }))
  }

  lines.push("---")

  const logBlock = lines.join("\n")

  // Enriched details for TCP failureDetails
  const fileSummary = `+${fileChanges.created.length} ~${fileChanges.modified.length} -${fileChanges.deleted.length}`
  const adapterPart = adapterError ? `, adapter exit=${adapterError.exitCode}` : ""
  const enrichedDetails = `${opts.evalDetails} | ${steps.length} steps, ${summary.totalCalls} calls${summary.errors.length ? ` (${summary.errors.length} err)` : ""}${adapterPart}, files: ${fileSummary}`

  return { consoleHint, logBlock, report, enrichedDetails }
}
