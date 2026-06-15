/**
 * `skvm jit-optimize` — optimize a skill from synthetic, real, or log evidence.
 *
 * The most complex flag surface in the CLI: deprecated aliases plus per-task-
 * source cross-flag rules. The declarative layer (#49) owns the single-flag
 * shape — kinds, enums, required/required-unless, the `--model`/`--adapter`
 * deprecation aliases, and the generated help. What stays hand-coded in
 * `runJitOptimize` is everything genuinely conditional on `--task-source`:
 *
 *  - `buildTaskSource` turns the chosen source + its inputs into a `TaskSource`
 *    (and rejects a missing `--tasks` / `--logs`, etc.).
 *  - `validateFlagsForSource` enforces the per-source forbidden-flag matrix.
 *
 * These run on the typed config and throw `UsageError`, so `runOrExit` gives
 * them the same stderr/exit-1 path as parse errors while keeping the handler
 * unit-testable without spawning the CLI.
 */

import { defineFlags, UsageError, type ConfigOf } from "./flags.ts"
import { ALL_ADAPTERS, type AdapterName } from "../adapters/registry.ts"
import { resolveAdapterConfigMode } from "../core/config.ts"
import { AdapterConfigModeSchema, type SkillMode } from "../core/types.ts"
import { CLI_DEFAULTS } from "../core/ui-defaults.ts"
import { TIMEOUT_DEFAULTS } from "../core/timeouts.ts"
import { createLogger, c } from "../core/logger.ts"
import type { JitOptimizeConfig, JitOptimizeResult, TaskSource } from "../jit-optimize/types.ts"
import type { TokenUsage } from "../core/types.ts"

/** CLI-facing task-source literals (the internal `-task` / `execution-` spellings are not accepted). */
const TASK_SOURCES = ["synthetic", "real", "log"] as const
/** Tied to `SkillMode` at compile time so the flag spec cannot drift. */
const SKILL_MODES = ["inject", "discover"] as const satisfies readonly SkillMode[]

