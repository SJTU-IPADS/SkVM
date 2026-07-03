import { describe, test, expect } from "bun:test"
import { BENCH_FLAGS, runBench, resolveManifestDir } from "../../src/cli/bench.ts"
import { UsageError } from "../../src/cli/flags.ts"
import { ALL_ADAPTERS } from "../../src/adapters/registry.ts"
import { BENCH_CONDITIONS } from "../../src/bench/types.ts"
import { CLI_DEFAULTS, MODEL_DEFAULTS } from "../../src/core/ui-defaults.ts"
import { TIMEOUT_DEFAULTS } from "../../src/core/timeouts.ts"

function parseError(argv: string[]): UsageError {
  try {
    BENCH_FLAGS.parse(argv)
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError)
    return err as UsageError
  }
  throw new Error(`expected parse(${JSON.stringify(argv)}) to throw UsageError`)
}

async function runError(argv: string[]): Promise<UsageError> {
  const config = BENCH_FLAGS.parse(argv)
  if (config.help) throw new Error("unexpected help")
  try {
    await runBench(config)
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError)
    return err as UsageError
  }
  throw new Error(`expected runBench(${JSON.stringify(argv)}) to throw UsageError`)
}

/**
 * Like runError, for argv that legitimately prints before throwing: matrix
 * mode emits the "--profile not set, AOT conditions will be skipped" warning
 * (legacy order) before the model/axis checks run.
 */
async function runErrorQuiet(argv: string[]): Promise<UsageError> {
  const origLog = console.log
  console.log = () => {}
  try {
    return await runError(argv)
  } finally {
    console.log = origLog
  }
}

describe("BENCH_FLAGS.parse", () => {
  test("no flags → typed defaults (config-shape lock)", () => {
    expect(BENCH_FLAGS.parse([])).toEqual({
      help: false,
      // Mode selectors
      import: undefined,
      judge: undefined,
      "merge-judge": undefined,
      "list-sessions": false,
      compare: false,
      custom: undefined,
      // Resume / sessions
      resume: undefined,
      // Core run knobs
      model: undefined,
      adapter: undefined,
      tasks: undefined,
      source: undefined,
      conditions: undefined,
      "skill-mode": undefined,
      "jit-runs": CLI_DEFAULTS.jitRuns,
      "timeout-ms": undefined,
      "max-steps": CLI_DEFAULTS.maxSteps,
      "judge-model": MODEL_DEFAULTS.judge,
      "compiler-model": undefined,
      profile: undefined,
      "keep-workdirs": false,
      concurrency: undefined,
      "async-judge": false,
      "runs-per-task": CLI_DEFAULTS.benchRunsPerTask,
      "adapter-config": undefined,
      // Import mode
      path: undefined,
      exclude: undefined,
      "dry-run": false,
      // Judge / merge mode
      manifest: undefined,
      report: undefined,
      // Compare mode
      "skill-path": undefined,
      lhs: undefined,
      rhs: undefined,
      "output-dir": undefined,
      "analyze-model": undefined,
    })
  })

  test("sample argv → typed config", () => {
    expect(BENCH_FLAGS.parse([
      "--model=a/b,c/d", "--adapter=pi", "--conditions=no-skill,original",
      "--skill-mode=discover", "--jit-runs=2", "--timeout-ms=5000",
      "--concurrency=4", "--async-judge", "--keep-workdirs", "--adapter-config=native",
    ])).toEqual({
      help: false,
      import: undefined,
      judge: undefined,
      "merge-judge": undefined,
      "list-sessions": false,
      compare: false,
      custom: undefined,
      resume: undefined,
      model: "a/b,c/d",
      adapter: "pi",
      tasks: undefined,
      source: undefined,
      conditions: "no-skill,original",
      "skill-mode": "discover",
      "jit-runs": 2,
      "timeout-ms": 5000,
      "max-steps": CLI_DEFAULTS.maxSteps,
      "judge-model": MODEL_DEFAULTS.judge,
      "compiler-model": undefined,
      profile: undefined,
      "keep-workdirs": true,
      concurrency: 4,
      "async-judge": true,
      "runs-per-task": CLI_DEFAULTS.benchRunsPerTask,
      "adapter-config": "native",
      path: undefined,
      exclude: undefined,
      "dry-run": false,
      manifest: undefined,
      report: undefined,
      "skill-path": undefined,
      lhs: undefined,
      rhs: undefined,
      "output-dir": undefined,
      "analyze-model": undefined,
    })
  })

  test("--skill-mode is a single-value enum", () => {
    expect(parseError(["--skill-mode=bogus"]).message).toBe(
      'bench: invalid --skill-mode "bogus". Valid: inject, discover',
    )
  })

  test("int flags now validate (legacy accepted NaN silently)", () => {
    expect(parseError(["--jit-runs=abc"]).message).toBe('bench: --jit-runs expects an integer, got "abc"')
    expect(parseError(["--max-steps=0"]).message).toBe("bench: --max-steps must be >= 1, got 0")
    expect(parseError(["--concurrency=abc"]).message).toBe('bench: --concurrency expects an integer, got "abc"')
    expect(parseError(["--runs-per-task=0"]).message).toBe("bench: --runs-per-task must be >= 1, got 0")
  })

  test("--help short-circuits", () => {
    expect(BENCH_FLAGS.parse(["--help"])).toEqual({ help: true })
  })
})

