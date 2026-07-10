import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PiAdapter } from "../../src/adapters/pi.ts"
import {
  parsePiNDJSON,
  piEventsToRunRecord,
  piBuildRunRecordFromNDJSON,
  piBuildRunRecordFromFile,
  renderPiBaseUrlOverride,
  renderPiModelRegistration,
  type PiEvent,
} from "../../src/core/pi-runtime.ts"

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

describe("piEventsToRunRecord", () => {
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

    const result = piEventsToRunRecord(events).finish({ workDir: "/tmp/work", durationMs: 5000 })
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

    const result = piEventsToRunRecord(events).finish({ workDir: "/tmp/work", durationMs: 5000 })
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

    const result = piEventsToRunRecord(events).finish({ workDir: "/tmp/work", durationMs: 1000 })
    expect(result.runStatus).toBe("ok")
    expect(result.adapterError).toBeDefined()
    expect(result.adapterError!.stderr).toContain("rate limit exceeded")
  })

  test("handles empty events", () => {
    const result = piEventsToRunRecord([]).finish({ workDir: "/tmp/work", durationMs: 0 })
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

    const result = piEventsToRunRecord(events).finish({ workDir: "/tmp/work", durationMs: 500 })
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

    const result = piEventsToRunRecord(events).finish({ workDir: "/tmp/work", durationMs: 3000 })
    expect(result.tokens.input).toBe(30)
    expect(result.tokens.output).toBe(15)
    expect(result.tokens.cacheRead).toBe(6)
    expect(result.tokens.cacheWrite).toBe(3)
    expect(result.cost).toBeCloseTo(0.099)
  })
})

