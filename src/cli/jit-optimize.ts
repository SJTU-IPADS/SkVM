/**
 * `skvm jit-optimize` — optimize a skill based on execution evidence.
 * Migrated to the declarative flag layer (#49). Cross-flag rules (the
 * per-task-source required/forbidden matrix, `--detach` × batch, required
 * models) live in `runJitOptimize` and its helpers, throwing `UsageError`
 * before any side effects. The domain engine stays in `src/jit-optimize/`.
 *
 * Design-carrying rule: `validateFlagsForSource` enforces the per-source
 * matrix by testing flag PRESENCE (`config[x] !== undefined`). Every
 * source-specific or log-forbidden flag is therefore declared WITHOUT a
 * layer default — it parses to `undefined` when absent — and its default is
 * applied in the handler (or `buildTaskSource`) AFTER the compatibility
 * check. Layer defaults exist only on `concurrency` and `target-adapter`,
 * whose presence never matters. `adapter-config`, `timeout-ms`,
 * `max-steps`, and `skill-mode` also parse to `undefined` when absent, but
 * for a different reason: their defaults live downstream
 * (resolveAdapterConfigMode, the engine's per-actor timeouts, per-task
 * maxSteps, the skill-mode fallback), so `undefined` simply passes through.
 */

import { defineFlags, UsageError, type ConfigOf } from "./flags.ts"
import { ALL_ADAPTERS } from "../adapters/registry.ts"
import { resolveAdapterConfigMode } from "../core/config.ts"
import { AdapterConfigModeSchema, type TokenUsage } from "../core/types.ts"
import { CLI_DEFAULTS } from "../core/ui-defaults.ts"
import { TIMEOUT_DEFAULTS } from "../core/timeouts.ts"
import { createLogger, c } from "../core/logger.ts"
import type {
  ExecutionLogInput,
  JitOptimizeConfig as JitOptimizeEngineConfig,
  JitOptimizeResult,
  TaskSource,
} from "../jit-optimize/types.ts"

