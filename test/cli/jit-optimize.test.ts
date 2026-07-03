import { describe, test, expect } from "bun:test"
import {
  JIT_OPTIMIZE_FLAGS,
  runJitOptimize,
  buildTaskSource,
  validateFlagsForSource,
  type JitOptimizeConfig,
} from "../../src/cli/jit-optimize.ts"
import { UsageError } from "../../src/cli/flags.ts"
import { ALL_ADAPTERS } from "../../src/adapters/registry.ts"
import { CLI_DEFAULTS } from "../../src/core/ui-defaults.ts"
import { TIMEOUT_DEFAULTS } from "../../src/core/timeouts.ts"
import type { TaskSource } from "../../src/jit-optimize/types.ts"

function parse(argv: string[]): JitOptimizeConfig {
  const config = JIT_OPTIMIZE_FLAGS.parse(argv)
  if (config.help) throw new Error("unexpected help")
  return config
}

function parseError(argv: string[]): UsageError {
  try {
    JIT_OPTIMIZE_FLAGS.parse(argv)
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError)
    return err as UsageError
  }
  throw new Error(`expected parse(${JSON.stringify(argv)}) to throw UsageError`)
}

async function runError(argv: string[]): Promise<UsageError> {
  const config = parse(argv)
  try {
    await runJitOptimize(config)
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError)
    return err as UsageError
  }
  throw new Error(`expected runJitOptimize(${JSON.stringify(argv)}) to throw UsageError`)
}

function buildError(argv: string[]): UsageError {
  try {
    buildTaskSource(parse(argv))
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError)
    return err as UsageError
  }
  throw new Error(`expected buildTaskSource(${JSON.stringify(argv)}) to throw UsageError`)
}

function validateError(argv: string[], kind: TaskSource["kind"]): UsageError {
  try {
    validateFlagsForSource(parse(argv), kind)
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError)
    return err as UsageError
  }
  throw new Error(`expected validateFlagsForSource(${JSON.stringify(argv)}, ${kind}) to throw UsageError`)
}

describe("JIT_OPTIMIZE_FLAGS.parse", () => {
  test("no flags → typed defaults (config-shape lock)", () => {
    // Source-specific and log-forbidden flags deliberately have NO layer
    // defaults: validateFlagsForSource tests presence (!== undefined), so
    // their defaults are applied in the handler after the compatibility
    // check. Only presence-insensitive flags carry layer defaults.
    expect(JIT_OPTIMIZE_FLAGS.parse([])).toEqual({
      help: false,
      // Skill selection
      skill: undefined,
      "skill-list": undefined,
      "skill-mode": undefined,
      // Source kind + per-source inputs
      "task-source": undefined,
      "synthetic-count": undefined,
      "synthetic-test-count": undefined,
      tasks: undefined,
      "test-tasks": undefined,
      logs: undefined,
      failures: undefined,
      // Target & optimizer
      "optimizer-model": undefined,
      "target-model": undefined,
      "target-adapter": CLI_DEFAULTS.adapter,
      // Loop
      rounds: undefined,
      "runs-per-task": undefined,
      "task-concurrency": undefined,
      convergence: undefined,
      baseline: false,
      // Delivery
      "no-keep-all-rounds": false,
      "auto-apply": false,
      // Batch
      concurrency: CLI_DEFAULTS.concurrency,
      // Adapter mode
      "adapter-config": undefined,
      // Per-agent-loop overrides
      "timeout-ms": undefined,
      "max-steps": undefined,
      // Detached invocation
      detach: false,
    })
  })

  test("sample argv → typed config", () => {
    expect(JIT_OPTIMIZE_FLAGS.parse([
      "--skill=./s", "--task-source=synthetic", "--optimizer-model=o/m",
      "--target-model=t/m", "--synthetic-count=5", "--rounds=2",
      "--convergence=0.9", "--baseline", "--auto-apply",
      "--timeout-ms=5000", "--max-steps=30",
    ])).toEqual({
      help: false,
      skill: "./s",
      "skill-list": undefined,
      "skill-mode": undefined,
      "task-source": "synthetic",
      "synthetic-count": 5,
      "synthetic-test-count": undefined,
      tasks: undefined,
      "test-tasks": undefined,
      logs: undefined,
      failures: undefined,
      "optimizer-model": "o/m",
      "target-model": "t/m",
      "target-adapter": CLI_DEFAULTS.adapter,
      rounds: 2,
      "runs-per-task": undefined,
      "task-concurrency": undefined,
      convergence: 0.9,
      baseline: true,
      "no-keep-all-rounds": false,
      "auto-apply": true,
      concurrency: CLI_DEFAULTS.concurrency,
      "adapter-config": undefined,
      "timeout-ms": 5000,
      "max-steps": 30,
      detach: false,
    })
  })

  test("deprecated aliases map onto their canonical flags", () => {
    expect(parse(["--model=x/y"])["target-model"]).toBe("x/y")
    expect(parse(["--adapter=opencode"])["target-adapter"]).toBe("opencode")
    expect(parse(["--compiler-model=o/m"])["optimizer-model"]).toBe("o/m")
  })

  test("canonical flag wins when both canonical and alias are given", () => {
    expect(parse(["--target-model=a/b", "--model=c/d"])["target-model"]).toBe("a/b")
  })

  test("--convergence is a validated float in [0, 1]", () => {
    expect(parse(["--convergence=0.5"]).convergence).toBe(0.5)
    expect(parseError(["--convergence=abc"]).message).toBe(
      'jit-optimize: --convergence expects a number, got "abc"',
    )
    expect(parseError(["--convergence=1.5"]).message).toBe(
      "jit-optimize: --convergence must be <= 1, got 1.5",
    )
  })

  test("--target-adapter enum error keeps the legacy wording", () => {
    expect(parseError(["--target-adapter=bogus"]).message).toBe(
      `jit-optimize: invalid --target-adapter "bogus". Valid: ${ALL_ADAPTERS.join(", ")}`,
    )
  })

  test("--help short-circuits", () => {
    expect(JIT_OPTIMIZE_FLAGS.parse(["--help"])).toEqual({ help: true })
  })
})

