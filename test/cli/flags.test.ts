import { describe, test, expect } from "bun:test"
import { defineFlags, parseOrExit, runOrExit, UsageError } from "../../src/cli/flags.ts"

const ADAPTERS = ["bare-agent", "opencode", "pi"] as const

function makeDef() {
  return defineFlags("demo", "Exercise every flag kind", {
    model: { kind: "string", required: true, placeholder: "<id>", help: "Model id" },
    note: { kind: "string", help: "Optional note" },
    count: { kind: "int", min: 1, default: 3, help: "How many" },
    "timeout-ms": { kind: "int", min: 1, help: "Per-run cap" },
    adapter: { kind: "enum", values: ADAPTERS, default: "bare-agent", help: "Agent harness" },
    force: { kind: "bool", help: "Re-run even if cached" },
    "target-model": { aliasOf: "model" },
  })
}

function parseError(def: ReturnType<typeof makeDef>, argv: string[]): UsageError {
  try {
    def.parse(argv)
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError)
    return err as UsageError
  }
  throw new Error(`expected parse(${JSON.stringify(argv)}) to throw UsageError`)
}

describe("defineFlags().parse — happy paths", () => {
  test("full invocation produces the typed config", () => {
    const def = makeDef()
    const config = def.parse([
      "--model=anthropic/claude-sonnet-4.6",
      "--count=7",
      "--timeout-ms=5000",
      "--adapter=pi",
      "--force",
      "--note=hello world",
    ])
    expect(config).toEqual({
      help: false,
      model: "anthropic/claude-sonnet-4.6",
      note: "hello world",
      count: 7,
      "timeout-ms": 5000,
      adapter: "pi",
      force: true,
    })
  })

  test("defaults apply when flags are absent", () => {
    const config = makeDef().parse(["--model=x/y"])
    if (config.help) throw new Error("unexpected help")
    expect(config.count).toBe(3)
    expect(config.adapter).toBe("bare-agent")
    expect(config.force).toBe(false)
    expect(config.note).toBeUndefined()
    expect(config["timeout-ms"]).toBeUndefined()
  })

  test("values may contain '='", () => {
    const config = makeDef().parse(["--model=x/y", "--note=a=b=c"])
    if (config.help) throw new Error("unexpected help")
    expect(config.note).toBe("a=b=c")
  })

  test("last occurrence wins on repeated flags", () => {
    const config = makeDef().parse(["--model=x/a", "--model=x/b"])
    if (config.help) throw new Error("unexpected help")
    expect(config.model).toBe("x/b")
  })

  test("non-flag argv entries are ignored (no space-separated form)", () => {
    const config = makeDef().parse(["--model", "x/y", "--count=2"])
    // `--model x/y` is NOT `--model=x/y`: the bare flag reads as "true".
    if (config.help) throw new Error("unexpected help")
    expect(config.model).toBe("true")
    expect(config.count).toBe(2)
  })

  test("empty value (--key=) on string/bool counts as flag-not-provided", () => {
    const config = makeDef().parse(["--model=x/y", "--note=", "--force="])
    if (config.help) throw new Error("unexpected help")
    expect(config.note).toBeUndefined()
    expect(config.force).toBe(false)
  })

  test("empty value (--key=) on int/enum is rejected, not defaulted", () => {
    // Legacy profile/run errored on empty --timeout-ms= / --adapter=;
    // silently substituting the default would hide the typo.
    const intErr = parseError(makeDef(), ["--model=x/y", "--count="])
    expect(intErr.message).toContain('--count expects an integer, got ""')
    const enumErr = parseError(makeDef(), ["--model=x/y", "--adapter="])
    expect(enumErr.message).toContain('invalid --adapter ""')
  })

  test("global flags are accepted without declaration and kept out of the config", () => {
    const config = makeDef().parse([
      "--model=x/y",
      "--verbose",
      "--skvm-cache=/tmp/c",
      "--skvm-data-dir=/tmp/d",
      "--tmp-dir=/tmp/t",
    ])
    if (config.help) throw new Error("unexpected help")
    expect(Object.keys(config).sort()).toEqual(
      ["adapter", "count", "force", "help", "model", "note", "timeout-ms"].sort(),
    )
  })
})

