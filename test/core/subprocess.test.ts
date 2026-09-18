import { test, expect, describe } from "bun:test"
import { runSubprocess } from "../../src/core/subprocess.ts"

function bunEval(source: string, executable = process.execPath): string[] {
  return [executable, "-e", source]
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

  test("decodes a UTF-8 character split across stdout chunks", async () => {
    const r = await runSubprocess(bunEval([
      "process.stdout.write(new Uint8Array([0xe4]))",
      "await Bun.sleep(50)",
      "process.stdout.write(new Uint8Array([0xbd, 0xa0]))",
    ].join("; ")))

    expect(r.stdout).toBe("你")
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

const windowsTest = process.platform === "win32" ? test : test.skip

describe("runSubprocess: Windows process handling", () => {
  windowsTest("resolves an MSYS drive path and its implicit .exe suffix", async () => {
    const withoutExe = process.execPath.replace(/\.exe$/i, "")
    const normalized = withoutExe.replace(/\\/g, "/")
    const match = /^([a-zA-Z]):\/(.*)$/.exec(normalized)
    expect(match).not.toBeNull()
    const msysPath = `/${match![1]!.toLowerCase()}/${match![2]}`

    const r = await runSubprocess(bunEval(
      'process.stdout.write("msys-ok")',
      msysPath,
    ))

    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("msys-ok")
  })

  windowsTest("kills a wrapper and its grandchild on timeout", async () => {
    const wrapper = [
      'const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30_000)"],',
      '  { stdout: "ignore", stderr: "ignore" });',
      'process.stdout.write(String(child.pid) + "\\n");',
      "await child.exited;",
    ].join("\n")

    const r = await runSubprocess(bunEval(wrapper), { timeoutMs: 500 })
    const grandchildPid = Number(r.stdout.trim())

    expect(r.timedOut).toBe(true)
    expect(r.durationMs).toBeLessThan(5000)
    expect(Number.isInteger(grandchildPid)).toBe(true)
    expect(() => process.kill(grandchildPid, 0)).toThrow()
  })
})
