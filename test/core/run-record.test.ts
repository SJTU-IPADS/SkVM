import { test, expect, describe } from "bun:test"
import { RunRecordBuilder, hasUsageTelemetry } from "../../src/core/run-record.ts"

describe("RunRecordBuilder: final-text policy", () => {
  test("last non-empty assistantText wins", () => {
    const r = new RunRecordBuilder()
      .assistantText("first", 1)
      .assistantText("second", 2)
      .finish({ workDir: "/wd", durationMs: 10 })
    expect(r.text).toBe("second")
    expect(r.steps).toHaveLength(2)
  })

  test("empty assistantText is ignored entirely", () => {
    const r = new RunRecordBuilder()
      .assistantText("kept", 1)
      .assistantText("", 2)
      .finish({ workDir: "/wd", durationMs: 10 })
    expect(r.text).toBe("kept")
    expect(r.steps).toHaveLength(1)
  })

  test("falls back to text on a tool-call assistant step when no plain text exists", () => {
    const r = new RunRecordBuilder()
      .assistantToolCalls([{ id: "c1", name: "bash" }], { text: "running a command", timestamp: 1 })
      .finish({ workDir: "/wd", durationMs: 10 })
    expect(r.text).toBe("running a command")
  })

  test("explicit text beats later tool-call text in the fallback scan", () => {
    const r = new RunRecordBuilder()
      .assistantText("explicit", 1)
      .assistantToolCalls([{ id: "c1", name: "bash" }], { text: "later tool text", timestamp: 2 })
      .finish({ workDir: "/wd", durationMs: 10 })
    expect(r.text).toBe("explicit")
  })

  test("no assistant output at all → empty text", () => {
    const r = new RunRecordBuilder().finish({ workDir: "/wd", durationMs: 10 })
    expect(r.text).toBe("")
    expect(r.steps).toHaveLength(0)
  })
})

describe("RunRecordBuilder: tool-call pairing", () => {
  test("toolResult enriches the registered assistant tool call and records a tool step", () => {
    const r = new RunRecordBuilder()
      .assistantToolCalls([{ id: "c1", name: "read_file", input: { path: "a.txt" } }], { timestamp: 1 })
      .toolResult("c1", { name: "read_file", output: "contents", exitCode: 0 }, 2)
      .finish({ workDir: "/wd", durationMs: 10 })

    // The assistant step's registered call gained the output.
    const assistantCall = r.steps[0]!.toolCalls[0]!
    expect(assistantCall.output).toBe("contents")
    expect(assistantCall.exitCode).toBe(0)
    // And a standalone tool step was recorded.
    expect(r.steps[1]!.role).toBe("tool")
    expect(r.steps[1]!.toolCalls[0]!.id).toBe("c1")
  })

  test("toolResult with an unknown id still records a tool step", () => {
    const r = new RunRecordBuilder()
      .toolResult("orphan", { name: "bash", output: "out" }, 1)
      .finish({ workDir: "/wd", durationMs: 10 })
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0]!.toolCalls[0]!).toMatchObject({ id: "orphan", name: "bash", output: "out" })
  })

  test("toolResult falls back to the registered call's name when none is given", () => {
    const r = new RunRecordBuilder()
      .assistantToolCalls([{ id: "c1", name: "write_file" }], { timestamp: 1 })
      .toolResult("c1", { output: "done" }, 2)
      .finish({ workDir: "/wd", durationMs: 10 })
    expect(r.steps[1]!.toolCalls[0]!.name).toBe("write_file")
  })

  test("toolStep records complete calls in one shot (multiple per step allowed)", () => {
    const r = new RunRecordBuilder()
      .toolStep([
        { id: "t1", name: "bash", input: { cmd: "ls" }, output: "files", exitCode: 0 },
        { id: "t2", name: "read", output: "data" },
      ], 1)
      .finish({ workDir: "/wd", durationMs: 10 })
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0]!.role).toBe("tool")
    expect(r.steps[0]!.toolCalls[0]!).toMatchObject({ id: "t1", name: "bash", output: "files" })
    expect(r.steps[0]!.toolCalls[1]!).toMatchObject({ id: "t2", name: "read" })
  })
})

