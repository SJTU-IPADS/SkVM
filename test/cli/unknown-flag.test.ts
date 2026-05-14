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
})
