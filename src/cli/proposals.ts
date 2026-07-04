/**
 * `skvm proposals` — list, inspect, accept, or reject jit-optimize proposals.
 * Migrated to the declarative flag layer (#49).
 *
 * The odd one out among subcommands: eight sub-subcommands, each with its own
 * flag set, several taking a positional `<id>`. Shape (decided 2026-07-02):
 * one `defineFlags` definition per sub, with the command label
 * `"proposals <sub>"` so unknown-flag errors keep the exact legacy
 * `assertKnownFlags` wording; a pure router (`routeProposals`) extracts the
 * sub name and the positional id — the flag layer never sees positionals (its
 * `parse()` ignores non-`--` argv entries by design). Per-sub `--help` is
 * generated from the declarations; the top-level overview stays hand-written
 * (`printProposalsOverview`), matching the legacy block.
 *
 * Import shape: the legacy `runProposals` loaded `proposals/storage.ts` and
 * `proposals/deploy.ts` eagerly before dispatching to any sub. The handlers
 * are now exported and unit-testable, so each one dynamically imports exactly
 * what it needs at its top — the same lazy-import boundary as every other
 * migrated subcommand, with a narrower per-sub surface.
 */

import { defineFlags, parseOrExit, exitOnUsageError, UsageError, type ConfigOf } from "./flags.ts"
import { shouldUseColor } from "../core/logger.ts"
import { CLI_DEFAULTS } from "../core/ui-defaults.ts"

// ---------------------------------------------------------------------------
// Flag definitions (one per sub-subcommand)
// ---------------------------------------------------------------------------

/**
 * Shared filter spec for `list` and `report` — their legacy allow-sets were
 * identical except list's `--no-color` and report's `--out`.
 */
const LIST_FILTER_SPEC = {
  harness: { kind: "string", placeholder: "<n>", help: "Filter by harness" },
  "target-model": { kind: "string", placeholder: "<id>", help: "Filter by target model (the model the skill was tuned for)" },
  model: { aliasOf: "target-model" },
  skill: { kind: "string", placeholder: "<name>", help: "Filter by skill name" },
  status: { kind: "enum", values: ["pending", "accepted", "rejected"], placeholder: "<s>", help: "Filter by status" },
  sort: { kind: "enum", values: ["recent", "delta", "skill", "model"], default: CLI_DEFAULTS.listSort, help: "Sort order" },
  "min-delta": { kind: "float", placeholder: "<n>", help: "Only rows with score delta >= n" },
  "group-by": { kind: "enum", values: ["skill", "model"], placeholder: "<g>", help: "Aggregate rows" },
} as const

export const PROPOSALS_LIST_FLAGS = defineFlags("proposals list", "List jit-optimize proposals", {
  ...LIST_FILTER_SPEC,
  "no-color": { kind: "bool", help: "Disable ANSI colors" },
}, { usage: ["skvm proposals list [filters]"] })

export const PROPOSALS_SHOW_FLAGS = defineFlags("proposals show", "Show one proposal", {
  full: { kind: "bool", help: "Also print analysis.md" },
  "no-color": { kind: "bool", help: "Disable ANSI colors" },
  round: { kind: "int", min: 0, placeholder: "<n>", help: "Show evidence + optimizer record for round N" },
}, { usage: ["skvm proposals show <id> [--full] [--no-color] [--round=<n>]"] })

export const PROPOSALS_DIFF_FLAGS = defineFlags("proposals diff", "Diff a proposal round against the original", {
  round: { kind: "int", min: 0, placeholder: "<n>", help: "Round to diff (default: best round)" },
}, { usage: ["skvm proposals diff <id> [--round=<n>]"] })

export const PROPOSALS_REPORT_FLAGS = defineFlags("proposals report", "Write an HTML report", {
  ...LIST_FILTER_SPEC,
  out: { kind: "string", placeholder: "<path>", help: "Output path (default: <jit-optimize-dir>/report.html)" },
}, { usage: ["skvm proposals report [filters] [--out=<path>]"] })

export const PROPOSALS_SERVE_FLAGS = defineFlags("proposals serve", "Serve the review UI", {
  port: { kind: "int", min: 1, max: 65535, default: CLI_DEFAULTS.reportPort, help: "Port" },
  host: { kind: "string", placeholder: "<h>", default: CLI_DEFAULTS.reportHost, help: "Host" },
  "no-open": { kind: "bool", help: "Do not open a browser" },
}, { usage: ["skvm proposals serve [--port=<n>] [--host=<h>] [--no-open]"] })

