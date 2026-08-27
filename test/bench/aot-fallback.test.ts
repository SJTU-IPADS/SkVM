import { test, expect, describe } from "bun:test"
import { mkdtemp, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { aotVariantRunner, shouldFallbackToOriginal, readVariantGuardPassed } from "../../src/bench/conditions/aot-variant.ts"
import { getVariantDir } from "../../src/proposals/storage.ts"
import { contentHash, type ResolvedSkill } from "../../src/core/skill-loader.ts"
import type { ConditionContext } from "../../src/bench/conditions/types.ts"
import type { AgentAdapter, AdapterConfig, RunResult, TCP } from "../../src/core/types.ts"
import type { LLMProvider } from "../../src/providers/types.ts"
import type { ConversationLog } from "../../src/core/conversation-logger.ts"
import { emptyTokenUsage } from "../../src/core/types.ts"
import type { BenchTask, AotFallbackMode } from "../../src/bench/types.ts"

// A guard-failing compiled AOT variant should not be shipped: the aot-compiled
// condition falls back to the original skill (aotFallback=original, the
// default) unless the operator explicitly opts into 'use-anyway' for A/B
// diagnosis.

describe("shouldFallbackToOriginal", () => {
  test("guard passed → never falls back, regardless of mode", () => {
    expect(shouldFallbackToOriginal(true, "original")).toBe(false)
    expect(shouldFallbackToOriginal(true, "use-anyway")).toBe(false)
  })

  test("guard failed + mode=original → falls back to original", () => {
    expect(shouldFallbackToOriginal(false, "original")).toBe(true)
  })

  test("guard failed + mode=use-anyway → runs the compiled variant anyway", () => {
    expect(shouldFallbackToOriginal(false, "use-anyway")).toBe(false)
  })
})

describe("readVariantGuardPassed", () => {
  async function dirWithMeta(meta: string | null): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "skvm-guard-"))
    if (meta !== null) await writeFile(path.join(dir, "meta.json"), meta)
    return dir
  }

  test("meta.json with guardPassed:false → fail", async () => {
    const dir = await dirWithMeta(JSON.stringify({ guardPassed: false }))
    expect(await readVariantGuardPassed(dir)).toBe("fail")
  })

  test("meta.json with guardPassed:true → pass", async () => {
    const dir = await dirWithMeta(JSON.stringify({ guardPassed: true }))
    expect(await readVariantGuardPassed(dir)).toBe("pass")
  })

  test("meta.json without a guardPassed field → pass (predates the field, don't fall back)", async () => {
    const dir = await dirWithMeta(JSON.stringify({ model: "x", harness: "bare-agent" }))
    expect(await readVariantGuardPassed(dir)).toBe("pass")
  })

  test("missing meta.json → unusable (a variant dir always gets SKILL.md and meta together)", async () => {
    // compileSkill's workDir IS the published variant dir: SKILL.md is written
    // first, then the passes run, then meta.json. SKILL.md with no meta is a
    // compile that died partway — benching it as a pass ran an uncompiled skill
    // under the aot-compiled label.
    const dir = await dirWithMeta(null)
    expect(await readVariantGuardPassed(dir)).toBe("unusable")
  })

  test("malformed meta.json → unusable (don't guess at a verdict we cannot read)", async () => {
    const dir = await dirWithMeta("{not valid json")
    expect(await readVariantGuardPassed(dir)).toBe("unusable")
  })
})