describe("defineFlags().parse — required / int / enum / bool validation", () => {
  test("missing required flag throws", () => {
    const err = parseError(makeDef(), [])
    expect(err.message).toBe("demo: --model is required")
    expect(err.help).toContain("Options:")
  })

  test("int rejects non-numeric values", () => {
    const err = parseError(makeDef(), ["--model=x/y", "--count=abc"])
    expect(err.message).toBe('demo: --count expects an integer, got "abc"')
  })

  test("int rejects trailing garbage (no parseInt prefix-parsing)", () => {
    const err = parseError(makeDef(), ["--model=x/y", "--count=5x"])
    expect(err.message).toBe('demo: --count expects an integer, got "5x"')
  })

  test("int rejects values below min", () => {
    const err = parseError(makeDef(), ["--model=x/y", "--count=0"])
    expect(err.message).toBe("demo: --count must be >= 1, got 0")
  })

  test("enum rejects values outside the declared set", () => {
    const err = parseError(makeDef(), ["--model=x/y", "--adapter=clade-code"])
    expect(err.message).toBe('demo: invalid --adapter "clade-code". Valid: bare-agent, opencode, pi')
  })

  test("bool accepts bare, =true, and =false forms", () => {
    const def = makeDef()
    for (const [argv, expected] of [
      [["--model=x/y", "--force"], true],
      [["--model=x/y", "--force=true"], true],
      [["--model=x/y", "--force=false"], false],
      [["--model=x/y"], false],
    ] as Array<[string[], boolean]>) {
      const config = def.parse(argv)
      if (config.help) throw new Error("unexpected help")
      expect(config.force).toBe(expected)
    }
  })

  test("bool rejects other values", () => {
    const err = parseError(makeDef(), ["--model=x/y", "--force=banana"])
    expect(err.message).toBe('demo: --force expects true or false, got "banana"')
  })
})

describe("defineFlags().parse — aliasOf", () => {
  test("alias maps onto the canonical key", () => {
    const config = makeDef().parse(["--target-model=x/y"])
    if (config.help) throw new Error("unexpected help")
    expect(config.model).toBe("x/y")
    expect("target-model" in config).toBe(false)
  })

  test("canonical flag wins when both are given", () => {
    const config = makeDef().parse(["--target-model=x/old", "--model=x/new"])
    if (config.help) throw new Error("unexpected help")
    expect(config.model).toBe("x/new")
  })

  test("alias value goes through the target's validation", () => {
    const def = defineFlags("demo", "s", {
      rounds: { kind: "int", min: 1 },
      iterations: { aliasOf: "rounds" },
    })
    expect(() => def.parse(["--iterations=zero"])).toThrow(UsageError)
    const config = def.parse(["--iterations=4"])
    if (config.help) throw new Error("unexpected help")
    expect(config.rounds).toBe(4)
  })
})

