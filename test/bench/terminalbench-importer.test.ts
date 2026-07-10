import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { importTerminalBench } from "../../src/bench/importers/terminalbench.ts"
import { tbGrade } from "../../src/bench/evaluators/tb-grade.ts"

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe("Terminal-Bench importer", () => {
  test("writes one finalized task and preserves test bytes and modes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "skvm-tb-import-"))
    cleanups.push(root)
    const taskSource = path.join(root, "repo", "tasks", "demo")
    const testsSource = path.join(taskSource, "tests")
    const tasksDir = path.join(root, "output")
    await mkdir(testsSource, { recursive: true })
    await Bun.write(path.join(taskSource, "task.toml"), [
      "[task]",
      'name = "Demo"',
      "[environment]",
      'docker_image = "example/demo:latest"',
      "[agent]",
      "timeout_sec = 30",
    ].join("\n"))
    await Bun.write(path.join(taskSource, "instruction.md"), "Edit /app/main.py\n")
    const testSh = path.join(testsSource, "test.sh")
    await Bun.write(testSh, "#!/bin/sh\r\necho ok\r\n")
    if (process.platform !== "win32") await chmod(testSh, 0o755)
    const binary = new Uint8Array([0, 13, 10, 255, 128, 1])
    await Bun.write(path.join(testsSource, "fixture.bin"), binary)

    const result = await importTerminalBench(path.join(root, "repo"), {
      tasks: ["demo"],
      tasksDir,
    })

    expect(result.errors).toEqual([])
    expect(result.imported).toHaveLength(1)
    const outDir = path.join(tasksDir, "tb-demo")
    const taskJson = JSON.parse(await Bun.file(path.join(outDir, "task.json")).text())
    const criterion = taskJson.eval[0]
    const expectedTestsDir = path.join(outDir, "tests")
    expect(taskJson.tbTestsDir).toBe(expectedTestsDir)
    expect(criterion.payload.testsDir).toBe(expectedTestsDir)
    expect(await Bun.file(path.join(expectedTestsDir, "test.sh")).text()).toBe(
      "#!/bin/sh\necho ok\n",
    )
    expect(new Uint8Array(await readFile(path.join(expectedTestsDir, "fixture.bin")))).toEqual(binary)
    if (process.platform !== "win32") {
      expect((await stat(path.join(expectedTestsDir, "test.sh"))).mode & 0o777).toBe(0o755)
    }
  })

  test("tb-grade rejects a relative testsDir before invoking Docker", async () => {
    const integrity = await tbGrade.checkIntegrity!(
      {
        method: "custom",
        evaluatorId: "tb-grade",
        id: "tb-grade",
        name: "TB",
        weight: 1,
        payload: {
          dockerImage: "example/demo:latest",
          testsDir: "tests",
          verifierTimeoutSec: 30,
        },
      },
      { taskDir: "/unused", fixturesDir: "/unused/fixtures" },
    )

    expect(integrity.ok).toBe(false)
    if (!integrity.ok) expect(integrity.reason).toContain("absolute path")
  })
})
