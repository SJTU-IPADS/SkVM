import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { serializeContext } from "../../src/jit-optimize/workspace.ts"
import type { Evidence, EvidenceCriterion } from "../../src/jit-optimize/types.ts"

function crit(opts: {
  score: number
  passed?: boolean
  weight?: number
  infraError?: string
  name?: string
}): EvidenceCriterion {
  return {
    id: `c-${Math.random().toString(36).slice(2, 8)}`,
    method: "llm-judge",
    weight: opts.weight ?? 1,
    score: opts.score,
    passed: opts.passed ?? opts.score >= 0.5,
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.infraError ? { infraError: opts.infraError } : {}),
  }
}

function ev(
  taskId: string,
  taskPrompt: string,
  criteria: EvidenceCriterion[],
): Evidence {
  return {
    taskId,
    taskPrompt,
    conversationLog: [
      { type: "request", ts: "2026-04-14T00:00:00Z", text: taskPrompt },
      { type: "response", ts: "2026-04-14T00:00:01Z", text: "ok" },
    ],
    workDirSnapshot: { files: new Map() },
    criteria,
    runMeta: {
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0,
      durationMs: 1000,
      skillLoaded: true,
      runStatus: "ok",
    },
  }
}

async function setupOptimizeDir(evidences: Evidence[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "workspace-test-"))
  await serializeContext(dir, evidences, [])
  return dir
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