export const JIT_OPTIMIZE_FLAGS = defineFlags(
  "jit-optimize",
  "Optimize a skill based on execution evidence",
  {
    // Skill selection
    skill: { kind: "string", placeholder: "<path>", help: "Path to skill directory (or --skill-list)" },
    "skill-list": { kind: "string", placeholder: "<file>", help: "One skill path per line (batch mode)" },
    "skill-mode": { kind: "enum", values: ["inject", "discover"], placeholder: "<mode>", help: `inject | discover (default: ${CLI_DEFAULTS.skillMode}). Controls how the skill\nis loaded into each per-task adapter run during optimization.` },
    // Source kind + per-source inputs — NO layer defaults (presence drives
    // validateFlagsForSource). `task-source` stays a string, not an enum:
    // buildTaskSource also accepts the long-form aliases `synthetic-task` /
    // `real-task` / `execution-log` and owns the validation.
    "task-source": { kind: "string", placeholder: "<kind>", help: "synthetic | real | log   (must be set explicitly)" },
    "synthetic-count": { kind: "int", min: 1, help: `Train tasks to generate (synthetic only; default: ${CLI_DEFAULTS.syntheticTrainCount})` },
    "synthetic-test-count": { kind: "int", min: 0, help: `Held-out test tasks to generate (synthetic only; default: ${CLI_DEFAULTS.syntheticTestCount})` },
    tasks: { kind: "string", placeholder: "<id|path,...>", help: "Train tasks — IDs or task.json paths (real only, required)" },
    "test-tasks": { kind: "string", placeholder: "<id|path,...>", help: "Held-out test tasks (real only). If omitted, --tasks is used as\nboth train and test (fallback for small task lists)." },
    logs: { kind: "string", placeholder: "<path,...>", help: "Conversation log files, comma-separated (log only, required)" },
    failures: { kind: "string", placeholder: "<path,...>", help: "Per-log failure JSON files, same order (log only, optional).\nEach file holds EvidenceCriterion[] evidence for its log." },
    // Target & optimizer
    "optimizer-model": { kind: "string", placeholder: "<id>", help: "Optimizer LLM model, shaped as <provider>/<model-id> (required)" },
    "compiler-model": { aliasOf: "optimizer-model" },
    "target-model": { kind: "string", placeholder: "<id>", help: "Target model being optimized for (required for every source;\nfor log it is the storage key of the proposal)" },
    model: { aliasOf: "target-model" },
    "target-adapter": { kind: "enum", values: ALL_ADAPTERS, default: CLI_DEFAULTS.adapter, placeholder: "<name>", help: `${ALL_ADAPTERS.join(" | ")}` },
    adapter: { aliasOf: "target-adapter" },
    // Loop — no layer defaults: presence is forbidden for log
    // (runs-per-task, task-concurrency, convergence) or the default is
    // source-dependent (rounds).
    rounds: { kind: "int", min: 1, help: "Max optimization rounds (default: 1 for log, 3 otherwise)" },
    "runs-per-task": { kind: "int", min: 1, help: `Runs per task per round (default: ${CLI_DEFAULTS.jitOptimizeRunsPerTask}; forbidden for log)` },
    "task-concurrency": { kind: "int", min: 1, help: `Max parallel in-flight task runs per round (default: ${CLI_DEFAULTS.jitOptimizeTaskConcurrency};\nforbidden for log). Train + test share the same limiter.` },
    convergence: { kind: "float", min: 0, max: 1, placeholder: "<0-1>", help: `Early-exit threshold on primary score (default: ${CLI_DEFAULTS.jitOptimizeConvergence}; forbidden for log)` },
    baseline: { kind: "bool", help: "Run no-skill/original conditions for comparison (forbidden for log)" },
    // Delivery
    "no-keep-all-rounds": { kind: "bool", help: "Keep only the best round's folder (default: keep all)" },
    "auto-apply": { kind: "bool", help: "Overwrite original skillDir with best round" },
    // Batch
    concurrency: { kind: "int", min: 1, default: CLI_DEFAULTS.concurrency, help: "Parallel jobs (batch mode)" },
    // Adapter mode
    "adapter-config": { kind: "enum", values: AdapterConfigModeSchema.options, placeholder: "<m>", help: "native | managed (default: defaults.adapterConfigMode in\nskvm.config.json, else managed)" },
    // Per-agent-loop overrides
    "timeout-ms": { kind: "int", min: 1, help: `Per-agent-loop ceiling for this jit-optimize run (ms).\nDefaults: task ${TIMEOUT_DEFAULTS.taskExec}, optimizer ${TIMEOUT_DEFAULTS.optimizer}, task-gen ${TIMEOUT_DEFAULTS.taskGen},\nsynthetic task exec ${TIMEOUT_DEFAULTS.syntheticTaskExec}. Per-loop ceiling, not total wall time.` },
    "max-steps": { kind: "int", min: 1, help: "Override max agent steps per task. When omitted,\neach task's own maxSteps is honored." },
    // Detached invocation
    detach: { kind: "bool", help: "Spawn a background worker and return as soon as it reports its\nproposal id. Single-skill only. Track with 'skvm proposals show <id>'." },
  },
  {
    usage: [
      "skvm jit-optimize --skill=<path> --task-source=<kind> [options]",
      "skvm jit-optimize --skill-list=<file> --task-source=<kind> [--concurrency=<n>] [options]",
    ],
    epilogue: `Deprecated aliases: --model → --target-model, --adapter → --target-adapter,
--compiler-model → --optimizer-model.`,
  },
)

export type JitOptimizeConfig = ConfigOf<typeof JIT_OPTIMIZE_FLAGS>

