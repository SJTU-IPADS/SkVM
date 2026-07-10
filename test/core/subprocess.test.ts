import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { runSubprocess } from "../../src/core/subprocess.ts"

function bunEval(source: string): string[] {
  return [process.execPath, "-e", source]
}

describe("runSubprocess: exit + output", () => {
  test("captures stdout/stderr and exit code 0 on success", async () => {
    const r = await runSubprocess(bunEval(
      'process.stdout.write("out\\n"); process.stderr.write("err\\n")',
    ))
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe("out")
    expect(r.stderr.trim()).toBe("err")
    expect(r.timedOut).toBe(false)
  })

  test("propagates a non-zero exit code", async () => {
    const r = await runSubprocess(bunEval("process.exit(3)"))
    expect(r.exitCode).toBe(3)
    expect(r.timedOut).toBe(false)
  })

  test("reports a plausible durationMs", async () => {
    const r = await runSubprocess(bunEval("await Bun.sleep(100)"))
    expect(r.durationMs).toBeGreaterThanOrEqual(50)
  })

  test("drains output larger than the OS pipe buffer without deadlock", async () => {
    // ~256 KB of stdout; without concurrent draining the child blocks on a
    // full pipe (~64 KB on macOS) while the parent waits on proc.exited.
    const r = await runSubprocess(bunEval('process.stdout.write("a".repeat(262144))'))
    expect(r.exitCode).toBe(0)
    expect(r.stdout.length).toBe(262144)
  })
})

describe("runSubprocess: timeout", () => {
  test("returns timedOut=true when the subprocess is killed by the timer", async () => {
    const r = await runSubprocess(bunEval("await Bun.sleep(10_000)"), { timeoutMs: 200 })
    expect(r.timedOut).toBe(true)
    expect(r.exitCode).not.toBe(0)
  })

  test("returns timedOut=false on natural completion", async () => {
    const r = await runSubprocess(bunEval('process.stdout.write("ok\\n")'), { timeoutMs: 5000 })
    expect(r.timedOut).toBe(false)
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe("ok")
  })
})

describe("runSubprocess: env overlay", () => {
  test("merges the overlay over process.env", async () => {
    const r = await runSubprocess(bunEval(
      'process.stdout.write(JSON.stringify([process.env.SKVM_SUBPROC_TEST, process.env.HOME ?? ""]))',
    ), {
      env: { SKVM_SUBPROC_TEST: "overlay-value" },
    })
    const [overlaid, home] = JSON.parse(r.stdout) as [string, string]
    expect(overlaid).toBe("overlay-value")
    // Inherited variables survive the merge.
    expect(home).toBe(process.env.HOME ?? "")
  })

  test("an undefined overlay value removes the variable from the child env", async () => {
    process.env.SKVM_SUBPROC_DELETED = "should-not-survive"
    try {
      const r = await runSubprocess(bunEval(
        'process.stdout.write(process.env.SKVM_SUBPROC_DELETED ?? "unset")',
      ), {
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
      const r = await runSubprocess(bunEval(
        'process.stdout.write(process.env.SKVM_SUBPROC_INHERIT ?? "")',
      ))
      expect(r.stdout.trim()).toBe("inherited")
    } finally {
      delete process.env.SKVM_SUBPROC_INHERIT
    }
  })
})

describe("runSubprocess: stdoutSink", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "skvm-subproc-sink-"))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  test("streams stdout verbatim to the sink file and returns stdout=''", async () => {
    const sink = path.join(tmpDir, "out.log")
    const r = await runSubprocess(bunEval(
      'process.stdout.write("hello\\nworld\\n")',
    ), { stdoutSink: sink })

    expect(r.stdout).toBe("")
    expect(r.stdoutFile).toBe(sink)
    expect(await Bun.file(sink).text()).toBe("hello\nworld\n")
  })

  test("streams output larger than the OS pipe buffer to the sink", async () => {
    // 1 MB of 'a' — well past the ~64 KB pipe buffer; would deadlock without
    // concurrent draining, and would OOM the old string path at GB scale.
    const sink = path.join(tmpDir, "big.log")
    const r = await runSubprocess(bunEval('process.stdout.write("a".repeat(1048576))'), {
      stdoutSink: sink,
    })

    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
    expect(await Bun.file(sink).size).toBe(1048576)
  })

  test("flushes partial content to the sink on timeout", async () => {
    // Echo 'a' immediately, then sleep past the timeout. The sink must hold
    // the 'a' line even though the child is killed mid-flight.
    const sink = path.join(tmpDir, "partial.log")
    const r = await runSubprocess(bunEval(
      'process.stdout.write("a\\n"); await Bun.sleep(10_000); process.stdout.write("b\\n")',
    ), {
      timeoutMs: 300,
      stdoutSink: sink,
    })

    expect(r.timedOut).toBe(true)
    const content = await Bun.file(sink).text()
    expect(content).toContain("a\n")
  })

  test("auto-creates the sink parent directory", async () => {
    const sink = path.join(tmpDir, "nested", "deeper", "out.log")
    const r = await runSubprocess(bunEval('process.stdout.write("deep\\n")'), {
      stdoutSink: sink,
    })

    expect(r.stdoutFile).toBe(sink)
    expect(await Bun.file(sink).text()).toBe("deep\n")
  })

  test("does not create the sink file when stdout is empty", async () => {
    // Lazy-open: a child that produces no stdout must not leave an empty file
    // behind — preserves the old `stdout.trim()` guard in pi.ts.
    const sink = path.join(tmpDir, "empty.log")
    const r = await runSubprocess(bunEval("process.exit(0)"), { stdoutSink: sink })

    expect(r.stdout).toBe("")
    expect(r.stdoutFile).toBeUndefined()
    expect(existsSync(sink)).toBe(false)
  })

  test("stderr is still buffered as a string when stdoutSink is set", async () => {
    const sink = path.join(tmpDir, "out.log")
    const r = await runSubprocess(bunEval(
      'process.stdout.write("out\\n"); process.stderr.write("err\\n")',
    ), { stdoutSink: sink })

    expect(r.stdout).toBe("")
    expect(r.stderr.trim()).toBe("err")
    expect(await Bun.file(sink).text()).toBe("out\n")
  })
})
