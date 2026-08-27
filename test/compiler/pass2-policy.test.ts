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
  test("pip deps route through the template helpers (never raw pip)", () => {
    const platform = mkPlatform("macos", {
      packageManagers: { ...mkPlatform("macos").packageManagers, brew: true },
    })
    const policy = createInstallPolicy(platform)
    expect(policy.pipInstallPrefix).toBe("pip_install")
    expect(policy.pipCheckPrefix).toBe("pip_check")
    expect(policy.notes.join(" ")).toContain("fall")
  })

  test("pip-less platform notes the venv bootstrap", () => {
    const platform = mkPlatform("linux", {
      packageManagers: { ...mkPlatform("linux").packageManagers, pip: false },
    })
    const policy = createInstallPolicy(platform)
    expect(policy.pipInstallPrefix).toBe("pip_install")
    expect(policy.notes.join(" ")).toContain("SKVM_ENV_DIR")
  })

  test("normalized pip dependency uses the helpers", () => {
    const deps: DependencyEntry[] = [{
      name: "reportlab",
      type: "pip",
      checkCommand: "",
      required: true,
      source: "model",
      confidence: 0.9,
    }]
    const normalized = normalizeDependenciesForPlatform(deps, mkPlatform("linux"))
    expect(normalized[0]?.checkCommand).toBe("pip_check reportlab")
    expect(normalized[0]?.installCommand).toBe("pip_install reportlab")
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

describe("pip commands are rewritten, not merely filled in", () => {
  const pipLess = {
    os: "linux",
    packageManagers: { pip: false, npm: true, apt: true },
    python: { python3: true },
  } as never

  test("the extractor's own `pip show` / `pip install` are routed through the helpers", () => {
    // The prompt asks the extraction model for `pip show <pkg>` / `pip install
    // <pkg>`, and mergeImportHints hardcodes `python -m pip …`. Both are
    // non-empty, so a `dep.checkCommand || …` fallback never fired for them —
    // on a pip-less host the script still shelled out to pip and failed exactly
    // as it did before the helpers existed.
    const [llmExtracted, importHint] = normalizeDependenciesForPlatform([
      { name: "pandas", type: "pip", checkCommand: "pip show pandas", installCommand: "pip install pandas", required: true, source: "model" },
      { name: "reportlab", type: "pip", checkCommand: "python -m pip show reportlab", installCommand: "python3 -m pip install --user reportlab", required: true, source: "python-import" },
    ] as never, pipLess)

    expect(llmExtracted!.checkCommand).toBe("pip_check pandas")
    expect(llmExtracted!.installCommand).toBe("pip_install pandas")
    expect(importHint!.checkCommand).toBe("pip_check reportlab")
    expect(importHint!.installCommand).toBe("pip_install reportlab")
  })

  test("a version spec is quoted on BOTH commands", () => {
    // `pip_check reportlab>=4.0 >/dev/null` parses as `pip_check reportlab`
    // plus a redirect: wrong package checked, and a file named `=4.0` created.
    const [dep] = normalizeDependenciesForPlatform([
      { name: "reportlab>=4.0", type: "pip", checkCommand: "", installCommand: "", required: true, source: "model" },
    ] as never, pipLess)

    expect(dep!.checkCommand).toBe("pip_check 'reportlab>=4.0'")
    expect(dep!.installCommand).toBe("pip_install 'reportlab>=4.0'")
  })

  test("rewriting is idempotent and leaves non-pip commands alone", () => {
    // Repair passes re-normalize, and a dependency may legitimately be checked
    // by importing it rather than by asking pip.
    const [already, custom] = normalizeDependenciesForPlatform([
      { name: "pandas", type: "pip", checkCommand: "pip_check pandas", installCommand: "pip_install pandas", required: true, source: "model" },
      { name: "lxml", type: "pip", checkCommand: "python -c 'import lxml'", installCommand: "", required: true, source: "model" },
    ] as never, pipLess)

    expect(already!.checkCommand).toBe("pip_check pandas")
    expect(custom!.checkCommand).toBe("python -c 'import lxml'")
    expect(custom!.installCommand).toBe("pip_install lxml")
  })
})