export async function runJitOptimize(config: JitOptimizeConfig): Promise<void> {
  const skillDirs = await resolveSkillDirs(config)
  if (skillDirs.length === 0) {
    throw new UsageError("jit-optimize: no skills resolved from --skill or --skill-list", JIT_OPTIMIZE_FLAGS.help)
  }

  const optimizerModel = config["optimizer-model"]
  if (!optimizerModel) {
    throw new UsageError("jit-optimize: --optimizer-model is required", JIT_OPTIMIZE_FLAGS.help)
  }

  // Build taskSource — --task-source is required, no inference
  const taskSource = buildTaskSource(config)

  // Validate flag compatibility for the chosen task source
  validateFlagsForSource(config, taskSource.kind)

  // --target-model is required for every source. For execution-log it's not
  // used to run anything; it's the storage key (target the logs came from),
  // and the user knows it because they're feeding in those logs.
  const tModel = config["target-model"]
  const tHarness = config["target-adapter"]
  if (!tModel) {
    throw new UsageError(
      `jit-optimize: --target-model is required for task-source=${stripSuffix(taskSource.kind)}`,
      JIT_OPTIMIZE_FLAGS.help,
    )
  }
  const adapterModeJit = resolveAdapterConfigMode(config["adapter-config"])
  const timeoutMsJit = config["timeout-ms"]
  const maxStepsJit = config["max-steps"]
  const skillMode = config["skill-mode"]
  const targetAdapter: JitOptimizeEngineConfig["targetAdapter"] = {
    model: tModel,
    harness: tHarness,
    adapterConfig: {
      mode: adapterModeJit,
      ...(timeoutMsJit !== undefined ? { timeoutMs: timeoutMsJit } : {}),
      ...(maxStepsJit !== undefined ? { maxSteps: maxStepsJit } : {}),
    },
  }

  const rounds = config.rounds ?? (taskSource.kind === "execution-log" ? 1 : 3)
  // Default raised from 1 to 2 as part of the pickBestRound hardening: a
  // single run per task per round leaves the noise floor carrying the full
  // scoring variance. Two runs is the cheapest meaningful improvement on
  // that statistical basis. Users can still pass `--runs-per-task=1`
  // explicitly to opt out.
  const runsPerTask = config["runs-per-task"] ?? CLI_DEFAULTS.jitOptimizeRunsPerTask
  const taskConcurrency = config["task-concurrency"] ?? CLI_DEFAULTS.jitOptimizeTaskConcurrency
  const convergence = config.convergence ?? CLI_DEFAULTS.jitOptimizeConvergence
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

  const buildConfig = (skillDir: string): JitOptimizeEngineConfig => ({
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
  const detach = config.detach
  if (detach) {
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
    // Process-level exit code from the detached spawn — not an error path.
    process.exit(code)
  }

  // Single skill
  if (skillDirs.length === 1) {
    const skillDir = skillDirs[0]!
    const skillName = deriveSkillName(skillDir)
    const harness = targetAdapter.harness
    if (!(await acquireOptimizeLock(harness, tModel, skillName))) {
      // Not a UsageError: environment state (lock), not flag shape.
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
// Helpers
// ---------------------------------------------------------------------------

export function buildTaskSource(config: JitOptimizeConfig): TaskSource {
  const kind = config["task-source"]
  if (!kind) {
    throw new UsageError("jit-optimize: --task-source is required (one of: synthetic | real | log)", JIT_OPTIMIZE_FLAGS.help)
  }
  if (kind === "synthetic" || kind === "synthetic-task") {
    // Count defaults are applied HERE, after validateFlagsForSource has had
    // its presence check — a layer default would make an absent flag
    // indistinguishable from an explicit one. Range checks (>= 1 / >= 0)
    // are owned by the layer's min bounds.
    const trainCount = config["synthetic-count"] ?? CLI_DEFAULTS.syntheticTrainCount
    const testCount = config["synthetic-test-count"] ?? CLI_DEFAULTS.syntheticTestCount
    return { kind: "synthetic-task", trainCount, testCount }
  }
  if (kind === "real" || kind === "real-task") {
    const raw = config.tasks
    if (!raw) {
      throw new UsageError("jit-optimize: --tasks is required for --task-source=real", JIT_OPTIMIZE_FLAGS.help)
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
  if (kind === "log" || kind === "execution-log") {
    const raw = config.logs
    if (!raw) {
      throw new UsageError("jit-optimize: --logs is required for --task-source=log", JIT_OPTIMIZE_FLAGS.help)
    }
    const logs = raw.split(",").map((s) => s.trim()).filter(Boolean)
    const failures = config.failures
      ? config.failures.split(",").map((s) => s.trim()).filter(Boolean)
      : []
    if (failures.length > 0 && failures.length !== logs.length) {
      throw new UsageError(
        `jit-optimize: --failures count (${failures.length}) must match --logs count (${logs.length})`,
        JIT_OPTIMIZE_FLAGS.help,
      )
    }
    return {
      kind: "execution-log",
      // criteriaPath: per-log EvidenceCriterion[] JSON — consumed by task-source.ts (#76).
      // Explicit callback return type (rather than letting `.map()` infer it)
      // is load-bearing: without it, TS does not excess-property-check the
      // literal against ExecutionLogInput, so a future field-name typo here
      // would again compile clean and silently drop data (#76).
      logs: logs.map((p, i): ExecutionLogInput => ({ path: p, criteriaPath: failures[i] })),
    }
  }
  throw new UsageError(`jit-optimize: unknown --task-source "${kind}" (expected synthetic | real | log)`, JIT_OPTIMIZE_FLAGS.help)
}

/**
 * Enforce flag compatibility: each task source accepts a specific subset of
 * flags; passing others is an error (not silently ignored) so users notice
 * when they've confused sources.
 */
export function validateFlagsForSource(config: JitOptimizeConfig, kind: TaskSource["kind"]): void {
  // Flags that are only valid for certain sources. Typed as an array of
  // literal config keys so the presence checks below stay cast-free.
  const SOURCE_SPECIFIC: ReadonlyArray<[keyof JitOptimizeConfig & string, TaskSource["kind"]]> = [
    ["synthetic-count", "synthetic-task"],
    ["synthetic-test-count", "synthetic-task"],
    ["tasks", "real-task"],
    ["test-tasks", "real-task"],
    ["logs", "execution-log"],
    ["failures", "execution-log"],
  ]
  // Flags that only make sense when a target agent actually runs tasks.
  // --target-model / --target-adapter are NOT in this set: every source needs
  // a target model (it's the proposal's storage key), and execution-log sets
  // the harness purely informationally.
  const TARGET_ADAPTER_FLAGS: ReadonlyArray<keyof JitOptimizeConfig & string> = [
    "runs-per-task",
    "task-concurrency",
    "convergence",
  ]

  const bad: string[] = []

  for (const [flag, allowedKind] of SOURCE_SPECIFIC) {
    if (config[flag] !== undefined && kind !== allowedKind) {
      bad.push(`--${flag} is only valid with --task-source=${stripSuffix(allowedKind)} (got ${stripSuffix(kind)})`)
    }
  }

  if (kind === "execution-log") {
    for (const flag of TARGET_ADAPTER_FLAGS) {
      if (config[flag] !== undefined) {
        bad.push(`--${flag} is not valid with --task-source=log (log source does not rerun tasks)`)
      }
    }
    // `--baseline` is a bool flag now: absent parses to false, so presence
    // cannot be observed post-parse. Ledger-class deviation from the legacy
    // string-flag behavior: `--baseline=false` no longer counts as "passed"
    // (it is indistinguishable from omitting the flag), while legacy
    // rejected any --baseline spelling for the log source.
    if (config.baseline === true) {
      bad.push("--baseline is not valid with --task-source=log (log source does not rerun tasks)")
    }
  }

  if (bad.length > 0) {
    throw new UsageError(
      "jit-optimize: incompatible flags:\n" + bad.map((m) => "  " + m).join("\n"),
      JIT_OPTIMIZE_FLAGS.help,
    )
  }
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
 * Resolve skill directories from --skill or --skill-list flag.
 *
 * --skill is a single path (directory containing SKILL.md).
 * --skill-list is a file with one skill path per line; each path is resolved
 * against the list file's parent directory (or used as-is if absolute).
 */
async function resolveSkillDirs(config: JitOptimizeConfig): Promise<string[]> {
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
