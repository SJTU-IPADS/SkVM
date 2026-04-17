import path from "node:path"
import {
  ProvidersConfigSchema,
  HeadlessAgentConfigSchema,
  type ProvidersConfig,
  type HeadlessAgentConfig,
} from "./types.ts"

export const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..")

// ---------------------------------------------------------------------------
// Flag + env helpers
// ---------------------------------------------------------------------------

function findFlag(name: string): string | undefined {
  const prefix = `--${name}=`
  for (const arg of process.argv) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length)
  }
  return undefined
}

export function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(process.env.HOME ?? "", p.slice(2))
  return p
}

function resolvePath(p: string): string {
  return path.resolve(expandHome(p))
}

// ---------------------------------------------------------------------------
// Cache root (runtime artifacts) — SKVM_CACHE
// ---------------------------------------------------------------------------

/**
 * Cache root for runtime artifacts (profiles, logs, proposals). Default is
 * `~/.skvm/` so profiles, proposals, and logs are shared across every
 * directory the user invokes skvm from. Individual subdirectories can be
 * overridden via their own env vars — this is only the fallback parent.
 *
 * Priority:  --skvm-cache=<path> > SKVM_CACHE env > ~/.skvm
 */
function resolveCacheRoot(): string {
  const flag = findFlag("skvm-cache")
  if (flag) return resolvePath(flag)
  const env = process.env.SKVM_CACHE
  if (env) return resolvePath(env)
  return resolvePath("~/.skvm")
}

export const SKVM_CACHE = resolveCacheRoot()

/** Resolve a subdirectory under SKVM_CACHE, allowing an env var override. */
function cacheSubdir(envVar: string, defaultSubdir: string): string {
  const env = process.env[envVar]
  if (env) return resolvePath(env)
  return path.join(SKVM_CACHE, defaultSubdir)
}

// ---------------------------------------------------------------------------
// Cache subdirectories
// ---------------------------------------------------------------------------

/** Profile cache: ~/.skvm/profiles/ (override: SKVM_PROFILES_DIR) */
export const PROFILES_DIR = cacheSubdir("SKVM_PROFILES_DIR", "profiles")

/** Runtime logs: ~/.skvm/log/ (override: SKVM_LOGS_DIR) */
export const LOGS_DIR = cacheSubdir("SKVM_LOGS_DIR", "log")

export const SESSIONS_INDEX_PATH = path.join(LOGS_DIR, "sessions.jsonl")

/** Proposals root: ~/.skvm/proposals/ (override: SKVM_PROPOSALS_DIR) */
export const PROPOSALS_ROOT = cacheSubdir("SKVM_PROPOSALS_DIR", "proposals")

/** AOT-compile outputs live under proposals. */
export const AOT_COMPILE_DIR = path.join(PROPOSALS_ROOT, "aot-compile")

/** JIT-boost outputs live under proposals. */
export const JIT_BOOST_DIR = path.join(PROPOSALS_ROOT, "jit-boost")

/** JIT-optimize outputs live under proposals. */
export const JIT_OPTIMIZE_DIR = path.join(PROPOSALS_ROOT, "jit-optimize")

// ---------------------------------------------------------------------------
// Input dataset (skills + tasks) — SKVM_DATA_DIR
// ---------------------------------------------------------------------------

/**
 * Input dataset root. Contains skills/ and tasks/ subdirectories.
 *
 * Priority: --skvm-data-dir=<path> > SKVM_DATA_DIR env > <project>/skvm-data
 *
 * This is a separate git submodule that users only need to clone when running
 * the bench harness. Commands that take an explicit --skill or --task path do
 * not need it.
 */
function resolveDataDir(): string {
  const flag = findFlag("skvm-data-dir")
  if (flag) return resolvePath(flag)
  const env = process.env.SKVM_DATA_DIR
  if (env) return resolvePath(env)
  return path.join(PROJECT_ROOT, "skvm-data")
}

export const SKVM_DATA_DIR = resolveDataDir()
export const SKVM_SKILLS_DIR = path.join(SKVM_DATA_DIR, "skills")
export const SKVM_TASKS_DIR = path.join(SKVM_DATA_DIR, "tasks")

// ---------------------------------------------------------------------------
// Model name sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize a model ID for use in filesystem paths.
 * Replaces `/` with `--` and `:` with `_`.
 * e.g. "anthropic/claude-sonnet-4.6" → "anthropic--claude-sonnet-4.6"
 * e.g. "meta/llama-3.1:free" → "meta--llama-3.1_free"
 *
 * Reject `.` / `..` / empty input. Model ids flow into many path
 * constructions (variantDir, proposals tree, per-model log dirs); a
 * dot-segment id would escape those roots via `path.join`. Not
 * reachable through standard OpenRouter ids today, but the guard is a
 * single regex check and prevents a category of bugs at the source.
 */
