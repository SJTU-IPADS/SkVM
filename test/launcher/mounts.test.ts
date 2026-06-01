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
      existsSync: () => true,
    })
    expect(argv).toContain("/elsewhere/skills/foo:/extra/0/foo:ro")
    expect(rewrittenArgs).toEqual(["--skill=/extra/0/foo"])
  })

  test("adds a parent-dir /extra/ mount for a file-kind out-of-root --task", () => {
    const { argv, rewrittenArgs } = composeMounts({
      args: ["--task=/tmp/x/task.json"],
      roots: ROOTS,
      existsSync: () => true,
    })
    expect(argv).toContain("/tmp/x:/extra/0:ro")
    expect(rewrittenArgs).toEqual(["--task=/extra/0/task.json"])
  })

  test("does not dedupe sibling out-of-root paths — each gets its own /extra/ mount", () => {
    const { argv, rewrittenArgs } = composeMounts({
      args: ["--skill=/elsewhere/a/skill", "--out=/elsewhere/b/out"],
      roots: ROOTS,
      existsSync: () => true,
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
      existsSync: () => true,
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

describe("composeMounts — csv path flags", () => {
  test("rewrites each element of an out-of-root --skill list to its own /extra mount", () => {
    const { argv, rewrittenArgs } = composeMounts({
      args: ["--skill=/tmp/a,/tmp/b"],
      roots: ROOTS,
      existsSync: () => true,
    })
    expect(rewrittenArgs).toEqual(["--skill=/extra/0/a,/extra/1/b"])
    expect(argv).toContain("/tmp/a:/extra/0/a:ro")
    expect(argv).toContain("/tmp/b:/extra/1/b:ro")
  })

  test("rewrites each element of an out-of-root --logs list (file-kind parent mounts)", () => {
    const { argv, rewrittenArgs } = composeMounts({
      args: ["--logs=/tmp/a.jsonl,/tmp/b.jsonl"],
      roots: ROOTS,
      existsSync: () => true,
    })
    // Both files share parent /tmp → prefix dedup into a single /extra/0 mount.
    expect(rewrittenArgs).toEqual(["--logs=/extra/0/a.jsonl,/extra/0/b.jsonl"])
    expect(argv).toContain("/tmp:/extra/0:ro")
  })

  test("mixes fixed-root and out-of-root elements within one csv flag", () => {
    const { rewrittenArgs } = composeMounts({
      args: ["--skill=/home/u/proj/skills/in,/tmp/out"],
      roots: ROOTS,
      existsSync: () => true,
    })
    expect(rewrittenArgs).toEqual(["--skill=/workspace/skills/in,/extra/0/out"])
  })

  test("--tasks (pathLikeOnly) leaves bare task IDs untouched and rewrites only paths", () => {
    const { rewrittenArgs } = composeMounts({
      args: ["--tasks=bench_task_id,/tmp/task.json"],
      roots: ROOTS,
      existsSync: () => true,
    })
    expect(rewrittenArgs).toEqual(["--tasks=bench_task_id,/extra/0/task.json"])
  })
})

describe("composeMounts — extra mounts", () => {
  test("applies config extraMounts after defaults, before dynamic", () => {
    const { argv } = composeMounts({
      args: [],
      roots: ROOTS,
      configExtraMounts: [{ host: "/h/.ssh", inner: "/root/.ssh", mode: "ro" }],
    })
    expect(argv).toContain("/h/.ssh:/root/.ssh:ro")
  })

  test("applies CLI --mount-extra triples", () => {
    const { argv } = composeMounts({
      args: [],
      roots: ROOTS,
      cliExtraMounts: [{ host: "/h/.gitconfig", inner: "/root/.gitconfig", mode: "ro" }],
    })
    expect(argv).toContain("/h/.gitconfig:/root/.gitconfig:ro")
  })
})
