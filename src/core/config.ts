import path from "node:path"
import { existsSync } from "node:fs"
import {
  ProvidersConfigSchema,
  HeadlessAgentConfigSchema,
  type ProvidersConfig,
  type HeadlessAgentConfig,
  type AdapterConfigMode,
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
// Model id helpers
// ---------------------------------------------------------------------------

/**
 * Drop the first `/`-separated segment of a SkVM model id. SkVM's CLI-facing
 * namespace is `<provider>/<backend-model-id>` (e.g. `openai/gpt-4o`,
 * `openrouter/anthropic/claude-sonnet-4.6`, `self/qwen3-7b`); the backend
 * provider SDKs expect just the trailing part:
 *
 *   openai/gpt-4o             → gpt-4o                      (OpenAI SDK)
 *   openrouter/anthropic/...  → anthropic/claude-sonnet-4.6 (OpenRouter native)
 *   anthropic/claude-sonnet-4 → claude-sonnet-4             (Anthropic SDK)
 *
 * No-op when there's no slash (pre-stripped or malformed id).
 */
export function stripRoutingPrefix(modelId: string): string {
  const slash = modelId.indexOf("/")
  return slash >= 0 ? modelId.slice(slash + 1) : modelId
}

/**
 * Sanitize a model ID for use in filesystem paths. One CLI id = one slug
 * (no provider-prefix stripping): `openai/gpt-4o` and `ipads/gpt-4o` deliberately
 * produce different slugs because their routing paths aren't equivalent —
 * different baseUrls, credentials, proxy behavior, rate limits — and the
 * artifacts we're keying off these slugs (profiles, AOT/JIT proposals, logs)
 * capture those observable differences. Users wanting explicit equivalence
 * can symlink dirs after the fact.
 *
 * Replaces `/` with `--` and `:` with `_`. Rejects `.` / `..` / empty —
 * model ids flow into many path constructions (variantDir, proposals tree,
 * per-model log dirs); a dot-segment id would escape those roots via
 * `path.join`. Not reachable through standard provider ids today, but the
 * guard is a single regex check and prevents a category of bugs at the
 * source.
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

/**
 * Per-adapter settings stored in skvm.config.json. The `repoPath` field
 * (historically just a bare string) is preserved as `repoPath` when the
 * wizard writes the richer shape, and the loader normalizes either form to
 * this object. All fields are optional; missing ones fall back to code
 * defaults at read time.
 */
export interface AdapterEntrySettings {
  /** Local source checkout / binary path. */
  repoPath?: string
  /**
   * openclaw only: which user agent to clone into the sandbox in native mode.
   * Default "main".
   */
  nativeSourceAgent?: string
  /**
   * opencode only: which agent id (`--agent <id>`) to pass through in native
   * mode. Default "build".
   */
  nativeAgent?: string
  /**
   * Extra CLI args appended verbatim to the harness invocation. Escape
   * hatch for per-run flags skvm doesn't model directly.
   */
  extraCliArgs?: string[]
}

interface SkVMConfig {
  adapters?: {
    opencode?: string | AdapterEntrySettings
    openclaw?: string | AdapterEntrySettings
    hermes?: string | AdapterEntrySettings
    jiuwenclaw?: string | AdapterEntrySettings
  }
  proposalsDir?: string
  providers?: unknown
  headlessAgent?: unknown
  defaults?: {
    adapterConfigMode?: AdapterConfigMode
  }
}

let _configCache: SkVMConfig | undefined

/** Always the cache-dir location — where `skvm config init` writes. */
export const CONFIG_WRITE_PATH = path.join(SKVM_CACHE, "skvm.config.json")

let _configPath: string | undefined

/**
 * Resolved on-disk path for `skvm.config.json`. Lazy + memoized so that
 * commands which never read the config (e.g. `--version`) skip the existsSync
 * syscalls.
 *
 * Resolution order:
 *   1. $SKVM_CACHE/skvm.config.json           ← preferred (~/.skvm/skvm.config.json)
 *   2. <PROJECT_ROOT>/skvm.config.json        ← legacy fallback for in-tree dev
 *
 * If neither exists, returns the cache-dir path so error messages and `show`
 * point at where a future `init` will write.
 */
export function getConfigPath(): string {
  if (_configPath) return _configPath
  if (existsSync(CONFIG_WRITE_PATH)) return _configPath = CONFIG_WRITE_PATH
  const legacy = path.join(PROJECT_ROOT, "skvm.config.json")
  if (existsSync(legacy)) return _configPath = legacy
  return _configPath = CONFIG_WRITE_PATH
}

export function getProjectConfig(): SkVMConfig {
  if (_configCache) return _configCache
  try {
    // Bun supports synchronous JSON import via require
    const raw = require(getConfigPath())
    _configCache = raw as SkVMConfig
  } catch {
    _configCache = {}
  }
  return _configCache!
}

/**
 * Names of deprecated `headlessAgent` fields present in the on-disk config.
 * The schema dropped these when headless-agent routing became driven by
 * `providers.routes`, but old config files may still carry them — see
 * `warnLegacyHeadlessFields` in cli-config (info-level surfacing) and
 * `assertNoLegacyHeadlessFields` (hard-fail before jit-optimize /
 * jit-boost misroute through the new fallback).
 */
export function detectLegacyHeadlessFields(): string[] {
  const ha = getProjectConfig().headlessAgent as Record<string, unknown> | undefined
  if (!ha) return []
  const legacy: string[] = []
  if (ha.providerOverride !== undefined) legacy.push("providerOverride")
  if (ha.modelPrefix !== undefined) legacy.push("modelPrefix")
  return legacy
}

/**
 * Throw a migration-guidance error when the on-disk config still has the
 * deprecated `headlessAgent` override fields. Called from the hot path of
 * every headless-agent spawn so users who upgraded without running
 * `skvm config init` see an actionable message instead of a downstream
 * "No providers.routes entry matches …" that hides the real cause.
 */
export function assertNoLegacyHeadlessFields(): void {
  const fields = detectLegacyHeadlessFields()
  if (fields.length === 0) return
  const fieldList = fields.map(f => `headlessAgent.${f}`).join(", ")
  throw new Error(
    `${fieldList} is no longer supported. The headless agent now derives ` +
    `credentials and endpoints from providers.routes automatically. Re-run ` +
    `\`skvm config init\` to migrate (the wizard will drop the legacy fields and, ` +
    `if needed, help you add a matching route), or remove those fields by hand ` +
    `and add a providers.routes entry for your optimizer model prefix.`,
  )
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

/**
 * Read the adapter settings block. Normalizes legacy string form
 * (`"adapters.opencode": "~/Projects/opencode"`) into the richer object
 * shape at read time so callers only deal with one representation.
 */
export function getAdapterSettings(
  adapter: "opencode" | "openclaw" | "hermes" | "jiuwenclaw",
): AdapterEntrySettings {
  const config = getProjectConfig()
  const raw = config.adapters?.[adapter]
  if (!raw) return {}
  if (typeof raw === "string") return { repoPath: raw }
  return raw
}

export function getAdapterRepoDir(adapter: "opencode" | "openclaw" | "hermes" | "jiuwenclaw"): string | undefined {
  const repo = getAdapterSettings(adapter).repoPath
  if (!repo) return undefined
  return expandHome(repo)
}

/**
 * Resolve the default adapter-config mode from skvm.config.json. Returns
 * `undefined` when the user hasn't set one — callers apply their own
 * fallback (typically `"managed"` for the legacy behavior).
 */
export function getDefaultAdapterConfigMode(): AdapterConfigMode | undefined {
  return getProjectConfig().defaults?.adapterConfigMode
}

/**
 * Resolve the effective adapter-config mode for a single invocation.
 *
 * Precedence:
 *   1. CLI flag (`--adapter-config=<mode>`; passed as `flagValue`)
 *   2. `defaults.adapterConfigMode` in skvm.config.json
 *   3. `"managed"` (preserves pre-feature behavior)
 *
 * Throws on an invalid flag value so the user sees a clear error instead of
 * the adapter silently reverting to `"managed"`.
 */
export function resolveAdapterConfigMode(flagValue: string | undefined): AdapterConfigMode {
  if (flagValue !== undefined) {
    if (flagValue !== "native" && flagValue !== "managed") {
      throw new Error(
        `--adapter-config must be "native" or "managed" (got "${flagValue}")`,
      )
    }
    return flagValue
  }
  return getDefaultAdapterConfigMode() ?? "managed"
}

/**
 * Proposals root — returns PROPOSALS_ROOT (which already factors in env/flag overrides).
 * Kept as a function for backwards compatibility; consumers now prefer constants like
 * JIT_OPTIMIZE_DIR / JIT_BOOST_DIR / AOT_COMPILE_DIR for typed subtrees.
 */
export function getProposalsRoot(): string {
  return PROPOSALS_ROOT
}
