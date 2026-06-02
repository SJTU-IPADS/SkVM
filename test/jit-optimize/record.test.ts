import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  writeEvidenceRecord,
  readEvidenceRecord,
  runRecordDir,
  resolveSafeTaskIds,
  listRunDirs,
} from "../../src/jit-optimize/record.ts"
import type { Evidence } from "../../src/jit-optimize/types.ts"

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "skvm-record-test-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function sampleEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    taskId: "task-A",
    taskPrompt: "do the thing",
    conversationLog: [
      { type: "request", ts: "2026-01-01T00:00:00.000Z", method: "complete", messages: [{ role: "user", content: "hi" }] },
      { type: "response", ts: "2026-01-01T00:00:01.000Z", text: "ok" },
    ],
    workDirSnapshot: {
      files: new Map([
        ["result.txt", "42"],
        ["sub/answer.json", `{"v":1}`],
      ]),
    },
    runMeta: {
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0,
      durationMs: 1234,
      runStatus: "ok",
    },
    criteria: [
      { id: "c1", method: "script", weight: 1, score: 1, passed: true },
    ],
    ...overrides,
  }
}

describe("writeEvidenceRecord / readEvidenceRecord", () => {
  test("roundtrip preserves every field", async () => {
    await withTempDir(async (dir) => {
      const original = sampleEvidence()
      await writeEvidenceRecord(dir, original)
      const read = await readEvidenceRecord(dir)

      expect(read.taskId).toBe(original.taskId)
      expect(read.taskPrompt).toBe(original.taskPrompt)
      expect(read.conversationLog).toEqual(original.conversationLog)
      expect(read.criteria).toEqual(original.criteria)
      expect(read.runMeta).toEqual(original.runMeta)
      expect(read.workDirSnapshot).toBeDefined()
      expect(read.workDirSnapshot!.files.get("result.txt")).toBe("42")
      expect(read.workDirSnapshot!.files.get("sub/answer.json")).toBe(`{"v":1}`)
      expect(read.workDirSnapshot!.files.size).toBe(2)
    })
  })

  test("omits workdir subdir when snapshot absent", async () => {
    await withTempDir(async (dir) => {
      const ev = sampleEvidence({ workDirSnapshot: undefined })
      await writeEvidenceRecord(dir, ev)
      const read = await readEvidenceRecord(dir)
      expect(read.workDirSnapshot).toBeUndefined()
    })
  })

  test("omits conversation.jsonl when log empty", async () => {
    await withTempDir(async (dir) => {
      const ev = sampleEvidence({ conversationLog: [] })
      await writeEvidenceRecord(dir, ev)
      const conv = Bun.file(path.join(dir, "conversation.jsonl"))
      expect(await conv.exists()).toBe(false)
      const read = await readEvidenceRecord(dir)
      expect(read.conversationLog).toEqual([])
    })
  })

  test("preserves empty workdir snapshot as 'captured but empty'", async () => {
    await withTempDir(async (dir) => {
      const ev = sampleEvidence({ workDirSnapshot: { files: new Map() } })
      await writeEvidenceRecord(dir, ev)
      const read = await readEvidenceRecord(dir)
      expect(read.workDirSnapshot).toBeDefined()
      expect(read.workDirSnapshot!.files.size).toBe(0)
    })
  })

  test("omits optional fields when absent", async () => {
    await withTempDir(async (dir) => {
      const ev: Evidence = {
        taskId: "minimal",
        taskPrompt: "p",
        conversationLog: [],
      }
      await writeEvidenceRecord(dir, ev)
      const read = await readEvidenceRecord(dir)
      expect(read.criteria).toBeUndefined()
      expect(read.runMeta).toBeUndefined()
      expect(read.workDirSnapshot).toBeUndefined()
    })
  })
})

describe("runRecordDir / listRunDirs", () => {
  test("sanitises taskId and groups by set", async () => {
    await withTempDir(async (root) => {
      const a = runRecordDir(root, "train", "task/with:slashes", 0)
      const b = runRecordDir(root, "train", "task/with:slashes", 1)
      const c = runRecordDir(root, "test", "other-task", 0)
      await writeEvidenceRecord(a, sampleEvidence({ taskId: "task/with:slashes" }))
      await writeEvidenceRecord(b, sampleEvidence({ taskId: "task/with:slashes" }))
      await writeEvidenceRecord(c, sampleEvidence({ taskId: "other-task" }))

      const dirs = await listRunDirs(root)
      expect(dirs).toHaveLength(3)
      const trainDirs = dirs.filter((d) => d.setLabel === "train").map((d) => d.runDir)
      const testDirs = dirs.filter((d) => d.setLabel === "test").map((d) => d.runDir)
      expect(trainDirs).toContain(a)
      expect(trainDirs).toContain(b)
      expect(testDirs).toContain(c)
      // taskId with slash collapsed to dash, never a raw `/` in the basename
      expect(path.basename(a)).not.toContain("/")
      expect(path.basename(a)).toContain("run0")
    })
  })

  test("listRunDirs returns empty when root absent (no error)", async () => {
    await withTempDir(async (parent) => {
      const dirs = await listRunDirs(path.join(parent, "does-not-exist"))
      expect(dirs).toEqual([])
    })
  })
})

describe("resolveSafeTaskIds", () => {
  test("distinct task ids that slug identically get distinct dirs", async () => {
    await withTempDir(async (root) => {
      // `task:a` and `task a` both raw-slug to `task-a` — without
      // disambiguation they would clobber each other on disk.
      const ids = ["task:a", "task a", "plain"]
      const safe = resolveSafeTaskIds(ids)
      const slugs = ids.map((id) => safe.get(id)!)
      // All three resolved slugs are unique.
      expect(new Set(slugs).size).toBe(3)

      // Write a run record for each under the same set and confirm three
      // separate directories survive (no overwrite).
      const evidenceRoot = path.join(root, "round-0-evidence")
      for (const id of ids) {
        const dir = runRecordDir(evidenceRoot, "train", safe.get(id)!, 0)
        await writeEvidenceRecord(dir, sampleEvidence({ taskId: id }))
      }
      const dirs = await listRunDirs(evidenceRoot)
      expect(dirs).toHaveLength(3)

      // Each persisted record round-trips to its original (distinct) taskId.
      const readBack = await Promise.all(
        dirs.map(async (d) => (await readEvidenceRecord(d.runDir)).taskId),
      )
      expect(new Set(readBack)).toEqual(new Set(ids))
    })
  })

  test("repeated task id maps to a single slug (runs disambiguated by runIdx, not here)", () => {
    const safe = resolveSafeTaskIds(["dup", "dup", "dup"])
    expect(safe.size).toBe(1)
    expect(safe.get("dup")).toBe("dup")
  })

  test("case-only differences do not alias", () => {
    const safe = resolveSafeTaskIds(["Foo", "foo"])
    expect(safe.get("Foo")).not.toBe(safe.get("foo"))
  })

  test("resolved slugs are idempotent through runRecordDir", () => {
    // allocateSafeId emits e.g. `task-a-2`; runRecordDir slugs again and must
    // not mangle it — otherwise the pre-resolved disambiguation is lost.
    const safe = resolveSafeTaskIds(["task:a", "task a"])
    const second = safe.get("task a")!
    expect(second).toBe("task-a-2")
    const dir = runRecordDir("/root", "train", second, 0)
    expect(path.basename(dir)).toBe("task-a-2-run0")
  })
})