export function safeModelName(model: string): string {
  const replaced = model.replace(/\//g, "--").replace(/:/g, "_")
  if (replaced.length === 0 || /^\.+$/.test(replaced)) {
    throw new Error(`safeModelName: refusing to slugify dot-segment or empty model id "${model}"`)
  }
  return replaced
}

// ---------------------------------------------------------------------------
// Variant directory helpers
// ---------------------------------------------------------------------------

/**
 * Get the AOT-compiled variant directory for a specific skill × model × harness.
 * When passTag is provided, appends it as a subdirectory (e.g. "p1", "p1p2p3").
 */
export function getVariantDir(
  harness: string,
  model: string,
  skillName: string,
  passTag?: string,
): string {
  const dir = path.join(AOT_COMPILE_DIR, harness, safeModelName(model), skillName)
  return passTag ? path.join(dir, passTag) : dir
}

// ---------------------------------------------------------------------------
// Log directory helpers
// ---------------------------------------------------------------------------

/** Profile logs: log/profile/{harness}/{safeModel}/ */
export function getProfileLogDir(harness: string, model: string): string {
  return path.join(LOGS_DIR, "profile", harness, safeModelName(model))
}

/** AOT-compile logs: log/aot-compile/{harness}/{safeModel}/{skill}/ */
export function getCompileLogDir(harness: string, model: string, skill: string): string {
  return path.join(LOGS_DIR, "aot-compile", harness, safeModelName(model), skill)
}

/** Bench logs + reports: log/bench/{sessionId}/ */
export function getBenchLogDir(sessionId: string): string {
  return path.join(LOGS_DIR, "bench", sessionId)
}

/** Runtime logs (JIT traces, notebook): log/runtime/{harness}/{safeModel}/{skill}/ */
export function getRuntimeLogDir(harness: string, model: string, skill: string): string {
  return path.join(LOGS_DIR, "runtime", harness, safeModelName(model), skill)
}

/** JIT-boost storage: proposals/jit-boost/{skillId}/ — model/harness agnostic */
export function getJitBoostDir(skillId: string): string {
  return path.join(JIT_BOOST_DIR, skillId)
}

// ---------------------------------------------------------------------------
// Pass Tags
// ---------------------------------------------------------------------------

/**
 * Convert a passes array to a canonical pass tag string for directory naming.
 * e.g. [1] -> "p1", [2] -> "p2", [1,2,3] -> "p1p2p3"
 */
export function toPassTag(passes: number[]): string {
  return [...passes].sort().map(p => `p${p}`).join("")
}

/**
 * Convert a pass tag string back to a passes array.
 * e.g. "p1" -> [1], "p1p2p3" -> [1,2,3]
 */
export function fromPassTag(tag: string): number[] {
  const matches = tag.match(/p(\d)/g)
  if (!matches) return [1, 2, 3]
  return matches.map(m => parseInt(m[1]!, 10))
}

// ---------------------------------------------------------------------------
// Project config (skvm.config.json)
// ---------------------------------------------------------------------------

interface SkVMConfig {
  adapters?: {
    opencode?: string
    openclaw?: string
    hermes?: string
    jiuwenclaw?: string
    pi?: string
  }
  proposalsDir?: string
  providers?: unknown
  headlessAgent?: unknown
}

let _configCache: SkVMConfig | undefined

export function getProjectConfig(): SkVMConfig {
  if (_configCache) return _configCache
  const configPath = path.join(PROJECT_ROOT, "skvm.config.json")
  try {
    // Bun supports synchronous JSON import via require
    const raw = require(configPath)
    _configCache = raw as SkVMConfig
  } catch {
    _configCache = {}
  }
  return _configCache!
}

let _providersConfigCache: ProvidersConfig | undefined

/**
 * Parsed `providers` section of skvm.config.json. Empty routes array if
 * the section is missing. Throws on shape errors so typos fail loudly at
 * startup instead of silently falling through to the default route.
 */
export function getProvidersConfig(): ProvidersConfig {
  if (_providersConfigCache) return _providersConfigCache
  const raw = getProjectConfig().providers
  if (raw === undefined) {
    _providersConfigCache = { routes: [] }
    return _providersConfigCache
  }
  _providersConfigCache = ProvidersConfigSchema.parse(raw)
  return _providersConfigCache
}

let _headlessAgentConfigCache: HeadlessAgentConfig | undefined

/**
 * Parsed `headlessAgent` section of skvm.config.json. Defaults
 * `{ driver: "opencode", modelPrefix: "openrouter/" }` for backward compat.
 */
export function getHeadlessAgentConfig(): HeadlessAgentConfig {
  if (_headlessAgentConfigCache) return _headlessAgentConfigCache
  const raw = getProjectConfig().headlessAgent
  _headlessAgentConfigCache = HeadlessAgentConfigSchema.parse(raw ?? {})
  return _headlessAgentConfigCache
}

export function getAdapterRepoDir(adapter: "opencode" | "openclaw" | "hermes" | "jiuwenclaw" | "pi"): string | undefined {
  const config = getProjectConfig()
  const raw = config.adapters?.[adapter]
  if (!raw) return undefined
  return expandHome(raw)
}

/**
 * Proposals root — returns PROPOSALS_ROOT (which already factors in env/flag overrides).
 * Kept as a function for backwards compatibility; consumers now prefer constants like
 * JIT_OPTIMIZE_DIR / JIT_BOOST_DIR / AOT_COMPILE_DIR for typed subtrees.
 */
export function getProposalsRoot(): string {
  return PROPOSALS_ROOT
}
