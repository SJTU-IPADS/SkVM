import { test, expect, describe } from "bun:test"
import {
  TaskSchema,
  RunResultSchema,
  EvalCriterionSchema,
  TokenUsageSchema,
  TCPSchema,
  SCRSchema,
  emptyTokenUsage,
  addTokenUsage,
  compareLevel,
  type Task,
  type TokenUsage,
} from "../../src/core/types.ts"

describe("TokenUsage", () => {
  test("schema validates valid input", () => {
    const result = TokenUsageSchema.parse({ input: 100, output: 50 })
    expect(result.input).toBe(100)
    expect(result.output).toBe(50)
    expect(result.cacheRead).toBe(0) // default
    expect(result.cacheWrite).toBe(0) // default
  })

  test("schema rejects invalid input", () => {
    expect(() => TokenUsageSchema.parse({ input: "abc" })).toThrow()
    expect(() => TokenUsageSchema.parse({})).toThrow()
  })

  test("emptyTokenUsage returns zeros", () => {
    const t = emptyTokenUsage()
    expect(t).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  test("addTokenUsage sums correctly", () => {
    const a: TokenUsage = { input: 10, output: 20, cacheRead: 5, cacheWrite: 3 }
    const b: TokenUsage = { input: 30, output: 10, cacheRead: 2, cacheWrite: 1 }
    expect(addTokenUsage(a, b)).toEqual({ input: 40, output: 30, cacheRead: 7, cacheWrite: 4 })
  })
})

describe("Level", () => {
  test("compareLevel ordering", () => {
    expect(compareLevel("L0", "L3")).toBeLessThan(0)
    expect(compareLevel("L3", "L0")).toBeGreaterThan(0)
    expect(compareLevel("L2", "L2")).toBe(0)
    expect(compareLevel("L1", "L2")).toBeLessThan(0)
  })
})

describe("EvalCriterion", () => {
  test("script criterion", () => {
    const criterion = EvalCriterionSchema.parse({
      method: "script",
      command: "wc -l result.txt",
      expectedExitCode: 0,
    })
    expect(criterion.method).toBe("script")
  })

  test("file-check criterion", () => {
    const criterion = EvalCriterionSchema.parse({
      method: "file-check",
      path: "result.txt",
      mode: "exact",
      expected: "hello",
    })
    expect(criterion.method).toBe("file-check")
  })

  test("llm-judge criterion", () => {
    const criterion = EvalCriterionSchema.parse({
      method: "llm-judge",
      rubric: "Output must be a valid JSON array",
    })
    expect(criterion.method).toBe("llm-judge")
    if (criterion.method === "llm-judge") {
      expect(criterion.maxScore).toBe(1.0) // default
    }
  })

  test("rejects unknown method", () => {
    expect(() =>
      EvalCriterionSchema.parse({ method: "unknown", foo: "bar" })
    ).toThrow()
  })
})

describe("Task", () => {
  test("validates minimal task", () => {
    const task = TaskSchema.parse({
      id: "test-1",
      prompt: "Write hello to output.txt",
      eval: [{ method: "file-check", path: "output.txt", mode: "exact", expected: "hello" }],
    })
    expect(task.id).toBe("test-1")
    expect(task.timeoutMs).toBe(120_000) // default
    expect(task.maxSteps).toBe(30) // default
  })

  test("validates task with fixtures", () => {
    const task = TaskSchema.parse({
      id: "test-2",
      prompt: "Count lines in data.txt",
      fixtures: { "data.txt": "line1\nline2\nline3" },
      eval: [{ method: "file-check", path: "result.txt", mode: "exact", expected: "3" }],
    })
    expect(task.fixtures?.["data.txt"]).toBe("line1\nline2\nline3")
  })

  test("rejects task with empty eval", () => {
    expect(() =>
      TaskSchema.parse({ id: "t", prompt: "p", eval: [] })
    ).toThrow()
  })

  test("round-trip: parse -> serialize -> parse", () => {
    const original: Task = {
      id: "round-trip",
      prompt: "do something",
      eval: [{ method: "script", command: "echo ok", expectedExitCode: 0 }],
      timeoutMs: 60_000,
      maxSteps: 10,
    }
    const json = JSON.stringify(original)
    const parsed = TaskSchema.parse(JSON.parse(json))
    expect(parsed.id).toBe(original.id)
    expect(parsed.prompt).toBe(original.prompt)
    expect(parsed.timeoutMs).toBe(60_000)
  })
})

describe("RunResult", () => {
  test("validates complete result", () => {
    const result = RunResultSchema.parse({
      text: "Done",
      steps: [{
        role: "assistant",
        text: "I will write the file",
        toolCalls: [{
          id: "tc_1",
          name: "write_file",
          input: { path: "output.txt", content: "hello" },
          output: "File written",
          durationMs: 50,
        }],
        timestamp: Date.now(),
      }],
      tokens: { input: 100, output: 50 },
      cost: 0.001,
      durationMs: 2000,
      workDir: "/tmp/test",
      runStatus: "ok",
    })
    expect(result.text).toBe("Done")
    expect(result.steps).toHaveLength(1)
    expect(result.runStatus).toBe("ok")
  })
})

describe("TCP", () => {
  test("validates profile", () => {
    const tcp = TCPSchema.parse({
      version: "1.0",
      model: "test-model",
      harness: "bare",
      profiledAt: new Date().toISOString(),
      capabilities: {
        "gen.code.python": "L2",
        "reason.arithmetic": "L3",
      },
      details: [{
        primitiveId: "gen.code.python",
        highestLevel: "L2",
        levelResults: [
          { level: "L3", passed: false, passCount: 1, totalCount: 3, durationMs: 5000, costUsd: 0.01 },
          { level: "L2", passed: true, passCount: 3, totalCount: 3, durationMs: 4000, costUsd: 0.01 },
        ],
      }],
      cost: {
        totalUsd: 0.05,
        totalTokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
        durationMs: 30000,
      },
    })
    expect(tcp.capabilities["gen.code.python"]).toBe("L2")
  })
})

describe("SCR", () => {
  test("validates skill requirement", () => {
    const scr = SCRSchema.parse({
      skillName: "weather-forecast",
      purposes: [{
        id: "fetch-weather",
        description: "Fetch weather data from API",
        currentPath: {
          primitives: [
            { id: "tool.web", minLevel: "L1", evidence: "Makes HTTP GET to weather API" },
            { id: "gen.text.structured", minLevel: "L1", evidence: "Formats JSON output" },
          ],
        },
        alternativePaths: [{
          primitives: [
            { id: "tool.exec", minLevel: "L2", evidence: "Use curl command instead" },
            { id: "gen.code.shell", minLevel: "L1", evidence: "Parse with jq" },
          ],
          note: "Shell-based alternative using curl + jq",
        }],
      }],
    })
    expect(scr.purposes).toHaveLength(1)
    expect(scr.purposes[0]!.currentPath.primitives).toHaveLength(2)
    expect(scr.purposes[0]!.alternativePaths).toHaveLength(1)
  })
})

describe("RunResult skill telemetry fields", () => {
  test("accepts skillProvided / skillObserved / skillMode as optional", () => {
    const base = {
      text: "", steps: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0, durationMs: 0, llmDurationMs: 0, workDir: "/tmp", runStatus: "ok",
    } as const
    expect(RunResultSchema.safeParse({ ...base }).success).toBe(true)
    expect(RunResultSchema.safeParse({ ...base, skillProvided: true, skillObserved: false, skillMode: "inject" }).success).toBe(true)
    expect(RunResultSchema.safeParse({ ...base, skillProvided: false, skillMode: "discover" }).success).toBe(true)
  })

  test("rejects invalid skillMode literal", () => {
    const base = {
      text: "", steps: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0, durationMs: 0, llmDurationMs: 0, workDir: "/tmp", runStatus: "ok",
    } as const
    expect(RunResultSchema.safeParse({ ...base, skillMode: "bogus" }).success).toBe(false)
  })

  test("still accepts legacy skillLoaded for back-compat", () => {
    const base = {
      text: "", steps: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0, durationMs: 0, llmDurationMs: 0, workDir: "/tmp", runStatus: "ok",
    } as const
    expect(RunResultSchema.safeParse({ ...base, skillLoaded: true }).success).toBe(true)
  })

  test("typed property access compiles for new fields", () => {
    const parsed = RunResultSchema.parse({
      text: "", steps: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0, durationMs: 0, llmDurationMs: 0, workDir: "/tmp", runStatus: "ok",
      skillProvided: true, skillObserved: false, skillMode: "inject",
    })
    // Property accesses below must type-check — that is the real assertion.
    expect(parsed.skillProvided).toBe(true)
    expect(parsed.skillObserved).toBe(false)
    expect(parsed.skillMode).toBe("inject")
  })
})