describe("defineFlags().parse — cross-flag rules (requires / requiredUnless)", () => {
  // "--mode requires --skill" and "--model required unless --list" — the two
  // real cases from run.ts and profile.ts.
  function ruleDef() {
    return defineFlags("demo", "s", {
      skill: { kind: "string" },
      mode: { kind: "enum", values: ["inject", "discover"], requires: "skill" },
      model: { kind: "string", requiredUnless: "list" },
      list: { kind: "bool" },
    })
  }

  test("requires: satisfied when both flags are present", () => {
    const config = ruleDef().parse(["--skill=/s", "--mode=inject", "--list"])
    if (config.help) throw new Error("unexpected help")
    expect(config.mode).toBe("inject")
    expect(config.skill).toBe("/s")
  })

  test("requires: violated when the dependent flag is present but its target is absent", () => {
    const err = parseError(ruleDef(), ["--mode=inject", "--list"])
    expect(err.message).toBe("demo: --mode requires --skill to also be specified")
  })

  test("requires: not triggered when the dependent flag is itself absent", () => {
    // No --mode, so the requires rule is moot even though --skill is missing.
    const config = ruleDef().parse(["--list"])
    if (config.help) throw new Error("unexpected help")
    expect(config.mode).toBeUndefined()
  })

  test("requires: an empty value (--mode=) counts as absent, so the rule is moot", () => {
    // Enum empty value would normally be rejected, but `--mode` is not in the
    // string/bool empty-as-absent set; assert with a string dependent instead.
    const def = defineFlags("demo", "s", {
      note: { kind: "string" },
      tag: { kind: "string", requires: "note" },
    })
    const config = def.parse(["--tag="])
    if (config.help) throw new Error("unexpected help")
    expect(config.tag).toBeUndefined()
  })

  test("requiredUnless: satisfied when the flag itself is present", () => {
    const config = ruleDef().parse(["--model=x/y"])
    if (config.help) throw new Error("unexpected help")
    expect(config.model).toBe("x/y")
  })

  test("requiredUnless: satisfied when the alternative is present", () => {
    const config = ruleDef().parse(["--list"])
    if (config.help) throw new Error("unexpected help")
    expect(config.model).toBeUndefined()
    expect(config.list).toBe(true)
  })

  test("requiredUnless: violated when neither the flag nor its alternative is present", () => {
    const err = parseError(ruleDef(), [])
    expect(err.message).toBe("demo: --model is required unless --list is given")
  })

  test("rule markers render in help after default/required markers", () => {
    const help = ruleDef().help()
    expect(help).toContain("--mode=<inject|discover>")
    expect(help).toContain("(requires --skill)")
    expect(help).toContain("(required unless --list)")
  })

  test("requires marker appends after a declared default", () => {
    const def = defineFlags("demo", "s", {
      base: { kind: "string" },
      n: { kind: "int", default: 3, requires: "base" },
    })
    // Marker order is prose → default/required → requiredUnless → requires.
    expect(def.help()).toContain("(default: 3) (requires --base)")
  })
})

describe("defineFlags().parse — unknown-flag rejection (same wording as assertKnownFlags)", () => {
  test("typo gets a did-you-mean hint plus the help trailer", () => {
    const err = parseError(makeDef(), ["--modle=x/y"])
    expect(err.message).toBe(
      "demo: Unknown flag --modle. Did you mean --model?\n" +
        "Run 'skvm demo --help' for the list of supported flags.",
    )
  })

  test("far-off flag gets no hint", () => {
    const err = parseError(makeDef(), ["--model=x/y", "--zzzzzz=1"])
    expect(err.message).toBe(
      "demo: Unknown flag --zzzzzz.\nRun 'skvm demo --help' for the list of supported flags.",
    )
  })

  test("all unknown flags are reported in one error", () => {
    const err = parseError(makeDef(), ["--modle=x", "--cont=2"])
    expect(err.message).toContain("--modle")
    expect(err.message).toContain("--cont")
  })

  test("alias names and global-flag typos are part of the suggestion universe", () => {
    const err = parseError(makeDef(), ["--model=x/y", "--target-modl=z"])
    expect(err.message).toContain("Did you mean --target-model?")
    const err2 = parseError(makeDef(), ["--model=x/y", "--vrbose"])
    expect(err2.message).toContain("Did you mean --verbose?")
  })

  test("unknown-flag rejection beats --help (legacy order)", () => {
    const err = parseError(makeDef(), ["--help", "--bogus=1"])
    expect(err.message).toContain("Unknown flag --bogus")
  })
})

describe("defineFlags().parse — --help short-circuit", () => {
  test("--help wins even when required flags are missing", () => {
    expect(makeDef().parse(["--help"])).toEqual({ help: true })
  })

  test("--help skips value validation", () => {
    expect(makeDef().parse(["--help", "--count=abc"])).toEqual({ help: true })
  })

  test("--help=<not-true> does not trigger help (legacy `flags.help === \"true\"`)", () => {
    const config = makeDef().parse(["--model=x/y", "--help=banana"])
    expect(config.help).toBe(false)
  })
})