export const JIT_OPTIMIZE_FLAGS = defineFlags(
  "jit-optimize",
  "Optimize a skill based on execution evidence",
  {
    // -- Skill selection (one of --skill / --skill-list) --------------------
    skill: {
      kind: "string",
      requiredUnless: "skill-list",
      placeholder: "<path>",
      help: "Path to skill directory",
    },
    "skill-list": {
      kind: "string",
      placeholder: "<file>",
      help: "Batch mode: file with one skill path per line",
    },
    // -- Optimizer (declared before the source block so the required-flag
    //    error precedence matches the legacy handler: optimizer-model →
    //    task-source → target-model). ----------------------------------------
    "optimizer-model": {
      kind: "string",
      required: true,
      placeholder: "<id>",
      help: "Optimizer LLM model, shaped as <provider>/<model-id>",
    },
    "compiler-model": { aliasOf: "optimizer-model" },
    // -- Source kind + per-source inputs ------------------------------------
    "task-source": {
      kind: "enum",
      values: TASK_SOURCES,
      required: true,
      placeholder: "<kind>",
      help: "Where execution evidence comes from (must be set explicitly)",
    },
    "synthetic-count": {
      kind: "int",
      min: 1,
      placeholder: "<n>",
      help: `[synthetic] Train tasks to generate (default: ${CLI_DEFAULTS.syntheticTrainCount})`,
    },
    "synthetic-test-count": {
      kind: "int",
      min: 0,
      placeholder: "<n>",
      help: `[synthetic] Held-out test tasks to generate (default: ${CLI_DEFAULTS.syntheticTestCount})`,
    },
    tasks: {
      kind: "string",
      placeholder: "<id|path,...>",
      help: "[real] Train tasks — IDs or task.json paths, comma-separated",
    },
    "test-tasks": {
      kind: "string",
      placeholder: "<id|path,...>",
      help: "[real] Held-out test tasks. If omitted, --tasks is reused as both\ntrain and test (fallback for small task lists).",
    },
    logs: {
      kind: "string",
      placeholder: "<path,...>",
      help: "[log] Conversation log files, comma-separated",
    },
    failures: {
      kind: "string",
      placeholder: "<path,...>",
      help: "[log] Per-log failure JSON files, same order (optional)",
    },
    // -- Target -------------------------------------------------------------
    "target-model": {
      kind: "string",
      required: true,
      placeholder: "<id>",
      help: "Target model the optimized skill is tuned for (the proposal's\nstorage key — required even for --task-source=log)",
    },
    model: { aliasOf: "target-model" },
    "target-adapter": {
      kind: "enum",
      values: ALL_ADAPTERS,
      default: CLI_DEFAULTS.adapter,
      placeholder: "<name>",
      help: `Target agent adapter: ${ALL_ADAPTERS.join(" | ")}`,
    },
    adapter: { aliasOf: "target-adapter" },
    // -- Loop ---------------------------------------------------------------
    rounds: {
      kind: "int",
      min: 1,
      placeholder: "<n>",
      help: "Max optimization rounds (default: 1 for log, 3 otherwise)",
    },
    "runs-per-task": {
      kind: "int",
      min: 1,
      placeholder: "<n>",
      help: `Runs per task per round (default: ${CLI_DEFAULTS.jitOptimizeRunsPerTask}; forbidden for log).\nRaised from 1 to give the selection noise-floor a cleaner\nstatistical basis and reduce single-run variance.`,
    },
    "task-concurrency": {
      kind: "int",
      min: 1,
      placeholder: "<n>",
      help: `Max parallel in-flight task runs per round (default: ${CLI_DEFAULTS.jitOptimizeTaskConcurrency};\nforbidden for log). Train + test share the same limiter.`,
    },
    convergence: {
      kind: "string",
      placeholder: "<0-1>",
      help: "Early-exit threshold on primary score (default: 0.95; forbidden\nfor log). Primary score is the test score when a test set\nexists, else the train score.",
    },
    baseline: {
      kind: "bool",
      help: "Run no-skill/original conditions for comparison (forbidden for log)",
    },
    // -- Delivery (writes to the proposals tree) ----------------------------
    "no-keep-all-rounds": {
      kind: "bool",
      help: "Keep only the best round's folder (default: keep all)",
    },
    "auto-apply": {
      kind: "bool",
      help: "Overwrite original skillDir with best round",
    },
    // -- Batch --------------------------------------------------------------
    concurrency: {
      kind: "int",
      min: 1,
      default: CLI_DEFAULTS.concurrency,
      placeholder: "<n>",
      help: "Parallel jobs in --skill-list batch mode",
    },
    // -- Adapter mode -------------------------------------------------------
    "adapter-config": {
      kind: "enum",
      values: AdapterConfigModeSchema.options,
      placeholder: "<m>",
      help: "native | managed (default: defaults.adapterConfigMode in\nskvm.config.json, else managed). Applies to the target\nadapter that runs tasks during optimization.",
    },
    "skill-mode": {
      kind: "enum",
      values: SKILL_MODES,
      placeholder: "<mode>",
      help: "inject | discover (default: inject). How the skill is loaded\ninto each per-task adapter run during optimization.",
    },
    // -- Per-agent-loop timeout / step overrides ----------------------------
    "timeout-ms": {
      kind: "int",
      min: 1,
      placeholder: "<n>",
      help: `Per-agent-loop ceiling for this run (ms). Applies to each\nper-task adapter execution (default: ${TIMEOUT_DEFAULTS.taskExec}), each round's\noptimizer agent (default: ${TIMEOUT_DEFAULTS.optimizer}), the synthetic task-gen\nagent (default: ${TIMEOUT_DEFAULTS.taskGen}), and synthetic tasks' default timeout\n(default: ${TIMEOUT_DEFAULTS.syntheticTaskExec}). Per-loop ceiling, not total wall time.`,
    },
    "max-steps": {
      kind: "int",
      min: 1,
      placeholder: "<n>",
      help: "Override max agent steps per task. When omitted, each task's\nown maxSteps is honored.",
    },
    // -- Detached invocation ------------------------------------------------
    detach: {
      kind: "bool",
      help: "Spawn a background worker and return as soon as it reports its\nproposal id (~100-300 ms). Track with 'skvm proposals show <id>'.\nSingle-skill only: incompatible with --skill-list / batch mode.",
    },
  },
  {
    usage: [
      "skvm jit-optimize --skill=<path> --task-source=<kind> --optimizer-model=<id> --target-model=<id> [options]",
      "skvm jit-optimize --skill-list=<file> --task-source=<kind> [--concurrency=<n>] [options]",
    ],
    epilogue: `Per-source inputs (flags from other sources are rejected):
  --task-source=synthetic   --synthetic-count, --synthetic-test-count
  --task-source=real        --tasks (required), --test-tasks
  --task-source=log         --logs (required), --failures
                            (forbidden for log: --runs-per-task, --task-concurrency,
                             --convergence, --baseline — log source does not rerun tasks)`,
  },
)

