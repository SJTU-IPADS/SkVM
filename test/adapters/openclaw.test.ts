import { test, expect, describe } from "bun:test"
import { normalizeAgentId, renderOpenclawProviderEntries } from "../../src/adapters/openclaw.ts"
import type { ProviderRoute } from "../../src/core/types.ts"

describe("normalizeAgentId", () => {
  test("lowercases and replaces slashes, dots, and colons with dashes", () => {
    expect(normalizeAgentId("anthropic/claude-haiku-4.5")).toBe("anthropic-claude-haiku-4-5")
    expect(normalizeAgentId("qwen:qwen3.5-9b")).toBe("qwen-qwen3-5-9b")
    expect(normalizeAgentId("OpenAI/GPT-5.4")).toBe("openai-gpt-5-4")
  })

  test("leaves already-safe IDs unchanged", () => {
    expect(normalizeAgentId("plain-model-id")).toBe("plain-model-id")
  })
})

describe("renderOpenclawProviderEntries — block synthesis from a resolved route", () => {
  // Route selection is the resolver's job (resolveRoute → findMatchingRoute,
  // covered in test/providers/registry.test.ts incl. the shared-prefix case).
  // This renderer just builds the provider block from the route it's handed.
  test("keys the block by the model's prefix and builds it from the route", () => {
    const route: ProviderRoute = {
      match: "openrouter/anthropic/*", kind: "openai-compatible",
      apiKey: "anthropic-key", baseUrl: "https://anthropic.example/v1",
    }
    const entries = renderOpenclawProviderEntries(route, "openrouter/anthropic/claude-sonnet-4.6")
    // Key is the model's own leading segment, not the route's.
    expect(entries.openrouter).toBeDefined()
    expect(entries.openrouter!.baseUrl).toBe("https://anthropic.example/v1")
    expect(entries.openrouter!.apiKey).toBe("anthropic-key")
    expect(entries.openrouter!.api).toBe("openai-completions")
    // Synthesized model id is backend-namespace (provider prefix stripped).
    expect(entries.openrouter!.models[0]!.id).toBe("anthropic/claude-sonnet-4.6")
  })

  test("anthropic-kind route uses the anthropic-messages api + default baseUrl", () => {
    const route: ProviderRoute = { match: "anthropic/*", kind: "anthropic", apiKey: "k" }
    const entries = renderOpenclawProviderEntries(route, "anthropic/claude-sonnet-4.6")
    expect(entries.anthropic!.api).toBe("anthropic-messages")
    // baseUrl falls back to the anthropic default when the route omits it.
    expect(entries.anthropic!.baseUrl).toBe("https://api.anthropic.com/v1")
  })

  test("apiKeyEnv resolves to the env var's value, never its name", () => {
    process.env.SKVM_TEST_OPENCLAW_KEY = "from-env"
    try {
      const route: ProviderRoute = { match: "anthropic/*", kind: "anthropic", apiKeyEnv: "SKVM_TEST_OPENCLAW_KEY" }
      const entries = renderOpenclawProviderEntries(route, "anthropic/claude-sonnet-4.6")
      expect(entries.anthropic!.apiKey).toBe("from-env")
    } finally {
      delete process.env.SKVM_TEST_OPENCLAW_KEY
    }
  })

  test("throws when apiKeyEnv names an unset env var", () => {
    // The openclaw child inherits this process's env, so an unset var can
    // never resolve later — fail at synthesis with the var's name instead of
    // writing it as a literal apiKey and failing inside openclaw with a
    // generic auth error.
    const route: ProviderRoute = { match: "anthropic/*", kind: "anthropic", apiKeyEnv: "SKVM_TEST_OPENCLAW_UNSET_KEY" }
    expect(() => renderOpenclawProviderEntries(route, "anthropic/claude-sonnet-4.6"))
      .toThrow(/SKVM_TEST_OPENCLAW_UNSET_KEY/)
  })
})
