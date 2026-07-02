#!/usr/bin/env bun

import "./core/env-bootstrap.ts"
import { setLogLevel, createLogger, c, shouldUseColor } from "./core/logger.ts"
import { ALL_ADAPTERS, type AdapterName, isAdapterName } from "./adapters/registry.ts"
import { resolveAdapterConfigMode } from "./core/config.ts"
import { assertKnownFlags, parseSkillModeFlag } from "./core/cli-flags.ts"
import { runOrExit } from "./cli/flags.ts"
import { CLI_DEFAULTS } from "./core/ui-defaults.ts"
import { TIMEOUT_DEFAULTS } from "./core/timeouts.ts"
import pkgJson from "../package.json" with { type: "json" }

const args = process.argv.slice(2)
// Strip --no-auto-probe before any subcommand or flag parsing so it works
// regardless of position (before or after the subcommand name).
{
  const idx = args.indexOf("--no-auto-probe")
  if (idx !== -1) {
    process.env.SKVM_AUTO_PROBE = "0"
    args.splice(idx, 1)
  }
}
const rawCommand = args[0]
// Accept `--help` / `-h` at the top level as a synonym for no-command (help
// output). Accept `--version` / `-v` and print the bundled package version.
// Without this, `skvm --help` — which the README, install.sh post-script, and
// the skvm-general skill preflight all tell users to run — falls through to
// the unknown-command branch and exits non-zero.
const isTopLevelHelp = !rawCommand || rawCommand === "--help" || rawCommand === "-h"
const isTopLevelVersion = rawCommand === "--version" || rawCommand === "-v"
const command = isTopLevelHelp || isTopLevelVersion ? undefined : rawCommand

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {}
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const [key, val] = arg.slice(2).split("=")
      flags[key!] = val ?? "true"
    }
  }
  return flags
}

async function main() {
  // Hidden subcommand for `skvm jit-optimize --detach`. Spawned by the
  // parent CLI with stdio: ignore + IPC channel; takes a JSON-stringified
  // WorkerInput as argv[3]. Not listed in --help on purpose. The string
  // literal here must match detach.ts's JIT_OPTIMIZE_WORKER_SUBCOMMAND —
  // we inline the comparison to avoid importing detach.ts on the common
  // non-worker path.
  if (process.argv[2] === "__jit-optimize-worker") {
    const { runDetachWorker } = await import("./jit-optimize/detach.ts")
    await runDetachWorker(process.argv[3] ?? "")
    return
  }

  const flags = parseFlags(args.slice(1))

  if (flags.verbose) setLogLevel("debug")

  if (isTopLevelVersion) {
    console.log(pkgJson.version)
    process.exit(0)
  }

  if (!command) {
    console.log(`skvm — Compile and run LLM agent skills across heterogeneous models and harnesses

Commands:
  profile      Profile a model's primitive capabilities
  aot-compile  AOT-compile a skill for a target model
  pipeline     Profile (if needed), then AOT-compile
  run          Run a task with an optional skill (no scoring)
  bench        Benchmark skills across conditions and models
  jit-optimize Optimize a skill from synthetic, real, or log evidence
  proposals    List, inspect, accept, or reject proposals
  clean-jit    Remove persisted JIT artifacts for a model+adapter
  logs         List recent runs across subsystems
  config       Configure providers, adapters, and paths (init / show / doctor)

Global Options:
  --skvm-cache=<path>      Override cache root (default: ~/.skvm)
  --skvm-data-dir=<path>   Override dataset root (default: ./skvm-data)
  --tmp-dir=<path>         Override temp-dir root (default: \$SKVM_TMP_DIR or \${TMPDIR:-/tmp})
  --verbose                Enable debug logging
  --no-auto-probe          Disable auto-probe for this invocation (also via SKVM_AUTO_PROBE=0)
  --version, -v            Print version and exit
  --help, -h               Print this help and exit

Use --help with any command for details.`)
    process.exit(0)
  }

  switch (command) {
    case "profile": {
      const { PROFILE_FLAGS, runProfile } = await import("./cli/profile.ts")
      await runOrExit(PROFILE_FLAGS, args.slice(1), runProfile)
      break
    }
    case "test":
      console.log("test command not yet implemented")
      break
    case "aot-compile": {
      const { COMPILE_FLAGS, runCompile } = await import("./cli/aot-compile.ts")
      await runOrExit(COMPILE_FLAGS, args.slice(1), runCompile)
      break
    }
    case "run": {
      const { RUN_FLAGS, runRun } = await import("./cli/run.ts")
      await runOrExit(RUN_FLAGS, args.slice(1), runRun)
      break
    }
    case "pipeline": {
      const { PIPELINE_FLAGS, runPipeline } = await import("./cli/pipeline.ts")
      await runOrExit(PIPELINE_FLAGS, args.slice(1), runPipeline)
      break
    }
    case "bench": {
      const { BENCH_FLAGS, runBench } = await import("./cli/bench.ts")
      await runOrExit(BENCH_FLAGS, args.slice(1), runBench)
      break
    }
    case "jit-optimize":
      await runJitOptimize(flags)
      break
    case "proposals":
      await runProposals(args.slice(1))
      break
    case "clean-jit": {
      const { CLEAN_JIT_FLAGS, runCleanJIT } = await import("./cli/clean-jit.ts")
      await runOrExit(CLEAN_JIT_FLAGS, args.slice(1), runCleanJIT)
      break
    }
    case "logs": {
      const { parseOrExit } = await import("./cli/flags.ts")
      const { LOGS_FLAGS, runLogs } = await import("./cli/logs.ts")
      await runLogs(parseOrExit(LOGS_FLAGS, args.slice(1)))
      break
    }
    case "config": {
      const { runConfig } = await import("./cli-config/index.ts")
      await runConfig(args.slice(1))
      break
    }
    default:
      console.error(c.red(`Unknown command: ${command}`))
      process.exit(1)
  }

  process.exit(0)
}