describe("defineFlags().help — generated help text", () => {
  test("renders summary and aligned option rows; aliases are hidden", () => {
    const def = defineFlags("demo", "Do demo things", {
      type: { kind: "string", placeholder: "<type>", help: "Filter by type" },
      limit: { kind: "int", default: 20, help: "Show last N entries" },
      all: { kind: "bool", help: "Show all entries (no limit)" },
      "old-type": { aliasOf: "type" },
    })
    // "(default: 20)" comes from the declaration, not the prose — declared
    // defaults render automatically so help can't drift from the spec.
    expect(def.help()).toBe(
      [
        "skvm demo - Do demo things",
        "",
        "Options:",
        "  --type=<type>    Filter by type",
        "  --limit=<n>      Show last N entries (default: 20)",
        "  --all            Show all entries (no limit)",
      ].join("\n"),
    )
  })

  test("default placeholders: int <n>, string <value>, enum value list", () => {
    const def = defineFlags("demo", "s", {
      a: { kind: "string" },
      b: { kind: "int" },
      c: { kind: "enum", values: ["x", "y"] },
    })
    const help = def.help()
    expect(help).toContain("--a=<value>")
    expect(help).toContain("--b=<n>")
    expect(help).toContain("--c=<x|y>")
  })

  test("multi-line help strings indent continuation lines to the help column", () => {
    const def = defineFlags("demo", "s", {
      mode: { kind: "string", help: "First line\nsecond line" },
    })
    expect(def.help()).toBe(
      [
        "skvm demo - s",
        "",
        "Options:",
        "  --mode=<value>    First line",
        "                    second line",
      ].join("\n"),
    )
  })

  test("UsageError carries the generated help text", () => {
    const def = makeDef()
    const err = parseError(def, ["--modle=x"])
    expect(err.help).toBe(def.help())
  })

  test("usage lines render between summary and Options; epilogue renders after", () => {
    const def = defineFlags(
      "demo",
      "Do demo things",
      { type: { kind: "string", placeholder: "<type>", help: "Filter by type" } },
      {
        usage: ["skvm demo --type=<type> [options]", "skvm demo [options]"],
        epilogue: "Notes:\n  - This is a demo.",
      },
    )
    expect(def.help()).toBe(
      [
        "skvm demo - Do demo things",
        "",
        "Usage:",
        "  skvm demo --type=<type> [options]",
        "  skvm demo [options]",
        "",
        "Options:",
        "  --type=<type>    Filter by type",
        "",
        "Notes:",
        "  - This is a demo.",
      ].join("\n"),
    )
  })

  test("required flags render '(required)' from the declaration", () => {
    const def = defineFlags("demo", "s", {
      model: { kind: "string", required: true, help: "Model id" },
      bare: { kind: "int", required: true },
    })
    const help = def.help()
    expect(help).toContain("--model=<value>    Model id (required)")
    expect(help).toContain("--bare=<n>         (required)")
  })
})

