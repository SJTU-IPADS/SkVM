import { test, expect, describe } from "bun:test"
import { composeEnv } from "../../src/launcher/env.ts"

describe("composeEnv", () => {
  test("includes SKVM_IN_SANDBOX=1 and HOME=/workspace", () => {
    const env = composeEnv({ routes: [], hostEnv: {} })
    expect(env.SKVM_IN_SANDBOX).toBe("1")
    expect(env.HOME).toBe("/workspace")
  })

  test("points SKVM_CACHE at the mounted /skvm-cache", () => {
    const env = composeEnv({ routes: [], hostEnv: {} })
    expect(env.SKVM_CACHE).toBe("/skvm-cache")
  })

  test("sets SKVM_DATA_DIR=/skvm-data only when the dataset is mounted", () => {
    const without = composeEnv({ routes: [], hostEnv: {} })
    expect(without.SKVM_DATA_DIR).toBeUndefined()
    const withData = composeEnv({ routes: [], hostEnv: {}, skvmDataMounted: true })
    expect(withData.SKVM_DATA_DIR).toBe("/skvm-data")
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

  test("throws on a route-match collision (distinct matches → same env var)", () => {
    expect(() => composeEnv({
      routes: [
        { match: "openai-x/*", kind: "openai-compatible", apiKey: "sk-1" },
        { match: "openai_x/*", kind: "openai-compatible", apiKey: "sk-2" },
      ],
      hostEnv: {},
    })).toThrow(/route match collision/)
  })

  test("does not flag the same match string appearing once", () => {
    expect(() => composeEnv({
      routes: [{ match: "openai/*", kind: "openai-compatible", apiKey: "sk-1" }],
      hostEnv: {},
    })).not.toThrow()
  })

  test("forwards SKVM_AUTO_PROBE when set on the host (--no-auto-probe opt-out)", () => {
    const off = composeEnv({ routes: [], hostEnv: { SKVM_AUTO_PROBE: "0" } })
    expect(off.SKVM_AUTO_PROBE).toBe("0")
    const unset = composeEnv({ routes: [], hostEnv: {} })
    expect(unset.SKVM_AUTO_PROBE).toBeUndefined()
  })
})
