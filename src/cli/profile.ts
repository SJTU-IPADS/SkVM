/**
 * `skvm profile` — profile a model's primitive capabilities.
 *
 * Flags are declared once via `defineFlags` (#49); help is generated from the
 * declarations and `runProfile` takes the typed config, so the parse path and
 * cross-flag rules are unit-testable without spawning the CLI. Rules the
 * layer cannot express stay here and throw `UsageError`:
 * - `--model` is required, but only after the `--list` short-circuit, so it
 *   cannot be `required: true` at the layer.
 * - `--adapter` is comma-separated multi-value, so it stays `kind: "string"`
 *   and each entry is validated against the adapter registry via
 *   `parseEnumListFlag` (the layer's standard enum wording).
 */

import { defineFlags, parseEnumListFlag, UsageError, type ConfigOf } from "./flags.ts"
import { ALL_ADAPTERS, type AdapterName, createAdapter } from "../adapters/registry.ts"
import { resolveAdapterConfigMode } from "../core/config.ts"
import { AdapterConfigModeSchema, type TCP } from "../core/types.ts"
import { CLI_DEFAULTS } from "../core/ui-defaults.ts"
import { TIMEOUT_DEFAULTS } from "../core/timeouts.ts"
import { c, noColor, setLogLevel } from "../core/logger.ts"

export const PROFILE_FLAGS = defineFlags(
  "profile",
  "Profile a model's primitive capabilities",
  {
    model: {
      kind: "string",
      placeholder: "<id,...>",
      help: "Model identifier(s), comma-separated (required unless --batch).\nFormat: <provider>/<model-id> — the <provider> prefix selects\na route in providers.routes (see docs/providers.md)",
    },
    adapter: {
      kind: "string",
      placeholder: "<name,...>",
      help: `Agent adapter(s), comma-separated: ${ALL_ADAPTERS.join(" | ")}\n(default: ${CLI_DEFAULTS.adapter}; batch default: all adapters)`,
    },
    primitives: {
      kind: "string",
      placeholder: "<list>",
      help: "Comma-separated primitive IDs (default: all registered)",
    },
    skip: {
      kind: "string",
      placeholder: "<list>",
      help: "Comma-separated primitive IDs to skip",
    },
    instances: {
      kind: "int",
      min: 1,
      default: CLI_DEFAULTS.profileInstances,
      help: "Instances per level",
    },
    force: { kind: "bool", help: "Ignore cached profile, re-run" },
    list: { kind: "bool", help: "List cached profiles" },
    batch: { kind: "bool", help: "Profile all models from bench config" },
    concurrency: {
      kind: "int",
      min: 1,
      default: CLI_DEFAULTS.concurrency,
      help: "Parallel primitives across all model×adapter combos.\nSlots are distributed per-adapter then per-model.",
    },
    "adapter-config": {
      kind: "enum",
      values: AdapterConfigModeSchema.options,
      placeholder: "<m>",
      help: "native | managed (default: defaults.adapterConfigMode in\nskvm.config.json, falls back to managed). Native uses your\nreal harness config; managed uses providers.routes only.",
    },
    "timeout-ms": {
      kind: "int",
      min: 1,
      // Profile probe default harmonizes with task-exec (previously hardcoded
      // to 300s). CLI --timeout-ms wins absolutely.
      default: TIMEOUT_DEFAULTS.taskExec,
      help: "Cap on each microbenchmark probe's adapter execution (ms)",
    },
    "export-cost": {
      kind: "string",
      placeholder: "<path>",
      help: "Write a per-primitive cost/token CSV\nfrom the cached profiles of --model × --adapter, then exit.\nReads the cache only — no LLM calls.",
    },
    "export-all-versions": {
      kind: "bool",
      help: "With --export-cost, emit every archived profile run, not just\nthe latest, so repeat runs can be compared (rows are keyed\nby the profiled_at column).",
    },
    reconcile: {
      kind: "bool",
      help: "Check the cached profile's cost block against its conversation\ntranscripts, then exit. Non-zero when they disagree, or when\ncost coverage is below --min-coverage. Reads the cache only.",
    },
    tolerance: {
      kind: "float",
      min: 0,
      max: 1,
      default: 0.005,
      help: "With --reconcile, the largest relative gap between a profile\nmetric and its transcripts that still counts as agreement",
    },
    "min-coverage": {
      kind: "float",
      min: 0,
      max: 1,
      default: 0.99,
      help: "With --reconcile, the share of LLM calls the provider must have\npriced. Below this the cost is too incomplete to publish as a\nfloor; above it the run passes with the floor stated.",
    },
    json: {
      kind: "bool",
      help: "With --reconcile, emit the result as JSON on stdout and nothing else",
    },
  },
  {
    usage: [
      "skvm profile --model=<id> [options]",
      "skvm profile --batch [options]",
    ],
  },
)

