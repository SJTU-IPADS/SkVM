import { test, expect, describe } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { runTasksForRound, isInfraTaintedEvidence } from "../../src/jit-optimize/loop.ts"
import type { RunnableTask } from "../../src/jit-optimize/task-source.ts"
import type { AgentAdapter, RunResult } from "../../src/core/types.ts"
import { emptyTokenUsage } from "../../src/core/types.ts"
import { Pool } from "../../src/core/concurrency.ts"
import { loadSkill } from "../../src/core/skill-loader.ts"
import type { ResolvedSkill } from "../../src/core/skill-loader.ts"

// Mock adapter that fakes a timeout-killed run with residual workDir output —
// the exact shape that recreated the original false-positive in subprocess
// adapters before the round-3 fixes. This test asserts that jit-optimize's
// loop runner gates on runStatus and emits an infra-tainted Evidence instead
// of feeding contaminated criteria scores to the optimizer.
function createTaintedMockAdapter(): AgentAdapter {
  return {
    name: "mock-tainted",
    async setup() {},
    async run(task): Promise<RunResult> {
      // Plant a file the eval would otherwise score as a pass.
      await Bun.write(`${task.workDir}/result.txt`, "ok")
      return {
        text: "",
        steps: [],
        tokens: emptyTokenUsage(),
        cost: 0,
        durationMs: 300_000,
        llmDurationMs: 0,
        workDir: task.workDir,
        runStatus: "timeout",
        statusDetail: "mock subprocess killed after 300000ms",
      }
    },
    async teardown() {},
  }
}

function createOkMockAdapter(): AgentAdapter {
  return {
    name: "mock-ok",
    async setup() {},
    async run(task): Promise<RunResult> {
      await Bun.write(`${task.workDir}/result.txt`, "ok")
      return {
        text: "done",
        steps: [{ role: "assistant", text: "done", toolCalls: [], timestamp: Date.now() }],
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        cost: 0.001,
        durationMs: 100,
        llmDurationMs: 50,
        workDir: task.workDir,
        runStatus: "ok",
      }
    },
    async teardown() {},
  }
}

async function withSkill(fn: (skill: ResolvedSkill) => Promise<void>) {
  const skillDir = await mkdtemp(path.join(tmpdir(), "jit-optimize-test-"))
  try {
    await writeFile(path.join(skillDir, "SKILL.md"), "# test skill\n")
    const skill = await loadSkill(skillDir)
    await fn(skill)
  } finally {
    await rm(skillDir, { recursive: true, force: true })
  }
}

describe("jit-optimize runTasksForRound runStatus gate (sweep G1)", () => {
  test("tainted adapter run produces infra-tainted Evidence, no eval", async () => {
    await withSkill(async (skill) => {
      const logDir = await mkdtemp(path.join(tmpdir(), "jit-optimize-log-"))
      try {
        const task: RunnableTask = {
          id: "task1",
          prompt: "Write 'ok' to result.txt",
          eval: [{ method: "file-check", path: "result.txt", mode: "exact", expected: "ok" }],
          workDir: "",
          timeoutMs: 60_000,
          maxSteps: 30,
        }

        const evidences = await runTasksForRound({
          tasks: [task],
          skill,
          runsPerTask: 1,
          adapterPool: new Pool([createTaintedMockAdapter()]),
          adapterConfig: { model: "test", maxSteps: 30, timeoutMs: 60_000 },
          evalConfig: {},
          logDir,
          setLabel: "train",
        })

        expect(evidences).toHaveLength(1)
        const ev = evidences[0]!
        // Critical: the evidence MUST be flagged infra-tainted so the
        // abstain path can pick it up. Without the gate, isInfraTaintedEvidence
        // would return false because the adapter didn't throw — it just
        // returned runStatus='timeout'.
        expect(isInfraTaintedEvidence(ev)).toBe(true)
        expect(ev.criteria).toBeDefined()
        expect(ev.criteria!.length).toBe(1)
        expect(ev.criteria![0]!.id).toBe("runtime-error")
        expect(ev.criteria![0]!.infraError).toBeDefined()
        // infraError carries the adapter's statusDetail (more informative
        // than the raw enum value).
        expect(ev.criteria![0]!.infraError).toContain("killed")
        // runMeta still carries the runStatus (round-1 plumbing)
        expect(ev.runMeta?.runStatus).toBe("timeout")
      } finally {
        await rm(logDir, { recursive: true, force: true })
      }
    })
  })

  test("ok adapter run produces normal Evidence with criteria from evaluateAll", async () => {
    await withSkill(async (skill) => {
      const logDir = await mkdtemp(path.join(tmpdir(), "jit-optimize-log-"))
      try {
        const task: RunnableTask = {
          id: "task1",
          prompt: "Write 'ok' to result.txt",
          eval: [{ method: "file-check", path: "result.txt", mode: "exact", expected: "ok" }],
          workDir: "",
          timeoutMs: 60_000,
          maxSteps: 30,
        }

        const evidences = await runTasksForRound({
          tasks: [task],
          skill,
          runsPerTask: 1,
          adapterPool: new Pool([createOkMockAdapter()]),
          adapterConfig: { model: "test", maxSteps: 30, timeoutMs: 60_000 },
          evalConfig: {},
          logDir,
          setLabel: "train",
        })

        expect(evidences).toHaveLength(1)
        const ev = evidences[0]!
        expect(isInfraTaintedEvidence(ev)).toBe(false)
        expect(ev.runMeta?.runStatus).toBe("ok")
        // The healthy run should have produced a real evaluation criterion,
        // not a runtime-error stub.
        expect(ev.criteria![0]!.id).not.toBe("runtime-error")
      } finally {
        await rm(logDir, { recursive: true, force: true })
      }
    })
  })
})
