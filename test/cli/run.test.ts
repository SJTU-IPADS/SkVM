import { describe, test, expect } from "bun:test"
import { RUN_FLAGS, runRun } from "../../src/cli/run.ts"
import { UsageError } from "../../src/cli/flags.ts"
import { ALL_ADAPTERS } from "../../src/adapters/registry.ts"
import { CLI_DEFAULTS } from "../../src/core/ui-defaults.ts"
import { TIMEOUT_DEFAULTS } from "../../src/core/timeouts.ts"

function parseError(argv: string[]): UsageError {
  try {
    RUN_FLAGS.parse(argv)
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError)
    return err as UsageError
  }
  throw new Error(`expected parse(${JSON.stringify(argv)}) to throw UsageError`)
}

describe("RUN_FLAGS.parse — typed config", () => {
  test("minimal valid argv → typed config with defaults", () => {
    expect(RUN_FLAGS.parse(["--task=/tmp/task.json", "--model=x/y"])).toEqual({
      help: false,
      task: "/tmp/task.json",
      model: "x/y",
      skill: undefined,
      "skill-mode": undefined,
      adapter: CLI_DEFAULTS.adapter,
      workdir: undefined,
      "timeout-ms": undefined,
      "max-steps": undefined,
      "adapter-config": undefined,
    })
  })

  test("full argv → typed config", () => {
    expect(RUN_FLAGS.parse([
      "--task=/tmp/task.json",
      "--model=anthropic/claude-sonnet-4.6",
      "--skill=/tmp/SKILL.md",
      "--skill-mode=discover",
      "--adapter=opencode",
      "--workdir=/tmp/wd",
      "--timeout-ms=90000",
      "--max-steps=12",
      "--adapter-config=managed",
    ])).toEqual({
      help: false,
      task: "/tmp/task.json",
      model: "anthropic/claude-sonnet-4.6",
      skill: "/tmp/SKILL.md",
      "skill-mode": "discover",
      adapter: "opencode",
      workdir: "/tmp/wd",
      "timeout-ms": 90000,
      "max-steps": 12,
      "adapter-config": "managed",
    })
  })

  test("--help short-circuits even without the required flags", () => {
    expect(RUN_FLAGS.parse(["--help"])).toEqual({ help: true })
  })

  test("required flags use the layer's unified wording (--task first, then --model)", () => {
    expect(parseError([]).message).toBe("run: --task is required")
    expect(parseError(["--task=/tmp/task.json"]).message).toBe("run: --model is required")
  })

  test("--adapter is an enum over the adapter registry", () => {
    expect(parseError(["--task=t", "--model=m", "--adapter=bogus"]).message).toBe(
      `run: invalid --adapter "bogus". Valid: ${ALL_ADAPTERS.join(", ")}`,
    )
  })

  test("--skill-mode is an enum over inject | discover", () => {
    expect(parseError(["--task=t", "--model=m", "--skill-mode=bogus"]).message).toBe(
      'run: invalid --skill-mode "bogus". Valid: inject, discover',
    )
  })

  test("--timeout-ms / --max-steps validate as positive integers", () => {
    expect(parseError(["--task=t", "--model=m", "--timeout-ms=0"]).message).toBe(
      "run: --timeout-ms must be >= 1, got 0",
    )
    expect(parseError(["--task=t", "--model=m", "--max-steps=abc"]).message).toBe(
      'run: --max-steps expects an integer, got "abc"',
    )
  })

  test("unknown flag is rejected with the legacy wording (issue #12 surface)", () => {
    expect(parseError(["--tsk=foo.json", "--model=x/y"]).message).toBe(
      "run: Unknown flag --tsk. Did you mean --task?\n" +
        "Run 'skvm run --help' for the list of supported flags.",
    )
  })
})

describe("runRun — cross-flag rules (typed config, no subprocess)", () => {
  test("--skill-mode without --skill throws before any execution", async () => {
    const config = RUN_FLAGS.parse(["--task=/tmp/task.json", "--model=x/y", "--skill-mode=inject"])
    if (config.help) throw new Error("unexpected help")
    try {
      await runRun(config)
      throw new Error("expected UsageError")
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError)
      expect((err as UsageError).message).toBe("run: --skill-mode requires --skill to also be specified")
    }
  })
})

describe("RUN_FLAGS.help — generated help text", () => {
  test("matches the canonical layout (usage + options + notes epilogue)", () => {
    expect(RUN_FLAGS.help()).toBe(
      `skvm run - Run one task with an optional user-specified skill

Usage:
  skvm run --task=<path/to/task.json> --model=<id> [options]
  skvm run --task=<path/to/task.json> --skill=<path/to/SKILL.md> --model=<id> [options]

Options:
  --task=<path>           Path to a task JSON file (bench task schema) (required)
  --model=<id>            Model identifier, <provider>/<model-id> (required)
  --skill=<path>          Optional path to a SKILL.md file
  --skill-mode=<mode>     inject | discover (default: inject).
                          Requires --skill. inject: skill text is concatenated
                          into the system prompt. discover: skill is written
                          to .claude/skills/<name>/ and discovered via its
                          SKILL.md description.
  --adapter=<name>        Agent adapter: ${ALL_ADAPTERS.join(" | ")} (default: ${CLI_DEFAULTS.adapter})
  --workdir=<path>        Use this directory instead of a temp work directory
  --timeout-ms=<n>        Override the per-task agent execution timeout (ms).
                          This caps how long the target adapter spends solving
                          one task. Falls back to task.json's \`timeoutMs\`,
                          then to the built-in default (${TIMEOUT_DEFAULTS.taskExec}).
  --max-steps=<n>         Override max steps for the adapter
  --adapter-config=<m>    native | managed (default: from skvm.config.json, else managed)

Notes:
  - This command executes only. It does not run evaluation or scoring.
  - Task files use the bench task.json shape, but eval is optional here.
  - Any files under the task's fixtures/ directory are copied into the workDir before execution.`,
    )
  })
})
