import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SandboxConfigSchema } from "../../src/core/types.ts"
import { invalidateConfigCache, getSandboxConfig, resolveRouteApiKey, safeRouteId, resolveAdapterConfigMode } from "../../src/core/config.ts"

describe("resolveAdapterConfigMode — sandbox native guard", () => {
  let savedInSandbox: string | undefined
  beforeEach(() => { savedInSandbox = process.env.SKVM_IN_SANDBOX })
  afterEach(() => {
    if (savedInSandbox === undefined) delete process.env.SKVM_IN_SANDBOX
    else process.env.SKVM_IN_SANDBOX = savedInSandbox
  })

  test("throws on native mode inside the sandbox", () => {
    process.env.SKVM_IN_SANDBOX = "1"
    expect(() => resolveAdapterConfigMode("native")).toThrow(/managed adapter mode/)
  })

  test("allows managed mode inside the sandbox", () => {
    process.env.SKVM_IN_SANDBOX = "1"
    expect(resolveAdapterConfigMode("managed")).toBe("managed")
  })

  test("allows native mode on the host (not in sandbox)", () => {
    delete process.env.SKVM_IN_SANDBOX
    expect(resolveAdapterConfigMode("native")).toBe("native")
  })
})

describe("SandboxConfigSchema", () => {
  test("accepts an empty object and fills defaults", () => {
    const parsed = SandboxConfigSchema.parse({})
    expect(parsed.docker.network).toBe("bridge")
    expect(parsed.docker.memory).toBe("2g")
    expect(parsed.docker.cpus).toBe("2")
    expect(parsed.docker.pidsLimit).toBe(512)
    expect(parsed.docker.image).toBeNull()
    expect(parsed.docker.extraMounts).toEqual([])
  })

  test("accepts a fully populated block", () => {
    const parsed = SandboxConfigSchema.parse({
      docker: {
        image: "ghcr.io/sjtu-ipads/skvm-sandbox:0.1.4",
        network: "none",
        memory: "4g",
        cpus: "4",
        pidsLimit: 1024,
        extraMounts: [{ host: "/home/x/.ssh", inner: "/root/.ssh", mode: "ro" }],
      },
    })
    expect(parsed.docker.image).toBe("ghcr.io/sjtu-ipads/skvm-sandbox:0.1.4")
    expect(parsed.docker.extraMounts[0]!.mode).toBe("ro")
  })

  test("rejects unknown network values", () => {
    expect(() => SandboxConfigSchema.parse({ docker: { network: "wifi" } })).toThrow()
  })

  test("rejects extra-mount with bad mode", () => {
    expect(() =>
      SandboxConfigSchema.parse({
        docker: { extraMounts: [{ host: "/x", inner: "/y", mode: "exec" }] },
      }),
    ).toThrow()
  })
})

describe("getSandboxConfig", () => {
  let tmp: string
  let savedCache: string | undefined

  beforeEach(() => {
    savedCache = process.env.SKVM_CACHE
    tmp = mkdtempSync(path.join(tmpdir(), "skvm-cfg-"))
    process.env.SKVM_CACHE = tmp
    invalidateConfigCache()
  })

  afterEach(() => {
    invalidateConfigCache()
    if (savedCache === undefined) delete process.env.SKVM_CACHE
    else process.env.SKVM_CACHE = savedCache
    rmSync(tmp, { recursive: true, force: true })
  })

  test("returns parsed defaults when the file has no sandbox slice", () => {
    writeFileSync(path.join(tmp, "skvm.config.json"), JSON.stringify({}))
    const sb = getSandboxConfig()
    expect(sb.docker.network).toBe("bridge")
    expect(sb.docker.memory).toBe("2g")
  })

  test("throws on malformed sandbox slice", () => {
    writeFileSync(
      path.join(tmp, "skvm.config.json"),
      JSON.stringify({ sandbox: { docker: { network: "wifi" } } }),
    )
    expect(() => getSandboxConfig()).toThrow()
  })
})

describe("resolveRouteApiKey", () => {
  // Restore env state between tests so the `SKVM_ROUTE_openai_KEY` etc. don't leak.
  let savedSandboxKey: string | undefined
  let savedCustomKey: string | undefined
  beforeEach(() => {
    savedSandboxKey = process.env.SKVM_ROUTE_openai_KEY
    savedCustomKey = process.env.MY_CUSTOM_KEY
    delete process.env.SKVM_ROUTE_openai_KEY
    delete process.env.MY_CUSTOM_KEY
  })
  afterEach(() => {
    if (savedSandboxKey === undefined) delete process.env.SKVM_ROUTE_openai_KEY
    else process.env.SKVM_ROUTE_openai_KEY = savedSandboxKey
    if (savedCustomKey === undefined) delete process.env.MY_CUSTOM_KEY
    else process.env.MY_CUSTOM_KEY = savedCustomKey
  })

  test("returns the in-config apiKey when present", () => {
    const route = { match: "openai", kind: "openai-compatible" as const, apiKey: "sk-direct" }
    expect(resolveRouteApiKey(route)).toBe("sk-direct")
  })

  test("falls back to SKVM_ROUTE_<safe-id>_KEY when apiKey is absent", () => {
    process.env.SKVM_ROUTE_openai_KEY = "sk-from-env"
    const route = { match: "openai", kind: "openai-compatible" as const }
    expect(resolveRouteApiKey(route)).toBe("sk-from-env")
  })

  test("honours apiKeyEnv when neither apiKey nor the standard fallback env are set", () => {
    process.env.MY_CUSTOM_KEY = "sk-custom"
    const route = { match: "openai", kind: "openai-compatible" as const, apiKeyEnv: "MY_CUSTOM_KEY" }
    expect(resolveRouteApiKey(route)).toBe("sk-custom")
  })

  test("safe-id replaces every non-alphanumeric run in the route match string", () => {
    expect(safeRouteId("openrouter/anthropic/claude-sonnet-4.6")).toBe("openrouter_anthropic_claude_sonnet_4_6")
    expect(safeRouteId("openai/*")).toBe("openai__")
  })
})
