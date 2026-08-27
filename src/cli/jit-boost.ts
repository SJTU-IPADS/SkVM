/**
 * `skvm jit-boost` — code-solidification toolchain.
 *
 * Two sub-actions, routed on argv[0] like `skvm proposals`:
 *   compile  AOT-generate boost candidates from a skill directory
 *   run      drive a case spec (varying prompts per case) with solidification
 *            hooks, emitting one CSV row per invocation for downstream
 *            analysis
 *
 * Unknown actions and handler-level usage problems throw UsageError; the
 * src/index.ts case routes them through exitOnUsageError so they share the
 * message-to-stderr / exit-1 path of every other subcommand.
 */

import path from "node:path"
import { defineFlags, parseOrExit, UsageError, type ConfigOf } from "./flags.ts"

export const JIT_BOOST_COMPILE_FLAGS = defineFlags(
  "jit-boost compile",
  "AOT-generate boost candidates for a skill (writes proposals/jit-boost/{skillId}/boost-candidates.json)",
  {
    skill: {
      kind: "string",
      required: true,
      placeholder: "<dir>",
      help: "Skill directory containing SKILL.md",
    },
    model: {
      kind: "string",
      placeholder: "<id>",
      help: "Compiler model, shaped as <provider>/<model-id> (default: anthropic/claude-opus-4.6)",
    },
    "timeout-ms": { kind: "int", min: 1, placeholder: "<n>", help: "Candidate-generation timeout override" },
  },
  { usage: ["skvm jit-boost compile --skill=<dir> [--model=<id>]"] },
)

export type JitBoostCompileConfig = ConfigOf<typeof JIT_BOOST_COMPILE_FLAGS>

export const JIT_BOOST_RUN_FLAGS = defineFlags(
  "jit-boost run",
  "Run solidification cases (varying prompts per case) and emit a per-invocation CSV",
  {
    cases: {
      kind: "string",
      required: true,
      placeholder: "<file>",
      help: "Case spec JSON: { cases: [{ id, purposeId, skill, prompts[], fixturesDir? }] }",
    },
    model: {
      kind: "string",
      required: true,
      placeholder: "<id>",
      help: "Runtime model, shaped as <provider>/<model-id>",
    },
    adapter: {
      kind: "enum",
      values: ["bare-agent"],
      default: "bare-agent",
      placeholder: "<name>",
      help: "Agent adapter (only hook-capable adapters: bare-agent)",
    },
    invocations: { kind: "int", min: 1, placeholder: "<n>", help: "Cap invocations per case (default: all prompts)" },
    "promotion-threshold": { kind: "int", min: 1, default: 3, placeholder: "<n>", help: "Matched runs required to promote" },
    "demotion-threshold": { kind: "int", min: 1, default: 3, placeholder: "<n>", help: "Failed executions before demotion" },
    "match-granularity": {
      kind: "enum",
      values: ["run", "tool-call"],
      default: "run",
      placeholder: "<g>",
      help: "Signature-match counting: once per run or per tool call",
    },
    "extract-model": {
      kind: "string",
      placeholder: "<id>",
      help: "Optional LLM for param extraction; unset = regex-only (served rows stay 0-token)",
    },
    out: { kind: "string", placeholder: "<file>", help: "CSV output path (default: ./jit-boost-<safeModel>.csv)" },
    "json-out": { kind: "string", placeholder: "<file>", help: "Optional JSON detail output (records + per-case summary)" },
    "timeout-ms": { kind: "int", min: 1, placeholder: "<n>", help: "Per-invocation adapter timeout" },
    "max-steps": { kind: "int", min: 1, placeholder: "<n>", help: "Per-invocation agent-loop step cap" },
    "keep-workdirs": { kind: "bool", help: "Keep per-invocation work directories for debugging" },
    "online-refine": { kind: "bool", help: "Rewrite a repeatedly-missing candidate from observed runtime behavior (promotion re-earned from zero)" },
    "refine-model": { kind: "string", placeholder: "<id>", help: "Model for the refinement rewrite (default: anthropic/claude-sonnet-4.6)" },
    "refine-after-misses": { kind: "int", min: 1, default: 3, placeholder: "<n>", help: "Total missed runs before a refinement attempt" },
    "max-refines": { kind: "int", min: 1, default: 1, placeholder: "<n>", help: "Maximum refinements per case" },
    "retro-promote": { kind: "bool", help: "Credit the refined signature's coverage of observed runs toward promotion (immediate promote if it covers the last N runs)" },
  },
  { usage: ["skvm jit-boost run --cases=<file> --model=<id> [options]"] },
)