export type JitOptimizeCliConfig = ConfigOf<typeof JIT_OPTIMIZE_FLAGS>

export async function runJitOptimize(config: JitOptimizeCliConfig): Promise<void> {
  // Skill resolution: the layer already guaranteed --skill or --skill-list is
  // present (`requiredUnless`); an empty --skill-list file is the only way to
  // reach zero skills here.
  const skillDirs = await resolveSkillDirs(config)
  if (skillDirs.length === 0) {
    throw new UsageError(
      "jit-optimize: no skills resolved from --skill or --skill-list",
      JIT_OPTIMIZE_FLAGS.help,
    )
  }

  const optimizerModel = config["optimizer-model"]

  // Build taskSource from the (layer-validated) --task-source plus its inputs.
  const taskSource = buildTaskSource(config)

  // Enforce the per-source forbidden-flag matrix.
  validateFlagsForSource(config, taskSource.kind)

  // --target-model is required for every source (the layer enforces it). For
  // execution-log it's not used to run anything; it's the storage key.
  const tModel = config["target-model"]
  const tHarness: AdapterName = config["target-adapter"]

  const adapterModeJit = resolveAdapterConfigMode(config["adapter-config"])
  const timeoutMsJit = config["timeout-ms"]
  const maxStepsJit = config["max-steps"]
  const skillMode = config["skill-mode"]
  const targetAdapter: JitOptimizeConfig["targetAdapter"] = {
    model: tModel,
    harness: tHarness,
    adapterConfig: {
      mode: adapterModeJit,
      ...(timeoutMsJit !== undefined ? { timeoutMs: timeoutMsJit } : {}),
      ...(maxStepsJit !== undefined ? { maxSteps: maxStepsJit } : {}),
    },
  }

  const rounds = config.rounds ?? (taskSource.kind === "execution-log" ? 1 : 3)
  const runsPerTask = config["runs-per-task"] ?? CLI_DEFAULTS.jitOptimizeRunsPerTask
  const taskConcurrency = config["task-concurrency"] ?? CLI_DEFAULTS.jitOptimizeTaskConcurrency
  const convergence = config.convergence ? parseFloat(config.convergence) : 0.95
  const baseline = config.baseline
  const keepAllRounds = !config["no-keep-all-rounds"]
  const autoApply = config["auto-apply"]
  const concurrency = config.concurrency

  {
    const { printBanner, describeModelRoute, describeAdapter, shortenPath } = await import("../core/banner.ts")
    const { SKVM_CACHE, JIT_OPTIMIZE_DIR } = await import("../core/config.ts")
    printBanner("jit-optimize", [
      ["Optimizer", describeModelRoute(optimizerModel)],
      ["Target", `${describeModelRoute(tModel)} / ${describeAdapter(tHarness)}`],
      ["Source", stripSuffix(taskSource.kind)],
      ["Skill", skillDirs.length === 1 ? skillDirs[0]! : `${skillDirs.length} skills (batch)`],
      ["Skill mode", skillMode ?? CLI_DEFAULTS.skillMode],
      ["Rounds", `${rounds} (runs-per-task=${runsPerTask})`],
      ["Cache", shortenPath(SKVM_CACHE)],
      ["Output", shortenPath(JIT_OPTIMIZE_DIR)],
    ])
  }

  const { jitOptimize } = await import("../jit-optimize/index.ts")
  const { acquireOptimizeLock, releaseOptimizeLock } = await import("../proposals/storage.ts")

  const buildConfig = (skillDir: string): JitOptimizeConfig => ({
    skillDir,
    optimizer: { model: optimizerModel },
    taskSource,
    targetAdapter,
    loop: { rounds, runsPerTask, taskConcurrency, convergence, baseline },
    delivery: { keepAllRounds, autoApply },
    ...(timeoutMsJit !== undefined ? { optimizerTimeoutMs: timeoutMsJit, taskGenTimeoutMs: timeoutMsJit, taskExecTimeoutMs: timeoutMsJit } : {}),
    ...(skillMode !== undefined ? { skillMode } : {}),
  })

  // Detached invocation: parent forks a worker, awaits a `ready` handshake
  // that carries the proposal id, and exits. The optimization keeps running
  // in the background; users watch with `skvm proposals show <id>`.
  //
  // Single-skill only by design. Detached workers are independent background
  // processes — once the parent exits, there is no one left to enforce the
  // `--concurrency` cap, so detaching a batch would silently fan out N
  // workers regardless of what the user asked for. Users who need
  // concurrency-limited batches should use sync mode.
  if (config.detach) {
    if (skillDirs.length > 1) {
      throw new UsageError(
        "jit-optimize: --detach is incompatible with --skill-list / multi-skill batches " +
          "(detached workers outlive the parent and cannot be throttled by --concurrency). " +
          "Re-run without --detach, or invoke `skvm jit-optimize --detach ...` once per skill.",
        JIT_OPTIMIZE_FLAGS.help,
      )
    }
    const { spawnDetachedJitOptimize } = await import("../jit-optimize/detach.ts")
    const skillDir = skillDirs[0]!
    const skillName = deriveSkillName(skillDir)
    const code = await spawnDetachedJitOptimize({
      skillName,
      workerInput: {
        config: buildConfig(skillDir),
        lockKey: { harness: targetAdapter.harness, targetModel: tModel, skillName },
        source: stripSuffix(taskSource.kind),
      },
    })
    process.exit(code)
  }

  // Single skill
  if (skillDirs.length === 1) {
    const skillDir = skillDirs[0]!
    const skillName = deriveSkillName(skillDir)
    const harness = targetAdapter.harness
    if (!(await acquireOptimizeLock(harness, tModel, skillName))) {
      console.error(`jit-optimize: another optimization is in progress for ${harness}/${tModel}/${skillName}`)
      process.exit(1)
    }
    try {
      const result = await jitOptimize(buildConfig(skillDir))
      printOptimizeResult(skillName, result)
    } finally {
      await releaseOptimizeLock(harness, tModel, skillName)
    }
    return
  }

  // Batch mode
  const { createSlotPool } = await import("../core/concurrency.ts")
  const pool = createSlotPool(concurrency)

  interface BatchResult {
    skillDir: string
    skillName: string
    result?: JitOptimizeResult
    error?: string
  }
  const results: BatchResult[] = []

  await Promise.all(skillDirs.map(async (skillDir) => {
    const slot = await pool.acquire()
    const skillName = deriveSkillName(skillDir)
    const harness = targetAdapter.harness
    try {
      if (!(await acquireOptimizeLock(harness, tModel, skillName))) {
        results.push({ skillDir, skillName, error: "lock held by another process" })
        return
      }
      try {
        console.log(`[${skillName}] starting`)
        const result = await jitOptimize(buildConfig(skillDir))
        results.push({ skillDir, skillName, result })
        console.log(`[${skillName}] done: best=round-${result.bestRound} (${result.bestRoundReason})`)
      } finally {
        await releaseOptimizeLock(harness, tModel, skillName)
      }
    } catch (err) {
      results.push({ skillDir, skillName, error: `${err}` })
      console.error(c.red(`[${skillName}] failed: ${err}`))
    } finally {
      pool.release(slot)
    }
  }))

  // Batch summary
  console.log(`\n=== Batch summary ===`)
  for (const r of results) {
    if (r.result) {
      const baselineRound = r.result.rounds.find((x) => x.isBaseline)
      const bestRound = r.result.rounds.find((x) => x.round === r.result!.bestRound)
      // Use test score when available, else train
      const primary = (round?: typeof baselineRound) =>
        round ? (round.testScore ?? round.trainScore) : null
      const baselineScore = primary(baselineRound)
      const bestScore = primary(bestRound)
      const delta = baselineScore !== null && bestScore !== null ? bestScore - baselineScore : null
      const deltaStr = delta === null ? "" : ` (Δ ${delta >= 0 ? "+" : ""}${delta.toFixed(3)})`
      console.log(`  ${r.skillName}: best=round-${r.result.bestRound}${deltaStr}  ${r.result.proposalDir}`)
    } else {
      console.log(c.red(`  ${r.skillName}: FAILED — ${r.error}`))
    }
  }
}

