/**
 * Thin, non-interactive config mutation helpers used by both the CLI wizard
 * (cli-config/index.ts) and the provider registry (providers/registry.ts).
 *
 * This module MUST NOT import from cli-config/ or from @inquirer/* — it is
 * loaded by core runtime paths that have no interactive terminal. Any
 * dependency on prompt libraries would drag heavy interactive-CLI code into
 * the provider instantiation hot path and violate the layering contract
 * (core must not depend on CLI).
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, chmodSync, readdirSync, unlinkSync } from "node:fs"
import path from "node:path"
import { withFileLock } from "./file-lock.ts"
import { invalidateConfigCache, resolveConfigWritePath } from "./config.ts"
import { createLogger } from "./logger.ts"
import type { ProviderRoute } from "./types.ts"

const log = createLogger("config-write")

/** Cap on the number of `.bak.<ts>` backup files kept alongside the config. */
const MAX_CONFIG_BACKUPS = 5

/**
 * Prune old `.bak.<ts>` files alongside the config, keeping the most recent
 * MAX_CONFIG_BACKUPS. Best-effort — errors are swallowed.
 */
function pruneBackups(configPath: string): void {
  const dir = path.dirname(configPath)
  const prefix = `${path.basename(configPath)}.bak.`
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  const backups = entries
    .filter(name => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .map(name => ({ name, ts: Number(name.slice(prefix.length)) }))
    .sort((a, b) => b.ts - a.ts)
  for (const stale of backups.slice(MAX_CONFIG_BACKUPS)) {
    try { unlinkSync(path.join(dir, stale.name)) } catch { /* best-effort */ }
  }
}

/**
 * Atomically prepend a discovered provider route to the top of
 * `providers.routes` in `skvm.config.json`.
 *
 * Behaviour:
 *  - Idempotent: if a route with the same `match` already exists, returns
 *    `{ written: false }` without touching the file.
 *  - Corrupt / unparseable config: logs a warning and returns
 *    `{ written: false }` without clobbering the user's file. The caller
 *    (AutoProbeProvider) falls through to its in-session alt-provider path.
 *  - Backup: the original file is backed up as `skvm.config.json.bak.<ts>`
 *    before writing; old backups are pruned to MAX_CONFIG_BACKUPS.
 *  - Permissions: chmod 0600 on both the backup and the new file.
 *  - Cache bust: `invalidateConfigCache()` is called after a successful write
 *    so any same-process re-resolution picks up the new route immediately.
 */
export async function appendDiscoveredRoute(
  newRoute: ProviderRoute,
): Promise<{ written: boolean }> {
  const configPath = resolveConfigWritePath()
  const lockPath = `${configPath}.lock`

  return withFileLock(lockPath, { timeoutMs: 5_000 }, async () => {
    let raw: string | null = null
    if (existsSync(configPath)) {
      raw = readFileSync(configPath, "utf-8")
    }

    // Parse the existing config. A malformed file must NOT be clobbered — log
    // a warning and bail out so the user's config is preserved intact.
    let doc: Record<string, unknown>
    if (raw !== null) {
      try {
        doc = JSON.parse(raw) as Record<string, unknown>
      } catch (err) {
        log.warn(
          `appendDiscoveredRoute: ${configPath} contains invalid JSON — ` +
          `skipping config write to avoid data loss. ` +
          `Fix or re-run \`skvm config init\` to repair. ` +
          `(parse error: ${(err as Error).message})`,
        )
        return { written: false }
      }
    } else {
      doc = {}
    }

    const providers = (doc.providers && typeof doc.providers === "object"
      ? doc.providers
      : {}) as Record<string, unknown>
    const routes: unknown[] = Array.isArray(providers.routes) ? providers.routes : []

    const alreadyExists = routes.some(
      r => r && typeof r === "object" && (r as Record<string, unknown>).match === newRoute.match,
    )
    if (alreadyExists) {
      return { written: false }
    }

    routes.unshift(newRoute)
    providers.routes = routes
    doc.providers = providers

    mkdirSync(path.dirname(configPath), { recursive: true })
    if (raw !== null) {
      const backup = `${configPath}.bak.${Date.now()}`
      copyFileSync(configPath, backup)
      try { chmodSync(backup, 0o600) } catch { /* best-effort */ }
      pruneBackups(configPath)
    }
    writeFileSync(configPath, JSON.stringify(doc, null, 2) + "\n")
    try { chmodSync(configPath, 0o600) } catch { /* best-effort */ }
    invalidateConfigCache()
    return { written: true }
  })
}