// End-to-end through aotVariantRunner: a cached guard-FAIL variant should make
// the aot-compiled condition run the ORIGINAL skill (default), keeping the
// aot-compiled label and marking aotFallback — or run the compiled variant
// anyway under --aot-fallback=use-anyway.
describe("aotVariantRunner guard fallback", () => {
  const ORIGINAL = "---\nname: demo\ndescription: d\n---\n# Original skill body\n"
  const COMPILED = "---\nname: demo\ndescription: d\n---\n# COMPILED (guard-failing) body\n"

  /** Adapter that records into `state` the skill content it was handed. */
  function captureAdapter(): { adapter: AgentAdapter; state: { seenContent?: string } } {
    const state: { seenContent?: string } = {}
    const adapter: AgentAdapter = {
      name: "fake-capture",
      async setup() {},
      async run(task): Promise<RunResult> {
        state.seenContent = task.skill?.content
        await Bun.write(`${task.workDir}/out.txt`, "ok")
        return {
          text: "done", steps: [], tokens: emptyTokenUsage(), cost: 0,
          durationMs: 1, llmDurationMs: 1, workDir: task.workDir, runStatus: "ok",
        }
      },
      async teardown() {},
    }
    return { adapter, state }
  }

  async function makeCachedVariant(skillId: string, model: string, harness: string, guardPassed: boolean) {
    const dir = getVariantDir(harness, model, skillId, "p1p2p3")
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, "SKILL.md"), COMPILED)
    await writeFile(path.join(dir, "meta.json"), JSON.stringify({ guardPassed }))
  }

  async function makeSkill(skillId: string): Promise<ResolvedSkill> {
    const skillDir = await mkdtemp(path.join(tmpdir(), "skvm-origskill-"))
    await writeFile(path.join(skillDir, "SKILL.md"), ORIGINAL)
    return {
      skillId,
      skillDir,
      skillPath: path.join(skillDir, "SKILL.md"),
      skillContent: ORIGINAL,
      skillMeta: { name: skillId, description: "d" },
      bundleFiles: [],
    }
  }

  function makeTask(): BenchTask {
    return {
      id: "fallback-task",
      category: "test",
      gradingType: "automated",
      prompt: "noop",
      eval: [{ method: "file-check", path: "out.txt", mode: "exact", expected: "ok" }],
      timeoutMs: 5_000,
      maxSteps: 5,
    }
  }

  async function runFallbackCase(skillId: string, guardPassed: boolean, mode: AotFallbackMode | undefined) {
    const model = "test/fake"
    const harness = "fake-capture"
    await makeCachedVariant(skillId, model, harness, guardPassed)
    const skill = await makeSkill(skillId)
    const { adapter, state } = captureAdapter()
    const adapterConfig: AdapterConfig = { model, maxSteps: 5, timeoutMs: 5_000 }

    const ctx = {
      condition: "aot-compiled",
      task: makeTask(),
      adapter,
      adapterConfig,
      skills: [skill],
      createConvLog: async () => ({}) as unknown as ConversationLog,
      tcp: {} as TCP,
      compilerProvider: {} as LLMProvider,
      aotFallback: mode,
      jitRuns: 0,
    } satisfies Partial<ConditionContext> as ConditionContext

    const result = await aotVariantRunner.run(ctx)
    return { result, seenContent: state.seenContent }
  }

  test("guard FAIL + default mode → runs ORIGINAL, keeps aot-compiled label, marks aotFallback", async () => {
    const { result, seenContent } = await runFallbackCase("demo-fail-default", false, undefined)
    expect(seenContent).toBe(ORIGINAL)
    expect(result.condition).toBe("aot-compiled")
    expect(result.aotFallback).toBe(true)
    expect(result.skillContentHash).toBe(contentHash(ORIGINAL))
    expect(result.runStatus).toBe("ok")
  })

  test("guard FAIL + use-anyway → runs the COMPILED variant, no fallback marker", async () => {
    const { result, seenContent } = await runFallbackCase("demo-fail-useanyway", false, "use-anyway")
    expect(seenContent).toBe(COMPILED)
    expect(result.aotFallback).toBeUndefined()
    expect(result.skillContentHash).toBe(contentHash(COMPILED))
  })

  test("guard PASS → runs the COMPILED variant regardless of mode", async () => {
    const { result, seenContent } = await runFallbackCase("demo-pass", true, "original")
    expect(seenContent).toBe(COMPILED)
    expect(result.aotFallback).toBeUndefined()
    expect(result.skillContentHash).toBe(contentHash(COMPILED))
  })
})

