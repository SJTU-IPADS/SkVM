import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { appendDiscoveredRoute } from "../../src/core/config-write.ts"
import type { ProviderRoute } from "../../src/core/types.ts"

let tmp: string
let savedCache: string | undefined

beforeEach(() => {
  tmp = path.join(tmpdir(), `skvm-test-config-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmp, { recursive: true })
  savedCache = process.env.SKVM_CACHE
  process.env.SKVM_CACHE = tmp
})

afterEach(() => {
  if (savedCache === undefined) delete process.env.SKVM_CACHE
  else process.env.SKVM_CACHE = savedCache
  rmSync(tmp, { recursive: true, force: true })
})

function writeInitialConfig(content: object): string {
  const configPath = path.join(tmp, "skvm.config.json")
  writeFileSync(configPath, JSON.stringify(content, null, 2))
  return configPath
}

describe("appendDiscoveredRoute", () => {
  test("appends a new literal route at the top of providers.routes", async () => {
    const configPath = writeInitialConfig({
      providers: {
        routes: [
          { match: "gw/*", kind: "openai-compatible", baseUrl: "https://gw.example.com/v1", apiKey: "k" },
        ],
      },
    })
    const newRoute: ProviderRoute = {
      match: "gw/glm-5-thinking",
      kind: "anthropic",
      baseUrl: "https://gw.example.com",
      apiKey: "k",
      discoveredAt: "2026-05-19T00:00:00.000Z",
      discoveredFrom: "gw/*",
    }
    const result = await appendDiscoveredRoute(newRoute)
    expect(result.written).toBe(true)
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"))
    expect(parsed.providers.routes[0].match).toBe("gw/glm-5-thinking")
    expect(parsed.providers.routes[1].match).toBe("gw/*")
  })

  test("idempotent: skips write when a literal route with the same match exists", async () => {
    const configPath = writeInitialConfig({
      providers: {
        routes: [
          { match: "gw/glm-5-thinking", kind: "openai-compatible", baseUrl: "https://gw.example.com/v1", apiKey: "k" },
          { match: "gw/*", kind: "openai-compatible", baseUrl: "https://gw.example.com/v1", apiKey: "k" },
        ],
      },
    })
    const newRoute: ProviderRoute = {
      match: "gw/glm-5-thinking",
      kind: "anthropic",
      baseUrl: "https://gw.example.com",
      apiKey: "k",
      discoveredAt: "2026-05-19T00:00:00.000Z",
    }
    const result = await appendDiscoveredRoute(newRoute)
    expect(result.written).toBe(false)
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"))
    expect(parsed.providers.routes[0].kind).toBe("openai-compatible")
  })
})
