#!/usr/bin/env bun

import "./core/env-bootstrap.ts"
import { setLogLevel, c } from "./core/logger.ts"
import { runOrExit } from "./cli/flags.ts"
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

  // Legacy parseFlags treated any `--verbose=<non-empty>` (including
  // --verbose=false) as set. This scan is a slight superset: `--verbose=`
  // (empty value) and `--verbose` in the command position also enable
  // debug — acceptable for a debug toggle.
  if (args.some((a) => a === "--verbose" || a.startsWith("--verbose="))) setLogLevel("debug")

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
    case "proposals": {
      const { runProposals } = await import("./cli/proposals.ts")
      await runProposals(args.slice(1))
      break
    }
    case "clean-jit": {
      const { CLEAN_JIT_FLAGS, runCleanJIT } = await import("./cli/clean-jit.ts")
      await runOrExit(CLEAN_JIT_FLAGS, args.slice(1), runCleanJIT)
      break
    }
    case "logs": {
      const { LOGS_FLAGS, runLogs } = await import("./cli/logs.ts")
      await runOrExit(LOGS_FLAGS, args.slice(1), runLogs)
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

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
