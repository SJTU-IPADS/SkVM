import { test, expect, describe } from "bun:test"
import { resolveImageRef, buildBuildCommandHint } from "../../src/launcher/image.ts"

describe("resolveImageRef", () => {
  test("cli override wins over config and built-in", () => {
    expect(resolveImageRef({
      cliOverride: "custom:tag",
      configImage: "config:tag",
      skvmVersion: "0.1.4",
    })).toBe("custom:tag")
  })

  test("config wins over built-in when no cli override", () => {
    expect(resolveImageRef({
      cliOverride: null,
      configImage: "config:tag",
      skvmVersion: "0.1.4",
    })).toBe("config:tag")
  })

  test("built-in default uses skvm version", () => {
    expect(resolveImageRef({
      cliOverride: null,
      configImage: null,
      skvmVersion: "0.1.4",
    })).toBe("ghcr.io/sjtu-ipads/skvm-sandbox:0.1.4")
  })
})

describe("buildBuildCommandHint", () => {
  test("includes the resolved image ref so the user can copy-paste", () => {
    const hint = buildBuildCommandHint("ghcr.io/sjtu-ipads/skvm-sandbox:0.1.4")
    expect(hint).toContain("docker build")
    expect(hint).toContain("-f docker/skvm-sandbox.Dockerfile")
    expect(hint).toContain("-t ghcr.io/sjtu-ipads/skvm-sandbox:0.1.4")
  })
})