describe("runBench — cross-flag rules", () => {
  test("no mode, no --model → required error (after the aot warning prints)", async () => {
    expect((await runErrorQuiet([])).message).toBe("bench: --model is required")
  })

  test("multi-adapter × multi-model is rejected", async () => {
    expect((await runErrorQuiet(["--model=a/b,c/d", "--adapter=bare-agent,opencode"])).message).toBe(
      "bench: cannot combine multiple adapters with multiple models. Use one axis at a time.",
    )
  })

  test("each comma-separated condition is validated", async () => {
    expect((await runError(["--model=a/b", "--conditions=bogus"])).message).toStartWith(
      'bench: unknown condition "bogus". Valid: ',
    )
  })

  test("each comma-separated adapter is validated", async () => {
    expect((await runError(["--model=a/b", "--adapter=bogus"])).message).toBe(
      `bench: unknown adapter "bogus". Valid: ${ALL_ADAPTERS.join(", ")}`,
    )
  })

  // Judge-mode precedence (#77): a bare `--judge` parses as the string
  // "true" (flag layer's bare-flag rule), which used to be taken literally
  // as the manifest directory. `resolveManifestDir` now treats a bare
  // --judge as "mode selected, no directory named" and defers to
  // --manifest; an explicit --judge=<dir> still wins outright.
  test("bare --judge with no --manifest: the now-reachable guard fires", async () => {
    expect((await runError(["--judge"])).message).toBe(
      "bench: --manifest=<dir> is required (directory containing manifest.jsonl)",
    )
  })

  test("--judge= (empty value) does not select judge mode; falls through to matrix mode", async () => {
    expect((await runErrorQuiet(["--judge="])).message).toBe("bench: --model is required")
  })

  describe("resolveManifestDir", () => {
    test("bare --judge (\"true\") defers to --manifest", () => {
      expect(resolveManifestDir("true", "/m")).toBe("/m")
    })

    test("explicit --judge=<dir> wins over --manifest", () => {
      expect(resolveManifestDir("/j", "/m")).toBe("/j")
    })

    test("explicit --judge=<dir> with no --manifest", () => {
      expect(resolveManifestDir("/j", undefined)).toBe("/j")
    })

    test("bare --judge with no --manifest: unresolved (caller's guard fires)", () => {
      expect(resolveManifestDir("true", undefined)).toBeUndefined()
    })
  })

  test("--merge-judge requires --report", async () => {
    expect((await runError(["--merge-judge=./r"])).message).toBe(
      "bench: --report=<path> is required (existing bench report JSON)",
    )
  })

  test("--compare validation matrix (legacy check order, bench: prefix)", async () => {
    expect((await runError(["--compare"])).message).toBe(
      "bench: --model=<id> is required for --compare",
    )
    expect((await runError(["--compare", "--model=a/b"])).message).toBe(
      "bench: --skill-path=<dir> is required for --compare",
    )
    expect((await runError(["--compare", "--model=a/b", "--skill-path=./s"])).message).toBe(
      "bench: --lhs=<condition> and --rhs=<condition> are required for --compare",
    )
    expect((await runError(["--compare", "--model=a/b", "--skill-path=./s", "--lhs=original", "--rhs=no-skill"])).message).toBe(
      "bench: --output-dir=<dir> is required for --compare",
    )
    expect((await runError(["--compare", "--model=a/b", "--skill-path=./s", "--lhs=original", "--rhs=bogus", "--output-dir=./o"])).message).toBe(
      `bench: invalid compare conditions. Valid: ${BENCH_CONDITIONS.join(", ")}, aot-p<N>`,
    )
    expect((await runError(["--compare", "--model=a/b", "--skill-path=./s", "--lhs=original", "--rhs=original", "--output-dir=./o"])).message).toBe(
      "bench: --lhs and --rhs must be different",
    )
  })
})

