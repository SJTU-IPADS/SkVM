import { test, expect, describe } from "bun:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { runTasksForRound } from "../../src/jit-optimize/loop.ts"
import type { RunnableTask } from "../../src/jit-optimize/task-source.ts"
import type { AgentAdapter, RunResult } from "../../src/core/types.ts"
import { Pool } from "../../src/core/concurrency.ts"
import { loadSkill } from "../../src/core/skill-loader.ts"
import type { ResolvedSkill } from "../../src/core/skill-loader.ts"

// Factory returning N distinct adapter instances wired to a shared
// barrier state. Each adapter.run() increments a shared `inFlight`
// counter, awaits an externally-released gate keyed by task prompt,
// then decrements. Tests use `maxSeen` to assert the concurrency bound
// and drive completion order via `release`.
//
// Using N *distinct* instances (rather than one shared instance reused N
// times) is intentional: the whole point of the adapterPool refactor is
// that each worker owns its own adapter. The shared counters observe
// pool-level aggregate in-flight, which is what concurrency bounds are
// actually about.
interface BarrierPool {
  adapters: AgentAdapter[]
  release: (taskId: string) => void
  inFlight: () => number
  maxSeen: () => number
  completed: () => string[]
}

function createBarrierPool(size: number): BarrierPool {
  const gates = new Map<string, () => void>()
  const completed: string[] = []
  let inFlight = 0
  let maxSeen = 0

  const makeInstance = (): AgentAdapter => ({
    name: "mock-barrier",
    async setup() {},
    async teardown() {},
    async run(task): Promise<RunResult> {
      const id = task.prompt.replace(/^task /, "")
      inFlight += 1
      if (inFlight > maxSeen) maxSeen = inFlight
      await new Promise<void>((resolve) => {
        gates.set(id, resolve)
      })
      inFlight -= 1
      completed.push(id)
      await Bun.write(`${task.workDir}/result.txt`, "ok")
      return {
        text: "done",
        steps: [{ role: "assistant", text: "done", toolCalls: [], timestamp: Date.now() }],
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
        durationMs: 10,
        llmDurationMs: 5,
        workDir: task.workDir,
        runStatus: "ok",
      }
    },
  })

  return {
    adapters: Array.from({ length: size }, makeInstance),
    release(taskId) {
      const g = gates.get(taskId)
      if (g) {
        gates.delete(taskId)
        g()
      }
    },
    inFlight: () => inFlight,
    maxSeen: () => maxSeen,
    completed: () => completed.slice(),
  }
}

// Serial-order recording adapter — used for the 1-instance-pool order test.
function createRecordingAdapter(order: string[]): AgentAdapter {
  return {
    name: "mock-recording",
    async setup() {},
    async teardown() {},
    async run(task): Promise<RunResult> {
      order.push(task.prompt.replace(/^task /, ""))
      await Bun.write(`${task.workDir}/result.txt`, "ok")
      return {
        text: "",
        steps: [],
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
        durationMs: 1,
        llmDurationMs: 1,
        workDir: task.workDir,
        runStatus: "ok",
      }
    },
  }
}

async function withSkill(fn: (skill: ResolvedSkill) => Promise<void>) {
  const skillDir = await mkdtemp(path.join(tmpdir(), "jit-opt-concurrency-skill-"))
  try {
    await writeFile(path.join(skillDir, "SKILL.md"), "# test skill\n")
    const skill = await loadSkill(skillDir)
    await fn(skill)
  } finally {
    await rm(skillDir, { recursive: true, force: true })
  }
}

function makeTask(id: string): RunnableTask {
  return {
    id,
    prompt: `task ${id}`,
    eval: [{ method: "file-check", path: "result.txt", mode: "exact", expected: "ok" }],
    workDir: "",
    timeoutMs: 60_000,
    maxSteps: 30,
  }
}

