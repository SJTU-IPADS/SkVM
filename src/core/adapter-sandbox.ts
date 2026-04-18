/**
 * Shared sandbox utilities for CLI-wrapping adapters (openclaw, opencode,
 * hermes, jiuwenclaw).
 *
 * Every adapter that wraps an external harness runs inside a per-process,
 * per-adapter sandbox HOME so the user's real `~/.openclaw`, `~/.config/opencode`,
 * `~/.local/share/opencode`, `~/.hermes`, `~/.jiuwenclaw` are never written
 * to. The sandbox lives at:
 *
 *     /tmp/skvm-adapter-home-<adapter>-<pid>-<rand>/
 *
 * Two modes are supported (see `AdapterConfigMode` in types.ts):
 *   - native  — populate the sandbox from the user's real harness config
 *               (copy config files, symlink asset dirs).
 *   - managed — start empty; the adapter writes a minimal config derived
 *               from `providers.routes`.
 *
 * This module holds the filesystem primitives (mkdirp / copy / symlink /
 * optional copy / optional symlink) and owns process-exit teardown plus
 * stale-sandbox reaping on startup. Each adapter composes these into its
 * own sandbox layout.
 */

import path from "node:path"
import {
  mkdirSync,
  existsSync,
  copyFileSync,
  cpSync,
  symlinkSync,
  rmSync,
  readdirSync,
  statSync,
  lstatSync,
} from "node:fs"
import os from "node:os"
import { createLogger } from "./logger.ts"
import { isPidAlive } from "./file-lock.ts"
import type { ProviderRoute } from "./types.ts"
import { resolveRouteApiKey } from "../providers/registry.ts"
import { HEADLESS_AGENT_DEFAULTS } from "./ui-defaults.ts"

const log = createLogger("adapter-sandbox")

/** Root under which every per-run sandbox lives. */
const SANDBOX_PARENT = path.join(os.tmpdir(), "skvm-adapter-homes")

/** Max age for a stale sandbox tree when sweeping at startup. */
const STALE_SANDBOX_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Stale reap (best-effort, module-load side effect)
// ---------------------------------------------------------------------------

let _staleReapRun = false

/**
 * One-time sweep of abandoned sandbox roots. Runs at first `createSandbox()`
 * call. We don't aggressively delete everything in SANDBOX_PARENT — only dirs
 * whose leading segment looks like our scheme AND whose mtime is older than
 * STALE_SANDBOX_MS, which protects live siblings and unrelated tenants.
 */
function reapStaleSandboxes(): void {
  if (_staleReapRun) return
  _staleReapRun = true
  try {
    if (!existsSync(SANDBOX_PARENT)) return
    const now = Date.now()
    const entries = readdirSync(SANDBOX_PARENT, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (!e.name.startsWith("skvm-adapter-home-")) continue
      const full = path.join(SANDBOX_PARENT, e.name)
      try {
        const st = statSync(full)
        if (now - st.mtimeMs < STALE_SANDBOX_MS) continue
      } catch {
        continue
      }
      // Parse the pid out so we don't delete a sandbox whose owner is still
      // alive (long-running skvm). Format: skvm-adapter-home-<adapter>-<pid>-<rand>
      const parts = e.name.split("-")
      const pidStr = parts[parts.length - 2]
      const pid = pidStr ? Number(pidStr) : NaN
      if (Number.isFinite(pid) && pid > 0 && isPidAlive(pid)) continue
      try {
        rmSync(full, { recursive: true, force: true })
        log.debug(`reaped stale sandbox ${full}`)
      } catch (err) {
        log.debug(`reap failed for ${full}: ${err}`)
      }
    }
  } catch (err) {
    log.debug(`stale sandbox sweep failed: ${err}`)
  }
}

// ---------------------------------------------------------------------------
// Teardown registry (process-exit cleanup)
// ---------------------------------------------------------------------------

const activeSandboxes = new Set<string>()
let _exitHookInstalled = false

function installExitHook(): void {
  if (_exitHookInstalled) return
  _exitHookInstalled = true
  const cleanup = () => {
    for (const dir of activeSandboxes) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch { /* best-effort */ }
    }
    activeSandboxes.clear()
  }
  process.once("exit", cleanup)
  // Re-raise signals so the default disposition still runs.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      cleanup()
      process.kill(process.pid, sig)
    })
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface Sandbox {
  /** Absolute path to the sandbox root. */
  root: string
  /** Which adapter this sandbox belongs to. */
  adapter: string
  /** Remove the sandbox tree. Idempotent. */
  teardown: () => void
}

/**
 * Create a new sandbox root at `/tmp/skvm-adapter-homes/skvm-adapter-home-<adapter>-<pid>-<rand>/`.
 * Registers it for process-exit cleanup. First call also sweeps stale sandboxes.
 */
