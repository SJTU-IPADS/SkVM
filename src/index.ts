#!/usr/bin/env bun

import "./core/env-bootstrap.ts"
import { setLogLevel, c, shouldUseColor } from "./core/logger.ts"
import { createProgressSpinner, spinnerLog } from "./core/spinner.ts"
import { ALL_ADAPTERS, type AdapterName, createAdapter, isAdapterName } from "./adapters/registry.ts"
import { resolveAdapterConfigMode } from "./core/config.ts"
import { assertKnownFlags } from "./core/cli-flags.ts"
import { runOrExit } from "./cli/flags.ts"
import { CLI_DEFAULTS, MODEL_DEFAULTS } from "./core/ui-defaults.ts"
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
    case "aot-compile":
      await runCompile(flags)
      break
    case "run": {
      const { RUN_FLAGS, runRun } = await import("./cli/run.ts")
      await runOrExit(RUN_FLAGS, args.slice(1), runRun)
      break
    }
    case "pipeline":
      await runPipeline(flags)
      break
    case "bench":
      await runBenchCmd(flags)
      break
    case "jit-optimize": {
      const { JIT_OPTIMIZE_FLAGS, runJitOptimize } = await import("./cli/jit-optimize.ts")
      await runOrExit(JIT_OPTIMIZE_FLAGS, args.slice(1), runJitOptimize)
      break
    }
    case "proposals":
      await runProposals(args.slice(1))
      break
    case "clean-jit":
      await runCleanJIT(flags)
      break
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

const COMPILE_KNOWN_FLAGS: ReadonlySet<string> = new Set([
  "skill",
  "model",
  "adapter",
  "profile",
  "pass",
  "list-passes",
  "concurrency",
  "dry-run",
  "compiler-model",
  "timeout-ms",
])

