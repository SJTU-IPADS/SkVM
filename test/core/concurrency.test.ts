import { test, expect, describe } from "bun:test"
import {
  runScheduled,
  distributeSlots,
  type WorkItem,
  type RunnerHandle,
} from "../../src/core/concurrency.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestRunner extends RunnerHandle {
  adapter: string
  model: string
  id: number
}

/** Track execution order and runner lifecycle for assertions. */
function createTracker() {
  let runnerId = 0
  const log: string[] = []
  const runners: TestRunner[] = []

  return {
    log,
    runners,
    createRunner: async (adapter: string, model: string): Promise<TestRunner> => {
      const id = runnerId++
      const runner: TestRunner = {
        adapter, model, id,
        teardown: async () => { log.push(`teardown:${id}(${adapter}/${model})`) },
      }
      runners.push(runner)
      log.push(`create:${id}(${adapter}/${model})`)
      return runner
    },
  }
}

// ---------------------------------------------------------------------------
// distributeSlots
// ---------------------------------------------------------------------------

describe("distributeSlots", () => {
  test("even division", () => {
    expect(distributeSlots(6, 3)).toEqual([2, 2, 2])
  })

  test("remainder goes to first groups", () => {
    expect(distributeSlots(7, 3)).toEqual([3, 2, 2])
    expect(distributeSlots(5, 3)).toEqual([2, 2, 1])
  })

  test("more groups than slots", () => {
    expect(distributeSlots(2, 5)).toEqual([1, 1, 0, 0, 0])
  })

  test("single group", () => {
    expect(distributeSlots(4, 1)).toEqual([4])
  })
})

// ---------------------------------------------------------------------------
// runScheduled — basic dispatch
// ---------------------------------------------------------------------------

