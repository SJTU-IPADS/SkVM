import { describe, test, expect } from "bun:test"
import { UI_FLAGS } from "../../src/cli/ui.ts"
import { UsageError } from "../../src/cli/flags.ts"
import { CLI_DEFAULTS } from "../../src/core/ui-defaults.ts"

describe("UI_FLAGS.parse — typed config", () => {
  test("no flags → defaults (same surface as proposals serve)", () => {
    expect(UI_FLAGS.parse([])).toEqual({
      help: false,
      port: CLI_DEFAULTS.reportPort,
      host: CLI_DEFAULTS.reportHost,
      "no-open": false,
    })
  })

  test("sample argv → typed config", () => {
    expect(UI_FLAGS.parse(["--port=8080", "--host=0.0.0.0", "--no-open"])).toEqual({
      help: false,
      port: 8080,
      host: "0.0.0.0",
      "no-open": true,
    })
  })

  test("--help short-circuits", () => {
    expect(UI_FLAGS.parse(["--help"])).toEqual({ help: true })
  })

  test("--port validates its range", () => {
    expect(() => UI_FLAGS.parse(["--port=0"])).toThrow("ui: --port must be >= 1, got 0")
    expect(() => UI_FLAGS.parse(["--port=99999"])).toThrow("ui: --port must be <= 65535, got 99999")
  })

  test("unknown flag is rejected with a suggestion", () => {
    try {
      UI_FLAGS.parse(["--prot=8080"])
      throw new Error("expected UsageError")
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError)
      expect((err as UsageError).message).toBe(
        "ui: Unknown flag --prot. Did you mean --port?\n" +
          "Run 'skvm ui --help' for the list of supported flags.",
      )
    }
  })
})

describe("UI_FLAGS.help — generated help text", () => {
  test("matches the canonical layout", () => {
    expect(UI_FLAGS.help()).toBe(
      `skvm ui - Serve the SkVM web UI

Usage:
  skvm ui [--port=<n>] [--host=<h>] [--no-open]

Options:
  --port=<n>    Port (default: ${CLI_DEFAULTS.reportPort})
  --host=<h>    Host (default: ${CLI_DEFAULTS.reportHost})
  --no-open     Do not open a browser`,
    )
  })
})
