import { describe, test, expect } from "bun:test"
import {
  PROPOSALS_LIST_FLAGS,
  PROPOSALS_SHOW_FLAGS,
  PROPOSALS_DIFF_FLAGS,
  PROPOSALS_REPORT_FLAGS,
  PROPOSALS_SERVE_FLAGS,
  PROPOSALS_ACCEPT_FLAGS,
  PROPOSALS_REJECT_FLAGS,
  PROPOSALS_CANCEL_FLAGS,
  routeProposals,
  runProposals,
  runProposalsList,
  runProposalsShow,
  runProposalsDiff,
  runProposalsAccept,
  runProposalsReject,
  runProposalsCancel,
} from "../../src/cli/proposals.ts"
import { UsageError, type FlagsDef, type FlagSpecs, type FlagConfig } from "../../src/cli/flags.ts"
import { CLI_DEFAULTS } from "../../src/core/ui-defaults.ts"

// This file exercises eight defs, so the helpers take the def as the first
// argument (the single-def siblings hardcode theirs).

function parseOk<S extends FlagSpecs>(def: FlagsDef<S>, argv: string[]): FlagConfig<S> {
  const config = def.parse(argv)
  if (config.help) throw new Error(`unexpected --help from ${def.command}`)
  return config
}

function parseError<S extends FlagSpecs>(def: FlagsDef<S>, argv: string[]): UsageError {
  try {
    def.parse(argv)
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError)
    return err as UsageError
  }
  throw new Error(`expected ${def.command} parse(${JSON.stringify(argv)}) to throw UsageError`)
}

async function handlerError(run: () => Promise<void>): Promise<UsageError> {
  try {
    await run()
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError)
    return err as UsageError
  }
  throw new Error("expected handler to throw UsageError")
}

describe("PROPOSALS_LIST_FLAGS.parse", () => {
  test("no flags → typed defaults (config-shape lock)", () => {
    expect(PROPOSALS_LIST_FLAGS.parse([])).toEqual({
      help: false,
      harness: undefined,
      "target-model": undefined,
      skill: undefined,
      status: undefined,
      sort: CLI_DEFAULTS.listSort,
      "min-delta": undefined,
      "group-by": undefined,
      "no-color": false,
    })
  })

  test("sample argv → typed config; --model aliases --target-model", () => {
    expect(PROPOSALS_LIST_FLAGS.parse([
      "--model=x/y", "--status=pending", "--min-delta=0.05", "--group-by=skill", "--no-color",
    ])).toEqual({
      help: false,
      harness: undefined,
      "target-model": "x/y",
      skill: undefined,
      status: "pending",
      sort: CLI_DEFAULTS.listSort,
      "min-delta": 0.05,
      "group-by": "skill",
      "no-color": true,
    })
  })

  test("--status and --sort are now validated enums (ledger class 5)", () => {
    // Legacy `as`-cast garbage straight into the storage filter / sortRows,
    // silently producing empty or default-sorted output. Now a loud error.
    expect(parseError(PROPOSALS_LIST_FLAGS, ["--status=bogus"]).message).toBe(
      'proposals list: invalid --status "bogus". Valid: pending, accepted, rejected',
    )
    expect(parseError(PROPOSALS_LIST_FLAGS, ["--sort=bogus"]).message).toBe(
      'proposals list: invalid --sort "bogus". Valid: recent, delta, skill, model',
    )
  })

  test("--group-by is a validated enum (was a manual check + exit in legacy)", () => {
    expect(parseError(PROPOSALS_LIST_FLAGS, ["--group-by=bogus"]).message).toBe(
      'proposals list: invalid --group-by "bogus". Valid: skill, model',
    )
  })

  test("--min-delta is a validated float (ledger class 3)", () => {
    // Legacy did parseFloat + `!Number.isNaN` and silently SKIPPED the filter
    // on garbage input; the layer's float kind rejects it instead.
    expect(parseError(PROPOSALS_LIST_FLAGS, ["--min-delta=abc"]).message).toBe(
      'proposals list: --min-delta expects a number, got "abc"',
    )
  })

  test("unknown flag keeps the legacy 'proposals <sub>' label and wording", () => {
    expect(parseError(PROPOSALS_LIST_FLAGS, ["--harnes=pi"]).message).toBe(
      "proposals list: Unknown flag --harnes. Did you mean --harness?\n" +
        "Run 'skvm proposals list --help' for the list of supported flags.",
    )
  })
})

