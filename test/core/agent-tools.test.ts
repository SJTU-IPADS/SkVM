import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  createAgentToolExecutor,
  resolveCommandTimeoutMs,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
} from "../../src/core/agent-tools.ts"

let workDir: string

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "skvm-agent-tools-test-"))
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

describe("resolveCommandTimeoutMs", () => {
  test("defaults to 30s when unset", () => {
    expect(resolveCommandTimeoutMs(undefined)).toBe(DEFAULT_COMMAND_TIMEOUT_MS)
    expect(resolveCommandTimeoutMs(null)).toBe(DEFAULT_COMMAND_TIMEOUT_MS)
  })

  test("converts seconds to milliseconds", () => {
    expect(resolveCommandTimeoutMs(45)).toBe(45_000)
    expect(resolveCommandTimeoutMs(120)).toBe(120_000)
  })

  test("caps at the maximum", () => {
    expect(resolveCommandTimeoutMs(99_999)).toBe(MAX_COMMAND_TIMEOUT_MS)
  })

  test("rejects non-positive and unparseable values back to default", () => {
    expect(resolveCommandTimeoutMs(0)).toBe(DEFAULT_COMMAND_TIMEOUT_MS)
    expect(resolveCommandTimeoutMs(-5)).toBe(DEFAULT_COMMAND_TIMEOUT_MS)
    expect(resolveCommandTimeoutMs("soon")).toBe(DEFAULT_COMMAND_TIMEOUT_MS)
    expect(resolveCommandTimeoutMs(Number.NaN)).toBe(DEFAULT_COMMAND_TIMEOUT_MS)
    expect(resolveCommandTimeoutMs(undefined)).toBe(DEFAULT_COMMAND_TIMEOUT_MS)
  })

  test("a numeric string is honoured, not silently downgraded", () => {
    // Models emit "60" routinely; silently giving them 30s is worse than parsing.
    expect(resolveCommandTimeoutMs("60")).toBe(60_000)
  })

  test("a sub-second request is floored rather than made unrunnable", () => {
    // 1e-9 rounded to 0ms produced "command timed out after 0s" before anything ran.
    expect(resolveCommandTimeoutMs(1e-9)).toBe(1_000)
    expect(resolveCommandTimeoutMs(0.001)).toBe(1_000)
  })

  test("the caller's remaining budget caps the request", () => {
    // A tool call is not interruptible once started, so a 600s command inside a
    // 20s run would otherwise run to completion past the run's own deadline.
    expect(resolveCommandTimeoutMs(600, 20_000)).toBe(20_000)
    expect(resolveCommandTimeoutMs(5, 20_000)).toBe(5_000)
    // An exhausted budget still leaves the floor — never a 0ms timeout.
    expect(resolveCommandTimeoutMs(600, -1)).toBe(MAX_COMMAND_TIMEOUT_MS)
    expect(resolveCommandTimeoutMs(600, 10)).toBe(1_000)
  })
})

describe("execute_command timeout_seconds", () => {
  test("kills the command after the requested timeout", async () => {
    const exec = createAgentToolExecutor(workDir)
    const start = performance.now()
    const result = await exec({
      id: "t1",
      name: "execute_command",
      arguments: { command: "sleep 30", timeout_seconds: 1 },
    })
    const elapsed = performance.now() - start
    expect(result.output).toContain("timed out after 1s")
    expect(elapsed).toBeLessThan(5_000)
  })

  test("a command finishing within a raised timeout succeeds", async () => {
    const exec = createAgentToolExecutor(workDir)
    const result = await exec({
      id: "t2",
      name: "execute_command",
      arguments: { command: "echo ok", timeout_seconds: 90 },
    })
    expect(result.output).toContain("ok")
    expect(result.exitCode).toBe(0)
  })

  test("default timeout message still reports 30s", async () => {
    const exec = createAgentToolExecutor(workDir)
    const result = await exec({
      id: "t3",
      name: "execute_command",
      arguments: { command: "echo fine" },
    })
    expect(result.output).toContain("fine")
  })
})
