import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ARTIFACT_DIR, ArtifactStore } from "../../src/compiler/artifacts.ts"
import type { SCR, WorkflowDAG } from "../../src/core/types.ts"

const SAMPLE_SCR: SCR = {
  skillName: "demo-skill",
  purposes: [
    {
      id: "main",
      description: "Run the workflow",
      currentPath: {
        primitives: [
          { id: "tool.exec", minLevel: "L1", evidence: "executes scripts" },
        ],
      },
      alternativePaths: [],
    },
  ],
}

const SAMPLE_DAG: WorkflowDAG = {
  steps: [
    { id: "a", description: "Step A", primitives: ["tool.exec"], dependsOn: [] },
    { id: "b", description: "Step B", primitives: ["tool.exec"], dependsOn: ["a"] },
  ],
  parallelism: [],
}

describe("ArtifactStore", () => {
  let workDir: string

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "artifact-store-"))
  })

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  test("merge writes one JSON file per key under _artifacts/", async () => {
    const store = await ArtifactStore.load(workDir)
    await store.merge({ scr: SAMPLE_SCR, dag: SAMPLE_DAG })

    const scrFile = Bun.file(path.join(workDir, "_artifacts", "scr.json"))
    const dagFile = Bun.file(path.join(workDir, "_artifacts", "dag.json"))
    expect(await scrFile.exists()).toBe(true)
    expect(await dagFile.exists()).toBe(true)

    expect(await scrFile.json()).toEqual(SAMPLE_SCR)
    expect(await dagFile.json()).toEqual(SAMPLE_DAG)
  })

  test("get returns merged artifacts", async () => {
    const store = await ArtifactStore.load(workDir)
    await store.merge({ scr: SAMPLE_SCR })
    expect(store.get("scr")).toEqual(SAMPLE_SCR)
    expect(store.get("scr")).toBeDefined()
    expect(store.get("dag")).toBeUndefined()
  })

  test("load picks up cached artifacts written by a prior run", async () => {
    const first = await ArtifactStore.load(workDir)
    await first.merge({ scr: SAMPLE_SCR, dag: SAMPLE_DAG })

    // Fresh store — same workDir, should see the cached files
    const second = await ArtifactStore.load(workDir)
    expect(second.get("scr")).toEqual(SAMPLE_SCR)
    expect(second.get("dag")).toEqual(SAMPLE_DAG)
    expect(Object.keys(second.snapshot()).sort()).toEqual(["dag", "scr"])
  })

  test("writeMeta persists per-pass metadata", async () => {
    const store = await ArtifactStore.load(workDir)
    await store.writeMeta({
      passId: "rewrite-skill",
      status: "ok",
      tokens: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 },
      durationMs: 1234,
      iterations: 5,
    })

    const metaFile = Bun.file(path.join(workDir, "_artifacts", "_meta", "rewrite-skill.json"))
    expect(await metaFile.exists()).toBe(true)
    const persisted = await metaFile.json()
    expect(persisted.passId).toBe("rewrite-skill")
    expect(persisted.iterations).toBe(5)

    // Reload picks the meta back up
    const reloaded = await ArtifactStore.load(workDir)
    expect(reloaded.metaSnapshot()["rewrite-skill"]).toBeDefined()
    expect(reloaded.metaSnapshot()["rewrite-skill"]!.tokens.input).toBe(100)
  })

  test("merge skips undefined values", async () => {
    const store = await ArtifactStore.load(workDir)
    await store.merge({ scr: SAMPLE_SCR, dag: undefined })
    expect(store.get("scr")).toBeDefined()
    expect(store.get("dag")).toBeUndefined()
  })

  test("ARTIFACT_DIR exported for skip-rule co-ordination", () => {
    // File walkers in pass1, pass2, and bench must all skip this directory.
    // If the constant changes, every co-ordinator below has to update too.
    expect(ARTIFACT_DIR).toBe("_artifacts")
  })
})
