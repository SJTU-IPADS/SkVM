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
})