describe("PROPOSALS_SHOW_FLAGS.parse", () => {
  test("no flags → typed defaults (config-shape lock)", () => {
    expect(PROPOSALS_SHOW_FLAGS.parse([])).toEqual({
      help: false,
      full: false,
      "no-color": false,
      round: undefined,
    })
  })

  test("--round=0 parses to 0 (legacy parseInt edge preserved)", () => {
    expect(parseOk(PROPOSALS_SHOW_FLAGS, ["--round=0"]).round).toBe(0)
  })
})

describe("--round validation across show/diff/accept (ledger class 3)", () => {
  // Legacy show/diff had a bespoke NaN check ("--round must be an integer");
  // accept had NONE (parseInt garbage → NaN flowed into deployProposal). All
  // three now share the layer's integer error.
  test("non-integer --round is rejected with the layer wording", () => {
    expect(parseError(PROPOSALS_SHOW_FLAGS, ["--round=x"]).message).toBe(
      'proposals show: --round expects an integer, got "x"',
    )
    expect(parseError(PROPOSALS_DIFF_FLAGS, ["--round=x"]).message).toBe(
      'proposals diff: --round expects an integer, got "x"',
    )
    expect(parseError(PROPOSALS_ACCEPT_FLAGS, ["--round=x"]).message).toBe(
      'proposals accept: --round expects an integer, got "x"',
    )
  })

  test("negative --round is rejected (legacy passed it downstream unchecked)", () => {
    expect(parseError(PROPOSALS_SHOW_FLAGS, ["--round=-1"]).message).toBe(
      "proposals show: --round must be >= 0, got -1",
    )
  })
})

describe("PROPOSALS_SERVE_FLAGS.parse", () => {
  test("no flags → layer defaults (config-shape lock)", () => {
    expect(PROPOSALS_SERVE_FLAGS.parse([])).toEqual({
      help: false,
      port: CLI_DEFAULTS.reportPort,
      host: CLI_DEFAULTS.reportHost,
      "no-open": false,
    })
  })

  test("--port is bounded to [1, 65535] at the layer (was a manual range check + exit)", () => {
    expect(parseError(PROPOSALS_SERVE_FLAGS, ["--port=99999"]).message).toBe(
      "proposals serve: --port must be <= 65535, got 99999",
    )
    expect(parseError(PROPOSALS_SERVE_FLAGS, ["--port=0"]).message).toBe(
      "proposals serve: --port must be >= 1, got 0",
    )
  })
})

describe("PROPOSALS_REPORT_FLAGS.parse", () => {
  test("report shares list's filters plus --out, but not --no-color (legacy allow-set parity)", () => {
    const config = parseOk(PROPOSALS_REPORT_FLAGS, ["--model=x/y", "--out=/tmp/r.html"])
    expect(config["target-model"]).toBe("x/y")
    expect(config.out).toBe("/tmp/r.html")
    expect(parseError(PROPOSALS_REPORT_FLAGS, ["--no-color"]).message).toBe(
      "proposals report: Unknown flag --no-color.\n" +
        "Run 'skvm proposals report --help' for the list of supported flags.",
    )
  })
})

