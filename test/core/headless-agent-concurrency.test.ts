import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from "bun:test"
import path from "node:path"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"

// We capture the AuthStorage instance each createAgentSession sees so we can
// confirm two concurrent calls receive their own storage (no shared state).
const seenAuthStorages: any[] = []
const seenCwds: string[] = []
const seenAgentDirs: string[] = []
const promptResolvers: Array<() => void> = []

mock.module("@mariozechner/pi-coding-agent", () => {
  return {
    createAgentSession: async (opts: any) => {
      seenAuthStorages.push(opts.authStorage)
      seenCwds.push(opts.cwd)
      seenAgentDirs.push(opts.agentDir)
      return {
        session: {
          subscribe: (_l: any) => () => {},
          prompt: async () => {
            await new Promise<void>(resolve => promptResolvers.push(resolve))
          },
          abort: async () => {},
          dispose: () => {},
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
      // Probe registry (builtins-only) — returns undefined so uncatalogued path is taken.
      inMemory: () => ({
        find: (_provider: string, _modelId: string) => undefined,
      }),
      create: () => ({
        find: (provider: string, modelId: string) => ({ provider, id: modelId, reasoning: false }) as any,
      }),
    },
    SessionManager: { inMemory: () => ({}) },
    SettingsManager: { create: () => ({}) },
    DefaultResourceLoader: class { constructor(_: any) {} async reload() {} },
    readTool: { name: "read" }, bashTool: { name: "bash" },
    editTool: { name: "edit" }, writeTool: { name: "write" },
    grepTool: { name: "grep" }, findTool: { name: "find" }, lsTool: { name: "ls" },
  }
})

import { runHeadlessAgent } from "../../src/core/headless-agent/index.ts"
import { resetConfigCacheForTesting } from "../../src/core/config.ts"

const SKVM_CACHE = process.env.SKVM_CACHE!
const CONFIG_PATH = path.join(SKVM_CACHE, "skvm.config.json")

// Multiple test files sharing a Bun worker share a module registry, so a
// previous file may have cached config.ts's module-level singletons with
// different route data. Reset before writing our config so the first
// runHeadlessAgent call sees KEY-A / KEY-B, not a stale key from another file.
beforeAll(async () => {
  await Bun.write(CONFIG_PATH, JSON.stringify({
    providers: {
      routes: [
        { match: "anthropic/*", kind: "anthropic", apiKey: "KEY-A" },
        { match: "openrouter/*", kind: "openrouter", apiKey: "KEY-B" },
      ],
    },
    headlessAgent: { driver: "pi" },
  }))
  resetConfigCacheForTesting()
})

afterAll(() => {
  try { rmSync(CONFIG_PATH, { force: true }) } catch {}
  // Reset caches so subsequent files in the same worker don't see KEY-A/KEY-B.
  resetConfigCacheForTesting()
})

beforeEach(() => {
  seenAuthStorages.length = 0
  seenCwds.length = 0
  seenAgentDirs.length = 0
  promptResolvers.length = 0
})

describe("runHeadlessAgent(driver=pi) concurrency", () => {
  test("two parallel calls get distinct AuthStorage, cwd, agentDir, and apiKey", async () => {
    const cwdA = mkdtempSync(path.join(tmpdir(), "skvm-conc-A-"))
    const cwdB = mkdtempSync(path.join(tmpdir(), "skvm-conc-B-"))

    try {
      const promiseA = runHeadlessAgent({
        cwd: cwdA, prompt: "A", model: "anthropic/claude-sonnet-4.6",
      })
      const promiseB = runHeadlessAgent({
        cwd: cwdB, prompt: "B", model: "openrouter/qwen/qwen3-30b",
      })

      // Wait until both prompts have started.
      // Each await session.prompt() registers one resolver.
      while (promptResolvers.length < 2) {
        await new Promise(r => setTimeout(r, 5))
      }

      // Both sessions are constructed and prompting. Inspect state.
      // Order of concurrent async completions is non-deterministic (both
      // calls race on mkdtemp), so we find each session by credential content
      // rather than asserting a fixed index order.
      expect(seenAuthStorages).toHaveLength(2)
      expect(seenAuthStorages[0]).not.toBe(seenAuthStorages[1])

      const anthropicStorage = seenAuthStorages.find((s: any) => s._kv.get("anthropic") === "KEY-A")
      const openrouterStorage = seenAuthStorages.find((s: any) => s._kv.get("openrouter") === "KEY-B")
      expect(anthropicStorage).toBeDefined()
      expect(openrouterStorage).toBeDefined()
      // Each session must carry ONLY its own credential, not the other's.
      expect(anthropicStorage!._kv.get("openrouter")).toBeUndefined()
      expect(openrouterStorage!._kv.get("anthropic")).toBeUndefined()

      // Both cwds must be present (order-independent).
      expect(seenCwds.sort()).toEqual([cwdA, cwdB].sort())
      expect(seenAgentDirs[0]).not.toBe(seenAgentDirs[1])

      // Critical: skvm did NOT set process.env credentials.
      // (We use a key that's distinctive so we can scan all known names.)
      expect(process.env.ANTHROPIC_API_KEY).not.toBe("KEY-A")
      expect(process.env.OPENROUTER_API_KEY).not.toBe("KEY-B")

      // Resolve both prompts so the test can drain.
      for (const r of promptResolvers) r()
      await Promise.all([promiseA, promiseB])
    } finally {
      rmSync(cwdA, { recursive: true, force: true })
      rmSync(cwdB, { recursive: true, force: true })
    }
  })
})
