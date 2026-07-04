/**
 * `skvm bench` — run benchmarks across skill optimization conditions.
 * Migrated to the declarative flag layer (#49). One definition covers all six
 * modes (`--import` / `--judge` / `--merge-judge` / `--list-sessions` /
 * `--compare` / `--custom`) plus the default matrix mode; mode dispatch and
 * every cross-flag rule live in `runBench`, throwing `UsageError` before any
 * side effects. The domain handlers stay in `src/bench/index.ts`.
 */

import path from "node:path"
import { mkdir } from "node:fs/promises"
import { defineFlags, parseEnumListFlag, UsageError, type ConfigOf } from "./flags.ts"
import { ALL_ADAPTERS } from "../adapters/registry.ts"
import { resolveAdapterConfigMode } from "../core/config.ts"
import { AdapterConfigModeSchema } from "../core/types.ts"
import { CLI_DEFAULTS, MODEL_DEFAULTS } from "../core/ui-defaults.ts"
import { TIMEOUT_DEFAULTS } from "../core/timeouts.ts"
import { BENCH_CONDITIONS, isAotCondition, isValidCondition } from "../bench/types.ts"
import type { BenchCondition, BenchRunConfig } from "../bench/types.ts"

export const BENCH_FLAGS = defineFlags(
  "bench",
  "Run benchmark across skill optimization conditions",
  {
    // Mode selectors
    import: { kind: "string", placeholder: "<source>", help: "Import tasks from an external source. Sources: pinchbench, skillsbench" },
    judge: { kind: "string", placeholder: "<dir>", help: "Run async LLM judge from a manifest directory (or pass it via --manifest)" },
    "merge-judge": { kind: "string", placeholder: "<results-dir>", help: "Merge async judge results into an existing report (requires --report)" },
    "list-sessions": { kind: "bool", help: "List all bench sessions with status" },
    compare: { kind: "bool", help: "Compare two conditions for a given model, adapter, and skill path" },
    custom: {
      kind: "string",
      placeholder: "<file.yaml>",
      help: "Run a custom bench plan from a YAML file. Defines task-skill\nmappings, models, and adapters in nested groups. Bypasses\nthe standard condition system entirely.",
    },
    // Resume / sessions
    resume: { kind: "string", placeholder: "<session>", help: 'Resume an interrupted session (or "latest")' },
    // Core run knobs
    model: { kind: "string", placeholder: "<id,...>", help: "Target model(s), comma-separated." },
    adapter: {
      kind: "string",
      placeholder: "<name,...>",
      help: `${ALL_ADAPTERS.join(" | ")} — comma-separated for\nmulti-adapter mode (default: ${CLI_DEFAULTS.adapter})`,
    },
    tasks: { kind: "string", placeholder: "<list>", help: "Comma-separated task IDs (default: all)" },
    source: { kind: "string", placeholder: "<name,...>", help: "Filter tasks by origin source(s), comma-separated\n(e.g. pinchbench, skillsbench, clawhub)" },
    conditions: {
      kind: "string",
      placeholder: "<list>",
      help: "no-skill,original,aot-compiled,jit-optimized,jit-boost,aot-compiled-p<N> (default: all)\nAOT pass variants: aot-compiled-p1, aot-compiled-p2, aot-compiled-p3, aot-compiled-p12, aot-compiled-p23, etc.",
    },
    "skill-mode": { kind: "enum", values: ["inject", "discover"], placeholder: "<mode>", help: `inject | discover (default: ${CLI_DEFAULTS.skillMode})` },
    "jit-runs": { kind: "int", min: 1, default: CLI_DEFAULTS.jitRuns, help: "JIT-boost warm-up runs" },
    "timeout-ms": {
      kind: "int",
      min: 1,
      help: `Absolute override for per-task timeout in ms.
When set, wins over task.json's timeoutMs
(which falls back to ${TIMEOUT_DEFAULTS.taskExec}).
Also caps the jit-boost candidate-generation agent
when --conditions includes jit-boost
(default: ${TIMEOUT_DEFAULTS.candidateGen}).`,
    },
    "max-steps": { kind: "int", min: 1, default: CLI_DEFAULTS.maxSteps, help: "Max agent steps per task.\nUniform across tasks; per-task task.maxSteps is not used in bench." },
    "judge-model": { kind: "string", placeholder: "<id>", default: MODEL_DEFAULTS.judge, help: "LLM judge model" },
    "compiler-model": { kind: "string", placeholder: "<id>", help: `Model for AOT compiler (default: ${MODEL_DEFAULTS.compiler})` },
    profile: { kind: "string", placeholder: "<path>", help: "TCP JSON path (required for aot conditions)" },
    "keep-workdirs": { kind: "bool", help: "Don't delete work directories after runs" },
    concurrency: {
      kind: "int",
      min: 1,
      help: `Parallel task runs (default: ${CLI_DEFAULTS.concurrency}; judge mode default: ${CLI_DEFAULTS.benchJudgeConcurrency}).\nIn multi-model mode, slots are distributed across models.`,
    },
    "async-judge": { kind: "bool", help: "Run LLM-judge evaluations asynchronously in a post-run batch\n(uses --concurrency for parallelism)" },
    "runs-per-task": { kind: "int", min: 1, default: CLI_DEFAULTS.benchRunsPerTask, help: "Runs per task-condition pair, averaged to reduce variance" },
    "adapter-config": {
      kind: "enum",
      values: AdapterConfigModeSchema.options,
      placeholder: "<m>",
      help: "native | managed (default: defaults.adapterConfigMode in skvm.config.json, else managed).\nNative uses your real harness config; managed uses providers.routes only.",
    },
    // Import mode
    path: { kind: "string", placeholder: "<dir>", help: "Path for import source (default: ~/Projects/<source>)" },
    exclude: { kind: "string", placeholder: "<list>", help: "Comma-separated task IDs to exclude on import" },
    "dry-run": { kind: "bool", help: "Show what would be imported without writing" },
    // Judge / merge mode
    manifest: { kind: "string", placeholder: "<dir>", help: "Manifest directory for judge mode (used when --judge is passed bare)" },
    report: { kind: "string", placeholder: "<path>", help: "Existing bench report JSON for --merge-judge" },
    // Compare mode
    "skill-path": { kind: "string", placeholder: "<dir>", help: "Skill directory or SKILL.md path used for --compare" },
    lhs: { kind: "string", placeholder: "<condition>", help: "Left-hand condition for --compare" },
    rhs: { kind: "string", placeholder: "<condition>", help: "Right-hand condition for --compare" },
    "output-dir": { kind: "string", placeholder: "<dir>", help: "Required root directory for compare outputs" },
    "analyze-model": { kind: "string", placeholder: "<id>", help: "Optional OpenRouter model for summarizing the skill differences" },
  },
  {
    usage: [
      "skvm bench --model=<id,...> [options]",
      "skvm bench --custom=<file.yaml>",
      "skvm bench --import=<source> [--path=<dir>] [--exclude=<list>] [--dry-run]",
      "skvm bench --judge=<dir> [--judge-model=<id>] [--concurrency=<n>]",
      "skvm bench --merge-judge=<results-dir> --report=<path>",
      "skvm bench --list-sessions",
      "skvm bench --compare --model=<id> --skill-path=<dir> --lhs=<c> --rhs=<c> --output-dir=<dir>",
    ],
    epilogue: `Examples:
  # Import tasks from PinchBench
  skvm bench --import=pinchbench --path=~/Projects/pinchbench

  # Single model quick test
  skvm bench --model=<id> --tasks=task_00_sanity,task_09_files --conditions=no-skill,original

  # Compare original vs aot-compiled-p1 for one skill directory
  skvm bench --compare --model=<id> --adapter=bare-agent --skill-path=skvm-data/skills/calendar \\
    --lhs=original --rhs=aot-compiled-p1 --output-dir=compare-runs --analyze-model=${MODEL_DEFAULTS.judge}`,
  },
)