// ---------------------------------------------------------------------------
// jit-optimize flag helpers (source-dependent rules — kept hand-coded)
// ---------------------------------------------------------------------------

/**
 * Turn the (layer-validated) `--task-source` plus its source-specific inputs
 * into a `TaskSource`. The source enum and the presence of inputs that the
 * layer can't express conditionally (e.g. `--tasks` required only for `real`)
 * are validated here and surface as `UsageError`.
 */
function buildTaskSource(config: JitOptimizeCliConfig): TaskSource {
  const kind = config["task-source"]
  if (kind === "synthetic") {
    const trainCount = config["synthetic-count"] ?? CLI_DEFAULTS.syntheticTrainCount
    const testCount = config["synthetic-test-count"] ?? CLI_DEFAULTS.syntheticTestCount
    return { kind: "synthetic-task", trainCount, testCount }
  }
  if (kind === "real") {
    const raw = config.tasks
    if (!raw) {
      throw usageErr("jit-optimize: --tasks is required for --task-source=real")
    }
    const trainTasks = raw.split(",").map((s) => s.trim()).filter(Boolean)
    const testTasks = config["test-tasks"]
      ? config["test-tasks"].split(",").map((s) => s.trim()).filter(Boolean)
      : undefined
    if (!testTasks) {
      // No holdout split → pickBestRound's per-task monotonicity gate runs
      // on the training set, which is strictly weaker than the intended
      // "cannot regress a held-out task" protection. Warn loudly but do
      // not error — existing CI jobs would break.
      createLogger("jit-optimize-cli").warn(
        "--task-source=real was used without --test-tasks. " +
          "The selection engine's per-task monotonicity gate will degrade to " +
          "weak-monotonicity on the training set. Pass --test-tasks=<id,...> " +
          "for a real held-out check.",
      )
    }
    return { kind: "real-task", trainTasks, testTasks }
  }
  // kind === "log"
  const raw = config.logs
  if (!raw) {
    throw usageErr("jit-optimize: --logs is required for --task-source=log")
  }
  const logs = raw.split(",").map((s) => s.trim()).filter(Boolean)
  const failures = config.failures
    ? config.failures.split(",").map((s) => s.trim()).filter(Boolean)
    : []
  if (failures.length > 0 && failures.length !== logs.length) {
    throw usageErr(`jit-optimize: --failures count (${failures.length}) must match --logs count (${logs.length})`)
  }
  return {
    kind: "execution-log",
    logs: logs.map((p, i) => ({ path: p, failuresPath: failures[i] })),
  }
}