// ---------------------------------------------------------------------------
// Command: proposals
// ---------------------------------------------------------------------------

const PROPOSALS_KNOWN_FLAGS: Record<string, ReadonlySet<string>> = {
  list:   new Set(["harness", "target-model", "model", "skill", "status",
                   "sort", "min-delta", "group-by", "no-color"]),
  show:   new Set(["full", "no-color", "round"]),
  diff:   new Set(["round"]),
  report: new Set(["harness", "target-model", "model", "skill", "status",
                   "sort", "min-delta", "group-by", "out"]),
  serve:  new Set(["port", "host", "no-open"]),
  accept: new Set(["target", "round"]),
  reject: new Set([]),
  cancel: new Set([]),
}

async function runProposals(rawArgs: string[]) {
  const sub = rawArgs[0]
  const flags = parseFlags(rawArgs.slice(1))
  const positional = rawArgs.slice(1).filter((a) => !a.startsWith("--"))

  if (sub && sub !== "help") {
    const allowed = PROPOSALS_KNOWN_FLAGS[sub] ?? new Set<string>()
    assertKnownFlags(`proposals ${sub}`, flags, allowed)
  }

  if (!sub || sub === "help" || flags.help === "true") {
    console.log(`skvm proposals - Manage jit-optimize proposals

Usage:
  skvm proposals list    [--harness=<n>] [--target-model=<id>] [--skill=<name>] [--status=<s>]
                         [--sort=recent|delta|skill|model] [--min-delta=<n>]
                         [--group-by=skill|model] [--no-color]
  skvm proposals show    <id> [--full] [--no-color]
                         [--round=<n>]   Show evidence + optimizer record for round N
  skvm proposals diff    <id> [--round=<n>]
  skvm proposals report  [filters as in list] [--out=<path>]
  skvm proposals serve   [--port=<n>] [--host=<h>] [--no-open]
  skvm proposals accept  <id> [--target=<dir>] [--round=<n>]
  skvm proposals reject  <id>
  skvm proposals cancel  <id>   Stop a detached run still in phase=running

Filters:
  --target-model=<id>   Filter by target model (the model the skill was tuned for).
                        --model is accepted as a deprecated alias.

Proposals root: $SKVM_PROPOSALS_DIR or ~/.skvm/proposals by default.`)
    process.exit(0)
  }

  const { listProposals, loadProposal, updateStatus, proposalDirFromId } = await import("./proposals/storage.ts")
  const { deployProposal } = await import("./proposals/deploy.ts")

  if (sub === "list") {
    const items = await listProposals({
      harness: flags.harness,
      targetModel: flags["target-model"] ?? flags.model,
      skillName: flags.skill,
      status: flags.status as "pending" | "accepted" | "rejected" | undefined,
    })
    if (items.length === 0) {
      console.log("No proposals found.")
      return
    }
    const {
      buildRow, sortRows, filterByMinDelta, renderTable,
      aggregate, renderGroupTable,
    } = await import("./proposals/list-format.ts")
    const color = shouldUseColor({ noColor: flags["no-color"] === "true" })

    const loaded = await Promise.all(items.map((s) => loadProposal(s.id)))
    let rows = loaded.map(buildRow)

    if (flags["min-delta"] !== undefined) {
      const min = parseFloat(flags["min-delta"])
      if (!Number.isNaN(min)) rows = filterByMinDelta(rows, min)
    }

    const sortKey = (flags.sort ?? CLI_DEFAULTS.listSort) as "recent" | "delta" | "skill" | "model"
    rows = sortRows(rows, sortKey)

    if (flags["group-by"]) {
      const groupBy = flags["group-by"] as "skill" | "model"
      if (groupBy !== "skill" && groupBy !== "model") {
        console.error(`--group-by must be 'skill' or 'model'`)
        process.exit(1)
      }
      const groups = aggregate(rows, groupBy)
      console.log(renderGroupTable(groups, groupBy, { color }))
      return
    }

    console.log(renderTable(rows, { color }))
    return
  }

  if (sub === "show") {
    const id = positional[0]
    if (!id) { console.error("Usage: skvm proposals show <id> [--round=N]"); process.exit(1) }
    const p = await loadProposal(id)
    const proposalDir = proposalDirFromId(id)

    // --round=<n> dispatches to the per-round inspector — the durable evidence
    // record + optimizer step record introduced with schemaVersion=1. Output
    // is markdown so the same machinery prints cleanly to a terminal or
    // pipes to a viewer.
    if (flags.round !== undefined) {
      const round = parseInt(flags.round, 10)
      if (Number.isNaN(round)) { console.error(`--round must be an integer`); process.exit(1) }
      const { renderRoundShow } = await import("./proposals/round-show.ts")
      const result = await renderRoundShow(proposalDir, round)
      console.log(result.text)
      return
    }
    const { renderShowSummary, formatRunPhaseLine } = await import("./proposals/list-format.ts")
    const { selfHealRunStatus } = await import("./jit-optimize/run-status.ts")
    const color = shouldUseColor({ noColor: flags["no-color"] === "true" })

    // selfHealRunStatus rewrites phase=running → phase=failed when the
    // worker pid is gone, so a stale "running" never misleads the reader.
    const run = await selfHealRunStatus(proposalDir)
    const phaseLine = formatRunPhaseLine(run, proposalDir, color)
    if (phaseLine !== null) {
      console.log(phaseLine)
      if (run?.phase === "failed" && run.error) {
        // First line of the error lives here; full trace is in run.log.
        const firstLine = run.error.split("\n")[0]?.trim() ?? ""
        if (firstLine) console.log(`     ${firstLine}`)
      }
    }

    console.log(`# ${id}`)
    console.log(`status: ${p.meta.status}`)
    console.log(`optimizer-model: ${p.meta.optimizerModel}`)
    if (p.meta.targetModel) console.log(`target-model: ${p.meta.targetModel}`)
    console.log(`harness: ${p.meta.harness}`)
    console.log(`skill: ${p.meta.skillName} (${p.meta.skillDir})`)
    console.log(`source: ${p.meta.source}`)
    console.log(`best round: ${p.meta.bestRound} — ${p.meta.bestRoundReason}`)
    console.log(`total rounds: ${p.meta.roundCount}`)
    if (p.meta.acceptedRound !== null) console.log(`accepted round: ${p.meta.acceptedRound}`)
    console.log(renderShowSummary(p, { color }))
    if (flags.full === "true") {
      console.log("")
      console.log("--- analysis.md ---")
      console.log(p.analysis)
    }
    // Tail run.log when the worker is mid-flight or has failed — gives
    // the reader recent context that the structured fields above can't
    // (current-round progress, the error's surrounding log lines).
    // Skipped on done because finalized meta + rounds table already cover it.
    if (run !== null && (run.phase === "running" || run.phase === "failed")) {
      const { readLastLines } = await import("./core/fs-utils.ts")
      const pathMod = await import("node:path")
      const tail = await readLastLines(pathMod.join(proposalDir, "run.log"), 20)
      if (tail !== null) {
        console.log("")
        console.log(`--- run.log (last 20 lines) ---`)
        console.log(tail)
      }
    }
    return
  }

  if (sub === "diff") {
    const id = positional[0]
    if (!id) { console.error("Usage: skvm proposals diff <id> [--round=N]"); process.exit(1) }
    const p = await loadProposal(id)
    const round = flags.round !== undefined ? parseInt(flags.round, 10) : p.meta.bestRound
    if (Number.isNaN(round)) { console.error(`--round must be an integer`); process.exit(1) }
    if (round === 0) {
      console.log("(round-0 is the baseline — no diff against original)")
      return
    }
    const { diffProposalRound } = await import("./proposals/diff.ts")
    const result = await diffProposalRound(proposalDirFromId(id), round)
    if (!result.ok) {
      console.error(result.reason)
      process.exit(1)
    }
    process.stdout.write(result.unified)
    return
  }

  if (sub === "report") {
    const items = await listProposals({
      harness: flags.harness,
      targetModel: flags["target-model"] ?? flags.model,
      skillName: flags.skill,
      status: flags.status as "pending" | "accepted" | "rejected" | undefined,
    })
    if (items.length === 0) {
      console.log("No proposals found — nothing to report.")
      return
    }
    const loaded = await Promise.all(items.map((s) => loadProposal(s.id)))
    const { generateReport } = await import("./proposals/report.ts")
    const html = await generateReport(loaded)
    const { JIT_OPTIMIZE_DIR } = await import("./core/config.ts")
    const pathMod = await import("node:path")
    const outPath = flags.out ?? pathMod.join(JIT_OPTIMIZE_DIR, "report.html")
    await Bun.write(outPath, html)
    console.log(`Wrote ${items.length}-proposal report → ${outPath}`)
    return
  }

  if (sub === "serve") {
    const port = flags.port ? parseInt(flags.port, 10) : CLI_DEFAULTS.reportPort
    const host = flags.host ?? CLI_DEFAULTS.reportHost
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      console.error(`--port must be a valid port number`)
      process.exit(1)
    }
    const { startServer } = await import("./proposals/serve.ts")
    const server = startServer({ port, host })
    console.log(`SkVM proposals review server listening on ${server.url}`)
    console.log(`  Press Ctrl+C to stop.`)
    if (flags["no-open"] !== "true") {
      const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
      try {
        Bun.spawn([openCmd, server.url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
      } catch {
        // ignore — user can still navigate manually
      }
    }
    // Keep the process alive until SIGINT/SIGTERM.
    await new Promise<void>((resolve) => {
      const shutdown = () => {
        console.log("\nShutting down…")
        server.stop()
        resolve()
      }
      process.on("SIGINT", shutdown)
      process.on("SIGTERM", shutdown)
    })
    return
  }

  if (sub === "accept") {
    const id = positional[0]
    if (!id) { console.error("Usage: skvm proposals accept <id>"); process.exit(1) }
    const target = flags.target
    const round = flags.round ? parseInt(flags.round, 10) : undefined
    const r = await deployProposal(id, { targetDir: target, round })
    console.log(`Accepted ${id} (round ${r.deployedRound})`)
    console.log(`  Deployed ${r.filesDeployed.length} file(s) → ${r.targetDir}`)
    if (r.filesBackedUp.length > 0) {
      console.log(`  Backed up ${r.filesBackedUp.length} existing file(s):`)
      for (const f of r.filesBackedUp) console.log(`    ${f}`)
    }
    return
  }

  if (sub === "reject") {
    const id = positional[0]
    if (!id) { console.error("Usage: skvm proposals reject <id>"); process.exit(1) }
    await updateStatus(id, "rejected")
    console.log(`Rejected ${id}`)
    return
  }

  if (sub === "cancel") {
    const id = positional[0]
    if (!id) { console.error("Usage: skvm proposals cancel <id>"); process.exit(1) }
    const proposalDir = proposalDirFromId(id)
    const { readRunStatus, patchRunStatus } = await import("./jit-optimize/run-status.ts")
    const { isPidAlive } = await import("./core/file-lock.ts")

    const status = await readRunStatus(proposalDir)
    if (status === null) {
      console.error(`cancel: ${id} has no run-status.json (not a detached run)`)
      process.exit(1)
    }
    if (status.phase !== "running") {
      console.error(`cancel: ${id} is already in phase=${status.phase}, nothing to cancel`)
      process.exit(1)
    }

    const pid = status.pid

    if (!isPidAlive(pid)) {
      await patchRunStatus(proposalDir, {
        phase: "failed",
        finishedAt: new Date().toISOString(),
        error: `worker pid ${pid} was already dead at cancel time`,
      })
      console.log(`Cancelled ${id} (worker pid ${pid} was already dead; marked failed)`)
      return
    }

    // SIGTERM so file-lock.ts's signal handler runs `releaseAllHeld` and
    // unlinks the optimize lock before exit. If the worker is stuck in a
    // blocking call that ignores SIGTERM, escalate to SIGKILL after 2s.
    try {
      process.kill(pid, "SIGTERM")
    } catch (err) {
      console.error(`cancel: failed to signal pid ${pid}: ${err}`)
      process.exit(1)
    }

    const DEADLINE_MS = 3000
    const KILL_ESCALATE_MS = 2000
    const start = Date.now()
    let escalated = false
    let died = false
    while (Date.now() - start < DEADLINE_MS) {
      if (!isPidAlive(pid)) { died = true; break }
      if (!escalated && Date.now() - start >= KILL_ESCALATE_MS) {
        try { process.kill(pid, "SIGKILL") } catch { /* race — already dead */ }
        escalated = true
      }
      await Bun.sleep(100)
    }

    if (!died) {
      // Leave run-status at phase=running: a zombie worker may still
      // complete and write its own terminal state, and we don't want to
      // overwrite that with a lie.
      console.error(`cancel: ${id} — pid ${pid} did not die within ${DEADLINE_MS / 1000}s; run-status unchanged, please investigate manually`)
      process.exit(1)
    }

    await patchRunStatus(proposalDir, {
      phase: "failed",
      finishedAt: new Date().toISOString(),
      error: `cancelled by user${escalated ? " (SIGKILL after SIGTERM timeout)" : ""}`,
    })
    console.log(`Cancelled ${id} (worker pid ${pid} stopped${escalated ? " via SIGKILL" : ""}; marked failed)`)
    return
  }

  console.error(`Unknown proposals subcommand: ${sub}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Command: jit-optimize
// ---------------------------------------------------------------------------

const JIT_OPTIMIZE_KNOWN_FLAGS: ReadonlySet<string> = new Set([
  // Skill selection
  "skill", "skill-list", "skill-mode",
  // Source kind + per-source inputs
  "task-source",
  "synthetic-count", "synthetic-test-count",
  "tasks", "test-tasks",
  "logs", "failures",
  // Target & optimizer
  "optimizer-model", "compiler-model",
  "target-model", "target-adapter",
  "model", "adapter",          // deprecated aliases — see runJitOptimize
  // Loop
  "rounds", "runs-per-task", "task-concurrency", "convergence", "baseline",
  // Delivery
  "no-keep-all-rounds", "auto-apply",
  // Batch
  "concurrency",
  // Adapter mode
  "adapter-config",
  // Per-agent-loop timeout / step overrides
  "timeout-ms", "max-steps",
  // Detached invocation
  "detach",
])

async function runJitOptimize(flags: Record<string, string>) {
  assertKnownFlags("jit-optimize", flags, JIT_OPTIMIZE_KNOWN_FLAGS)
  if (flags.help === "true") {
    console.log(`skvm jit-optimize - Optimize a skill based on execution evidence

Usage:
  skvm jit-optimize --skill=<path> --task-source=<kind> [options]
  skvm jit-optimize --skill-list=<file> --task-source=<kind> [--concurrency=<n>] [options]

Required for all sources:
  --skill=<path>             Path to skill directory (or --skill-list)
  --task-source=<kind>       synthetic | real | log   (must be set explicitly)
  --optimizer-model=<id>     Optimizer LLM model, shaped as <provider>/<model-id>

Task-source-specific flags:
  --task-source=synthetic
    --synthetic-count=<n>      Train tasks to generate (default: ${CLI_DEFAULTS.syntheticTrainCount})
    --synthetic-test-count=<n> Held-out test tasks to generate (default: ${CLI_DEFAULTS.syntheticTestCount})
    --target-model=<id>        Target model being optimized for          [required]
    --target-adapter=<name>    ${ALL_ADAPTERS.join(" | ")} (default: ${CLI_DEFAULTS.adapter})
    (forbidden: --tasks, --test-tasks, --logs, --failures)

  --task-source=real
    --tasks=<id|path,...>      Train tasks — IDs or task.json paths      [required]
    --test-tasks=<id|path,...> Held-out test tasks. If omitted, --tasks is used as
                               both train and test (fallback for small task lists).
    --target-model=<id>        Target model being optimized for          [required]
    --target-adapter=<name>    ${ALL_ADAPTERS.join(" | ")} (default: ${CLI_DEFAULTS.adapter})
    (forbidden: --synthetic-count, --synthetic-test-count, --logs, --failures)

  --task-source=log
    --logs=<path,...>          Conversation log files, comma-separated   [required]
    --failures=<path,...>      Per-log failure JSON files, same order    [optional]
    --target-model=<id>        Target model the logs were produced on    [required]
    --target-adapter=<name>    ${ALL_ADAPTERS.join(" | ")} (default: ${CLI_DEFAULTS.adapter})
                               (informational only — log source does not rerun tasks)
    (forbidden: --tasks, --test-tasks, --synthetic-count, --synthetic-test-count,
                --runs-per-task, --convergence, --baseline)

Loop:
  --rounds=<n>               Max optimization rounds (default: 1 for log, 3 otherwise)
  --runs-per-task=<n>        Runs per task per round (default: ${CLI_DEFAULTS.jitOptimizeRunsPerTask}; forbidden for log).
                             Default was 1 prior to the pickBestRound hardening;
                             raised to give the selection noise-floor a cleaner
                             statistical basis and reduce single-run variance in
                             per-task monotonicity checks.
  --task-concurrency=<n>     Max parallel in-flight task runs per round (default: ${CLI_DEFAULTS.jitOptimizeTaskConcurrency};
                             forbidden for log). Train + test share the same limiter,
                             so total in-flight never exceeds N. jiuwenclaw holds a
                             global sidecar file lock and serializes naturally
                             regardless of this setting.
  --convergence=<0-1>        Early-exit threshold on primary score
                             (default: 0.95; forbidden for log). Primary score is
                             the test score when a test set exists, else the train score.
  --baseline                 Run no-skill/original conditions for comparison (forbidden for log)

Delivery (writes to the proposals tree):
  --no-keep-all-rounds       Keep only the best round's folder (default: keep all)
  --auto-apply               Overwrite original skillDir with best round

Batch mode:
  --skill-list=<file>        One skill path per line
  --concurrency=<n>          Parallel jobs (default: ${CLI_DEFAULTS.concurrency})

Adapter config:
  --adapter-config=<m>       native | managed (default: defaults.adapterConfigMode in
                             skvm.config.json, else managed). Applies to the target
                             adapter that runs tasks during optimization.
  --skill-mode=<mode>        inject | discover (default: inject). Controls
                             how the skill is loaded into each per-task
                             adapter run during optimization.
  --timeout-ms=<n>           Per-agent-loop ceiling for this jit-optimize run (ms).
                             Applies to:
                               - each per-task adapter execution
                                 (default: ${TIMEOUT_DEFAULTS.taskExec})
                               - each round's optimizer agent
                                 (default: ${TIMEOUT_DEFAULTS.optimizer})
                               - the synthetic task-gen agent if used
                                 (default: ${TIMEOUT_DEFAULTS.taskGen})
                               - synthetic tasks' default timeout when
                                 --task-source=synthetic (default: ${TIMEOUT_DEFAULTS.syntheticTaskExec})
                             Each agent loop is timed independently — this is a
                             per-loop ceiling, not a total wall time.
  --max-steps=<n>            Override max agent steps per task. When omitted,
                             each task's own maxSteps is honored.

Detached invocation:
  --detach                   Spawn a background worker and return as soon as
                             it reports its proposal id (~100-300 ms). The
                             optimization runs in the background; use
                             'skvm proposals show <id>' to track progress
                             and 'skvm proposals list' to enumerate
                             detached runs. Single-skill only: not
                             compatible with --skill-list / batch mode.
`)
    process.exit(0)
  }

  const skillDirs = await resolveSkillDirs(flags)
  if (skillDirs.length === 0) {
    console.error("jit-optimize: no skills resolved from --skill or --skill-list")
    process.exit(1)
  }

  const optimizerModel = flags["optimizer-model"] ?? flags["compiler-model"]
  if (!optimizerModel) {
    console.error("jit-optimize: --optimizer-model is required")
    process.exit(1)
  }

  // Build taskSource — --task-source is required, no inference
  const taskSource = buildTaskSource(flags)

  // Validate flag compatibility for the chosen task source
  validateFlagsForSource(flags, taskSource.kind)

  // --target-model is required for every source. For execution-log it's not
  // used to run anything; it's the storage key (target the logs came from),
  // and the user knows it because they're feeding in those logs.
  const tModel = flags["target-model"] ?? flags.model
  const tHarnessStr = flags["target-adapter"] ?? flags.adapter ?? CLI_DEFAULTS.adapter
  if (!isAdapterName(tHarnessStr)) {
    console.error(`jit-optimize: invalid --target-adapter "${tHarnessStr}". Valid: ${ALL_ADAPTERS.join(", ")}`)
    process.exit(1)
  }
  const tHarness: AdapterName = tHarnessStr
  if (!tModel) {
    console.error(`jit-optimize: --target-model is required for task-source=${stripSuffix(taskSource.kind)}`)
    process.exit(1)
  }
  const adapterModeJit = resolveAdapterConfigMode(flags["adapter-config"])
  let timeoutMsJit: number | undefined
  if (flags["timeout-ms"] !== undefined) {
    const parsed = parseInt(flags["timeout-ms"], 10)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`jit-optimize: --timeout-ms must be a positive integer (got "${flags["timeout-ms"]}")`)
      process.exit(1)
    }
    timeoutMsJit = parsed
  }
  let maxStepsJit: number | undefined
  if (flags["max-steps"] !== undefined) {
    const parsed = parseInt(flags["max-steps"], 10)
    if (!Number.isFinite(parsed) || parsed < 1) {
      console.error(`jit-optimize: --max-steps must be a positive integer (got "${flags["max-steps"]}")`)
      process.exit(1)
    }
    maxStepsJit = parsed
  }
  const skillMode = parseSkillModeFlag(flags)
  const targetAdapter: import("./jit-optimize/types.ts").JitOptimizeConfig["targetAdapter"] = {
    model: tModel,
    harness: tHarness,
    adapterConfig: {
      mode: adapterModeJit,
      ...(timeoutMsJit !== undefined ? { timeoutMs: timeoutMsJit } : {}),
      ...(maxStepsJit !== undefined ? { maxSteps: maxStepsJit } : {}),
    },
  }

  const rounds = flags.rounds
    ? parseInt(flags.rounds, 10)
    : taskSource.kind === "execution-log" ? 1 : 3
  // Default raised from 1 to 2 as part of the pickBestRound hardening: a
  // single run per task per round leaves the noise floor carrying the full
  // scoring variance. Two runs is the cheapest meaningful improvement on
  // that statistical basis. Users can still pass `--runs-per-task=1`
  // explicitly to opt out.
  const runsPerTask = flags["runs-per-task"] ? parseInt(flags["runs-per-task"], 10) : CLI_DEFAULTS.jitOptimizeRunsPerTask
  const taskConcurrency = flags["task-concurrency"] ? parseInt(flags["task-concurrency"], 10) : CLI_DEFAULTS.jitOptimizeTaskConcurrency
  if (!Number.isFinite(taskConcurrency) || taskConcurrency < 1) {
    console.error(`jit-optimize: --task-concurrency must be an integer >= 1 (got "${flags["task-concurrency"]}")`)
    process.exit(1)
  }
  const convergence = flags.convergence ? parseFloat(flags.convergence) : 0.95
  const baseline = flags.baseline === "true" || flags.baseline === ""
  const keepAllRounds = flags["no-keep-all-rounds"] !== "true" && flags["no-keep-all-rounds"] !== ""
  const autoApply = flags["auto-apply"] === "true" || flags["auto-apply"] === ""
  const concurrency = flags.concurrency ? parseInt(flags.concurrency, 10) : CLI_DEFAULTS.concurrency

  {
    const { printBanner, describeModelRoute, describeAdapter, shortenPath } = await import("./core/banner.ts")
    const { SKVM_CACHE, JIT_OPTIMIZE_DIR } = await import("./core/config.ts")
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

  const { jitOptimize } = await import("./jit-optimize/index.ts")
  const { acquireOptimizeLock, releaseOptimizeLock } = await import("./proposals/storage.ts")

  const buildConfig = (skillDir: string): import("./jit-optimize/types.ts").JitOptimizeConfig => ({
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
  const detach = flags.detach === "true" || flags.detach === ""
  if (detach) {
    if (skillDirs.length > 1) {
      console.error(
        "jit-optimize: --detach is incompatible with --skill-list / multi-skill batches " +
        "(detached workers outlive the parent and cannot be throttled by --concurrency). " +
        "Re-run without --detach, or invoke `skvm jit-optimize --detach ...` once per skill.",
      )
      process.exit(1)
    }
    const { spawnDetachedJitOptimize } = await import("./jit-optimize/detach.ts")
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
  const { createSlotPool } = await import("./core/concurrency.ts")
  const pool = createSlotPool(concurrency)

  interface BatchResult {
    skillDir: string
    skillName: string
    result?: import("./jit-optimize/types.ts").JitOptimizeResult
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
// jit-optimize flag helpers
// ---------------------------------------------------------------------------

function buildTaskSource(flags: Record<string, string>): import("./jit-optimize/types.ts").TaskSource {
  const kind = flags["task-source"]
  if (!kind) {
    console.error("jit-optimize: --task-source is required (one of: synthetic | real | log)")
    process.exit(1)
  }
  if (kind === "synthetic" || kind === "synthetic-task") {
    const trainCount = flags["synthetic-count"] ? parseInt(flags["synthetic-count"], 10) : CLI_DEFAULTS.syntheticTrainCount
    const testCount = flags["synthetic-test-count"] ? parseInt(flags["synthetic-test-count"], 10) : CLI_DEFAULTS.syntheticTestCount
    if (trainCount < 1) {
      console.error("jit-optimize: --synthetic-count must be >= 1")
      process.exit(1)
    }
    if (testCount < 0) {
      console.error("jit-optimize: --synthetic-test-count must be >= 0")
      process.exit(1)
    }
    return { kind: "synthetic-task", trainCount, testCount }
  }
  if (kind === "real" || kind === "real-task") {
    const raw = flags.tasks
    if (!raw) {
      console.error("jit-optimize: --tasks is required for --task-source=real")
      process.exit(1)
    }
    const trainTasks = raw.split(",").map((s) => s.trim()).filter(Boolean)
    const testTasks = flags["test-tasks"]
      ? flags["test-tasks"].split(",").map((s) => s.trim()).filter(Boolean)
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
    const raw = flags.logs
    if (!raw) {
      console.error("jit-optimize: --logs is required for --task-source=log")
      process.exit(1)
    }
    const logs = raw.split(",").map((s) => s.trim()).filter(Boolean)
    const failures = flags.failures
      ? flags.failures.split(",").map((s) => s.trim()).filter(Boolean)
      : []
    if (failures.length > 0 && failures.length !== logs.length) {
      console.error(`jit-optimize: --failures count (${failures.length}) must match --logs count (${logs.length})`)
      process.exit(1)
    }
    return {
      kind: "execution-log",
      logs: logs.map((p, i) => ({ path: p, failuresPath: failures[i] })),
    }
  }
  console.error(`jit-optimize: unknown --task-source "${kind}" (expected synthetic | real | log)`)
  process.exit(1)
}

/**
 * Enforce flag compatibility: each task source accepts a specific subset of
 * flags; passing others is an error (not silently ignored) so users notice
 * when they've confused sources.
 */
function validateFlagsForSource(
  flags: Record<string, string>,
  kind: import("./jit-optimize/types.ts").TaskSource["kind"],
): void {
  // Flags that are only valid for certain sources.
  const SOURCE_SPECIFIC: Record<string, "synthetic-task" | "real-task" | "execution-log"> = {
    "synthetic-count": "synthetic-task",
    "synthetic-test-count": "synthetic-task",
    tasks: "real-task",
    "test-tasks": "real-task",
    logs: "execution-log",
    failures: "execution-log",
  }
  // Flags that only make sense when a target agent actually runs tasks.
  // --target-model / --target-adapter are NOT in this set: every source needs
  // a target model (it's the proposal's storage key), and execution-log sets
  // the harness purely informationally.
  const TARGET_ADAPTER_FLAGS = new Set([
    "runs-per-task",
    "task-concurrency",
    "convergence",
    "baseline",
  ])

  const bad: string[] = []

  for (const [flag, allowedKind] of Object.entries(SOURCE_SPECIFIC)) {
    if (flags[flag] !== undefined && kind !== allowedKind) {
      bad.push(`--${flag} is only valid with --task-source=${stripSuffix(allowedKind)} (got ${stripSuffix(kind)})`)
    }
  }

  if (kind === "execution-log") {
    for (const flag of TARGET_ADAPTER_FLAGS) {
      if (flags[flag] !== undefined) {
        bad.push(`--${flag} is not valid with --task-source=log (log source does not rerun tasks)`)
      }
    }
  }

  if (bad.length > 0) {
    console.error("jit-optimize: incompatible flags:")
    for (const msg of bad) console.error(`  ${msg}`)
    process.exit(1)
  }
}

/** Normalize the internal "-task" / "execution-" suffixes back to the CLI spelling. */
function stripSuffix(kind: import("./jit-optimize/types.ts").TaskSource["kind"]): string {
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

function printOptimizeResult(
  skillName: string,
  result: import("./jit-optimize/types.ts").JitOptimizeResult,
): void {
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

function fmtTokens(tokens: import("./core/types.ts").TokenUsage): string {
  return `in=${tokens.input} out=${tokens.output}`
}

/**
 * Resolve skill directories from --skill or --skill-list flag.
 *
 * --skill is a single path (directory containing SKILL.md).
 * --skill-list is a file with one skill path per line; each path is resolved
 * against the list file's parent directory (or used as-is if absolute).
 */
async function resolveSkillDirs(flags: Record<string, string>): Promise<string[]> {
  if (flags.skill) return [flags.skill]
  if (!flags["skill-list"]) return []

  const listPath = flags["skill-list"]
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

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
