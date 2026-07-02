import { describe, test, expect } from "bun:test"
import { PIPELINE_FLAGS } from "../../src/cli/pipeline.ts"
import { UsageError } from "../../src/cli/flags.ts"
import { ALL_ADAPTERS } from "../../src/adapters/registry.ts"
import { CLI_DEFAULTS, MODEL_DEFAULTS } from "../../src/core/ui-defaults.ts"
import { TIMEOUT_DEFAULTS } from "../../src/core/timeouts.ts"

function parseError(argv: string[]): UsageError {
  try {
    PIPELINE_FLAGS.parse(argv)
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError)
    return err as UsageError
  }
  throw new Error(`expected parse(${JSON.stringify(argv)}) to throw UsageError`)
}

describe("PIPELINE_FLAGS.parse", () => {
  test("--skill and --model are required at the layer (no short-circuit flags)", () => {
    expect(parseError(["--model=x/y"]).message).toBe("pipeline: --skill is required")
    expect(parseError(["--skill=./s"]).message).toBe("pipeline: --model is required")
  })

  test("sample argv → typed config", () => {
    expect(PIPELINE_FLAGS.parse(["--skill=./s", "--model=x/y", "--force-profile", "--timeout-ms=5000"])).toEqual({
      help: false,
      skill: "./s",
      model: "x/y",
      adapter: CLI_DEFAULTS.adapter,
      "force-profile": true,
      profile: undefined,
      pass: undefined,
      "compiler-model": MODEL_DEFAULTS.compiler,
      "dry-run": false,
      "adapter-config": undefined,
      "timeout-ms": 5000,
    })
  })

  test("fuller argv → typed config", () => {
    expect(PIPELINE_FLAGS.parse([
      "--skill=./s", "--model=x/y", "--adapter=pi", "--profile=./tcp.json",
      "--pass=1,3", "--compiler-model=c/m", "--dry-run", "--adapter-config=native",
    ])).toEqual({
      help: false,
      skill: "./s",
      model: "x/y",
      adapter: "pi",
      "force-profile": false,
      profile: "./tcp.json",
      pass: "1,3",
      "compiler-model": "c/m",
      "dry-run": true,
      "adapter-config": "native",
      "timeout-ms": undefined,
    })
  })

  test("--adapter is a single-value enum", () => {
    expect(parseError(["--skill=./s", "--model=x/y", "--adapter=bogus"]).message).toBe(
      `pipeline: invalid --adapter "bogus". Valid: ${ALL_ADAPTERS.join(", ")}`,
    )
  })

  test("--timeout-ms must be a positive integer", () => {
    expect(parseError(["--skill=./s", "--model=x/y", "--timeout-ms=0"]).message).toBe(
      "pipeline: --timeout-ms must be >= 1, got 0",
    )
  })

  test("--help short-circuits required flags", () => {
    expect(PIPELINE_FLAGS.parse(["--help"])).toEqual({ help: true })
  })

  test("generated help documents --adapter-config (fixes help drift)", () => {
    expect(PIPELINE_FLAGS.help()).toContain("--adapter-config")
  })
})

describe("PIPELINE_FLAGS.help — generated", () => {
  test("matches the canonical layout (usage block + options, no epilogue)", () => {
    expect(PIPELINE_FLAGS.help()).toBe(
      `skvm pipeline - Profile (if needed) then compile a skill for a target model

Usage:
  skvm pipeline --skill=<path> --model=<id> [options]

Options:
  --skill=<path>           Path to skill directory or SKILL.md (required)
  --model=<id>             Target model (required)
  --adapter=<name>         Harness: ${ALL_ADAPTERS.join(" | ")} (default: ${CLI_DEFAULTS.adapter})
  --force-profile          Re-profile even if cached
  --profile=<path>         Use specific TCP file (skip auto-profiling)
  --pass=<list>            Compiler passes, comma-separated (default: ${CLI_DEFAULTS.compilerPasses.join(",")})
  --compiler-model=<id>    Compiler model via OpenRouter (default: ${MODEL_DEFAULTS.compiler})
  --dry-run                Show compilation plan without writing
  --adapter-config=<m>     native | managed (default: defaults.adapterConfigMode in
                           skvm.config.json, falls back to managed)
  --timeout-ms=<n>         Per-agent-loop ceiling for this pipeline run (ms).
                           Applies to BOTH the profile stage's per-probe agent
                           execution AND the compiler agent loop. Each is timed
                           independently — this is a per-loop ceiling, not a
                           total wall time.
                           Default: ${TIMEOUT_DEFAULTS.taskExec} for profile,
                           ${TIMEOUT_DEFAULTS.compiler} for compiler.`,
    )
  })
})
