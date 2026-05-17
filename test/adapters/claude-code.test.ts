import { test, expect, describe } from "bun:test"
import { tmpdir } from "node:os"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import {
  parseClaudeCodeStreamJSON,
  eventsToRunResult,
  ClaudeCodeAdapter,
  toClaudeCodeModelId,
  detectSkillProvided_Discover,
  detectSkillObserved_Discover,
  buildClaudeCodeInjectArtifacts,
  buildClaudeCodeDiscoverArtifacts,
  type ClaudeCodeEvent,
} from "../../src/adapters/claude-code.ts"

describe("parseClaudeCodeStreamJSON", () => {
  test("parses valid stream-json lines", () => {
    const input = [
      '{"type":"system","subtype":"init","session_id":"s1","model":"claude-sonnet-4-6","tools":["Bash","Read"]}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":3,"output_tokens":4}}}',
      '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,"usage":{"input_tokens":3,"output_tokens":4}}',
    ].join("\n")

    const events = parseClaudeCodeStreamJSON(input)
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

    const events = parseClaudeCodeStreamJSON(input)
    expect(events.length).toBe(1)
    expect(events[0]!.type).toBe("assistant")
  })

  test("rejects JSON without a type field", () => {
    const input = [
      '{"foo":"bar"}',
      '{"type":"assistant","message":{"content":[]}}',
    ].join("\n")
    const events = parseClaudeCodeStreamJSON(input)
    expect(events.length).toBe(1)
    expect(events[0]!.type).toBe("assistant")
  })

  test("handles empty input", () => {
    expect(parseClaudeCodeStreamJSON("")).toEqual([])
    expect(parseClaudeCodeStreamJSON("\n\n")).toEqual([])
  })
})

