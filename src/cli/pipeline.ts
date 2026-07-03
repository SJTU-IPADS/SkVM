/**
 * `skvm pipeline` — profile (if needed) then compile a skill.
 * Migrated to the declarative flag layer (#49). Both required flags are
 * layer-level `required: true` — pipeline has no `--list`-style short-circuit.
 */

import { defineFlags, type ConfigOf, UsageError } from "./flags.ts"
import { ALL_ADAPTERS, createAdapter } from "../adapters/registry.ts"
import { resolveAdapterConfigMode } from "../core/config.ts"
import { AdapterConfigModeSchema } from "../core/types.ts"
import { CLI_DEFAULTS, MODEL_DEFAULTS } from "../core/ui-defaults.ts"
import { TIMEOUT_DEFAULTS } from "../core/timeouts.ts"

export const PIPELINE_FLAGS = defineFlags(
  "pipeline",
  "Profile (if needed) then compile a skill for a target model",
  {
    skill: { kind: "string", required: true, placeholder: "<path>", help: "Path to skill directory or SKILL.md" },
    model: { kind: "string", required: true, placeholder: "<id>", help: "Target model" },
    adapter: {
      kind: "enum",
      values: ALL_ADAPTERS,
      default: CLI_DEFAULTS.adapter,
      placeholder: "<name>",
      help: `Harness: ${ALL_ADAPTERS.join(" | ")}`,
    },
    "force-profile": { kind: "bool", help: "Re-profile even if cached" },
    profile: { kind: "string", placeholder: "<path>", help: "Use specific TCP file (skip auto-profiling)" },
    pass: { kind: "string", placeholder: "<list>", help: `Compiler passes, comma-separated (default: ${CLI_DEFAULTS.compilerPasses.join(",")})` },
    "compiler-model": { kind: "string", placeholder: "<id>", default: MODEL_DEFAULTS.compiler, help: "Compiler model via OpenRouter" },
    "dry-run": { kind: "bool", help: "Show compilation plan without writing" },
    "adapter-config": {
      kind: "enum",
      values: AdapterConfigModeSchema.options,
      placeholder: "<m>",
      help: "native | managed (default: defaults.adapterConfigMode in\nskvm.config.json, falls back to managed)",
    },
    "timeout-ms": {
      kind: "int",
      min: 1,
      help: `Per-agent-loop ceiling for this pipeline run (ms).
Applies to BOTH the profile stage's per-probe agent
execution AND the compiler agent loop. Each is timed
independently — this is a per-loop ceiling, not a
total wall time.
Default: ${TIMEOUT_DEFAULTS.taskExec} for profile,
${TIMEOUT_DEFAULTS.compiler} for compiler.`,
    },
  },
  { usage: ["skvm pipeline --skill=<path> --model=<id> [options]"] },
)

export type PipelineConfig = ConfigOf<typeof PIPELINE_FLAGS>

