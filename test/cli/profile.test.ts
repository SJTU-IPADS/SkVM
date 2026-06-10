import { describe, test, expect } from "bun:test"
import { PROFILE_FLAGS, runProfile } from "../../src/cli/profile.ts"
import { UsageError } from "../../src/cli/flags.ts"
import { ALL_ADAPTERS } from "../../src/adapters/registry.ts"
import { CLI_DEFAULTS } from "../../src/core/ui-defaults.ts"
import { TIMEOUT_DEFAULTS } from "../../src/core/timeouts.ts"

function parseError(argv: string[]): UsageError {
  try {
    PROFILE_FLAGS.parse(argv)
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError)
    return err as UsageError
  }
  throw new Error(`expected parse(${JSON.stringify(argv)}) to throw UsageError`)
}

async function runError(argv: string[]): Promise<UsageError> {
  const config = PROFILE_FLAGS.parse(argv)
  if (config.help) throw new Error("unexpected help")
  try {
    await runProfile(config)
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError)
    return err as UsageError
  }
  throw new Error(`expected runProfile(${JSON.stringify(argv)}) to throw UsageError`)
}

describe("PROFILE_FLAGS.parse — typed config", () => {
  test("no flags → defaults (model stays undefined; required check is a cross-flag rule)", () => {
    expect(PROFILE_FLAGS.parse([])).toEqual({
      help: false,
      model: undefined,
      adapter: undefined,
      primitives: undefined,
      skip: undefined,
      instances: CLI_DEFAULTS.profileInstances,
      force: false,
      list: false,
      batch: false,
      concurrency: CLI_DEFAULTS.concurrency,
      "adapter-config": undefined,
      "timeout-ms": TIMEOUT_DEFAULTS.taskExec,
    })
  })

  test("sample argv → typed config", () => {
    expect(PROFILE_FLAGS.parse([
      "--model=openrouter/qwen/qwen3-30b,anthropic/claude-sonnet-4.6",
      "--adapter=bare-agent,opencode",
      "--primitives=p1,p2",
      "--skip=p3",
      "--instances=5",
      "--force",
      "--concurrency=4",
      "--adapter-config=native",
      "--timeout-ms=60000",
    ])).toEqual({
      help: false,
      model: "openrouter/qwen/qwen3-30b,anthropic/claude-sonnet-4.6",
      adapter: "bare-agent,opencode",
      primitives: "p1,p2",
      skip: "p3",
      instances: 5,
      force: true,
      list: false,
      batch: false,
      concurrency: 4,
      "adapter-config": "native",
      "timeout-ms": 60000,
    })
  })

  test("--help short-circuits even without --model", () => {
    expect(PROFILE_FLAGS.parse(["--help"])).toEqual({ help: true })
  })

  test("unknown flag is rejected with the legacy wording (issue #12 surface)", () => {
    expect(parseError(["--adpter=opencode", "--model=x/y"]).message).toBe(
      "profile: Unknown flag --adpter. Did you mean --adapter?\n" +
        "Run 'skvm profile --help' for the list of supported flags.",
    )
  })

  test("--instances / --concurrency / --timeout-ms validate as positive integers", () => {
    expect(parseError(["--instances=abc"]).message).toBe('profile: --instances expects an integer, got "abc"')
    expect(parseError(["--concurrency=0"]).message).toBe("profile: --concurrency must be >= 1, got 0")
    expect(parseError(["--timeout-ms=abc"]).message).toBe('profile: --timeout-ms expects an integer, got "abc"')
    expect(parseError(["--timeout-ms=0"]).message).toBe("profile: --timeout-ms must be >= 1, got 0")
  })

  test("--adapter-config is an enum over native | managed", () => {
    expect(parseError(["--adapter-config=bogus"]).message).toBe(
      'profile: invalid --adapter-config "bogus". Valid: native, managed',
    )
  })
})

describe("runProfile — cross-flag rules (typed config, no subprocess)", () => {
  test("missing --model throws the unified required error", async () => {
    expect((await runError([])).message).toBe("profile: --model is required")
  })

  test("--batch still requires --model (pre-existing behavior preserved)", async () => {
    expect((await runError(["--batch"])).message).toBe("profile: --model is required")
  })

  test("each comma-separated --adapter entry is validated against the registry", async () => {
    expect((await runError(["--model=x/y", "--adapter=bare-agent,bogus"])).message).toBe(
      `profile: invalid --adapter "bogus". Valid: ${ALL_ADAPTERS.join(", ")}`,
    )
  })

  test("--list runs in-process (empty test cache → 'No cached profiles.')", async () => {
    // listProfiles() scans PROFILES_DIR and (like the pre-migration CLI)
    // requires it to exist; the bunfig preload points SKVM_CACHE at a fresh
    // temp dir, so create the empty profiles subdir.
    const { PROFILES_DIR } = await import("../../src/core/config.ts")
    const { mkdirSync } = await import("node:fs")
    mkdirSync(PROFILES_DIR, { recursive: true })

    let stdout = ""
    const origLog = console.log
    console.log = (...a: unknown[]) => {
      stdout += a.join(" ") + "\n"
    }
    try {
      const config = PROFILE_FLAGS.parse(["--list"])
      if (config.help) throw new Error("unexpected help")
      await runProfile(config)
    } finally {
      console.log = origLog
    }
    expect(stdout).toBe("No cached profiles.\n")
  })
})

describe("PROFILE_FLAGS.help — generated help text", () => {
  test("matches the canonical layout (usage block + options, defaults auto-appended)", () => {
    expect(PROFILE_FLAGS.help()).toBe(
      `skvm profile - Profile a model's primitive capabilities

Usage:
  skvm profile --model=<id> [options]
  skvm profile --batch [options]

Options:
  --model=<id,...>        Model identifier(s), comma-separated (required unless --batch).
                          Format: <provider>/<model-id> — the <provider> prefix selects
                          a route in providers.routes (see docs/providers.md)
  --adapter=<name,...>    Agent adapter(s), comma-separated: ${ALL_ADAPTERS.join(" | ")}
                          (default: ${CLI_DEFAULTS.adapter}; batch default: all adapters)
  --primitives=<list>     Comma-separated primitive IDs (default: all registered)
  --skip=<list>           Comma-separated primitive IDs to skip
  --instances=<n>         Instances per level (default: ${CLI_DEFAULTS.profileInstances})
  --force                 Ignore cached profile, re-run
  --list                  List cached profiles
  --batch                 Profile all models from bench config
  --concurrency=<n>       Parallel primitives across all model×adapter combos.
                          Slots are distributed per-adapter then per-model. (default: ${CLI_DEFAULTS.concurrency})
  --adapter-config=<m>    native | managed (default: defaults.adapterConfigMode in
                          skvm.config.json, falls back to managed). Native uses your
                          real harness config; managed uses providers.routes only.
  --timeout-ms=<n>        Cap on each microbenchmark probe's adapter execution (ms) (default: ${TIMEOUT_DEFAULTS.taskExec})`,
    )
  })
})
