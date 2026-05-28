import { test, expect, describe } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { writeSanitizedConfig } from "../../src/launcher/config-sanitize.ts"

describe("writeSanitizedConfig", () => {
  test("drops apiKey and rewrites apiKeyEnv to the injected env var", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "skvm-sancfg-"))
    const src = path.join(dir, "skvm.config.json")
    writeFileSync(src, JSON.stringify({
      providers: {
        routes: [
          { match: "openai/*", kind: "openai-compatible", apiKey: "sk-1" },
          { match: "x/*", kind: "openai-compatible", apiKeyEnv: "X_KEY" },
        ],
      },
    }))
    const out = writeSanitizedConfig(src, 99999)
    expect(existsSync(out)).toBe(true)
    expect(out).toMatch(/\/tmp\/skvm-launcher-99999\/skvm\.config\.json$/)
    const parsed = JSON.parse(readFileSync(out, "utf-8"))
    // No literal secret remains; apiKeyEnv points at the launcher-injected var,
    // keeping the route schema-valid (requires apiKey or apiKeyEnv).
    expect(parsed.providers.routes[0]).toEqual({
      match: "openai/*",
      kind: "openai-compatible",
      apiKeyEnv: "SKVM_ROUTE_openai___KEY",
    })
    expect(parsed.providers.routes[1]).toEqual({
      match: "x/*",
      kind: "openai-compatible",
      apiKeyEnv: "SKVM_ROUTE_x___KEY",
    })
    expect(JSON.stringify(parsed)).not.toContain("sk-1")
  })

  test("returns an empty-config path when host config is missing", () => {
    const out = writeSanitizedConfig("/nonexistent/skvm.config.json", 99998)
    expect(existsSync(out)).toBe(true)
    const parsed = JSON.parse(readFileSync(out, "utf-8"))
    expect(parsed).toEqual({})
  })
})