export async function runPipeline(config: PipelineConfig): Promise<void> {
  const cliPipelineTimeoutMs = config["timeout-ms"]

  const skillPath = config.skill
  const model = config.model
  const harness = config.adapter

  const passes: string[] = config.pass
    ? config.pass.split(",").map((p) => p.trim()).filter(Boolean)
    : CLI_DEFAULTS.compilerPasses.map(String)
  const pipelineCompilerModel = config["compiler-model"]

  // Validate the skill path up front (#78): a typo'd --skill used to cost a
  // full profiling run before erroring, and left the RunSession dangling as
  // RUNNING. This check now runs before any side effect (banner, session,
  // profiling), so it's a legitimate pre-side-effect UsageError.
  const skillFile = Bun.file(skillPath.endsWith(".md") ? skillPath : `${skillPath}/SKILL.md`)
  if (!(await skillFile.exists())) {
    throw new UsageError(`pipeline: skill not found: ${skillPath}`, PIPELINE_FLAGS.help)
  }

  {
    const { printBanner, describeModelRoute, describeAdapter, shortenPath } = await import("../core/banner.ts")
    const { SKVM_CACHE, AOT_COMPILE_DIR } = await import("../core/config.ts")
    printBanner("pipeline", [
      ["Adapter", describeAdapter(harness)],
      ["Model", describeModelRoute(model)],
      ["Compiler", describeModelRoute(pipelineCompilerModel)],
      ["Skill", skillPath],
      ["Cache", shortenPath(SKVM_CACHE)],
      ["Output", shortenPath(AOT_COMPILE_DIR)],
    ])
  }

  const { RunSession, shortModel: shortModelName } = await import("../core/run-session.ts")
  const { getCompileLogDir } = await import("../core/config.ts")
  const skillName = skillPath.replace(/.*\//, "").replace(/\.md$/, "")
  const pipelineSession = await RunSession.start({
    type: "pipeline",
    tag: `${harness}-${shortModelName(model)}-${skillName}`,
    logDir: getCompileLogDir(harness, model, skillName),
    models: [model],
    harness,
    skill: skillName,
  })

  try {
    // -------------------------------------------------------------------------
    // Step 1: Obtain TCP (profile or load from cache)
    // -------------------------------------------------------------------------

    let tcp: import("../core/types.ts").TCP

    if (config.profile) {
      // Explicit TCP file provided
      console.log(`Loading profile from ${config.profile}`)
      const profileData = await Bun.file(config.profile).json()
      const { TCPSchema } = await import("../core/types.ts")
      tcp = TCPSchema.parse(profileData)
      console.log(`  Loaded profile: ${tcp.model} -- ${tcp.harness}`)
    } else {
      // Try cache, then profile if needed
      const { profile, loadProfile } = await import("../profiler/index.ts")
      const forceProfile = config["force-profile"]

      const cached = forceProfile ? null : await loadProfile(model, harness)
      if (cached) {
        console.log(`Using cached profile for ${model} -- ${harness}`)
        tcp = cached
      } else {
        console.log(`No cached profile for ${model} -- ${harness}. Profiling...`)

        // Always-on logging
        const { getProfileLogDir } = await import("../core/config.ts")
        const pipelineLogDir = getProfileLogDir(harness, model)
        const { mkdirSync } = await import("node:fs")
        mkdirSync(pipelineLogDir, { recursive: true })
        const logFile = `${pipelineLogDir}/console.log`
        const convLogDir = pipelineLogDir

        const adapter = createAdapter(harness)
        const adapterModePipeline = resolveAdapterConfigMode(config["adapter-config"])
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

        const { printProfileSummary } = await import("./profile.ts")
        printProfileSummary(tcp)
      }
    }

    // -------------------------------------------------------------------------
    // Step 2: Load skill content (existence already validated up front)
    // -------------------------------------------------------------------------

    const skillContent = await skillFile.text()

    // -------------------------------------------------------------------------
    // Step 3: Compile
    // -------------------------------------------------------------------------

    console.log(`\nCompiling skill for ${model} -- ${harness}...`)

    const { createProviderForModel: createCompilerProvider } = await import("../providers/registry.ts")
    const provider = createCompilerProvider(pipelineCompilerModel)

    const { dirname: pipelineDirname } = await import("node:path")
    const pipelineSkillDir = skillPath.endsWith(".md") ? pipelineDirname(skillPath) : skillPath

    const { compileSkill, writeVariant } = await import("../compiler/index.ts")
    const result = await compileSkill({
      skillPath,
      skillDir: pipelineSkillDir,
      skillContent,
      tcp,
      model,
      harness,
      passes,
      dryRun: config["dry-run"],
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
    if (!config["dry-run"]) {
      const dir = await writeVariant(result)
      console.log(`\nVariant written to: ${dir}`)
    }

    await pipelineSession.complete(`${gaps.length} gaps, guard=${result.guardPassed ? "pass" : "fail"}`)
  } catch (err) {
    // Mark the session failed, then rethrow: UsageError exits cleanly via
    // runOrExit; anything else propagates to the top-level crash handler
    // (stack trace to stderr, exit 1).
    await pipelineSession.fail(err instanceof Error ? err.message : String(err))
    throw err
  }
}
