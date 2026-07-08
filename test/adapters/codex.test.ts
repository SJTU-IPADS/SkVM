import { test, expect, describe } from "bun:test"
import { parse as parseTOML } from "smol-toml"
import {
  parseCodexJSONL,
  eventsToRunRecord,
  fromCodexUsage,
  isTransientCodexError,
  detectSkillInject,
  detectSkillDiscover,
  resolveCodexDiscoverSkillDir,
  resolveUserCodexHome,
  CodexAdapter,
  type CodexEvent,
} from "../../src/adapters/codex.ts"
import { buildCodexConfigContent } from "../../src/core/adapter-sandbox.ts"
import { estimateCost } from "../../src/core/cost.ts"
import type { ProviderRoute } from "../../src/core/types.ts"

describe("parseCodexJSONL", () => {
  test("parses valid JSONL event lines", () => {
    const input = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hi"}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}',
    ].join("\n")
    const events = parseCodexJSONL(input)
    expect(events.length).toBe(4)
    expect(events[0]!.type).toBe("thread.started")
    expect(events[2]!.item!.type).toBe("agent_message")
  })

  test("skips blank and non-JSON lines", () => {
    const input = [
      "",
      "codex 0.142.3 starting…",
      '{"type":"item.completed","item":{"type":"agent_message","text":"valid"}}',
      "Reading additional input from stdin...",
    ].join("\n")
    const events = parseCodexJSONL(input)
    expect(events.length).toBe(1)
    expect(events[0]!.item!.text).toBe("valid")
  })

  test("rejects JSON without a string type field", () => {
    const events = parseCodexJSONL('{"foo":"bar"}\n{"type":"turn.started"}')
    expect(events.length).toBe(1)
    expect(events[0]!.type).toBe("turn.started")
  })

  test("handles empty input", () => {
    expect(parseCodexJSONL("")).toEqual([])
    expect(parseCodexJSONL("\n\n")).toEqual([])
  })
})

