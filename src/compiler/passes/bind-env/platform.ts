import { createLogger } from "../../../core/logger.ts"

const log = createLogger("pass2:platform")

export type HostOS = "linux" | "macos" | "windows"

export interface PlatformContext {
  os: HostOS
  arch: string
  packageManagers: {
    brew: boolean
    apt: boolean
    yum: boolean
    dnf: boolean
    winget: boolean
    choco: boolean
    pip: boolean
    npm: boolean
  }
  python: {
    condaActive: boolean
    venvActive: boolean
  }
}

async function commandExists(command: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["bash", "-lc", `command -v ${command} >/dev/null 2>&1`], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const code = await proc.exited
    return code === 0
  } catch {
    return false
  }
}

export async function detectPlatformContext(): Promise<PlatformContext> {
  const os: HostOS = process.platform === "darwin"
    ? "macos"
    : process.platform === "win32"
      ? "windows"
      : "linux"

  const [brew, apt, yum, dnf, winget, choco, pip, npm] = await Promise.all([
    commandExists("brew"),
    commandExists("apt-get"),
    commandExists("yum"),
    commandExists("dnf"),
    commandExists("winget"),
    commandExists("choco"),
    commandExists("pip"),
    commandExists("npm"),
  ])

  const context: PlatformContext = {
    os,
    arch: process.arch,
    packageManagers: { brew, apt, yum, dnf, winget, choco, pip, npm },
    python: {
      condaActive: Boolean(process.env.CONDA_DEFAULT_ENV),
      venvActive: Boolean(process.env.VIRTUAL_ENV),
    },
  }

  log.info(`Detected platform: os=${context.os}, arch=${context.arch}`)
  return context
}
