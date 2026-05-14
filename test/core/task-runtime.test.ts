import { describe, expect, test } from "bun:test"
import { resolveTaskRuntime } from "../../src/core/task-runtime.ts"

describe("resolveTaskRuntime", () => {
  const task = { timeoutMs: 120_000, maxSteps: 30 }

  test("returns per-task values when no overrides", () => {
    expect(resolveTaskRuntime(task)).toEqual({ timeoutMs: 120_000, maxSteps: 30 })
  })

  test("CLI timeoutMs absolute override beats task value", () => {
    expect(resolveTaskRuntime(task, { timeoutMs: 3_600_000 })).toEqual({
      timeoutMs: 3_600_000,
      maxSteps: 30,
    })
  })

  test("CLI maxSteps absolute override beats task value", () => {
    expect(resolveTaskRuntime(task, { maxSteps: 100 })).toEqual({
      timeoutMs: 120_000,
      maxSteps: 100,
    })
  })

  test("timeoutMult multiplies the per-task value when no absolute override", () => {
    expect(resolveTaskRuntime(task, { timeoutMult: 2 })).toEqual({
      timeoutMs: 240_000,
      maxSteps: 30,
    })
  })

  test("absolute timeoutMs override ignores timeoutMult", () => {
    expect(resolveTaskRuntime(task, { timeoutMs: 60_000, timeoutMult: 5 })).toEqual({
      timeoutMs: 60_000,
      maxSteps: 30,
    })
  })

  test("non-integer multipliers are rounded", () => {
    expect(resolveTaskRuntime({ timeoutMs: 1_000, maxSteps: 10 }, { timeoutMult: 1.5 })).toEqual({
      timeoutMs: 1_500,
      maxSteps: 10,
    })
    expect(resolveTaskRuntime({ timeoutMs: 333, maxSteps: 10 }, { timeoutMult: 0.5 })).toEqual({
      timeoutMs: 167,
      maxSteps: 10,
    })
  })

  test("fractional multipliers shrink the timeout", () => {
    expect(resolveTaskRuntime(task, { timeoutMult: 0.5 }).timeoutMs).toBe(60_000)
  })
})