describe("defineFlags — define-time validation", () => {
  test("aliasOf must reference a declared non-alias flag", () => {
    expect(() => defineFlags("demo", "s", { a: { aliasOf: "missing" } })).toThrow(
      'defineFlags(demo): --a aliasOf "missing" must name a declared non-alias flag',
    )
    expect(() =>
      defineFlags("demo", "s", {
        x: { kind: "string" },
        a: { aliasOf: "x" },
        b: { aliasOf: "a" },
      }),
    ).toThrow('defineFlags(demo): --b aliasOf "a" must name a declared non-alias flag')
  })

  test("global flag names cannot be redeclared", () => {
    expect(() => defineFlags("demo", "s", { help: { kind: "bool" } })).toThrow(
      "defineFlags(demo): --help is a global flag and cannot be redeclared",
    )
  })

  test("enum default must be one of values", () => {
    expect(() =>
      defineFlags("demo", "s", { m: { kind: "enum", values: ["a", "b"], default: "c" } }),
    ).toThrow('defineFlags(demo): --m default "c" is not in values')
  })

  test("int default must respect min", () => {
    expect(() => defineFlags("demo", "s", { n: { kind: "int", min: 1, default: 0 } })).toThrow(
      "defineFlags(demo): --n default 0 is below min 1",
    )
  })

  test("a flag cannot be both required and have a default", () => {
    expect(() =>
      defineFlags("demo", "s", { m: { kind: "string", required: true, default: "x" } }),
    ).toThrow("defineFlags(demo): --m cannot be both required and have a default")
  })

  test("requires must reference a declared non-alias flag", () => {
    expect(() =>
      defineFlags("demo", "s", { a: { kind: "string", requires: "missing" } }),
    ).toThrow('defineFlags(demo): --a requires "missing" must name a declared non-alias flag')
    // An alias is not a valid rule target — rules reference canonical names.
    expect(() =>
      defineFlags("demo", "s", {
        x: { kind: "string" },
        old: { aliasOf: "x" },
        a: { kind: "string", requires: "old" },
      }),
    ).toThrow('defineFlags(demo): --a requires "old" must name a declared non-alias flag')
  })

  test("requiredUnless must reference a declared non-alias flag", () => {
    expect(() =>
      defineFlags("demo", "s", { a: { kind: "string", requiredUnless: "nope" } }),
    ).toThrow('defineFlags(demo): --a requiredUnless "nope" must name a declared non-alias flag')
  })
})

describe("parseOrExit", () => {
  /** Run `fn` with process.exit / console.error / console.log captured. */
  function captureExit(fn: () => void): { exitCode: number | null; stderr: string; stdout: string } {
    const captured = { exitCode: null as number | null, stderr: "", stdout: "" }
    const origExit = process.exit
    const origErr = console.error
    const origLog = console.log
    process.exit = ((code?: number) => {
      captured.exitCode = code ?? 0
      throw new Error("__exit__")
    }) as typeof process.exit
    console.error = (...a: unknown[]) => {
      captured.stderr += a.join(" ") + "\n"
    }
    console.log = (...a: unknown[]) => {
      captured.stdout += a.join(" ") + "\n"
    }
    try {
      expect(fn).toThrow("__exit__")
    } finally {
      process.exit = origExit
      console.error = origErr
      console.log = origLog
    }
    return captured
  }

  test("prints the UsageError message to stderr and exits 1", () => {
    const def = makeDef()
    const { exitCode, stderr } = captureExit(() => parseOrExit(def, ["--modle=x"]))
    expect(exitCode).toBe(1)
    expect(stderr).toContain("demo: Unknown flag --modle. Did you mean --model?")
    expect(stderr).toContain("Run 'skvm demo --help' for the list of supported flags.")
  })

  test("prints the generated help to stdout and exits 0 on --help", () => {
    const def = makeDef()
    const { exitCode, stdout } = captureExit(() => parseOrExit(def, ["--help"]))
    expect(exitCode).toBe(0)
    expect(stdout).toBe(def.help() + "\n")
  })

  test("returns the typed config on success", () => {
    const config = parseOrExit(makeDef(), ["--model=x/y"])
    expect(config.model).toBe("x/y")
    expect(config.count).toBe(3)
  })
})

describe("runOrExit", () => {
  test("invokes the handler with the typed config on success", async () => {
    let seen: unknown
    await runOrExit(makeDef(), ["--model=x/y"], (config) => {
      seen = config.model
    })
    expect(seen).toBe("x/y")
  })

  test("a UsageError thrown by the handler (cross-flag rule) prints to stderr and exits 1", async () => {
    const def = makeDef()
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
      await expect(
        runOrExit(def, ["--model=x/y"], () => {
          throw new UsageError("demo: --force requires --note to also be specified", def.help)
        }),
      ).rejects.toThrow("__exit__")
    } finally {
      process.exit = origExit
      console.error = origErr
    }
    expect(captured.exitCode).toBe(1)
    expect(captured.stderr).toBe("demo: --force requires --note to also be specified\n")
  })

  test("non-UsageError handler failures propagate to the caller", async () => {
    await expect(
      runOrExit(makeDef(), ["--model=x/y"], () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
  })
})