async function runCompile(flags: Record<string, string>) {
  assertKnownFlags("aot-compile", flags, COMPILE_KNOWN_FLAGS)
  if (flags.help === "true") {
    console.log(`skvm aot-compile - AOT-compile skill(s) for target model(s)

Usage:
  skvm aot-compile --skill=<id,...> --model=<id,...> [options]

Options:
  --skill=<id,...>      Skill name(s) or path(s), comma-separated (required)
  --model=<id,...>      Target model(s), comma-separated (required)
  --adapter=<name,...>  Harness name(s), comma-separated (${ALL_ADAPTERS.join(" | ")}; default: ${CLI_DEFAULTS.adapter})
  --profile=<path>      Path to TCP JSON (single-job only; default: load from cache)
  --pass=<list>         Compiler passes, comma-separated (numeric or string ids; see --list-passes for the registry). Default: ${CLI_DEFAULTS.compilerPasses.join(",")}
  --list-passes         Print the pass registry and exit
  --concurrency=<n>     Parallel compilations (default: ${CLI_DEFAULTS.concurrency})
  --dry-run             Show plan without applying
  --compiler-model=<id> Compiler model via OpenRouter (default: ${MODEL_DEFAULTS.compiler})
  --timeout-ms=<n>      Cap on the compiler agent loop (Pass 1, rewrite-skill)
                        while it edits SKILL.md (ms). Default: ${TIMEOUT_DEFAULTS.compiler}.`)
    process.exit(0)
  }

  if (flags["list-passes"] === "true") {
    const { formatRegistry } = await import("./compiler/registry.ts")
    console.log(formatRegistry())
    process.exit(0)
  }

  let cliCompilerTimeoutMs: number | undefined
  if (flags["timeout-ms"] !== undefined) {
    const n = parseInt(flags["timeout-ms"], 10)
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`aot-compile: --timeout-ms must be a positive integer (got "${flags["timeout-ms"]}")`)
      process.exit(1)
    }
    cliCompilerTimeoutMs = n
  }

  if (!flags.skill || !flags.model) {
    console.error("--skill and --model are required")
    process.exit(1)
  }

  const skillInputs = flags.skill.split(",").map(s => s.trim())
  const models = flags.model.split(",").map(m => m.trim())
  const adapters = (flags.adapter ?? CLI_DEFAULTS.adapter).split(",").map(a => a.trim())
  const passes: string[] = flags.pass
    ? flags.pass.split(",").map((p) => p.trim()).filter(Boolean)
    : CLI_DEFAULTS.compilerPasses.map(String)
  const concurrency = flags.concurrency ? parseInt(flags.concurrency) : CLI_DEFAULTS.concurrency
  const dryRun = flags["dry-run"] === "true"

  for (const a of adapters) {
    if (!isAdapterName(a)) {
      console.error(`Invalid adapter: ${a}. Valid: ${ALL_ADAPTERS.join(", ")}`)
      process.exit(1)
    }
  }

  const compilerModel = flags["compiler-model"] ?? MODEL_DEFAULTS.compiler
  {
    const { printBanner, describeModelRoute, describeAdapter, shortenPath } = await import("./core/banner.ts")
    const { SKVM_CACHE, AOT_COMPILE_DIR } = await import("./core/config.ts")
    printBanner("aot-compile", [
      ["Adapter", adapters.map(a => describeAdapter(a)).join(", ")],
      ["Model", models.map(m => describeModelRoute(m)).join(", ")],
      ["Compiler", describeModelRoute(compilerModel)],
      ["Skill", skillInputs.join(", ")],
      ["Cache", shortenPath(SKVM_CACHE)],
      ["Output", shortenPath(AOT_COMPILE_DIR)],
    ])
  }

  // ---------------------------------------------------------------------------
  // Resolve skills: each input is a path (skill directory or SKILL.md file).
  // Bare skill names were previously looked up in a registry; now the caller
  // must hand us a path.
  // ---------------------------------------------------------------------------
  const { loadSkill: loadSkillFromPath } = await import("./core/skill-loader.ts")

  type CompileSkill = { name: string; skillPath: string; skillDir: string; skillContent: string }
  const resolvedSkills: CompileSkill[] = []

  for (const input of skillInputs) {
    try {
      const loaded = await loadSkillFromPath(input)
      resolvedSkills.push({
        name: loaded.skillId,
        skillPath: loaded.skillPath,
        skillDir: loaded.skillDir,
        skillContent: loaded.skillContent,
      })
    } catch (err) {
      console.error(`Skill not found: ${input} — ${err instanceof Error ? err.message : err}`)
      process.exit(1)
    }
  }

  // ---------------------------------------------------------------------------
  // Load and validate profiles for all (model, adapter) combos
  // ---------------------------------------------------------------------------
  const { loadProfile } = await import("./profiler/index.ts")
  type TCP = import("./core/types.ts").TCP
  const tcpCache = new Map<string, TCP>()

  if (flags.profile) {
    // Explicit --profile only for single-job mode
    if (models.length > 1 || adapters.length > 1) {
      console.error("--profile flag only supported for single model + single adapter")
      process.exit(1)
    }
    const { TCPSchema } = await import("./core/types.ts")
    const profileData = await Bun.file(flags.profile).json()
    tcpCache.set(`${models[0]}--${adapters[0]}`, TCPSchema.parse(profileData))
  } else {
    const missing: string[] = []
    for (const adapter of adapters) {
      for (const model of models) {
        const key = `${model}--${adapter}`
        const tcp = await loadProfile(model, adapter)
        if (!tcp) {
          missing.push(key)
        } else {
          tcpCache.set(key, tcp)
        }
      }
    }
    if (missing.length > 0) {
      console.error(`Missing profiles:\n${missing.map(m => `  ${m}`).join("\n")}`)
      console.error(`Run 'skvm profile' first.`)
      process.exit(1)
    }
  }

  // ---------------------------------------------------------------------------
  // Build job matrix: skills × models × adapters
  // ---------------------------------------------------------------------------
  type CompileJob = { skill: typeof resolvedSkills[number]; model: string; adapter: string; tcp: TCP }
  const jobs: CompileJob[] = []
  for (const skill of resolvedSkills) {
    for (const adapter of adapters) {
      for (const model of models) {
        jobs.push({ skill, model, adapter, tcp: tcpCache.get(`${model}--${adapter}`)! })
      }
    }
  }

  console.log(`\nCompile: ${resolvedSkills.length} skill(s) × ${models.length} model(s) × ${adapters.length} adapter(s) = ${jobs.length} job(s), concurrency=${concurrency}\n`)

  if (jobs.length === 0) return

  const { RunSession, shortModel: shortModelName } = await import("./core/run-session.ts")
  const { getCompileLogDir } = await import("./core/config.ts")
  const skillNames = resolvedSkills.map(s => s.name).join("+")
  const compileSession = await RunSession.start({
    type: "aot-compile",
    tag: `${adapters[0]}-${shortModelName(models[0]!)}-${skillNames}`,
    logDir: getCompileLogDir(adapters[0]!, models[0]!, resolvedSkills[0]!.name),
    models,
    harness: adapters.join(","),
    skill: skillNames,
  })

  // ---------------------------------------------------------------------------
  // Create shared provider and run jobs
  // ---------------------------------------------------------------------------
  const { createProviderForModel } = await import("./providers/registry.ts")
  const provider = createProviderForModel(compilerModel)
  const { compileSkill, writeVariant } = await import("./compiler/index.ts")
  const { createSlotPool } = await import("./core/concurrency.ts")

  type JobResult = { skill: string; model: string; adapter: string; gaps: number; guard: boolean; durationMs: number; error?: string }
  const results: JobResult[] = []
  let completed = 0
  const isMultiJob = jobs.length > 1

  const pool = createSlotPool(concurrency)
  const compileProgress = isMultiJob
    ? createProgressSpinner("Compiling", jobs.length)
    : { tick() {}, stop() {} }

  await Promise.allSettled(jobs.map(async (job) => {
    const slot = await pool.acquire()
    try {
      const label = `${job.skill.name} × ${job.model} × ${job.adapter}`
      const result = await compileSkill({
        skillPath: job.skill.skillPath,
        skillDir: job.skill.skillDir,
        skillContent: job.skill.skillContent,
        tcp: job.tcp,
        model: job.model,
        harness: job.adapter,
        passes,
        dryRun,
        timeoutMs: cliCompilerTimeoutMs,
      }, provider, { showSpinner: !isMultiJob })

      if (!dryRun) {
        await writeVariant(result)
      }

      completed++
      const guardStr = result.guardPassed ? "PASS" : "FAIL"
      const gapCount = result.artifacts.gaps?.length ?? 0
      spinnerLog(`  [${completed}/${jobs.length}] ${label}: ${gapCount} gaps, guard=${guardStr}, ${(result.durationMs / 1000).toFixed(1)}s`)
      compileProgress.tick(`Compiled ${jobs.length} job(s)`)

      results.push({
        skill: job.skill.name, model: job.model, adapter: job.adapter,
        gaps: gapCount, guard: result.guardPassed, durationMs: result.durationMs,
      })
    } catch (err) {
      completed++
      const msg = err instanceof Error ? err.message : String(err)
      spinnerLog(c.red(`  [${completed}/${jobs.length}] ${job.skill.name} × ${job.model} × ${job.adapter}: FAILED: ${msg.slice(0, 200)}`))
      compileProgress.tick()
      results.push({
        skill: job.skill.name, model: job.model, adapter: job.adapter,
        gaps: 0, guard: false, durationMs: 0, error: msg,
      })
    } finally {
      pool.release(slot)
    }
  }))
  compileProgress.stop()

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  const compileFailures = results.filter(r => r.error)
  if (jobs.length > 1) {
    const guardFails = results.filter(r => !r.error && !r.guard)
    console.log(`\n=== Compile Summary ===`)
    console.log(`Total: ${jobs.length}, Completed: ${results.length - compileFailures.length}, Failed: ${compileFailures.length}, Guard failures: ${guardFails.length}`)
    if (compileFailures.length > 0) {
      console.log(`\nFailures:`)
      for (const f of compileFailures) console.log(`  ${f.skill} × ${f.model} × ${f.adapter}: ${f.error!.slice(0, 150)}`)
    }
  }

  if (compileFailures.length > 0) {
    await compileSession.fail(`${compileFailures.length}/${jobs.length} failed`)
  } else {
    await compileSession.complete(`${jobs.length} job(s) compiled`)
  }
}

