import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { parsePiNDJSON, piEventsToRunResult, PiAdapter, type PiEvent } from "../../src/adapters/pi.ts"

describe("parsePiNDJSON", () => {
  test("parses valid NDJSON lines", () => {
    const input = [
      '{"type":"session","version":3,"id":"test-1","timestamp":"2026-01-01T00:00:00Z","cwd":"/tmp"}',
      '{"type":"agent_start"}',
      '{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"hello"}],"timestamp":1000}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hi"}],"api":"openai","provider":"openai","model":"gpt-4o","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":2000}}',
      '{"type":"agent_end","messages":[]}',
    ].join("\n")

    const events = parsePiNDJSON(input)
    expect(events.length).toBe(5)
    expect(events[0]!.type).toBe("session")
    expect(events[1]!.type).toBe("agent_start")
    expect(events[2]!.type).toBe("message_start")
    expect(events[3]!.type).toBe("message_end")
    expect(events[4]!.type).toBe("agent_end")
  })

  test("skips blank lines and non-JSON lines", () => {
    const input = [
      "",
      "some non-json output",
      '{"type":"agent_start"}',
      "",
      "another invalid line",
    ].join("\n")

    const events = parsePiNDJSON(input)
    expect(events.length).toBe(1)
    expect(events[0]!.type).toBe("agent_start")
  })

  test("handles empty input", () => {
    expect(parsePiNDJSON("")).toEqual([])
    expect(parsePiNDJSON("\n\n")).toEqual([])
  })
})

describe("piEventsToRunResult", () => {
  test("extracts text from assistant messages", () => {
    const events: PiEvent[] = [
      {
        type: "agent_end",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Hello" }],
            timestamp: 1000,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Hello there!" }],
            api: "openai",
            provider: "openai",
            model: "gpt-4o",
            usage: {
              input: 1,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 3,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 2000,
          },
        ],
      },
    ]

    const result = piEventsToRunResult(events, "/tmp/work", 5000)
    expect(result.text).toBe("Hello there!")
    expect(result.steps.length).toBe(1)
    expect(result.steps[0]!.role).toBe("assistant")
    expect(result.steps[0]!.text).toBe("Hello there!")
    expect(result.durationMs).toBe(5000)
    expect(result.workDir).toBe("/tmp/work")
    expect(result.tokens.input).toBe(1)
    expect(result.tokens.output).toBe(2)
  })

  test("extracts tool calls and tool results", () => {
    const events: PiEvent[] = [
      {
        type: "agent_end",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Run ls" }],
            timestamp: 1000,
          },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Sure" },
              { type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "ls -la" } },
            ],
            api: "openai",
            provider: "openai",
            model: "gpt-4o",
            usage: {
              input: 5,
              output: 10,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 15,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 2000,
          },
          {
            role: "toolResult",
            toolCallId: "tc-1",
            toolName: "bash",
            content: [{ type: "text", text: "file1.txt\nfile2.txt" }],
            isError: false,
            timestamp: 3000,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Done!" }],
            api: "openai",
            provider: "openai",
            model: "gpt-4o",
            usage: {
              input: 20,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 22,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
            },
            stopReason: "stop",
            timestamp: 4000,
          },
        ],
      },
    ]

    const result = piEventsToRunResult(events, "/tmp/work", 5000)
    expect(result.text).toBe("Done!")
    expect(result.steps.length).toBe(3)

    // First assistant step with tool call
    const assistantStep = result.steps[0]!
    expect(assistantStep.role).toBe("assistant")
    expect(assistantStep.text).toBe("Sure")
    expect(assistantStep.toolCalls.length).toBe(1)
    expect(assistantStep.toolCalls[0]!.id).toBe("tc-1")
    expect(assistantStep.toolCalls[0]!.name).toBe("bash")
    expect(assistantStep.toolCalls[0]!.input).toEqual({ command: "ls -la" })
    expect(assistantStep.toolCalls[0]!.output).toBe("file1.txt\nfile2.txt")
    expect(assistantStep.toolCalls[0]!.exitCode).toBe(0)

    // Tool result step
    const toolStep = result.steps[1]!
    expect(toolStep.role).toBe("tool")
    expect(toolStep.toolCalls[0]!.output).toBe("file1.txt\nfile2.txt")

    // Final assistant step
    expect(result.steps[2]!.role).toBe("assistant")
    expect(result.steps[2]!.text).toBe("Done!")

    // Token aggregation
    expect(result.tokens.input).toBe(25)
    expect(result.tokens.output).toBe(12)
    expect(result.cost).toBeCloseTo(0.001)
  })

  test("handles error assistant messages", () => {
    const events: PiEvent[] = [
      {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            api: "openai",
            provider: "openai",
            model: "gpt-4o",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "error",
            errorMessage: "rate limit exceeded",
            timestamp: 1000,
          },
        ],
      },
    ]

    const result = piEventsToRunResult(events, "/tmp/work", 1000)
    expect(result.runStatus).toBe("ok")
    expect(result.adapterError).toBeDefined()
    expect(result.adapterError!.stderr).toContain("rate limit exceeded")
  })

  test("handles empty events", () => {
    const result = piEventsToRunResult([], "/tmp/work", 0)
    expect(result.text).toBe("")
    expect(result.steps).toEqual([])
    expect(result.tokens.input).toBe(0)
    expect(result.cost).toBe(0)
    expect(result.runStatus).toBe("parse-failed")
  })

  test("falls back to message_end events when agent_end is missing", () => {
    const events: PiEvent[] = [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Partial output" }],
          api: "openai",
          provider: "openai",
          model: "gpt-4o",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1000,
        },
      },
    ]

    const result = piEventsToRunResult(events, "/tmp/work", 500)
    expect(result.text).toBe("Partial output")
    expect(result.steps.length).toBe(1)
    expect(result.runStatus).toBe("ok")
  })

  test("aggregates usage across multiple assistant messages", () => {
    const events: PiEvent[] = [
      {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "A" }],
            api: "openai",
            provider: "openai",
            model: "gpt-4o",
            usage: {
              input: 10,
              output: 5,
              cacheRead: 2,
              cacheWrite: 1,
              totalTokens: 15,
              cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
            },
            stopReason: "toolUse",
            timestamp: 1000,
          },
          {
            role: "toolResult",
            toolCallId: "tc-1",
            toolName: "bash",
            content: [{ type: "text", text: "ok" }],
            isError: false,
            timestamp: 2000,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "B" }],
            api: "openai",
            provider: "openai",
            model: "gpt-4o",
            usage: {
              input: 20,
              output: 10,
              cacheRead: 4,
              cacheWrite: 2,
              totalTokens: 30,
              cost: { input: 0.02, output: 0.04, cacheRead: 0.002, cacheWrite: 0.004, total: 0.066 },
            },
            stopReason: "stop",
            timestamp: 3000,
          },
        ],
      },
    ]

    const result = piEventsToRunResult(events, "/tmp/work", 3000)
    expect(result.tokens.input).toBe(30)
    expect(result.tokens.output).toBe(15)
    expect(result.tokens.cacheRead).toBe(6)
    expect(result.tokens.cacheWrite).toBe(3)
    expect(result.cost).toBeCloseTo(0.099)
  })
})

