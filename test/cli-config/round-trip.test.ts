import { describe, test, expect, afterEach } from "bun:test"
import path from "node:path"
import os from "node:os"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { loadExistingDraft, serialize } from "../../src/cli-config/index.ts"
import { invalidateConfigCache } from "../../src/core/config.ts"

/**
 * `skvm config init` rewrites the whole file from a `ConfigDraft`. The wizard
 * never prompts for `paths.tmpDir`, so it must survive re-init as an opaque
 * passthrough (the same guarantee the `headlessAgent` block already has) —
 * otherwise a hand-set temp dir is silently dropped on the next `init`.
 */
describe("config init round-trip: paths.tmpDir", () => {
  const savedCache = process.env.SKVM_CACHE
  const trash: string[] = []

  afterEach(() => {
    if (savedCache === undefined) delete process.env.SKVM_CACHE
    else process.env.SKVM_CACHE = savedCache
    invalidateConfigCache()
    for (const d of trash.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  test("loadExistingDraft preserves a hand-set paths.tmpDir and serialize re-emits it", () => {
    const cacheDir = mkdtempSync(path.join(os.tmpdir(), "cfg-roundtrip-"))
    trash.push(cacheDir)
    writeFileSync(
      path.join(cacheDir, "skvm.config.json"),
      JSON.stringify({
        paths: { tmpDir: "/srv/skvm-tmp" },
        providers: {
          routes: [{ match: "openrouter/*", kind: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY" }],
        },
      }),
    )
    process.env.SKVM_CACHE = cacheDir
    invalidateConfigCache()

    const draft = loadExistingDraft()
    expect(draft.paths?.tmpDir).toBe("/srv/skvm-tmp")

    const out = JSON.parse(serialize(draft))
    expect(out.paths).toEqual({ tmpDir: "/srv/skvm-tmp" })
  })

  test("serialize omits paths when no tmpDir is set (output stays minimal)", () => {
    const out = JSON.parse(serialize({ adapters: {}, providers: { routes: [] } }))
    expect(out.paths).toBeUndefined()
  })
})