describe("fromCodexUsage", () => {
  test("subtracts cached tokens out of input (OpenAI subset convention)", () => {
    const u = fromCodexUsage({ input_tokens: 32598, cached_input_tokens: 32512, output_tokens: 34, reasoning_output_tokens: 0 })
    expect(u.input).toBe(32598 - 32512)
    expect(u.cacheRead).toBe(32512)
    expect(u.output).toBe(34)
    expect(u.cacheWrite).toBe(0)
  })

  test("handles missing fields and never goes negative", () => {
    expect(fromCodexUsage(undefined)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    const u = fromCodexUsage({ cached_input_tokens: 50 }) // cached > input (0)
    expect(u.input).toBe(0)
    expect(u.cacheRead).toBe(50)
  })
})

describe("isTransientCodexError", () => {
  test("classifies reconnect / transport-fallback notices as transient", () => {
    expect(isTransientCodexError("Reconnecting... 2/5 (stream disconnected before completion)")).toBe(true)
    expect(isTransientCodexError("Falling back from WebSockets to HTTPS transport. stream disconnected")).toBe(true)
  })
  test("does not classify real failures as transient", () => {
    expect(isTransientCodexError("invalid_request_error: model not found")).toBe(false)
    expect(isTransientCodexError("stream disconnected before completion: Transport error")).toBe(false)
  })
})

describe("eventsToRunRecord", () => {
  test("maps agent_message to final text + assistant step", () => {
    const events: CodexEvent[] = [
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "done" } },
      { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 5 } },
    ]
    const r = eventsToRunRecord(events).finish({ workDir: "/tmp/w", durationMs: 10 })
    expect(r.text).toBe("done")
    expect(r.steps.length).toBe(1)
    expect(r.steps[0]!.role).toBe("assistant")
    expect(r.tokens.input).toBe(80)
    expect(r.tokens.cacheRead).toBe(20)
    expect(r.tokens.output).toBe(5)
    expect(r.usageAvailable).toBe(true)
    expect(r.runStatus).toBe("ok")
  })

  test("maps command_execution to a shell tool step with output and exit code", () => {
    const events: CodexEvent[] = [
      {
        type: "item.completed",
        item: {
          id: "item_1", type: "command_execution",
          command: "/usr/bin/bash -lc 'echo hi'", aggregated_output: "hi\n", exit_code: 0, status: "completed",
        },
      },
    ]
    const r = eventsToRunRecord(events).finish({ workDir: "/tmp/w", durationMs: 1 })
    expect(r.steps.length).toBe(1)
    expect(r.steps[0]!.role).toBe("tool")
    expect(r.steps[0]!.toolCalls[0]!.name).toBe("shell")
    expect(r.steps[0]!.toolCalls[0]!.input).toEqual({ command: "/usr/bin/bash -lc 'echo hi'" })
    expect(r.steps[0]!.toolCalls[0]!.output).toBe("hi\n")
    expect(r.steps[0]!.toolCalls[0]!.exitCode).toBe(0)
  })

  test("maps file_change to an apply_patch tool step", () => {
    const events: CodexEvent[] = [
      {
        type: "item.completed",
        item: { id: "item_2", type: "file_change", changes: [{ path: "/tmp/w/hello.txt", kind: "add" }], status: "completed" },
      },
    ]
    const r = eventsToRunRecord(events).finish({ workDir: "/tmp/w", durationMs: 1 })
    expect(r.steps[0]!.toolCalls[0]!.name).toBe("apply_patch")
    expect(r.steps[0]!.toolCalls[0]!.input).toEqual({ changes: [{ path: "/tmp/w/hello.txt", kind: "add" }] })
  })

  test("last agent_message wins as final text over an earlier reasoning item", () => {
    const events: CodexEvent[] = [
      { type: "item.completed", item: { type: "reasoning", text: "I will write the file." } },
      { type: "item.completed", item: { type: "file_change", changes: [{ path: "a", kind: "add" }] } },
      { type: "item.completed", item: { type: "agent_message", text: "finished" } },
    ]
    const r = eventsToRunRecord(events).finish({ workDir: "/tmp/w", durationMs: 1 })
    expect(r.text).toBe("finished")
  })

  test("computeCost hook is applied to the final usage", () => {
    const events: CodexEvent[] = [
      { type: "item.completed", item: { type: "agent_message", text: "ok" } },
      { type: "turn.completed", usage: { input_tokens: 1_000_000, output_tokens: 0 } },
    ]
    const r = eventsToRunRecord(events, (t) => t.input * 0.000002).finish({ workDir: "/tmp/w", durationMs: 1 })
    expect(r.cost).toBeCloseTo(2)
    expect(r.usageAvailable).toBe(true)
  })

  test("without a computeCost hook, cost stays 0 but token telemetry is still available", () => {
    const events: CodexEvent[] = [
      { type: "item.completed", item: { type: "agent_message", text: "ok" } },
      { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 5 } },
    ]
    const r = eventsToRunRecord(events).finish({ workDir: "/tmp/w", durationMs: 1 })
    expect(r.cost).toBe(0)
    expect(r.usageAvailable).toBe(true)
  })

  test("transient reconnect error events do not become adapterError", () => {
    const events: CodexEvent[] = [
      { type: "error", message: "Reconnecting... 2/5 (stream disconnected before completion)" },
      { type: "item.completed", item: { type: "agent_message", text: "recovered" } },
      { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 1 } },
    ]
    const r = eventsToRunRecord(events).finish({ workDir: "/tmp/w", durationMs: 1 })
    expect(r.adapterError).toBeUndefined()
    expect(r.text).toBe("recovered")
    expect(r.runStatus).toBe("ok")
  })

  test("turn.failed with no steps surfaces adapterError and statusDetail", () => {
    const events: CodexEvent[] = [
      { type: "error", message: '{"type":"error","error":{"message":"The following tools cannot be used with reasoning.effort minimal"}}' },
      { type: "turn.failed", error: { message: "The following tools cannot be used with reasoning.effort minimal" } },
    ]
    const r = eventsToRunRecord(events).finish({ workDir: "/tmp/w", durationMs: 1 })
    expect(r.steps.length).toBe(0)
    expect(r.adapterError?.stderr).toContain("reasoning.effort minimal")
    expect(r.statusDetail).toContain("codex failed")
  })

  test("empty events produce a telemetry-only note", () => {
    const r = eventsToRunRecord([]).finish({ workDir: "/tmp/w", durationMs: 0 })
    expect(r.text).toBe("")
    expect(r.steps).toEqual([])
    expect(r.cost).toBe(0)
    expect(r.usageAvailable).toBe(false)
    expect(r.runStatus).toBe("ok")
    expect(r.statusDetail).toContain("no parseable items")
  })
})

describe("detectSkillInject", () => {
  test("true when model text echoes the sentinel", () => {
    const events: CodexEvent[] = [
      { type: "item.completed", item: { type: "agent_message", text: "loaded <skvm-skill-injected/> ok" } },
    ]
    expect(detectSkillInject(events, "irrelevant snippet over twenty chars long")).toBe(true)
  })

  test("true when model quotes a long-enough skill snippet", () => {
    const snippet = "Detailed mandatory formatting instructions"
    const events: CodexEvent[] = [
      { type: "item.completed", item: { type: "agent_message", text: `Following: ${snippet}.` } },
    ]
    expect(detectSkillInject(events, snippet)).toBe(true)
  })

  test("falls back to true when any real step ran (AGENTS.md is auto-loaded)", () => {
    const events: CodexEvent[] = [
      { type: "item.completed", item: { type: "file_change", changes: [{ path: "a", kind: "add" }] } },
    ]
    expect(detectSkillInject(events, "a snippet that is never echoed back at all")).toBe(true)
  })

  test("false when nothing ran and no text matched", () => {
    const events: CodexEvent[] = [
      { type: "error", message: "Reconnecting... 1/5" },
      { type: "item.completed", item: { type: "error", message: "Falling back from WebSockets to HTTPS transport" } },
    ]
    expect(detectSkillInject(events, "a snippet that is never echoed back at all")).toBe(false)
  })
})

