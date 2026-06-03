import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { PATH_FLAGS, resolvePathFlagValue, looksLikePath } from "../../src/launcher/path-flags.ts"

describe("PATH_FLAGS", () => {
  test("each entry has flag/kind/mode/required", () => {
    for (const e of PATH_FLAGS) {
      expect(e.flag).toMatch(/^--[a-z][-a-z0-9]*$/)
      expect(["file", "dir"]).toContain(e.kind)
      expect(["ro", "rw"]).toContain(e.mode)
      expect(typeof e.required).toBe("boolean")
    }
  })

  test("flag list has no duplicates", () => {
    const flags = PATH_FLAGS.map(e => e.flag)
    expect(new Set(flags).size).toBe(flags.length)
  })

  test("--skill, --task, --out are present", () => {
    const flags = new Set(PATH_FLAGS.map(e => e.flag))
    expect(flags.has("--skill")).toBe(true)
    expect(flags.has("--task")).toBe(true)
    expect(flags.has("--out")).toBe(true)
  })

  test("csv list flags are marked shape:csv", () => {
    const byFlag = new Map(PATH_FLAGS.map(e => [e.flag, e]))
    for (const f of ["--skill", "--logs", "--failures", "--tasks", "--test-tasks"]) {
      expect(byFlag.get(f)?.shape).toBe("csv")
    }
  })

  test("--tasks / --test-tasks are pathLikeOnly (mixed IDs + paths)", () => {
    const byFlag = new Map(PATH_FLAGS.map(e => [e.flag, e]))
    expect(byFlag.get("--tasks")?.pathLikeOnly).toBe(true)
    expect(byFlag.get("--test-tasks")?.pathLikeOnly).toBe(true)
  })
})

describe("looksLikePath", () => {
  test("treats .json files and slashed values as paths", () => {
    expect(looksLikePath("/tmp/task.json")).toBe(true)
    expect(looksLikePath("task.json")).toBe(true)
    expect(looksLikePath("dir/task")).toBe(true)
  })

  test("treats bare identifiers as non-paths", () => {
    expect(looksLikePath("bench_task_id")).toBe(false)
    expect(looksLikePath("pinch_foo")).toBe(false)
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