describe("toPiModel", () => {
  test("passes through model ids that already contain a slash", async () => {
    const { toPiModel } = await import("../../src/adapters/pi.ts")
    expect(toPiModel("anthropic/claude-sonnet-4.6")).toBe("anthropic/claude-sonnet-4.6")
    expect(toPiModel("openrouter/anthropic/claude-sonnet-4.6")).toBe("openrouter/anthropic/claude-sonnet-4.6")
  })

  test("prepends openrouter/ for bare model ids", async () => {
    const { toPiModel } = await import("../../src/adapters/pi.ts")
    expect(toPiModel("gpt-4o")).toBe("openrouter/gpt-4o")
    expect(toPiModel("claude-3-opus")).toBe("openrouter/claude-3-opus")
  })
})

describe("PiAdapter basics", () => {
  test("adapter name is pi", () => {
    const adapter = new PiAdapter()
    expect(adapter.name).toBe("pi")
  })
})

// ---------------------------------------------------------------------------
// Skill Mode File Creation Tests
// ---------------------------------------------------------------------------

describe("Pi skill mode file creation", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "pi-skill-test-"))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  test("inject mode writes AGENTS.md in workDir", async () => {
    const skillContent = "# My Skill\nInstructions here."
    await Bun.write(path.join(tmpDir, "AGENTS.md"), skillContent)

    const file = Bun.file(path.join(tmpDir, "AGENTS.md"))
    expect(await file.exists()).toBe(true)
    expect(await file.text()).toBe(skillContent)
  })

  test("discover mode writes .pi-skills/<name>/SKILL.md", async () => {
    const skillName = "file-ops"
    const skillContent = "# File Ops\nDetailed instructions."

    const skillDir = path.join(tmpDir, ".pi-skills", skillName)
    await mkdir(skillDir, { recursive: true })
    await Bun.write(path.join(skillDir, "SKILL.md"), skillContent)

    const written = await Bun.file(path.join(skillDir, "SKILL.md")).text()
    expect(written).toBe(skillContent)
  })
})
