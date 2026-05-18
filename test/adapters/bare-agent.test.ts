import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BareAgentAdapter } from "../../src/adapters/bare-agent.ts"
import type { LLMProvider, LLMResponse, CompletionParams, LLMToolResult } from "../../src/providers/types.ts"
import type { AdapterConfig } from "../../src/core/types.ts"

let workDir: string

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "skvm-bare-test-"))
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

function createSequenceProvider(responses: LLMResponse[]): LLMProvider {
  let callIndex = 0
  return {
    name: "mock-sequence",
    async complete(_params: CompletionParams): Promise<LLMResponse> {
      return responses[callIndex++]!
    },
    async completeWithToolResults(
      _params: CompletionParams,
      _toolResults: LLMToolResult[],
      _prev: LLMResponse,
    ): Promise<LLMResponse> {
      return responses[callIndex++]!
    },
  }
}

describe("BareAgentAdapter", () => {
  test("handles text-only response (no tool calls)", async () => {
    const provider = createSequenceProvider([
      {
        text: "Hello! The answer is 42.",
        toolCalls: [],
        tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
        durationMs: 0,
        stopReason: "end_turn",
      },
    ])

    const adapter = new BareAgentAdapter(() => provider)
    await adapter.setup({ model: "test", maxSteps: 30, timeoutMs: 120_000 })

    const result = await adapter.run({ prompt: "What is the answer?", workDir })

    expect(result.text).toBe("Hello! The answer is 42.")
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]!.role).toBe("assistant")
    expect(result.tokens.input).toBe(10)
    expect(result.tokens.output).toBe(20)
  })

  test("executes write_file tool call", async () => {
    const provider = createSequenceProvider([
      // First response: write_file tool call
      {
        text: "",
        toolCalls: [{
          id: "tc_1",
          name: "write_file",
          arguments: { path: "output.txt", content: "hello world" },
        }],
        tokens: { input: 10, output: 15, cacheRead: 0, cacheWrite: 0 },
        durationMs: 0,
        stopReason: "tool_use",
      },
      // After tool result: final text
      {
        text: "I wrote the file.",
        toolCalls: [],
        tokens: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 },
        durationMs: 0,
        stopReason: "end_turn",
      },
    ])

    const adapter = new BareAgentAdapter(() => provider)
    await adapter.setup({ model: "test", maxSteps: 30, timeoutMs: 120_000 })

    const result = await adapter.run({ prompt: "Write hello to output.txt", workDir })

    expect(result.text).toBe("I wrote the file.")
    expect(result.steps).toHaveLength(3) // assistant + tool + assistant

    // Verify file was actually written
    const content = await Bun.file(path.join(workDir, "output.txt")).text()
    expect(content).toBe("hello world")

    // Verify token accumulation
    expect(result.tokens.input).toBe(30)
    expect(result.tokens.output).toBe(25)
  })

  test("executes read_file tool call", async () => {
    await Bun.write(path.join(workDir, "data.txt"), "line1\nline2\nline3")

    const provider = createSequenceProvider([
      {
        text: "",
        toolCalls: [{
          id: "tc_1",
          name: "read_file",
          arguments: { path: "data.txt" },
        }],
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        durationMs: 0,
        stopReason: "tool_use",
      },
      {
        text: "The file has 3 lines.",
        toolCalls: [],
        tokens: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 },
        durationMs: 0,
        stopReason: "end_turn",
      },
    ])

    const adapter = new BareAgentAdapter(() => provider)
    await adapter.setup({ model: "test", maxSteps: 30, timeoutMs: 120_000 })

    const result = await adapter.run({ prompt: "Read data.txt", workDir })

    // Check the tool step captured the file content
    const toolStep = result.steps.find((s) => s.role === "tool")
    expect(toolStep).toBeDefined()
    expect(toolStep!.toolCalls[0]!.output).toContain("line1")
  })

  test("executes execute_command tool call", async () => {
    const provider = createSequenceProvider([
      {
        text: "",
        toolCalls: [{
          id: "tc_1",
          name: "execute_command",
          arguments: { command: "echo hello" },
        }],
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        durationMs: 0,
        stopReason: "tool_use",
      },
      {
        text: "Done",
        toolCalls: [],
        tokens: { input: 20, output: 3, cacheRead: 0, cacheWrite: 0 },
        durationMs: 0,
        stopReason: "end_turn",
      },
    ])

    const adapter = new BareAgentAdapter(() => provider)
    await adapter.setup({ model: "test", maxSteps: 30, timeoutMs: 120_000 })

    const result = await adapter.run({ prompt: "Run echo hello", workDir })

    const toolStep = result.steps.find((s) => s.role === "tool")
    expect(toolStep!.toolCalls[0]!.output).toContain("hello")
    expect(toolStep!.toolCalls[0]!.exitCode).toBe(0)
  })

  test("executes list_directory tool call", async () => {
    await Bun.write(path.join(workDir, "a.txt"), "a")
    await Bun.write(path.join(workDir, "b.txt"), "b")

    const provider = createSequenceProvider([
      {
        text: "",
        toolCalls: [{
          id: "tc_1",
          name: "list_directory",
          arguments: { path: "." },
        }],
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        durationMs: 0,
        stopReason: "tool_use",
      },
      {
        text: "There are 2 files.",
        toolCalls: [],
        tokens: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
        durationMs: 0,
        stopReason: "end_turn",
      },
    ])

    const adapter = new BareAgentAdapter(() => provider)
    await adapter.setup({ model: "test", maxSteps: 30, timeoutMs: 120_000 })

    const result = await adapter.run({ prompt: "List files", workDir })

    const toolStep = result.steps.find((s) => s.role === "tool")
    expect(toolStep!.toolCalls[0]!.output).toContain("a.txt")
    expect(toolStep!.toolCalls[0]!.output).toContain("b.txt")
  })

  test("multi-turn conversation (3 turns)", async () => {
    const provider = createSequenceProvider([
      // Turn 1: write file
      {
        text: "",
        toolCalls: [{ id: "tc_1", name: "write_file", arguments: { path: "out.txt", content: "42" } }],
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        durationMs: 0,
        stopReason: "tool_use",
      },
      // Turn 2: read file back
      {
        text: "",
        toolCalls: [{ id: "tc_2", name: "read_file", arguments: { path: "out.txt" } }],
        tokens: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
        durationMs: 0,
        stopReason: "tool_use",
      },
      // Turn 3: done
      {
        text: "File contains 42.",
        toolCalls: [],
        tokens: { input: 30, output: 10, cacheRead: 0, cacheWrite: 0 },
        durationMs: 0,
        stopReason: "end_turn",
      },
    ])

    const adapter = new BareAgentAdapter(() => provider)
    await adapter.setup({ model: "test", maxSteps: 30, timeoutMs: 120_000 })

    const result = await adapter.run({ prompt: "Write 42 to out.txt then read it back", workDir })

    expect(result.text).toBe("File contains 42.")
    // Steps: assistant(write) + tool(write result) + assistant(read) + tool(read result) + assistant(done)
    expect(result.steps).toHaveLength(5)
  })

  test("stops at maxSteps", async () => {
    // Provider always returns a tool call, never ends
    const infiniteProvider: LLMProvider = {
      name: "infinite",
      async complete(): Promise<LLMResponse> {
        return {
          text: "",
          toolCalls: [{ id: `tc_${Date.now()}`, name: "execute_command", arguments: { command: "echo loop" } }],
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          durationMs: 0,
        stopReason: "tool_use",
        }
      },
      async completeWithToolResults(): Promise<LLMResponse> {
        return {
          text: "",
          toolCalls: [{ id: `tc_${Date.now()}`, name: "execute_command", arguments: { command: "echo loop" } }],
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          durationMs: 0,
        stopReason: "tool_use",
        }
      },
    }

    const adapter = new BareAgentAdapter(() => infiniteProvider)
    await adapter.setup({ model: "test", maxSteps: 3, timeoutMs: 120_000 })

    const result = await adapter.run({ prompt: "Loop forever", workDir })

    // Should have stopped after 3 iterations
    const assistantSteps = result.steps.filter((s) => s.role === "assistant")
    expect(assistantSteps.length).toBeLessThanOrEqual(3)
  })

  test("handles skill content injection", async () => {
    let capturedSystem = ""
    const provider: LLMProvider = {
      name: "capture",
      async complete(params: CompletionParams): Promise<LLMResponse> {
        capturedSystem = params.system ?? ""
        return {
          text: "Done",
          toolCalls: [],
          tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          durationMs: 0,
        stopReason: "end_turn",
        }
      },
      async completeWithToolResults(): Promise<LLMResponse> {
        throw new Error("not needed")
      },
    }

    const adapter = new BareAgentAdapter(() => provider)
    await adapter.setup({ model: "test", maxSteps: 30, timeoutMs: 120_000 })

    await adapter.run({
      prompt: "Do task",
      workDir,
      skill: { content: "# My Skill\nDo things carefully.", mode: "inject", meta: { name: "my-skill", description: "demo" } },
    })

    expect(capturedSystem).toContain("<skill>")
    expect(capturedSystem).toContain("# My Skill")
    expect(capturedSystem).toContain("Do things carefully.")
  })

  // ---------------------------------------------------------------------------
  // Skill Loading Modes
  // ---------------------------------------------------------------------------

  describe("inject mode", () => {
    test("injects skill into system prompt and sets skillLoaded=true", async () => {
      let capturedSystem = ""
      const provider: LLMProvider = {
        name: "capture",
        async complete(params: CompletionParams): Promise<LLMResponse> {
          capturedSystem = params.system ?? ""
          return {
            text: "Done",
            toolCalls: [],
            tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
            durationMs: 0,
            stopReason: "end_turn",
          }
        },
        async completeWithToolResults(): Promise<LLMResponse> {
          throw new Error("not needed")
        },
      }

      const adapter = new BareAgentAdapter(() => provider)
      await adapter.setup({ model: "test", maxSteps: 30, timeoutMs: 120_000 })

      const result = await adapter.run({
        prompt: "Do task",
        workDir,
        skill: { content: "# File Ops\nUse structured approach.", mode: "inject", meta: { name: "file-ops", description: "File operations skill" } },
      })

      expect(capturedSystem).toContain("<skill>")
      expect(capturedSystem).toContain("# File Ops")
      expect(capturedSystem).not.toContain("Available Skills")
      expect(result.skillLoaded).toBe(true)
    })

    test("defaults to inject when skillMode is undefined", async () => {
      let capturedSystem = ""
      const provider: LLMProvider = {
        name: "capture",
        async complete(params: CompletionParams): Promise<LLMResponse> {
          capturedSystem = params.system ?? ""
          return {
            text: "Done",
            toolCalls: [],
            tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
            durationMs: 0,
            stopReason: "end_turn",
          }
        },
        async completeWithToolResults(): Promise<LLMResponse> {
          throw new Error("not needed")
        },
      }

      const adapter = new BareAgentAdapter(() => provider)
      await adapter.setup({ model: "test", maxSteps: 30, timeoutMs: 120_000 })

      const result = await adapter.run({
        prompt: "Do task",
        workDir,
        skill: { content: "My skill content", mode: "inject", meta: { name: "test-skill", description: "test" } },
      })

      expect(capturedSystem).toContain("<skill>")
      expect(result.skillLoaded).toBe(true)
    })
  })

  describe("discover mode", () => {
    test("lists skill in prompt and loads on request", async () => {
      let capturedSystem = ""
      const provider: LLMProvider = {
        name: "discover-mock",
        async complete(params: CompletionParams): Promise<LLMResponse> {
          capturedSystem = params.system ?? ""
          return {
            text: "<load-skill>file-ops</load-skill>",
            toolCalls: [],
            tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
            durationMs: 0,
            stopReason: "end_turn",
          }
        },
        async completeWithToolResults(): Promise<LLMResponse> {
          throw new Error("not needed")
        },
      }

      const adapter = new BareAgentAdapter(() => provider)
      await adapter.setup({ model: "test", maxSteps: 30, timeoutMs: 120_000 })

      const result = await adapter.run({
        prompt: "Do task",
        workDir,
        skill: { content: "# File Ops Skill\nDetailed instructions here.", mode: "discover", meta: { name: "file-ops", description: "File operations skill" } },
      })

      // System prompt should list the skill but not embed its content.
      expect(capturedSystem).toContain("Available Skills")
      expect(capturedSystem).toContain("file-ops")
      expect(capturedSystem).toContain("File operations skill")
      expect(capturedSystem).not.toContain("<skill>")

      // skillLoaded flips to true as soon as the agent emits the correct <load-skill> marker.
      expect(result.skillLoaded).toBe(true)

      // Skill dir is materialized in workDir at setup time so the agent can read it via tools.
      const skillFile = Bun.file(path.join(workDir, "skills", "file-ops", "SKILL.md"))
      expect(await skillFile.exists()).toBe(true)
    })

    test("skillLoaded=false when agent never requests skill", async () => {
      const provider = createSequenceProvider([
        {
          text: "Done without skill.",
          toolCalls: [],
          tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          durationMs: 0,
          stopReason: "end_turn",
        },
      ])

      const adapter = new BareAgentAdapter(() => provider)
      await adapter.setup({ model: "test", maxSteps: 30, timeoutMs: 120_000 })

      const result = await adapter.run({
        prompt: "Do task",
        workDir,
        skill: { content: "# File Ops\nInstructions.", mode: "discover", meta: { name: "file-ops", description: "File operations" } },
      })

      expect(result.skillLoaded).toBe(false)
    })

    test("wrong skill name is silently ignored", async () => {
      const provider = createSequenceProvider([
        {
          text: "<load-skill>wrong-name</load-skill>",
          toolCalls: [],
          tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          durationMs: 0,
          stopReason: "end_turn",
        },
      ])

      const adapter = new BareAgentAdapter(() => provider)
      await adapter.setup({ model: "test", maxSteps: 30, timeoutMs: 120_000 })

      const result = await adapter.run({
        prompt: "Do task",
        workDir,
        skill: { content: "# File Ops\nInstructions.", mode: "discover", meta: { name: "file-ops", description: "File operations" } },
      })

      expect(result.skillLoaded).toBe(false)
    })
  })

  test("skillLoaded is undefined when no skill content provided", async () => {
    const provider = createSequenceProvider([
      {
        text: "Done",
        toolCalls: [],
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        durationMs: 0,
        stopReason: "end_turn",
      },
    ])

    const adapter = new BareAgentAdapter(() => provider)
    await adapter.setup({ model: "test", maxSteps: 30, timeoutMs: 120_000 })

    const result = await adapter.run({ prompt: "Do task", workDir })
    expect(result.skillLoaded).toBeUndefined()
  })
})