// A cached p3 variant must run without a TCP profile or compiler provider:
// pass3 never consumes the TCP, and a cache hit compiles nothing at all.
// (A pre-compile-then-bench workflow hits exactly this path.)
describe("aotVariantRunner TCP requirement", () => {
  const P3_COMPILED = "---\nname: demo\ndescription: d\n---\n# body\n\n**Parallel execution hints:** …\n"

  async function makeCachedP3Variant(skillId: string, model: string, harness: string) {
    const dir = getVariantDir(harness, model, skillId, "p3")
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, "SKILL.md"), P3_COMPILED)
    await writeFile(path.join(dir, "meta.json"), JSON.stringify({ guardPassed: true }))
  }

  async function makeP3Skill(skillId: string): Promise<ResolvedSkill> {
    const skillDir = await mkdtemp(path.join(tmpdir(), "skvm-p3skill-"))
    const content = "---\nname: demo\ndescription: d\n---\n# body\n"
    await writeFile(path.join(skillDir, "SKILL.md"), content)
    return {
      skillId, skillDir,
      skillPath: path.join(skillDir, "SKILL.md"),
      skillContent: content,
      skillMeta: { name: skillId, description: "d" },
      bundleFiles: [],
    }
  }

  function p3Ctx(skillId: string, skill: ResolvedSkill, adapter: AgentAdapter): ConditionContext {
    return {
      condition: "aot-compiled-p3",
      task: {
        id: "p3-task", category: "test", gradingType: "automated", prompt: "noop",
        eval: [{ method: "file-check", path: "out.txt", mode: "exact", expected: "ok" }],
        timeoutMs: 5_000, maxSteps: 5,
      },
      adapter,
      adapterConfig: { model: "test/fake", maxSteps: 5, timeoutMs: 5_000 },
      skills: [skill],
      createConvLog: async () => ({}) as unknown as ConversationLog,
      tcp: undefined,
      compilerProvider: undefined,
      aotFallback: undefined,
      jitRuns: 0,
    } satisfies Partial<ConditionContext> as ConditionContext
  }

  test("cached p3 variant runs with neither TCP nor compiler provider", async () => {
    const skillId = "p3-cached-no-tcp"
    const model = "test/fake"
    const harness = "fake-capture"
    await makeCachedP3Variant(skillId, model, harness)
    const skill = await makeP3Skill(skillId)

    const state: { seenContent?: string } = {}
    const adapter: AgentAdapter = {
      name: harness,
      async setup() {},
      async run(task): Promise<RunResult> {
        state.seenContent = task.skill?.content
        await Bun.write(`${task.workDir}/out.txt`, "ok")
        return {
          text: "done", steps: [], tokens: emptyTokenUsage(), cost: 0,
          durationMs: 1, llmDurationMs: 1, workDir: task.workDir, runStatus: "ok",
        }
      },
      async teardown() {},
    }

    const result = await aotVariantRunner.run(p3Ctx(skillId, skill, adapter))
    expect(result.runStatus).toBe("ok")
    expect(state.seenContent).toBe(P3_COMPILED)
  })

  test("uncached p3 without a compiler provider degrades to a zero result, not a crash", async () => {
    const skillId = "p3-uncached-no-provider"
    const skill = await makeP3Skill(skillId)
    const adapter: AgentAdapter = {
      name: "fake-never-called",
      async setup() {},
      async run(): Promise<RunResult> {
        throw new Error("adapter must not run when compilation is impossible")
      },
      async teardown() {},
    }

    const result = await aotVariantRunner.run(p3Ctx(skillId, skill, adapter))
    expect(result.score).toBe(0)
    expect(result.error).toMatch(/compiler provider/i)
  })
})
