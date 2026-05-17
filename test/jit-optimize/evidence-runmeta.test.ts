import { test, expect, describe } from "bun:test"
import { buildRunMeta } from "../../src/jit-optimize/evidence.ts"
import type { RunResult } from "../../src/core/types.ts"

function baseRun(overrides: Partial<RunResult> = {}): RunResult {
  return {
    text: "",
    steps: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    durationMs: 100,
    llmDurationMs: 0,
    workDir: "/tmp",
    runStatus: "ok",
    ...overrides,
  }
}

describe("buildRunMeta propagates skill telemetry", () => {
  test("copies skillProvided / skillObserved / skillMode", () => {
    const meta = buildRunMeta(baseRun({
      skillProvided: true,
      skillObserved: false,
      skillMode: "inject",
    }))
    expect(meta.skillProvided).toBe(true)
    expect(meta.skillObserved).toBe(false)
    expect(meta.skillMode).toBe("inject")
  })

  test("mirrors skillProvided into deprecated skillLoaded", () => {
    const meta = buildRunMeta(baseRun({ skillProvided: false, skillMode: "discover" }))
    expect(meta.skillLoaded).toBe(false)
  })

  test("preserves legacy-only skillLoaded when skillProvided is absent", () => {
    const meta = buildRunMeta(baseRun({ skillLoaded: true }))
    expect(meta.skillLoaded).toBe(true)
    expect(meta.skillProvided).toBeUndefined()
  })

  test("omits fields when not provided", () => {
    const meta = buildRunMeta(baseRun())
    expect(meta.skillProvided).toBeUndefined()
    expect(meta.skillObserved).toBeUndefined()
    expect(meta.skillMode).toBeUndefined()
    expect(meta.skillLoaded).toBeUndefined()
  })
})
