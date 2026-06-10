import { test, expect, describe } from "bun:test"
import { safeModelName } from "../../src/core/config.ts"

// The routing-prefix convention (resolveBackendModel / routeProviderName) is
// the provider registry's knowledge — tests live in test/providers/registry.test.ts.

describe("safeModelName", () => {
  test("slugifies the full CLI id; distinct providers get distinct slugs", () => {
    // Separation is deliberate — `openai/gpt-4o` and `ipads/gpt-4o` route
    // through different endpoints with potentially different behavior, so
    // their cached artifacts should not collide.
    expect(safeModelName("openai/gpt-4o")).toBe("openai--gpt-4o")
    expect(safeModelName("ipads/gpt-4o")).toBe("ipads--gpt-4o")
    expect(safeModelName("openrouter/anthropic/claude-opus-4.6"))
      .toBe("openrouter--anthropic--claude-opus-4.6")
    expect(safeModelName("anthropic/claude-sonnet-4.6"))
      .toBe("anthropic--claude-sonnet-4.6")
  })

  test("replaces / with -- and : with _", () => {
    expect(safeModelName("openrouter/meta/llama-3.1:free"))
      .toBe("openrouter--meta--llama-3.1_free")
  })

  test("rejects empty / dot-segment ids", () => {
    expect(() => safeModelName("")).toThrow()
    expect(() => safeModelName("..")).toThrow()
  })
})
