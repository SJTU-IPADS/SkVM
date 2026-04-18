import { test, expect, describe } from "bun:test"
import { safeModelName, stripRoutingPrefix } from "../../src/core/config.ts"

describe("stripRoutingPrefix", () => {
  test("drops the first /-separated segment", () => {
    expect(stripRoutingPrefix("openai/gpt-4o")).toBe("gpt-4o")
    expect(stripRoutingPrefix("anthropic/claude-sonnet-4.6")).toBe("claude-sonnet-4.6")
    expect(stripRoutingPrefix("self/qwen3-7b")).toBe("qwen3-7b")
  })

  test("leaves the remainder intact for nested ids like OR's vendor/model form", () => {
    expect(stripRoutingPrefix("openrouter/qwen/qwen3-30b"))
      .toBe("qwen/qwen3-30b")
    expect(stripRoutingPrefix("openrouter/anthropic/claude-sonnet-4.6"))
      .toBe("anthropic/claude-sonnet-4.6")
  })

  test("no-op for bare ids", () => {
    expect(stripRoutingPrefix("gpt-4o")).toBe("gpt-4o")
    expect(stripRoutingPrefix("")).toBe("")
  })
})

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