describe("piBuildRunRecordFromNDJSON", () => {
  // Helpers to build NDJSON with the streaming-delta noise pi actually emits
  // (message_update / thinking / *_delta make up ~99.9% of a real transcript).
  const assistantMsg = (text: string, stopReason: "stop" | "toolUse" = "stop", usage?: Partial<{ input: number; output: number }>) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai", provider: "openai", model: "gpt-4o",
    usage: { input: usage?.input ?? 1, output: usage?.output ?? 1, cacheRead: 0, cacheWrite: 0, totalTokens: (usage?.input ?? 1) + (usage?.output ?? 1), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: 2000,
  })

  const noiseLines = (n: number): string[] =>
    Array.from({ length: n }, (_, i) =>
      JSON.stringify({ type: "message_update", message: assistantMsg(`partial ${i}`) }),
    )

  test("equivalent to parsePiNDJSON + piEventsToRunRecord on a clean transcript", () => {
    const events: PiEvent[] = [
      { type: "agent_start" },
      { type: "message_end", message: assistantMsg("Hello there!") },
      { type: "agent_end", messages: [assistantMsg("Hello there!")] },
    ]
    const ndjson = events.map((e) => JSON.stringify(e)).join("\n")

    const oldPath = piEventsToRunRecord(parsePiNDJSON(ndjson)).finish({ workDir: "/tmp", durationMs: 100 })
    const newPath = piBuildRunRecordFromNDJSON(ndjson).finish({ workDir: "/tmp", durationMs: 100 })

    expect(newPath.text).toBe(oldPath.text)
    expect(newPath.steps.length).toBe(oldPath.steps.length)
    expect(newPath.tokens).toEqual(oldPath.tokens)
    expect(newPath.runStatus).toBe(oldPath.runStatus)
  })

  test("skips message_update / thinking noise and retains only agent_end", () => {
    // 5,000 streaming-delta lines (the OOM pattern) + 1 real agent_end.
    const lines = [
      '{"type":"session","version":3,"id":"s","timestamp":"t","cwd":"/tmp"}',
      '{"type":"agent_start"}',
      ...noiseLines(5000),
      JSON.stringify({ type: "agent_end", messages: [assistantMsg("final answer", "stop", { input: 7, output: 9 })] }),
    ]
    const ndjson = lines.join("\n")

    const result = piBuildRunRecordFromNDJSON(ndjson).finish({ workDir: "/tmp", durationMs: 100 })
    expect(result.text).toBe("final answer")
    expect(result.steps.length).toBe(1)
    expect(result.tokens.input).toBe(7)
    expect(result.tokens.output).toBe(9)
    expect(result.runStatus).toBe("ok")
  })

  test("falls back to message_end events when agent_end is absent (OOM/killed-task case)", () => {
    // Matches circuit-fibsqrt: no agent_end, only message_end + ~30k deltas.
    const lines = [
      ...noiseLines(3000),
      JSON.stringify({ type: "message_end", message: assistantMsg("partial recovery") }),
    ]
    const ndjson = lines.join("\n")

    const oldPath = piEventsToRunRecord(parsePiNDJSON(ndjson)).finish({ workDir: "/tmp", durationMs: 100 })
    const newPath = piBuildRunRecordFromNDJSON(ndjson).finish({ workDir: "/tmp", durationMs: 100 })
    expect(newPath.text).toBe("partial recovery")
    expect(newPath.steps.length).toBe(1)
    expect(newPath.runStatus).toBe(oldPath.runStatus) // "ok" — message_end fallback yields ok
  })

  test("handles empty / whitespace-only input", () => {
    const r = piBuildRunRecordFromNDJSON("\n\n").finish({ workDir: "/tmp", durationMs: 0 })
    expect(r.text).toBe("")
    expect(r.steps).toEqual([])
    expect(r.runStatus).toBe("parse-failed")
  })

  test("equivalent on tool-call + tool-result transcript with noise", () => {
    const events: PiEvent[] = [
      {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Sure" },
              { type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "ls" } },
            ],
            api: "openai", provider: "openai", model: "gpt-4o",
            usage: { input: 5, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "toolUse", timestamp: 2000,
          },
          {
            role: "toolResult", toolCallId: "tc-1", toolName: "bash",
            content: [{ type: "text", text: "file1" }], isError: false, timestamp: 3000,
          },
          assistantMsg("Done!", "stop", { input: 20, output: 2 }),
        ],
      },
    ]
    const ndjson = [
      ...noiseLines(1000),
      ...events.map((e) => JSON.stringify(e)),
    ].join("\n")

    const oldPath = piEventsToRunRecord(parsePiNDJSON(ndjson)).finish({ workDir: "/tmp", durationMs: 100 })
    const newPath = piBuildRunRecordFromNDJSON(ndjson).finish({ workDir: "/tmp", durationMs: 100 })
    expect(newPath.text).toBe(oldPath.text)
    expect(newPath.steps.length).toBe(oldPath.steps.length)
    expect(newPath.tokens.input).toBe(oldPath.tokens.input)
    expect(newPath.cost).toBeCloseTo(oldPath.cost)
    // Tool call wiring survived the streaming parse
    expect(newPath.steps[0]!.toolCalls[0]!.name).toBe("bash")
    expect(newPath.steps[0]!.toolCalls[0]!.output).toBe("file1")
  })
})