/**
 * Enforce flag compatibility: each task source accepts a specific subset of
 * flags; passing others is an error (not silently ignored) so users notice
 * when they've confused sources.
 */
function validateFlagsForSource(config: JitOptimizeCliConfig, kind: TaskSource["kind"]): void {
  // Flags that are only valid for certain sources.
  const SOURCE_SPECIFIC: Record<string, "synthetic-task" | "real-task" | "execution-log"> = {
    "synthetic-count": "synthetic-task",
    "synthetic-test-count": "synthetic-task",
    tasks: "real-task",
    "test-tasks": "real-task",
    logs: "execution-log",
    failures: "execution-log",
  }

  const bad: string[] = []

  // Presence for string/int flags is "value is defined" (none of these carry a
  // layer default, so undefined === not passed).
  const present = (flag: keyof JitOptimizeCliConfig): boolean => config[flag] !== undefined
  for (const [flag, allowedKind] of Object.entries(SOURCE_SPECIFIC)) {
    if (present(flag as keyof JitOptimizeCliConfig) && kind !== allowedKind) {
      bad.push(`--${flag} is only valid with --task-source=${stripSuffix(allowedKind)} (got ${stripSuffix(kind)})`)
    }
  }

  if (kind === "execution-log") {
    // Flags that only make sense when a target agent actually runs tasks.
    // --target-model / --target-adapter are NOT here: every source needs a
    // target model (it's the proposal's storage key), and execution-log sets
    // the harness purely informationally. `--baseline` is a bool, so presence
    // is "the flag is on" (true).
    if (config["runs-per-task"] !== undefined) bad.push(logForbidden("runs-per-task"))
    if (config["task-concurrency"] !== undefined) bad.push(logForbidden("task-concurrency"))
    if (config.convergence !== undefined) bad.push(logForbidden("convergence"))
    if (config.baseline) bad.push(logForbidden("baseline"))
  }

  if (bad.length > 0) {
    throw usageErr(`jit-optimize: incompatible flags:\n${bad.map((m) => `  ${m}`).join("\n")}`)
  }
}

function logForbidden(flag: string): string {
  return `--${flag} is not valid with --task-source=log (log source does not rerun tasks)`
}

function usageErr(message: string): UsageError {
  return new UsageError(message, JIT_OPTIMIZE_FLAGS.help)
}

/** Normalize the internal "-task" / "execution-" suffixes back to the CLI spelling. */
function stripSuffix(kind: TaskSource["kind"]): string {
  if (kind === "synthetic-task") return "synthetic"
  if (kind === "real-task") return "real"
  return "log"
}

