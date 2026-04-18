import { test, expect, describe } from "bun:test"
import {
  globMatch,
  findMatchingRoute,
  createProviderForModel,
} from "../../src/providers/registry.ts"
import { ProviderAuthError } from "../../src/providers/errors.ts"
import type { ProvidersConfig } from "../../src/core/types.ts"

describe("globMatch", () => {
  test("literal match", () => {
    expect(globMatch("anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-6")).toBe(true)
    expect(globMatch("anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-5")).toBe(false)
  })

  test("wildcard suffix", () => {
    expect(globMatch("anthropic/*", "anthropic/claude-sonnet-4-6")).toBe(true)
    expect(globMatch("anthropic/*", "anthropic/claude-haiku-4-5")).toBe(true)
    expect(globMatch("anthropic/*", "openai/gpt-4o")).toBe(false)
  })

  test("wildcard in middle", () => {
    expect(globMatch("openai/gpt-*", "openai/gpt-4o")).toBe(true)
    expect(globMatch("openai/gpt-*", "openai/gpt-4o-mini")).toBe(true)
    expect(globMatch("openai/gpt-*", "openai/o1-preview")).toBe(false)
  })

  test("catch-all", () => {
    expect(globMatch("*", "anything/at/all")).toBe(true)
    expect(globMatch("*", "")).toBe(true)
  })

  test("regex metacharacters in pattern are literal", () => {
    // Dot should not match any char; it should match a literal dot.
    expect(globMatch("a.b", "a.b")).toBe(true)
    expect(globMatch("a.b", "axb")).toBe(false)
  })
})

describe("findMatchingRoute", () => {
  const config: ProvidersConfig = {
    routes: [
      { match: "anthropic/*", kind: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
      { match: "openai/*", kind: "openai-compatible", apiKeyEnv: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1" },
      { match: "openrouter/*", kind: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY" },
    ],
  }

  test("first match wins — specific route before later entries", () => {
    const route = findMatchingRoute("anthropic/claude-sonnet-4-6", config)
    expect(route?.kind).toBe("anthropic")
  })

  test("openrouter prefix matches the openrouter/* route", () => {
    const route = findMatchingRoute("openrouter/qwen/qwen3-30b", config)
    expect(route?.kind).toBe("openrouter")
  })

  test("order matters — earlier specific wins over later prefix", () => {
    const route = findMatchingRoute("openai/gpt-4o", config)
    expect(route?.kind).toBe("openai-compatible")
  })

  test("unprefixed id returns undefined under prefix-required convention", () => {
    // `qwen/qwen3-30b` without `openrouter/` matches none of the configured
    // routes — caller must fall back to DEFAULT_ROUTE or raise an error.
    expect(findMatchingRoute("qwen/qwen3-30b", config)).toBeUndefined()
  })

  test("no routes → undefined", () => {
    expect(findMatchingRoute("anything", { routes: [] })).toBeUndefined()
  })
})

// stripRoutingPrefix tests live alongside its canonical home in test/core/config.test.ts.

describe("createProviderForModel", () => {
  test("falls back to DEFAULT_ROUTE (openrouter/*) when no user routes match", () => {
    // apiKey override bypasses env var lookup so the test doesn't depend on
    // OPENROUTER_API_KEY being set in the environment.
    const provider = createProviderForModel("openrouter/qwen/qwen3-30b-a3b-instruct-2507", {
      apiKey: "test-key",
    })
    expect(provider.name).toBe("openrouter")
  })

  test("overrides.apiKey bypasses the route's apiKeyEnv", () => {
    const provider = createProviderForModel("openrouter/some/model", { apiKey: "fake" })
    expect(provider).toBeDefined()
  })

  test("missing env var throws ProviderAuthError", () => {
    // Save + clear OPENROUTER_API_KEY so the default route's apiKeyEnv lookup
    // fails. Not using overrides — this test is specifically about the env-var
    // failure path producing a classifiable infra error.
    const saved = process.env.OPENROUTER_API_KEY
    delete process.env.OPENROUTER_API_KEY
    try {
      let thrown: unknown
      try {
        createProviderForModel("openrouter/qwen/qwen3-30b")
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(ProviderAuthError)
      expect((thrown as ProviderAuthError).retryable).toBe(false)
      expect((thrown as Error).message).toContain("OPENROUTER_API_KEY")
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved
    }
  })

  test("unmatched prefix fails loudly rather than falling back to openrouter", () => {
    // A bare id can't match `openrouter/*` and won't collide with any
    // `<prefix>/*` pattern a real user config might contain. Typo'd ids
    // must not be silently sent to OpenRouter with a wrong key.
    let thrown: unknown
    try {
      createProviderForModel("bare-id-no-prefix", { apiKey: "fake" })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain("No providers.routes entry matches")
    expect((thrown as Error).message).toContain("bare-id-no-prefix")
  })
})