export const PROPOSALS_ACCEPT_FLAGS = defineFlags("proposals accept", "Deploy a proposal round", {
  target: { kind: "string", placeholder: "<dir>", help: "Deploy target directory (default: original skillDir)" },
  round: { kind: "int", min: 0, placeholder: "<n>", help: "Round to deploy (default: best round)" },
}, { usage: ["skvm proposals accept <id> [--target=<dir>] [--round=<n>]"] })

export const PROPOSALS_REJECT_FLAGS = defineFlags("proposals reject", "Mark a proposal rejected", {},
  { usage: ["skvm proposals reject <id>"] })

export const PROPOSALS_CANCEL_FLAGS = defineFlags("proposals cancel", "Stop a detached run still in phase=running", {},
  { usage: ["skvm proposals cancel <id>"] })

export type ProposalsListConfig = ConfigOf<typeof PROPOSALS_LIST_FLAGS>
export type ProposalsShowConfig = ConfigOf<typeof PROPOSALS_SHOW_FLAGS>
export type ProposalsDiffConfig = ConfigOf<typeof PROPOSALS_DIFF_FLAGS>
export type ProposalsReportConfig = ConfigOf<typeof PROPOSALS_REPORT_FLAGS>
export type ProposalsServeConfig = ConfigOf<typeof PROPOSALS_SERVE_FLAGS>
export type ProposalsAcceptConfig = ConfigOf<typeof PROPOSALS_ACCEPT_FLAGS>
export type ProposalsRejectConfig = ConfigOf<typeof PROPOSALS_REJECT_FLAGS>
export type ProposalsCancelConfig = ConfigOf<typeof PROPOSALS_CANCEL_FLAGS>

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export type ProposalsRoute =
  | { kind: "overview" }
  | { kind: "unknown"; sub: string }
  | { kind: "sub"; sub: SubName; id: string | undefined; argv: string[] }

const SUB_NAMES = ["list", "show", "diff", "report", "serve", "accept", "reject", "cancel"] as const
type SubName = (typeof SUB_NAMES)[number]
const SUBS: ReadonlySet<string> = new Set(SUB_NAMES)

function isSubName(s: string): s is SubName {
  return SUBS.has(s)
}

export function routeProposals(rawArgs: string[]): ProposalsRoute {
  const sub = rawArgs[0]
  // Legacy quirk fixed (ledger class 6): `skvm proposals --help` used to fall
  // through to "Unknown proposals subcommand: --help"; flag-ONLY invocations
  // now get the overview. A flag in the sub position followed by non-flag
  // args (`proposals --no-color list`) is NOT flag-only — that stays the
  // legacy loud unknown-subcommand failure below.
  if (!sub || sub === "help" || rawArgs.every((a) => a.startsWith("--"))) return { kind: "overview" }
  if (!isSubName(sub)) return { kind: "unknown", sub }
  const rest = rawArgs.slice(1)
  return {
    kind: "sub",
    sub,
    id: rest.find((a) => !a.startsWith("--")),
    argv: rest,
  }
}

/**
 * list/report/serve take no positional — a stray one (e.g. `serve 8080`,
 * where the user meant `--port=8080`) used to be silently ignored (legacy
 * parity); it is now a usage error. Id-taking subs keep ignoring EXTRA
 * positionals beyond their `<id>` (the router only extracts the first).
 * Called before parseOrExit so, like unknown flags, a stray positional beats
 * --help (the layer's errors-beat-help convention).
 */
function rejectStrayPositional(
  route: Extract<ProposalsRoute, { kind: "sub" }>,
  buildHelp: () => string,
): void {
  if (route.id !== undefined) {
    throw new UsageError(`proposals ${route.sub}: unexpected argument "${route.id}"`, buildHelp)
  }
}