export type JitBoostRunConfig = ConfigOf<typeof JIT_BOOST_RUN_FLAGS>

export async function runJitBoostCompile(config: JitBoostCompileConfig): Promise<void> {
  const { loadSkill } = await import("../core/skill-loader.ts")
  const skill = await loadSkill(path.resolve(config.skill))

  const { getJitBoostDir } = await import("../proposals/storage.ts")
  const outputDir = getJitBoostDir(skill.skillId)

  const { generateBoostCandidates } = await import("../jit-boost/candidates.ts")
  const result = await generateBoostCandidates(skill.skillDir, outputDir, {
    model: config.model || undefined,
    timeoutMs: config["timeout-ms"],
  })

  console.log(`\n=== jit-boost compile ===`)
  console.log(`Skill: ${skill.skillId} (${skill.skillDir})`)
  console.log(`Candidates: ${result.candidates.length} (cost=$${result.cost.toFixed(4)})`)
  for (const c of result.candidates) {
    console.log(`  - ${c.purposeId} [${c.materializationType}] keywords=${c.keywords.join("/")}`)
  }
  console.log(`Written to: ${path.join(outputDir, "boost-candidates.json")}`)
}

export async function runJitBoostRun(config: JitBoostRunConfig): Promise<void> {
  // Miss observations are collected and folded per run (finalizeRun); under
  // tool-call granularity that never happens, so refinement would silently
  // never trigger.
  if (config["online-refine"] && config["match-granularity"] !== "run") {
    throw new UsageError(
      "jit-boost run: --online-refine requires --match-granularity=run (miss observations are folded per run)",
      JIT_BOOST_RUN_FLAGS.help,
    )
  }
  // The converse: every refinement knob is read only inside the online-refine
  // branch, so passing one without it is a silent no-op — the run completes and
  // the flag did nothing, which is exactly the shape a scripted sweep cannot
  // notice.
  if (!config["online-refine"]) {
    // Detected by value rather than by "was it typed": a flag left at its
    // default is indistinguishable from an unset one here, which is fine — the
    // point is to catch a value the user chose and would never see applied.
    const dependent: string[] = []
    if (config["refine-model"]) dependent.push("--refine-model")
    if (config["refine-after-misses"] !== 3) dependent.push("--refine-after-misses")
    if (config["max-refines"] !== 1) dependent.push("--max-refines")
    if (config["retro-promote"]) dependent.push("--retro-promote")
    if (dependent.length > 0) {
      throw new UsageError(
        `jit-boost run: ${dependent.join(", ")} ` +
        `${dependent.length > 1 ? "have" : "has"} no effect without --online-refine`,
        JIT_BOOST_RUN_FLAGS.help,
      )
    }
  }
  const casesPath = path.resolve(config.cases)
  if (!(await Bun.file(casesPath).exists())) {
    throw new UsageError(`jit-boost run: cases file not found: ${casesPath}`, JIT_BOOST_RUN_FLAGS.help)
  }

  const { createAdapter } = await import("../adapters/registry.ts")
  const adapter = createAdapter(config.adapter)

  const { runSolidifyExperiment, invocationRecordsToCsv } = await import("../jit-boost/experiment.ts")
  const { records, refinements, failures } = await runSolidifyExperiment({
    specPath: casesPath,
    model: config.model,
    adapter,
    invocations: config.invocations,
    promotionThreshold: config["promotion-threshold"],
    demotionThreshold: config["demotion-threshold"],
    matchGranularity: config["match-granularity"],
    extractModel: config["extract-model"] || undefined,
    timeoutMs: config["timeout-ms"],
    maxSteps: config["max-steps"],
    keepWorkDirs: config["keep-workdirs"],
    onlineRefine: config["online-refine"],
    refineModel: config["refine-model"] || undefined,
    refineAfterMisses: config["refine-after-misses"],
    maxRefines: config["max-refines"],
    retroPromote: config["retro-promote"],
  })

  const { safeModelName } = await import("../core/config.ts")
  const outPath = path.resolve(config.out || `jit-boost-${safeModelName(config.model)}.csv`)
  await Bun.write(outPath, invocationRecordsToCsv(records))

  if (config["json-out"]) {
    await Bun.write(path.resolve(config["json-out"]), JSON.stringify({ model: config.model, records, refinements }, null, 2))
  }

  console.log(`\n=== jit-boost run ===`)
  const byCase = new Map<string, typeof records>()
  for (const r of records) {
    if (!byCase.has(r.case)) byCase.set(r.case, [])
    byCase.get(r.case)!.push(r)
  }
  for (const [caseId, rows] of byCase) {
    const firstJit = rows.find((r) => r.method === "JIT")
    const firstPromoted = rows.find((r) => r.promoted)
    const refined = refinements.find((e) => e.case === caseId)
    const status = firstJit
      ? `solidified at invocation ${firstJit.invocation}`
      : firstPromoted
        ? `promoted at invocation ${firstPromoted.invocation} but never served (param extraction or template execution failed)`
        : "not promoted"
    const refineNote = refined ? ` (candidate refined after invocation ${refined.invocation})` : ""
    console.log(`  ${caseId}: ${rows.length} invocations, ${status}${refineNote}`)
  }
  console.log(`CSV: ${outPath}`)

  // Scriptability: non-ok invocations poison the data — signal via exit code.
  // Post-side-effect failure: the CSV is already written (partial data is
  // still useful for diagnosis), so console.error + exit(1) instead of UsageError.
  const bad = records.filter((r) => r.runStatus !== "ok")
  if (failures.length > 0) {
    for (const f of failures) console.error(`ERROR: case "${f.case}" did not complete: ${f.error}`)
    console.error(`WARNING: ${failures.length} case(s) failed — the CSV covers only the cases that finished`)
  }
  if (bad.length > 0) {
    console.error(`WARNING: ${bad.length} invocation(s) had runStatus != ok — CSV rows are tainted`)
  }
  if (bad.length > 0 || failures.length > 0) process.exit(1)
}

