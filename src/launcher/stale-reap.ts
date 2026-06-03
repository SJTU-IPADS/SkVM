import { spawnSync } from "node:child_process"
import { readdirSync, rmSync } from "node:fs"
import path from "node:path"

const TMP_PREFIX = "skvm-launcher-"

export function isPidAlive(pid: number): boolean {
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function parseHostPidFromLabel(label: string): number | null {
  const m = /^skvm-sandbox-host-pid=(\d+)$/.exec(label)
  if (!m) return null
  return parseInt(m[1]!, 10)
}

interface ContainerInfo { id: string; hostPid: number | null }

function listLabeledContainers(): ContainerInfo[] {
  const res = spawnSync(
    "docker",
    ["ps", "-a", "--filter", "label=skvm-sandbox=1", "--format", "{{.ID}} {{.Labels}}"],
    { encoding: "utf-8", timeout: 5000 },
  )
  // status is non-zero (or null on timeout) when the daemon is down/hung —
  // treat as "nothing to reap" so a stuck daemon never blocks the launch.
  if (res.status !== 0) return []
  return res.stdout.trim().split("\n").filter(Boolean).map(line => {
    const [id, ...rest] = line.split(" ")
    const labels = rest.join(" ")
    const pidLabel = labels.split(",").map(s => s.trim()).find(s => s.startsWith("skvm-sandbox-host-pid="))
    return { id: id!, hostPid: pidLabel ? parseHostPidFromLabel(pidLabel) : null }
  })
}

function reapContainers(): void {
  for (const c of listLabeledContainers()) {
    if (c.hostPid === null || !isPidAlive(c.hostPid)) {
      spawnSync("docker", ["rm", "-f", c.id], { stdio: "ignore", timeout: 10000 })
    }
  }
}

function reapTmpDirs(): void {
  let entries: string[] = []
  try { entries = readdirSync("/tmp") } catch { return }
  for (const name of entries) {
    if (!name.startsWith(TMP_PREFIX)) continue
    const pidStr = name.slice(TMP_PREFIX.length)
    const pid = parseInt(pidStr, 10)
    if (Number.isNaN(pid) || isPidAlive(pid)) continue
    try { rmSync(path.join("/tmp", name), { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

export function reapLeaked(): void {
  // Reaping is best-effort cleanup of prior crashed runs — it must never
  // abort or block the current launch. Any failure (daemon down, timeout,
  // permission) is swallowed.
  try { reapContainers() } catch { /* best-effort */ }
  try { reapTmpDirs() } catch { /* best-effort */ }
}
