import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { PATH_FLAGS, resolvePathFlagValue } from "../../src/launcher/path-flags.ts"

describe("PATH_FLAGS", () => {
  test("each entry has flag/kind/mode/required", () => {
    for (const e of PATH_FLAGS) {
      expect(e.flag).toMatch(/^--[a-z][-a-z0-9]*$/)
      expect(["file", "dir"]).toContain(e.kind)
      expect(["ro", "rw"]).toContain(e.mode)
      expect(typeof e.required).toBe("boolean")
    }
  })

  test("--skill, --task, --out are present", () => {
    const flags = new Set(PATH_FLAGS.map(e => e.flag))
    expect(flags.has("--skill")).toBe(true)
    expect(flags.has("--task")).toBe(true)
    expect(flags.has("--out")).toBe(true)
  })
})

describe("resolvePathFlagValue", () => {
  let savedHome: string | undefined

  beforeEach(() => {
    savedHome = process.env.HOME
  })

  afterEach(() => {
    if (savedHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = savedHome
    }
  })

  test("resolves relative path against cwd", () => {
    const cwd = "/home/user/proj"
    expect(resolvePathFlagValue("./skill", cwd)).toBe("/home/user/proj/skill")
    expect(resolvePathFlagValue("skill", cwd)).toBe("/home/user/proj/skill")
    expect(resolvePathFlagValue("../sibling", cwd)).toBe("/home/user/sibling")
  })

  test("returns absolute paths unchanged (modulo normalization)", () => {
    expect(resolvePathFlagValue("/abs/path", "/cwd")).toBe("/abs/path")
    expect(resolvePathFlagValue("/abs//path", "/cwd")).toBe("/abs/path")
  })

  test("expands ~/ to $HOME", () => {
    process.env.HOME = "/home/user"
    expect(resolvePathFlagValue("~/x", "/cwd")).toBe("/home/user/x")
  })
})
