import { describe, test, expect } from "bun:test"
import { CLEAN_JIT_FLAGS, runCleanJIT } from "../../src/cli/clean-jit.ts"
import { UsageError } from "../../src/cli/flags.ts"
import { ALL_ADAPTERS } from "../../src/adapters/registry.ts"

function parseError(argv: string[]): UsageError {
  try {
    CLEAN_JIT_FLAGS.parse(argv)
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError)
    return err as UsageError
  }
  throw new Error(`expected parse(${JSON.stringify(argv)}) to throw UsageError`)
}

describe("CLEAN_JIT_FLAGS.parse — typed config", () => {
  test("sample argv → typed config", () => {
    expect(CLEAN_JIT_FLAGS.parse([
      "--model=openrouter/qwen/qwen3-30b", "--adapter=bare-agent",
      "--dry-run", "--include-bench-logs",
    ])).toEqual({
      help: false,
      model: "openrouter/qwen/qwen3-30b",
      adapter: "bare-agent",
      "dry-run": true,
      yes: false,
      "include-bench-logs": true,
    })
  })

  test("--model and --adapter are required at the layer", () => {
    expect(parseError(["--adapter=bare-agent"]).message).toBe("clean-jit: --model is required")
    expect(parseError(["--model=x/y"]).message).toBe("clean-jit: --adapter is required")
  })

  test("--adapter is an enum over the adapter registry", () => {
    expect(parseError(["--model=x/y", "--adapter=bogus"]).message).toBe(
      `clean-jit: invalid --adapter "bogus". Valid: ${ALL_ADAPTERS.join(", ")}`,
    )
  })

  test("unknown flag rejected with typo hint", () => {
    expect(parseError(["--model=x/y", "--adapter=pi", "--dryrun"]).message).toBe(
      "clean-jit: Unknown flag --dryrun. Did you mean --dry-run?\n" +
        "Run 'skvm clean-jit --help' for the list of supported flags.",
    )
  })

  test("--help short-circuits required flags", () => {
    expect(CLEAN_JIT_FLAGS.parse(["--help"])).toEqual({ help: true })
  })
})

describe("runCleanJIT — cross-flag rules", () => {
  test("without --dry-run and without --yes: refuses before deleting", async () => {
    const config = CLEAN_JIT_FLAGS.parse(["--model=x/y", "--adapter=bare-agent"])
    if (config.help) throw new Error("unexpected help")
    let err: unknown
    const origLog = console.log
    console.log = () => {}
    try {
      await runCleanJIT(config)
    } catch (e) {
      err = e
    } finally {
      console.log = origLog
    }
    expect(err).toBeInstanceOf(UsageError)
    expect((err as UsageError).message).toBe(
      "\nRefusing to delete without --yes. Re-run with --dry-run first, then add --yes.",
    )
  })

  test("--dry-run on an empty cache prints the plan and deletes nothing", async () => {
    const config = CLEAN_JIT_FLAGS.parse(["--model=x/y", "--adapter=bare-agent", "--dry-run"])
    if (config.help) throw new Error("unexpected help")
    let stdout = ""
    const origLog = console.log
    console.log = (...a: unknown[]) => { stdout += a.join(" ") + "\n" }
    try {
      await runCleanJIT(config)
    } finally {
      console.log = origLog
    }
    expect(stdout).toContain("=== clean-jit plan ===")
    expect(stdout).toContain("(missing)")
  })

  test("--yes deletes the runtime dir and solidification-state files", async () => {
    const path = await import("node:path")
    const { existsSync } = await import("node:fs")
    const { LOGS_DIR, safeModelName } = await import("../../src/core/config.ts")
    const { getVariantModelDir } = await import("../../src/proposals/storage.ts")

    // Seed the temp cache (bunfig preload redirects SKVM_CACHE) with both
    // default cleanup targets: a runtime log dir and a solidification-state
    // file under the compiled variant tree. Bun.write creates parent dirs.
    const model = "prov/delete-me"
    const adapter = "bare-agent"
    const runtimeDir = path.join(LOGS_DIR, "runtime", adapter, safeModelName(model))
    await Bun.write(path.join(runtimeDir, "console.log"), "dummy")
    const solidificationFile = path.join(
      getVariantModelDir(adapter, model), "some-skill", "pass1", "solidification-state.json",
    )
    await Bun.write(solidificationFile, "{}")

    const config = CLEAN_JIT_FLAGS.parse([`--model=${model}`, `--adapter=${adapter}`, "--yes"])
    if (config.help) throw new Error("unexpected help")
    let stdout = ""
    const origLog = console.log
    console.log = (...a: unknown[]) => { stdout += a.join(" ") + "\n" }
    try {
      await runCleanJIT(config)
    } finally {
      console.log = origLog
    }

    expect(existsSync(runtimeDir)).toBe(false)
    expect(existsSync(solidificationFile)).toBe(false)
    expect(stdout).toContain("=== clean-jit result ===")
    expect(stdout).toContain("Deleted directories: 1")
    expect(stdout).toContain("Deleted files: 1")
    expect(stdout).toContain("Errors: 0")
  })
})

describe("CLEAN_JIT_FLAGS.help — generated", () => {
  test("lists all registry adapters (fixes the 4-adapter help drift)", () => {
    const help = CLEAN_JIT_FLAGS.help()
    for (const a of ALL_ADAPTERS) expect(help).toContain(a)
    expect(help).toContain("skvm clean-jit - Clear persisted JIT artifacts for a model+adapter")
  })

  test("matches the canonical layout (usage block + options + epilogue, required markers auto-appended)", () => {
    expect(CLEAN_JIT_FLAGS.help()).toBe(
      `skvm clean-jit - Clear persisted JIT artifacts for a model+adapter

Usage:
  skvm clean-jit --model=<id> --adapter=<name> [options]

Options:
  --model=<id>            Model identifier, shaped as <provider>/<model-id> (required)
  --adapter=<name>        Adapter: ${ALL_ADAPTERS.join(", ")} (required)
  --dry-run               Show what would be deleted, but do not delete
  --yes                   Confirm deletion (required unless --dry-run)
  --include-bench-logs    Also delete matching logs/bench session folders

Default cleanup targets:
  - ~/.skvm/log/runtime/{adapter}/{safeModel}
  - ~/.skvm/proposals/aot-compile/{adapter}/{safeModel}/**/solidification-state.json

Notes:
  - This command keeps compiled SKILL.md, jit-candidates.json, and profiles intact.
  - It is intended for clean JIT effect testing across repeated bench runs.`,
    )
  })
})
