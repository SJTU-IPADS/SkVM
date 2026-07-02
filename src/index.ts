#!/usr/bin/env bun

import "./core/env-bootstrap.ts"
import { setLogLevel, c, shouldUseColor } from "./core/logger.ts"
import { assertKnownFlags } from "./core/cli-flags.ts"
import { runOrExit } from "./cli/flags.ts"
import { CLI_DEFAULTS } from "./core/ui-defaults.ts"
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
    case "jit-optimize": {
      const { JIT_OPTIMIZE_FLAGS, runJitOptimize } = await import("./cli/jit-optimize.ts")
      await runOrExit(JIT_OPTIMIZE_FLAGS, args.slice(1), runJitOptimize)
      break
    }
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

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
