import { describe, test, expect, afterEach } from "bun:test"
import { buildWorkerEnv } from "../../src/jit-optimize/detach.ts"
import { SKVM_CACHE, SKVM_DATA_DIR, invalidateConfigCache } from "../../src/core/config.ts"

/**
 * Detached jit-optimize workers are spawned with only the worker subcommand +
 * JSON payload — never the parent's global path flags. The temp/cache/data
 * roots are re-resolved globally inside the worker, so the parent must forward
 * its *resolved* roots via the child env. Otherwise a run launched with
 * `--tmp-dir=/fast` (a flag, not the env var) would write under the wrong root.
 */
describe("detach worker env forwarding", () => {
  const savedTmp = process.env.SKVM_TMP_DIR

  afterEach(() => {
    if (savedTmp === undefined) delete process.env.SKVM_TMP_DIR
    else process.env.SKVM_TMP_DIR = savedTmp
    invalidateConfigCache()
  })

  test("forwards a --tmp-dir flag as SKVM_TMP_DIR so the detached worker honors it", () => {
    delete process.env.SKVM_TMP_DIR
    process.argv.push("--tmp-dir=/fasttmp/skvm")
    invalidateConfigCache()
    try {
      const env = buildWorkerEnv({ PATH: "/usr/bin" })
      expect(env.SKVM_TMP_DIR).toBe("/fasttmp/skvm")   // flag → env for the child
      expect(env.PATH).toBe("/usr/bin")                 // base env preserved
      expect(env.SKVM_CACHE).toBe(SKVM_CACHE)           // sibling roots forwarded too
      expect(env.SKVM_DATA_DIR).toBe(SKVM_DATA_DIR)
    } finally {
      process.argv.pop()
    }
  })

  test("forwards the SKVM_TMP_DIR env value when no flag is set", () => {
    process.env.SKVM_TMP_DIR = "/var/tmp/skvm-detach"
    invalidateConfigCache()
    const env = buildWorkerEnv({})
    expect(env.SKVM_TMP_DIR).toBe("/var/tmp/skvm-detach")
  })
})