describe("RunRecordBuilder: usage accumulation + availability", () => {
  test("usage() accumulates across calls", () => {
    const r = new RunRecordBuilder()
      .usage({ input: 100, output: 10 })
      .usage({ input: 50, output: 5, cacheRead: 7 })
      .finish({ workDir: "/wd", durationMs: 10 })
    expect(r.tokens).toEqual({ input: 150, output: 15, cacheRead: 7, cacheWrite: 0 })
    expect(r.usageAvailable).toBe(true)
  })

  test("cost() accumulates and marks usage available", () => {
    const r = new RunRecordBuilder()
      .cost(0.01)
      .cost(0.02)
      .finish({ workDir: "/wd", durationMs: 10 })
    expect(r.cost).toBeCloseTo(0.03)
    expect(r.usageAvailable).toBe(true)
  })

  test("a reported zero is a true zero — usageAvailable stays true", () => {
    const r = new RunRecordBuilder()
      .usage({ input: 0, output: 0 })
      .finish({ workDir: "/wd", durationMs: 10 })
    expect(r.tokens.input).toBe(0)
    expect(r.usageAvailable).toBe(true)
  })

  test("no usage()/cost() calls → usageAvailable: false with zero-filled tokens", () => {
    const r = new RunRecordBuilder()
      .assistantText("hi", 1)
      .finish({ workDir: "/wd", durationMs: 10 })
    expect(r.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(r.cost).toBe(0)
    expect(r.usageAvailable).toBe(false)
  })
})

describe("RunRecordBuilder: finish", () => {
  test("defaults runStatus=ok and llmDurationMs=0; passes options through", () => {
    const r = new RunRecordBuilder().finish({
      workDir: "/wd",
      durationMs: 1234,
      runStatus: "timeout",
      statusDetail: "killed after 1s",
      skillLoaded: true,
    })
    expect(r.runStatus).toBe("timeout")
    expect(r.statusDetail).toBe("killed after 1s")
    expect(r.skillLoaded).toBe(true)
    expect(r.durationMs).toBe(1234)
    expect(r.llmDurationMs).toBe(0)
    expect(r.workDir).toBe("/wd")
  })

  test("stepCount reflects recorded steps before finish", () => {
    const b = new RunRecordBuilder()
    expect(b.stepCount).toBe(0)
    b.assistantText("x", 1)
    expect(b.stepCount).toBe(1)
  })

  test("adapterError passes through finish; absent when not given", () => {
    const withErr = new RunRecordBuilder().finish({
      workDir: "/wd",
      durationMs: 1,
      adapterError: { exitCode: 1, stderr: "boom" },
    })
    expect(withErr.adapterError).toEqual({ exitCode: 1, stderr: "boom" })
    const without = new RunRecordBuilder().finish({ workDir: "/wd", durationMs: 1 })
    expect("adapterError" in without).toBe(false)
  })
})

describe("hasUsageTelemetry", () => {
  test("explicit false means unavailable; true and absent mean available", () => {
    expect(hasUsageTelemetry({ usageAvailable: false })).toBe(false)
    expect(hasUsageTelemetry({ usageAvailable: true })).toBe(true)
    expect(hasUsageTelemetry({})).toBe(true)
  })
})

describe("RunRecordBuilder: per-harness variance knobs", () => {
  test("toolCallTextIsFinal dialect: tool-call turn text claims the final text", () => {
    const r = new RunRecordBuilder({ toolCallTextIsFinal: true })
      .assistantText("early plain text", 1)
      .assistantToolCalls([{ id: "c1", name: "bash" }], { text: "later tool text", timestamp: 2 })
      .finish({ workDir: "/wd", durationMs: 1 })
    expect(r.text).toBe("later tool text")
  })

  test("stepForPairedToolResult=false dialect: paired result enriches without a standalone step", () => {
    const b = new RunRecordBuilder({ stepForPairedToolResult: false })
      .assistantToolCalls([{ id: "c1", name: "read" }], { timestamp: 1 })
      .toolResult("c1", { output: "out" }, 2)
    expect(b.stepCount).toBe(1)
    const r = b.toolResult("orphan", { name: "x", output: "o" }, 3)
      .finish({ workDir: "/wd", durationMs: 1 })
    // Unpaired ids still get a standalone step.
    expect(r.steps).toHaveLength(2)
    expect(r.steps[0]!.toolCalls[0]!.output).toBe("out")
  })

  test("usageTotalOverride beats accumulated sums; zero totals are ignored", () => {
    const r = new RunRecordBuilder()
      .usage({ input: 10, output: 1 })
      .usageTotalOverride({ input: 100, output: 20, cacheRead: 5, cacheWrite: 0 })
      .finish({ workDir: "/wd", durationMs: 1 })
    expect(r.tokens.input).toBe(100)
    const zero = new RunRecordBuilder()
      .usage({ input: 10, output: 1 })
      .usageTotalOverride({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
      .finish({ workDir: "/wd", durationMs: 1 })
    expect(zero.tokens.input).toBe(10)
    expect(zero.usageAvailable).toBe(true)
  })

  test("parseNote survives an ok finish; finish() fields beat it one by one", () => {
    const note = {
      runStatus: "parse-failed" as const,
      statusDetail: "no events",
      adapterError: { exitCode: 1, stderr: "parser error" },
    }
    const ok = new RunRecordBuilder().parseNote(note).finish({ workDir: "/wd", durationMs: 1 })
    expect(ok.runStatus).toBe("parse-failed")
    expect(ok.statusDetail).toBe("no events")
    expect(ok.adapterError?.stderr).toBe("parser error")

    const verdict = new RunRecordBuilder().parseNote(note).finish({
      workDir: "/wd",
      durationMs: 1,
      runStatus: "timeout",
      statusDetail: "killed",
      adapterError: { exitCode: 1, stderr: "subprocess stderr" },
    })
    expect(verdict.runStatus).toBe("timeout")
    expect(verdict.statusDetail).toBe("killed")
    expect(verdict.adapterError?.stderr).toBe("subprocess stderr")
  })

  test("textFallback is last resort after explicit text and the step scan", () => {
    const onlyFallback = new RunRecordBuilder()
      .textFallback("from result event")
      .finish({ workDir: "/wd", durationMs: 1 })
    expect(onlyFallback.text).toBe("from result event")

    const stepWins = new RunRecordBuilder()
      .assistantToolCalls([{ id: "c", name: "t" }], { text: "step text", timestamp: 1 })
      .textFallback("from result event")
      .finish({ workDir: "/wd", durationMs: 1 })
    expect(stepWins.text).toBe("step text")
  })
})
