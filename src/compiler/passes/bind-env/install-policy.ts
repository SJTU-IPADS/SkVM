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

export function normalizeDependenciesForPlatform(
  dependencies: DependencyEntry[],
  platform: PlatformContext,
): DependencyEntry[] {
  const policy = createInstallPolicy(platform)

  return dependencies.map((dep) => {
    if (dep.type === "pip") {
      // Quote package specs containing version operators to prevent shell redirection
      const needsQuote = /[><=!~]/.test(dep.name)
      const quotedName = needsQuote ? `'${dep.name}'` : dep.name
      return {
        ...dep,
        checkCommand: dep.checkCommand || `${policy.pipCheckPrefix} ${dep.name}`,
        installCommand: dep.installCommand || `${policy.pipInstallPrefix} ${quotedName}`,
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
