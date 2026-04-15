import path from "node:path"
import type { BenchCondition, BenchRunConfig } from "./types.ts"
import { BENCH_CONDITIONS, BenchConfigFileSchema, isAotCondition, isValidCondition } from "./types.ts"
import { runBenchmark, runMultiModelBenchmark, runMultiAdapterBenchmark } from "./orchestrator.ts"
import { loadTasks } from "./loader.ts"
import { generateMarkdown } from "./reporter.ts"
import {
  analyzeCompareBenchSkill,
  compareBenchSkill,
  generateCompareBenchSkillMarkdown,
  printCompareBenchSkillReport,
  writeCompareBenchSkillOutputs,
} from "./compare.ts"
import { LOGS_DIR, getBenchLogDir } from "../core/config.ts"
import { mkdir, readdir } from "node:fs/promises"
import { runDeferredJudge, readDeferredResults, mergeDeferredResults } from "../framework/deferred-eval.ts"
import { ALL_ADAPTERS, type AdapterName, isAdapterName } from "../adapters/registry.ts"
import { CLI_DEFAULTS, MODEL_DEFAULTS } from "../core/ui-defaults.ts"

const HOME = process.env.HOME ?? ""

export async function runBench(flags: Record<string, string>): Promise<void> {
  if (flags.help) {
    printHelp()
    return
  }

  // Handle --import=<source>
  if (flags.import) {
    await handleImport(flags)
    return
  }

  // Handle judge subcommand: bun run skvm bench judge --manifest=<dir> --judge-model=<id>
  if (flags.judge !== undefined) {
    await handleJudge(flags)
    return
  }

  // Handle --merge-judge: merge deferred results into an existing report
  if (flags["merge-judge"]) {
    await handleMergeJudge(flags)
    return
  }

  // Handle --list-sessions
  if (flags["list-sessions"] !== undefined) {
    await handleListSessions()
    return
  }

  // Handle --compare skill diff mode
  if (flags.compare !== undefined) {
    await handleCompare(flags)
    return
  }

  // Handle --custom=<file.yaml>: standalone custom plan mode
  if (flags.custom) {
    const { executeCustomPlan } = await import("./custom-plan.ts")
    await executeCustomPlan(flags.custom, flags.resume)
    return
  }

  // Parse conditions
  let conditions: BenchCondition[]
  if (flags.conditions) {
    conditions = flags.conditions.split(",").map(c => c.trim())
    for (const c of conditions) {
      if (!isValidCondition(c)) {
        console.error(`Error: unknown condition "${c}". Valid: ${BENCH_CONDITIONS.join(", ")}, aot-compiled-p<N> (e.g. aot-compiled-p1, aot-compiled-p12, aot-compiled-p23)`)
        process.exit(1)
      }
    }
  } else {
    conditions = [...BENCH_CONDITIONS]
  }

  const tasks = flags.tasks ? flags.tasks.split(",").map(t => t.trim()) : undefined

  // Parse skill mode
  const skillMode = flags["skill-mode"] as "inject" | "discover" | undefined
  if (skillMode && skillMode !== "inject" && skillMode !== "discover") {
    console.error(`Error: unknown skill mode "${skillMode}". Valid: inject, discover`)
    process.exit(1)
  }

  // Parse adapter(s): comma-separated
  const adapterRaw = (flags.adapter ?? CLI_DEFAULTS.adapter).split(",").map(a => a.trim())
  for (const a of adapterRaw) {
    if (!isAdapterName(a)) {
      console.error(`Error: unknown adapter "${a}". Valid: ${ALL_ADAPTERS.join(", ")}`)
      process.exit(1)
    }
  }
  const adapters = adapterRaw as AdapterName[]

  const baseConfig = {
    adapter: adapters[0]!,
    conditions,
    tasks,
    skillMode,
    jitRuns: flags["jit-runs"] ? parseInt(flags["jit-runs"], 10) : CLI_DEFAULTS.jitRuns,
    timeoutMult: flags["timeout-mult"] ? parseFloat(flags["timeout-mult"]) : CLI_DEFAULTS.timeoutMult,
    maxSteps: flags["max-steps"] ? parseInt(flags["max-steps"], 10) : CLI_DEFAULTS.maxSteps,
    judgeModel: flags["judge-model"] ?? MODEL_DEFAULTS.judge,
    compilerModel: flags["compiler-model"],
    source: flags.source ? flags.source.split(",").map(s => s.trim()) : undefined,
    tcpPath: flags.profile,
    resumeSession: flags.resume,
    keepWorkDirs: flags["keep-workdirs"] === "true",
    verbose: flags.verbose === "true",
    concurrency: flags.concurrency ? parseInt(flags.concurrency, 10) : CLI_DEFAULTS.concurrency,
    asyncJudge: flags["async-judge"] === "true" || flags["async-judge"] === "",
    runsPerTask: flags["runs-per-task"] ? parseInt(flags["runs-per-task"], 10) : CLI_DEFAULTS.benchRunsPerTask,
  }

  if (!baseConfig.tcpPath && conditions.some(c => isAotCondition(c))) {
    console.log("Warning: --profile not set. AOT conditions will be skipped.")
    console.log("Run: bun run skvm profile --model=<id> to generate a TCP first.\n")
  }

  // Resolve --resume=latest
  if (baseConfig.resumeSession === "latest") {
    const latest = await findLatestIncompleteSession()
    if (!latest) {
      console.error("No incomplete sessions found to resume.")
      process.exit(1)
    }
    baseConfig.resumeSession = latest.sessionId
    console.log(`Resuming latest incomplete session: ${latest.sessionId} (model: ${latest.model})`)
  }

  // Resolve model(s)
  let models: string[]
  if (baseConfig.resumeSession && !flags.model) {
    // When resuming without explicit --model, use model from the progress file
    const latest = await findLatestIncompleteSession(baseConfig.resumeSession)
    if (latest) {
      models = [latest.model]
      console.log(`Using model from session: ${latest.model}`)
    } else {
      console.error("Error: could not determine model from session. Use --model to specify.")
      process.exit(1)
    }
  } else if (flags.model) {
    models = flags.model.split(",").map(m => m.trim())
  } else {
    console.error("Error: --model is required")
    process.exit(1)
  }

  if (adapters.length > 1 && models.length > 1) {
    console.error("Error: cannot combine multiple adapters with multiple models. Use one axis at a time.")
    process.exit(1)
  }

  if (adapters.length > 1) {
    // Multi-adapter mode: single model, multiple adapters
    await runMultiAdapterBenchmark(adapters, { ...baseConfig, model: models[0]! })
  } else if (models.length > 1) {
    // Multi-model mode: single adapter, multiple models
    await runMultiModelBenchmark(models, baseConfig)
  } else {
    // Single adapter, single model
    const config: BenchRunConfig = { ...baseConfig, model: models[0]! }
    const report = await runBenchmark(config)

    const mdPath = path.join(getBenchLogDir(report.sessionId), "report.md")
    await mkdir(path.dirname(mdPath), { recursive: true })
    await Bun.write(mdPath, generateMarkdown(report))
    console.log(`Markdown report: ${mdPath}`)
  }
}

