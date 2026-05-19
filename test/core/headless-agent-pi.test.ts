import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from "bun:test"
import path from "node:path"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"

// ---------------------------------------------------------------------------
// Mock @mariozechner/pi-coding-agent at the package level. The stubs below
// record what skvm passes them so the test can assert wiring is correct.
// ---------------------------------------------------------------------------

let lastCreateOpts: any = null
let lastSubscribe: ((e: any) => void) | null = null
let lastPromptText: string | null = null
let promptDelayMs = 0
let abortCalled = false
let promptShouldError = false

mock.module("@mariozechner/pi-coding-agent", () => {
  return {
    createAgentSession: async (opts: any) => {
      lastCreateOpts = opts
      return {
        session: {
          subscribe: (listener: (e: any) => void) => {
            lastSubscribe = listener
            return () => { /* unsubscribe */ }
          },
          prompt: async (text: string) => {
            lastPromptText = text
            if (promptDelayMs > 0) {
              await new Promise(r => setTimeout(r, promptDelayMs))
            }
            // Emit a synthetic agent_end so piEventsToRunResult has data.
            if (promptShouldError) {
              lastSubscribe?.({
                type: "agent_end",
                messages: [{
                  role: "assistant",
                  content: [{ type: "text", text: "" }],
                  api: "openai", provider: "openai", model: "gpt-4o-mini",
                  usage: {
                    input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                  },
                  stopReason: "error",
                  errorMessage: "fake provider 5xx",
                  timestamp: Date.now(),
                }],
              })
            } else {
              lastSubscribe?.({
                type: "agent_end",
                messages: [{
                  role: "assistant",
                  content: [{ type: "text", text: "done" }],
                  api: "openai", provider: "openai", model: "gpt-4o-mini",
                  usage: {
                    input: 10, output: 20, cacheRead: 0, cacheWrite: 0,
                    totalTokens: 30,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0042 },
                  },
                  stopReason: "stop",
                  timestamp: Date.now(),
                }],
              })
            }
          },
          abort: async () => { abortCalled = true },
          dispose: () => { /* noop */ },
        },
      }
    },
    AuthStorage: {
      inMemory: () => ({
        _kv: new Map<string, string>(),
        setRuntimeApiKey(provider: string, key: string) { this._kv.set(provider, key) },
      }),
    },
    ModelRegistry: {
      create: (_auth: any, _modelsPath: string) => ({
        // Magic id "nonexistent" returns undefined so we can test the
        // not-found path without rewriting skvm.config.json mid-file.
        find: (provider: string, modelId: string) => {
          if (modelId.includes("nonexistent")) return undefined
          return { provider, id: modelId, reasoning: false } as any
        },
      }),
    },
    SessionManager: { inMemory: (_cwd: string) => ({ /* opaque */ }) },
    SettingsManager: { create: (_cwd: string, _agentDir: string) => ({ /* opaque */ }) },
    DefaultResourceLoader: class { constructor(_opts: any) {} async reload() {} },
    readTool: { name: "read" },
    bashTool: { name: "bash" },
    editTool: { name: "edit" },
    writeTool: { name: "write" },
    grepTool: { name: "grep" },
    findTool: { name: "find" },
    lsTool: { name: "ls" },
  }
})

// Import-under-test must come AFTER mock.module setup.
import { runHeadlessAgent } from "../../src/core/headless-agent/index.ts"
import { resetConfigCacheForTesting } from "../../src/core/config.ts"

const SKVM_CACHE = process.env.SKVM_CACHE!
const CONFIG_PATH = path.join(SKVM_CACHE, "skvm.config.json")

beforeAll(async () => {
  resetConfigCacheForTesting()
  await Bun.write(CONFIG_PATH, JSON.stringify({
    providers: {
      routes: [
        { match: "anthropic/*", kind: "anthropic", apiKey: "sk-test-key" },
      ],
    },
    headlessAgent: { driver: "pi" },
  }))
})

afterAll(() => {
  try { rmSync(CONFIG_PATH, { force: true }) } catch {}
  resetConfigCacheForTesting()
})

beforeEach(() => {
  lastCreateOpts = null
  lastSubscribe = null
  lastPromptText = null
  promptDelayMs = 0
  abortCalled = false
  promptShouldError = false
})

describe("runHeadlessAgent (driver=pi, library mode)", () => {
  test("wires model, apiKey, cwd, tools, prompt correctly", async () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "skvm-pi-driver-test-"))
    try {
      const result = await runHeadlessAgent({
        cwd: workDir,
        prompt: "say hi",
        model: "anthropic/claude-sonnet-4.6",
        timeoutMs: 5000,
      })

      // Result shape
      expect(result.driver).toBe("pi")
      expect(result.exitCode).toBe(0)
      expect(result.timedOut).toBe(false)
      expect(result.cost).toBeCloseTo(0.0042)
      expect(result.tokens.input).toBe(10)
      expect(result.tokens.output).toBe(20)

      // createAgentSession received expected wiring
      expect(lastCreateOpts.cwd).toBe(workDir)
      expect(lastCreateOpts.model.provider).toBe("anthropic")
      expect(lastCreateOpts.model.id).toBe("claude-sonnet-4.6")
      expect(Array.isArray(lastCreateOpts.tools)).toBe(true)
      expect(lastCreateOpts.tools.map((t: any) => t.name).sort())
        .toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"])

      // Credentials injected into AuthStorage, not process.env
      const auth = lastCreateOpts.authStorage
      expect(auth._kv.get("anthropic")).toBe("sk-test-key")

      // Prompt got prefixed with the "no clarifying questions" preamble
      expect(lastPromptText).toContain("Do not ask clarifying questions")
      expect(lastPromptText).toContain("say hi")
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  test("throws HeadlessAgentError when model not registered", async () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "skvm-pi-driver-test-"))
    try {
      await expect(
        runHeadlessAgent({
          cwd: workDir, prompt: "x",
          model: "anthropic/nonexistent-model",
        })
      ).rejects.toThrow(/could not resolve model/)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  test("aborts session on timeout and throws", async () => {
    promptDelayMs = 1000

    const workDir = mkdtempSync(path.join(tmpdir(), "skvm-pi-driver-test-"))
    try {
      await expect(
        runHeadlessAgent({
          cwd: workDir,
          prompt: "x",
          model: "anthropic/claude-sonnet-4.6",
          timeoutMs: 50,
        })
      ).rejects.toThrow(/timed out/)
      expect(abortCalled).toBe(true)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  test("throws HeadlessAgentError when pi reports stopReason=error", async () => {
    promptShouldError = true
    const workDir = mkdtempSync(path.join(tmpdir(), "skvm-pi-driver-test-"))
    try {
      await expect(
        runHeadlessAgent({
          cwd: workDir, prompt: "x",
          model: "anthropic/claude-sonnet-4.6",
          timeoutMs: 5000,
        })
      ).rejects.toThrow(/stopReason=error/)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })
})
