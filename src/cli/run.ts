/**
 * `skvm run` — run one task with an optional user-specified skill (execution
 * only, no evaluation or scoring).
 *
 * Flags are declared once via `defineFlags` (#49); help is generated from the
 * declarations and `runRun` takes the typed config, so the parse path is
 * unit-testable without spawning the CLI. The `--skill-mode` requires `--skill`
 * rule is declared on the flag (`requires: "skill"`) so the check and its
 * help suffix generate from one place.
 */

import { defineFlags, type ConfigOf } from "./flags.ts"
import { ALL_ADAPTERS, createAdapter } from "../adapters/registry.ts"
import { resolveAdapterConfigMode } from "../core/config.ts"
import { AdapterConfigModeSchema, type AdapterConfig, type SkillMode } from "../core/types.ts"
import { CLI_DEFAULTS } from "../core/ui-defaults.ts"
import { TIMEOUT_DEFAULTS } from "../core/timeouts.ts"
import { hasUsageTelemetry } from "../core/run-record.ts"
import { createSpinner } from "../core/spinner.ts"
import { c } from "../core/logger.ts"

/** Tied to `SkillMode` at compile time so the flag spec cannot drift. */
const SKILL_MODES = ["inject", "discover"] as const satisfies readonly SkillMode[]

export const RUN_FLAGS = defineFlags(
  "run",
  "Run one task with an optional user-specified skill",
  {
    task: {
      kind: "string",
      required: true,
      placeholder: "<path>",
      help: "Path to a task JSON file (bench task schema)",
    },
    model: {
      kind: "string",
      required: true,
      placeholder: "<id>",
      help: "Model identifier, <provider>/<model-id>",
    },
    skill: {
      kind: "string",
      placeholder: "<path>",
      help: "Optional path to a SKILL.md file",
    },
    "skill-mode": {
      kind: "enum",
      values: SKILL_MODES,
      requires: "skill",
      placeholder: "<mode>",
      help: "inject | discover (default: inject).\ninject: skill text is concatenated into the system\nprompt. discover: skill is written to\n.claude/skills/<name>/ and discovered via its\nSKILL.md description.",
    },
    adapter: {
      kind: "enum",
      values: ALL_ADAPTERS,
      default: CLI_DEFAULTS.adapter,
      placeholder: "<name>",
      help: `Agent adapter: ${ALL_ADAPTERS.join(" | ")}`,
    },
    workdir: {
      kind: "string",
      placeholder: "<path>",
      help: "Use this directory instead of a temp work directory",
    },
    "timeout-ms": {
      kind: "int",
      min: 1,
      help: `Override the per-task agent execution timeout (ms).\nThis caps how long the target adapter spends solving\none task. Falls back to task.json's \`timeoutMs\`,\nthen to the built-in default (${TIMEOUT_DEFAULTS.taskExec}).`,
    },
    "max-steps": {
      kind: "int",
      min: 1,
      help: "Override max steps for the adapter",
    },
    "adapter-config": {
      kind: "enum",
      values: AdapterConfigModeSchema.options,
      placeholder: "<m>",
      help: "native | managed (default: from skvm.config.json, else managed)",
    },
  },
  {
    usage: [
      "skvm run --task=<path/to/task.json> --model=<id> [options]",
      "skvm run --task=<path/to/task.json> --skill=<path/to/SKILL.md> --model=<id> [options]",
    ],
    epilogue: `Notes:
  - This command executes only. It does not run evaluation or scoring.
  - Task files use the bench task.json shape, but eval is optional here.
  - Any files under the task's fixtures/ directory are copied into the workDir before execution.`,
  },
)

export type RunConfig = ConfigOf<typeof RUN_FLAGS>

export async function runRun(config: RunConfig): Promise<void> {
  // The `--skill-mode requires --skill` rule is declared on the flag spec
  // (`requires: "skill"`) and enforced in `parse()`, so by the time runRun
  // sees the config the pairing is already valid.
  const skillMode = config["skill-mode"]

  const { task: taskPath, skill: skillPath, model, adapter: harness } = config

  {
    const { printBanner, describeModelRoute, describeAdapter, shortenPath } = await import("../core/banner.ts")
    const { SKVM_CACHE } = await import("../core/config.ts")
    const bannerLines: [string, string][] = [
      ["Adapter", describeAdapter(harness)],
      ["Model", describeModelRoute(model)],
      ["Task", taskPath],
    ]
    if (skillPath) bannerLines.push(["Skill", skillPath])
    if (config.workdir) bannerLines.push(["WorkDir", shortenPath(config.workdir)])
    bannerLines.push(["Cache", shortenPath(SKVM_CACHE)])
    printBanner("run", bannerLines)
  }

  // Provider-specific API key is checked lazily by createProviderForModel().

  const { executeRun, loadRunSkill, loadRunTask } = await import("../run/index.ts")

  let task
  let skill
  try {
    task = await loadRunTask(taskPath)
    skill = skillPath ? await loadRunSkill(skillPath) : undefined
  } catch (err) {
    console.error(String(err))
    process.exit(1)
  }

  const adapterModeRun = resolveAdapterConfigMode(config["adapter-config"])

  const { resolveTaskRuntime } = await import("../core/task-runtime.ts")
  const runRuntime = resolveTaskRuntime(task, {
    timeoutMs: config["timeout-ms"],
    maxSteps: config["max-steps"],
  })
  const adapterConfig: AdapterConfig = {
    model,
    maxSteps: runRuntime.maxSteps,
    timeoutMs: runRuntime.timeoutMs,
    mode: adapterModeRun,
  }

  const adapter = createAdapter(harness)

  const { RunSession, shortModel: shortModelName } = await import("../core/run-session.ts")
  const { getRuntimeLogDir } = await import("../core/config.ts")
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
      skillMode,
      workDir: config.workdir,
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
    console.log(hasUsageTelemetry(result.runResult)
      ? `Tokens: in=${result.runResult.tokens.input} out=${result.runResult.tokens.output}`
      : `Tokens: n/a (harness reported no usage telemetry)`)
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
      const ae = result.runResult.adapterError
      if (ae.diagnosis) {
        console.log(`Adapter error: ${ae.diagnosis.summary}`)
        if (ae.diagnosis.hint) console.log(`  ${ae.diagnosis.hint}`)
      } else {
        console.log(`Adapter error: ${ae.stderr || `exit code ${ae.exitCode}`}`)
      }
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