describe("serializeContext — task-first layout", () => {
  test("groups multiple runs of the same task under tasks/<safeId>/", async () => {
    const dir = await setupOptimizeDir([
      ev("task-A", "do A", [crit({ score: 0.0 })]),
      ev("task-A", "do A", [crit({ score: 0.0 })]),
      ev("task-B", "do B", [crit({ score: 1.0 })]),
      ev("task-B", "do B", [crit({ score: 1.0 })]),
    ])
    try {
      const taskEntries = await readdir(path.join(dir, "tasks"))
      expect(taskEntries.sort()).toEqual(["task-A", "task-B"])

      const aFiles = await readdir(path.join(dir, "tasks", "task-A"))
      expect(aFiles).toContain("summary.md")
      expect(aFiles).toContain("run-0.md")
      expect(aFiles).toContain("run-0.json")
      expect(aFiles).toContain("run-1.md")
      expect(aFiles).toContain("run-1.json")

      const bFiles = await readdir(path.join(dir, "tasks", "task-B"))
      expect(bFiles).toContain("run-0.md")
      expect(bFiles).toContain("run-1.md")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("taskId with slashes is sanitized for the directory name", async () => {
    const dir = await setupOptimizeDir([
      ev("pdf/extract", "extract pdf", [crit({ score: 0.5 })]),
    ])
    try {
      const taskEntries = await readdir(path.join(dir, "tasks"))
      expect(taskEntries).toEqual(["pdf-extract"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("taskId with arbitrary non-fs-safe chars is reduced to a clean slug", async () => {
    const dir = await setupOptimizeDir([
      ev("skill:pdf extract!?", "p", [crit({ score: 0.5 })]),
    ])
    try {
      const taskEntries = await readdir(path.join(dir, "tasks"))
      // Only [a-zA-Z0-9._-] survives, repeats collapsed, leading/trailing
      // dashes trimmed. Colons, spaces, question marks all become dashes.
      expect(taskEntries).toEqual(["skill-pdf-extract"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("taskId that reduces to empty falls back to unnamed-task", async () => {
    const dir = await setupOptimizeDir([
      ev("///", "empty", [crit({ score: 0.5 })]),
    ])
    try {
      const taskEntries = await readdir(path.join(dir, "tasks"))
      expect(taskEntries).toEqual(["unnamed-task"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("dot-segment taskId does NOT escape the tasks directory (Codex review P2)", async () => {
    // `..` as a task id would resolve `path.join(optimizeDir, "tasks", "..")`
    // to optimizeDir itself, clobbering README.md, PER_TASK_SUMMARY.md, etc.
    // Reachable from the log source (file named `...jsonl` → basename after
    // extension strip is `..`). Must fall back to `unnamed-task`.
    const dir = await setupOptimizeDir([
      ev("..", "dot-dot", [crit({ score: 0.5 })]),
    ])
    try {
      const taskEntries = await readdir(path.join(dir, "tasks"))
      expect(taskEntries).toEqual(["unnamed-task"])
      // No stray summary.md / run-0.md in the root (those would indicate
      // the `..` escape had actually written into optimizeDir).
      const rootFiles = await readdir(dir)
      expect(rootFiles).not.toContain("run-0.md")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("pure-dot taskIds of any length are rejected", async () => {
    const dir = await setupOptimizeDir([
      ev(".", "single dot", [crit({ score: 0.5 })]),
      ev("....", "four dots", [crit({ score: 0.5 })]),
    ])
    try {
      const taskEntries = await readdir(path.join(dir, "tasks"))
      // Both fall back to `unnamed-task`, then the collision disambiguator
      // gives the second one a `-2` suffix.
      expect(taskEntries.sort()).toEqual(["unnamed-task", "unnamed-task-2"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("two distinct task ids that collapse to the same slug land in separate directories (Codex review P2)", async () => {
    // `pdf/extract` and `pdf:extract` both sanitize to `pdf-extract`.
    // Without disambiguation the second group overwrites the first.
    const dir = await setupOptimizeDir([
      ev("pdf/extract", "slash form", [crit({ score: 0.2 })]),
      ev("pdf:extract", "colon form", [crit({ score: 0.9 })]),
    ])
    try {
      const taskEntries = await readdir(path.join(dir, "tasks"))
      expect(taskEntries.sort()).toEqual(["pdf-extract", "pdf-extract-2"])
      const firstRun = await readFile(
        path.join(dir, "tasks", "pdf-extract", "run-0.md"),
        "utf-8",
      )
      const secondRun = await readFile(
        path.join(dir, "tasks", "pdf-extract-2", "run-0.md"),
        "utf-8",
      )
      expect(firstRun).toContain("slash form")
      expect(secondRun).toContain("colon form")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("case-only collision is disambiguated (APFS is case-insensitive by default)", async () => {
    const dir = await setupOptimizeDir([
      ev("TaskA", "upper", [crit({ score: 0.5 })]),
      ev("taska", "lower", [crit({ score: 0.5 })]),
    ])
    try {
      const taskEntries = await readdir(path.join(dir, "tasks"))
      expect(taskEntries.length).toBe(2)
      const lowerNames = taskEntries.map((n) => n.toLowerCase()).sort()
      expect(lowerNames).toEqual(["taska", "taska-2"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("does NOT emit the legacy flat evidence-N.md files", async () => {
    const dir = await setupOptimizeDir([
      ev("task-A", "do A", [crit({ score: 0.5 })]),
      ev("task-A", "do A", [crit({ score: 0.5 })]),
    ])
    try {
      const top = await readdir(dir)
      expect(top.some((f) => f.startsWith("evidence-"))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("each run-N.md records its global Evidence Index", async () => {
    const dir = await setupOptimizeDir([
      ev("task-A", "a", [crit({ score: 0.0 })]), // global 0
      ev("task-B", "b", [crit({ score: 1.0 })]), // global 1
      ev("task-A", "a", [crit({ score: 0.0 })]), // global 2 (second run of A)
    ])
    try {
      const aRun0 = await readFile(path.join(dir, "tasks", "task-A", "run-0.md"), "utf-8")
      const aRun1 = await readFile(path.join(dir, "tasks", "task-A", "run-1.md"), "utf-8")
      const bRun0 = await readFile(path.join(dir, "tasks", "task-B", "run-0.md"), "utf-8")
      expect(aRun0).toContain("Evidence Index (global): 0")
      expect(bRun0).toContain("Evidence Index (global): 1")
      expect(aRun1).toContain("Evidence Index (global): 2")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("PER_TASK_SUMMARY.md — status bucketing", () => {
  test("FAILING / MARGINAL / PASSING buckets honour the 0.5 and 0.9 boundaries", async () => {
    const dir = await setupOptimizeDir([
      ev("task-failing", "f", [crit({ score: 0.2 })]),
      ev("task-marginal", "m", [crit({ score: 0.7 })]),
      ev("task-passing", "p", [crit({ score: 0.95 })]),
    ])
    try {
      const summary = await readFile(path.join(dir, "PER_TASK_SUMMARY.md"), "utf-8")
      expect(summary).toContain("`task-failing`")
      expect(summary).toContain("`task-marginal`")
      expect(summary).toContain("`task-passing`")
      // Status bucketing
      const failingRow = summary.split("\n").find((l) => l.includes("task-failing"))
      expect(failingRow).toBeDefined()
      expect(failingRow!).toContain("FAILING")
      const marginalRow = summary.split("\n").find((l) => l.includes("task-marginal"))
      expect(marginalRow!).toContain("MARGINAL")
      const passingRow = summary.split("\n").find((l) => l.includes("task-passing"))
      expect(passingRow!).toContain("PASSING")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("fully-tainted task lands in TAINTED bucket", async () => {
    const dir = await setupOptimizeDir([
      ev("task-broken", "x", [crit({ score: 0, infraError: "timeout" })]),
    ])
    try {
      const summary = await readFile(path.join(dir, "PER_TASK_SUMMARY.md"), "utf-8")
      const row = summary.split("\n").find((l) => l.includes("task-broken"))
      expect(row!).toContain("TAINTED")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rows are sorted by mean score ascending (failures at the top)", async () => {
    const dir = await setupOptimizeDir([
      ev("task-ok", "ok", [crit({ score: 0.95 })]),
      ev("task-broken", "br", [crit({ score: 0.1 })]),
      ev("task-mid", "mid", [crit({ score: 0.6 })]),
    ])
    try {
      const summary = await readFile(path.join(dir, "PER_TASK_SUMMARY.md"), "utf-8")
      const lines = summary.split("\n")
      const brokenIdx = lines.findIndex((l) => l.includes("task-broken"))
      const midIdx = lines.findIndex((l) => l.includes("task-mid"))
      const okIdx = lines.findIndex((l) => l.includes("task-ok"))
      expect(brokenIdx).toBeLessThan(midIdx)
      expect(midIdx).toBeLessThan(okIdx)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("summary lists global Evidence Indices for each task", async () => {
    const dir = await setupOptimizeDir([
      ev("task-A", "a", [crit({ score: 0.5 })]),
      ev("task-B", "b", [crit({ score: 0.5 })]),
      ev("task-A", "a", [crit({ score: 0.5 })]),
    ])
    try {
      const summary = await readFile(path.join(dir, "PER_TASK_SUMMARY.md"), "utf-8")
      const aRow = summary.split("\n").find((l) => l.includes("task-A"))!
      const bRow = summary.split("\n").find((l) => l.includes("task-B"))!
      // task-A's two runs landed at global index 0 and 2; task-B's single run at 1.
      expect(aRow).toContain("0,2")
      expect(bRow).toMatch(/\|\s*1\s*\|/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("task summary.md", () => {
  test("includes per-run breakdown and mean", async () => {
    const dir = await setupOptimizeDir([
      ev("task-A", "a", [crit({ score: 0.2 })]),
      ev("task-A", "a", [crit({ score: 0.4 })]),
    ])
    try {
      const summary = await readFile(path.join(dir, "tasks", "task-A", "summary.md"), "utf-8")
      expect(summary).toContain("Task `task-A`")
      expect(summary).toContain("mean score: 0.300")
      expect(summary).toContain("| run-0 | 0 |")
      expect(summary).toContain("| run-1 | 1 |")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("workdir snapshot placement", () => {
  test("workdir files land under tasks/<safeId>/run-N-workdir/", async () => {
    const taskEv: Evidence = {
      taskId: "task-A",
      taskPrompt: "do A",
      conversationLog: [],
      workDirSnapshot: { files: new Map([["out.txt", "hello"]]) },
      criteria: [crit({ score: 0.5 })],
      runMeta: {
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0,
        durationMs: 0,
        skillLoaded: true,
        runStatus: "ok",
      },
    }
    const dir = await setupOptimizeDir([taskEv])
    try {
      const workdirFile = path.join(dir, "tasks", "task-A", "run-0-workdir", "out.txt")
      expect(await pathExists(workdirFile)).toBe(true)
      const content = await readFile(workdirFile, "utf-8")
      expect(content).toBe("hello")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

function evWithSkill(opts: {
  taskId?: string
  provided?: boolean
  mode?: "inject" | "discover"
  legacyOnly?: boolean   // when true, only set skillLoaded (no skillProvided/skillMode)
}): Evidence {
  return {
    taskId: opts.taskId ?? "t1",
    taskPrompt: "do the thing",
    conversationLog: [
      { type: "request", ts: "2026-04-14T00:00:00Z", text: "do the thing" },
      { type: "response", ts: "2026-04-14T00:00:01Z", text: "ok" },
    ],
    workDirSnapshot: { files: new Map() },
    criteria: [crit({ score: 0.5, passed: true })],
    runMeta: {
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0,
      durationMs: 1000,
      ...(opts.legacyOnly
        ? { skillLoaded: opts.provided ?? false }
        : {
            ...(opts.provided !== undefined ? { skillProvided: opts.provided, skillLoaded: opts.provided } : {}),
            ...(opts.mode ? { skillMode: opts.mode } : {}),
          }),
      runStatus: "ok",
    },
  }
}

async function readRunMd(evidences: Evidence[]): Promise<string> {
  const dir = await setupOptimizeDir(evidences)
  try {
    // task-first layout: tasks/<safeTaskId>/run-0.md
    const tasksRoot = path.join(dir, "tasks")
    const taskDirs = await readdir(tasksRoot)
    let combined = ""
    for (const td of taskDirs) {
      const runFiles = (await readdir(path.join(tasksRoot, td))).filter(f => f.startsWith("run-") && f.endsWith(".md"))
      for (const rf of runFiles) {
        combined += await readFile(path.join(tasksRoot, td, rf), "utf-8")
        combined += "\n"
      }
    }
    return combined
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("workspace skill-loaded WARNING is mode-aware", () => {
  test("inject + provided=false → WARNING with inject-mode wording", async () => {
    const md = await readRunMd([evWithSkill({ provided: false, mode: "inject" })])
    expect(md).toContain("WARNING: skill failed to load (inject mode")
  })

  test("discover + provided=false → discover-mode WARNING, no inject wording", async () => {
    const md = await readRunMd([evWithSkill({ provided: false, mode: "discover" })])
    expect(md).toContain("WARNING: skill not recognized by harness (discover mode")
    expect(md).not.toContain("inject mode")
  })

  test("provided=true → no WARNING in either mode", async () => {
    const inj = await readRunMd([evWithSkill({ provided: true, mode: "inject" })])
    const dis = await readRunMd([evWithSkill({ provided: true, mode: "discover" })])
    expect(inj).not.toContain("WARNING: skill")
    expect(dis).not.toContain("WARNING: skill")
  })

  test("legacy skillLoaded=false (no skillMode) emits the original wording", async () => {
    // Back-compat: evidence written by old adapters before this migration.
    const md = await readRunMd([evWithSkill({ provided: false, legacyOnly: true })])
    expect(md).toContain("WARNING: skill was not loaded")
    // The new mode-specific wordings must NOT trigger in the legacy branch.
    expect(md).not.toContain("inject mode")
    expect(md).not.toContain("discover mode")
  })
})