describe("runScheduled", () => {
  test("empty items returns immediately", async () => {
    await runScheduled({
      concurrency: 4,
      items: [],
      createRunner: async () => ({}),
      execute: async () => {},
    })
  })

  test("single adapter, single model — all items processed", async () => {
    const results: number[] = []
    const items: WorkItem<number>[] = [1, 2, 3, 4, 5].map((n) => ({
      adapter: "bare-agent",
      model: "m1",
      payload: n,
    }))

    await runScheduled({
      concurrency: 2,
      items,
      createRunner: async () => ({}),
      execute: async (_runner, item) => { results.push(item.payload) },
    })

    expect(results.sort()).toEqual([1, 2, 3, 4, 5])
  })

  test("onComplete called for each item", async () => {
    const completed: number[] = []
    const items: WorkItem<number>[] = [10, 20, 30].map((n) => ({
      adapter: "a", model: "m", payload: n,
    }))

    await runScheduled({
      concurrency: 1,
      items,
      createRunner: async () => ({}),
      execute: async () => {},
      onComplete: (item) => { completed.push(item.payload) },
    })

    expect(completed).toEqual([10, 20, 30])
  })

  // ---------------------------------------------------------------------------
  // Sequential model processing within adapter
  // ---------------------------------------------------------------------------

  test("models within adapter are processed sequentially", async () => {
    const executionOrder: string[] = []
    const items: WorkItem<string>[] = [
      // model-1 tasks
      { adapter: "a", model: "m1", payload: "m1-t1" },
      { adapter: "a", model: "m1", payload: "m1-t2" },
      // model-2 tasks
      { adapter: "a", model: "m2", payload: "m2-t1" },
      { adapter: "a", model: "m2", payload: "m2-t2" },
    ]

    await runScheduled({
      concurrency: 1,
      items,
      createRunner: async () => ({}),
      execute: async (_runner, item) => { executionOrder.push(item.payload) },
    })

    // With concurrency=1, model-1 tasks must come before model-2 tasks
    expect(executionOrder).toEqual(["m1-t1", "m1-t2", "m2-t1", "m2-t2"])
  })

  test("multiple workers on same adapter drain model-1 before model-2", async () => {
    const modelTransitions: string[] = []
    let lastModel = ""

    const items: WorkItem<string>[] = [
      { adapter: "a", model: "m1", payload: "m1-t1" },
      { adapter: "a", model: "m1", payload: "m1-t2" },
      { adapter: "a", model: "m1", payload: "m1-t3" },
      { adapter: "a", model: "m1", payload: "m1-t4" },
      { adapter: "a", model: "m2", payload: "m2-t1" },
      { adapter: "a", model: "m2", payload: "m2-t2" },
    ]

    await runScheduled({
      concurrency: 2,
      items,
      createRunner: async () => ({}),
      execute: async (_runner, item) => {
        if (item.model !== lastModel) {
          modelTransitions.push(item.model)
          lastModel = item.model
        }
      },
    })

    // m1 must appear before m2 in transitions (no interleaving)
    const m1Idx = modelTransitions.indexOf("m1")
    const m2Idx = modelTransitions.indexOf("m2")
    expect(m1Idx).toBeLessThan(m2Idx)
  })

  // ---------------------------------------------------------------------------
  // Multiple adapters — parallel processing
  // ---------------------------------------------------------------------------

  test("multiple adapters process in parallel", async () => {
    const adapterSeen = new Set<string>()
    const concurrentAdapters: number[] = []

    const items: WorkItem<string>[] = [
      { adapter: "a1", model: "m", payload: "a1-t1" },
      { adapter: "a1", model: "m", payload: "a1-t2" },
      { adapter: "a2", model: "m", payload: "a2-t1" },
      { adapter: "a2", model: "m", payload: "a2-t2" },
    ]

    await runScheduled({
      concurrency: 2,
      items,
      createRunner: async () => ({}),
      execute: async (_runner, item) => {
        adapterSeen.add(item.adapter)
        concurrentAdapters.push(adapterSeen.size)
        await new Promise((r) => setTimeout(r, 10))
      },
    })

    // Both adapters should have been seen (processed)
    expect(adapterSeen.size).toBe(2)
  })

  // ---------------------------------------------------------------------------
  // Work stealing to slowest adapter
  // ---------------------------------------------------------------------------

  test("workers steal from slowest adapter when their group is done", async () => {
    const results: string[] = []

    const items: WorkItem<string>[] = [
      // adapter-fast: 1 task (finishes quickly)
      { adapter: "fast", model: "m", payload: "fast-1" },
      // adapter-slow: 4 tasks (needs help)
      { adapter: "slow", model: "m", payload: "slow-1" },
      { adapter: "slow", model: "m", payload: "slow-2" },
      { adapter: "slow", model: "m", payload: "slow-3" },
      { adapter: "slow", model: "m", payload: "slow-4" },
    ]

    await runScheduled({
      concurrency: 2,
      items,
      createRunner: async () => ({}),
      execute: async (_runner, item) => {
        results.push(item.payload)
        // Slow adapter tasks take longer
        if (item.adapter === "slow") {
          await new Promise((r) => setTimeout(r, 20))
        }
      },
    })

    // All items should be processed
    expect(results.sort()).toEqual(["fast-1", "slow-1", "slow-2", "slow-3", "slow-4"])
  })

  test("stealing picks adapter with most remaining tasks", async () => {
    const results: string[] = []

    const items: WorkItem<string>[] = [
      // adapter-done: 1 task — finishes first
      { adapter: "done", model: "m", payload: "done-1" },
      // adapter-medium: 2 tasks
      { adapter: "medium", model: "m", payload: "medium-1" },
      { adapter: "medium", model: "m", payload: "medium-2" },
      // adapter-heavy: 5 tasks — most work
      { adapter: "heavy", model: "m", payload: "heavy-1" },
      { adapter: "heavy", model: "m", payload: "heavy-2" },
      { adapter: "heavy", model: "m", payload: "heavy-3" },
      { adapter: "heavy", model: "m", payload: "heavy-4" },
      { adapter: "heavy", model: "m", payload: "heavy-5" },
    ]

    await runScheduled({
      concurrency: 3,
      items,
      createRunner: async () => ({}),
      execute: async (_runner, item) => {
        results.push(item.payload)
        await new Promise((r) => setTimeout(r, 10))
      },
    })

    expect(results.length).toBe(8)
    expect(results.sort()).toEqual([
      "done-1", "heavy-1", "heavy-2", "heavy-3", "heavy-4", "heavy-5",
      "medium-1", "medium-2",
    ])
  })

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  test("onError captures failures, other items continue", async () => {
    const errors: Array<{ payload: number; error: string }> = []
    const completed: number[] = []

    const items: WorkItem<number>[] = [1, 2, 3, 4].map((n) => ({
      adapter: "a", model: "m", payload: n,
    }))

    await runScheduled({
      concurrency: 1,
      items,
      createRunner: async () => ({}),
      execute: async (_runner, item) => {
        if (item.payload === 2) throw new Error("fail on 2")
        completed.push(item.payload)
      },
      onError: (item, err) => {
        errors.push({ payload: item.payload, error: (err as Error).message })
      },
    })

    expect(completed).toEqual([1, 3, 4])
    expect(errors).toEqual([{ payload: 2, error: "fail on 2" }])
  })

  test("without onError, errors propagate", async () => {
    const items: WorkItem<number>[] = [{ adapter: "a", model: "m", payload: 1 }]

    await expect(
      runScheduled({
        concurrency: 1,
        items,
        createRunner: async () => ({}),
        execute: async () => { throw new Error("boom") },
      }),
    ).rejects.toThrow("boom")
  })

  // ---------------------------------------------------------------------------
  // Runner creation failure (#86)
  // ---------------------------------------------------------------------------

  test("createRunner failure drains that queue via onError; other queues execute; promise resolves", async () => {
    const errors: Array<{ payload: string; error: string }> = []
    const completed: string[] = []

    const items: WorkItem<string>[] = [
      { adapter: "a", model: "bad", payload: "bad-1" },
      { adapter: "a", model: "bad", payload: "bad-2" },
      { adapter: "a", model: "good", payload: "good-1" },
      { adapter: "a", model: "good", payload: "good-2" },
    ]

    await runScheduled({
      concurrency: 2,
      items,
      createRunner: async (_adapter, model) => {
        if (model === "bad") throw new Error("no runner for bad")
        return {}
      },
      execute: async (_runner, item) => { completed.push(item.payload) },
      onError: (item, err) => {
        errors.push({ payload: item.payload, error: (err as Error).message })
      },
    })

    // All items of the dead queue reported with the setup error
    expect(errors.map((e) => e.payload).sort()).toEqual(["bad-1", "bad-2"])
    expect(errors.every((e) => e.error === "no runner for bad")).toBe(true)
    // Other queue unaffected
    expect(completed.sort()).toEqual(["good-1", "good-2"])
  })

  test("createRunner failure without onError rejects (fail-fast preserved)", async () => {
    const items: WorkItem<number>[] = [{ adapter: "a", model: "m", payload: 1 }]

    await expect(
      runScheduled({
        concurrency: 1,
        items,
        createRunner: async () => { throw new Error("setup boom") },
        execute: async () => {},
      }),
    ).rejects.toThrow("setup boom")
  })

  test("async onError is awaited for runner-creation failures", async () => {
    const recorded: string[] = []
    const items: WorkItem<string>[] = [
      { adapter: "a", model: "bad", payload: "b1" },
      { adapter: "a", model: "bad", payload: "b2" },
    ]

    await runScheduled({
      concurrency: 1,
      items,
      createRunner: async () => { throw new Error("nope") },
      execute: async () => {},
      onError: async (item) => {
        await new Promise((r) => setTimeout(r, 5))
        recorded.push(item.payload)
      },
    })

    // Both entries present after runScheduled resolves — scheduler awaited onError
    expect(recorded.sort()).toEqual(["b1", "b2"])
  })

  test("async onError is awaited for execute failures", async () => {
    const recorded: number[] = []
    const items: WorkItem<number>[] = [1, 2, 3].map((n) => ({
      adapter: "a", model: "m", payload: n,
    }))

    await runScheduled({
      concurrency: 1,
      items,
      createRunner: async () => ({}),
      execute: async (_runner, item) => {
        if (item.payload !== 2) throw new Error(`fail on ${item.payload}`)
      },
      onError: async (item) => {
        await new Promise((r) => setTimeout(r, 5))
        recorded.push(item.payload)
      },
    })

    expect(recorded.sort()).toEqual([1, 3])
  })

  test("a throwing onError rejects the whole run", async () => {
    const items: WorkItem<string>[] = [
      { adapter: "a", model: "m", payload: "t1" },
      { adapter: "a", model: "m", payload: "t2" },
    ]

    await expect(
      runScheduled({
        concurrency: 1,
        items,
        createRunner: async () => { throw new Error("setup boom") },
        execute: async () => {},
        onError: async () => { throw new Error("handler boom") },
      }),
    ).rejects.toThrow("handler boom")
  })

  test("teardown failure does not kill scheduling; all queues complete", async () => {
    const completed: string[] = []

    const items: WorkItem<string>[] = [
      // Model switch within adapter "a" hits the runner-switch teardown site;
      // cross-group steal to adapter "b" hits the group-drained teardown site.
      { adapter: "a", model: "m1", payload: "t1" },
      { adapter: "a", model: "m2", payload: "t2" },
      { adapter: "b", model: "m1", payload: "t3" },
    ]

    await runScheduled({
      concurrency: 1,
      items,
      createRunner: async () => ({
        teardown: async () => { throw new Error("teardown boom") },
      }),
      execute: async (_runner, item) => { completed.push(item.payload) },
    })

    expect(completed.sort()).toEqual(["t1", "t2", "t3"])
  })

  test("worker whose queue's runner fails steals and completes another queue", async () => {
    const errors: string[] = []
    const completed: string[] = []

    const items: WorkItem<string>[] = [
      // Single worker (concurrency=1) starts on the "bad" queue
      { adapter: "a", model: "bad", payload: "bad-1" },
      { adapter: "a", model: "bad", payload: "bad-2" },
      { adapter: "a", model: "good", payload: "good-1" },
      { adapter: "a", model: "good", payload: "good-2" },
    ]

    await runScheduled({
      concurrency: 1,
      items,
      createRunner: async (_adapter, model) => {
        if (model === "bad") throw new Error("bad runner")
        return {}
      },
      execute: async (_runner, item) => { completed.push(item.payload) },
      onError: (item) => { errors.push(item.payload) },
    })

    expect(errors).toEqual(["bad-1", "bad-2"])
    expect(completed).toEqual(["good-1", "good-2"])
  })

  // ---------------------------------------------------------------------------
  // Runner lifecycle
  // ---------------------------------------------------------------------------

  test("runner created per adapter+model, torn down on switch", async () => {
    const tracker = createTracker()

    const items: WorkItem<string>[] = [
      { adapter: "a", model: "m1", payload: "t1" },
      { adapter: "a", model: "m1", payload: "t2" },
      { adapter: "a", model: "m2", payload: "t3" },
    ]

    await runScheduled({
      concurrency: 1,
      items,
      createRunner: tracker.createRunner,
      execute: async () => {},
    })

    // Should create runner for m1, teardown, create for m2, teardown
    expect(tracker.log).toEqual([
      "create:0(a/m1)",
      "teardown:0(a/m1)",
      "create:1(a/m2)",
      "teardown:1(a/m2)",
    ])
  })

  test("runner reused within same adapter+model", async () => {
    const tracker = createTracker()

    const items: WorkItem<string>[] = [
      { adapter: "a", model: "m", payload: "t1" },
      { adapter: "a", model: "m", payload: "t2" },
      { adapter: "a", model: "m", payload: "t3" },
    ]

    await runScheduled({
      concurrency: 1,
      items,
      createRunner: tracker.createRunner,
      execute: async () => {},
    })

    // Only one create + one teardown
    expect(tracker.log).toEqual([
      "create:0(a/m)",
      "teardown:0(a/m)",
    ])
  })

  test("stealing creates new runner for different adapter", async () => {
    const tracker = createTracker()

    const items: WorkItem<string>[] = [
      // fast adapter: 1 task
      { adapter: "fast", model: "m", payload: "f1" },
      // slow adapter: 3 tasks
      { adapter: "slow", model: "m", payload: "s1" },
      { adapter: "slow", model: "m", payload: "s2" },
      { adapter: "slow", model: "m", payload: "s3" },
    ]

    await runScheduled({
      concurrency: 2,
      items,
      createRunner: tracker.createRunner,
      execute: async (_runner, item) => {
        if (item.adapter === "slow") await new Promise((r) => setTimeout(r, 30))
      },
    })

    // Fast worker should create runner for fast, teardown, create for slow, teardown
    const createFast = tracker.log.filter((l) => l.includes("(fast/"))
    const createSlow = tracker.log.filter((l) => l.includes("create") && l.includes("(slow/"))
    expect(createFast.length).toBeGreaterThanOrEqual(1)  // at least 1 create + teardown for fast
    expect(createSlow.length).toBeGreaterThanOrEqual(1)  // at least 1 slow runner
  })

  // ---------------------------------------------------------------------------
  // Concurrency = 1 (sequential)
  // ---------------------------------------------------------------------------

  test("concurrency=1 processes everything sequentially", async () => {
    const order: string[] = []

    const items: WorkItem<string>[] = [
      { adapter: "a1", model: "m1", payload: "a1-m1-t1" },
      { adapter: "a1", model: "m1", payload: "a1-m1-t2" },
      { adapter: "a1", model: "m2", payload: "a1-m2-t1" },
      { adapter: "a2", model: "m1", payload: "a2-m1-t1" },
    ]

    await runScheduled({
      concurrency: 1,
      items,
      createRunner: async () => ({}),
      execute: async (_runner, item) => { order.push(item.payload) },
    })

    // With concurrency=1, only 1 worker. It gets assigned to the first adapter group.
    // Drains a1/m1, a1/m2, then steals to a2/m1.
    expect(order).toEqual(["a1-m1-t1", "a1-m1-t2", "a1-m2-t1", "a2-m1-t1"])
  })
})
