import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AgentAdapter, AdapterConfig, RunResult, SkillBundle } from "../../src/core/types.ts"
import { emptyTokenUsage } from "../../src/core/types.ts"
import { loadSkill } from "../../src/core/skill-loader.ts"
import { runTasksForRound } from "../../src/jit-optimize/loop.ts"
import { Pool } from "../../src/core/concurrency.ts"
import type { RunnableTask } from "../../src/jit-optimize/task-source.ts"

let tempRoot: string
beforeEach(async () => { tempRoot = await mkdtemp(path.join(tmpdir(), "skvm-jit-skill-mode-")) })
afterEach(async () => { await rm(tempRoot, { recursive: true, force: true }) })

function recordingAdapter(seen: { skill?: SkillBundle }[]): AgentAdapter {
  return {
    name: "recording",
    async setup(_cfg: AdapterConfig) {},
    async run(opts) {
      seen.push({ skill: opts.skill })
      const r: RunResult = {
        text: "ok",
        steps: [],
        tokens: emptyTokenUsage(),
        durationMs: 0,
        llmDurationMs: 0,
        cost: 0,
        workDir: opts.workDir,
        runStatus: "ok",
      }
      return r
    },
    async teardown() {},
  }
}

describe("runTasksForRound skillMode threading", () => {
  test("passes skillMode and skillMeta to the adapter as a complete SkillBundle", async () => {
    const skillDir = path.join(tempRoot, "skill")
    await mkdir(skillDir, { recursive: true })
    await writeFile(path.join(skillDir, "SKILL.md"),
      `---\nname: demo-skill\ndescription: demo description\n---\n\n# Demo`)
    const skill = await loadSkill(skillDir)

    const task: RunnableTask = {
      id: "t-1",
      prompt: "do it",
      workDir: "",
      eval: [],
      timeoutMs: 5000,
      maxSteps: 5,
    }

    const seen: { skill?: SkillBundle }[] = []
    const adapterPool = new Pool<AgentAdapter>([recordingAdapter(seen)])

    await runTasksForRound({
      tasks: [task],
      skill,
      runsPerTask: 1,
      adapterPool,
      adapterConfig: { model: "test", maxSteps: 5, timeoutMs: 5000 },
      evalConfig: {},
      logDir: path.join(tempRoot, "logs"),
      setLabel: "train",
      skillMode: "discover",
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]!.skill).toBeDefined()
    expect(seen[0]!.skill!.mode).toBe("discover")
    expect(seen[0]!.skill!.meta).toEqual({ name: "demo-skill", description: "demo description" })
    expect(seen[0]!.skill!.content).toContain("# Demo")
  })

  test("defaults to inject when skillMode is omitted", async () => {
    const skillDir = path.join(tempRoot, "skill")
    await mkdir(skillDir, { recursive: true })
    await writeFile(path.join(skillDir, "SKILL.md"),
      `---\nname: demo-skill\ndescription: demo description\n---\n\n# Demo`)
    const skill = await loadSkill(skillDir)

    const task: RunnableTask = {
      id: "t-1", prompt: "do it", workDir: "", eval: [], timeoutMs: 5000, maxSteps: 5,
    }

    const seen: { skill?: SkillBundle }[] = []
    const adapterPool = new Pool<AgentAdapter>([recordingAdapter(seen)])

    await runTasksForRound({
      tasks: [task],
      skill,
      runsPerTask: 1,
      adapterPool,
      adapterConfig: { model: "test", maxSteps: 5, timeoutMs: 5000 },
      evalConfig: {},
      logDir: path.join(tempRoot, "logs"),
      setLabel: "train",
    })

    expect(seen[0]!.skill!.mode).toBe("inject")
  })
})
