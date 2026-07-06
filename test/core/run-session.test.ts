import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import path from "node:path"
import { mkdtemp, rm, unlink } from "node:fs/promises"
import os from "node:os"
import { RunSession, readSessions } from "../../src/core/run-session.ts"
import { SKVM_CACHE, SESSIONS_INDEX_PATH } from "../../src/core/config.ts"

// SKVM_CACHE is redirected to a temp dir by the bunfig preload, so these
// tests never touch the real ~/.skvm sessions index. The index is shared
// across the test process — every assertion filters by session id, and the
// index is restored afterwards (test/cli/logs.test.ts asserts on an empty
// cache).

let priorIndex: string | null = null
let outsideDir: string | undefined

beforeAll(async () => {
  priorIndex = await Bun.file(SESSIONS_INDEX_PATH).text().catch(() => null)
})

afterAll(async () => {
  if (priorIndex === null) await unlink(SESSIONS_INDEX_PATH).catch(() => {})
  else await Bun.write(SESSIONS_INDEX_PATH, priorIndex)
  if (outsideDir) await rm(outsideDir, { recursive: true, force: true })
})

async function findEntry(id: string) {
  const entries = await readSessions()
  return entries.filter((e) => e.id === id)
}

describe("RunSession.rehydrate", () => {
  test("start → drop → rehydrate → complete: terminal entry wins", async () => {
    const logDir = path.join(SKVM_CACHE, "log", "bench", "rehydrate-complete")
    const original = await RunSession.start({
      type: "bench",
      tag: "rehydrate-complete",
      logDir,
      models: ["test/model-a"],
      harness: "bare-agent",
    })
    const { id, startedAt } = original
    // Simulate process loss: the original object is simply never used again.

    const session = await RunSession.rehydrate(id)
    expect(session).not.toBeNull()
    // Rebound instance carries the fields a live session captured at start().
    expect(session!.id).toBe(id)
    expect(session!.type).toBe("bench")
    expect(session!.startedAt).toBe(startedAt)
    expect(session!.logDir).toBe(logDir) // resolved back to absolute

    await session!.complete("resumed and finished")

    const matches = await findEntry(id)
    expect(matches).toHaveLength(1) // last-wins dedup collapses to one entry
    const entry = matches[0]!
    expect(entry.status).toBe("completed")
    expect(entry.summary).toBe("resumed and finished")
    expect(entry.startedAt).toBe(startedAt) // original start time preserved
    expect(entry.completedAt).toBeDefined()
    expect(entry.logDir).toBe(path.relative(SKVM_CACHE, logDir))
  })

  test("start → drop → rehydrate → fail: terminal entry wins", async () => {
    const logDir = path.join(SKVM_CACHE, "log", "bench", "rehydrate-fail")
    const { id } = await RunSession.start({
      type: "bench",
      tag: "rehydrate-fail",
      logDir,
    })

    const session = await RunSession.rehydrate(id)
    expect(session).not.toBeNull()
    await session!.fail("provider exploded")

    const matches = await findEntry(id)
    expect(matches).toHaveLength(1)
    expect(matches[0]!.status).toBe("failed")
    expect(matches[0]!.error).toBe("provider exploded")
  })

  test("rehydrating an already-failed session can re-mark it completed (last wins)", async () => {
    // A run interrupted after #85 marked it failed; resuming and finishing
    // must flip the visible state to completed.
    const logDir = path.join(SKVM_CACHE, "log", "bench", "rehydrate-flip")
    const original = await RunSession.start({
      type: "bench",
      tag: "rehydrate-flip",
      logDir,
    })
    await original.fail("interrupted")

    const session = await RunSession.rehydrate(original.id)
    expect(session).not.toBeNull()
    await session!.complete("second attempt done")

    const matches = await findEntry(original.id)
    expect(matches).toHaveLength(1)
    expect(matches[0]!.status).toBe("completed")
    expect(matches[0]!.summary).toBe("second attempt done")
  })

  test("preserves an absolute logDir outside the cache root", async () => {
    outsideDir = await mkdtemp(path.join(os.tmpdir(), "skvm-rehydrate-")) // removed in afterAll
    const { id } = await RunSession.start({
      type: "profile",
      tag: "rehydrate-outside",
      logDir: outsideDir,
    })

    const session = await RunSession.rehydrate(id)
    expect(session).not.toBeNull()
    expect(session!.logDir).toBe(outsideDir)
    expect(session!.type).toBe("profile")
  })

  test("returns null for an id not in the index", async () => {
    const session = await RunSession.rehydrate("20990101-000000-bench-nonexistent")
    expect(session).toBeNull()
  })
})
