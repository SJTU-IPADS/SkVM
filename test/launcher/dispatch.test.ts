import { test, expect, describe } from "bun:test"
import { shouldEnterLauncher, parseSandboxFlag } from "../../src/index.ts"

describe("parseSandboxFlag", () => {
  test("--sandbox alone means true", () => {
    expect(parseSandboxFlag(["--sandbox", "run"])).toEqual({ value: true, present: true })
  })

  test("--sandbox=true means true", () => {
    expect(parseSandboxFlag(["--sandbox=true"])).toEqual({ value: true, present: true })
  })

  test("--sandbox=false means false (explicit opt-out)", () => {
    expect(parseSandboxFlag(["--sandbox=false"])).toEqual({ value: false, present: true })
  })

  test("absent means present:false", () => {
    expect(parseSandboxFlag(["run", "--skill=/x"])).toEqual({ value: false, present: false })
  })
})

describe("shouldEnterLauncher", () => {
  test("explicit --sandbox + not in container → enter launcher", () => {
    expect(shouldEnterLauncher({
      parsed: { value: true, present: true },
      defaultsSandbox: false,
      inSandboxEnv: false,
    })).toBe(true)
  })

  test("default config sandbox=true + flag absent + not in container → enter launcher", () => {
    expect(shouldEnterLauncher({
      parsed: { value: false, present: false },
      defaultsSandbox: true,
      inSandboxEnv: false,
    })).toBe(true)
  })

  test("explicit --sandbox=false overrides config default", () => {
    expect(shouldEnterLauncher({
      parsed: { value: false, present: true },
      defaultsSandbox: true,
      inSandboxEnv: false,
    })).toBe(false)
  })

  test("never enters launcher when SKVM_IN_SANDBOX=1", () => {
    expect(shouldEnterLauncher({
      parsed: { value: true, present: true },
      defaultsSandbox: false,
      inSandboxEnv: true,
    })).toBe(false)
  })
})
