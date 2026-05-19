import { test, expect, describe, afterEach, mock } from "bun:test"
import {
  globMatch,
  findMatchingRoute,
  createProviderForModel,
  validateModelIdForRoute,
} from "../../src/providers/registry.ts"
import { ProviderAuthError } from "../../src/providers/errors.ts"
import type { ProviderRoute, ProvidersConfig } from "../../src/core/types.ts"
import * as configModule from "../../src/core/config.ts"

// ---------------------------------------------------------------------------
// Stub getProvidersConfig for the anthropic-gateway baseUrl routing test.
// Returning an empty routes array keeps the existing createProviderForModel
// tests working — they all use openrouter/... ids which fall through to the
// built-in DEFAULT_ROUTE. The gw_anthropic/* route is only matched by the
// new test below.
// ---------------------------------------------------------------------------
mock.module("../../src/core/config.ts", () => ({
  ...configModule,
  getProvidersConfig: (): ProvidersConfig => ({
    routes: [
      {
        match: "gw_anthropic/*",
        kind: "anthropic" as const,
        apiKey: "k",
        baseUrl: "https://gw.example.com",
      },
    ],
  }),
}))

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

describe("validateModelIdForRoute", () => {
  const ORoute: ProviderRoute = { match: "openrouter/*", kind: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY" }
  const ARoute: ProviderRoute = { match: "anthropic/*", kind: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" }
  const CRoute: ProviderRoute = { match: "ipads/*", kind: "openai-compatible", baseUrl: "http://x/v1" }

  test("openrouter: id missing <vendor>/ segment is rejected with hint", () => {
    let err: Error | undefined
    try { validateModelIdForRoute("openrouter/qwen3.5-35b-a3b", ORoute) } catch (e) { err = e as Error }
    expect(err).toBeInstanceOf(Error)
    expect(err?.message).toContain("not a valid OpenRouter id")
    expect(err?.message).toContain("<vendor>/<model>")
  })

  test("openrouter: vendor/model form passes", () => {
    expect(() => validateModelIdForRoute("openrouter/qwen/qwen3-30b-a3b", ORoute)).not.toThrow()
  })

  test("anthropic: non-claude id is rejected", () => {
    let err: Error | undefined
    try { validateModelIdForRoute("anthropic/gpt-4o", ARoute) } catch (e) { err = e as Error }
    expect(err?.message).toContain("doesn't look like an Anthropic model")
  })

  test("anthropic: claude-* id passes", () => {
    expect(() => validateModelIdForRoute("anthropic/claude-sonnet-4.6", ARoute)).not.toThrow()
  })

  test("openai-compatible: any non-whitespace id passes", () => {
    expect(() => validateModelIdForRoute("ipads/gpt-4o", CRoute)).not.toThrow()
    expect(() => validateModelIdForRoute("ipads/whatever-123_v2", CRoute)).not.toThrow()
  })

  test("openai-compatible: whitespace in id rejected", () => {
    let err: Error | undefined
    try { validateModelIdForRoute("ipads/has space", CRoute) } catch (e) { err = e as Error }
    expect(err?.message).toMatch(/empty or contains whitespace/)
  })
})

describe("validateModelIdForRoute on anthropic kind", () => {
  test("rejects non-claude id when baseUrl is missing (official Anthropic)", () => {
    const route: ProviderRoute = {
      match: "anthropic/*", kind: "anthropic", apiKey: "k",
    }
    expect(() => validateModelIdForRoute("anthropic/glm-5-thinking", route))
      .toThrow(/doesn't look like an Anthropic model/)
  })

  test("rejects non-claude id when baseUrl is api.anthropic.com", () => {
    const route: ProviderRoute = {
      match: "anthropic/*", kind: "anthropic",
      baseUrl: "https://api.anthropic.com", apiKey: "k",
    }
    expect(() => validateModelIdForRoute("anthropic/glm-5-thinking", route))
      .toThrow(/doesn't look like an Anthropic model/)
  })

  test("accepts non-claude id when baseUrl is a third-party gateway", () => {
    const route: ProviderRoute = {
      match: "gw_anthropic/*", kind: "anthropic",
      baseUrl: "https://gateway.example.com", apiKey: "k",
    }
    expect(() => validateModelIdForRoute("gw_anthropic/glm-5-thinking", route))
      .not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// registry: anthropic route.baseUrl is threaded into AnthropicProvider
// ---------------------------------------------------------------------------

describe("createProviderForModel — anthropic route with baseUrl", () => {
  const realFetch = globalThis.fetch
  let observedUrl: string | undefined

  afterEach(() => {
    globalThis.fetch = realFetch
    observedUrl = undefined
  })

  function stubFetch(body: unknown, status = 200) {
    globalThis.fetch = (async (input: string | URL | Request) => {
      observedUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch
  }

  test("route.baseUrl is forwarded to AnthropicProvider — outbound fetch hits gateway URL", async () => {
    // The gw_anthropic/* route (declared via mock.module above) sets
    // baseUrl="https://gw.example.com". Before the fix, registry.ts ignored
    // route.baseUrl in the anthropic branch and the Anthropic SDK would hit
    // the default api.anthropic.com endpoint instead.
    stubFetch({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      model: "glm-5-thinking",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 5,
        output_tokens: 3,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    })

    const provider = createProviderForModel("gw_anthropic/glm-5-thinking", { apiKey: "k" })
    await provider.complete({ messages: [{ role: "user", content: "hi" }] })

    expect(observedUrl).toBe("https://gw.example.com/v1/messages")
  })
})
