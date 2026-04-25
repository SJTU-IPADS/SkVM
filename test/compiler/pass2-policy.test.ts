import { describe, test, expect } from "bun:test"
import { createInstallPolicy, normalizeDependenciesForPlatform } from "../../src/compiler/passes/bind-env/install-policy.ts"
import type { PlatformContext } from "../../src/compiler/passes/bind-env/platform.ts"
import type { DependencyEntry } from "../../src/core/types.ts"

function mkPlatform(os: PlatformContext["os"], overrides?: Partial<PlatformContext>): PlatformContext {
  return {
    os,
    arch: "x64",
    packageManagers: {
      brew: false,
      apt: false,
      yum: false,
      dnf: false,
      winget: false,
      choco: false,
      pip: true,
      npm: true,
    },
    python: {
      condaActive: false,
      venvActive: false,
    },
    ...overrides,
  }
}

describe("pass2 install policy", () => {
  test("macOS prefers python -m pip and records fallback note without venv", () => {
    const platform = mkPlatform("macos", {
      packageManagers: { ...mkPlatform("macos").packageManagers, brew: true },
    })
    const policy = createInstallPolicy(platform)
    expect(policy.pipInstallPrefix).toBe("python -m pip install")
    expect(policy.notes.join(" ")).toContain("fallback")
  })

  test("linux system dependency prefers apt when available", () => {
    const platform = mkPlatform("linux", {
      packageManagers: { ...mkPlatform("linux").packageManagers, apt: true },
    })

    const deps: DependencyEntry[] = [{
      name: "jq",
      type: "system",
      checkCommand: "",
      required: true,
      source: "model",
      confidence: 0.8,
    }]

    const normalized = normalizeDependenciesForPlatform(deps, platform)
    expect(normalized[0]?.installCommand).toContain("apt-get")
    expect(normalized[0]?.installCommand).not.toContain("apt-get update")
    expect(normalized[0]?.checkCommand).toBe("command -v jq")
  })

  test("windows system dependency prefers winget", () => {
    const platform = mkPlatform("windows", {
      packageManagers: { ...mkPlatform("windows").packageManagers, winget: true },
    })

    const deps: DependencyEntry[] = [{
      name: "Git.Git",
      type: "system",
      checkCommand: "",
      required: true,
      source: "model",
      confidence: 0.8,
    }]

    const normalized = normalizeDependenciesForPlatform(deps, platform)
    expect(normalized[0]?.installCommand).toContain("winget install")
  })
})