describe("eventsToRunResult", () => {
  test("extracts text and tokens from assistant event", () => {
    const events: ClaudeCodeEvent[] = [
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

    const result = eventsToRunResult(events, "/tmp/work", 1000)
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
    const events: ClaudeCodeEvent[] = [
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

    const result = eventsToRunResult(events, "/tmp/work", 500)
    expect(result.tokens.input).toBe(999)
    expect(result.tokens.output).toBe(42)
    expect(result.tokens.cacheWrite).toBe(7)
    expect(result.tokens.cacheRead).toBe(8)
    expect(result.cost).toBeCloseTo(0.025)
    expect(result.text).toBe("done")
  })

  test("falls back to summed assistant usage when result usage is empty", () => {
    const events: ClaudeCodeEvent[] = [
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

    const result = eventsToRunResult(events, "/tmp/work", 500)
    expect(result.tokens.input).toBe(12)
    expect(result.tokens.output).toBe(14)
  })

  test("merges tool_use and tool_result events into a single ToolCall", () => {
    const events: ClaudeCodeEvent[] = [
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

    const result = eventsToRunResult(events, "/tmp/work", 100)
    expect(result.steps.length).toBe(1)
    expect(result.steps[0]!.role).toBe("assistant")
    expect(result.steps[0]!.toolCalls.length).toBe(1)
    expect(result.steps[0]!.toolCalls[0]!.id).toBe("toolu_01")
    expect(result.steps[0]!.toolCalls[0]!.name).toBe("Bash")
    expect(result.steps[0]!.toolCalls[0]!.input).toEqual({ command: "ls -la" })
    expect(result.steps[0]!.toolCalls[0]!.output).toBe("file1.txt\nfile2.txt")
  })

  test("flags error tool results via exitCode", () => {
    const events: ClaudeCodeEvent[] = [
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

    const result = eventsToRunResult(events, "/tmp/work", 50)
    expect(result.steps[0]!.toolCalls[0]!.exitCode).toBe(1)
    expect(result.steps[0]!.toolCalls[0]!.output).toBe("error: command not found")
  })

  test("handles empty events", () => {
    const result = eventsToRunResult([], "/tmp/work", 0)
    expect(result.text).toBe("")
    expect(result.steps).toEqual([])
    expect(result.tokens.input).toBe(0)
    expect(result.cost).toBe(0)
    expect(result.runStatus).toBe("ok")
    expect(result.statusDetail).toContain("no parseable steps")
  })

  test("ignores init, rate_limit_event, and partial-message events", () => {
    const events: ClaudeCodeEvent[] = [
      { type: "system", subtype: "init", model: "claude-sonnet-4-6", tools: ["Bash"] },
      { type: "stream_event", message: { content: [] } },
      { type: "rate_limit_event" } as unknown as ClaudeCodeEvent,
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "hi" }], usage: { input_tokens: 1, output_tokens: 1 } },
      },
      { type: "result", subtype: "success", is_error: false, result: "hi", usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    const result = eventsToRunResult(events, "/tmp/work", 100)
    expect(result.text).toBe("hi")
    expect(result.steps.length).toBe(1)
  })

  test("captures result-event errors as adapterError when no steps emitted", () => {
    const events: ClaudeCodeEvent[] = [
      {
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Not logged in · Please run /login",
      },
    ]
    const result = eventsToRunResult(events, "/tmp/work", 25)
    expect(result.steps.length).toBe(0)
    expect(result.text).toBe("Not logged in · Please run /login")
    expect(result.adapterError?.stderr).toContain("Not logged in")
  })
})

describe("toClaudeCodeModelId", () => {
  test("converts dot to dash for known anthropic ids", () => {
    expect(toClaudeCodeModelId("claude-sonnet-4.6")).toBe("claude-sonnet-4-6")
    expect(toClaudeCodeModelId("claude-opus-4.7")).toBe("claude-opus-4-7")
    expect(toClaudeCodeModelId("claude-haiku-4.5")).toBe("claude-haiku-4-5")
  })

  test("passes through aliases unchanged", () => {
    expect(toClaudeCodeModelId("sonnet")).toBe("sonnet")
    expect(toClaudeCodeModelId("opus")).toBe("opus")
  })

  test("passes through dash-form ids unchanged", () => {
    expect(toClaudeCodeModelId("claude-sonnet-4-6")).toBe("claude-sonnet-4-6")
  })

  test("only rewrites the version suffix, not other dots in the id", () => {
    expect(toClaudeCodeModelId("custom-model-1.2.3")).toBe("custom-model-1.2.3")
  })
})

describe("ClaudeCodeAdapter shape", () => {
  test("adapter exposes the canonical name", () => {
    const adapter = new ClaudeCodeAdapter()
    expect(adapter.name).toBe("claude-code")
  })
})

describe("detectSkillProvided_Discover (init-event signal)", () => {
  test("returns true when init event lists the skill", () => {
    const events: ClaudeCodeEvent[] = [
      { type: "system", subtype: "init", skills: ["bench-skill", "other-skill"] },
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
    ]
    expect(detectSkillProvided_Discover(events, "bench-skill")).toBe(true)
  })

  test("tolerates plugin-namespaced skill names (e.g. 'pkg:bench-skill')", () => {
    const events: ClaudeCodeEvent[] = [
      { type: "system", subtype: "init", skills: ["some-plugin:bench-skill"] },
    ]
    expect(detectSkillProvided_Discover(events, "bench-skill")).toBe(true)
  })

  test("returns false when init event lists no matching skill", () => {
    const events: ClaudeCodeEvent[] = [
      { type: "system", subtype: "init", skills: ["other-skill"] },
    ]
    expect(detectSkillProvided_Discover(events, "bench-skill")).toBe(false)
  })

  test("returns false when there is no init event at all (e.g. crash before init)", () => {
    const events: ClaudeCodeEvent[] = [
      { type: "result", is_error: true, result: "binary not found" },
    ]
    expect(detectSkillProvided_Discover(events, "bench-skill")).toBe(false)
  })
})

describe("detectSkillObserved_Discover (Skill tool-use signal)", () => {
  test("returns true when assistant calls Skill tool with matching name", () => {
    const events: ClaudeCodeEvent[] = [
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Skill", input: { name: "bench-skill" } }],
        },
      },
    ]
    expect(detectSkillObserved_Discover(events, "bench-skill")).toBe(true)
  })

  test("accepts lowercase `skill` tool name", () => {
    const events: ClaudeCodeEvent[] = [
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t1", name: "skill", input: { skill: "bench-skill" } }],
        },
      },
    ]
    expect(detectSkillObserved_Discover(events, "bench-skill")).toBe(true)
  })

  test("returns false when Skill tool is called with a different name", () => {
    const events: ClaudeCodeEvent[] = [
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Skill", input: { name: "other-skill" } }],
        },
      },
    ]
    expect(detectSkillObserved_Discover(events, "bench-skill")).toBe(false)
  })

  test("returns false when no Skill tool is called", () => {
    const events: ClaudeCodeEvent[] = [
      { type: "assistant", message: { content: [{ type: "text", text: "thinking..." }] } },
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } }] },
      },
    ]
    expect(detectSkillObserved_Discover(events, "bench-skill")).toBe(false)
  })
})

