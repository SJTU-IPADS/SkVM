import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AdapterConfig, AgentAdapter, RunResult } from "../../src/core/types.ts"
import { emptyTokenUsage } from "../../src/core/types.ts"
import { executeRun, loadRunSkill, loadRunTask } from "../../src/run/index.ts"

let tempRoot: string

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "skvm-run-test-"))
})

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

describe("run task loading", () => {
  test("loads and validates a bench-style task file", async () => {
    const taskPath = path.join(tempRoot, "task.json")
    await Bun.write(taskPath, JSON.stringify({
      id: "demo-task",
      prompt: "Do the thing",
      eval: [{ method: "file-check", path: "out.txt", mode: "exact", expected: "ok" }],
      timeoutMs: 5000,
      maxSteps: 7,
      category: "demo",
    }))

    const task = await loadRunTask(taskPath)

    expect(task.id).toBe("demo-task")
    expect(task.taskPath).toBe(taskPath)
    expect(task.taskDir).toBe(tempRoot)
    expect(task.maxSteps).toBe(7)
    expect(task.eval).toHaveLength(1)
  })

  test("allows run task files without eval", async () => {
    const taskPath = path.join(tempRoot, "task-no-eval.json")
    await Bun.write(taskPath, JSON.stringify({
      id: "demo-no-eval",
      prompt: "Just respond",
      timeoutMs: 5000,
      maxSteps: 7,
    }))

    const task = await loadRunTask(taskPath)

    expect(task.id).toBe("demo-no-eval")
    expect(task.eval).toHaveLength(0)
  })

  test("loads skill metadata from frontmatter", async () => {
    const skillPath = path.join(tempRoot, "SKILL.md")
    await Bun.write(skillPath, `---\nname: demo-skill\ndescription: Demo description\n---\n\n# Demo`)

    const skill = await loadRunSkill(skillPath)

    expect(skill.skillMeta.name).toBe("demo-skill")
    expect(skill.skillMeta.description).toBe("Demo description")
    expect(skill.skillDir).toBe(tempRoot)
  })
})

describe("executeRun", () => {
  test("copies inline fixtures, task fixtures dir, and skill bundle files before adapter execution", async () => {
    const taskDir = path.join(tempRoot, "task")
    const skillDir = path.join(tempRoot, "skill")
    const workDir = path.join(tempRoot, "workdir")
    await mkdir(path.join(taskDir, "fixtures", "nested"), { recursive: true })
    await mkdir(path.join(skillDir, "helpers"), { recursive: true })

    const taskPath = path.join(taskDir, "task.json")
    await Bun.write(taskPath, JSON.stringify({
      id: "fixture-task",
      prompt: "Inspect files",
      fixtures: { "inline/input.txt": "hello" },
      eval: [{ method: "file-check", path: "ignored.txt", mode: "exact", expected: "ignored" }],
    }))
    await Bun.write(path.join(taskDir, "fixtures", "sample.txt"), "fixture-file")
    await Bun.write(path.join(taskDir, "fixtures", "nested", "more.txt"), "nested-fixture")

    const skillPath = path.join(skillDir, "SKILL.md")
    await Bun.write(skillPath, `---\nname: my-skill\ndescription: My skill\n---\n\n# Skill body`)
    await Bun.write(path.join(skillDir, "tool.py"), "print('tool')")
    await Bun.write(path.join(skillDir, "helpers", "util.txt"), "utility")

    const task = await loadRunTask(taskPath)
    const skill = await loadRunSkill(skillPath)

    let setupConfig: AdapterConfig | undefined
    let capturedPrompt = ""
    const adapter: AgentAdapter = {
      name: "mock-run",
      async setup(config: AdapterConfig) {
        setupConfig = config
      },
      async run(runTask): Promise<RunResult> {
        capturedPrompt = runTask.prompt
        expect(await Bun.file(path.join(runTask.workDir, "inline", "input.txt")).text()).toBe("hello")
        expect(await Bun.file(path.join(runTask.workDir, "sample.txt")).text()).toBe("fixture-file")
        expect(await Bun.file(path.join(runTask.workDir, "nested", "more.txt")).text()).toBe("nested-fixture")
        expect(await Bun.file(path.join(runTask.workDir, "tool.py")).text()).toContain("tool")
        expect(await Bun.file(path.join(runTask.workDir, "helpers", "util.txt")).text()).toBe("utility")
        expect(runTask.skill?.content).toContain("# Skill body")
        expect(runTask.skill?.mode).toBe("inject")
        expect(runTask.skill?.meta?.name).toBe("my-skill")
        await Bun.write(path.join(runTask.workDir, "result.txt"), "done")
        return {
          text: "Completed",
          steps: [],
          tokens: emptyTokenUsage(),
          cost: 0,
          durationMs: 12,
          llmDurationMs: 0,
          workDir: runTask.workDir,
          runStatus: "ok",
        }
      },
      async teardown() {},
    }

    const result = await executeRun({
      task,
      skill,
      adapter,
      adapterConfig: { model: "test-model", maxSteps: 10, timeoutMs: 1234 },
      workDir,
      keepWorkDir: true,
    })

    expect(setupConfig?.model).toBe("test-model")
    expect(capturedPrompt).toBe("Inspect files")
    expect(result.workDir).toBe(workDir)
    expect(await Bun.file(path.join(workDir, "result.txt")).text()).toBe("done")
  })

  test("runs without a skill when none is provided", async () => {
    const taskPath = path.join(tempRoot, "task.json")
    const workDir = path.join(tempRoot, "no-skill-workdir")
    await Bun.write(taskPath, JSON.stringify({
      id: "no-skill-task",
      prompt: "Say hello",
      timeoutMs: 3000,
    }))

    const task = await loadRunTask(taskPath)

    const adapter: AgentAdapter = {
      name: "mock-no-skill",
      async setup() {},
      async run(runTask): Promise<RunResult> {
        expect(runTask.prompt).toBe("Say hello")
        expect(runTask.skill?.content).toBeUndefined()
        expect(runTask.skill?.mode).toBeUndefined()
        expect(runTask.skill?.meta).toBeUndefined()
        await Bun.write(path.join(runTask.workDir, "result.txt"), "hello")
        return {
          text: "Hello, I'm ready!",
          steps: [],
          tokens: emptyTokenUsage(),
          cost: 0,
          durationMs: 5,
          llmDurationMs: 0,
          workDir: runTask.workDir,
          runStatus: "ok",
        }
      },
      async teardown() {},
    }

    const result = await executeRun({
      task,
      adapter,
      adapterConfig: { model: "test-model", maxSteps: 10, timeoutMs: 3000 },
      workDir,
      keepWorkDir: true,
    })

    expect(result.skill).toBeUndefined()
    expect(result.runResult.text).toBe("Hello, I'm ready!")
    expect(await Bun.file(path.join(workDir, "result.txt")).text()).toBe("hello")
  })
})