describe("BENCH_FLAGS.help — generated", () => {
  test("matches the canonical layout (usage block + options + epilogue)", () => {
    expect(BENCH_FLAGS.help()).toBe(
      `skvm bench - Run benchmark across skill optimization conditions

Usage:
  skvm bench --model=<id,...> [options]
  skvm bench --custom=<file.yaml>
  skvm bench --import=<source> [--path=<dir>] [--exclude=<list>] [--dry-run]
  skvm bench --judge=<dir> [--judge-model=<id>] [--concurrency=<n>]
  skvm bench --merge-judge=<results-dir> --report=<path>
  skvm bench --list-sessions
  skvm bench --compare --model=<id> --skill-path=<dir> --lhs=<c> --rhs=<c> --output-dir=<dir>

Options:
  --import=<source>              Import tasks from an external source. Sources: pinchbench, skillsbench
  --judge=<dir>                  Run async LLM judge from a manifest directory (or pass it via --manifest)
  --merge-judge=<results-dir>    Merge async judge results into an existing report (requires --report)
  --list-sessions                List all bench sessions with status
  --compare                      Compare two conditions for a given model, adapter, and skill path
  --custom=<file.yaml>           Run a custom bench plan from a YAML file. Defines task-skill
                                 mappings, models, and adapters in nested groups. Bypasses
                                 the standard condition system entirely.
  --resume=<session>             Resume an interrupted session (or "latest")
  --model=<id,...>               Target model(s), comma-separated.
  --adapter=<name,...>           ${ALL_ADAPTERS.join(" | ")} — comma-separated for
                                 multi-adapter mode (default: ${CLI_DEFAULTS.adapter})
  --tasks=<list>                 Comma-separated task IDs (default: all)
  --source=<name,...>            Filter tasks by origin source(s), comma-separated
                                 (e.g. pinchbench, skillsbench, clawhub)
  --conditions=<list>            no-skill,original,aot-compiled,jit-optimized,jit-boost,aot-compiled-p<N> (default: all)
                                 AOT pass variants: aot-compiled-p1, aot-compiled-p2, aot-compiled-p3, aot-compiled-p12, aot-compiled-p23, etc.
  --skill-mode=<mode>            inject | discover (default: ${CLI_DEFAULTS.skillMode})
  --jit-runs=<n>                 JIT-boost warm-up runs (default: ${CLI_DEFAULTS.jitRuns})
  --timeout-ms=<n>               Absolute override for per-task timeout in ms.
                                 When set, wins over task.json's timeoutMs
                                 (which falls back to ${TIMEOUT_DEFAULTS.taskExec}).
                                 Also caps the jit-boost candidate-generation agent
                                 when --conditions includes jit-boost
                                 (default: ${TIMEOUT_DEFAULTS.candidateGen}).
  --max-steps=<n>                Max agent steps per task.
                                 Uniform across tasks; per-task task.maxSteps is not used in bench. (default: ${CLI_DEFAULTS.maxSteps})
  --judge-model=<id>             LLM judge model (default: ${MODEL_DEFAULTS.judge})
  --compiler-model=<id>          Model for AOT compiler (default: ${MODEL_DEFAULTS.compiler})
  --profile=<path>               TCP JSON path (required for aot conditions)
  --keep-workdirs                Don't delete work directories after runs
  --concurrency=<n>              Parallel task runs (default: ${CLI_DEFAULTS.concurrency}; judge mode default: ${CLI_DEFAULTS.benchJudgeConcurrency}).
                                 In multi-model mode, slots are distributed across models.
  --async-judge                  Run LLM-judge evaluations asynchronously in a post-run batch
                                 (uses --concurrency for parallelism)
  --runs-per-task=<n>            Runs per task-condition pair, averaged to reduce variance (default: ${CLI_DEFAULTS.benchRunsPerTask})
  --adapter-config=<m>           native | managed (default: defaults.adapterConfigMode in skvm.config.json, else managed).
                                 Native uses your real harness config; managed uses providers.routes only.
  --path=<dir>                   Path for import source (default: ~/Projects/<source>)
  --exclude=<list>               Comma-separated task IDs to exclude on import
  --dry-run                      Show what would be imported without writing
  --manifest=<dir>               Manifest directory for judge mode (used when --judge is passed bare)
  --report=<path>                Existing bench report JSON for --merge-judge
  --skill-path=<dir>             Skill directory or SKILL.md path used for --compare
  --lhs=<condition>              Left-hand condition for --compare
  --rhs=<condition>              Right-hand condition for --compare
  --output-dir=<dir>             Required root directory for compare outputs
  --analyze-model=<id>           Optional OpenRouter model for summarizing the skill differences

Examples:
  # Import tasks from PinchBench
  skvm bench --import=pinchbench --path=~/Projects/pinchbench

  # Single model quick test
  skvm bench --model=<id> --tasks=task_00_sanity,task_09_files --conditions=no-skill,original

  # Compare original vs aot-compiled-p1 for one skill directory
  skvm bench --compare --model=<id> --adapter=bare-agent --skill-path=skvm-data/skills/calendar \\
    --lhs=original --rhs=aot-compiled-p1 --output-dir=compare-runs --analyze-model=${MODEL_DEFAULTS.judge}`,
    )
  })
})
