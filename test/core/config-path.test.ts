import { describe, test, expect, afterEach } from "bun:test"
import path from "node:path"
import {
  resolveConfigWritePath,
  getConfigPath,
  invalidateConfigCache,
} from "../../src/core/config.ts"

/**
 * Regression: a `SKVM_CACHE` value containing a leading `~/` must be expanded
 * to the user's home directory, exactly like `resolveCacheRoot()` does for the
 * cache root. Previously `resolveConfigWritePath()` ran `path.resolve(env)`
 * without `expandHome`, so `~/foo` was treated as cwd-relative and produced a
 * doubled path like `<cwd>/~/foo/skvm.config.json` — which then failed every
 * `existsSync`/`require`, silently dropping the whole config.
 */
describe("config path resolution with ~ in SKVM_CACHE", () => {
  const saved = process.env.SKVM_CACHE

  afterEach(() => {
    if (saved === undefined) delete process.env.SKVM_CACHE
    else process.env.SKVM_CACHE = saved
    invalidateConfigCache()
  })

  test("resolveConfigWritePath expands a leading ~ to $HOME", () => {
    process.env.SKVM_CACHE = "~/skvm-tilde-regression"
    invalidateConfigCache()

    const expected = path.join(process.env.HOME!, "skvm-tilde-regression", "skvm.config.json")
    const resolved = resolveConfigWritePath()

    expect(resolved).toBe(expected)
    expect(resolved).not.toContain(`${path.sep}~${path.sep}`)
  })

  test("getConfigPath falls back to the expanded write path when no file exists", () => {
    // Point at a tilde cache dir that has no config file on disk; getConfigPath
    // should return the expanded write path, not a cwd-relative ~ path.
    process.env.SKVM_CACHE = "~/skvm-tilde-regression-missing"
    invalidateConfigCache()

    const resolved = getConfigPath()
    expect(resolved.startsWith(process.env.HOME!)).toBe(true)
    expect(resolved).not.toContain(`${path.sep}~${path.sep}`)
  })
})
