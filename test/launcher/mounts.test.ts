import { test, expect, describe } from "bun:test"
import { composeMounts, type HostRoots } from "../../src/launcher/mounts.ts"

const ROOTS: HostRoots = {
  cwd: "/home/u/proj",
  skvmCache: "/home/u/.skvm",
  skvmDataDir: "/home/u/.skvm-data",
  sanitizedConfigPath: "/tmp/skvm-launcher-1234/skvm.config.json",
}

describe("composeMounts — defaults", () => {
  test("emits three default mounts + sanitized-config overlay", () => {
    const { mounts, argv } = composeMounts({ args: [], roots: ROOTS })
    expect(argv).toEqual([
      "-v", "/home/u/proj:/workspace:rw",
      "-v", "/home/u/.skvm:/skvm-cache:rw",
      "-v", "/home/u/.skvm-data:/skvm-data:ro",
      "-v", "/tmp/skvm-launcher-1234/skvm.config.json:/skvm-cache/skvm.config.json:ro",
    ])
    expect(mounts.length).toBe(4)
  })

  test("omits /skvm-data when skvmDataDir is null", () => {
    const { argv } = composeMounts({
      args: [],
      roots: { ...ROOTS, skvmDataDir: null },
    })
    expect(argv.find(s => s.includes("/skvm-data"))).toBeUndefined()
  })
})

describe("composeMounts — path rewriting under known roots", () => {
  test("rewrites --skill under cwd to /workspace/", () => {
    const { rewrittenArgs } = composeMounts({
      args: ["--skill=/home/u/proj/skills/foo"],
      roots: ROOTS,
    })
    expect(rewrittenArgs).toEqual(["--skill=/workspace/skills/foo"])
  })

  test("rewrites --profiles-dir under skvm-cache", () => {
    const { rewrittenArgs } = composeMounts({
      args: ["--profiles-dir=/home/u/.skvm/profiles"],
      roots: ROOTS,
    })
    expect(rewrittenArgs).toEqual(["--profiles-dir=/skvm-cache/profiles"])
  })
})

describe("composeMounts — out-of-root dynamic mounts", () => {
  test("adds an /extra/ mount for a dir-kind out-of-root --skill", () => {
    const { argv, rewrittenArgs } = composeMounts({
      args: ["--skill=/elsewhere/skills/foo"],
      roots: ROOTS,
    })
    expect(argv).toContain("/elsewhere/skills/foo:/extra/0/foo:ro")
    expect(rewrittenArgs).toEqual(["--skill=/extra/0/foo"])
  })

  test("adds a parent-dir /extra/ mount for a file-kind out-of-root --task", () => {
    const { argv, rewrittenArgs } = composeMounts({
      args: ["--task=/tmp/x/task.json"],
      roots: ROOTS,
    })
    expect(argv).toContain("/tmp/x:/extra/0:ro")
    expect(rewrittenArgs).toEqual(["--task=/extra/0/task.json"])
  })

  test("does not dedupe sibling out-of-root paths — each gets its own /extra/ mount", () => {
    const { argv, rewrittenArgs } = composeMounts({
      args: ["--skill=/elsewhere/a/skill", "--out=/elsewhere/b/out"],
      roots: ROOTS,
    })
    const extraCount = argv.filter(s => s.startsWith("/elsewhere/")).length
    expect(extraCount).toBe(2)
    expect(rewrittenArgs).toEqual([
      "--skill=/extra/0/skill",
      "--out=/extra/1/out",
    ])
  })

  test("dedupes when one out-of-root path contains another (prefix dedup)", () => {
    const { argv, rewrittenArgs } = composeMounts({
      args: ["--out=/elsewhere/work", "--skill=/elsewhere/work/skill"],
      roots: ROOTS,
    })
    const extraCount = argv.filter(s => s.startsWith("/elsewhere/")).length
    expect(extraCount).toBe(1)
    expect(rewrittenArgs).toEqual([
      "--out=/extra/0",
      "--skill=/extra/0/skill",
    ])
    // The broader path's mode (rw, from --out) wins for the merged mount.
    expect(argv).toContain("/elsewhere/work:/extra/0:rw")
  })
})

describe("composeMounts — hard errors", () => {
  test("throws when a required path-flag value does not exist", () => {
    // --skill is required; we point at a non-existent path
    expect(() =>
      composeMounts({
        args: ["--skill=/definitely/not/here"],
        roots: ROOTS,
        existsSync: () => false,
      }),
    ).toThrow(/--skill/)
  })
})
