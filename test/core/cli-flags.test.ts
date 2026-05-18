import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { assertKnownFlags, suggestFlag, GLOBAL_FLAGS, parseSkillModeFlag } from "../../src/core/cli-flags.ts"

describe("suggestFlag", () => {
  test("suggests the nearest within Levenshtein distance 2", () => {
    expect(suggestFlag("adpter", ["adapter", "model", "task"])).toBe("adapter")
    expect(suggestFlag("modle", ["adapter", "model", "task"])).toBe("model")
  })

  test("returns null when nothing is within distance 2", () => {
    expect(suggestFlag("zzz", ["adapter", "model", "task"])).toBeNull()
  })

  test("prefers exact-distance ties by lexical order (stable)", () => {
    // 'aabb' is distance 2 from both 'aaaa' and 'bbbb'; lexical order wins.
    expect(suggestFlag("aabb", ["aaaa", "bbbb"])).toBe("aaaa")
  })
})

describe("assertKnownFlags", () => {
  let exitCode: number | null
  let stderr: string
  const origExit = process.exit
  const origErr = console.error

  beforeEach(() => {
    exitCode = null
    stderr = ""
    process.exit = (code?: number) => { exitCode = code ?? 0; throw new Error("__exit__") }
    console.error = (...args: unknown[]) => { stderr += args.join(" ") + "\n" }
  })

  afterEach(() => {
    process.exit = origExit
    console.error = origErr
  })

  test("accepts known flags silently", () => {
    assertKnownFlags("profile", { adapter: "claude-code", model: "x/y" }, new Set(["adapter", "model"]))
    expect(exitCode).toBeNull()
    expect(stderr).toBe("")
  })

  test("accepts global flags without per-command declaration", () => {
    for (const g of GLOBAL_FLAGS) {
      const flags: Record<string, string> = {}
      flags[g] = "true"
      assertKnownFlags("profile", flags, new Set())
    }
    expect(exitCode).toBeNull()
  })

  test("rejects an unknown flag with a 'did you mean' hint", () => {
    expect(() => {
      assertKnownFlags("profile", { adpter: "claude-code", model: "x/y" }, new Set(["adapter", "model"]))
    }).toThrow("__exit__")
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Unknown flag --adpter")
    expect(stderr).toContain("Did you mean --adapter?")
    expect(stderr).toContain("profile") // command label appears
  })

  test("rejects an unknown flag with no close match (no hint line)", () => {
    expect(() => {
      assertKnownFlags("profile", { zzz: "v" }, new Set(["adapter", "model"]))
    }).toThrow("__exit__")
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Unknown flag --zzz")
    expect(stderr).not.toContain("Did you mean")
  })

  test("reports all unknown flags in a single error before exiting", () => {
    expect(() => {
      assertKnownFlags("profile", { adpter: "x", modle: "y" }, new Set(["adapter", "model"]))
    }).toThrow("__exit__")
    expect(stderr).toContain("--adpter")
    expect(stderr).toContain("--modle")
  })
})

describe("parseSkillModeFlag", () => {
  test("returns undefined when flag is not set", () => {
    expect(parseSkillModeFlag({})).toBeUndefined()
  })

  test("returns 'inject' / 'discover' verbatim", () => {
    expect(parseSkillModeFlag({ "skill-mode": "inject" })).toBe("inject")
    expect(parseSkillModeFlag({ "skill-mode": "discover" })).toBe("discover")
  })

  test("exits with error on invalid value", () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("process.exit called")
    }) as never)
    const errSpy = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(() => parseSkillModeFlag({ "skill-mode": "bogus" })).toThrow("process.exit called")
      expect(errSpy.mock.calls.at(-1)?.[0]).toContain(`unknown skill mode "bogus"`)
    } finally {
      exitSpy.mockRestore()
      errSpy.mockRestore()
    }
  })
})