const PIPELINE_KNOWN_FLAGS: ReadonlySet<string> = new Set([
  "skill",
  "model",
  "adapter",
  "force-profile",
  "profile",
  "pass",
  "compiler-model",
  "dry-run",
  "adapter-config",
  "timeout-ms",
])

async function runPipeline(flags: Record<string, string>) {
  assertKnownFlags("pipeline", flags, PIPELINE_KNOWN_FLAGS)
  if (flags.help === "true") {
    console.log(`skvm pipeline - Profile (if needed) then compile a skill for a target model

Usage:
  skvm pipeline --skill=<path> --model=<id> [options]

Options:
  --skill=<path>          Path to skill directory or SKILL.md (required)
  --model=<id>            Target model (required)
  --adapter=<name>        Harness: ${ALL_ADAPTERS.join(" | ")} (default: ${CLI_DEFAULTS.adapter})
  --force-profile         Re-profile even if cached
  --profile=<path>        Use specific TCP file (skip auto-profiling)
  --pass=<list>           Compiler passes, comma-separated (default: ${CLI_DEFAULTS.compilerPasses.join(",")})
  --compiler-model=<id>   Compiler model via OpenRouter (default: ${MODEL_DEFAULTS.compiler})
  --dry-run               Show compilation plan without writing
  --timeout-ms=<n>        Per-agent-loop ceiling for this pipeline run (ms).
                          Applies to BOTH the profile stage's per-probe agent
                          execution AND the compiler agent loop. Each is timed
                          independently — this is a per-loop ceiling, not a
                          total wall time.
                          Default: ${TIMEOUT_DEFAULTS.taskExec} for profile,
                          ${TIMEOUT_DEFAULTS.compiler} for compiler.`)
    process.exit(0)
  }

  let cliPipelineTimeoutMs: number | undefined
  if (flags["timeout-ms"] !== undefined) {
    const n = parseInt(flags["timeout-ms"], 10)
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`pipeline: --timeout-ms must be a positive integer (got "${flags["timeout-ms"]}")`)
      process.exit(1)
    }
    cliPipelineTimeoutMs = n
  }

  const skillPath = flags.skill
  const model = flags.model
  if (!skillPath || !model) {
    console.error("--skill and --model are required")
    process.exit(1)
  }

  const harnessStr = flags.adapter ?? CLI_DEFAULTS.adapter
  if (!isAdapterName(harnessStr)) {
    console.error(`Invalid adapter: ${harnessStr}. Valid: ${ALL_ADAPTERS.join(", ")}`)
    process.exit(1)
  }
  const harness: AdapterName = harnessStr

  const passes: string[] = flags.pass
    ? flags.pass.split(",").map((p) => p.trim()).filter(Boolean)
    : CLI_DEFAULTS.compilerPasses.map(String)
  const pipelineCompilerModel = flags["compiler-model"] ?? MODEL_DEFAULTS.compiler

  {
    const { printBanner, describeModelRoute, describeAdapter, shortenPath } = await import("./core/banner.ts")
    const { SKVM_CACHE, AOT_COMPILE_DIR } = await import("./core/config.ts")
    printBanner("pipeline", [
      ["Adapter", describeAdapter(harness)],
      ["Model", describeModelRoute(model)],
      ["Compiler", describeModelRoute(pipelineCompilerModel)],
      ["Skill", skillPath],
      ["Cache", shortenPath(SKVM_CACHE)],
      ["Output", shortenPath(AOT_COMPILE_DIR)],
    ])
  }

  const { RunSession, shortModel: shortModelName } = await import("./core/run-session.ts")
  const { getCompileLogDir } = await import("./core/config.ts")
  const skillName = skillPath.replace(/.*\//, "").replace(/\.md$/, "")
  const pipelineSession = await RunSession.start({
    type: "pipeline",
    tag: `${harness}-${shortModelName(model)}-${skillName}`,
    logDir: getCompileLogDir(harness, model, skillName),
    models: [model],
    harness,
    skill: skillName,
  })

  // -------------------------------------------------------------------------
  // Step 1: Obtain TCP (profile or load from cache)
  // -------------------------------------------------------------------------

  let tcp: import("./core/types.ts").TCP

  if (flags.profile) {
    // Explicit TCP file provided
    console.log(`Loading profile from ${flags.profile}`)
    const profileData = await Bun.file(flags.profile).json()
    const { TCPSchema } = await import("./core/types.ts")
    tcp = TCPSchema.parse(profileData)
    console.log(`  Loaded profile: ${tcp.model} -- ${tcp.harness}`)
  } else {
    // Try cache, then profile if needed
    const { profile, loadProfile } = await import("./profiler/index.ts")
    const forceProfile = flags["force-profile"] === "true"

    const cached = forceProfile ? null : await loadProfile(model, harness)
    if (cached) {
      console.log(`Using cached profile for ${model} -- ${harness}`)
      tcp = cached
    } else {
      console.log(`No cached profile for ${model} -- ${harness}. Profiling...`)

      // Always-on logging
      const { getProfileLogDir } = await import("./core/config.ts")
      const pipelineLogDir = getProfileLogDir(harness, model)
      const { mkdirSync } = await import("node:fs")
      mkdirSync(pipelineLogDir, { recursive: true })
      const logFile = `${pipelineLogDir}/console.log`
      const convLogDir = pipelineLogDir

      const adapter = createAdapter(harness)
      const adapterModePipeline = resolveAdapterConfigMode(flags["adapter-config"])
      tcp = await profile({
        model,
        harness,
        adapter,
        adapterConfig: {
          model,
          maxSteps: 25,
          // Profile probe default harmonizes with task-exec (120s); previously a
          // standalone 300s literal. CLI --timeout-ms wins absolutely; see
          // docs/skvm/2026-05-16-timeout-subsystem.md.
          timeoutMs: cliPipelineTimeoutMs ?? TIMEOUT_DEFAULTS.taskExec,
          mode: adapterModePipeline,
        },
        force: true,
        logFile,
        convLogDir,
      })

      const { printProfileSummary } = await import("./cli/profile.ts")
      printProfileSummary(tcp)
    }
  }

  // -------------------------------------------------------------------------
  // Step 2: Load skill content
  // -------------------------------------------------------------------------

  const pipelineSkillFile = Bun.file(skillPath.endsWith(".md") ? skillPath : `${skillPath}/SKILL.md`)
  if (!(await pipelineSkillFile.exists())) {
    console.error(`Skill not found: ${skillPath}`)
    process.exit(1)
  }
  const skillContent = await pipelineSkillFile.text()

  // -------------------------------------------------------------------------
  // Step 3: Compile
  // -------------------------------------------------------------------------

  console.log(`\nCompiling skill for ${model} -- ${harness}...`)

  const { createProviderForModel: createCompilerProvider } = await import("./providers/registry.ts")
  const provider = createCompilerProvider(pipelineCompilerModel)

  const { dirname: pipelineDirname } = await import("node:path")
  const pipelineSkillDir = skillPath.endsWith(".md") ? pipelineDirname(skillPath) : skillPath

  const { compileSkill, writeVariant } = await import("./compiler/index.ts")
  const result = await compileSkill({
    skillPath,
    skillDir: pipelineSkillDir,
    skillContent,
    tcp,
    model,
    harness,
    passes,
    dryRun: flags["dry-run"] === "true",
    timeoutMs: cliPipelineTimeoutMs,
  }, provider)

  // Print results
  console.log(`\n=== Pipeline Complete: ${result.skillName} for ${result.model}--${result.harness} ===`)
  console.log(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`)
  console.log(`Guard: ${result.guardPassed ? "PASSED" : "FAILED"}`)
  if (result.guardViolations.length > 0) {
    for (const v of result.guardViolations) console.log(`  Violation: ${v}`)
  }
  const scr = result.artifacts.scr
  const gaps = result.artifacts.gaps ?? []
  const deps = result.artifacts.deps ?? []
  const dag = result.artifacts.dag ?? { steps: [], parallelism: [] }
  if (scr) console.log(`SCR: ${scr.purposes.length} purposes`)
  console.log(`Gaps: ${gaps.length}`)
  console.log(`Dependencies: ${deps.length}`)
  console.log(`DAG steps: ${dag.steps.length}`)
  console.log(`Parallelism: ${dag.parallelism.length}`)

  // Write variant
  if (flags["dry-run"] !== "true") {
    const dir = await writeVariant(result)
    console.log(`\nVariant written to: ${dir}`)
  }

  await pipelineSession.complete(`${gaps.length} gaps, guard=${result.guardPassed ? "pass" : "fail"}`)
}

async function runBenchCmd(flags: Record<string, string>) {
  const { runBench } = await import("./bench/index.ts")
  await runBench(flags)
}

const CLEAN_JIT_KNOWN_FLAGS: ReadonlySet<string> = new Set([
  "model",
  "adapter",
  "dry-run",
  "yes",
  "include-bench-logs",
])

async function runCleanJIT(flags: Record<string, string>) {
  assertKnownFlags("clean-jit", flags, CLEAN_JIT_KNOWN_FLAGS)
  if (flags.help === "true") {
    console.log(`skvm clean-jit - Clear persisted JIT artifacts for a model+adapter

Usage:
  skvm clean-jit --model=<id> --adapter=<name> [options]

Required:
  --model=<id>              Model identifier, shaped as <provider>/<model-id>
  --adapter=<name>          Adapter: bare-agent, opencode, openclaw, pi

Options:
  --dry-run                 Show what would be deleted, but do not delete
  --yes                     Confirm deletion (required unless --dry-run)
  --include-bench-logs      Also delete matching logs/bench session folders

Default cleanup targets:
  - ~/.skvm/log/runtime/{adapter}/{safeModel}
  - ~/.skvm/proposals/aot-compile/{adapter}/{safeModel}/**/solidification-state.json

Notes:
  - This command keeps compiled SKILL.md, jit-candidates.json, and profiles intact.
  - It is intended for clean JIT effect testing across repeated bench runs.`)
    process.exit(0)
  }

  const model = flags.model
  const adapterStr = flags.adapter
  const dryRun = flags["dry-run"] === "true"
  const includeBenchLogs = flags["include-bench-logs"] === "true"
  const yes = flags.yes === "true"

  if (!model || !adapterStr) {
    console.error("--model and --adapter are required")
    process.exit(1)
  }
  if (!isAdapterName(adapterStr)) {
    console.error(`Invalid adapter: ${adapterStr}. Valid: ${ALL_ADAPTERS.join(", ")}`)
    process.exit(1)
  }
  const adapter: AdapterName = adapterStr

  const path = await import("node:path")
  const { readdir, rm, stat, unlink } = await import("node:fs/promises")
  const { LOGS_DIR, safeModelName } = await import("./core/config.ts")
  const { getVariantModelDir } = await import("./proposals/storage.ts")

  const runtimeModelDir = path.join(LOGS_DIR, "runtime", adapter, safeModelName(model))
  const compiledModelDir = getVariantModelDir(adapter, model)
  const benchRootDir = path.join(LOGS_DIR, "bench")

  async function pathExists(p: string): Promise<boolean> {
    try {
      await stat(p)
      return true
    } catch {
      return false
    }
  }

  async function collectSolidificationFiles(rootDir: string): Promise<string[]> {
    if (!(await pathExists(rootDir))) return []
    const files: string[] = []
    const stack = [rootDir]

    while (stack.length > 0) {
      const dir = stack.pop()!
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        const entryName = String(entry.name)
        const fullPath = path.join(dir, entryName)
        if (entry.isDirectory()) {
          stack.push(fullPath)
        } else if (entry.isFile() && entryName === "solidification-state.json") {
          files.push(fullPath)
        }
      }
    }

    return files
  }

  async function collectBenchSessions(rootDir: string): Promise<string[]> {
    if (!includeBenchLogs || !(await pathExists(rootDir))) return []
    const matched: string[] = []
    const sessions = await readdir(rootDir, { withFileTypes: true })

    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const sessionDir = path.join(rootDir, session.name)
      const progressFile = path.join(sessionDir, "progress.json")
      if (!(await pathExists(progressFile))) continue
      try {
        const raw = await Bun.file(progressFile).text()
        const progress = JSON.parse(raw) as { model?: string; adapter?: string }
        if (progress.model === model && progress.adapter === adapter) {
          matched.push(sessionDir)
        }
      } catch {
        // Ignore malformed progress files and continue.
      }
    }

    return matched
  }

  const solidificationFiles = await collectSolidificationFiles(compiledModelDir)
  const benchSessionDirs = await collectBenchSessions(benchRootDir)

  const runtimeDirExists = await pathExists(runtimeModelDir)

  console.log(`\n=== clean-jit plan ===`)
  console.log(`Model: ${model}`)
  console.log(`Adapter: ${adapter}`)
  console.log(`Dry run: ${dryRun ? "yes" : "no"}`)
  console.log(`Include bench logs: ${includeBenchLogs ? "yes" : "no"}`)
  console.log(``)
  console.log(`Delete directory: ${runtimeModelDir}${runtimeDirExists ? "" : " (missing)"}`)
  console.log(`Delete files: ${solidificationFiles.length} solidification-state.json`)
  if (includeBenchLogs) {
    console.log(`Delete bench sessions: ${benchSessionDirs.length}`)
  }

  if (dryRun) {
    if (solidificationFiles.length > 0) {
      console.log(`\nsolidification-state targets:`)
      for (const f of solidificationFiles) {
        console.log(`  ${f}`)
      }
    }
    if (includeBenchLogs && benchSessionDirs.length > 0) {
      console.log(`\nbench session targets:`)
      for (const d of benchSessionDirs) {
        console.log(`  ${d}`)
      }
    }
    return
  }

  if (!yes) {
    console.error("\nRefusing to delete without --yes. Re-run with --dry-run first, then add --yes.")
    process.exit(1)
  }

  const errors: string[] = []
  let deletedDirs = 0
  let deletedFiles = 0

  if (runtimeDirExists) {
    try {
      await rm(runtimeModelDir, { recursive: true, force: true })
      deletedDirs++
    } catch (err) {
      errors.push(`Failed to remove ${runtimeModelDir}: ${String(err)}`)
    }
  }

  for (const filePath of solidificationFiles) {
    try {
      await unlink(filePath)
      deletedFiles++
    } catch (err) {
      errors.push(`Failed to remove ${filePath}: ${String(err)}`)
    }
  }

  for (const sessionDir of benchSessionDirs) {
    try {
      await rm(sessionDir, { recursive: true, force: true })
      deletedDirs++
    } catch (err) {
      errors.push(`Failed to remove ${sessionDir}: ${String(err)}`)
    }
  }

  console.log(`\n=== clean-jit result ===`)
  console.log(`Deleted directories: ${deletedDirs}`)
  console.log(`Deleted files: ${deletedFiles}`)
  console.log(`Errors: ${errors.length}`)

  if (errors.length > 0) {
    for (const err of errors) {
      console.error(`  ${err}`)
    }
    process.exit(1)
  }
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
