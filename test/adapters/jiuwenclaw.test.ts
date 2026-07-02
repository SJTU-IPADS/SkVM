import { test, expect, describe } from "bun:test"
import { renderJiuwenEnv } from "../../src/adapters/jiuwenclaw.ts"
import type { ProviderRoute } from "../../src/core/types.ts"

describe("renderJiuwenEnv — managed .env synthesis from a resolved route", () => {
  test("openai-compatible route renders API_BASE/API_KEY/MODEL_NAME", () => {
    const route: ProviderRoute = {
      match: "ipads/*", kind: "openai-compatible",
      apiKey: "sk-ipads", baseUrl: "https://ipads.example/v1",
    }
    const env = renderJiuwenEnv(route, "ipads/glm-5", undefined)
    expect(env).toContain('API_BASE="https://ipads.example/v1"')
    expect(env).toContain('API_KEY="sk-ipads"')
    expect(env).toContain('MODEL_NAME="glm-5"')
    expect(env).toContain("BROWSER_RUNTIME_MCP_ENABLED=0")
  })

  test("explicit apiKey override wins over the route's credential", () => {
    const route: ProviderRoute = {
      match: "ipads/*", kind: "openai-compatible",
      apiKey: "sk-route", baseUrl: "https://ipads.example/v1",
    }
    expect(renderJiuwenEnv(route, "ipads/glm-5", "sk-override"))
      .toContain('API_KEY="sk-override"')
  })

  test("deliberate apiKey:\"\" (auth-free local endpoint) writes an empty API_KEY", () => {
    const route: ProviderRoute = {
      match: "local/*", kind: "openai-compatible",
      apiKey: "", baseUrl: "http://localhost:8000/v1",
    }
    expect(renderJiuwenEnv(route, "local/qwen3-7b", undefined))
      .toContain('API_KEY=""')
  })

  test("throws when apiKeyEnv names an unset env var", () => {
    // The sidecar inherits this process's env, so an unset var can never
    // resolve later — fail at synthesis instead of writing API_KEY="" and
    // letting the sidecar 401 mid-run.
    const route: ProviderRoute = {
      match: "ipads/*", kind: "openai-compatible",
      apiKeyEnv: "SKVM_TEST_JIUWEN_UNSET_KEY", baseUrl: "https://ipads.example/v1",
    }
    expect(() => renderJiuwenEnv(route, "ipads/glm-5", undefined))
      .toThrow(/SKVM_TEST_JIUWEN_UNSET_KEY/)
  })

  test("rejects anthropic-kind routes — jiuwenclaw's .env is OpenAI-only", () => {
    const route: ProviderRoute = { match: "anthropic/*", kind: "anthropic", apiKey: "k" }
    expect(() => renderJiuwenEnv(route, "anthropic/claude-sonnet-4.6", undefined))
      .toThrow(/kind=anthropic/)
  })
})
