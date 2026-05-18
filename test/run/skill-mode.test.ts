import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AgentAdapter, AdapterConfig, RunResult, SkillBundle } from "../../src/core/types.ts"
import { emptyTokenUsage } from "../../src/core/types.ts"
import { executeRun, loadRunSkill, loadRunTask } from "../../src/run/index.ts"

let tempRoot: string
beforeEach(async () => { tempRoot = await mkdtemp(path.join(tmpdir(), "skvm-run-skill-mode-")) })
afterEach(async () => { await rm(tempRoot, { recursive: true, force: true }) })

function recordingAdapter(): { adapter: AgentAdapter; seen: { skill?: SkillBundle }[] } {
  const seen: { skill?: SkillBundle }[] = []
  const adapter: AgentAdapter = {
    name: "recording",
    async setup(_cfg: AdapterConfig) {},
    async run(opts) {
      seen.push({ skill: opts.skill })
      const result: RunResult = {
        text: "ok",
        steps: [],
        tokens: emptyTokenUsage(),
        cost: 0,
        durationMs: 0,
        llmDurationMs: 0,
        workDir: opts.workDir,
        runStatus: "ok",
      }
      return result
    },
    async teardown() {},
  }
  return { adapter, seen }
}

describe("executeRun --skill-mode threading", () => {
  test("forwards explicit skillMode to the adapter", async () => {
    const taskPath = path.join(tempRoot, "task.json")
    await writeFile(taskPath, JSON.stringify({ id: "t", prompt: "hi", timeoutMs: 5000, maxSteps: 5 }))
    const skillPath = path.join(tempRoot, "SKILL.md")
    await writeFile(skillPath, `---\nname: demo\ndescription: demo skill\n---\n\n# Demo`)

    const task = await loadRunTask(taskPath)
    const skill = await loadRunSkill(skillPath)
    const { adapter, seen } = recordingAdapter()

    await executeRun({
      task,
      skill,
      adapter,
      adapterConfig: { model: "test", maxSteps: 5, timeoutMs: 5000 },
      skillMode: "discover",
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]!.skill).toBeDefined()
    expect(seen[0]!.skill!.mode).toBe("discover")
    expect(seen[0]!.skill!.meta).toEqual({ name: "demo", description: "demo skill" })
  })

  test("defaults skill mode to inject when not specified", async () => {
    const taskPath = path.join(tempRoot, "task.json")
    await writeFile(taskPath, JSON.stringify({ id: "t", prompt: "hi", timeoutMs: 5000, maxSteps: 5 }))
    const skillPath = path.join(tempRoot, "SKILL.md")
    await writeFile(skillPath, `---\nname: demo\ndescription: demo\n---\n\n# Demo`)

    const task = await loadRunTask(taskPath)
    const skill = await loadRunSkill(skillPath)
    const { adapter, seen } = recordingAdapter()

    await executeRun({
      task,
      skill,
      adapter,
      adapterConfig: { model: "test", maxSteps: 5, timeoutMs: 5000 },
    })

    expect(seen[0]!.skill!.mode).toBe("inject")
  })

  test("passes undefined skill when none is provided", async () => {
    const taskPath = path.join(tempRoot, "task.json")
    await writeFile(taskPath, JSON.stringify({ id: "t", prompt: "hi", timeoutMs: 5000, maxSteps: 5 }))

    const task = await loadRunTask(taskPath)
    const { adapter, seen } = recordingAdapter()

    await executeRun({
      task,
      adapter,
      adapterConfig: { model: "test", maxSteps: 5, timeoutMs: 5000 },
    })

    expect(seen[0]!.skill).toBeUndefined()
  })
})