describe("detectSkillDiscover", () => {
  test("true when a command reads the skill's SKILL.md path", () => {
    const events: CodexEvent[] = [
      {
        type: "item.completed",
        item: { type: "command_execution", command: "/usr/bin/bash -lc \"sed -n '1,220p' /tmp/ch/.agents/skills/greeting-helper/SKILL.md\"" },
      },
    ]
    expect(detectSkillDiscover(events, "greeting-helper")).toBe(true)
  })

  test("true when the model narrates the skill by name", () => {
    const events: CodexEvent[] = [
      { type: "item.completed", item: { type: "agent_message", text: "I'll use the `greeting-helper` skill for this." } },
    ]
    expect(detectSkillDiscover(events, "greeting-helper")).toBe(true)
  })

  test("false when no event references the skill", () => {
    const events: CodexEvent[] = [
      { type: "item.completed", item: { type: "command_execution", command: "/usr/bin/bash -lc 'ls'" } },
      { type: "item.completed", item: { type: "agent_message", text: "done" } },
    ]
    expect(detectSkillDiscover(events, "greeting-helper")).toBe(false)
  })
})

describe("resolveCodexDiscoverSkillDir", () => {
  test("stages discover skills under the repo-scoped .agents/skills directory", () => {
    expect(resolveCodexDiscoverSkillDir("/tmp/work", "greeting-helper"))
      .toBe("/tmp/work/.agents/skills/greeting-helper")
  })
})

describe("resolveUserCodexHome", () => {
  test("honors CODEX_HOME override", () => {
    const prev = process.env.CODEX_HOME
    process.env.CODEX_HOME = "/custom/codex"
    try {
      expect(resolveUserCodexHome()).toBe("/custom/codex")
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prev
    }
  })
})

describe("CodexAdapter shape", () => {
  test("exposes the canonical name", () => {
    expect(new CodexAdapter().name).toBe("codex")
  })
})

describe("buildCodexConfigContent", () => {
  const mkRoute = (over: Partial<ProviderRoute>): ProviderRoute => ({
    match: "openai/*", kind: "openai-compatible", apiKey: "sk-test", baseUrl: "https://api.example.com/v1", ...over,
  } as ProviderRoute)

  test("openai-compatible route → custom provider block using OPENAI_API_KEY", () => {
    const toml = buildCodexConfigContent(mkRoute({}), "gpt-5.5")
    const cfg = parseTOML(toml) as any
    expect(cfg.model).toBe("gpt-5.5")
    expect(cfg.model_provider).toBe("skvm")
    expect(cfg.model_providers.skvm.base_url).toBe("https://api.example.com/v1")
    expect(cfg.model_providers.skvm.env_key).toBe("OPENAI_API_KEY")
    expect(cfg.model_providers.skvm.wire_api).toBe("chat")
  })

  test("openrouter route → OPENROUTER_API_KEY and default base_url", () => {
    const toml = buildCodexConfigContent(mkRoute({ match: "openrouter/*", kind: "openrouter", baseUrl: undefined }), "gpt-5.5")
    const cfg = parseTOML(toml) as any
    expect(cfg.model_providers.skvm.env_key).toBe("OPENROUTER_API_KEY")
    expect(cfg.model_providers.skvm.base_url).toBe("https://openrouter.ai/api/v1")
  })

  test("auth-free local route omits env_key", () => {
    const toml = buildCodexConfigContent(mkRoute({ apiKey: "" }), "local-model")
    const cfg = parseTOML(toml) as any
    expect(cfg.model_providers.skvm.base_url).toBe("https://api.example.com/v1")
    expect(cfg.model_providers.skvm.env_key).toBeUndefined()
  })

  test("env-backed route throws early when the env var is missing", () => {
    const prev = process.env.SKVM_MISSING_CODEX_KEY
    delete process.env.SKVM_MISSING_CODEX_KEY
    try {
      expect(() => buildCodexConfigContent(mkRoute({ apiKey: undefined, apiKeyEnv: "SKVM_MISSING_CODEX_KEY" }), "x"))
        .toThrow(/SKVM_MISSING_CODEX_KEY/)
    } finally {
      if (prev !== undefined) process.env.SKVM_MISSING_CODEX_KEY = prev
    }
  })

  test("rejects anthropic routes", () => {
    expect(() => buildCodexConfigContent(mkRoute({ match: "anthropic/*", kind: "anthropic", baseUrl: undefined }), "x"))
      .toThrow(/anthropic/)
  })

  test("throws when openai-compatible route is missing baseUrl", () => {
    expect(() => buildCodexConfigContent(mkRoute({ baseUrl: undefined }), "x")).toThrow(/baseUrl/)
  })
})

describe("Codex cost coverage", () => {
  test("estimates current recommended Codex model costs", () => {
    const tokens = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }
    expect(estimateCost("openai/gpt-5.5", tokens)).toBeCloseTo(35)
    expect(estimateCost("openai/gpt-5.4-mini", tokens)).toBeCloseTo(5.25)
  })
})
