import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { TCP } from "../../src/core/types.ts"

// PROFILES_DIR is frozen at module load, so integration tests below write to the real
// profiles directory under unique `test/...` model names. The global test preload
// (test/helpers/test-env.ts, registered in bunfig.toml) prunes every `test--*` subdir
// at process exit so the run leaves no on-disk footprint.

let tempDir: string

function makeTCP(overrides: Partial<TCP> = {}): TCP {
  return {
    version: "1.0",
    model: "openrouter/qwen/qwen3-30b",
    harness: "bare-agent",
    profiledAt: "2026-04-03T11:39:57.566Z",
    capabilities: { "reason.arithmetic": "L2" },
    details: [{
      primitiveId: "reason.arithmetic",
      highestLevel: "L2",
      levelResults: [
        { level: "L3", passed: false, passCount: 1, totalCount: 3, durationMs: 100, costUsd: 0, testDescription: "L3 test", failureDetails: ["failed"] },
        { level: "L2", passed: true, passCount: 3, totalCount: 3, durationMs: 90, costUsd: 0, testDescription: "L2 test", failureDetails: [] },
      ],
    }],
    cost: {
      totalUsd: 0,
      totalTokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      durationMs: 190,
    },
    isPartial: false,
    ...overrides,
  }
}

// ---- sanitizeTimestamp tests (pure function, no FS) ----

import { sanitizeTimestamp } from "../../src/profiler/cache.ts"

describe("sanitizeTimestamp", () => {
  test("strips colons, dashes, and milliseconds", () => {
    expect(sanitizeTimestamp("2026-04-03T11:39:57.566Z")).toBe("20260403T113957Z")
  })

  test("handles no milliseconds", () => {
    expect(sanitizeTimestamp("2026-04-03T11:39:57Z")).toBe("20260403T113957Z")
  })

  test("handles different millisecond lengths", () => {
    expect(sanitizeTimestamp("2026-12-31T23:59:59.9Z")).toBe("20261231T235959Z")
  })
})

// ---- Integration tests using real temp directory ----
// We can't easily mock PROFILES_DIR, so we test via the functions directly
// by writing/reading from a known directory structure.

describe("versioned profile storage (integration)", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "skvm-cache-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test("saveProfile creates directory with latest.json and v_*.json", async () => {
    // We'll test the storage layout by manually implementing what saveProfile does
    // using the same logic, since we can't redirect PROFILES_DIR easily.
    // Instead, let's use the actual module and verify the structure at PROFILES_DIR.

    // For a proper integration test, we use dynamic imports and env.
    // But since PROFILES_DIR is a constant, we test the actual save/load cycle.
    const { saveProfile, loadProfile, hasProfile, listProfiles } = await import("../../src/profiler/cache.ts")

    // Use a unique model to avoid leftovers from prior runs
    const model = `test/save-basic-${Date.now()}`
    const tcp = makeTCP({ model })
    const savedPath = await saveProfile(tcp)

    // Verify latest.json exists
    expect(savedPath).toEndWith("latest.json")
    const latestFile = Bun.file(savedPath)
    expect(await latestFile.exists()).toBe(true)

    // Verify versioned file exists
    const dir = path.dirname(savedPath)
    const files = await readdir(dir)
    const versionFiles = files.filter((f) => f.startsWith("v_"))
    expect(versionFiles.length).toBe(1)
    expect(versionFiles[0]).toBe("v_20260403T113957Z.json")

    // Verify loadProfile returns the saved data
    const loaded = await loadProfile(model, "bare-agent")
    expect(loaded).not.toBeNull()
    expect(loaded!.model).toBe(model)
    expect(loaded!.harness).toBe("bare-agent")

    // Verify hasProfile
    expect(await hasProfile(model, "bare-agent")).toBe(true)
    expect(await hasProfile("nonexistent/model", "bare-agent")).toBe(false)
  })

  test("re-save preserves old version and updates latest", async () => {
    const { saveProfile, loadProfile, listProfileVersions } = await import("../../src/profiler/cache.ts")

    // Use a unique model to avoid cross-test contamination (tests share PROFILES_DIR)
    const model = "test/resave-model"

    const tcp1 = makeTCP({ model, profiledAt: "2026-04-01T10:00:00.000Z" })
    await saveProfile(tcp1)

    const tcp2 = makeTCP({
      model,
      profiledAt: "2026-04-05T15:30:00.000Z",
      capabilities: { "reason.arithmetic": "L3" },
    })
    await saveProfile(tcp2)

    // latest should be tcp2
    const loaded = await loadProfile(model, "bare-agent")
    expect(loaded!.capabilities["reason.arithmetic"]).toBe("L3")
    expect(loaded!.profiledAt).toBe("2026-04-05T15:30:00.000Z")

    // Both versions should exist
    const versions = await listProfileVersions(model, "bare-agent")
    expect(versions.length).toBe(2)
    // Sorted newest first
    expect(versions[0]!.version).toBe("20260405T153000Z")
    expect(versions[1]!.version).toBe("20260401T100000Z")
  })

  test("loadProfileVersion loads specific archived version", async () => {
    const { saveProfile, loadProfileVersion } = await import("../../src/profiler/cache.ts")

    // Use a unique model to avoid cross-test contamination
    const model = "test/version-model"

    const tcp1 = makeTCP({
      model,
      profiledAt: "2026-04-01T10:00:00.000Z",
      capabilities: { "reason.arithmetic": "L1" },
    })
    await saveProfile(tcp1)

    const tcp2 = makeTCP({
      model,
      profiledAt: "2026-04-05T15:30:00.000Z",
      capabilities: { "reason.arithmetic": "L3" },
    })
    await saveProfile(tcp2)

    // Load old version
    const old = await loadProfileVersion(model, "bare-agent", "20260401T100000Z")
    expect(old).not.toBeNull()
    expect(old!.capabilities["reason.arithmetic"]).toBe("L1")

    // Load new version
    const newer = await loadProfileVersion(model, "bare-agent", "20260405T153000Z")
    expect(newer).not.toBeNull()
    expect(newer!.capabilities["reason.arithmetic"]).toBe("L3")

    // Non-existent version
    const missing = await loadProfileVersion(model, "bare-agent", "19990101T000000Z")
    expect(missing).toBeNull()
  })

  test("listProfiles includes profiles from versioned directories", async () => {
    const { saveProfile, listProfiles } = await import("../../src/profiler/cache.ts")

    const ts = Date.now()
    const modelA = `test/list-a-${ts}`
    const modelB = `test/list-b-${ts}`

    await saveProfile(makeTCP({ model: modelA, harness: "bare-agent" }))
    await saveProfile(makeTCP({ model: modelB, harness: "openclaw" }))

    const profiles = await listProfiles()
    const found = profiles.filter(
      (p) =>
        (p.model === modelA && p.harness === "bare-agent") ||
        (p.model === modelB && p.harness === "openclaw"),
    )
    expect(found.length).toBe(2)
  })

  test("listProfileVersions returns empty for non-existent model", async () => {
    const { listProfileVersions } = await import("../../src/profiler/cache.ts")
    const versions = await listProfileVersions("nonexistent/model", "bare-agent")
    expect(versions).toEqual([])
  })
})
