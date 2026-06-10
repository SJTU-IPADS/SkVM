import { describe, test, expect } from "bun:test"
import { runCondition } from "../../src/bench/conditions/run-condition.ts"
import type { AgentAdapter, AdapterConfig, RunResult } from "../../src/core/types.ts"
import { emptyTokenUsage } from "../../src/core/types.ts"
import type { BenchTask } from "../../src/bench/types.ts"

function makeTask(): BenchTask {
  return {
    id: "fake-task",
    category: "test",
    gradingType: "automated",
    prompt: "noop",
    eval: [{ method: "file-check", path: "out.txt", mode: "exact", expected: "ok" }],
    timeoutMs: 5_000,
    maxSteps: 5,
  }
}

const adapterConfig: AdapterConfig = { model: "test/fake", maxSteps: 5, timeoutMs: 5_000 }

/** Adapter whose run() throws — exercises the crash → ConditionResult conversion. */
function crashingAdapter(message: string): AgentAdapter {
  return {
    name: "fake-crashing",
    async setup() {},
    async run(): Promise<RunResult> {
      throw new Error(message)
    },
    async teardown() {},
  }
}

/** Adapter that completes the task successfully. */
function okAdapter(): AgentAdapter & { seenWorkDirs: string[] } {
  const seenWorkDirs: string[] = []
  return {
    name: "fake-ok",
    seenWorkDirs,
    async setup() {},
    async run(task): Promise<RunResult> {
      seenWorkDirs.push(task.workDir)
      await Bun.write(`${task.workDir}/out.txt`, "ok")
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

/** Adapter that reports a non-ok runStatus (e.g. timeout) without throwing. */
function timedOutAdapter(): AgentAdapter {
  return {
    name: "fake-timeout",
    async setup() {},
    async run(task): Promise<RunResult> {
      return {
        text: "",
        steps: [],
        tokens: emptyTokenUsage(),
        cost: 0,
        durationMs: 1,
        llmDurationMs: 0,
        workDir: task.workDir,
        runStatus: "timeout",
        statusDetail: "deadline exceeded",
      }
    },
    async teardown() {},
  }
}

describe("bench/conditions runCondition scaffold", () => {
  test("adapter crash converts to an adapter-crashed ConditionResult with resultMeta preserved", async () => {
    const result = await runCondition({
      condition: "original",
      task: makeTask(),
      adapter: crashingAdapter("boom"),
      adapterConfig,
      resultMeta: {
        skillId: "my-skill",
        skillPath: "/skills/my-skill/SKILL.md",
        skillPaths: ["/skills/my-skill/SKILL.md"],
        skillContentHash: "abc123",
      },
    })

    expect(result.condition).toBe("original")
    expect(result.score).toBe(0)
    expect(result.pass).toBe(false)
    expect(result.evalDetails).toEqual([])
    expect(result.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(result.cost).toBe(0)
    expect(result.steps).toBe(0)
    expect(result.error).toContain("boom")
    expect(result.runStatus).toBe("adapter-crashed")
    expect(result.statusDetail).toStartWith("bench orchestration threw:")
    // Identity fields survive into the crash result
    expect(result.skillId).toBe("my-skill")
    expect(result.skillPath).toBe("/skills/my-skill/SKILL.md")
    expect(result.skillPaths).toEqual(["/skills/my-skill/SKILL.md"])
    expect(result.skillContentHash).toBe("abc123")
    // The crash shape never carries gradingWeights
    expect(result.gradingWeights).toBeUndefined()
  })

  test("non-ok runStatus from the adapter is gated: score=0, status propagated, error from statusDetail", async () => {
    const result = await runCondition({
      condition: "no-skill",
      task: makeTask(),
      adapter: timedOutAdapter(),
      adapterConfig,
    })

    expect(result.condition).toBe("no-skill")
    expect(result.score).toBe(0)
    expect(result.pass).toBe(false)
    expect(result.evalDetails).toEqual([])
    expect(result.runStatus).toBe("timeout")
    expect(result.statusDetail).toBe("deadline exceeded")
    expect(result.error).toBe("deadline exceeded")
  })

  test("successful run evaluates and assembles the result; stage() ran in the adapter's workDir", async () => {
    const adapter = okAdapter()
    const staged: string[] = []
    const result = await runCondition({
      condition: "original",
      task: makeTask(),
      adapter,
      adapterConfig,
      stage: async (workDir) => {
        staged.push(workDir)
      },
      resultMeta: { skillId: "my-skill" },
    })

    expect(result.condition).toBe("original")
    expect(result.runStatus).toBe("ok")
    expect(result.score).toBe(1)
    expect(result.pass).toBe(true)
    expect(result.evalDetails).toHaveLength(1)
    expect(result.evalDetails[0]!.method).toBe("file-check")
    expect(result.skillId).toBe("my-skill")
    expect(result.error).toBeUndefined()
    // The staged workDir is the one the adapter ran in
    expect(staged).toHaveLength(1)
    expect(adapter.seenWorkDirs).toEqual(staged)
  })
})