describe("claude-code inject mode uses CC's native skill system", () => {
  test("inject artifacts: writes .claude/skills/<name>/SKILL.md with frontmatter + MUST directive", async () => {
    const tmpWork = await mkdtemp(path.join(tmpdir(), "skvm-cc-inject-"))
    try {
      const built = await buildClaudeCodeInjectArtifacts({
        workDir: tmpWork,
        skillContent: "# Test skill\n\nDo the thing.",
        skillMeta: { name: "bench-skill", description: "test skill" },
      })
      const skillFile = path.join(tmpWork, ".claude", "skills", "bench-skill", "SKILL.md")
      expect(await Bun.file(skillFile).exists()).toBe(true)
      const content = await Bun.file(skillFile).text()
      expect(content).toContain("name: bench-skill")
      expect(content).toContain("description: test skill")
      expect(content).toContain("Do the thing.")

      expect(built.appendSystemPrompt).toBeDefined()
      expect(built.appendSystemPrompt!).toContain("You MUST invoke the Skill tool")
      expect(built.appendSystemPrompt!).toContain('name="bench-skill"')
    } finally {
      await rm(tmpWork, { recursive: true, force: true })
    }
  })

  test("discover artifacts: writes the skill file WITHOUT a force directive", async () => {
    const tmpWork = await mkdtemp(path.join(tmpdir(), "skvm-cc-disc-"))
    try {
      const built = await buildClaudeCodeDiscoverArtifacts({
        workDir: tmpWork,
        skillContent: "# Test skill\n\nDo the thing.",
        skillMeta: { name: "bench-skill", description: "test skill" },
      })
      const skillFile = path.join(tmpWork, ".claude", "skills", "bench-skill", "SKILL.md")
      expect(await Bun.file(skillFile).exists()).toBe(true)
      // Discover returns no appendSystemPrompt — the field is undefined in the return.
      expect((built as { appendSystemPrompt?: string }).appendSystemPrompt).toBeUndefined()
    } finally {
      await rm(tmpWork, { recursive: true, force: true })
    }
  })

  test("thinking-mode-safe: skillProvided=true even when model never echoes content", () => {
    // The init event is our structural signal — it does not depend on model
    // behavior. Simulate a thinking-mode run where the assistant produces
    // no visible text echoing the skill, but CC's init event lists it.
    const events: ClaudeCodeEvent[] = [
      { type: "system", subtype: "init", skills: ["bench-skill"], tools: ["Skill", "Bash"] },
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Skill", input: { name: "bench-skill" } }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      { type: "result", is_error: false, total_cost_usd: 0.001, usage: { input_tokens: 10, output_tokens: 5 } },
    ]
    expect(detectSkillProvided_Discover(events, "bench-skill")).toBe(true)
    expect(detectSkillObserved_Discover(events, "bench-skill")).toBe(true)
  })

  test("inject without model engagement: skillProvided=true (init), skillObserved=false (no Skill tool call)", () => {
    const events: ClaudeCodeEvent[] = [
      { type: "system", subtype: "init", skills: ["bench-skill"] },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "done." }], usage: { input_tokens: 5, output_tokens: 2 } },
      },
      { type: "result", is_error: false, total_cost_usd: 0.001 },
    ]
    expect(detectSkillProvided_Discover(events, "bench-skill")).toBe(true)
    expect(detectSkillObserved_Discover(events, "bench-skill")).toBe(false)
  })
})

