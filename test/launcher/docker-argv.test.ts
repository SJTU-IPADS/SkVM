import { test, expect, describe } from "bun:test"
import { buildDockerRunArgv } from "../../src/launcher/docker-argv.ts"

describe("buildDockerRunArgv", () => {
  const base = {
    mountArgv: ["-v", "/x:/workspace:rw"],
    env: { SKVM_IN_SANDBOX: "1", HOME: "/workspace" },
    image: "skvm-sandbox:0.1.4",
    networkMode: "bridge" as const,
    resourceLimits: { memory: "2g", cpus: "2", pidsLimit: 512 },
    hostUid: 1000,
    hostGid: 1000,
    hostPid: 9999,
    command: ["skvm", "run", "--skill=/workspace/foo"],
  }

  test("throws when an env value contains a newline", () => {
    expect(() => buildDockerRunArgv({
      ...base,
      env: { ...base.env, SKVM_ROUTE_x_KEY: "sk-abc\n" },
    })).toThrow(/newline or NUL/)
  })

  test("includes hardening flags", () => {
    const argv = buildDockerRunArgv(base)
    expect(argv).toContain("--rm")
    expect(argv).toContain("--cap-drop=ALL")
    expect(argv).toContain("--security-opt")
    expect(argv).toContain("no-new-privileges")
    expect(argv).toContain("-u")
    expect(argv).toContain("1000:1000")
  })

  test("applies resource limits", () => {
    const argv = buildDockerRunArgv(base)
    expect(argv).toContain("--memory=2g")
    expect(argv).toContain("--cpus=2")
    expect(argv).toContain("--pids-limit=512")
  })

  test("applies network mode", () => {
    const argv = buildDockerRunArgv(base)
    expect(argv).toContain("--network=bridge")
  })

  test("labels include host pid for stale-reap", () => {
    const argv = buildDockerRunArgv(base)
    expect(argv).toContain("skvm-sandbox=1")
    expect(argv).toContain("skvm-sandbox-host-pid=9999")
  })

  test("forwards env via -e", () => {
    const argv = buildDockerRunArgv(base)
    expect(argv).toContain("-e")
    expect(argv).toContain("SKVM_IN_SANDBOX=1")
    expect(argv).toContain("HOME=/workspace")
  })

  test("workdir is /workspace", () => {
    const argv = buildDockerRunArgv(base)
    expect(argv).toContain("-w")
    expect(argv).toContain("/workspace")
  })

  test("image precedes command", () => {
    const argv = buildDockerRunArgv(base)
    const i = argv.indexOf("skvm-sandbox:0.1.4")
    const j = argv.indexOf("skvm")
    expect(i).toBeGreaterThan(-1)
    expect(j).toBeGreaterThan(i)
  })
})