export function createSandbox(adapter: string): Sandbox {
  reapStaleSandboxes()
  installExitHook()

  mkdirSync(SANDBOX_PARENT, { recursive: true })
  const rand = Math.random().toString(36).slice(2, 10)
  const name = `skvm-adapter-home-${adapter}-${process.pid}-${rand}`
  const root = path.join(SANDBOX_PARENT, name)
  mkdirSync(root, { recursive: true })
  activeSandboxes.add(root)
  log.debug(`created sandbox ${root}`)

  return {
    root,
    adapter,
    teardown: () => {
      activeSandboxes.delete(root)
      try {
        rmSync(root, { recursive: true, force: true })
      } catch (err) {
        log.debug(`teardown failed for ${root}: ${err}`)
      }
    },
  }
}

/** `mkdir -p` on an absolute path. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

/** Copy a file if the source exists. No-op otherwise. */
export function copyFileIfExists(src: string, dest: string): boolean {
  if (!existsSync(src)) return false
  ensureDir(path.dirname(dest))
  copyFileSync(src, dest)
  return true
}

/**
 * Create a symlink at `dest` pointing to `src` if the source exists. No-op
 * otherwise. Removes any existing dest (file or symlink) first so repeated
 * sandbox builds in the same process are idempotent.
 */
export function symlinkIfExists(src: string, dest: string): boolean {
  if (!existsSync(src)) return false
  ensureDir(path.dirname(dest))
  try {
    lstatSync(dest)
    rmSync(dest, { force: true, recursive: false })
  } catch { /* dest doesn't exist */ }
  try {
    symlinkSync(src, dest)
    return true
  } catch (err) {
    // Fall back to a plain recursive copy if the FS / permissions refuse symlinks.
    log.debug(`symlink ${src} → ${dest} failed (${err}); falling back to copy`)
    copyRecursive(src, dest)
    return true
  }
}

/** Recursive copy used as a symlink fallback. */
export function copyRecursive(src: string, dest: string): void {
  ensureDir(path.dirname(dest))
  cpSync(src, dest, { recursive: true, dereference: false, force: true })
}

// ---------------------------------------------------------------------------
// Shared helper: build OPENCODE_CONFIG_CONTENT for openai-compatible routes
// ---------------------------------------------------------------------------

/**
 * Build an OPENCODE_CONFIG_CONTENT JSON string that registers a route's
 * OpenAI-compatible endpoint as an opencode provider. `bareModelId` is the
 * model's name within the registered provider (i.e. the match-prefix
 * stripped: for `ipads/*` matched against `ipads/gpt-4o`, this is `gpt-4o`).
 *
 * Only valid for `kind: "openai-compatible"` routes — opencode ships with
 * openrouter and anthropic built in.
 */
export function buildOpenCodeConfigContent(route: ProviderRoute, bareModelId: string): string {
  if (route.kind !== "openai-compatible") {
    throw new Error(`buildOpenCodeConfigContent: unexpected route kind ${route.kind}`)
  }
  if (!route.baseUrl) {
    throw new Error(`buildOpenCodeConfigContent: route ${route.match} is missing baseUrl`)
  }

  // Empty string is intentional: allows auth-free local endpoints (vLLM
  // without --api-key). opencode will still send the Authorization header
  // but the server can ignore it.
  const apiKey = resolveRouteApiKey(route) ?? ""
  if (!apiKey) {
    log.warn(
      `route "${route.match}" has no resolved API key — the opencode subprocess may fail to authenticate.`,
    )
  }

  // The provider name in opencode's namespace is the first `/`-segment of the
  // route's match glob (e.g. `ipads/*` → `ipads`, `openai/gpt-4o-mini` →
  // `openai`). Taking just the first segment handles narrow matches like
  // single-model globs where the full pattern would yield an invalid opencode
  // provider id.
  const providerName = route.match.split("/")[0]
  if (!providerName) {
    throw new Error(`buildOpenCodeConfigContent: route match "${route.match}" has no leading prefix`)
  }

  const injected: Record<string, unknown> = {
    provider: {
      [providerName]: {
        npm: "@ai-sdk/openai-compatible",
        options: {
          apiKey,
          baseURL: route.baseUrl,
        },
        models: {
          [bareModelId]: {
            limit: {
              context: HEADLESS_AGENT_DEFAULTS.contextLimit,
              output: HEADLESS_AGENT_DEFAULTS.outputLimit,
            },
          },
        },
      },
    },
  }

  // Merge with any pre-existing OPENCODE_CONFIG_CONTENT from the parent
  // environment (CI wrappers, plugin configs, etc.) so we don't clobber it.
  const existing = process.env.OPENCODE_CONFIG_CONTENT
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as Record<string, unknown>
      const mergedProviders = {
        ...((parsed.provider as Record<string, unknown>) ?? {}),
        ...((injected.provider as Record<string, unknown>) ?? {}),
      }
      return JSON.stringify({ ...parsed, ...injected, provider: mergedProviders })
    } catch {
      log.warn("existing OPENCODE_CONFIG_CONTENT is not valid JSON; overwriting")
    }
  }

  return JSON.stringify(injected)
}