export async function runProposals(rawArgs: string[]): Promise<void> {
  const route = routeProposals(rawArgs)
  if (route.kind === "overview") {
    printProposalsOverview()
    return
  }
  if (route.kind === "unknown") {
    console.error(`Unknown proposals subcommand: ${route.sub}`)
    process.exit(1)
  }
  try {
    switch (route.sub) {
      case "list":
        rejectStrayPositional(route, PROPOSALS_LIST_FLAGS.help)
        return await runProposalsList(parseOrExit(PROPOSALS_LIST_FLAGS, route.argv))
      case "show":   return await runProposalsShow(parseOrExit(PROPOSALS_SHOW_FLAGS, route.argv), route.id)
      case "diff":   return await runProposalsDiff(parseOrExit(PROPOSALS_DIFF_FLAGS, route.argv), route.id)
      case "report":
        rejectStrayPositional(route, PROPOSALS_REPORT_FLAGS.help)
        return await runProposalsReport(parseOrExit(PROPOSALS_REPORT_FLAGS, route.argv))
      case "serve":
        rejectStrayPositional(route, PROPOSALS_SERVE_FLAGS.help)
        return await runProposalsServe(parseOrExit(PROPOSALS_SERVE_FLAGS, route.argv))
      case "accept": return await runProposalsAccept(parseOrExit(PROPOSALS_ACCEPT_FLAGS, route.argv), route.id)
      case "reject": return await runProposalsReject(parseOrExit(PROPOSALS_REJECT_FLAGS, route.argv), route.id)
      case "cancel": return await runProposalsCancel(parseOrExit(PROPOSALS_CANCEL_FLAGS, route.argv), route.id)
    }
  } catch (err) {
    exitOnUsageError(err) // same exit path runOrExit gives other commands
  }
}

/**
 * Hand-written top-level overview — verbatim the legacy `skvm proposals` help
 * block, plus the trailing pointer at the per-sub generated help. The caller
 * (src/index.ts main) exits 0 after runProposals returns.
 */
