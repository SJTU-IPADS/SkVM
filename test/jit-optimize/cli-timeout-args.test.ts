import { test, expect, describe } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { runTasksForRound } from "../../src/jit-optimize/loop.ts"
import type { RunnableTask } from "../../src/jit-optimize/task-source.ts"
import type { AgentAdapter, RunResult, AdapterConfig } from "../../src/core/types.ts"
import { emptyTokenUsage } from "../../src/core/types.ts"
import { Pool } from "../../src/core/concurrency.ts"
import { loadSkill, type ResolvedSkill } from "../../src/core/skill-loader.ts"

/** Records the `timeoutMs` the adapter sees at run() time and the `maxSteps`
 *  it saw at setup() time. Stored in a sidecar so the adapter object itself
 *  stays a plain AgentAdapter (Pool is invariant in its element type). */
interface RecordingState {
  observedTimeoutMs: number[]
  observedMaxSteps: number[]
}

function createRecordingAdapter(): { adapter: AgentAdapter; state: RecordingState } {
  const state: RecordingState = { observedTimeoutMs: [], observedMaxSteps: [] }
  const adapter: AgentAdapter = {
    name: "mock-recorder",
    async setup(config: AdapterConfig) {
      state.observedMaxSteps.push(config.maxSteps)
    },
    async run(task): Promise<RunResult> {
      state.observedTimeoutMs.push(task.timeoutMs ?? -1)
      await Bun.write(`${task.workDir}/result.txt`, "ok")
      return {
        text: "done",
        steps: [],
        tokens: emptyTokenUsage(),
        cost: 0,
        durationMs: 1,
        llmDurationMs: 1,
        workDir: task.workDir,
        runStatus: "ok",
      }
    },
    async teardown() {},
  }
  return { adapter, state }
}

async function withSkill(fn: (skill: ResolvedSkill) => Promise<void>) {
  const skillDir = await mkdtemp(path.join(tmpdir(), "jit-optimize-cli-args-"))
  try {
    await writeFile(path.join(skillDir, "SKILL.md"), "# test skill\n")
    const skill = await loadSkill(skillDir)
    await fn(skill)
  } finally {
    await rm(skillDir, { recursive: true, force: true })
  }
}

function mkTask(id: string, timeoutMs: number, maxSteps: number): RunnableTask {
  return {
    id,
    prompt: "noop",
    eval: [{ method: "file-check", path: "result.txt", mode: "exact", expected: "ok" }],
    workDir: "",
    timeoutMs,
    maxSteps,
  }
}

describe("jit-optimize CLI timeoutMs / maxSteps precedence", () => {
  test("task.timeoutMs is honored at adapter.run when CLI override is absent", async () => {
    await withSkill(async (skill) => {
      const logDir = await mkdtemp(path.join(tmpdir(), "jit-optimize-log-"))
      try {
        const { adapter, state } = createRecordingAdapter()
        await runTasksForRound({
          tasks: [mkTask("task1", 3_600_000, 30)],
          skill,
          runsPerTask: 1,
          adapterPool: new Pool([adapter]),
          adapterConfig: { model: "test", maxSteps: 30, timeoutMs: 120_000 },
          evalConfig: {},
          logDir,
          setLabel: "train",
        })
        expect(state.observedTimeoutMs).toEqual([3_600_000])
      } finally {
        await rm(logDir, { recursive: true, force: true })
      }
    })
  })

  test("CLI timeoutMs override beats task.timeoutMs", async () => {
    await withSkill(async (skill) => {
      const logDir = await mkdtemp(path.join(tmpdir(), "jit-optimize-log-"))
      try {
        const { adapter, state } = createRecordingAdapter()
        await runTasksForRound({
          tasks: [mkTask("task1", 3_600_000, 30)],
          skill,
          runsPerTask: 1,
          adapterPool: new Pool([adapter]),
          adapterConfig: { model: "test", maxSteps: 30, timeoutMs: 120_000 },
          cliTimeoutMs: 5_000,
          evalConfig: {},
          logDir,
          setLabel: "train",
        })
        expect(state.observedTimeoutMs).toEqual([5_000])
      } finally {
        await rm(logDir, { recursive: true, force: true })
      }
    })
  })

  test("task.maxSteps is honored at adapter.setup when CLI override is absent", async () => {
    await withSkill(async (skill) => {
      const logDir = await mkdtemp(path.join(tmpdir(), "jit-optimize-log-"))
      try {
        const { adapter, state } = createRecordingAdapter()
        await runTasksForRound({
          tasks: [mkTask("task1", 60_000, 75)],
          skill,
          runsPerTask: 1,
          adapterPool: new Pool([adapter]),
          adapterConfig: { model: "test", maxSteps: 30, timeoutMs: 60_000 },
          evalConfig: {},
          logDir,
          setLabel: "train",
        })
        expect(state.observedMaxSteps).toEqual([75])
      } finally {
        await rm(logDir, { recursive: true, force: true })
      }
    })
  })

  test("CLI maxSteps override beats task.maxSteps", async () => {
    await withSkill(async (skill) => {
      const logDir = await mkdtemp(path.join(tmpdir(), "jit-optimize-log-"))
      try {
        const { adapter, state } = createRecordingAdapter()
        await runTasksForRound({
          tasks: [mkTask("task1", 60_000, 75)],
          skill,
          runsPerTask: 1,
          adapterPool: new Pool([adapter]),
          adapterConfig: { model: "test", maxSteps: 30, timeoutMs: 60_000 },
          cliMaxSteps: 200,
          evalConfig: {},
          logDir,
          setLabel: "train",
        })
        expect(state.observedMaxSteps).toEqual([200])
      } finally {
        await rm(logDir, { recursive: true, force: true })
      }
    })
  })

  test("each task gets its own per-task timeout when CLI override is absent", async () => {
    await withSkill(async (skill) => {
      const logDir = await mkdtemp(path.join(tmpdir(), "jit-optimize-log-"))
      try {
        const { adapter, state } = createRecordingAdapter()
        await runTasksForRound({
          tasks: [
            mkTask("fast", 30_000, 30),
            mkTask("slow", 3_600_000, 30),
          ],
          skill,
          runsPerTask: 1,
          adapterPool: new Pool([adapter]),
          adapterConfig: { model: "test", maxSteps: 30, timeoutMs: 120_000 },
          evalConfig: {},
          logDir,
          setLabel: "train",
        })
        // Pool size = 1 → sequential, so order is preserved.
        expect(state.observedTimeoutMs).toEqual([30_000, 3_600_000])
      } finally {
        await rm(logDir, { recursive: true, force: true })
      }
    })
  })
})
