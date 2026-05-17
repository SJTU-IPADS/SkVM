import { describe, test, expect } from "bun:test"
import {
  TIMEOUT_DEFAULTS,
  resolveTaskTimeout,
  resolveCompilerTimeout,
  resolveOptimizerTimeout,
  resolveTaskGenTimeout,
  resolveCandidateGenTimeout,
} from "../../src/core/timeouts.ts"
import { TASK_FILE_DEFAULTS } from "../../src/core/ui-defaults.ts"

describe("TIMEOUT_DEFAULTS", () => {
  test("taskExec mirrors TASK_FILE_DEFAULTS.timeoutMs", () => {
    expect(TIMEOUT_DEFAULTS.taskExec).toBe(TASK_FILE_DEFAULTS.timeoutMs)
  })
  test("documented numeric defaults", () => {
    expect(TIMEOUT_DEFAULTS.compiler).toBe(300_000)
    expect(TIMEOUT_DEFAULTS.optimizer).toBe(600_000)
    expect(TIMEOUT_DEFAULTS.taskGen).toBe(900_000)
    expect(TIMEOUT_DEFAULTS.candidateGen).toBe(180_000)
  })
})

describe("resolveTaskTimeout", () => {
  test("cli wins outright when given", () => {
    expect(resolveTaskTimeout({ cli: 5000, task: { timeoutMs: 999 }, multiplier: 99 })).toBe(5000)
  })
  test("falls back to task value", () => {
    expect(resolveTaskTimeout({ task: { timeoutMs: 7000 } })).toBe(7000)
  })
  test("applies multiplier to task value when cli absent", () => {
    expect(resolveTaskTimeout({ task: { timeoutMs: 1000 }, multiplier: 2.5 })).toBe(2500)
  })
  test("multiplier defaults to 1 when undefined", () => {
    expect(resolveTaskTimeout({ task: { timeoutMs: 4242 } })).toBe(4242)
  })
  test("multiplier is ignored when cli is given", () => {
    expect(resolveTaskTimeout({ cli: 100, task: { timeoutMs: 1000 }, multiplier: 5 })).toBe(100)
  })
})

describe("resolveCompilerTimeout", () => {
  test("cli wins", () => {
    expect(resolveCompilerTimeout({ cli: 12345 })).toBe(12345)
  })
  test("falls back to TIMEOUT_DEFAULTS.compiler", () => {
    expect(resolveCompilerTimeout({})).toBe(TIMEOUT_DEFAULTS.compiler)
  })
})

describe("resolveOptimizerTimeout", () => {
  test("cli wins", () => {
    expect(resolveOptimizerTimeout({ cli: 22222 })).toBe(22222)
  })
  test("falls back to TIMEOUT_DEFAULTS.optimizer", () => {
    expect(resolveOptimizerTimeout({})).toBe(TIMEOUT_DEFAULTS.optimizer)
  })
})

describe("resolveTaskGenTimeout", () => {
  test("cli wins", () => {
    expect(resolveTaskGenTimeout({ cli: 33333 })).toBe(33333)
  })
  test("falls back to TIMEOUT_DEFAULTS.taskGen", () => {
    expect(resolveTaskGenTimeout({})).toBe(TIMEOUT_DEFAULTS.taskGen)
  })
})

describe("resolveCandidateGenTimeout", () => {
  test("cli wins", () => {
    expect(resolveCandidateGenTimeout({ cli: 44444 })).toBe(44444)
  })
  test("falls back to TIMEOUT_DEFAULTS.candidateGen", () => {
    expect(resolveCandidateGenTimeout({})).toBe(TIMEOUT_DEFAULTS.candidateGen)
  })
})