function deriveSkillName(skillDir: string): string {
  const base = skillDir.split("/").filter(Boolean).pop() ?? ""
  if (/^v\d/.test(base)) {
    const parent = skillDir.split("/").filter(Boolean).slice(-2, -1)[0] ?? ""
    return parent
  }
  return base
}

function printOptimizeResult(skillName: string, result: JitOptimizeResult): void {
  console.log(`\n=== JIT-Optimize Result: ${skillName} ===`)
  console.log(`Proposal: ${result.proposalId}`)
  console.log(`Proposal dir: ${result.proposalDir}`)
  console.log(`Best round: ${result.bestRound} — ${result.bestRoundReason}`)
  console.log(`Rounds: ${result.rounds.length}`)

  const hasTest = result.rounds.some((r) => r.testScore !== null)

  // Setup cost (only non-zero for synthetic-task source)
  if (result.setupCost.calls > 0) {
    console.log(
      `\nSetup: ${result.setupCost.calls} task-gen call(s)  tokens=${fmtTokens(result.setupCost.tokens)}  $${result.setupCost.costUsd.toFixed(4)}`,
    )
  }

  // Per-round breakdown
  console.log(`\nPer-round breakdown:`)
  for (const r of result.rounds) {
    const tag = r.round === result.bestRound ? " ★" : ""
    const base = r.isBaseline ? " (baseline)" : ""

    const trainStr = r.trainScore === null ? "n/a" : r.trainScore.toFixed(3)
    const scoreLine = hasTest
      ? `train=${trainStr} (${r.trainPassed}/${r.trainTotal})  test=${r.testScore === null ? "n/a" : r.testScore.toFixed(3)} (${r.testPassed}/${r.testTotal})`
      : `score=${trainStr} (${r.trainPassed}/${r.trainTotal})`
    console.log(`  round-${r.round}${base}: ${scoreLine}${tag}`)

    // target-agent bucket
    const ta = r.targetAgent
    console.log(
      `    target-agent: runs=${ta.runs}  tokens=${fmtTokens(ta.tokens)}  $${ta.costUsd.toFixed(4)}  (${(ta.durationMs / 1000).toFixed(1)}s)`,
    )
    // eval-judge bucket
    const ej = r.evalJudge
    if (ej.calls > 0 || ej.tokens.input > 0) {
      console.log(
        `    eval-judge:   calls=${ej.calls}  tokens=${fmtTokens(ej.tokens)}  $${ej.costUsd.toFixed(4)}`,
      )
    }
    // optimizer bucket (null for baseline)
    if (r.optimizer) {
      console.log(
        `    optimizer:    tokens=${fmtTokens(r.optimizer.tokens)}  $${r.optimizer.costUsd.toFixed(4)}`,
      )
    }
  }

  // Grand totals
  const t = result.totalCost
  console.log(
    `\nTotal cost: $${t.costUsd.toFixed(4)}  tokens=${fmtTokens(t.tokens)}  (setup+target-agent+eval-judge+optimizer across all rounds)`,
  )
  if (t.costUsd === 0) {
    console.log(
      `  NOTE: total is $0 — likely the optimizer/target/judge model is not in the pricing table (src/core/cost.ts) or the adapter did not report cost.`,
    )
  }
}

function fmtTokens(tokens: TokenUsage): string {
  return `in=${tokens.input} out=${tokens.output}`
}

/**
 * Resolve skill directories from --skill or --skill-list.
 *
 * --skill is a single path (directory containing SKILL.md).
 * --skill-list is a file with one skill path per line; each path is resolved
 * against the list file's parent directory (or used as-is if absolute).
 */
async function resolveSkillDirs(config: JitOptimizeCliConfig): Promise<string[]> {
  if (config.skill) return [config.skill]
  if (!config["skill-list"]) return []

  const listPath = config["skill-list"]
  const { readFile } = await import("node:fs/promises")
  const { dirname, isAbsolute, join, resolve } = await import("node:path")

  const content = await readFile(listPath, "utf-8")
  const entries = content.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
  const baseDir = dirname(listPath)

  const dirs: string[] = []
  for (const entry of entries) {
    const skillDir = isAbsolute(entry) ? entry : resolve(join(baseDir, entry))
    if (await Bun.file(join(skillDir, "SKILL.md")).exists()) {
      dirs.push(skillDir)
    } else {
      console.warn(`Skipping ${entry}: no SKILL.md in ${skillDir}`)
    }
  }
  return dirs
}
