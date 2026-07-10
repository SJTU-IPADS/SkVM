/**
 * `skvm aot-compile` — AOT-compile skill(s) for target model(s).
 * Migrated to the declarative flag layer (#49). `--skill`/`--model` stay
 * cross-flag rules (not `required: true`) because `--list-passes`
 * short-circuits before they are needed — same shape as profile's `--list`.
 */

import { defineFlags, parseEnumListFlag, UsageError, type ConfigOf } from "./flags.ts"
import { ALL_ADAPTERS } from "../adapters/registry.ts"
import { CLI_DEFAULTS, MODEL_DEFAULTS } from "../core/ui-defaults.ts"
import { TIMEOUT_DEFAULTS } from "../core/timeouts.ts"
import { createProgressSpinner, spinnerLog } from "../core/spinner.ts"
import { c } from "../core/logger.ts"

export const COMPILE_FLAGS = defineFlags(
  "aot-compile",
  "AOT-compile skill(s) for target model(s)",
  {
    skill: { kind: "string", placeholder: "<id,...>", help: "Skill name(s) or path(s), comma-separated (required)" },
    model: { kind: "string", placeholder: "<id,...>", help: "Target model(s), comma-separated (required)" },
    adapter: {
      kind: "string",
      placeholder: "<name,...>",
      help: `Harness name(s), comma-separated (${ALL_ADAPTERS.join(" | ")}; default: ${CLI_DEFAULTS.adapter})`,
    },
    profile: {
      kind: "string",
      placeholder: "<path>",
      help: "Path to TCP JSON (single-job only; default: load from cache).\nOnly required when a selected pass consumes the TCP (see --list-passes).",
    },
    pass: {
      kind: "string",
      placeholder: "<list>",
      help: `Compiler passes, comma-separated (numeric or string ids; see --list-passes\nfor the registry). Default: ${CLI_DEFAULTS.compilerPasses.join(",")}`,
    },
    "list-passes": { kind: "bool", help: "Print the pass registry and exit" },
    concurrency: { kind: "int", min: 1, default: CLI_DEFAULTS.concurrency, help: "Parallel compilations" },
    "dry-run": { kind: "bool", help: "Show plan without applying" },
    "compiler-model": { kind: "string", placeholder: "<id>", default: MODEL_DEFAULTS.compiler, help: "Compiler model via OpenRouter" },
    "timeout-ms": {
      kind: "int",
      min: 1,
      help: `Cap on the compiler agent loop (Pass 1, rewrite-skill)\nwhile it edits SKILL.md (ms). Default: ${TIMEOUT_DEFAULTS.compiler}.`,
    },
  },
  { usage: ["skvm aot-compile --skill=<id,...> --model=<id,...> [options]"] },
)

export type CompileConfig = ConfigOf<typeof COMPILE_FLAGS>

