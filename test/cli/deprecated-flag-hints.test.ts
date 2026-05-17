// test/cli/deprecated-flag-hints.test.ts
import { describe, test, expect } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"

const cli = path.resolve(__dirname, "../../src/index.ts")

function run(args: string[]): { code: number | null; stderr: string } {
  const r = spawnSync("bun", ["run", cli, ...args], { encoding: "utf8" })
  return { code: r.status, stderr: r.stderr }
}

describe("deprecated CLI flag → did-you-mean hint", () => {
  test("skvm run --timeoutMs suggests --timeout-ms", () => {
    const { code, stderr } = run(["run", "--timeoutMs=1000", "--task=/tmp/x"])
    expect(code).not.toBe(0)
    expect(stderr).toContain("--timeoutMs")
    expect(stderr).toContain("--timeout-ms")
  })

  test("skvm run --maxSteps suggests --max-steps", () => {
    const { code, stderr } = run(["run", "--maxSteps=10", "--task=/tmp/x"])
    expect(code).not.toBe(0)
    expect(stderr).toContain("--maxSteps")
    expect(stderr).toContain("--max-steps")
  })

  test("skvm jit-optimize --timeoutMs suggests --timeout-ms", () => {
    const { code, stderr } = run(["jit-optimize", "--timeoutMs=1000", "--skill=/tmp/x"])
    expect(code).not.toBe(0)
    expect(stderr).toContain("--timeoutMs")
    expect(stderr).toContain("--timeout-ms")
  })

  test("skvm jit-optimize --maxSteps suggests --max-steps", () => {
    const { code, stderr } = run(["jit-optimize", "--maxSteps=10", "--skill=/tmp/x"])
    expect(code).not.toBe(0)
    expect(stderr).toContain("--maxSteps")
    expect(stderr).toContain("--max-steps")
  })

  test("skvm bench --timeout-mult is rejected with no suggestion", () => {
    const { code, stderr } = run(["bench", "--timeout-mult=2"])
    expect(code).not.toBe(0)
    expect(stderr.toLowerCase()).toContain("unknown flag")
    expect(stderr).toContain("--timeout-mult")
  })
})
