import { test, expect, describe } from "bun:test"
import { composeEnv } from "../../src/launcher/env.ts"

describe("composeEnv", () => {
  test("includes SKVM_IN_SANDBOX=1 and HOME=/workspace", () => {
    const env = composeEnv({ routes: [], hostEnv: {} })
    expect(env.SKVM_IN_SANDBOX).toBe("1")
    expect(env.HOME).toBe("/workspace")
  })

  test("forwards HTTP_PROXY, HTTPS_PROXY, NO_PROXY in both cases", () => {
    const env = composeEnv({
      routes: [],
      hostEnv: {
        HTTP_PROXY: "http://p:1",
        https_proxy: "http://p:2",
        no_proxy: "localhost",
      },
    })
    expect(env.HTTP_PROXY).toBe("http://p:1")
    expect(env.https_proxy).toBe("http://p:2")
    expect(env.no_proxy).toBe("localhost")
  })

  test("injects SKVM_ROUTE_<safe>_KEY for each route with a resolved key", () => {
    const env = composeEnv({
      routes: [
        { match: "openai", kind: "openai-compatible", apiKey: "sk-1" },
        { match: "openrouter/anthropic/claude-sonnet-4.6", kind: "openrouter", apiKey: "sk-2" },
      ],
      hostEnv: {},
    })
    expect(env.SKVM_ROUTE_openai_KEY).toBe("sk-1")
    expect(env.SKVM_ROUTE_openrouter_anthropic_claude_sonnet_4_6_KEY).toBe("sk-2")
  })

  test("skips routes without a resolvable key", () => {
    const env = composeEnv({
      routes: [{ match: "x/y", kind: "openai-compatible" }],
      hostEnv: {},
    })
    expect(Object.keys(env).some(k => k.startsWith("SKVM_ROUTE_"))).toBe(false)
  })
})
