import { describe, test, expect } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"

describe("bench --timeout-mult", () => {
  test("is rejected as unknown flag", () => {
    const result = spawnSync(
      "bun",
      ["run", path.resolve(__dirname, "../../src/index.ts"), "bench", "--timeout-mult=2"],
      { encoding: "utf8" },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr.toLowerCase()).toContain("unknown flag")
    expect(result.stderr).toContain("--timeout-mult")
  })
})