describe("empty-spec defs (reject / cancel)", () => {
  test("any data flag is unknown, with the legacy label (empty allow-set parity)", () => {
    expect(parseError(PROPOSALS_REJECT_FLAGS, ["--round=1"]).message).toBe(
      "proposals reject: Unknown flag --round.\n" +
        "Run 'skvm proposals reject --help' for the list of supported flags.",
    )
    expect(PROPOSALS_CANCEL_FLAGS.parse([])).toEqual({ help: false })
    expect(PROPOSALS_CANCEL_FLAGS.parse(["--help"])).toEqual({ help: true })
  })
})

describe("routeProposals", () => {
  test("no sub / 'help' / flag-only argv → overview", () => {
    expect(routeProposals([]).kind).toBe("overview")
    expect(routeProposals(["help"]).kind).toBe("overview")
    // Legacy quirk fixed (ledger class 6): `skvm proposals --help` fell
    // through to "Unknown proposals subcommand: --help" and exited 1.
    expect(routeProposals(["--help"]).kind).toBe("overview")
    expect(routeProposals(["--no-color"]).kind).toBe("overview")
  })

  test("unknown sub is rejected", () => {
    expect(routeProposals(["bogus"])).toEqual({ kind: "unknown", sub: "bogus" })
  })

  test("a flag in the sub position with non-flag args after it is NOT the overview", () => {
    // Only flag-ONLY invocations soften to the overview. Legacy printed
    // `Unknown proposals subcommand: --no-color` (exit 1) here — swallowing
    // the trailing sub into a silent exit-0 overview would hide the mistake.
    expect(routeProposals(["--no-color", "list"])).toEqual({ kind: "unknown", sub: "--no-color" })
  })

  test("positional id is extracted; flags pass through as argv", () => {
    expect(routeProposals(["show", "abc123", "--full"])).toEqual({
      kind: "sub",
      sub: "show",
      id: "abc123",
      argv: ["abc123", "--full"],
    })
  })

  test("id extraction skips flags regardless of position", () => {
    expect(routeProposals(["accept", "--round=2", "xyz"])).toEqual({
      kind: "sub",
      sub: "accept",
      id: "xyz",
      argv: ["--round=2", "xyz"],
    })
  })
})

describe("no-id subs reject stray positionals", () => {
  /** Run runProposals with process.exit / console.error captured. */
  async function captureRunExit(argv: string[]): Promise<{ exitCode: number | null; stderr: string }> {
    const captured = { exitCode: null as number | null, stderr: "" }
    const origExit = process.exit
    const origErr = console.error
    process.exit = ((code?: number) => {
      captured.exitCode = code ?? 0
      throw new Error("__exit__")
    }) as typeof process.exit
    console.error = (...a: unknown[]) => {
      captured.stderr += a.join(" ") + "\n"
    }
    try {
      await expect(runProposals(argv)).rejects.toThrow("__exit__")
    } finally {
      process.exit = origExit
      console.error = origErr
    }
    return captured
  }

  // list/report/serve take no positional <id> — a stray one used to be
  // silently ignored (legacy parity); now it is a loud usage error through
  // the same exitOnUsageError path as every other UsageError.
  test("serve rejects a stray positional", async () => {
    const { exitCode, stderr } = await captureRunExit(["serve", "8080"])
    expect(exitCode).toBe(1)
    expect(stderr).toBe('proposals serve: unexpected argument "8080"\n')
  })

  test("list rejects a stray positional", async () => {
    const { exitCode, stderr } = await captureRunExit(["list", "foo"])
    expect(exitCode).toBe(1)
    expect(stderr).toBe('proposals list: unexpected argument "foo"\n')
  })

  test("report rejects a stray positional", async () => {
    const { exitCode, stderr } = await captureRunExit(["report", "x"])
    expect(exitCode).toBe(1)
    expect(stderr).toBe('proposals report: unexpected argument "x"\n')
  })

  test("id-taking subs still accept their positional id", async () => {
    // cancel with a nonexistent id must get PAST positional handling and
    // reach the handler's environment-state check (missing run-status.json)
    // — proof the positional was consumed as the id, not rejected as stray.
    const { exitCode, stderr } = await captureRunExit(["cancel", "no-such-id"])
    expect(exitCode).toBe(1)
    expect(stderr).toBe("cancel: no-such-id has no run-status.json (not a detached run)\n")
  })
})