describe("buildTaskSource", () => {
  test("synthetic: count defaults applied in the builder, not the layer", () => {
    expect(buildTaskSource(parse(["--task-source=synthetic"]))).toEqual({
      kind: "synthetic-task",
      trainCount: CLI_DEFAULTS.syntheticTrainCount,
      testCount: CLI_DEFAULTS.syntheticTestCount,
    })
  })

  test("long-form kind aliases are accepted (synthetic-task / real-task / execution-log)", () => {
    expect(buildTaskSource(parse(["--task-source=synthetic-task"])).kind).toBe("synthetic-task")
    expect(
      buildTaskSource(parse(["--task-source=real-task", "--tasks=a", "--test-tasks=b"])).kind,
    ).toBe("real-task")
    expect(buildTaskSource(parse(["--task-source=execution-log", "--logs=a"])).kind).toBe("execution-log")
  })

  test("real: splits train/test task lists", () => {
    expect(buildTaskSource(parse(["--task-source=real", "--tasks=a, b", "--test-tasks=c"]))).toEqual({
      kind: "real-task",
      trainTasks: ["a", "b"],
      testTasks: ["c"],
    })
  })

  test("real without --test-tasks reuses train as test (warns)", () => {
    // The no-holdout warning goes through createLogger().warn → console.warn;
    // capture it so test output stays clean. The log line itself is not
    // asserted — only the fallback shape.
    const origWarn = console.warn
    console.warn = () => {}
    try {
      expect(buildTaskSource(parse(["--task-source=real", "--tasks=a,b"]))).toEqual({
        kind: "real-task",
        trainTasks: ["a", "b"],
        testTasks: undefined,
      })
    } finally {
      console.warn = origWarn
    }
  })

  test("log: pairs --failures with --logs positionally as criteriaPath (fixed per #76)", () => {
    expect(buildTaskSource(parse(["--task-source=log", "--logs=a,b", "--failures=x,y"]))).toEqual({
      kind: "execution-log",
      logs: [
        { path: "a", criteriaPath: "x" },
        { path: "b", criteriaPath: "y" },
      ],
    })
  })

  test("log: --failures count must match --logs count", () => {
    expect(buildError(["--task-source=log", "--logs=a,b", "--failures=x"]).message).toBe(
      "jit-optimize: --failures count (1) must match --logs count (2)",
    )
  })

  test("missing --task-source throws", () => {
    expect(buildError([]).message).toBe(
      "jit-optimize: --task-source is required (one of: synthetic | real | log)",
    )
  })

  test("unknown --task-source throws", () => {
    expect(buildError(["--task-source=bogus"]).message).toBe(
      'jit-optimize: unknown --task-source "bogus" (expected synthetic | real | log)',
    )
  })

  test("real without --tasks throws", () => {
    expect(buildError(["--task-source=real"]).message).toBe(
      "jit-optimize: --tasks is required for --task-source=real",
    )
  })

  test("log without --logs throws", () => {
    expect(buildError(["--task-source=log"]).message).toBe(
      "jit-optimize: --logs is required for --task-source=log",
    )
  })
})

