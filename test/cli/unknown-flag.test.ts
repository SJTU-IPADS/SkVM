import { describe, test, expect } from "bun:test"

const CLI = ["bun", "run", "src/index.ts"]

async function runCli(args: string[]): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn([...CLI, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  return { exitCode, stderr, stdout }
}

describe("CLI rejects unknown flags", () => {
  test("issue #12 — `skvm profile --adpter=claude-code` errors with a hint", async () => {
    const { exitCode, stderr } = await runCli([
      "profile",
      "--adpter=claude-code",
      "--model=anthropic/claude-sonnet-4.6",
    ])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Unknown flag --adpter")
    expect(stderr).toContain("Did you mean --adapter?")
  })

  test("run rejects --tsk (typo for --task)", async () => {
    const { exitCode, stderr } = await runCli([
      "run",
      "--tsk=foo.json",
      "--model=anthropic/claude-sonnet-4.6",
    ])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Unknown flag --tsk")
    expect(stderr).toContain("Did you mean --task?")
  })

  test("aot-compile rejects --skll (typo for --skill)", async () => {
    const { exitCode, stderr } = await runCli([
      "aot-compile",
      "--skll=foo",
      "--model=anthropic/claude-sonnet-4.6",
    ])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Unknown flag --skll")
    expect(stderr).toContain("Did you mean --skill?")
  })

  test("pipeline rejects --modle (typo for --model)", async () => {
    const { exitCode, stderr } = await runCli([
      "pipeline",
      "--skill=skvm-data/skills/calendar",
      "--modle=anthropic/claude-sonnet-4.6",
    ])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Unknown flag --modle")
    expect(stderr).toContain("Did you mean --model?")
  })

  test("bench rejects --adpter (typo for --adapter)", async () => {
    const { exitCode, stderr } = await runCli([
      "bench",
      "--adpter=bare-agent",
      "--model=anthropic/claude-sonnet-4.6",
    ])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Unknown flag --adpter")
    expect(stderr).toContain("Did you mean --adapter?")
  })

  test("jit-optimize rejects --rouns (typo for --rounds)", async () => {
    const { exitCode, stderr } = await runCli([
      "jit-optimize",
      "--skill=skvm-data/skills/calendar",
      "--task-source=synthetic",
      "--optimizer-model=anthropic/claude-sonnet-4.6",
      "--target-model=anthropic/claude-sonnet-4.6",
      "--rouns=3",
    ])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Unknown flag --rouns")
    expect(stderr).toContain("Did you mean --rounds?")
  })

  test("clean-jit rejects --adpter (typo for --adapter)", async () => {
    const { exitCode, stderr } = await runCli([
      "clean-jit",
      "--model=anthropic/claude-sonnet-4.6",
      "--adpter=bare-agent",
    ])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Unknown flag --adpter")
    expect(stderr).toContain("Did you mean --adapter?")
  })

  test("logs rejects --lmit (typo for --limit)", async () => {
    const { exitCode, stderr } = await runCli(["logs", "--lmit=5"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Unknown flag --lmit")
    expect(stderr).toContain("Did you mean --limit?")
  })

  test("proposals list rejects --skll (typo for --skill)", async () => {
    const { exitCode, stderr } = await runCli(["proposals", "list", "--skll=foo"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Unknown flag --skll")
    expect(stderr).toContain("Did you mean --skill?")
  })

  test("proposals show rejects --ful (typo for --full)", async () => {
    const { exitCode, stderr } = await runCli(["proposals", "show", "abc123", "--ful"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Unknown flag --ful")
    expect(stderr).toContain("Did you mean --full?")
  })

  test("proposals with unknown sub-command still rejects unknown flags", async () => {
    // Unknown sub-command falls through to an empty allow-set, so any flag is
    // unknown. This guards against a regression where `proposals liist --skll=foo`
    // silently skipped the flag check (the unknown sub gets reported by the
    // existing sub-command dispatcher below).
    const { exitCode, stderr } = await runCli(["proposals", "liist", "--skll=foo"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Unknown flag --skll")
  })

  test("proposals serve rejects --hst (typo for --host) — unknown flag without close match shows no hint", async () => {
    // Covers the no-hint code path end-to-end (unit-tested, but not via the
    // real CLI before this).
    const { exitCode, stderr } = await runCli(["proposals", "serve", "--xyzzy=1"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Unknown flag --xyzzy")
    expect(stderr).not.toContain("Did you mean")
  })
})
