import { test, expect, describe } from "bun:test"
import { isPidAlive, parseHostPidFromLabel } from "../../src/launcher/stale-reap.ts"

describe("isPidAlive", () => {
  test("returns true for our own pid", () => {
    expect(isPidAlive(process.pid)).toBe(true)
  })

  test("returns false for pid 0 (invalid)", () => {
    expect(isPidAlive(0)).toBe(false)
  })

  test("returns false for an obviously-unused high pid", () => {
    expect(isPidAlive(2 ** 30)).toBe(false)
  })
})

describe("parseHostPidFromLabel", () => {
  test("extracts numeric pid from docker label output line", () => {
    expect(parseHostPidFromLabel("skvm-sandbox-host-pid=12345")).toBe(12345)
  })

  test("returns null for malformed labels", () => {
    expect(parseHostPidFromLabel("skvm-sandbox=1")).toBeNull()
    expect(parseHostPidFromLabel("garbage")).toBeNull()
  })
})
