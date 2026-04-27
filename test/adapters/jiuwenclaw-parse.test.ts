import { describe, expect, test } from "bun:test"
import { parseJiuwenClawHistory } from "../../src/adapters/jiuwenclaw.ts"

describe("parseJiuwenClawHistory", () => {
  test("sums tokens and cost from chat.usage_metadata records", () => {
    const records = [
      {
        id: "r1:assistant",
        role: "assistant" as const,
        request_id: "r1",
        channel_id: "acp",
        timestamp: 1.0,
        content: "",
        event_type: "chat.usage_metadata",
        metadata: {
          usage_metadata: {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
            input_cost: 0.001,
            output_cost: 0.002,
            total_cost: 0.003,
          },
        },
      },
      {
        id: "r1:assistant",
        role: "assistant" as const,
        request_id: "r1",
        channel_id: "acp",
        timestamp: 2.0,
        content: "",
        event_type: "chat.usage_metadata",
        metadata: {
          usage_metadata: {
            input_tokens: 200,
            output_tokens: 80,
            total_tokens: 280,
            input_cost: 0.002,
            output_cost: 0.003,
            total_cost: 0.005,
          },
        },
      },
    ]
    const result = parseJiuwenClawHistory(records, "/tmp/wd", 1234)
    expect(result.tokens.input).toBe(300)
    expect(result.tokens.output).toBe(130)
    expect(result.cost).toBeCloseTo(0.008, 6)
  })

  test("populates steps from chat.tool_call and chat.tool_result", () => {
    const records = [
      {
        id: "r:assistant",
        role: "assistant" as const,
        request_id: "r",
        channel_id: "acp",
        timestamp: 1.0,
        content: "",
        event_type: "chat.tool_call",
        tool_call: {
          name: "bash",
          arguments: '{"command": "ls"}',
          tool_call_id: "call_1",
        },
      },
      {
        id: "r:assistant",
        role: "assistant" as const,
        request_id: "r",
        channel_id: "acp",
        timestamp: 2.0,
        content: "",
        event_type: "chat.tool_result",
        result: "file1\nfile2",
        tool_name: "bash",
        tool_call_id: "call_1",
      },
    ]
    const result = parseJiuwenClawHistory(records, "/tmp/wd", 100)
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0]!.toolCalls[0]!.name).toBe("bash")
    expect(result.steps[0]!.toolCalls[0]!.input).toEqual({ command: "ls" })
    expect(result.steps[1]!.toolCalls[0]!.output).toBe("file1\nfile2")
  })

  test("captures chat.final content as text", () => {
    const records = [
      {
        id: "r:assistant",
        role: "assistant" as const,
        request_id: "r",
        channel_id: "acp",
        timestamp: 1.0,
        content: "All done.",
        event_type: "chat.final",
      },
    ]
    const result = parseJiuwenClawHistory(records, "/tmp/wd", 100)
    expect(result.text).toBe("All done.")
  })

  test("falls back to last assistant content when no chat.final", () => {
    const records = [
      {
        id: "r:assistant",
        role: "assistant" as const,
        request_id: "r",
        channel_id: "acp",
        timestamp: 1.0,
        content: "intermediate",
        event_type: "chat.delta",
      },
    ]
    const result = parseJiuwenClawHistory(records, "/tmp/wd", 100)
    expect(result.text).toBe("intermediate")
  })

  test("ignores chat.usage_summary (per-call records are authoritative)", () => {
    const records = [
      {
        id: "r:assistant",
        role: "assistant" as const,
        request_id: "r",
        channel_id: "acp",
        timestamp: 1.0,
        content: "",
        event_type: "chat.usage_metadata",
        metadata: {
          usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      },
      {
        id: "r:assistant",
        role: "assistant" as const,
        request_id: "r",
        channel_id: "acp",
        timestamp: 2.0,
        content: "",
        event_type: "chat.usage_summary",
        // upstream summary lives at top-level under "usage" — would double-count if not skipped
      },
    ]
    const result = parseJiuwenClawHistory(records, "/tmp/wd", 100)
    expect(result.tokens.input).toBe(10)
    expect(result.tokens.output).toBe(5)
  })

  test("ignores chat.delta and chat.tool_update noise", () => {
    const records = [
      { id: "r:assistant", role: "assistant" as const, request_id: "r", channel_id: "acp", timestamp: 1.0, content: "I", event_type: "chat.delta" },
      { id: "r:assistant", role: "assistant" as const, request_id: "r", channel_id: "acp", timestamp: 1.1, content: "'ll", event_type: "chat.delta" },
      { id: "r:assistant", role: "assistant" as const, request_id: "r", channel_id: "acp", timestamp: 1.2, content: "", event_type: "chat.tool_update", tool_name: "bash", tool_call_id: "x", arguments: "{}" },
      { id: "r:assistant", role: "assistant" as const, request_id: "r", channel_id: "acp", timestamp: 2.0, content: "Done.", event_type: "chat.final" },
    ]
    const result = parseJiuwenClawHistory(records, "/tmp/wd", 100)
    expect(result.steps).toHaveLength(1)
    expect(result.text).toBe("Done.")
  })

  test("malformed tool_call.arguments JSON does not blow up", () => {
    const records = [
      {
        id: "r:assistant",
        role: "assistant" as const,
        request_id: "r",
        channel_id: "acp",
        timestamp: 1.0,
        content: "",
        event_type: "chat.tool_call",
        tool_call: { name: "bash", arguments: "{not valid json", tool_call_id: "x" },
      },
    ]
    const result = parseJiuwenClawHistory(records, "/tmp/wd", 100)
    expect(result.steps[0]!.toolCalls[0]!.input).toEqual({})
  })

  test("user role records are skipped", () => {
    const records = [
      { id: "r:user", role: "user" as const, request_id: "r", channel_id: "acp", timestamp: 1.0, content: "hi" },
      { id: "r:assistant", role: "assistant" as const, request_id: "r", channel_id: "acp", timestamp: 2.0, content: "hello", event_type: "chat.final" },
    ]
    const result = parseJiuwenClawHistory(records, "/tmp/wd", 100)
    expect(result.text).toBe("hello")
  })

  test("skips usage when input_tokens is missing", () => {
    const records = [
      {
        id: "r:assistant",
        role: "assistant" as const,
        request_id: "r",
        channel_id: "acp",
        timestamp: 1.0,
        content: "",
        event_type: "chat.usage_metadata",
        metadata: { usage_metadata: {} },
      },
    ]
    const result = parseJiuwenClawHistory(records, "/tmp/wd", 100)
    expect(result.tokens.input).toBe(0)
    expect(result.tokens.output).toBe(0)
    expect(result.cost).toBe(0)
  })
})