describe("validateFlagsForSource", () => {
  test("source-specific flag with the wrong source is rejected", () => {
    expect(validateError(["--synthetic-count=3"], "real-task").message).toContain(
      "--synthetic-count is only valid with --task-source=synthetic (got real)",
    )
  })

  test("target-adapter flags are forbidden for the log source", () => {
    expect(validateError(["--runs-per-task=2"], "execution-log").message).toContain(
      "--runs-per-task is not valid with --task-source=log (log source does not rerun tasks)",
    )
  })

  test("bare --baseline with the log source is caught", () => {
    expect(validateError(["--baseline"], "execution-log").message).toContain(
      "--baseline is not valid with --task-source=log (log source does not rerun tasks)",
    )
  })

  test("--baseline=false is indistinguishable from omitting it (bool-flag deviation from legacy)", () => {
    // Ledger-class deviation: legacy stored raw strings, so any --baseline
    // spelling (including --baseline=false) counted as "passed" and was
    // rejected for log. The bool flag parses to false either way, so only
    // --baseline / --baseline=true can be detected post-parse.
    expect(() =>
      validateFlagsForSource(parse(["--baseline=false"]), "execution-log"),
    ).not.toThrow()
  })

  test("multiple incompatible flags accumulate into one error", () => {
    expect(validateError(["--tasks=a", "--runs-per-task=2", "--baseline"], "execution-log").message).toBe(
      "jit-optimize: incompatible flags:\n" +
      "  --tasks is only valid with --task-source=real (got log)\n" +
      "  --runs-per-task is not valid with --task-source=log (log source does not rerun tasks)\n" +
      "  --baseline is not valid with --task-source=log (log source does not rerun tasks)",
    )
  })

  test("clean configs pass", () => {
    expect(() =>
      validateFlagsForSource(
        parse(["--task-source=synthetic", "--synthetic-count=2", "--runs-per-task=3", "--baseline"]),
        "synthetic-task",
      ),
    ).not.toThrow()
    expect(() =>
      validateFlagsForSource(parse(["--task-source=log", "--logs=a", "--failures=x"]), "execution-log"),
    ).not.toThrow()
    expect(() =>
      validateFlagsForSource(parse(["--task-source=real", "--tasks=a", "--test-tasks=b"]), "real-task"),
    ).not.toThrow()
  })
})

describe("runJitOptimize — cross-flag rules (legacy check order)", () => {
  // None of these reach the banner: skills → optimizer-model → buildTaskSource
  // → validateFlagsForSource → target-model all throw before any output.
  test("no --skill / --skill-list → no skills resolved", async () => {
    expect((await runError(["--task-source=synthetic"])).message).toBe(
      "jit-optimize: no skills resolved from --skill or --skill-list",
    )
  })

  test("--optimizer-model is required (checked before the task source is built)", async () => {
    expect((await runError(["--skill=/tmp/s", "--task-source=synthetic"])).message).toBe(
      "jit-optimize: --optimizer-model is required",
    )
  })

  test("--target-model is required, named per source", async () => {
    expect((await runError(["--skill=/tmp/s", "--task-source=synthetic", "--optimizer-model=o/m"])).message).toBe(
      "jit-optimize: --target-model is required for task-source=synthetic",
    )
  })
})

