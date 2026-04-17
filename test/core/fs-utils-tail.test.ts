import { test, expect, describe } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

import { readLastLines } from "../../src/core/fs-utils.ts"

async function tmpDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "skvm-tail-"))
}

describe("readLastLines", () => {
  test("missing file returns null", async () => {
    const dir = await tmpDir()
    try {
      expect(await readLastLines(path.join(dir, "nope.log"), 20)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("empty file returns null", async () => {
    const dir = await tmpDir()
    try {
      const f = path.join(dir, "empty.log")
      await writeFile(f, "")
      expect(await readLastLines(f, 20)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("small file — fewer than n lines returns everything", async () => {
    const dir = await tmpDir()
    try {
      const f = path.join(dir, "small.log")
      await writeFile(f, "a\nb\nc\n")
      expect(await readLastLines(f, 20)).toBe("a\nb\nc")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("small file — more than n lines returns last n", async () => {
    const dir = await tmpDir()
    try {
      const f = path.join(dir, "medium.log")
      const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`)
      await writeFile(f, lines.join("\n") + "\n")
      const tail = await readLastLines(f, 5)
      expect(tail).toBe("line-45\nline-46\nline-47\nline-48\nline-49")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("file larger than chunk drops truncated first line", async () => {
    // Build a 128 KB file where each line has a serial number. The last
    // ~20 lines are well inside the 64 KB tail chunk; the boundary line
    // (the one the chunk start cuts through) must not appear in output.
    const dir = await tmpDir()
    try {
      const f = path.join(dir, "big.log")
      const line = (n: number) => `log-line-${n.toString().padStart(6, "0")}-${"x".repeat(100)}`
      const lines: string[] = []
      for (let i = 0; i < 2000; i += 1) lines.push(line(i))
      await writeFile(f, lines.join("\n") + "\n")
      const tail = await readLastLines(f, 5)
      expect(tail).toBe([line(1995), line(1996), line(1997), line(1998), line(1999)].join("\n"))
      // Confirm we really exercised the chunk path: file must be >> chunk
      const size = Bun.file(f).size
      expect(size).toBeGreaterThan(64 * 1024)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("file with no trailing newline", async () => {
    const dir = await tmpDir()
    try {
      const f = path.join(dir, "no-trailing.log")
      await writeFile(f, "one\ntwo\nthree")
      expect(await readLastLines(f, 2)).toBe("two\nthree")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
