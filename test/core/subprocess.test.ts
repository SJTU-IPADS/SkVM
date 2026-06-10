import { test, expect, describe } from "bun:test"
import { runSubprocess } from "../../src/core/subprocess.ts"

describe("runSubprocess: exit + output", () => {
  test("captures stdout/stderr and exit code 0 on success", async () => {
    const r = await runSubprocess(["sh", "-c", "echo out; echo err >&2"])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe("out")
    expect(r.stderr.trim()).toBe("err")
    expect(r.timedOut).toBe(false)
  })

  test("propagates a non-zero exit code", async () => {
    const r = await runSubprocess(["sh", "-c", "exit 3"])
    expect(r.exitCode).toBe(3)
    expect(r.timedOut).toBe(false)
  })

  test("reports a plausible durationMs", async () => {
    const r = await runSubprocess(["sh", "-c", "sleep 0.1"])
    expect(r.durationMs).toBeGreaterThanOrEqual(50)
  })

  test("drains output larger than the OS pipe buffer without deadlock", async () => {
    // ~256 KB of stdout; without concurrent draining the child blocks on a
    // full pipe (~64 KB on macOS) while the parent waits on proc.exited.
    const r = await runSubprocess(["sh", "-c", 'head -c 262144 /dev/zero | tr "\\0" a'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.length).toBe(262144)
  })
})

describe("runSubprocess: timeout", () => {
  test("returns timedOut=true when the subprocess is killed by the timer", async () => {
    const r = await runSubprocess(["sleep", "10"], { timeoutMs: 200 })
    expect(r.timedOut).toBe(true)
    expect(r.exitCode).not.toBe(0)
  })

  test("returns timedOut=false on natural completion", async () => {
    const r = await runSubprocess(["sh", "-c", "echo ok"], { timeoutMs: 5000 })
    expect(r.timedOut).toBe(false)
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe("ok")
  })
})

describe("runSubprocess: env overlay", () => {
  test("merges the overlay over process.env", async () => {
    const r = await runSubprocess(["sh", "-c", 'echo "$SKVM_SUBPROC_TEST:$HOME"'], {
      env: { SKVM_SUBPROC_TEST: "overlay-value" },
    })
    const [overlaid, home] = r.stdout.trim().split(":")
    expect(overlaid).toBe("overlay-value")
    // Inherited variables survive the merge.
    expect(home).toBe(process.env.HOME ?? "")
  })

  test("an undefined overlay value removes the variable from the child env", async () => {
    process.env.SKVM_SUBPROC_DELETED = "should-not-survive"
    try {
      const r = await runSubprocess(["sh", "-c", 'echo "${SKVM_SUBPROC_DELETED:-unset}"'], {
        env: { SKVM_SUBPROC_DELETED: undefined, SKVM_SUBPROC_KEEP: "1" },
      })
      expect(r.stdout.trim()).toBe("unset")
    } finally {
      delete process.env.SKVM_SUBPROC_DELETED
    }
  })

  test("no env option inherits process.env unchanged", async () => {
    process.env.SKVM_SUBPROC_INHERIT = "inherited"
    try {
      const r = await runSubprocess(["sh", "-c", 'echo "$SKVM_SUBPROC_INHERIT"'])
      expect(r.stdout.trim()).toBe("inherited")
    } finally {
      delete process.env.SKVM_SUBPROC_INHERIT
    }
  })
})