describe("handlers without <id> throw the verbatim legacy usage strings", () => {
  test("show", async () => {
    const err = await handlerError(() => runProposalsShow(parseOk(PROPOSALS_SHOW_FLAGS, []), undefined))
    expect(err.message).toBe("Usage: skvm proposals show <id> [--round=N]")
  })

  test("diff", async () => {
    const err = await handlerError(() => runProposalsDiff(parseOk(PROPOSALS_DIFF_FLAGS, []), undefined))
    expect(err.message).toBe("Usage: skvm proposals diff <id> [--round=N]")
  })

  test("accept", async () => {
    const err = await handlerError(() => runProposalsAccept(parseOk(PROPOSALS_ACCEPT_FLAGS, []), undefined))
    expect(err.message).toBe("Usage: skvm proposals accept <id>")
  })

  test("reject", async () => {
    const err = await handlerError(() => runProposalsReject(parseOk(PROPOSALS_REJECT_FLAGS, []), undefined))
    expect(err.message).toBe("Usage: skvm proposals reject <id>")
  })

  test("cancel", async () => {
    const err = await handlerError(() => runProposalsCancel(parseOk(PROPOSALS_CANCEL_FLAGS, []), undefined))
    expect(err.message).toBe("Usage: skvm proposals cancel <id>")
  })
})

describe("runProposalsList", () => {
  test("no matching proposals prints 'No proposals found.'", async () => {
    // The bunfig preload redirects SKVM_CACHE to a fresh temp dir, but bun
    // runs every test file in one shared process — a never-matching skill
    // filter makes the empty branch deterministic regardless of what other
    // files may have written to the shared cache.
    const origLog = console.log
    let stdout = ""
    console.log = (...a: unknown[]) => {
      stdout += a.join(" ") + "\n"
    }
    try {
      await runProposalsList(parseOk(PROPOSALS_LIST_FLAGS, ["--skill=no-such-skill-xyz"]))
    } finally {
      console.log = origLog
    }
    expect(stdout).toBe("No proposals found.\n")
  })
})

describe("generated per-sub help", () => {
  test("list help matches the canonical layout", () => {
    expect(PROPOSALS_LIST_FLAGS.help()).toBe(
      `skvm proposals list - List jit-optimize proposals

Usage:
  skvm proposals list [filters]

Options:
  --harness=<n>                        Filter by harness
  --target-model=<id>                  Filter by target model (the model the skill was tuned for)
  --skill=<name>                       Filter by skill name
  --status=<s>                         Filter by status
  --sort=<recent|delta|skill|model>    Sort order (default: ${CLI_DEFAULTS.listSort})
  --min-delta=<n>                      Only rows with score delta >= n
  --group-by=<g>                       Aggregate rows
  --no-color                           Disable ANSI colors`,
    )
  })

  test("serve help matches the canonical layout", () => {
    expect(PROPOSALS_SERVE_FLAGS.help()).toBe(
      `skvm proposals serve - Serve the review UI

Usage:
  skvm proposals serve [--port=<n>] [--host=<h>] [--no-open]

Options:
  --port=<n>    Port (default: ${CLI_DEFAULTS.reportPort})
  --host=<h>    Host (default: ${CLI_DEFAULTS.reportHost})
  --no-open     Do not open a browser`,
    )
  })

  test("reject help renders sanely with an empty flag spec (no Options block)", () => {
    // Locks the flags.ts empty-spec guard: no dangling "Options:" header, no
    // Math.max over zero rows.
    expect(PROPOSALS_REJECT_FLAGS.help()).toBe(
      `skvm proposals reject - Mark a proposal rejected

Usage:
  skvm proposals reject <id>`,
    )
  })
})
