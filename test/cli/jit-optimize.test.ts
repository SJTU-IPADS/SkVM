import { describe, test, expect } from "bun:test"
import { JIT_OPTIMIZE_FLAGS, runJitOptimize } from "../../src/cli/jit-optimize.ts"
import { UsageError } from "../../src/cli/flags.ts"
import { ALL_ADAPTERS } from "../../src/adapters/registry.ts"
import { CLI_DEFAULTS } from "../../src/core/ui-defaults.ts"

function parseError(argv: string[]): UsageError {
  try {
    JIT_OPTIMIZE_FLAGS.parse(argv)
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError)
    return err as UsageError
  }
  throw new Error(`expected parse(${JSON.stringify(argv)}) to throw UsageError`)
}

/** Drive runJitOptimize far enough to hit a cross-flag UsageError (no execution). */
async function runError(argv: string[]): Promise<UsageError> {
  const config = JIT_OPTIMIZE_FLAGS.parse(argv)
  if (config.help) throw new Error("unexpected help")
  try {
    await runJitOptimize(config)
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError)
    return err as UsageError
  }
  throw new Error(`expected runJitOptimize(${JSON.stringify(argv)}) to throw UsageError`)
}

// A minimal valid synthetic invocation, reused as a base for negative cases.
const BASE = [
  "--skill=/tmp/skill",
  "--task-source=synthetic",
  "--optimizer-model=anthropic/opt",
  "--target-model=anthropic/tgt",
]

describe("JIT_OPTIMIZE_FLAGS.parse — required flags (layer-enforced, legacy precedence)", () => {
  test("--help short-circuits even without required flags", () => {
    expect(JIT_OPTIMIZE_FLAGS.parse(["--help"])).toEqual({ help: true })
  })

  test("skill-or-skill-list is required (requiredUnless)", () => {
    // Was "no skills resolved from --skill or --skill-list" in the handler;
    // now a declarative requiredUnless reported at parse.
    expect(parseError([]).message).toBe(
      "jit-optimize: --skill is required unless --skill-list is given",
    )
  })

  test("required-flag precedence matches the legacy handler order", () => {
    // skill → optimizer-model → task-source → target-model
    expect(parseError(["--skill=/s"]).message).toBe("jit-optimize: --optimizer-model is required")
    expect(parseError(["--skill=/s", "--optimizer-model=anthropic/o"]).message).toBe(
      "jit-optimize: --task-source is required",
    )
    expect(
      parseError(["--skill=/s", "--optimizer-model=anthropic/o", "--task-source=synthetic"]).message,
    ).toBe("jit-optimize: --target-model is required")
  })

  test("--skill-list satisfies the skill requirement", () => {
    // No --skill, but --skill-list present → next missing required flag fires.
    expect(parseError(["--skill-list=/list.txt"]).message).toBe(
      "jit-optimize: --optimizer-model is required",
    )
  })
})

describe("JIT_OPTIMIZE_FLAGS.parse — enums and deprecated aliases", () => {
  test("--task-source is an enum over synthetic | real | log", () => {
    expect(parseError([...BASE.slice(0, 1), "--task-source=bogus", ...BASE.slice(2)]).message).toBe(
      "jit-optimize: invalid --task-source \"bogus\". Valid: synthetic, real, log",
    )
  })

  test("--target-adapter is an enum over the adapter registry", () => {
    expect(parseError([...BASE, "--target-adapter=bogus"]).message).toBe(
      `jit-optimize: invalid --target-adapter "bogus". Valid: ${ALL_ADAPTERS.join(", ")}`,
    )
  })

  test("--model is a deprecated alias of --target-model", () => {
    const config = JIT_OPTIMIZE_FLAGS.parse([
      "--skill=/s",
      "--task-source=synthetic",
      "--optimizer-model=anthropic/o",
      "--model=anthropic/tgt",
    ])
    if (config.help) throw new Error("unexpected help")
    expect(config["target-model"]).toBe("anthropic/tgt")
    expect("model" in config).toBe(false)
  })

  test("--adapter is a deprecated alias of --target-adapter", () => {
    const config = JIT_OPTIMIZE_FLAGS.parse([...BASE, "--adapter=opencode"])
    if (config.help) throw new Error("unexpected help")
    expect(config["target-adapter"]).toBe("opencode")
  })

  test("--compiler-model is a deprecated alias of --optimizer-model", () => {
    const config = JIT_OPTIMIZE_FLAGS.parse([
      "--skill=/s",
      "--task-source=synthetic",
      "--compiler-model=anthropic/o",
      "--target-model=anthropic/tgt",
    ])
    if (config.help) throw new Error("unexpected help")
    expect(config["optimizer-model"]).toBe("anthropic/o")
  })

  test("canonical flag wins over the deprecated alias", () => {
    const config = JIT_OPTIMIZE_FLAGS.parse([
      "--skill=/s",
      "--task-source=synthetic",
      "--optimizer-model=anthropic/o",
      "--target-model=anthropic/canon",
      "--model=anthropic/alias",
    ])
    if (config.help) throw new Error("unexpected help")
    expect(config["target-model"]).toBe("anthropic/canon")
  })

  test("--target-adapter defaults to the CLI default adapter", () => {
    const config = JIT_OPTIMIZE_FLAGS.parse(BASE)
    if (config.help) throw new Error("unexpected help")
    expect(config["target-adapter"]).toBe(CLI_DEFAULTS.adapter)
  })
})

