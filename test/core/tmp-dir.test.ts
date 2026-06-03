import { describe, test, expect, afterEach } from "bun:test"
import path from "node:path"
import os from "node:os"
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { resolveTmpDir, getTmpDir, invalidateConfigCache } from "../../src/core/config.ts"

/**
 * Resolver for the unified temp-dir root (issue #16, path-config half).
 *
 * Precedence: --tmp-dir flag > SKVM_TMP_DIR env > paths.tmpDir config >
 * ${TMPDIR:-/tmp} (i.e. os.tmpdir()). Mirrors the env-override + cache-busting
 * harness used by config-path.test.ts.
 */
describe("resolveTmpDir / getTmpDir", () => {
  const savedTmp = process.env.SKVM_TMP_DIR
  const savedCache = process.env.SKVM_CACHE
  const trash: string[] = []

  afterEach(() => {
    if (savedTmp === undefined) delete process.env.SKVM_TMP_DIR
    else process.env.SKVM_TMP_DIR = savedTmp
    if (savedCache === undefined) delete process.env.SKVM_CACHE
    else process.env.SKVM_CACHE = savedCache
    invalidateConfigCache()
    for (const d of trash.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  test("defaults to os.tmpdir() when nothing is set", () => {
    delete process.env.SKVM_TMP_DIR
    invalidateConfigCache()
    expect(resolveTmpDir()).toBe(os.tmpdir())
  })

  test("SKVM_TMP_DIR env overrides the default", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tmpdir-env-"))
    trash.push(dir)
    process.env.SKVM_TMP_DIR = dir
    invalidateConfigCache()
    expect(resolveTmpDir()).toBe(dir)
  })

  test("expands a leading ~ in SKVM_TMP_DIR to $HOME", () => {
    process.env.SKVM_TMP_DIR = "~/skvm-tmp-tilde-regression"
    invalidateConfigCache()
    const expected = path.join(process.env.HOME!, "skvm-tmp-tilde-regression")
    expect(resolveTmpDir()).toBe(expected)
    expect(resolveTmpDir()).not.toContain(`${path.sep}~${path.sep}`)
  })

  test("falls back to paths.tmpDir from config when no env/flag", () => {
    const cacheDir = mkdtempSync(path.join(os.tmpdir(), "tmpdir-cfg-"))
    trash.push(cacheDir)
    const cfgTmp = path.join(cacheDir, "custom-tmp")
    writeFileSync(
      path.join(cacheDir, "skvm.config.json"),
      JSON.stringify({ paths: { tmpDir: cfgTmp } }),
    )
    delete process.env.SKVM_TMP_DIR
    process.env.SKVM_CACHE = cacheDir
    invalidateConfigCache()
    expect(resolveTmpDir()).toBe(cfgTmp)
  })

  test("SKVM_TMP_DIR env beats paths.tmpDir config (precedence)", () => {
    const cacheDir = mkdtempSync(path.join(os.tmpdir(), "tmpdir-prec-"))
    trash.push(cacheDir)
    writeFileSync(
      path.join(cacheDir, "skvm.config.json"),
      JSON.stringify({ paths: { tmpDir: path.join(cacheDir, "from-config") } }),
    )
    const envDir = path.join(cacheDir, "from-env")
    process.env.SKVM_CACHE = cacheDir
    process.env.SKVM_TMP_DIR = envDir
    invalidateConfigCache()
    expect(resolveTmpDir()).toBe(envDir)
  })

  test("--tmp-dir flag beats SKVM_TMP_DIR env (precedence)", () => {
    const flagDir = mkdtempSync(path.join(os.tmpdir(), "tmpdir-flag-"))
    trash.push(flagDir)
    process.env.SKVM_TMP_DIR = path.join(flagDir, "env")
    process.argv.push(`--tmp-dir=${flagDir}`)
    invalidateConfigCache()
    try {
      expect(resolveTmpDir()).toBe(flagDir)
    } finally {
      process.argv.pop()
    }
  })

  test("getTmpDir creates the resolved directory if it is absent", () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "tmpdir-ensure-"))
    trash.push(base)
    const target = path.join(base, "nested", "tmp")
    process.env.SKVM_TMP_DIR = target
    invalidateConfigCache()
    expect(existsSync(target)).toBe(false)
    expect(getTmpDir()).toBe(target)
    expect(existsSync(target)).toBe(true)
  })
})
