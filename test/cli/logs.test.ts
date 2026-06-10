import { describe, test, expect } from "bun:test"
import { LOGS_FLAGS, runLogs } from "../../src/cli/logs.ts"
import { UsageError } from "../../src/cli/flags.ts"
import { CLI_DEFAULTS } from "../../src/core/ui-defaults.ts"

describe("LOGS_FLAGS.parse — typed config", () => {
  test("no flags → defaults", () => {
    expect(LOGS_FLAGS.parse([])).toEqual({
      help: false,
      type: undefined,
      limit: CLI_DEFAULTS.listLimit,
      all: false,
    })
  })

  test("sample argv → typed config", () => {
    expect(LOGS_FLAGS.parse(["--type=bench", "--limit=5"])).toEqual({
      help: false,
      type: "bench",
      limit: 5,
      all: false,
    })
  })

  test("--all parses to a boolean", () => {
    const config = LOGS_FLAGS.parse(["--all"])
    if (config.help) throw new Error("unexpected help")
    expect(config.all).toBe(true)
  })

  test("--help short-circuits", () => {
    expect(LOGS_FLAGS.parse(["--help"])).toEqual({ help: true })
  })

  test("unknown flag is rejected with the legacy wording (issue #12 surface)", () => {
    try {
      LOGS_FLAGS.parse(["--lmit=5"])
      throw new Error("expected UsageError")
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError)
      expect((err as UsageError).message).toBe(
        "logs: Unknown flag --lmit. Did you mean --limit?\n" +
          "Run 'skvm logs --help' for the list of supported flags.",
      )
    }
  })

  test("--limit validates as a positive integer", () => {
    expect(() => LOGS_FLAGS.parse(["--limit=abc"])).toThrow(
      'logs: --limit expects an integer, got "abc"',
    )
    expect(() => LOGS_FLAGS.parse(["--limit=0"])).toThrow("logs: --limit must be >= 1, got 0")
  })
})

describe("LOGS_FLAGS.help — generated help text", () => {
  test("matches the pre-migration `skvm logs --help` output byte-for-byte", () => {
    expect(LOGS_FLAGS.help()).toBe(
      `skvm logs - List recent runs across all subsystems

Options:
  --type=<type>    Filter by type (profile, aot-compile, bench, run, pipeline)
  --limit=<n>      Show last N entries (default: ${CLI_DEFAULTS.listLimit})
  --all            Show all entries (no limit)`,
    )
  })
})

describe("runLogs — runs without spawning the CLI", () => {
  test("prints 'No sessions found.' on an empty cache", async () => {
    // bunfig.toml's test preload points SKVM_CACHE at a fresh temp dir, so
    // the sessions index does not exist.
    let stdout = ""
    const origLog = console.log
    console.log = (...a: unknown[]) => {
      stdout += a.join(" ") + "\n"
    }
    try {
      const config = LOGS_FLAGS.parse([])
      if (config.help) throw new Error("unexpected help")
      await runLogs(config)
    } finally {
      console.log = origLog
    }
    expect(stdout).toBe("No sessions found.\n")
  })
})