// ---------------------------------------------------------------------------
// --import handler
// ---------------------------------------------------------------------------

async function handleImport(flags: Record<string, string>): Promise<void> {
  const source = flags.import!

  if (source.startsWith("pinchbench")) {
    const pinchbenchDir = flags.path ?? path.join(HOME, "Projects/pinchbench")

    // PinchBench-specific exclusions (not from global config)
    const excludedTasks = flags.exclude
      ? flags.exclude.split(",").map(s => s.trim())
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
    const skillsbenchDir = flags.path ?? path.join(HOME, "Projects/skillsbench")

    const excludedTasks = flags.exclude
      ? flags.exclude.split(",").map(s => s.trim())
      : []

    const dryRun = flags["dry-run"] === "true" || flags["dry-run"] === ""

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
async function handleListSessions(): Promise<void> {
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

async function findLatestIncompleteSession(specificId?: string): Promise<{ sessionId: string; model: string } | null> {
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

async function handleJudge(flags: Record<string, string>): Promise<void> {
  const manifestDir = flags.judge || flags.manifest
  if (!manifestDir) {
    console.error("Error: --manifest=<dir> is required (directory containing manifest.jsonl)")
    process.exit(1)
  }

  const judgeModel = flags["judge-model"] ?? MODEL_DEFAULTS.judge

  const concurrency = flags.concurrency ? parseInt(flags.concurrency, 10) : CLI_DEFAULTS.benchJudgeConcurrency

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

async function handleMergeJudge(flags: Record<string, string>): Promise<void> {
  const resultsDir = flags["merge-judge"]!
  const reportPath = flags.report
  if (!reportPath) {
    console.error("Error: --report=<path> is required (existing bench report JSON)")
    process.exit(1)
  }

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

async function handleCompare(flags: Record<string, string>): Promise<void> {
  const model = flags.model
  const adapter = flags.adapter ?? CLI_DEFAULTS.adapter
  const skillPath = flags["skill-path"]
  const lhs = flags.lhs
  const rhs = flags.rhs
  const outputDir = flags["output-dir"]
  const analyzeModel = flags["analyze-model"]

  if (!model) {
    console.error("Error: --model=<id> is required for --compare")
    process.exit(1)
  }
  if (!skillPath) {
    console.error("Error: --skill-path=<dir> is required for --compare")
    process.exit(1)
  }
  if (!lhs || !rhs) {
    console.error("Error: --lhs=<condition> and --rhs=<condition> are required for --compare")
    process.exit(1)
  }
  if (!outputDir) {
    console.error("Error: --output-dir=<dir> is required for --compare")
    process.exit(1)
  }
  if (!isValidCondition(lhs) || !isValidCondition(rhs)) {
    console.error(`Error: invalid compare conditions. Valid: ${BENCH_CONDITIONS.join(", ")}, aot-p<N>`) 
    process.exit(1)
  }
  if (lhs === rhs) {
    console.error("Error: --lhs and --rhs must be different")
    process.exit(1)
  }

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

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`skvm bench - Run benchmark across skill optimization conditions

Usage:
  bun run skvm bench [--model=<id>] [options]

Benchmark Options:
  --model=<id,...>       Target model(s), comma-separated.
  --adapter=<name,...>   ${ALL_ADAPTERS.join(" | ")} — comma-separated for
                         multi-adapter mode (default: ${CLI_DEFAULTS.adapter})
  --tasks=<list>         Comma-separated task IDs (default: all)
  --source=<name,...>    Filter tasks by origin source(s), comma-separated
                         (e.g. pinchbench, skillsbench, clawhub)
  --conditions=<list>    no-skill,original,aot-compiled,jit-optimized,jit-boost,aot-compiled-p<N> (default: all)
                         AOT pass variants: aot-compiled-p1, aot-compiled-p2, aot-compiled-p3, aot-compiled-p12, aot-compiled-p23, etc.
  --custom=<file.yaml>   Run a custom bench plan from a YAML file. Defines task-skill
                         mappings, models, and adapters in nested groups. Bypasses
                         the standard condition system entirely.
  --skill-mode=<mode>    inject | discover (default: ${CLI_DEFAULTS.skillMode})
  --jit-runs=<n>         JIT-boost warm-up runs (default: ${CLI_DEFAULTS.jitRuns})
  --timeout-mult=<n>     Multiply task timeouts (default: ${CLI_DEFAULTS.timeoutMult.toFixed(1)})
  --max-steps=<n>        Max agent steps per task (default: ${CLI_DEFAULTS.maxSteps})
  --judge-model=<id>     LLM judge model (default: ${MODEL_DEFAULTS.judge})
  --compiler-model=<id>  Model for AOT compiler (default: ${MODEL_DEFAULTS.compiler})
  --profile=<path>       TCP JSON path (required for aot conditions)
  --resume=<session>     Resume an interrupted session (or "latest")
  --list-sessions        List all bench sessions with status
  --compare              Compare two conditions for a given model, adapter, and skill path
  --skill-path=<dir>     Skill directory or SKILL.md path used for --compare
  --lhs=<condition>      Left-hand condition for --compare
  --rhs=<condition>      Right-hand condition for --compare
  --output-dir=<dir>     Required root directory for compare outputs
  --analyze-model=<id>   Optional OpenRouter model for summarizing the skill differences
  --concurrency=<n>     Parallel task runs (default: ${CLI_DEFAULTS.concurrency}, sequential).
                         In multi-model mode, slots are distributed across models.
  --runs-per-task=<n>    Runs per task-condition pair, averaged to reduce variance (default: ${CLI_DEFAULTS.benchRunsPerTask})
  --keep-workdirs        Don't delete work directories after runs
  --verbose              Enable debug logging

Async Judge:
  --async-judge          Run LLM-judge evaluations asynchronously in a post-run batch
                         (uses --concurrency for parallelism)

  bench judge --manifest=<dir> [--judge-model=<id>] [--concurrency=<n>]
                         Run async LLM judge from a manifest directory
  bench --merge-judge=<results-dir> --report=<path>
                         Merge async judge results into an existing report

Task Management:
  --import=<source>      Import tasks from an external source.
                         Sources: pinchbench, skillsbench
  --path=<dir>           Path for import source (default: ~/Projects/<source>)
  --dry-run              Show what would be imported without writing

Examples:
  # Import tasks from PinchBench
  bun run skvm bench --import=pinchbench --path=~/Projects/pinchbench

  # Import tasks and skills from SkillsBench
  bun run skvm bench --import=skillsbench --path=~/Projects/skillsbench

  # Run specific models
  bun run skvm bench --model=anthropic/claude-haiku-4.5,deepseek/deepseek-v3.2

  # Single model quick test
  bun run skvm bench --model=anthropic/claude-haiku-4.5 \\
    --tasks=task_00_sanity,task_09_files --conditions=no-skill,original

  # Run a custom bench plan (YAML-defined task-skill-model matrix)
  bun run skvm bench --custom=bench-plan.yaml`)

  console.log(`
  # Compare original vs aot-compiled-p1 for one skill directory
  bun run skvm bench --compare --model=qwen/qwen3.5-122b-a10b \
    --adapter=bare-agent --skill-path=skvm-data/skills/calendar \
    --lhs=original --rhs=aot-compiled-p1 --output-dir=compare-runs \
    --analyze-model=${MODEL_DEFAULTS.judge}`)
}