describe("JIT_OPTIMIZE_FLAGS.help — generated", () => {
  test("matches the canonical layout (usage block + options + epilogue)", () => {
    // Deprecated aliases (--model, --adapter, --compiler-model) must NOT
    // appear as option rows — the layer hides them; the epilogue documents them.
    expect(JIT_OPTIMIZE_FLAGS.help()).toBe(
      `skvm jit-optimize - Optimize a skill based on execution evidence

Usage:
  skvm jit-optimize --skill=<path> --task-source=<kind> [options]
  skvm jit-optimize --skill-list=<file> --task-source=<kind> [--concurrency=<n>] [options]

Options:
  --skill=<path>                Path to skill directory (or --skill-list)
  --skill-list=<file>           One skill path per line (batch mode)
  --skill-mode=<mode>           inject | discover (default: ${CLI_DEFAULTS.skillMode}). Controls how the skill
                                is loaded into each per-task adapter run during optimization.
  --task-source=<kind>          synthetic | real | log   (must be set explicitly)
  --synthetic-count=<n>         Train tasks to generate (synthetic only; default: ${CLI_DEFAULTS.syntheticTrainCount})
  --synthetic-test-count=<n>    Held-out test tasks to generate (synthetic only; default: ${CLI_DEFAULTS.syntheticTestCount})
  --tasks=<id|path,...>         Train tasks — IDs or task.json paths (real only, required)
  --test-tasks=<id|path,...>    Held-out test tasks (real only). If omitted, --tasks is used as
                                both train and test (fallback for small task lists).
  --logs=<path,...>             Conversation log files, comma-separated (log only, required)
  --failures=<path,...>         Per-log failure JSON files, same order (log only, optional).
                                Each file holds EvidenceCriterion[] evidence for its log.
  --optimizer-model=<id>        Optimizer LLM model, shaped as <provider>/<model-id> (required)
  --target-model=<id>           Target model being optimized for (required for every source;
                                for log it is the storage key of the proposal)
  --target-adapter=<name>       ${ALL_ADAPTERS.join(" | ")} (default: ${CLI_DEFAULTS.adapter})
  --rounds=<n>                  Max optimization rounds (default: 1 for log, 3 otherwise)
  --runs-per-task=<n>           Runs per task per round (default: ${CLI_DEFAULTS.jitOptimizeRunsPerTask}; forbidden for log)
  --task-concurrency=<n>        Max parallel in-flight task runs per round (default: ${CLI_DEFAULTS.jitOptimizeTaskConcurrency};
                                forbidden for log). Train + test share the same limiter.
  --convergence=<0-1>           Early-exit threshold on primary score (default: 0.95; forbidden for log)
  --baseline                    Run no-skill/original conditions for comparison (forbidden for log)
  --no-keep-all-rounds          Keep only the best round's folder (default: keep all)
  --auto-apply                  Overwrite original skillDir with best round
  --concurrency=<n>             Parallel jobs (batch mode) (default: ${CLI_DEFAULTS.concurrency})
  --adapter-config=<m>          native | managed (default: defaults.adapterConfigMode in
                                skvm.config.json, else managed)
  --timeout-ms=<n>              Per-agent-loop ceiling for this jit-optimize run (ms).
                                Defaults: task ${TIMEOUT_DEFAULTS.taskExec}, optimizer ${TIMEOUT_DEFAULTS.optimizer}, task-gen ${TIMEOUT_DEFAULTS.taskGen},
                                synthetic task exec ${TIMEOUT_DEFAULTS.syntheticTaskExec}. Per-loop ceiling, not total wall time.
  --max-steps=<n>               Override max agent steps per task. When omitted,
                                each task's own maxSteps is honored.
  --detach                      Spawn a background worker and return as soon as it reports its
                                proposal id. Single-skill only. Track with 'skvm proposals show <id>'.

Deprecated aliases: --model → --target-model, --adapter → --target-adapter,
--compiler-model → --optimizer-model.`,
    )
  })
})
