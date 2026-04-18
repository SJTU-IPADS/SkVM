#!/usr/bin/env bun

import "./core/env-bootstrap.ts"
import { setLogLevel, createLogger, c, shouldUseColor } from "./core/logger.ts"
import { createSpinner, createProgressSpinner, spinnerLog } from "./core/spinner.ts"
import { ALL_ADAPTERS, type AdapterName, createAdapter, isAdapterName } from "./adapters/registry.ts"

const noColor = (s: string) => s
import { CLI_DEFAULTS, MODEL_DEFAULTS } from "./core/ui-defaults.ts"
import pkgJson from "../package.json" with { type: "json" }

const args = process.argv.slice(2)
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
  --verbose                Enable debug logging
  --version, -v            Print version and exit
  --help, -h               Print this help and exit

Use --help with any command for details.`)
    process.exit(0)
  }

  switch (command) {
    case "profile":
      await runProfile(flags)
      break
    case "test":
      console.log("test command not yet implemented")
      break
    case "aot-compile":
      await runCompile(flags)
      break
    case "run":
      await runRun(flags)
      break
    case "pipeline":
      await runPipeline(flags)
      break
    case "bench":
      await runBenchCmd(flags)
      break
    case "jit-optimize":
      await runJitOptimize(flags)
      break
    case "proposals":
      await runProposals(args.slice(1))
      break
    case "clean-jit":
      await runCleanJIT(flags)
      break
    case "logs":
      await runLogs(flags)
      break
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

function printProfileSummary(tcp: import("./core/types.ts").TCP) {
  console.log(`\n=== Profile: ${tcp.model} -- ${tcp.harness} ===`)
  console.log(`Profiled at: ${tcp.profiledAt}`)
  console.log(`Duration: ${(tcp.cost.durationMs / 1000).toFixed(1)}s`)
  console.log(`\nCapabilities:`)

  const levelColors: Record<string, (s: string) => string> = {
    L0: c.red, L1: c.yellow, L2: c.cyan, L3: c.green,
  }

  for (const [id, level] of Object.entries(tcp.capabilities).sort()) {
    const colorFn = levelColors[level] ?? noColor
    console.log(`  ${id.padEnd(25)} ${colorFn(level)}`)
  }
}

async function runProfile(flags: Record<string, string>) {
  if (flags.help === "true") {
    console.log(`skvm profile - Profile a model's primitive capabilities

Usage:
  skvm profile --model=<id> [options]
  skvm profile --batch [options]