// Pool-gated work progresses in microtasks, so short polls converge fast.
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil timed out: ${label}`)
    }
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe("runTasksForRound adapterPool concurrency bound", () => {
  test("1-instance pool keeps in-flight at 1", async () => {
    await withSkill(async (skill) => {
      const logDir = await mkdtemp(path.join(tmpdir(), "jit-opt-concurrency-log-"))
      try {
        const barrier = createBarrierPool(1)
        const adapterPool = new Pool(barrier.adapters)
        const tasks = [makeTask("a"), makeTask("b"), makeTask("c")]

        const runPromise = runTasksForRound({
          tasks,
          skill,
          runsPerTask: 1,
          adapterPool,
          adapterConfig: { model: "mock", maxSteps: 30, timeoutMs: 60_000 },
          evalConfig: {},
          logDir,
          setLabel: "train",
        })

        await waitUntil(() => barrier.inFlight() === 1, "a in-flight")
        expect(barrier.maxSeen()).toBe(1)
        barrier.release("a")
        await waitUntil(() => barrier.inFlight() === 1 && barrier.completed().includes("a"), "b in-flight")
        expect(barrier.maxSeen()).toBe(1)
        barrier.release("b")
        await waitUntil(() => barrier.inFlight() === 1 && barrier.completed().includes("b"), "c in-flight")
        expect(barrier.maxSeen()).toBe(1)
        barrier.release("c")

        const evidences = await runPromise
        expect(evidences).toHaveLength(3)
        expect(barrier.maxSeen()).toBe(1)
      } finally {
        await rm(logDir, { recursive: true, force: true })
      }
    })
  })

  test("3-instance pool with 5 tasks caps in-flight at 3", async () => {
    await withSkill(async (skill) => {
      const logDir = await mkdtemp(path.join(tmpdir(), "jit-opt-concurrency-log-"))
      try {
        const barrier = createBarrierPool(3)
        const adapterPool = new Pool(barrier.adapters)
        const tasks = ["a", "b", "c", "d", "e"].map(makeTask)

        const runPromise = runTasksForRound({
          tasks,
          skill,
          runsPerTask: 1,
          adapterPool,
          adapterConfig: { model: "mock", maxSteps: 30, timeoutMs: 60_000 },
          evalConfig: {},
          logDir,
          setLabel: "train",
        })

        await waitUntil(() => barrier.inFlight() === 3, "3 in-flight")
        expect(barrier.maxSeen()).toBe(3)

        barrier.release("a")
        await waitUntil(() => barrier.completed().length === 1, "a done")
        await waitUntil(() => barrier.inFlight() === 3, "next admitted")
        expect(barrier.maxSeen()).toBe(3)

        barrier.release("b")
        barrier.release("c")
        await waitUntil(() => barrier.completed().length === 3, "a,b,c done")
        await waitUntil(() => barrier.inFlight() === 2, "d,e in-flight")
        expect(barrier.maxSeen()).toBe(3)

        barrier.release("d")
        barrier.release("e")
        const evidences = await runPromise
        expect(evidences).toHaveLength(5)
        expect(barrier.maxSeen()).toBe(3)
        for (let i = 0; i < tasks.length; i++) {
          expect(evidences[i]?.taskPrompt).toBe(tasks[i]!.prompt)
        }
      } finally {
        await rm(logDir, { recursive: true, force: true })
      }
    })
  })

  test("evidence order is preserved under reversed completion", async () => {
    await withSkill(async (skill) => {
      const logDir = await mkdtemp(path.join(tmpdir(), "jit-opt-concurrency-log-"))
      try {
        const barrier = createBarrierPool(3)
        const adapterPool = new Pool(barrier.adapters)
        const tasks = ["a", "b", "c"].map(makeTask)

        const runPromise = runTasksForRound({
          tasks,
          skill,
          runsPerTask: 1,
          adapterPool,
          adapterConfig: { model: "mock", maxSteps: 30, timeoutMs: 60_000 },
          evalConfig: {},
          logDir,
          setLabel: "train",
        })

        await waitUntil(() => barrier.inFlight() === 3, "3 in-flight")
        barrier.release("c")
        barrier.release("b")
        barrier.release("a")

        const evidences = await runPromise
        expect(evidences.map((e) => e.taskPrompt)).toEqual(["task a", "task b", "task c"])
      } finally {
        await rm(logDir, { recursive: true, force: true })
      }
    })
  })

  test("two runTasksForRound calls sharing one adapterPool are globally capped", async () => {
    await withSkill(async (skill) => {
      const logDir = await mkdtemp(path.join(tmpdir(), "jit-opt-concurrency-log-"))
      try {
        // 2-instance barrier pool mimics runBoth's train+test sharing one pool.
        const barrier = createBarrierPool(2)
        const adapterPool = new Pool(barrier.adapters)
        const trainTasks = [makeTask("t1"), makeTask("t2")]
        const testTasks = [makeTask("x1"), makeTask("x2")]

        const both = Promise.all([
          runTasksForRound({
            tasks: trainTasks,
            skill,
            runsPerTask: 1,
            adapterPool,
            adapterConfig: { model: "mock", maxSteps: 30, timeoutMs: 60_000 },
            evalConfig: {},
            logDir: path.join(logDir, "train"),
            setLabel: "train",
          }),
          runTasksForRound({
            tasks: testTasks,
            skill,
            runsPerTask: 1,
            adapterPool,
            adapterConfig: { model: "mock", maxSteps: 30, timeoutMs: 60_000 },
            evalConfig: {},
            logDir: path.join(logDir, "test"),
            setLabel: "test",
          }),
        ])

        // Pool has 2 instances; across all 4 jobs at most 2 may be in
        // adapter.run simultaneously, regardless of which set they belong to.
        await waitUntil(() => barrier.inFlight() === 2, "2 in-flight across sets")
        expect(barrier.maxSeen()).toBe(2)

        barrier.release("t1")
        await waitUntil(() => barrier.completed().length === 1, "first done")
        expect(barrier.maxSeen()).toBe(2)
        barrier.release("x1")
        await waitUntil(() => barrier.completed().length === 2, "second done")
        barrier.release("t2")
        await waitUntil(() => barrier.completed().length === 3, "third done")
        barrier.release("x2")

        const [trainEv, testEv] = await both
        expect(trainEv).toHaveLength(2)
        expect(testEv).toHaveLength(2)
        expect(barrier.maxSeen()).toBe(2)
      } finally {
        await rm(logDir, { recursive: true, force: true })
      }
    })
  })

  test("1-instance pool + runsPerTask=2 preserves (task × run) order", async () => {
    await withSkill(async (skill) => {
      const logDir = await mkdtemp(path.join(tmpdir(), "jit-opt-concurrency-log-"))
      try {
        const order: string[] = []
        const adapter = createRecordingAdapter(order)
        const tasks = ["a", "b", "c"].map(makeTask)

        const evidences = await runTasksForRound({
          tasks,
          skill,
          runsPerTask: 2,
          adapterPool: new Pool([adapter]),
          adapterConfig: { model: "mock", maxSteps: 30, timeoutMs: 60_000 },
          evalConfig: {},
          logDir,
          setLabel: "train",
        })

        expect(evidences).toHaveLength(6)
        expect(evidences.map((e) => e.taskPrompt)).toEqual([
          "task a", "task a", "task b", "task b", "task c", "task c",
        ])
        expect(order).toEqual(["a", "a", "b", "b", "c", "c"])
      } finally {
        await rm(logDir, { recursive: true, force: true })
      }
    })
  })
})
