import { describe, test, expect } from "bun:test"
import { COMPILE_FLAGS, runCompile } from "../../src/cli/aot-compile.ts"
import { UsageError } from "../../src/cli/flags.ts"
import { ALL_ADAPTERS } from "../../src/adapters/registry.ts"
import { CLI_DEFAULTS, MODEL_DEFAULTS } from "../../src/core/ui-defaults.ts"
import { TIMEOUT_DEFAULTS } from "../../src/core/timeouts.ts"

function parseError(argv: string[]): UsageError {
  try {
    COMPILE_FLAGS.parse(argv)
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError)
    return err as UsageError
  }
  throw new Error(`expected parse(${JSON.stringify(argv)}) to throw UsageError`)
}

async function runError(argv: string[]): Promise<UsageError> {
  const config = COMPILE_FLAGS.parse(argv)
  if (config.help) throw new Error("unexpected help")
  try {
    await runCompile(config)
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError)
    return err as UsageError
  }
  throw new Error(`expected runCompile(${JSON.stringify(argv)}) to throw UsageError`)
}

describe("COMPILE_FLAGS.parse", () => {
  test("sample argv → typed config", () => {
    expect(COMPILE_FLAGS.parse([
      "--skill=./s", "--model=a/b,c/d", "--adapter=pi,opencode",
      "--pass=1,3", "--concurrency=4", "--dry-run",
      "--compiler-model=x/comp", "--timeout-ms=5000",
    ])).toEqual({
      help: false,
      skill: "./s",
      model: "a/b,c/d",
      adapter: "pi,opencode",
      profile: undefined,
      pass: "1,3",
      "list-passes": false,
      concurrency: 4,
      "dry-run": true,
      "compiler-model": "x/comp",
      "timeout-ms": 5000,
    })
  })

  test("no flags → defaults (skill/model undefined: required is a cross-flag rule)", () => {
    expect(COMPILE_FLAGS.parse([])).toEqual({
      help: false,
      skill: undefined,
      model: undefined,
      adapter: undefined,
      profile: undefined,
      pass: undefined,
      "list-passes": false,
      concurrency: CLI_DEFAULTS.concurrency,
      "dry-run": false,
      "compiler-model": MODEL_DEFAULTS.compiler,
      "timeout-ms": undefined,
    })
  })

  test("--concurrency now validates (legacy accepted NaN silently)", () => {
    expect(parseError(["--concurrency=abc"]).message).toBe('aot-compile: --concurrency expects an integer, got "abc"')
    expect(parseError(["--concurrency=0"]).message).toBe("aot-compile: --concurrency must be >= 1, got 0")
  })

  test("--timeout-ms must be a positive integer", () => {
    expect(parseError(["--timeout-ms=0"]).message).toBe("aot-compile: --timeout-ms must be >= 1, got 0")
  })

  test("--help short-circuits", () => {
    expect(COMPILE_FLAGS.parse(["--help"])).toEqual({ help: true })
  })
})

describe("runCompile — cross-flag rules", () => {
  test("missing --skill/--model throws the combined required error", async () => {
    expect((await runError([])).message).toBe("aot-compile: --skill and --model are required")
    expect((await runError(["--skill=./s"])).message).toBe("aot-compile: --skill and --model are required")
  })

  test("each comma-separated --adapter entry is validated", async () => {
    expect((await runError(["--skill=./s", "--model=x/y", "--adapter=bogus"])).message).toBe(
      `aot-compile: invalid --adapter "bogus". Valid: ${ALL_ADAPTERS.join(", ")}`,
    )
  })

  test("--profile is single-job only", async () => {
    expect((await runError(["--skill=./s", "--model=a/b,c/d", "--profile=./tcp.json"])).message).toBe(
      "aot-compile: --profile flag only supported for single model + single adapter",
    )
  })

  test("nonexistent skill path throws (was console.error+exit)", async () => {
    // Capture console.log: the banner prints before skill resolution.
    const origLog = console.log
    console.log = () => {}
    try {
      const err = await runError(["--skill=/nonexistent/skill", "--model=x/y"])
      expect(err.message).toStartWith("aot-compile: skill not found: /nonexistent/skill")
    } finally {
      console.log = origLog
    }
  })

  test("missing profiles for a loadable skill throw the combined UsageError", async () => {
    const { mkdtempSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const path = await import("node:path")
    const skillDir = mkdtempSync(path.join(tmpdir(), "skvm-aot-missing-profile-"))
    await Bun.write(path.join(skillDir, "SKILL.md"), "# minimal skill\n")

    // Capture console.log: the banner prints before profile loading. The
    // preload redirects SKVM_CACHE to a temp dir, so the profile cache is
    // guaranteed empty here.
    const origLog = console.log
    console.log = () => {}
    try {
      const err = await runError([`--skill=${skillDir}`, "--model=x/y"])
      expect(err.message).toStartWith("aot-compile: missing profiles:")
      expect(err.message).toContain("Run 'skvm profile' first.")
    } finally {
      console.log = origLog
    }
  })

  test("--list-passes short-circuits without requiring --skill/--model", async () => {
    const config = COMPILE_FLAGS.parse(["--list-passes"])
    if (config.help) throw new Error("unexpected help")
    let stdout = ""
    const origLog = console.log
    console.log = (...a: unknown[]) => { stdout += a.join(" ") + "\n" }
    try {
      await runCompile(config)
    } finally {
      console.log = origLog
    }
    expect(stdout.length).toBeGreaterThan(0)   // pass registry printed
  })
})

describe("COMPILE_FLAGS.help — generated", () => {
  test("matches the canonical layout (usage block + options, no epilogue)", () => {
    expect(COMPILE_FLAGS.help()).toBe(
      `skvm aot-compile - AOT-compile skill(s) for target model(s)

Usage:
  skvm aot-compile --skill=<id,...> --model=<id,...> [options]

Options:
  --skill=<id,...>         Skill name(s) or path(s), comma-separated (required)
  --model=<id,...>         Target model(s), comma-separated (required)
  --adapter=<name,...>     Harness name(s), comma-separated (${ALL_ADAPTERS.join(" | ")}; default: ${CLI_DEFAULTS.adapter})
  --profile=<path>         Path to TCP JSON (single-job only; default: load from cache)
  --pass=<list>            Compiler passes, comma-separated (numeric or string ids; see --list-passes
                           for the registry). Default: ${CLI_DEFAULTS.compilerPasses.join(",")}
  --list-passes            Print the pass registry and exit
  --concurrency=<n>        Parallel compilations (default: ${CLI_DEFAULTS.concurrency})
  --dry-run                Show plan without applying
  --compiler-model=<id>    Compiler model via OpenRouter (default: ${MODEL_DEFAULTS.compiler})
  --timeout-ms=<n>         Cap on the compiler agent loop (Pass 1, rewrite-skill)
                           while it edits SKILL.md (ms). Default: ${TIMEOUT_DEFAULTS.compiler}.`,
    )
  })
})