describe("piBuildRunRecordFromFile", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "pi-fromfile-test-"))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  // Shared helpers (mirror of the string-path describe above) so the file
  // path exercises the same fixtures the string path was validated against.
  const assistantMsg = (text: string, stopReason: "stop" | "toolUse" = "stop", usage?: Partial<{ input: number; output: number }>) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai", provider: "openai", model: "gpt-4o",
    usage: { input: usage?.input ?? 1, output: usage?.output ?? 1, cacheRead: 0, cacheWrite: 0, totalTokens: (usage?.input ?? 1) + (usage?.output ?? 1), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: 2000,
  })

  const noiseLines = (n: number): string[] =>
    Array.from({ length: n }, (_, i) =>
      JSON.stringify({ type: "message_update", message: assistantMsg(`partial ${i}`) }),
    )

  test("equivalent to piBuildRunRecordFromNDJSON on identical content", async () => {
    const events: PiEvent[] = [
      { type: "agent_start" },
      { type: "message_end", message: assistantMsg("Hello there!") },
      { type: "agent_end", messages: [assistantMsg("Hello there!")] },
    ]
    const ndjson = events.map((e) => JSON.stringify(e)).join("\n")
    const file = path.join(tmpDir, "clean.ndjson")
    await Bun.write(file, ndjson)

    const fromStr = piBuildRunRecordFromNDJSON(ndjson).finish({ workDir: "/tmp", durationMs: 100 })
    const fromFile = (await piBuildRunRecordFromFile(file)).finish({ workDir: "/tmp", durationMs: 100 })

    expect(fromFile.text).toBe(fromStr.text)
    expect(fromFile.steps.length).toBe(fromStr.steps.length)
    expect(fromFile.tokens).toEqual(fromStr.tokens)
    expect(fromFile.runStatus).toBe(fromStr.runStatus)
  })

  test("skips message_update noise and retains agent_end (5000-line OOM pattern) from file", async () => {
    const lines = [
      '{"type":"session","version":3,"id":"s","timestamp":"t","cwd":"/tmp"}',
      '{"type":"agent_start"}',
      ...noiseLines(5000),
      JSON.stringify({ type: "agent_end", messages: [assistantMsg("final answer", "stop", { input: 7, output: 9 })] }),
    ]
    const file = path.join(tmpDir, "noisy.ndjson")
    await Bun.write(file, lines.join("\n"))

    const result = (await piBuildRunRecordFromFile(file)).finish({ workDir: "/tmp", durationMs: 100 })
    expect(result.text).toBe("final answer")
    expect(result.steps.length).toBe(1)
    expect(result.tokens.input).toBe(7)
    expect(result.tokens.output).toBe(9)
    expect(result.runStatus).toBe("ok")
  })

  test("falls back to message_end when agent_end absent (killed-task case) from file", async () => {
    const lines = [
      ...noiseLines(3000),
      JSON.stringify({ type: "message_end", message: assistantMsg("partial recovery") }),
    ]
    const file = path.join(tmpDir, "killed.ndjson")
    await Bun.write(file, lines.join("\n"))

    const fromStr = piBuildRunRecordFromNDJSON(lines.join("\n")).finish({ workDir: "/tmp", durationMs: 100 })
    const fromFile = (await piBuildRunRecordFromFile(file)).finish({ workDir: "/tmp", durationMs: 100 })

    expect(fromFile.text).toBe("partial recovery")
    expect(fromFile.steps.length).toBe(1)
    expect(fromFile.runStatus).toBe(fromStr.runStatus)
  })

  test("empty file yields parse-failed", async () => {
    const file = path.join(tmpDir, "empty.ndjson")
    await Bun.write(file, "\n\n")

    const r = (await piBuildRunRecordFromFile(file)).finish({ workDir: "/tmp", durationMs: 0 })
    expect(r.text).toBe("")
    expect(r.steps).toEqual([])
    expect(r.runStatus).toBe("parse-failed")
  })

  test("missing file yields parse-failed without throwing", async () => {
    // A lazy-open sink that never received stdout leaves no file on disk.
    // The parser must treat that as an empty/parse-failed record, not crash.
    const file = path.join(tmpDir, "does-not-exist.ndjson")

    const r = (await piBuildRunRecordFromFile(file)).finish({ workDir: "/tmp", durationMs: 0 })
    expect(r.text).toBe("")
    expect(r.steps).toEqual([])
    expect(r.runStatus).toBe("parse-failed")
  })
})

describe("toPiModel", () => {
  test("passes through anthropic and openrouter model ids", async () => {
    const { toPiModel } = await import("../../src/core/pi-runtime.ts")
    const anthropicRoute = { match: "anthropic/*", kind: "anthropic" as const }
    const openrouterRoute = { match: "openrouter/*", kind: "openrouter" as const }
    expect(toPiModel("anthropic/claude-sonnet-4.6", anthropicRoute)).toBe("anthropic/claude-sonnet-4.6")
    expect(toPiModel("openrouter/anthropic/claude-sonnet-4.6", openrouterRoute)).toBe("openrouter/anthropic/claude-sonnet-4.6")
  })

  test("rewrites openai-compatible routes through pi's openai provider", async () => {
    const { toPiModel } = await import("../../src/core/pi-runtime.ts")
    const route = { match: "ipads/*", kind: "openai-compatible" as const, baseUrl: "http://example/v1" }
    expect(toPiModel("ipads/gpt-4o-mini", route)).toBe("openai/gpt-4o-mini")
    expect(toPiModel("corp/claude-haiku", route)).toBe("openai/claude-haiku")
  })
})

