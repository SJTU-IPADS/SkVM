import { test, expect, describe } from "bun:test"
import {
  parseCodeBuddyStreamJSON,
  codeBuddyEventsToRunResult,
  CodeBuddyAdapter,
  detectSkillInject,
  detectSkillDiscover,
  type CodeBuddyEvent,
} from "../../src/adapters/codebuddy.ts"

describe("parseCodeBuddyStreamJSON", () => {
  test("parses valid stream-json lines", () => {
    const input = [
      '{"type":"system","subtype":"init","session_id":"s1","model":"gpt-5","tools":["Bash","Read"]}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":3,"output_tokens":4}}}',
      '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,"usage":{"input_tokens":3,"output_tokens":4}}',
    ].join("\n")

    const events = parseCodeBuddyStreamJSON(input)
    expect(events.length).toBe(3)
    expect(events[0]!.type).toBe("system")
    expect(events[0]!.subtype).toBe("init")
    expect(events[1]!.type).toBe("assistant")
    expect(events[2]!.type).toBe("result")
  })

  test("skips blank lines and non-JSON lines", () => {
    const input = [
      "",
      "some non-json output",
      '{"type":"assistant","message":{"content":[{"type":"text","text":"valid"}]}}',
      "",
      "another invalid line",
    ].join("\n")

    const events = parseCodeBuddyStreamJSON(input)
    expect(events.length).toBe(1)
    expect(events[0]!.type).toBe("assistant")
  })

  test("rejects JSON without a type field", () => {
    const input = [
      '{"foo":"bar"}',
      '{"type":"assistant","message":{"content":[]}}',
    ].join("\n")
    const events = parseCodeBuddyStreamJSON(input)
    expect(events.length).toBe(1)
    expect(events[0]!.type).toBe("assistant")
  })

  test("handles empty input", () => {
    expect(parseCodeBuddyStreamJSON("")).toEqual([])
    expect(parseCodeBuddyStreamJSON("\n\n")).toEqual([])
  })
})

describe("codeBuddyEventsToRunResult", () => {
  test("extracts text and tokens from assistant event", () => {
    const events: CodeBuddyEvent[] = [
      {
        type: "assistant",
        message: {
          id: "m1",
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 200 },
        },
      },
    ]

    const result = codeBuddyEventsToRunResult(events, "/tmp/work", 1000)
    expect(result.text).toBe("Hello world")
    expect(result.steps.length).toBe(1)
    expect(result.steps[0]!.role).toBe("assistant")
    expect(result.steps[0]!.text).toBe("Hello world")
    expect(result.tokens.input).toBe(10)
    expect(result.tokens.output).toBe(5)
    expect(result.tokens.cacheWrite).toBe(100)
    expect(result.tokens.cacheRead).toBe(200)
    expect(result.workDir).toBe("/tmp/work")
    expect(result.durationMs).toBe(1000)
    expect(result.runStatus).toBe("ok")
  })

  test("prefers result-event totals over summed assistant usage", () => {
    const events: CodeBuddyEvent[] = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "partial" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        total_cost_usd: 0.025,
        usage: {
          input_tokens: 999,
          output_tokens: 42,
          cache_creation_input_tokens: 7,
          cache_read_input_tokens: 8,
        },
        result: "done",
      },
    ]

    const result = codeBuddyEventsToRunResult(events, "/tmp/work", 500)
    expect(result.tokens.input).toBe(999)
    expect(result.tokens.output).toBe(42)
    expect(result.tokens.cacheWrite).toBe(7)
    expect(result.tokens.cacheRead).toBe(8)
    expect(result.cost).toBeCloseTo(0.025)
    expect(result.text).toBe("done")
  })

  test("falls back to summed assistant usage when result usage is empty", () => {
    const events: CodeBuddyEvent[] = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "first" }],
          usage: { input_tokens: 5, output_tokens: 6 },
        },
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "second" }],
          usage: { input_tokens: 7, output_tokens: 8 },
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        result: "second",
      },
    ]

    const result = codeBuddyEventsToRunResult(events, "/tmp/work", 500)
    expect(result.tokens.input).toBe(12)
    expect(result.tokens.output).toBe(14)
  })

  test("merges tool_use and tool_result events into a single ToolCall", () => {
    const events: CodeBuddyEvent[] = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_01",
              name: "Bash",
              input: { command: "ls -la" },
            },
          ],
          usage: { input_tokens: 5, output_tokens: 5 },
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01",
              content: "file1.txt\nfile2.txt",
            },
          ],
        },
      },
    ]

    const result = codeBuddyEventsToRunResult(events, "/tmp/work", 100)
    expect(result.steps.length).toBe(1)
    expect(result.steps[0]!.role).toBe("assistant")
    expect(result.steps[0]!.toolCalls.length).toBe(1)
    expect(result.steps[0]!.toolCalls[0]!.id).toBe("toolu_01")
    expect(result.steps[0]!.toolCalls[0]!.name).toBe("Bash")
    expect(result.steps[0]!.toolCalls[0]!.input).toEqual({ command: "ls -la" })
    expect(result.steps[0]!.toolCalls[0]!.output).toBe("file1.txt\nfile2.txt")
  })

  test("flags error tool results via exitCode", () => {
    const events: CodeBuddyEvent[] = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_02", name: "Bash", input: { command: "false" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_02", content: "error: command not found", is_error: true },
          ],
        },
      },
    ]

    const result = codeBuddyEventsToRunResult(events, "/tmp/work", 50)
    expect(result.steps[0]!.toolCalls[0]!.exitCode).toBe(1)
    expect(result.steps[0]!.toolCalls[0]!.output).toBe("error: command not found")
  })

  test("handles empty events", () => {
    const result = codeBuddyEventsToRunResult([], "/tmp/work", 0)
    expect(result.text).toBe("")
    expect(result.steps).toEqual([])
    expect(result.tokens.input).toBe(0)
    expect(result.cost).toBe(0)
    expect(result.runStatus).toBe("ok")
    expect(result.statusDetail).toContain("no parseable steps")
  })

  test("ignores init, rate_limit_event, and partial-message events", () => {
    const events: CodeBuddyEvent[] = [
      { type: "system", subtype: "init", model: "gpt-5", tools: ["Bash"] },
      { type: "stream_event", message: { content: [] } },
      { type: "rate_limit_event" } as unknown as CodeBuddyEvent,
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "hi" }], usage: { input_tokens: 1, output_tokens: 1 } },
      },
      { type: "result", subtype: "success", is_error: false, result: "hi", usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    const result = codeBuddyEventsToRunResult(events, "/tmp/work", 100)
    expect(result.text).toBe("hi")
    expect(result.steps.length).toBe(1)
  })

  test("captures result-event errors as adapterError when no steps emitted", () => {
    const events: CodeBuddyEvent[] = [
      {
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Not logged in · Please run /login",
      },
    ]
    const result = codeBuddyEventsToRunResult(events, "/tmp/work", 25)
    expect(result.steps.length).toBe(0)
    expect(result.text).toBe("Not logged in · Please run /login")
    expect(result.adapterError?.stderr).toContain("Not logged in")
  })
})