describe("JIT_OPTIMIZE_FLAGS.parse — int validation", () => {
  test("--timeout-ms / --task-concurrency / --synthetic-count validate as ints", () => {
    expect(parseError([...BASE, "--timeout-ms=abc"]).message).toBe(
      'jit-optimize: --timeout-ms expects an integer, got "abc"',
    )
    expect(parseError([...BASE, "--task-concurrency=0"]).message).toBe(
      "jit-optimize: --task-concurrency must be >= 1, got 0",
    )
    expect(parseError([...BASE, "--synthetic-count=0"]).message).toBe(
      "jit-optimize: --synthetic-count must be >= 1, got 0",
    )
  })

  test("forbidden-matrix int flags carry no layer default (undefined === not passed)", () => {
    const config = JIT_OPTIMIZE_FLAGS.parse(BASE)
    if (config.help) throw new Error("unexpected help")
    expect(config["runs-per-task"]).toBeUndefined()
    expect(config["task-concurrency"]).toBeUndefined()
    expect(config["synthetic-count"]).toBeUndefined()
    expect(config.rounds).toBeUndefined()
    // Only --concurrency (batch) carries a layer default.
    expect(config.concurrency).toBe(CLI_DEFAULTS.concurrency)
  })
})

describe("JIT_OPTIMIZE_FLAGS.parse — unknown flag rejection (issue #12 surface)", () => {
  test("typo gets a did-you-mean hint", () => {
    expect(parseError([...BASE, "--rouns=3"]).message).toBe(
      "jit-optimize: Unknown flag --rouns. Did you mean --rounds?\n" +
        "Run 'skvm jit-optimize --help' for the list of supported flags.",
    )
  })
})

describe("runJitOptimize — source-dependent cross-flag rules (hand-coded, typed config)", () => {
  test("--task-source=real requires --tasks", async () => {
    const err = await runError([
      "--skill=/s",
      "--task-source=real",
      "--optimizer-model=anthropic/o",
      "--target-model=anthropic/t",
    ])
    expect(err.message).toBe("jit-optimize: --tasks is required for --task-source=real")
  })

  test("--task-source=log requires --logs", async () => {
    const err = await runError([
      "--skill=/s",
      "--task-source=log",
      "--optimizer-model=anthropic/o",
      "--target-model=anthropic/t",
    ])
    expect(err.message).toBe("jit-optimize: --logs is required for --task-source=log")
  })

  test("source-specific flag from the wrong source is rejected", async () => {
    const err = await runError([...BASE, "--tasks=foo"])
    expect(err.message).toBe(
      "jit-optimize: incompatible flags:\n" +
        "  --tasks is only valid with --task-source=real (got synthetic)",
    )
  })

  test("log source forbids the target-agent loop flags", async () => {
    const err = await runError([
      "--skill=/s",
      "--task-source=log",
      "--logs=/tmp/l.jsonl",
      "--optimizer-model=anthropic/o",
      "--target-model=anthropic/t",
      "--runs-per-task=3",
    ])
    expect(err.message).toBe(
      "jit-optimize: incompatible flags:\n" +
        "  --runs-per-task is not valid with --task-source=log (log source does not rerun tasks)",
    )
  })

  test("log source forbids --baseline (bool, on)", async () => {
    const err = await runError([
      "--skill=/s",
      "--task-source=log",
      "--logs=/tmp/l.jsonl",
      "--optimizer-model=anthropic/o",
      "--target-model=anthropic/t",
      "--baseline",
    ])
    expect(err.message).toBe(
      "jit-optimize: incompatible flags:\n" +
        "  --baseline is not valid with --task-source=log (log source does not rerun tasks)",
    )
  })

  test("--failures count must match --logs count", async () => {
    const err = await runError([
      "--skill=/s",
      "--task-source=log",
      "--logs=/a.jsonl,/b.jsonl",
      "--failures=/only-one.json",
      "--optimizer-model=anthropic/o",
      "--target-model=anthropic/t",
    ])
    expect(err.message).toBe("jit-optimize: --failures count (1) must match --logs count (2)")
  })
})

describe("JIT_OPTIMIZE_FLAGS.help — generated from declarations", () => {
  const help = JIT_OPTIMIZE_FLAGS.help()

  test("required markers, requiredUnless, and defaults render from the spec", () => {
    expect(help).toContain("--optimizer-model=<id>        Optimizer LLM model, shaped as <provider>/<model-id> (required)")
    expect(help).toContain("--task-source=<kind>          Where execution evidence comes from (must be set explicitly) (required)")
    expect(help).toContain("--skill=<path>                Path to skill directory (required unless --skill-list)")
    expect(help).toContain(`--target-adapter=<name>       Target agent adapter: ${ALL_ADAPTERS.join(" | ")} (default: ${CLI_DEFAULTS.adapter})`)
    expect(help).toContain(`--concurrency=<n>             Parallel jobs in --skill-list batch mode (default: ${CLI_DEFAULTS.concurrency})`)
  })

  test("deprecated aliases are hidden from the options list", () => {
    expect(help).not.toContain("--model=")
    expect(help).not.toContain("--adapter=")
    expect(help).not.toContain("--compiler-model")
  })

  test("usage lines and the per-source epilogue render", () => {
    expect(help).toContain("Usage:")
    expect(help).toContain("Per-source inputs (flags from other sources are rejected):")
    expect(help).toContain("--task-source=real        --tasks (required), --test-tasks")
  })
})
