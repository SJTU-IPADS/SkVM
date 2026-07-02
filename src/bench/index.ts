/**
 * Bench mode handlers (domain logic). The CLI surface — flag definitions,
 * mode dispatch, and all cross-flag validation — lives in `src/cli/bench.ts`;
 * each handler here receives an already-parsed, typed options object.
 * Residual environment/source validation stays in the handlers.
 */

import path from "node:path"
import type { AdapterName } from "../adapters/registry.ts"
import type { BenchRunConfig } from "./types.ts"
import {
  analyzeCompareBenchSkill,
  compareBenchSkill,
  printCompareBenchSkillReport,
  writeCompareBenchSkillOutputs,
} from "./compare.ts"
import { LOGS_DIR } from "../core/config.ts"
import { readdir } from "node:fs/promises"
import { runDeferredJudge, readDeferredResults, mergeDeferredResults } from "../framework/deferred-eval.ts"

const HOME = process.env.HOME ?? ""

// ---------------------------------------------------------------------------
// --import handler
// ---------------------------------------------------------------------------

export async function handleImport(opts: {
  source: string
  path?: string
  exclude?: string
  dryRun: boolean
}): Promise<void> {
  const source = opts.source

  if (source.startsWith("pinchbench")) {
    const pinchbenchDir = opts.path ?? path.join(HOME, "Projects/pinchbench")

    // PinchBench-specific exclusions (not from global config)
    const excludedTasks = opts.exclude
      ? opts.exclude.split(",").map(s => s.trim())
      : ["task_13_image_gen", "task_22_second_brain"]

    console.log(`Importing from PinchBench: ${pinchbenchDir}`)
    if (excludedTasks.length > 0) console.log(`Excluding: ${excludedTasks.join(", ")}`)
    const { importPinchBench } = await import("./importers/pinchbench.ts")
    const { imported, skipped, errors } = await importPinchBench(pinchbenchDir, { excludedTasks })

    console.log(`\nImported: ${imported.length}`)
    for (const i of imported) console.log(`  ${i}`)

    if (skipped.length > 0) {
      console.log(`\nSkipped: ${skipped.length}`)
      for (const s of skipped) console.log(`  ${s}`)
    }
    if (errors.length > 0) {
      console.log(`\nErrors: ${errors.length}`)
      for (const e of errors) console.log(`  ${e}`)
    }

    console.log(`\nTasks written to: skvm-data/tasks/`)
  } else if (source.startsWith("skillsbench")) {
    const skillsbenchDir = opts.path ?? path.join(HOME, "Projects/skillsbench")

    const excludedTasks = opts.exclude
      ? opts.exclude.split(",").map(s => s.trim())
      : []

    const dryRun = opts.dryRun

    console.log(`Importing from SkillsBench: ${skillsbenchDir}`)
    if (dryRun) console.log(`[DRY RUN]`)
    if (excludedTasks.length > 0) console.log(`Excluding: ${excludedTasks.join(", ")}`)

    const { importSkillsBench } = await import("./importers/skillsbench.ts")
    const { imported, skipped, errors, skillsImported, skillCollisions } = await importSkillsBench(
      skillsbenchDir,
      { excludedTasks, dryRun },
    )

    console.log(`\nSkills imported: ${skillsImported}`)
    if (skillCollisions.length > 0) {
      console.log(`\nSkill collisions (same name, different content):`)
      for (const c of skillCollisions) console.log(`  ${c}`)
    }

    console.log(`\nTasks imported: ${imported.length}`)
    for (const i of imported) console.log(`  ${i}`)

    if (skipped.length > 0) {
      console.log(`\nSkipped: ${skipped.length}`)
      for (const s of skipped) console.log(`  ${s}`)
    }
    if (errors.length > 0) {
      console.log(`\nErrors: ${errors.length}`)
      for (const e of errors) console.log(`  ${e}`)
    }

    console.log(`\nTasks written to: skvm-data/tasks/`)
    console.log(`Skills written to: skvm-data/skills/`)
  } else {
    console.error(`Unknown import source: "${source}". Available: pinchbench, skillsbench`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// --list-sessions handler
// ---------------------------------------------------------------------------

/** List bench sessions from unified index, falling back to directory scan for legacy sessions. */
export async function handleListSessions(): Promise<void> {
  const { readSessions } = await import("../core/run-session.ts")

  // Try unified index first
  const indexed = await readSessions({ type: "bench" })
  const indexedIds = new Set(indexed.map(e => e.id))

  // Fall back to directory scan for legacy sessions not in the index
  const benchLogsDir = path.join(LOGS_DIR, "bench")
  let legacyDirs: string[] = []
  try {
    const entries = await readdir(benchLogsDir, { withFileTypes: true })
    legacyDirs = entries
      .filter(e => e.isDirectory() && !indexedIds.has(e.name))
      .map(e => e.name)
      .sort()
  } catch {
    // No bench directory yet
  }

  if (indexed.length === 0 && legacyDirs.length === 0) {
    console.log("No bench sessions found.")
    return
  }

  console.log("Bench sessions:\n")

  // Show indexed sessions first
  for (const e of indexed) {
    const status = e.status.toUpperCase().padEnd(12)
    console.log(`  ${status} ${e.id}`)
    const details: string[] = []
    if (e.models && e.models.length > 1) details.push(`Models: ${e.models.length}`)
    else if (e.models && e.models.length === 1) details.push(`Model: ${e.models[0]}`)
    if (e.harness) details.push(`Adapter: ${e.harness}`)
    if (e.conditions) details.push(`Conditions: ${e.conditions.join(", ")}`)
    if (e.summary) details.push(e.summary)
    if (e.error) details.push(`Error: ${e.error}`)
    console.log(`               ${details.join("  ")}`)
    console.log(`               Started: ${e.startedAt}`)
  }

  // Show legacy sessions (not in index)
  if (legacyDirs.length > 0 && indexed.length > 0) {
    console.log("\n  --- Legacy sessions (pre-index) ---\n")
  }
  for (const sessionId of legacyDirs) {
    const sessionDir = path.join(benchLogsDir, sessionId)
    const reportExists = await Bun.file(path.join(sessionDir, "report.json")).exists()

    try {
      const raw = await Bun.file(path.join(sessionDir, "progress.json")).text()
      const progress = JSON.parse(raw)
      const status = reportExists ? "COMPLETE" : "INCOMPLETE"
      console.log(`  ${status.padEnd(12)} ${sessionId}`)
      console.log(`               Model: ${progress.model}  Adapter: ${progress.adapter}`)
      console.log(`               Started: ${progress.startedAt}  Entries: ${progress.entries?.length ?? 0}`)
    } catch {
      console.log(`  ???          ${sessionId}`)
    }
  }
}

export async function findLatestIncompleteSession(specificId?: string): Promise<{ sessionId: string; model: string } | null> {
  const benchLogsDir = path.join(LOGS_DIR, "bench")

  if (specificId) {
    // Look up a specific session
    const progressFile = path.join(benchLogsDir, specificId, "progress.json")
    try {
      const raw = await Bun.file(progressFile).text()
      const progress = JSON.parse(raw)
      return { sessionId: specificId, model: progress.model }
    } catch {
      return null
    }
  }

  // Find the most recent incomplete session
  let dirs: string[]
  try {
    const entries = await readdir(benchLogsDir, { withFileTypes: true })
    dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort().reverse()
  } catch {
    return null
  }

  for (const sessionId of dirs) {
    const sessionDir = path.join(benchLogsDir, sessionId)
    const reportExists = await Bun.file(path.join(sessionDir, "report.json")).exists()
    if (!reportExists) {
      try {
        const raw = await Bun.file(path.join(sessionDir, "progress.json")).text()
        const progress = JSON.parse(raw)
        return { sessionId, model: progress.model }
      } catch {
        continue
      }
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// judge subcommand
// ---------------------------------------------------------------------------

export async function handleJudge(opts: {
  manifestDir: string
  judgeModel: string
  concurrency: number
}): Promise<void> {
  const { manifestDir, judgeModel, concurrency } = opts

  // Create LLM provider via registry (routes the judge model to the right backend)
  const { createProviderForModel } = await import("../providers/registry.ts")
  const llmProvider = createProviderForModel(judgeModel)

  console.log(`Running async LLM judge`)
  console.log(`  Manifest: ${manifestDir}`)
  console.log(`  Judge model: ${judgeModel}`)
  console.log(`  Concurrency: ${concurrency}`)

  const results = await runDeferredJudge({ manifestDir, llmProvider, concurrency })
  console.log(`\nJudged ${results.length} entries`)

  // Print summary
  const passed = results.filter(r => r.pass).length
  const avgScore = results.length > 0
    ? results.reduce((sum, r) => sum + r.score, 0) / results.length
    : 0
  console.log(`  Passed: ${passed}/${results.length}`)
  console.log(`  Avg score: ${avgScore.toFixed(3)}`)
  console.log(`\nResults written to: ${manifestDir}/results.jsonl`)
}

export async function handleMergeJudge(opts: {
  resultsDir: string
  reportPath: string
}): Promise<void> {
  const { resultsDir, reportPath } = opts

  // Read report
  const reportRaw = await Bun.file(reportPath).text()
  const report = JSON.parse(reportRaw) as import("./types.ts").BenchReport

  // Read deferred results
  const results = await readDeferredResults(resultsDir)
  if (results.length === 0) {
    console.log("No deferred results found")
    return
  }

  // Build taskResultsMap from report
  const taskResultsMap = new Map<string, import("./types.ts").ConditionResult[]>()
  for (const task of report.tasks) {
    taskResultsMap.set(task.taskId, task.conditions)
  }

  // Merge
  mergeDeferredResults(results, taskResultsMap)

  // Re-generate summary
  const { generateReport } = await import("./reporter.ts")
  const updatedReport = generateReport(report.sessionId, { model: report.model, adapter: report.adapter as AdapterName } as BenchRunConfig, report.tasks)

  // Write updated report
  await Bun.write(reportPath, JSON.stringify(updatedReport, null, 2))
  console.log(`Merged ${results.length} deferred judge results into: ${reportPath}`)
}

export async function handleCompare(opts: {
  model: string
  adapter: string
  skillPath: string
  lhs: string
  rhs: string
  outputDir: string
  analyzeModel?: string
}): Promise<void> {
  const { model, adapter, skillPath, lhs, rhs, outputDir, analyzeModel } = opts

  let report = await compareBenchSkill({ model, adapter, skillPath, lhs, rhs })

  if (analyzeModel) {
    const { createProviderForModel } = await import("../providers/registry.ts")
    const provider = createProviderForModel(analyzeModel)
    report = await analyzeCompareBenchSkill(report, provider, analyzeModel)
  }

  printCompareBenchSkillReport(report)

  const outputs = await writeCompareBenchSkillOutputs(report, path.resolve(outputDir))
  console.log(`Per-skill outputs written to: ${outputs.skillDir}`)
  console.log(`  Report JSON: ${outputs.reportJsonPath}`)
  console.log(`  Report MD:   ${outputs.reportMarkdownPath}`)
  console.log(`  Skill Diff:  ${outputs.skillDiffMarkdownPath}`)
}