Options:
  --model=<id,...>      Model identifier(s), comma-separated (required unless --batch)
  --adapter=<name,...>  Agent adapter(s), comma-separated (default: ${CLI_DEFAULTS.adapter};
                        batch default: all adapters)
  --primitives=<list>   Comma-separated primitive IDs (default: all registered)
  --skip=<list>         Comma-separated primitive IDs to skip
  --instances=<n>       Instances per level (default: ${CLI_DEFAULTS.profileInstances})
  --force               Ignore cached profile, re-run
  --list                List cached profiles
  --batch               Profile all models from bench config
  --concurrency=<n>     Parallel primitives across all model×adapter combos (default: ${CLI_DEFAULTS.concurrency}).
                        Slots are distributed per-adapter then per-model.
  --verbose             Show detailed output`)
    process.exit(0)
  }

  if (flags.list === "true") {
    const { listProfiles } = await import("./profiler/index.ts")
    const profiles = await listProfiles()
    if (profiles.length === 0) {
      console.log("No cached profiles.")
    } else {
      console.log("Cached profiles:")
      for (const p of profiles) {
        console.log(`  ${p.model} -- ${p.harness} (${p.profiledAt})`)
      }
    }
    process.exit(0)
  }

  const primitives = flags.primitives?.split(",")
  const skip = flags.skip?.split(",")
  const instances = flags.instances ? parseInt(flags.instances) : CLI_DEFAULTS.profileInstances
  const force = flags.force === "true"
  const concurrency = flags.concurrency ? parseInt(flags.concurrency) : CLI_DEFAULTS.concurrency

  // Resolve models
  let models: string[]
  if (flags.model) {
    models = flags.model.split(",").map(m => m.trim())
  } else {
    console.error("--model is required. Example: --model=qwen/qwen3-30b-a3b-instruct-2507")
    process.exit(1)
  }

  // Resolve adapters: unified --adapter flag, comma-separated
  let adapters: AdapterName[]
  if (flags.adapter) {
    const raw = flags.adapter.split(",").map(s => s.trim())
    for (const a of raw) {
      if (!isAdapterName(a)) {
        console.error(`Invalid adapter: ${a}. Valid: ${ALL_ADAPTERS.join(", ")}`)
        process.exit(1)
      }
    }
    adapters = raw as AdapterName[]
  } else if (flags.batch === "true") {
    adapters = [...ALL_ADAPTERS]
  } else {
    adapters = [CLI_DEFAULTS.adapter as AdapterName]
  }

  // Provider-specific API key is checked lazily when createProviderForModel
  // runs against each job's model id — it throws a clear error citing the
  // matched route and its apiKeyEnv.

  const { printBanner, describeModelRoute, describeAdapter, shortenPath } = await import("./core/banner.ts")
  const { SKVM_CACHE, PROFILES_DIR, getProfileLogDir } = await import("./core/config.ts")
  printBanner("profile", [
    ["Adapter", adapters.map(a => describeAdapter(a)).join(", ")],
    ["Model", models.map(m => describeModelRoute(m)).join(", ")],
    ["Cache", shortenPath(SKVM_CACHE)],
    ["Output", shortenPath(PROFILES_DIR)],
  ])

  const { profile, profileMulti, hasProfile } = await import("./profiler/index.ts")
  const { mkdirSync } = await import("node:fs")

  // Build job list: (model, adapter) combos that need profiling
  type Job = { model: string; harness: AdapterName }
  const jobs: Job[] = []
  let skipped = 0

  for (const model of models) {
    for (const harness of adapters) {
      if (!force && await hasProfile(model, harness)) {
        console.log(`${model} -- ${harness}: cached (skip)`)
        skipped++
      } else {
        jobs.push({ model, harness })
      }
    }
  }

  const total = models.length * adapters.length
  console.log(`\nProfile: ${total} total, ${skipped} cached, ${jobs.length} to run (concurrency=${concurrency})\n`)

  if (jobs.length === 0) {
    console.log("Nothing to profile.")
    return
  }

  const { RunSession, shortModel } = await import("./core/run-session.ts")
  const modelNames = jobs.map(j => j.model)
  const harnessNames = [...new Set(jobs.map(j => j.harness))]
  const tag = jobs.length === 1
    ? `${jobs[0]!.harness}-${shortModel(jobs[0]!.model)}`
    : `${jobs.length}j-${harnessNames.join("+")}`
  const logDir = jobs.length === 1
    ? getProfileLogDir(jobs[0]!.harness, jobs[0]!.model)
    : getProfileLogDir(harnessNames[0]!, modelNames[0]!)
  const session = await RunSession.start({
    type: "profile",
    tag,
    logDir,
    models: [...new Set(modelNames)],
    harness: harnessNames.join(","),
  })

  if (jobs.length === 1) {
    // Single job: use the original profile() function directly
    const job = jobs[0]!
    const profileLogDir = getProfileLogDir(job.harness, job.model)
    mkdirSync(profileLogDir, { recursive: true })

    try {
      const adapter = createAdapter(job.harness)
      const tcp = await profile({
        model: job.model,
        harness: job.harness,
        adapter,
        adapterConfig: { model: job.model, maxSteps: 25, timeoutMs: 300_000 },
        primitives,
        skip,
        instances,
        force,
        logFile: `${profileLogDir}/console.log`,
        convLogDir: profileLogDir,
        concurrency,
        adapterFactory: concurrency > 1 ? async () => {
          const a = createAdapter(job.harness)
          await a.setup({ model: job.model, maxSteps: 25, timeoutMs: 300_000 })
          return a
        } : undefined,
      })
      printProfileSummary(tcp)
      await session.complete(`${job.model} profiled`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(c.red(`${job.model} -- ${job.harness}: FAILED: ${msg}`))
      await session.fail(msg)
    }
    return
  }

  // Multi-job: use unified scheduler with work-stealing
  const { results, failures } = await profileMulti({
    jobs,
    createAdapter: (harness) => createAdapter(harness as AdapterName),
    primitives,
    instances,
    force,
    concurrency,
    logDirFactory: (harness, model) => {
      const dir = getProfileLogDir(harness, model)
      mkdirSync(dir, { recursive: true })
      return dir
    },
  })

  for (const [, { tcp }] of results) {
    printProfileSummary(tcp)
  }

  // Summary
  if (jobs.length > 1) {
    console.log(`\n=== Profile Summary ===`)
    console.log(`Total: ${total}, Completed: ${results.size}, Skipped: ${skipped}, Failed: ${failures.length}`)

    if (failures.length > 0) {
      console.log(`\nFailures:`)
      for (const f of failures) {
        console.log(`  ${f.model} -- ${f.harness}: ${f.error}`)
      }
    }
  }

  if (failures.length > 0) {
    await session.fail(`${failures.length}/${jobs.length} failed`)
  } else {
    await session.complete(`${results.size} models profiled`)
  }
}

async function runRun(flags: Record<string, string>) {
  if (flags.help === "true") {
    console.log(`skvm run - Run one task with an optional user-specified skill

