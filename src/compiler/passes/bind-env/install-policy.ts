import type { DependencyEntry } from "../../../core/types.ts"
import type { PlatformContext } from "./platform.ts"

export interface InstallPolicy {
  pipInstallPrefix: string
  pipCheckPrefix: string
  systemInstallTemplate: (name: string) => string
  notes: string[]
}

function systemInstallFor(platform: PlatformContext): (name: string) => string {
  if (platform.os === "macos" && platform.packageManagers.brew) {
    return (name: string) => `brew install ${name}`
  }

  if (platform.os === "windows") {
    if (platform.packageManagers.winget) {
      return (name: string) => `winget install --id ${name} -e`
    }
    if (platform.packageManagers.choco) {
      return (name: string) => `choco install -y ${name}`
    }
  }

  if (platform.packageManagers.apt) {
    return (name: string) => `apt-get install -y ${name}`
  }
  if (platform.packageManagers.dnf) {
    return (name: string) => `dnf install -y ${name}`
  }
  if (platform.packageManagers.yum) {
    return (name: string) => `yum install -y ${name}`
  }

  return (name: string) => `echo "No supported system package manager found for ${name}" && exit 1`
}

export function createInstallPolicy(platform: PlatformContext): InstallPolicy {
  const notes: string[] = []

  // pip deps always go through the template's pip_check/pip_install helpers:
  // they resolve the interpreter (active conda/venv → system python3/python)
  // and bootstrap a private venv at $SKVM_ENV_DIR when no usable pip exists
  // (module absent, or system installs blocked by PEP 668). Never emit raw
  // `pip`/`python -m pip` — it breaks on hosts without pip.
  if (platform.os === "macos") {
    if (platform.python.condaActive) {
      notes.push("macOS: conda environment detected; pip_install targets the conda-scoped python.")
    } else if (platform.python.venvActive) {
      notes.push("macOS: venv detected; pip_install targets the venv-scoped python.")
    } else {
      notes.push("macOS: no conda/venv detected; pip_install falls back to system python or a bootstrapped venv.")
    }
  } else {
    notes.push("Linux/Windows: detect existing environment first and prefer pip/npm when available.")
  }
  if (!platform.packageManagers.pip) {
    notes.push("No system pip detected: pip_install will bootstrap a private venv at $SKVM_ENV_DIR (default ./.skvm-env).")
  }

  return {
    pipInstallPrefix: "pip_install",
    pipCheckPrefix: "pip_check",
    systemInstallTemplate: systemInstallFor(platform),
    notes,
  }
}

/**
 * Route a pip command through the template's helpers.
 *
 * An empty command gets the canonical form. A command that already invokes the
 * helper is left alone (idempotent — this runs on repair passes too). Anything
 * that shells out to pip directly (`pip install x`, `python -m pip show x`,
 * `python3 -m pip install --user x`) is replaced, because the helper is the only
 * form that works when the interpreter has no pip or refuses to install into it.
 * A command doing something else entirely is preserved.
 */
export function rewritePipCommand(
  command: string | undefined,
  canonical: string,
  helper: string,
): string {
  const trimmed = (command ?? "").trim()
  if (trimmed.length === 0) return canonical
  if (new RegExp(`(^|[;&|]\\s*)${helper}\\b`).test(trimmed)) return trimmed
  const invokesPipDirectly = /(^|[;&|]\s*)(\S*python[0-9.]*\s+-m\s+pip|pip[0-9.]*)\b/.test(trimmed)
  return invokesPipDirectly ? canonical : trimmed
}

export function normalizeDependenciesForPlatform(
  dependencies: DependencyEntry[],
  platform: PlatformContext,
): DependencyEntry[] {
  const policy = createInstallPolicy(platform)

  return dependencies.map((dep) => {
    if (dep.type === "pip") {
      // Quote package specs containing version operators to prevent shell
      // redirection: `pip_check reportlab>=4.0 >/dev/null` otherwise parses as
      // `pip_check reportlab` plus a redirect, checking the wrong package and
      // leaving a file named `=4.0` behind.
      const needsQuote = /[><=!~ ]/.test(dep.name)
      const quotedName = needsQuote ? `'${dep.name}'` : dep.name
      // REWRITE rather than fill in the blanks. The extractor populates these
      // fields on essentially every dependency — the prompt asks for
      // `pip show`/`pip install`, and the import-hint path hardcodes
      // `python -m pip …` — so a `dep.checkCommand || …` fallback only ever
      // fired for the version-spec case that leaves them empty. On the
      // pip-less/PEP 668 hosts this policy exists for, everything else went
      // out as raw pip and failed exactly as before.
      return {
        ...dep,
        checkCommand: rewritePipCommand(dep.checkCommand, `${policy.pipCheckPrefix} ${quotedName}`, policy.pipCheckPrefix),
        installCommand: rewritePipCommand(dep.installCommand, `${policy.pipInstallPrefix} ${quotedName}`, policy.pipInstallPrefix),
      }
    }

    if (dep.type === "npm") {
      return {
        ...dep,
        checkCommand: dep.checkCommand || `npm list -g ${dep.name}`,
        installCommand: dep.installCommand || `npm install -g ${dep.name}`,
      }
    }

    if (dep.type === "system") {
      return {
        ...dep,
        checkCommand: dep.checkCommand || `command -v ${dep.name}`,
        installCommand: dep.installCommand || policy.systemInstallTemplate(dep.name),
      }
    }

    return dep
  })
}
