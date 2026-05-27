import { test, expect, describe } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SandboxConfigSchema } from "../../src/core/types.ts"

describe("SandboxConfigSchema", () => {
  test("accepts an empty object and fills defaults", () => {
    const parsed = SandboxConfigSchema.parse({})
    expect(parsed.docker.network).toBe("bridge")
    expect(parsed.docker.memory).toBe("2g")
    expect(parsed.docker.cpus).toBe("2")
    expect(parsed.docker.pidsLimit).toBe(512)
    expect(parsed.docker.image).toBeNull()
    expect(parsed.docker.extraMounts).toEqual([])
  })

  test("accepts a fully populated block", () => {
    const parsed = SandboxConfigSchema.parse({
      docker: {
        image: "ghcr.io/SJTU-IPADS/skvm-sandbox:0.1.4",
        network: "none",
        memory: "4g",
        cpus: "4",
        pidsLimit: 1024,
        extraMounts: [{ host: "/home/x/.ssh", inner: "/root/.ssh", mode: "ro" }],
      },
    })
    expect(parsed.docker.image).toBe("ghcr.io/SJTU-IPADS/skvm-sandbox:0.1.4")
    expect(parsed.docker.extraMounts[0]!.mode).toBe("ro")
  })

  test("rejects unknown network values", () => {
    expect(() => SandboxConfigSchema.parse({ docker: { network: "wifi" } })).toThrow()
  })

  test("rejects extra-mount with bad mode", () => {
    expect(() =>
      SandboxConfigSchema.parse({
        docker: { extraMounts: [{ host: "/x", inner: "/y", mode: "exec" }] },
      }),
    ).toThrow()
  })
})

describe("getSandboxConfig", () => {
  test("returns parsed defaults when the file has no sandbox slice", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "skvm-cfg-"))
    writeFileSync(path.join(tmp, "skvm.config.json"), JSON.stringify({}))
    process.env.SKVM_CACHE = tmp
    const { invalidateConfigCache, getSandboxConfig } = require("../../src/core/config.ts")
    invalidateConfigCache()
    const sb = getSandboxConfig()
    expect(sb.docker.network).toBe("bridge")
    expect(sb.docker.memory).toBe("2g")
  })

  test("throws on malformed sandbox slice", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "skvm-cfg-bad-"))
    writeFileSync(
      path.join(tmp, "skvm.config.json"),
      JSON.stringify({ sandbox: { docker: { network: "wifi" } } }),
    )
    process.env.SKVM_CACHE = tmp
    const { invalidateConfigCache, getSandboxConfig } = require("../../src/core/config.ts")
    invalidateConfigCache()
    expect(() => getSandboxConfig()).toThrow()
  })
})
