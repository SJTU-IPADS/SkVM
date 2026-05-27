import { test, expect, describe } from "bun:test"
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
