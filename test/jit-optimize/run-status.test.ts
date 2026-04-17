import { test, expect, describe } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

import {
  readRunStatus,
  writeRunStatus,
  patchRunStatus,
  selfHealRunStatus,
  runStatusExists,
  type RunStatus,
} from "../../src/jit-optimize/run-status.ts"

async function tmpDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "skvm-run-status-"))
}

describe("run-status — read/write round-trip", () => {
  test("absent file returns null", async () => {
    const dir = await tmpDir()
    try {
      expect(await readRunStatus(dir)).toBeNull()
      expect(await runStatusExists(dir)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("write then read preserves all fields", async () => {
    const dir = await tmpDir()
    try {
      const s: RunStatus = {
        phase: "running",
        pid: 12345,
        startedAt: "2026-04-16T10:00:00.000Z",
        finishedAt: null,
        error: null,
      }
      await writeRunStatus(dir, s)
      expect(await runStatusExists(dir)).toBe(true)
      expect(await readRunStatus(dir)).toEqual(s)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("patchRunStatus merges fields", async () => {
    const dir = await tmpDir()
    try {
      await writeRunStatus(dir, {
        phase: "running",
        pid: 1,
        startedAt: "2026-04-16T10:00:00.000Z",
        finishedAt: null,
        error: null,
      })
      const after = await patchRunStatus(dir, {
        phase: "done",
        finishedAt: "2026-04-16T10:05:00.000Z",
      })
      expect(after?.phase).toBe("done")
      expect(after?.finishedAt).toBe("2026-04-16T10:05:00.000Z")
      expect(after?.pid).toBe(1) // preserved
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("malformed JSON treated as absent (no crash)", async () => {
    const dir = await tmpDir()
    try {
      await writeFile(path.join(dir, "run-status.json"), "{not json")
      expect(await readRunStatus(dir)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("run-status — selfHealRunStatus", () => {
  test("dead pid in running flips to failed", async () => {
    const dir = await tmpDir()
    try {
      // Pick a pid that is definitely not allocated by walking down from a
      // high value until we see ESRCH on kill -0.
      let deadPid = 999999
      for (; deadPid > 100000; deadPid -= 1) {
        try {
          process.kill(deadPid, 0)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") break
        }
      }
      await writeRunStatus(dir, {
        phase: "running",
        pid: deadPid,
        startedAt: "2026-04-16T10:00:00.000Z",
        finishedAt: null,
        error: null,
      })
      const healed = await selfHealRunStatus(dir)
      expect(healed?.phase).toBe("failed")
      expect(healed?.error).toContain(`worker pid ${deadPid} disappeared`)
      expect(healed?.finishedAt).not.toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("live pid in running stays running", async () => {
    const dir = await tmpDir()
    try {
      await writeRunStatus(dir, {
        phase: "running",
        pid: process.pid,
        startedAt: "2026-04-16T10:00:00.000Z",
        finishedAt: null,
        error: null,
      })
      const after = await selfHealRunStatus(dir)
      expect(after?.phase).toBe("running")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("done phase ignored by self-heal", async () => {
    const dir = await tmpDir()
    try {
      await writeRunStatus(dir, {
        phase: "done",
        pid: 999999,
        startedAt: "2026-04-16T10:00:00.000Z",
        finishedAt: "2026-04-16T10:05:00.000Z",
        error: null,
      })
      const after = await selfHealRunStatus(dir)
      expect(after?.phase).toBe("done")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