export type ProfileConfig = ConfigOf<typeof PROFILE_FLAGS>

export function printProfileSummary(tcp: TCP) {
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

export async function runProfile(config: ProfileConfig): Promise<void> {
  if (config.list) {
    const { listProfiles } = await import("../profiler/index.ts")
    const profiles = await listProfiles()
    if (profiles.length === 0) {
      console.log("No cached profiles.")
    } else {
      console.log("Cached profiles:")
      for (const p of profiles) {
        console.log(`  ${p.model} -- ${p.harness} (${p.profiledAt})`)
      }
    }
    return
  }

  // Resolve models
  if (!config.model) {
    throw new UsageError("profile: --model is required", PROFILE_FLAGS.help)
  }
  const models = config.model.split(",").map(m => m.trim())

  // Resolve adapters: unified --adapter flag, comma-separated
  let adapters: AdapterName[]
  if (config.adapter) {
    adapters = parseEnumListFlag("profile", "adapter", config.adapter, ALL_ADAPTERS, PROFILE_FLAGS.help)
  } else if (config.batch) {
    adapters = [...ALL_ADAPTERS]
  } else {
    adapters = [CLI_DEFAULTS.adapter]
  }

  // Flags that only mean something in another mode must not be silently ignored:
  // a typo here otherwise starts a full 26-primitive profiling run.
  if (config["export-all-versions"] && !config["export-cost"]) {
    throw new UsageError("profile: --export-all-versions requires --export-cost", PROFILE_FLAGS.help)
  }
  if (config.json && !config.reconcile) {
    throw new UsageError("profile: --json requires --reconcile", PROFILE_FLAGS.help)
  }

  // Reconcile mode: verify a cached profile against its transcripts and exit.
  if (config.reconcile) {
    const { loadProfile } = await import("../profiler/index.ts")
    const { reconcileProfileCost, formatReconcileResult } = await import("../profiler/reconcile.ts")
    // JSON is a machine-readable contract: profile loading logs at info level,
    // which would put prose on stdout ahead of it.
    if (config.json) setLogLevel("error")

    let failed = false
    for (const model of models) {
      for (const harness of adapters) {
        const label = `${model} -- ${harness}`
        const tcp = await loadProfile(model, harness)
        if (!tcp) {
          // Post-argument-parse failure: exit directly rather than a UsageError,
          // which would print usage for a well-formed invocation.
          console.error(`profile: no cached profile for ${label}; run 'skvm profile' first`)
          process.exit(1)
        }
        const result = await reconcileProfileCost(tcp, {
          tolerance: config.tolerance,
          minCoverage: config["min-coverage"],
        })
        console.log(config.json ? JSON.stringify({ label, ...result }, null, 2) : formatReconcileResult(result, label))
        if (!result.ok) failed = true
      }
    }
    if (failed) process.exit(1)
    return
  }

  // Export mode: emit the profiling-cost CSV from cached profiles and exit.
  // Missing profiles are a hard error (scriptability rule — the caller must
  // know the CSV is incomplete rather than silently getting fewer rows).
  if (config["export-cost"]) {
    const { loadProfile, listProfileVersions, loadProfileVersion } = await import("../profiler/index.ts")
    const { profileCostCsv } = await import("../profiler/cost-export.ts")
    const allVersions = config["export-all-versions"]
    const entries: TCP[] = []
    for (const model of models) {
      for (const harness of adapters) {
        const tcps: TCP[] = []
        if (allVersions) {
          for (const v of await listProfileVersions(model, harness)) {
            const archived = await loadProfileVersion(model, harness, v.version)
            if (archived) tcps.push(archived)
          }
        }
        // `latest` is also the newest archive, so de-duplicate by run stamp
        // rather than emitting the final run twice.
        const latest = await loadProfile(model, harness)
        if (latest && !tcps.some(t => t.profiledAt === latest.profiledAt)) tcps.push(latest)
        if (tcps.length === 0) {
          console.error(`profile: no cached profile for ${model} -- ${harness}; run 'skvm profile' first`)
          process.exit(1)
        }
        entries.push(...tcps)
      }
    }
    await Bun.write(config["export-cost"], profileCostCsv(entries))
    const rows = entries.reduce((n, e) => n + e.details.length, 0)
    console.log(`Wrote ${rows} rows (${entries.length} profile(s)) to ${config["export-cost"]}`)
    return
  }

  const primitives = config.primitives?.split(",")
  const skip = config.skip?.split(",")
  const { instances, force, concurrency } = config
  const adapterMode = resolveAdapterConfigMode(config["adapter-config"])
  const probeTimeoutMs = config["timeout-ms"]

  // Provider-specific API key is checked lazily when createProviderForModel
  // runs against each job's model id — it throws a clear error citing the
  // matched route and its apiKeyEnv.

  const { printBanner, describeModelRoute, describeAdapter, shortenPath } = await import("../core/banner.ts")
  const { SKVM_CACHE, PROFILES_DIR, getProfileLogDir } = await import("../core/config.ts")
  printBanner("profile", [
    ["Adapter", adapters.map(a => describeAdapter(a)).join(", ")],
    ["Model", models.map(m => describeModelRoute(m)).join(", ")],
    ["Cache", shortenPath(SKVM_CACHE)],
    ["Output", shortenPath(PROFILES_DIR)],
  ])

  const { profile, profileMulti, hasProfile } = await import("../profiler/index.ts")
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

  const { RunSession, shortModel } = await import("../core/run-session.ts")
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

  try {
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
          adapterConfig: { model: job.model, maxSteps: 25, timeoutMs: probeTimeoutMs, mode: adapterMode },
          primitives,
          skip,
          instances,
          force,
          logFile: `${profileLogDir}/console.log`,
          convLogDir: profileLogDir,
          concurrency,
          adapterFactory: concurrency > 1 ? async () => {
            const a = createAdapter(job.harness)
            await a.setup({ model: job.model, maxSteps: 25, timeoutMs: probeTimeoutMs, mode: adapterMode })
            return a
          } : undefined,
        })
        printProfileSummary(tcp)
        await session.complete(`${job.model} profiled`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(c.red(`${job.model} -- ${job.harness}: FAILED: ${msg}`))
        await session.fail(msg)
        // Non-zero exit on failure (repo scriptability rule); see #83.
        process.exit(1)
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
      adapterMode,
      timeoutMs: probeTimeoutMs,
      logDirFactory: (harness, model) => {
        const dir = getProfileLogDir(harness, model)
        mkdirSync(dir, { recursive: true })
        return dir
      },
    })

    for (const [, { tcp }] of results) {
      printProfileSummary(tcp)
    }

    // Summary (this path only runs with ≥2 jobs — single jobs returned above)
    console.log(`\n=== Profile Summary ===`)
    console.log(`Total: ${total}, Completed: ${results.size}, Skipped: ${skipped}, Failed: ${failures.length}`)

    if (failures.length > 0) {
      console.log(`\nFailures:`)
      for (const f of failures) {
        console.log(`  ${f.model} -- ${f.harness}: ${f.error}`)
      }
    }

    if (failures.length > 0) {
      await session.fail(`${failures.length}/${jobs.length} failed`)
      // Non-zero exit on failure (repo scriptability rule); see #83.
      process.exit(1)
    } else {
      await session.complete(`${results.size} models profiled`)
    }
  } catch (err) {
    // Mark the session failed, then rethrow: UsageError exits cleanly via
    // runOrExit; anything else propagates to the top-level crash handler
    // (stack trace to stderr, exit 1). The per-path failure handlers above
    // exit(1) directly; this catches what escapes them (e.g. profileMulti
    // rethrowing an adapter-setup error out of the scheduler).
    await session.fail(err instanceof Error ? err.message : String(err))
    throw err
  }
}