/**
 * Route `skvm jit-boost <action>`. Bare / --help / flag-only invocations get
 * the overview; unknown actions throw UsageError (the src/index.ts case sends
 * it through exitOnUsageError).
 */
export async function runJitBoost(args: string[]): Promise<void> {
  const action = args[0]
  if (!action || action === "help" || args.every((a) => a.startsWith("--"))) {
    printJitBoostOverview()
    return
  }
  const rest = args.slice(1)
  switch (action) {
    case "compile":
      await runJitBoostCompile(parseOrExit(JIT_BOOST_COMPILE_FLAGS, rest))
      break
    case "run":
      await runJitBoostRun(parseOrExit(JIT_BOOST_RUN_FLAGS, rest))
      break
    default:
      throw new UsageError(
        `jit-boost: unknown action "${action}". Valid: compile, run`,
        JIT_BOOST_RUN_FLAGS.help,
      )
  }
}

/**
 * Overview for a bare `skvm jit-boost`. The per-action option lists come from
 * the flag definitions rather than being restated here — the hand-written
 * version had already drifted, omitting every refinement flag.
 */
function printJitBoostOverview(): void {
  console.log(`skvm jit-boost - Code solidification: compile boost candidates, run invocation-sequence cases

Actions:
  skvm jit-boost compile   Generate boost candidates for a skill
  skvm jit-boost run       Drive an invocation sequence with solidification hooks

${JIT_BOOST_COMPILE_FLAGS.help()}

${JIT_BOOST_RUN_FLAGS.help()}`)
}