function printProposalsOverview(): void {
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

Proposals root: $SKVM_PROPOSALS_DIR or ~/.skvm/proposals by default.
Use 'skvm proposals <sub> --help' for per-subcommand flags.`)
}

// ---------------------------------------------------------------------------
// Per-sub handlers
// ---------------------------------------------------------------------------

export async function runProposalsList(config: ProposalsListConfig): Promise<void> {
  const { listProposals, loadProposal } = await import("../proposals/storage.ts")
  const items = await listProposals({
    harness: config.harness,
    targetModel: config["target-model"],
    skillName: config.skill,
    status: config.status,
  })
  if (items.length === 0) {
    console.log("No proposals found.")
    return
  }
  const {
    buildRow, sortRows, filterByMinDelta, renderTable,
    aggregate, renderGroupTable,
  } = await import("../proposals/list-format.ts")
  const color = shouldUseColor({ noColor: config["no-color"] })

  const loaded = await Promise.all(items.map((s) => loadProposal(s.id)))
  let rows = loaded.map(buildRow)

  if (config["min-delta"] !== undefined) rows = filterByMinDelta(rows, config["min-delta"])

  rows = sortRows(rows, config.sort)

  if (config["group-by"]) {
    const groups = aggregate(rows, config["group-by"])
    console.log(renderGroupTable(groups, config["group-by"], { color }))
    return
  }

  console.log(renderTable(rows, { color }))
}

export async function runProposalsShow(config: ProposalsShowConfig, id: string | undefined): Promise<void> {
  if (!id) throw new UsageError("Usage: skvm proposals show <id> [--round=N]", PROPOSALS_SHOW_FLAGS.help)
  const { loadProposal, proposalDirFromId } = await import("../proposals/storage.ts")
  const p = await loadProposal(id)
  const proposalDir = proposalDirFromId(id)

  // --round=<n> dispatches to the per-round inspector — the durable evidence
  // record + optimizer step record introduced with schemaVersion=1. Output
  // is markdown so the same machinery prints cleanly to a terminal or
  // pipes to a viewer.
  if (config.round !== undefined) {
    const { renderRoundShow } = await import("../proposals/round-show.ts")
    const result = await renderRoundShow(proposalDir, config.round)
    console.log(result.text)
    return
  }
  const { renderShowSummary, formatRunPhaseLine } = await import("../proposals/list-format.ts")
  const { selfHealRunStatus } = await import("../jit-optimize/run-status.ts")
  const color = shouldUseColor({ noColor: config["no-color"] })

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
  if (config.full) {
    console.log("")
    console.log("--- analysis.md ---")
    console.log(p.analysis)
  }
  // Tail run.log when the worker is mid-flight or has failed — gives
  // the reader recent context that the structured fields above can't
  // (current-round progress, the error's surrounding log lines).
  // Skipped on done because finalized meta + rounds table already cover it.
  if (run !== null && (run.phase === "running" || run.phase === "failed")) {
    const { readLastLines } = await import("../core/fs-utils.ts")
    const pathMod = await import("node:path")
    const tail = await readLastLines(pathMod.join(proposalDir, "run.log"), 20)
    if (tail !== null) {
      console.log("")
      console.log(`--- run.log (last 20 lines) ---`)
      console.log(tail)
    }
  }
}

export async function runProposalsDiff(config: ProposalsDiffConfig, id: string | undefined): Promise<void> {
  if (!id) throw new UsageError("Usage: skvm proposals diff <id> [--round=N]", PROPOSALS_DIFF_FLAGS.help)
  const { loadProposal, proposalDirFromId } = await import("../proposals/storage.ts")
  const p = await loadProposal(id)
  const round = config.round ?? p.meta.bestRound
  if (round === 0) {
    console.log("(round-0 is the baseline — no diff against original)")
    return
  }
  const { diffProposalRound } = await import("../proposals/diff.ts")
  const result = await diffProposalRound(proposalDirFromId(id), round)
  if (!result.ok) {
    // Not a UsageError: environment state (missing round dir), not flag shape.
    console.error(result.reason)
    process.exit(1)
  }
  process.stdout.write(result.unified)
}

export async function runProposalsReport(config: ProposalsReportConfig): Promise<void> {
  const { listProposals, loadProposal } = await import("../proposals/storage.ts")
  // Legacy parity quirk preserved: --sort / --min-delta / --group-by are
  // accepted (they were in report's allow-set) but the handler has never
  // consumed them — the HTML report orders proposals itself.
  const items = await listProposals({
    harness: config.harness,
    targetModel: config["target-model"],
    skillName: config.skill,
    status: config.status,
  })
  if (items.length === 0) {
    console.log("No proposals found — nothing to report.")
    return
  }
  const loaded = await Promise.all(items.map((s) => loadProposal(s.id)))
  const { generateReport } = await import("../proposals/report.ts")
  const html = await generateReport(loaded)
  const { JIT_OPTIMIZE_DIR } = await import("../core/config.ts")
  const pathMod = await import("node:path")
  const outPath = config.out ?? pathMod.join(JIT_OPTIMIZE_DIR, "report.html")
  await Bun.write(outPath, html)
  console.log(`Wrote ${items.length}-proposal report → ${outPath}`)
}

export async function runProposalsServe(config: ProposalsServeConfig): Promise<void> {
  const { startServer } = await import("../proposals/serve.ts")
  const server = startServer({ port: config.port, host: config.host })
  console.log(`SkVM proposals review server listening on ${server.url}`)
  console.log(`  Press Ctrl+C to stop.`)
  if (!config["no-open"]) {
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
}

export async function runProposalsAccept(config: ProposalsAcceptConfig, id: string | undefined): Promise<void> {
  if (!id) throw new UsageError("Usage: skvm proposals accept <id>", PROPOSALS_ACCEPT_FLAGS.help)
  const { deployProposal } = await import("../proposals/deploy.ts")
  const r = await deployProposal(id, { targetDir: config.target, round: config.round })
  console.log(`Accepted ${id} (round ${r.deployedRound})`)
  console.log(`  Deployed ${r.filesDeployed.length} file(s) → ${r.targetDir}`)
  if (r.filesBackedUp.length > 0) {
    console.log(`  Backed up ${r.filesBackedUp.length} existing file(s):`)
    for (const f of r.filesBackedUp) console.log(`    ${f}`)
  }
}

export async function runProposalsReject(config: ProposalsRejectConfig, id: string | undefined): Promise<void> {
  if (!id) throw new UsageError("Usage: skvm proposals reject <id>", PROPOSALS_REJECT_FLAGS.help)
  const { updateStatus } = await import("../proposals/storage.ts")
  await updateStatus(id, "rejected")
  console.log(`Rejected ${id}`)
}

export async function runProposalsCancel(config: ProposalsCancelConfig, id: string | undefined): Promise<void> {
  if (!id) throw new UsageError("Usage: skvm proposals cancel <id>", PROPOSALS_CANCEL_FLAGS.help)
  const { proposalDirFromId } = await import("../proposals/storage.ts")
  const proposalDir = proposalDirFromId(id)
  const { readRunStatus, patchRunStatus } = await import("../jit-optimize/run-status.ts")
  const { isPidAlive } = await import("../core/file-lock.ts")

  const status = await readRunStatus(proposalDir)
  if (status === null) {
    // Not a UsageError: environment state (run-status/pid), not flag shape.
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
}