export type BenchConfig = ConfigOf<typeof BENCH_FLAGS>

/**
 * Bare `--judge` selects judge mode but names no directory — the flag layer
 * parses a bare flag as the string "true", which is not a real path, so we
 * defer to --manifest instead. An explicit `--judge=<dir>` always wins.
 *
 * Edge case: `--judge=true` (an explicit value that happens to be the
 * string "true") is indistinguishable from bare `--judge` and also defers
 * to --manifest. A manifest directory literally named "true" must be
 * passed via --manifest=true rather than --judge=true.
 */
export function resolveManifestDir(judge: string | undefined, manifest: string | undefined): string | undefined {
  return (judge !== undefined && judge !== "true" ? judge : undefined) ?? manifest
}

export async function runBench(config: BenchConfig): Promise<void> {
  // Handle --import=<source>
  if (config.import !== undefined) {
    const { handleImport } = await import("../bench/index.ts")
    return handleImport({
      source: config.import,
      path: config.path,
      exclude: config.exclude,
      dryRun: config["dry-run"],
    })
  }

  // Handle --judge=<dir>: async LLM judge from a manifest directory.
  // A bare --judge defers to --manifest for the directory (see
  // resolveManifestDir); an explicit --judge=<dir> wins outright.
  if (config.judge !== undefined) {
    const manifestDir = resolveManifestDir(config.judge, config.manifest)
    if (!manifestDir) {
      throw new UsageError("bench: --manifest=<dir> is required (directory containing manifest.jsonl)", BENCH_FLAGS.help)
    }
    // A typo'd directory used to sail through runDeferredJudge as an empty
    // manifest and print "Judged 0 entries" (exit 0) — indistinguishable
    // from success. Check before any side effects; handleMergeJudge already
    // errors on zero results, so this restores consistency.
    if (!(await Bun.file(path.join(manifestDir, "manifest.jsonl")).exists())) {
      throw new UsageError(`bench: no manifest.jsonl found in ${manifestDir}`, BENCH_FLAGS.help)
    }
    const { handleJudge } = await import("../bench/index.ts")
    return handleJudge({
      manifestDir,
      judgeModel: config["judge-model"],
      concurrency: config.concurrency ?? CLI_DEFAULTS.benchJudgeConcurrency,
    })
  }

  // Handle --merge-judge: merge deferred results into an existing report
  if (config["merge-judge"] !== undefined) {
    if (!config.report) {
      throw new UsageError("bench: --report=<path> is required (existing bench report JSON)", BENCH_FLAGS.help)
    }
    const { handleMergeJudge } = await import("../bench/index.ts")
    return handleMergeJudge({ resultsDir: config["merge-judge"], reportPath: config.report })
  }

  // Handle --list-sessions
  if (config["list-sessions"]) {
    const { handleListSessions } = await import("../bench/index.ts")
    return handleListSessions()
  }

  // Handle --compare skill diff mode
  if (config.compare) {
    const compareModel = config.model
    const skillPath = config["skill-path"]
    const lhs = config.lhs
    const rhs = config.rhs
    const outputDir = config["output-dir"]
    if (!compareModel) {
      throw new UsageError("bench: --model=<id> is required for --compare", BENCH_FLAGS.help)
    }
    if (!skillPath) {
      throw new UsageError("bench: --skill-path=<dir> is required for --compare", BENCH_FLAGS.help)
    }
    if (!lhs || !rhs) {
      throw new UsageError("bench: --lhs=<condition> and --rhs=<condition> are required for --compare", BENCH_FLAGS.help)
    }
    if (!outputDir) {
      throw new UsageError("bench: --output-dir=<dir> is required for --compare", BENCH_FLAGS.help)
    }
    if (!isValidCondition(lhs) || !isValidCondition(rhs)) {
      throw new UsageError(`bench: invalid compare conditions. Valid: ${BENCH_CONDITIONS.join(", ")}, aot-p<N>`, BENCH_FLAGS.help)
    }
    if (lhs === rhs) {
      throw new UsageError("bench: --lhs and --rhs must be different", BENCH_FLAGS.help)
    }
    const { handleCompare } = await import("../bench/index.ts")
    return handleCompare({
      model: compareModel,
      adapter: config.adapter ?? CLI_DEFAULTS.adapter,
      skillPath,
      lhs,
      rhs,
      outputDir,
      analyzeModel: config["analyze-model"],
    })
  }

  // Custom-plan mode (below) must receive skillMode too, not just matrix mode.
  const skillMode = config["skill-mode"]

  // Handle --custom=<file.yaml>: standalone custom plan mode
  if (config.custom !== undefined) {
    const { executeCustomPlan } = await import("../bench/custom-plan.ts")
    return executeCustomPlan(config.custom, config.resume, resolveAdapterConfigMode(config["adapter-config"]), skillMode)
  }

  // Parse conditions
  let conditions: BenchCondition[]
  if (config.conditions) {
    conditions = config.conditions.split(",").map(c => c.trim())
    for (const c of conditions) {
      if (!isValidCondition(c)) {
        throw new UsageError(
          `bench: invalid --conditions "${c}". Valid: ${BENCH_CONDITIONS.join(", ")}, aot-compiled-p<N> (e.g. aot-compiled-p1, aot-compiled-p12, aot-compiled-p23)`,
          BENCH_FLAGS.help,
        )
      }
    }
  } else {
    conditions = [...BENCH_CONDITIONS]
  }

  const tasks = config.tasks ? config.tasks.split(",").map(t => t.trim()) : undefined

  // Parse adapter(s): comma-separated
  const adapters = parseEnumListFlag("bench", "adapter", config.adapter ?? CLI_DEFAULTS.adapter, ALL_ADAPTERS, BENCH_FLAGS.help)

  const cliTimeoutMs = config["timeout-ms"]

  const baseConfig = {
    adapter: adapters[0]!,
    conditions,
    tasks,
    skillMode,
    jitRuns: config["jit-runs"],
    timeoutMult: CLI_DEFAULTS.timeoutMult,
    maxSteps: config["max-steps"],
    cliTimeoutMs,
    judgeModel: config["judge-model"],
    compilerModel: config["compiler-model"],
    source: config.source ? config.source.split(",").map(s => s.trim()) : undefined,
    tcpPath: config.profile,
    resumeSession: config.resume,
    keepWorkDirs: config["keep-workdirs"],
    concurrency: config.concurrency ?? CLI_DEFAULTS.concurrency,
    asyncJudge: config["async-judge"],
    runsPerTask: config["runs-per-task"],
    adapterConfigMode: resolveAdapterConfigMode(config["adapter-config"]),
  }

  if (!baseConfig.tcpPath && conditions.some(c => isAotCondition(c))) {
    console.log("Warning: --profile not set. AOT conditions will be skipped.")
    console.log("Run: bun run skvm profile --model=<id> to generate a TCP first.\n")
  }

  // Resolve --resume=latest
  if (baseConfig.resumeSession === "latest") {
    const { findLatestIncompleteSession } = await import("../bench/index.ts")
    const latest = await findLatestIncompleteSession()
    if (!latest) {
      // Not a UsageError: environment state, not flag shape.
      console.error("No incomplete sessions found to resume.")
      process.exit(1)
    }
    baseConfig.resumeSession = latest.sessionId
    console.log(`Resuming latest incomplete session: ${latest.sessionId} (model: ${latest.model})`)
  }

  // Resolve model(s)
  let models: string[]
  if (baseConfig.resumeSession && !config.model) {
    // When resuming without explicit --model, use model from the progress file
    const { findLatestIncompleteSession } = await import("../bench/index.ts")
    const latest = await findLatestIncompleteSession(baseConfig.resumeSession)
    if (latest) {
      models = [latest.model]
      console.log(`Using model from session: ${latest.model}`)
    } else {
      // Not a UsageError: fires after session lookup I/O, not on flag shape.
      console.error("Error: could not determine model from session. Use --model to specify.")
      process.exit(1)
    }
  } else if (config.model) {
    models = config.model.split(",").map(m => m.trim())
  } else {
    throw new UsageError("bench: --model is required", BENCH_FLAGS.help)
  }

  if (adapters.length > 1 && models.length > 1) {
    throw new UsageError("bench: cannot combine multiple adapters with multiple models. Use one axis at a time.", BENCH_FLAGS.help)
  }

  {
    const { printBanner, describeModelRoute, describeAdapter, shortenPath } = await import("../core/banner.ts")
    const { SKVM_CACHE, LOGS_DIR } = await import("../core/config.ts")
    printBanner("bench", [
      ["Adapter", adapters.map(a => describeAdapter(a)).join(", ")],
      ["Model", models.map(m => describeModelRoute(m)).join(", ")],
      ["Judge", describeModelRoute(baseConfig.judgeModel)],
      ["Conditions", baseConfig.conditions.join(", ")],
      ["Cache", shortenPath(SKVM_CACHE)],
      ["Output", shortenPath(LOGS_DIR) + "/bench"],
    ])
  }

  if (adapters.length > 1) {
    // Multi-adapter mode: single model, multiple adapters
    const { runMultiAdapterBenchmark } = await import("../bench/orchestrator.ts")
    await runMultiAdapterBenchmark(adapters, { ...baseConfig, model: models[0]! })
  } else if (models.length > 1) {
    // Multi-model mode: single adapter, multiple models
    const { runMultiModelBenchmark } = await import("../bench/orchestrator.ts")
    await runMultiModelBenchmark(models, baseConfig)
  } else {
    // Single adapter, single model
    const { runBenchmark } = await import("../bench/orchestrator.ts")
    const { generateMarkdown } = await import("../bench/reporter.ts")
    const { getBenchLogDir } = await import("../core/config.ts")
    const runConfig: BenchRunConfig = { ...baseConfig, model: models[0]! }
    const report = await runBenchmark(runConfig)

    const mdPath = path.join(getBenchLogDir(report.sessionId), "report.md")
    await mkdir(path.dirname(mdPath), { recursive: true })
    await Bun.write(mdPath, generateMarkdown(report))
    console.log(`Markdown report: ${mdPath}`)
  }
}