Usage:
  skvm run --task=<path/to/task.json> --model=<id> [options]
  skvm run --task=<path/to/task.json> --skill=<path/to/SKILL.md> --model=<id> [options]

Required:
  --task=<path>         Path to a task JSON file (bench task schema)
  --model=<id>          Model identifier

Options:
  --skill=<path>        Optional path to a SKILL.md file
  --adapter=<name>      Agent adapter: ${ALL_ADAPTERS.join(" | ")} (default: ${CLI_DEFAULTS.adapter})
  --workdir=<path>      Use this directory instead of a temp work directory
  --timeoutMs=<n>       Override task timeout in ms
  --maxSteps=<n>        Override max steps for the adapter
  --verbose             Show detailed output

Notes:
  - This command executes only. It does not run evaluation or scoring.
  - Task files use the bench task.json shape, but eval is optional here.
  - Any files under the task's fixtures/ directory are copied into the workDir before execution.`)
    process.exit(0)
  }

  const taskPath = flags.task
  const skillPath = flags.skill
  const model = flags.model
  if (!taskPath || !model) {
    console.error("--task and --model are required. Example: skvm run --task=path/to/task.json --model=qwen/qwen3-30b-a3b-instruct-2507 [--skill=path/to/SKILL.md]")
    process.exit(1)
  }

  const harnessStr = flags.adapter ?? CLI_DEFAULTS.adapter
  if (!isAdapterName(harnessStr)) {
    console.error(`Invalid adapter: ${harnessStr}. Valid: ${ALL_ADAPTERS.join(", ")}`)
    process.exit(1)
  }
  const harness: AdapterName = harnessStr

  {
    const { printBanner, describeModelRoute, describeAdapter, shortenPath } = await import("./core/banner.ts")
    const { SKVM_CACHE } = await import("./core/config.ts")
    const bannerLines: [string, string][] = [
      ["Adapter", describeAdapter(harness)],
      ["Model", describeModelRoute(model)],
      ["Task", taskPath],
    ]
    if (skillPath) bannerLines.push(["Skill", skillPath])
    if (flags.workdir) bannerLines.push(["WorkDir", shortenPath(flags.workdir)])
    bannerLines.push(["Cache", shortenPath(SKVM_CACHE)])
    printBanner("run", bannerLines)
  }

  // Provider-specific API key is checked lazily by createProviderForModel().

  const { executeRun, loadRunSkill, loadRunTask } = await import("./run/index.ts")

  let task
  let skill
  try {
    task = await loadRunTask(taskPath)
    skill = skillPath ? await loadRunSkill(skillPath) : undefined
  } catch (err) {
    console.error(String(err))
    process.exit(1)
  }

  const adapterConfig: import("./core/types.ts").AdapterConfig = {
    model,
    maxSteps: flags.maxSteps ? parseInt(flags.maxSteps) : task.maxSteps,
    timeoutMs: flags.timeoutMs ? parseInt(flags.timeoutMs) : task.timeoutMs,
  }

  const adapter = createAdapter(harness)

  const { RunSession, shortModel: shortModelName } = await import("./core/run-session.ts")
  const { getRuntimeLogDir } = await import("./core/config.ts")
  const runSession = await RunSession.start({
    type: "run",
    tag: `${harness}-${shortModelName(model)}-${task.id}`,
    logDir: getRuntimeLogDir(harness, model, task.id),
    models: [model],
    harness,
  })

  const runSp = createSpinner(`Running task ${task.id}...`)

  try {
    const result = await executeRun({
      task,
      skill,
      adapter,
      adapterConfig,
      workDir: flags.workdir,
      keepWorkDir: true,
    })
    runSp.succeed(`Task ${task.id} complete`)

    console.log(`\n=== Run Complete ===`)
    console.log(`Task: ${result.task.id}`)
    console.log(`Skill: ${result.skill?.skillPath ?? "<none>"}`)
    console.log(`Model: ${model}`)
    console.log(`Adapter: ${harness}`)
    console.log(`WorkDir: ${result.workDir}`)
    console.log(`Duration: ${(result.runResult.durationMs / 1000).toFixed(1)}s`)
    console.log(`Tokens: in=${result.runResult.tokens.input} out=${result.runResult.tokens.output}`)
    // Surface non-ok runStatus prominently — otherwise a timed-out single-task
    // run would silently print whatever text the agent emitted before the kill
    // and no warning that the budget was violated. (`skvm run` doesn't go
    // through the bench runner gate, so this is the only place to flag it.)
    if (result.runResult.runStatus !== "ok") {
      console.log(c.yellow(`⚠ runStatus: ${result.runResult.runStatus}`))
      if (result.runResult.statusDetail) {
        console.log(`  ${result.runResult.statusDetail}`)
      }
    }
    if (result.runResult.adapterError) {
      console.log(`Adapter error: ${result.runResult.adapterError.stderr || `exit code ${result.runResult.adapterError.exitCode}`}`)
    }
    if (result.runResult.text) {
      console.log(`\nFinal output:\n${result.runResult.text}`)
    }
    await runSession.complete(`${task.id}, ${(result.runResult.durationMs / 1000).toFixed(1)}s`)
  } catch (err) {
    runSp.fail(`Task ${task.id} failed`)
    await runSession.fail(err instanceof Error ? err.message : String(err))
    console.error(c.red(`Run failed: ${err}`))
    process.exit(1)
  }
}