export async function runCompile(config: CompileConfig): Promise<void> {
  if (config["list-passes"]) {
    const { formatRegistry } = await import("../compiler/registry.ts")
    console.log(formatRegistry())
    return
  }

  if (!config.skill || !config.model) {
    throw new UsageError("aot-compile: --skill and --model are required", COMPILE_FLAGS.help)
  }

  const cliCompilerTimeoutMs = config["timeout-ms"]

  const skillInputs = config.skill.split(",").map(s => s.trim())
  const models = config.model.split(",").map(m => m.trim())
  const adapters = parseEnumListFlag("aot-compile", "adapter", config.adapter ?? CLI_DEFAULTS.adapter, ALL_ADAPTERS, COMPILE_FLAGS.help)
  const passes: string[] = config.pass
    ? config.pass.split(",").map((p) => p.trim()).filter(Boolean)
    : CLI_DEFAULTS.compilerPasses.map(String)
  // A provided --pass that yields zero tokens (e.g. `--pass=,`) must not fall
  // through: `needsTcp` below would see "no passes" while compileSkill treats
  // an empty list as "use the default passes", which do require a TCP.
  if (config.pass && passes.length === 0) {
    throw new UsageError(
      "aot-compile: --pass contains no pass tokens. Run 'skvm aot-compile --list-passes' to see available passes.",
      COMPILE_FLAGS.help,
    )
  }
  const concurrency = config.concurrency
  const dryRun = config["dry-run"]

  // Resolve pass tokens up front: an unknown pass is a usage error (thrown
  // before any side effect), and the resolved set decides whether profiles
  // are needed at all — only passes that declare `requiresTcp` (pass 1,
  // rewrite-skill) read the TCP, so e.g. `--pass=bind-env` compiles without
  // a profile.
  const { resolvePassTokens } = await import("../compiler/registry.ts")
  let needsTcp: boolean
  try {
    needsTcp = resolvePassTokens(passes).some((p) => p.requiresTcp)
  } catch (err) {
    throw new UsageError(`aot-compile: ${err instanceof Error ? err.message : err}`, COMPILE_FLAGS.help)
  }

  // --profile is a pure flag-shape check (no I/O) — validated up front,
  // before skill resolution and the banner, alongside the other cross-flag
  // rules. The actual TCP file read stays below, after skill resolution, so
  // "skill not found" still wins over "missing profiles" for single-job runs.
  if (config.profile && (models.length > 1 || adapters.length > 1)) {
    throw new UsageError("aot-compile: --profile flag only supported for single model + single adapter", COMPILE_FLAGS.help)
  }

  const compilerModel = config["compiler-model"]
  {
    const { printBanner, describeModelRoute, describeAdapter, shortenPath } = await import("../core/banner.ts")
    const { SKVM_CACHE, AOT_COMPILE_DIR } = await import("../core/config.ts")
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
  const { loadSkill: loadSkillFromPath } = await import("../core/skill-loader.ts")

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
      throw new UsageError(`aot-compile: skill not found: ${input} — ${err instanceof Error ? err.message : err}`, COMPILE_FLAGS.help)
    }
  }

  // ---------------------------------------------------------------------------
  // Load and validate profiles for all (model, adapter) combos — skipped
  // entirely when no selected pass consumes the TCP (an explicit --profile is
  // still honored either way).
  // ---------------------------------------------------------------------------
  type TCP = import("../core/types.ts").TCP
  const tcpCache = new Map<string, TCP>()

  if (config.profile) {
    // Single-job shape already validated above.
    const { TCPSchema } = await import("../core/types.ts")
    const profileData = await Bun.file(config.profile).json()
    tcpCache.set(`${models[0]}--${adapters[0]}`, TCPSchema.parse(profileData))
  } else if (needsTcp) {
    const { loadProfile } = await import("../profiler/index.ts")
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
      throw new UsageError(
        `aot-compile: missing profiles:\n${missing.map(m => `  ${m}`).join("\n")}\nRun 'skvm profile' first.`,
        COMPILE_FLAGS.help,
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Build job matrix: skills × models × adapters
  // ---------------------------------------------------------------------------
  type CompileJob = { skill: typeof resolvedSkills[number]; model: string; adapter: string; tcp: TCP | undefined }
  const jobs: CompileJob[] = []
  for (const skill of resolvedSkills) {
    for (const adapter of adapters) {
      for (const model of models) {
        jobs.push({ skill, model, adapter, tcp: tcpCache.get(`${model}--${adapter}`) })
      }
    }
  }

  console.log(`\nCompile: ${resolvedSkills.length} skill(s) × ${models.length} model(s) × ${adapters.length} adapter(s) = ${jobs.length} job(s), concurrency=${concurrency}\n`)

  if (jobs.length === 0) return

  const { RunSession, shortModel: shortModelName } = await import("../core/run-session.ts")
  const { getCompileLogDir } = await import("../core/config.ts")
  const skillNames = resolvedSkills.map(s => s.name).join("+")
  const compileSession = await RunSession.start({
    type: "aot-compile",
    tag: `${adapters[0]}-${shortModelName(models[0]!)}-${skillNames}`,
    logDir: getCompileLogDir(adapters[0]!, models[0]!, resolvedSkills[0]!.name),
    models,
    harness: adapters.join(","),
    skill: skillNames,
  })

  try {
    // -------------------------------------------------------------------------
    // Create shared provider and run jobs
    // -------------------------------------------------------------------------
    const { createProviderForModel } = await import("../providers/registry.ts")
    const provider = createProviderForModel(compilerModel)
    const { compileSkill, writeVariant } = await import("../compiler/index.ts")
    const { createSlotPool } = await import("../core/concurrency.ts")

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

    // -------------------------------------------------------------------------
    // Summary
    // -------------------------------------------------------------------------
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
      // Non-zero exit on failure (repo scriptability rule); see #83. Explicit
      // process.exit(1) mirrors run.ts; this branch is the end of the run, so
      // nothing after it needs to execute.
      process.exit(1)
    } else {
      await compileSession.complete(`${jobs.length} job(s) compiled`)
    }
  } catch (err) {
    // Mark the session failed, then rethrow: UsageError exits cleanly via
    // runOrExit; anything else propagates to the top-level crash handler
    // (stack trace to stderr, exit 1).
    await compileSession.fail(err instanceof Error ? err.message : String(err))
    throw err
  }
}