describe("renderPiBaseUrlOverride", () => {
  test("emits baseUrl-only override for openai-compatible routes with baseUrl", () => {
    const route = { match: "ipads/*", kind: "openai-compatible" as const, baseUrl: "http://example/v1" }
    const json = renderPiBaseUrlOverride(route)
    expect(json).not.toBeNull()
    expect(JSON.parse(json!)).toEqual({
      providers: {
        openai: { baseUrl: "http://example/v1" },
      },
    })
    // Must NOT register any model id — that would clobber built-in metadata.
    expect(JSON.parse(json!).providers.openai.models).toBeUndefined()
  })

  test("returns null for openrouter routes", () => {
    const route = { match: "openrouter/*", kind: "openrouter" as const }
    expect(renderPiBaseUrlOverride(route)).toBeNull()
  })

  test("returns null for anthropic routes", () => {
    const route = { match: "anthropic/*", kind: "anthropic" as const }
    expect(renderPiBaseUrlOverride(route)).toBeNull()
  })

  test("returns null for openai-compatible routes with no baseUrl", () => {
    const route = { match: "ipads/*", kind: "openai-compatible" as const }
    expect(renderPiBaseUrlOverride(route)).toBeNull()
  })
})

describe("renderPiModelRegistration", () => {
  test("emits openai baseUrl and model registration for openai-compatible routes", () => {
    const route = { match: "ipads/*", kind: "openai-compatible" as const, baseUrl: "http://example/v1" }
    const json = renderPiModelRegistration(route, "gpt-4o-mini")
    expect(JSON.parse(json)).toEqual({
      providers: {
        openai: {
          baseUrl: "http://example/v1",
          models: [{ id: "gpt-4o-mini", api: "openai-completions" }],
        },
      },
    })
  })

  test("registers the exact modelId provided for openai-compatible routes", () => {
    const route = { match: "cheap_ipads/*", kind: "openai-compatible" as const, baseUrl: "http://proxy/v1" }
    const json = renderPiModelRegistration(route, "gpt-5.5")
    expect(JSON.parse(json).providers.openai.models).toEqual([
      { id: "gpt-5.5", api: "openai-completions" },
    ])
  })

  test("omits baseUrl for openai-compatible routes with no baseUrl", () => {
    const route = { match: "ipads/*", kind: "openai-compatible" as const }
    const json = renderPiModelRegistration(route, "gpt-4o")
    const parsed = JSON.parse(json)
    expect(parsed.providers.openai.models).toEqual([{ id: "gpt-4o", api: "openai-completions" }])
    expect(parsed.providers.openai.baseUrl).toBeUndefined()
  })

  test("pins api=openai-completions so pi does not route to the Responses endpoint", () => {
    // Regression guard for the deepseek 404. Pi's built-in `openai` provider
    // defaults custom-registered models to its API (openai-responses, used
    // for real OpenAI). Non-OpenAI openai-compatible backends — DeepSeek,
    // vLLM, OpenAI-proxy frontends — only speak /chat/completions, so
    // without this override pi POSTs to {baseUrl}/responses and gets 404.
    const route = {
      match: "deepseek/*",
      kind: "openai-compatible" as const,
      baseUrl: "https://api.deepseek.com",
    }
    const json = renderPiModelRegistration(route, "deepseek-v4-pro")
    const parsed = JSON.parse(json)
    expect(parsed.providers.openai.models[0].api).toBe("openai-completions")
  })

  test("registers openrouter model under openrouter provider key without baseUrl", () => {
    const route = { match: "openrouter/*", kind: "openrouter" as const }
    const json = renderPiModelRegistration(route, "qwen/qwen3-30b")
    expect(JSON.parse(json)).toEqual({
      providers: {
        openrouter: {
          models: [{ id: "qwen/qwen3-30b" }],
        },
      },
    })
  })

  test("registers anthropic model under anthropic provider key without baseUrl", () => {
    const route = { match: "anthropic/*", kind: "anthropic" as const }
    const json = renderPiModelRegistration(route, "claude-sonnet-4.6")
    expect(JSON.parse(json)).toEqual({
      providers: {
        anthropic: {
          models: [{ id: "claude-sonnet-4.6" }],
        },
      },
    })
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