async function runCompile(flags: Record<string, string>) {
  if (flags.help === "true") {
    console.log(`skvm aot-compile - AOT-compile skill(s) for target model(s)

Usage:
  skvm aot-compile --skill=<id,...> --model=<id,...> [options]

Options:
  --skill=<id,...>      Skill name(s) or path(s), comma-separated (required)
  --model=<id,...>      Target model(s), comma-separated (required)
  --adapter=<name,...>  Harness name(s), comma-separated (${ALL_ADAPTERS.join(" | ")}; default: ${CLI_DEFAULTS.adapter})
  --profile=<path>      Path to TCP JSON (single-job only; default: load from cache)
  --pass=<list>         Which passes to run, comma-separated (default: ${CLI_DEFAULTS.compilerPasses.join(",")})
  --concurrency=<n>     Parallel compilations (default: ${CLI_DEFAULTS.concurrency})
  --dry-run             Show plan without applying
  --compiler-model=<id> Compiler model via OpenRouter (default: ${MODEL_DEFAULTS.compiler})`)
    process.exit(0)
  }

  if (!flags.skill || !flags.model) {
    console.error("--skill and --model are required")
    process.exit(1)
  }

  const skillInputs = flags.skill.split(",").map(s => s.trim())
  const models = flags.model.split(",").map(m => m.trim())
  const adapters = (flags.adapter ?? CLI_DEFAULTS.adapter).split(",").map(a => a.trim())
  const passes: number[] = flags.pass
    ? flags.pass.split(",").map(p => Number(p.trim()))
    : [...CLI_DEFAULTS.compilerPasses]
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
      }, provider, { showSpinner: !isMultiJob })

      if (!dryRun) {
        await writeVariant(result)
      }

      completed++
      const guardStr = result.guardPassed ? "PASS" : "FAIL"
      spinnerLog(`  [${completed}/${jobs.length}] ${label}: ${result.pass1.gaps.length} gaps, guard=${guardStr}, ${(result.durationMs / 1000).toFixed(1)}s`)
      compileProgress.tick(`Compiled ${jobs.length} job(s)`)

      results.push({
        skill: job.skill.name, model: job.model, adapter: job.adapter,
        gaps: result.pass1.gaps.length, guard: result.guardPassed, durationMs: result.durationMs,
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

async function runPipeline(flags: Record<string, string>) {
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
  --dry-run               Show compilation plan without writing`)
    process.exit(0)
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

  const passes = flags.pass ? flags.pass.split(",").map(Number) : [...CLI_DEFAULTS.compilerPasses]
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
      tcp = await profile({
        model,
        harness,
        adapter,
        adapterConfig: {
          model,
          maxSteps: 25,
          timeoutMs: 300_000,
        },
        force: true,
        logFile,
        convLogDir,
      })

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
  }, provider)

  // Print results
  console.log(`\n=== Pipeline Complete: ${result.skillName} for ${result.model}--${result.harness} ===`)
  console.log(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`)
  console.log(`Guard: ${result.guardPassed ? "PASSED" : "FAILED"}`)
  if (result.guardViolations.length > 0) {
    for (const v of result.guardViolations) console.log(`  Violation: ${v}`)
  }
  console.log(`SCR: ${result.pass1.scr.purposes.length} purposes`)
  console.log(`Gaps: ${result.pass1.gaps.length}`)
  console.log(`Transforms: ${result.pass1.transforms.length}`)
  console.log(`Dependencies: ${result.pass2.dependencies.length}`)
  console.log(`DAG steps: ${result.pass3.dag.steps.length}`)
  console.log(`Parallelism: ${result.pass3.dag.parallelism.length}`)

  // Write variant
  if (flags["dry-run"] !== "true") {
    const dir = await writeVariant(result)
    console.log(`\nVariant written to: ${dir}`)
  }

  await pipelineSession.complete(`${result.pass1.gaps.length} gaps, guard=${result.guardPassed ? "pass" : "fail"}`)
}

async function runBenchCmd(flags: Record<string, string>) {
  const { runBench } = await import("./bench/index.ts")
  await runBench(flags)
}

async function runCleanJIT(flags: Record<string, string>) {
  if (flags.help === "true") {
    console.log(`skvm clean-jit - Clear persisted JIT artifacts for a model+adapter

Usage:
  skvm clean-jit --model=<id> --adapter=<name> [options]

Required:
  --model=<id>              Model identifier (e.g. qwen/qwen3.5-122b-a10b)
  --adapter=<name>          Adapter: bare-agent, opencode, openclaw

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
  const { AOT_COMPILE_DIR, LOGS_DIR, safeModelName } = await import("./core/config.ts")

  const safeModel = safeModelName(model)
  const runtimeModelDir = path.join(LOGS_DIR, "runtime", adapter, safeModel)
  const compiledModelDir = path.join(AOT_COMPILE_DIR, adapter, safeModel)
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
// Command: logs
// ---------------------------------------------------------------------------

async function runLogs(flags: Record<string, string>) {
  if (flags.help === "true") {
    console.log(`skvm logs - List recent runs across all subsystems

Options:
  --type=<type>    Filter by type (profile, aot-compile, bench, run, pipeline)
  --limit=<n>      Show last N entries (default: ${CLI_DEFAULTS.listLimit})
  --all            Show all entries (no limit)`)
    process.exit(0)
  }

  const { readSessions } = await import("./core/run-session.ts")

  const limit = flags.all === "true" ? undefined : (flags.limit ? parseInt(flags.limit) : CLI_DEFAULTS.listLimit)
  const entries = await readSessions({ type: flags.type, limit })

  if (entries.length === 0) {
    console.log("No sessions found.")
    return
  }

  console.log(`\nRecent runs${flags.type ? ` (type: ${flags.type})` : ""}:\n`)

  const statusColor: Record<string, (s: string) => string> = {
    COMPLETED: c.green, FAILED: c.red, RUNNING: c.yellow,
  }
  for (const e of entries) {
    const label = e.status.toUpperCase().padEnd(10)
    const colorFn = statusColor[label.trim()] ?? noColor
    console.log(`  ${colorFn(label)} ${e.id}`)

    const details: string[] = []
    details.push(`Type: ${e.type}`)
    if (e.models && e.models.length > 1) {
      details.push(`Models: ${e.models.length}`)
    } else if (e.models && e.models.length === 1) {
      details.push(`Model: ${e.models[0]}`)
    }
    if (e.harness) details.push(`Harness: ${e.harness}`)
    if (e.skill) details.push(`Skill: ${e.skill}`)
    if (e.conditions) details.push(`Conditions: ${e.conditions.join(", ")}`)
    if (e.summary) details.push(e.summary)
    if (e.error) details.push(`Error: ${e.error}`)
    console.log(`             ${details.join(" | ")}`)

    console.log(`             Log: ${e.logDir}`)
    console.log()
  }
}

// ---------------------------------------------------------------------------
// Command: proposals
// ---------------------------------------------------------------------------

async function runProposals(rawArgs: string[]) {
  const sub = rawArgs[0]
  const flags = parseFlags(rawArgs.slice(1))
  const positional = rawArgs.slice(1).filter((a) => !a.startsWith("--"))

  if (!sub || sub === "help" || flags.help === "true") {
    console.log(`skvm proposals - Manage jit-optimize proposals

Usage:
  skvm proposals list    [--harness=<n>] [--target-model=<id>] [--skill=<name>] [--status=<s>]
                         [--sort=recent|delta|skill|model] [--min-delta=<n>]
                         [--group-by=skill|model] [--no-color]
  skvm proposals show    <id> [--full] [--no-color]
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
    if (!id) { console.error("Usage: skvm proposals show <id>"); process.exit(1) }
    const p = await loadProposal(id)
    const proposalDir = proposalDirFromId(id)
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

async function runJitOptimize(flags: Record<string, string>) {
  if (flags.help === "true") {
    console.log(`skvm jit-optimize - Optimize a skill based on execution evidence

Usage:
  skvm jit-optimize --skill=<path> --task-source=<kind> [options]
  skvm jit-optimize --skill-list=<file> --task-source=<kind> [--concurrency=<n>] [options]

Required for all sources:
  --skill=<path>             Path to skill directory (or --skill-list)
  --task-source=<kind>       synthetic | real | log   (must be set explicitly)
  --optimizer-model=<id>     Optimizer LLM model (e.g. z-ai/glm-5.1)

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
  const targetAdapter: import("./jit-optimize/types.ts").JitOptimizeConfig["targetAdapter"] = {
    model: tModel,
    harness: tHarness,
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