describe("CodeBuddyAdapter shape", () => {
  test("adapter exposes the canonical name", () => {
    const adapter = new CodeBuddyAdapter()
    expect(adapter.name).toBe("codebuddy")
  })
})

describe("detectSkillInject", () => {
  test("returns true when assistant text echoes the sentinel", () => {
    const events: CodeBuddyEvent[] = [{
      type: "assistant",
      message: { content: [{ type: "text", text: "Got it: <skvm-skill-injected/>" }] },
    }]
    expect(detectSkillInject(events, "irrelevant snippet over twenty chars")).toBe(true)
  })

  test("returns true when assistant text quotes a long-enough skill snippet", () => {
    const snippet = "Detailed instructions about file ops"
    const events: CodeBuddyEvent[] = [{
      type: "assistant",
      message: { content: [{ type: "text", text: `I'll follow these: ${snippet}.` }] },
    }]
    expect(detectSkillInject(events, snippet)).toBe(true)
  })

  test("ignores short snippets to avoid false positives", () => {
    const events: CodeBuddyEvent[] = [{
      type: "assistant",
      message: { content: [{ type: "text", text: "the" }] },
    }]
    expect(detectSkillInject(events, "the")).toBe(false)
  })

  test("returns false when no assistant event mentions the sentinel or snippet", () => {
    const events: CodeBuddyEvent[] = [
      { type: "system", subtype: "init" },
      { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
    ]
    expect(detectSkillInject(events, "a snippet that is definitely not echoed back")).toBe(false)
  })
})

describe("detectSkillDiscover", () => {
  test("returns true when init event lists the skill by exact name", () => {
    const events: CodeBuddyEvent[] = [{
      type: "system",
      subtype: "init",
      skills: ["bench-skill", "another"],
    }]
    expect(detectSkillDiscover(events, "bench-skill")).toBe(true)
  })

  test("returns true when init event lists a namespaced suffix match", () => {
    const events: CodeBuddyEvent[] = [{
      type: "system",
      subtype: "init",
      skills: ["plugin-x:bench-skill"],
    }]
    expect(detectSkillDiscover(events, "bench-skill")).toBe(true)
  })

  test("returns true when assistant calls the Skill tool with matching input", () => {
    const events: CodeBuddyEvent[] = [{
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Skill", input: { name: "bench-skill" } }],
      },
    }]
    expect(detectSkillDiscover(events, "bench-skill")).toBe(true)
  })

  test("returns false when no event references the skill", () => {
    const events: CodeBuddyEvent[] = [
      { type: "system", subtype: "init", skills: ["other-skill"] },
      { type: "assistant", message: { content: [{ type: "text", text: "no tool call" }] } },
    ]
    expect(detectSkillDiscover(events, "bench-skill")).toBe(false)
  })
})
