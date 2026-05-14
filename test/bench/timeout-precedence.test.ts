import { test, expect, describe } from "bun:test"
import { runTask } from "../../src/framework/runner.ts"
import type { AgentAdapter, AdapterConfig, RunResult, Task } from "../../src/core/types.ts"
import { emptyTokenUsage } from "../../src/core/types.ts"

/** Adapter that records the `timeoutMs` passed to `run()`. */
function createTimeoutRecorder(): AgentAdapter & { observed: number[] } {
  const observed: number[] = []
  return {
    name: "mock-timeout-recorder",
    observed,
    async setup(_config: AdapterConfig) {},
    async run(task): Promise<RunResult> {
      observed.push(task.timeoutMs ?? -1)
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
}

const baseTask = (timeoutMs: number): Task => ({
  id: "t",
  prompt: "noop",
  eval: [{ method: "file-check", path: "result.txt", mode: "exact", expected: "ok" }],
  timeoutMs,
  maxSteps: 30,
})

describe("framework/runner.runTask — timeoutMs precedence", () => {
  test("uses adapterConfig.timeoutMs at adapter.run, not task.timeoutMs", async () => {
    // bench's executeBenchItem resolves per-task and writes the final value
    // onto adapterConfig before calling runTask, so runner.ts must consume
    // adapterConfig.timeoutMs (not re-read task.timeoutMs and shadow the
    // CLI override).
    const adapter = createTimeoutRecorder()
    await runTask({
      task: baseTask(3_600_000),
      adapter,
      // Simulates the resolved per-task value (e.g. CLI --timeout-ms=5000
      // overriding task.timeoutMs=3_600_000).
      adapterConfig: { model: "test", maxSteps: 30, timeoutMs: 5_000 },
    })
    expect(adapter.observed).toEqual([5_000])
  })

  test("when adapterConfig.timeoutMs matches task.timeoutMs, the run sees that value", async () => {
    // The default precedence (no CLI override) yields adapterConfig.timeoutMs
    // == task.timeoutMs after resolveTaskRuntime, so runner forwards the
    // task's own value.
    const adapter = createTimeoutRecorder()
    await runTask({
      task: baseTask(3_600_000),
      adapter,
      adapterConfig: { model: "test", maxSteps: 30, timeoutMs: 3_600_000 },
    })
    expect(adapter.observed).toEqual([3_600_000])
  })
})
