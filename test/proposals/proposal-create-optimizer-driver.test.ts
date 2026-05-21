import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import path from "node:path"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import os from "node:os"

// SKVM_PROPOSALS_DIR is captured at storage.ts module load time. To control
// where proposals land, set the env var BEFORE importing storage.ts.
// Mirrors the pattern used in test/proposals/storage.test.ts.
//
// NOTE: when this file runs as part of a suite alongside storage.test.ts,
// the module may already be cached with storage.test.ts's tmpRoot as the
// proposals root. We therefore derive the expected root from JIT_OPTIMIZE_DIR
// at runtime (the actual frozen path the module uses) rather than from our
// own mkdtemp call. The guard still catches the real regression — proposals
// landing in the global ~/.skvm cache — because all temp roots live under
// os.tmpdir().

let jitOptimizeDir: string
let skillDirA: string
let skillDirB: string
let createProposal: typeof import("../../src/proposals/storage.ts").createProposal

beforeAll(async () => {
  const proposalsRoot = await mkdtemp(path.join(os.tmpdir(), "skvm-proposals-"))
  process.env.SKVM_PROPOSALS_DIR = proposalsRoot
  ;({ createProposal } = await import("../../src/proposals/storage.ts"))
  // Read back the actual frozen path that the loaded module resolved to.
  // (If the module was already cached by storage.test.ts, JIT_OPTIMIZE_DIR
  // will point to that file's tmpRoot — still under os.tmpdir(), not ~/.skvm.)
  ;({ JIT_OPTIMIZE_DIR: jitOptimizeDir } = await import("../../src/core/config.ts"))

  // createProposal copies the skillDir — these must be real directories.
  skillDirA = await mkdtemp(path.join(os.tmpdir(), "skvm-skill-"))
  skillDirB = await mkdtemp(path.join(os.tmpdir(), "skvm-skill-"))
})

afterAll(async () => {
  await rm(skillDirA, { recursive: true, force: true })
  await rm(skillDirB, { recursive: true, force: true })
  delete process.env.SKVM_PROPOSALS_DIR
})

describe("createProposal records optimizerDriver in meta.json", () => {
  test("writes optimizerDriver = pi when supplied", async () => {
    const { dir } = await createProposal({
      skillName: "demo",
      skillDir: skillDirA,
      harness: "opencode",
      optimizerModel: "anthropic/claude-sonnet-4.6",
      targetModel: "anthropic/claude-sonnet-4.6",
      source: "synthetic",
      optimizerDriver: "pi",
    })
    const meta = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf-8"))
    expect(meta.optimizerDriver).toBe("pi")
    // Regression guard: proposals must land under a temp dir (not the global
    // ~/.skvm cache). jitOptimizeDir reflects the actual frozen path the
    // module resolved to, which is always under os.tmpdir() in tests.
    expect(dir.startsWith(jitOptimizeDir)).toBe(true)
    expect(dir.startsWith(os.tmpdir())).toBe(true)
  })

  test("omits optimizerDriver when not supplied", async () => {
    const { dir } = await createProposal({
      skillName: "demo2",
      skillDir: skillDirB,
      harness: "opencode",
      optimizerModel: "anthropic/claude-sonnet-4.6",
      targetModel: "anthropic/claude-sonnet-4.6",
      source: "synthetic",
    })
    const meta = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf-8"))
    expect(meta.optimizerDriver).toBeUndefined()
    expect(dir.startsWith(jitOptimizeDir)).toBe(true)
    expect(dir.startsWith(os.tmpdir())).toBe(true)
  })
})
