import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import path from "node:path"
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises"
import os from "node:os"

// SKVM_PROPOSALS_DIR is read at module load time (config.ts:68 captures it
// into PROPOSALS_ROOT, which JIT_OPTIMIZE_DIR is derived from). Tests must
// set the env var BEFORE the first import of storage.ts; we use a top-level
// tmpdir + dynamic import inside beforeAll.

let tmpRoot: string
let storage: typeof import("../../src/proposals/storage.ts")
let safeModelName: (m: string) => string

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "skvm-proposals-test-"))
  process.env.SKVM_PROPOSALS_DIR = tmpRoot
  storage = await import("../../src/proposals/storage.ts")
  ;({ safeModelName } = await import("../../src/core/config.ts"))
})

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
  delete process.env.SKVM_PROPOSALS_DIR
})

async function makeFakeSkill(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `skvm-skill-${name}-`))
  await writeFile(path.join(dir, "SKILL.md"), `# ${name}\n\nfake skill body\n`)
  return dir
}

describe("proposals storage — target-model keying", () => {
  test("createProposal writes under target-model segment, not optimizer-model", async () => {
    const skillDir = await makeFakeSkill("calc")
    try {
      const result = await storage.createProposal({
        skillName: "calc",
        skillDir,
        harness: "bare-agent",
        optimizerModel: "anthropic/claude-opus-4.6",
        targetModel: "openrouter/qwen/qwen3-30b-a3b",
        source: "test",
      })

      const expectedSegment = safeModelName("openrouter/qwen/qwen3-30b-a3b")
      expect(result.id).toContain(`bare-agent/${expectedSegment}/calc/`)
      expect(result.dir).toContain(`bare-agent/${expectedSegment}/calc/`)
      // optimizer model must NOT appear in the path
      expect(result.dir).not.toContain(safeModelName("anthropic/claude-opus-4.6"))

      // meta.json records both
      const meta = JSON.parse(await readFile(path.join(result.dir, "meta.json"), "utf-8"))
      expect(meta.targetModel).toBe("openrouter/qwen/qwen3-30b-a3b")
      expect(meta.optimizerModel).toBe("anthropic/claude-opus-4.6")
    } finally {
      await rm(skillDir, { recursive: true, force: true })
    }
  })

  test("getLatestBestRoundDir finds proposal by (harness, targetModel, skillName)", async () => {
    const skillDir = await makeFakeSkill("translator")
    try {
      const created = await storage.createProposal({
        skillName: "translator",
        skillDir,
        harness: "openclaw",
        optimizerModel: "openrouter/z-ai/glm-5.1",
        targetModel: "openrouter/qwen/qwen3-30b-a3b",
        source: "test",
      })
      // Simulate a finished proposal: write meta.json with bestRound=1 and create round-1/
      await mkdir(path.join(created.dir, "round-1"), { recursive: true })
      await writeFile(path.join(created.dir, "round-1", "SKILL.md"), "v1")
      const metaPath = path.join(created.dir, "meta.json")
      const meta = JSON.parse(await readFile(metaPath, "utf-8"))
      meta.bestRound = 1
      meta.roundCount = 2
      await writeFile(metaPath, JSON.stringify(meta))

      const found = await storage.getLatestBestRoundDir(
        "openclaw",
        "openrouter/qwen/qwen3-30b-a3b",
        "translator",
      )
      expect(found).not.toBeNull()
      expect(found).toBe(path.join(created.dir, "round-1"))

      // Wrong target model returns null even though optimizer matches
      const miss = await storage.getLatestBestRoundDir(
        "openclaw",
        "anthropic/claude-opus-4.6",
        "translator",
      )
      expect(miss).toBeNull()
    } finally {
      await rm(skillDir, { recursive: true, force: true })
    }
  })

  test("locks isolate by target model, not optimizer", async () => {
    // Same harness + skill + optimizer, two different targets — must NOT
    // block each other (this was the bug under the old layout).
    const got1 = await storage.acquireOptimizeLock("bare-agent", "openrouter/qwen/qwen3-30b-a3b", "lockskill")
    const got2 = await storage.acquireOptimizeLock("bare-agent", "anthropic/claude-opus-4.6", "lockskill")
    try {
      expect(got1).toBe(true)
      expect(got2).toBe(true)
      // Re-acquiring the same (harness, target, skill) is blocked.
      const got1Again = await storage.acquireOptimizeLock("bare-agent", "openrouter/qwen/qwen3-30b-a3b", "lockskill")
      expect(got1Again).toBe(false)
    } finally {
      await storage.releaseOptimizeLock("bare-agent", "openrouter/qwen/qwen3-30b-a3b", "lockskill")
      await storage.releaseOptimizeLock("bare-agent", "anthropic/claude-opus-4.6", "lockskill")
    }
  })

  test("getLatestBestRoundDir skips infra-blocked proposals", async () => {
    // Two proposals for the same (harness, target, skill). Newest is
    // infra-blocked; older is a normal finished proposal. getLatestBestRoundDir
    // must fall through to the older one.
    const skillDir = await makeFakeSkill("abstain-skill")
    try {
      const older = await storage.createProposal({
        skillName: "abstain-skill",
        skillDir,
        harness: "hermes",
        optimizerModel: "anthropic/claude-sonnet-4-6",
        targetModel: "openrouter/deepseek/deepseek-v3.2",
        source: "test",
      })
      // Make the older proposal a completed, non-blocked session with
      // bestRound=1.
      await mkdir(path.join(older.dir, "round-1"), { recursive: true })
      await writeFile(path.join(older.dir, "round-1", "SKILL.md"), "older-best")
      const olderMetaPath = path.join(older.dir, "meta.json")
      const olderMeta = JSON.parse(await readFile(olderMetaPath, "utf-8"))
      olderMeta.bestRound = 1
      olderMeta.roundCount = 2
      olderMeta.status = "pending"
      await writeFile(olderMetaPath, JSON.stringify(olderMeta))

      // Sleep 1.1s so the tsString() timestamps differ by >= 1 second.
      // (tsString is second-granularity UTC.)
      await new Promise((r) => setTimeout(r, 1100))

      const newer = await storage.createProposal({
        skillName: "abstain-skill",
        skillDir,
        harness: "hermes",
        optimizerModel: "anthropic/claude-sonnet-4-6",
        targetModel: "openrouter/deepseek/deepseek-v3.2",
        source: "test",
      })
      // Mark newer proposal as infra-blocked. round-0 exists from
      // createProposal (copy of skillDir), which is all the bench needs.
      const newerMetaPath = path.join(newer.dir, "meta.json")
      const newerMeta = JSON.parse(await readFile(newerMetaPath, "utf-8"))
      newerMeta.status = "infra-blocked"
      newerMeta.blockedReason = "Evidence 0 timed out"
      newerMeta.blockedEvidenceIds = ["0"]
      newerMeta.roundCount = 1
      await writeFile(newerMetaPath, JSON.stringify(newerMeta))

      const found = await storage.getLatestBestRoundDir(
        "hermes",
        "openrouter/deepseek/deepseek-v3.2",
        "abstain-skill",
      )
      expect(found).toBe(path.join(older.dir, "round-1"))

      // describeLatestProposalState should report has-usable (older exists).
      const state = await storage.describeLatestProposalState(
        "hermes",
        "openrouter/deepseek/deepseek-v3.2",
        "abstain-skill",
      )
      expect(state).toBe("has-usable")
    } finally {
      await rm(skillDir, { recursive: true, force: true })
    }
  })

  test("getLatestBestRoundDir returns null when only infra-blocked proposals exist", async () => {
    const skillDir = await makeFakeSkill("blocked-only")
    try {
      const p = await storage.createProposal({
        skillName: "blocked-only",
        skillDir,
        harness: "hermes",
        optimizerModel: "anthropic/claude-sonnet-4-6",
        targetModel: "openrouter/deepseek/deepseek-v3.2",
        source: "test",
      })
      const metaPath = path.join(p.dir, "meta.json")
      const meta = JSON.parse(await readFile(metaPath, "utf-8"))
      meta.status = "infra-blocked"
      meta.blockedReason = "Evidence 0 timed out"
      await writeFile(metaPath, JSON.stringify(meta))

      const found = await storage.getLatestBestRoundDir(
        "hermes",
        "openrouter/deepseek/deepseek-v3.2",
        "blocked-only",
      )
      expect(found).toBeNull()

      const state = await storage.describeLatestProposalState(
        "hermes",
        "openrouter/deepseek/deepseek-v3.2",
        "blocked-only",
      )
      expect(state).toBe("only-blocked")
    } finally {
      await rm(skillDir, { recursive: true, force: true })
    }
  })

  test("describeLatestProposalState reports 'none' when no proposals exist", async () => {
    const state = await storage.describeLatestProposalState(
      "hermes",
      "openrouter/deepseek/deepseek-v3.2",
      "never-existed",
    )
    expect(state).toBe("none")
  })

  test("finalizeProposal honors status override", async () => {
    const skillDir = await makeFakeSkill("finalize-block")
    try {
      const p = await storage.createProposal({
        skillName: "finalize-block",
        skillDir,
        harness: "hermes",
        optimizerModel: "anthropic/claude-sonnet-4-6",
        targetModel: "openrouter/deepseek/deepseek-v3.2",
        source: "test",
      })
      await storage.finalizeProposal(p.dir, {
        bestRound: 0,
        bestRoundReason: "infra-blocked at round-1: timeout",
        history: [],
        rounds: [],
        status: "infra-blocked",
        blockedReason: "timeout x1",
        blockedEvidenceIds: ["0"],
      })
      const meta = JSON.parse(await readFile(path.join(p.dir, "meta.json"), "utf-8"))
      expect(meta.status).toBe("infra-blocked")
      expect(meta.blockedReason).toBe("timeout x1")
      expect(meta.blockedEvidenceIds).toEqual(["0"])
      expect(meta.bestRound).toBe(0)
    } finally {
      await rm(skillDir, { recursive: true, force: true })
    }
  })

  test("finalizeProposal persists selectionConfig including perTaskRegressionTolerance (Codex review P3)", async () => {
    const skillDir = await makeFakeSkill("selection-config")
    try {
      const p = await storage.createProposal({
        skillName: "selection-config",
        skillDir,
        harness: "hermes",
        optimizerModel: "anthropic/claude-sonnet-4-6",
        targetModel: "openrouter/deepseek/deepseek-v3.2",
        source: "test",
      })
      await storage.finalizeProposal(p.dir, {
        bestRound: 0,
        bestRoundReason: "baseline won",
        history: [],
        rounds: [],
        selectionConfig: {
          minImprovement: 0.03,
          epsilon: 0.005,
          convergenceThreshold: 0.95,
          perTaskRegressionTolerance: 0.35,
        },
      })
      const meta = JSON.parse(await readFile(path.join(p.dir, "meta.json"), "utf-8"))
      expect(meta.selectionConfig).toEqual({
        minImprovement: 0.03,
        epsilon: 0.005,
        convergenceThreshold: 0.95,
        perTaskRegressionTolerance: 0.35,
      })
      // Re-parse via the schema to confirm the field round-trips.
      const parsed = storage.ProposalMetaSchema.parse(meta)
      expect(parsed.selectionConfig?.perTaskRegressionTolerance).toBe(0.35)
    } finally {
      await rm(skillDir, { recursive: true, force: true })
    }
  })

  test("ProposalMetaSchema parses legacy meta.json without the new optional fields", async () => {
    // A proposal written by the pre-abstain code has no blockedReason /
    // blockedEvidenceIds and a non-"infra-blocked" status. Must still parse.
    const skillDir = await makeFakeSkill("legacy-meta")
    try {
      const p = await storage.createProposal({
        skillName: "legacy-meta",
        skillDir,
        harness: "hermes",
        optimizerModel: "anthropic/claude-sonnet-4-6",
        targetModel: "openrouter/deepseek/deepseek-v3.2",
        source: "test",
      })
      // Overwrite with a minimal legacy shape (no optional fields).
      const legacyMeta = {
        skillName: "legacy-meta",
        skillDir,
        harness: "hermes",
        optimizerModel: "anthropic/claude-sonnet-4-6",
        targetModel: "openrouter/deepseek/deepseek-v3.2",
        source: "test",
        timestamp: "20260413T220209Z",
        status: "pending",
        acceptedRound: null,
        bestRound: 0,
        bestRoundReason: "",
        roundCount: 0,
      }
      await writeFile(path.join(p.dir, "meta.json"), JSON.stringify(legacyMeta))

      const parsed = storage.ProposalMetaSchema.parse(
        JSON.parse(await readFile(path.join(p.dir, "meta.json"), "utf-8")),
      )
      expect(parsed.status).toBe("pending")
      expect(parsed.blockedReason).toBeUndefined()
      expect(parsed.blockedEvidenceIds).toBeUndefined()
    } finally {
      await rm(skillDir, { recursive: true, force: true })
    }
  })

  test("listProposals filters by targetModel", async () => {
    const skillDir = await makeFakeSkill("listme")
    try {
      await storage.createProposal({
        skillName: "listme",
        skillDir,
        harness: "bare-agent",
        optimizerModel: "openrouter/z-ai/glm-5.1",
        targetModel: "openrouter/qwen/qwen3-30b-a3b",
        source: "test",
      })
      await storage.createProposal({
        skillName: "listme",
        skillDir,
        harness: "bare-agent",
        optimizerModel: "openrouter/z-ai/glm-5.1",
        targetModel: "anthropic/claude-opus-4.6",
        source: "test",
      })

      const onlyQwen = await storage.listProposals({
        skillName: "listme",
        targetModel: "openrouter/qwen/qwen3-30b-a3b",
      })
      expect(onlyQwen.length).toBeGreaterThanOrEqual(1)
      for (const p of onlyQwen) {
        expect(p.meta.targetModel).toBe("openrouter/qwen/qwen3-30b-a3b")
      }
    } finally {
      await rm(skillDir, { recursive: true, force: true })
    }
  })
})

describe("proposals storage — concurrent createProposal", () => {
  test("concurrent calls for the same skill produce distinct dirs", async () => {
    const skillDir = await makeFakeSkill("concurrent")
    try {
      // Detach mode: multiple workers race on createProposal in the same ms.
      // The retry-with-suffix loop must give each call a distinct directory.
      const N = 10
      const results = await Promise.all(
        Array.from({ length: N }, () =>
          storage.createProposal({
            skillName: "concurrent",
            skillDir,
            harness: "bare-agent",
            optimizerModel: "openrouter/z-ai/glm-5.1",
            targetModel: "openrouter/qwen/qwen3-30b-a3b",
            source: "test",
          }),
        ),
      )
      const dirs = new Set(results.map((r) => r.dir))
      expect(dirs.size).toBe(N)
      const ids = new Set(results.map((r) => r.id))
      expect(ids.size).toBe(N)
    } finally {
      await rm(skillDir, { recursive: true, force: true })
    }
  })
})
