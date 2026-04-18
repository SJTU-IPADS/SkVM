/**
 * `skvm config` — interactive configuration for providers, adapters, and paths.
 *
 *   skvm config init     Interactive wizard that writes $SKVM_CACHE/skvm.config.json
 *   skvm config show     Print the resolved config (file → env → defaults)
 *   skvm config doctor   Check that the resolved config actually works
 *
 * `init` writes to the cache-dir location regardless of where the current
 * config was read from, so an in-tree legacy file gets transparently migrated
 * (the legacy file is left in place; getConfigPath() prefers the cache-dir
 * copy on subsequent runs).
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, chmodSync, accessSync, readdirSync, constants as fsConst } from "node:fs"
import path from "node:path"
import readline from "node:readline/promises"
import { stdin, stdout } from "node:process"

import { c, useColor } from "../core/logger.ts"
import {
  PROJECT_ROOT,
  SKVM_CACHE,
  SKVM_DATA_DIR,
  PROFILES_DIR,
  LOGS_DIR,
  PROPOSALS_ROOT,
  CONFIG_WRITE_PATH,
  getConfigPath,
  expandHome,
  getProvidersConfig,
  getHeadlessAgentConfig,
  getAdapterRepoDir,
  getAdapterSettings,
  getDefaultAdapterConfigMode,
  detectLegacyHeadlessFields,
} from "../core/config.ts"
import type { ProviderKind, AdapterConfigMode } from "../core/types.ts"
import { ALL_ADAPTERS, type AdapterName } from "../adapters/registry.ts"
import { shortenPath } from "../core/banner.ts"

const EXAMPLE_PATH = path.join(PROJECT_ROOT, "skvm.config.example.json")
const CONFIG_LEGACY_PATH = path.join(PROJECT_ROOT, "skvm.config.json")

// ---------------------------------------------------------------------------
// Types — narrower than the schema to keep the wizard self-contained
// ---------------------------------------------------------------------------

interface RouteDraft {
  match: string
  kind: ProviderKind
  apiKey?: string
  apiKeyEnv?: string
  baseUrl?: string
}

interface HeadlessAgentDraft {
  driver?: "opencode"
  opencodePath?: string
}

interface AdapterDraft {
  repoPath?: string
  nativeSourceAgent?: string
  nativeAgent?: string
  extraCliArgs?: string[]
}

interface ConfigDraft {
  adapters: Partial<Record<AdapterName, AdapterDraft>>
  providers: { routes: RouteDraft[] }
  defaults?: { adapterConfigMode?: AdapterConfigMode }
  /**
   * Preserved as an opaque passthrough on re-init — the wizard doesn't
   * configure these fields (credentials and endpoints come from
   * providers.routes), but a user who hand-edited `opencodePath` or pinned
   * a specific `driver` shouldn't lose them to `skvm config init`.
   */
  headlessAgent?: HeadlessAgentDraft
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runConfig(rawArgs: string[]): Promise<void> {
  const sub = rawArgs[0]
  if (!sub || sub === "--help" || sub === "-h") {
    printHelp()
    return
  }
  switch (sub) {
    case "show":
      await runShow()
      return
    case "init":
      await runInit()
      return
    case "doctor":
      await runDoctor()
      return
    default:
      console.error(c.red(`Unknown subcommand: config ${sub}`))
      printHelp()
      process.exit(1)
  }
}

function printHelp(): void {
  console.log(`skvm config — Configure SkVM providers, adapters, and paths

Usage:
  skvm config <subcommand>

Subcommands:
  init       Interactive wizard; writes ${shortenPath(CONFIG_WRITE_PATH)}
  show       Print the resolved config and where each value came from
  doctor     Verify that providers, adapters, and paths actually work

Examples:
  skvm config init      # first-time setup or update existing config
  skvm config show      # see what skvm currently sees
  skvm config doctor    # sanity check before running a long bench

The config lives under \$SKVM_CACHE (default ~/.skvm/). A legacy in-tree
location at <project>/skvm.config.json is also read for backwards compat.
For the field reference, see docs/providers.md.`)
}

// ---------------------------------------------------------------------------
// `show` — read-only summary
// ---------------------------------------------------------------------------

async function runShow(): Promise<void> {
  const configPath = getConfigPath()
  const cfgExists = existsSync(configPath)
  const isLegacy = cfgExists && configPath === CONFIG_LEGACY_PATH
  console.log(c.bold("\nConfig file"))
  if (cfgExists) {
    const tag = isLegacy
      ? c.yellow("(legacy location — `skvm config init` will migrate it to the cache dir)")
      : c.green("(present)")
    console.log(`  Path        ${shortenPath(configPath)} ${tag}`)
  } else {
    console.log(`  Path        ${shortenPath(configPath)} ${c.yellow("(missing — using defaults)")}`)
    console.log(`  ${c.dim(`Run \`skvm config init\` to create one.`)}`)
  }
  if (existsSync(EXAMPLE_PATH)) {
    console.log(`  Template    ${shortenPath(EXAMPLE_PATH)}`)
  }

  console.log(c.bold("\nPaths"))
  printRow("Cache root", SKVM_CACHE, sourceFor("--skvm-cache", "SKVM_CACHE", "~/.skvm"))
  printRow("Profiles", PROFILES_DIR, envOrDefaultSource("SKVM_PROFILES_DIR", path.join(SKVM_CACHE, "profiles")))
  printRow("Logs", LOGS_DIR, envOrDefaultSource("SKVM_LOGS_DIR", path.join(SKVM_CACHE, "log")))
  printRow("Proposals", PROPOSALS_ROOT, envOrDefaultSource("SKVM_PROPOSALS_DIR", path.join(SKVM_CACHE, "proposals")))
  printRow("Data dir", SKVM_DATA_DIR, sourceFor("--skvm-data-dir", "SKVM_DATA_DIR", "<project>/skvm-data"))

  console.log(c.bold("\nProviders"))
  const providers = getProvidersConfig()
  if (providers.routes.length === 0) {
    console.log(`  ${c.dim("(no routes configured — falling back to OpenRouter via OPENROUTER_API_KEY)")}`)
    console.log(`  ${c.dim("Default")}  ${envBadge("OPENROUTER_API_KEY")}`)
  } else {
    const colW = Math.max(...providers.routes.map(r => r.match.length), 8)
    console.log(`  ${"match".padEnd(colW)}  kind                 auth`)
    for (const r of providers.routes) {
      const tail = r.kind === "openai-compatible" && r.baseUrl ? ` ${c.dim(`@ ${r.baseUrl}`)}` : ""
      console.log(`  ${r.match.padEnd(colW)}  ${r.kind.padEnd(20)} ${authBadge(r)}${tail}`)
    }
  }

  console.log(c.bold("\nHeadless agent"))
  const ha = getHeadlessAgentConfig()
  printRow("Driver", ha.driver)
  if (ha.opencodePath) printRow("opencode path", ha.opencodePath)
  console.log(`  ${c.dim("credentials derived automatically from providers.routes")}`)
  warnLegacyHeadlessFields()

  console.log(c.bold("\nDefaults"))
  const defMode = getDefaultAdapterConfigMode() ?? "(unset → managed)"
  printRow("Adapter mode", String(defMode), "defaults.adapterConfigMode")

  console.log(c.bold("\nAdapters"))
  const labelW = Math.max(...ALL_ADAPTERS.map(a => a.length))
  for (const a of ALL_ADAPTERS) {
    if (a === "bare-agent") {
      console.log(`  ${a.padEnd(labelW)}  ${c.dim("built-in (no checkout needed)")}`)
      continue
    }
    const dir = getAdapterRepoDir(a as Exclude<AdapterName, "bare-agent">)
    if (!dir) {
      const fallback = a === "opencode"
        ? "not configured (will use `which opencode` on PATH, then bundled copy)"
        : "not configured (will use `which " + a + "` on PATH)"
      console.log(`  ${a.padEnd(labelW)}  ${c.dim(fallback)}`)
    } else {
      const ok = existsSync(dir)
      const tag = ok ? c.green("✓") : c.red("✗ missing")
      console.log(`  ${a.padEnd(labelW)}  ${shortenPath(dir)}  ${tag}`)
    }
    // Surface native-mode + extraCliArgs settings when set.
    const settings = getAdapterSettings(a as Exclude<AdapterName, "bare-agent">)
    const lines: string[] = []
    if (a === "openclaw" && settings.nativeSourceAgent) {
      lines.push(`${c.dim("nativeSourceAgent:")} ${settings.nativeSourceAgent}`)
    }
    if (a === "opencode" && settings.nativeAgent) {
      lines.push(`${c.dim("nativeAgent:")} ${settings.nativeAgent}`)
    }
    if (settings.extraCliArgs && settings.extraCliArgs.length > 0) {
      lines.push(`${c.dim("extraCliArgs:")} ${settings.extraCliArgs.join(" ")}`)
    }
    if (a === "jiuwenclaw") {
      lines.push(c.dim("native not supported (managed only)"))
    }
    for (const ln of lines) console.log(`  ${"".padEnd(labelW)}    ${ln}`)
  }
  console.log()
}

function printRow(label: string, value: string, source?: string): void {
  const left = `  ${label.padEnd(13)}`
  const right = source ? `  ${c.dim(`(${source})`)}` : ""
  console.log(`${left} ${shortenPath(value)}${right}`)
}

function sourceFor(flagName: string, envName: string, defaultLabel: string): string {
  for (const arg of process.argv) if (arg.startsWith(`${flagName}=`)) return `from ${flagName}`
  if (process.env[envName]) return `from $${envName}`
  return `default ${defaultLabel}`
}

function envOrDefaultSource(envName: string, _defaultPath: string): string {
  return process.env[envName] ? `from $${envName}` : "from cache root"
}

function envBadge(envVar: string): string {
  const present = !!process.env[envVar]
  const mark = present ? c.green("✓ set") : c.red("✗ unset")
  return `${envVar} ${mark}`
}

/** Show "<masked-key> (in config)" or "<env var name> ✓/✗". */
function authBadge(r: { apiKey?: string; apiKeyEnv?: string }): string {
  if (r.apiKey) return `${maskKey(r.apiKey)} ${c.green("(in config)")}`
  if (r.apiKeyEnv) return envBadge(r.apiKeyEnv)
  return c.red("(no auth configured)")
}

function warnLegacyHeadlessFields(): void {
  const fields = detectLegacyHeadlessFields()
  if (fields.length === 0) return
  console.log(
    c.yellow(`  ⚠ ignored legacy fields: headlessAgent.${fields.join(", headlessAgent.")}`),
  )
  console.log(c.dim("    (run `skvm config init` to remove them; creds now come from providers.routes)"))
}

/** Reveal first 4 + last 4 chars; placeholder for shorter keys. */
function maskKey(key: string): string {
  if (key.length <= 8) return "•".repeat(key.length || 1)
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

/**
 * Build a plausible example model id for the "smoke test" hint after `init`.
 * Picks the first user route (or falls back to the built-in OpenRouter
 * default) and fills the wildcard with a well-known model that matches the
 * route's kind + baseUrl. Best-effort — the user knows their endpoint and
 * can swap the model name when pasting the command.
 */
function smokeTestModelId(routes: readonly RouteDraft[]): string {
  const route = routes[0]
  if (!route) return "openrouter/anthropic/claude-sonnet-4.6"
  if (!route.match.endsWith("/*") && !route.match.includes("*")) return route.match
  const prefix = route.match.replace(/\/\*$/, "")
  switch (route.kind) {
    case "openrouter":
      return `${prefix}/anthropic/claude-sonnet-4.6`
    case "anthropic":
      return `${prefix}/claude-sonnet-4.6`
    case "openai-compatible": {
      const bu = route.baseUrl ?? ""
      if (bu.includes("openai.com")) return `${prefix}/gpt-4o`
      if (bu.includes("deepseek.com")) return `${prefix}/deepseek-chat`
      if (bu.includes("11434")) return `${prefix}/llama3.1`
      return `${prefix}/<your-model>`
    }
  }
}

// ---------------------------------------------------------------------------
// `init` — interactive wizard
// ---------------------------------------------------------------------------

async function runInit(): Promise<void> {
  if (!stdin.isTTY) {
    console.error(c.red("skvm config init requires an interactive terminal (TTY)."))
    console.error("Edit skvm.config.json directly, or copy the example template:")
    console.error(`  cp ${shortenPath(EXAMPLE_PATH)} ${shortenPath(CONFIG_WRITE_PATH)}`)
    process.exit(1)
  }

  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true })

  printHeader("Welcome to skvm config")
  console.log(`This wizard writes ${c.bold(shortenPath(CONFIG_WRITE_PATH))}.`)
  const sourcePath = getConfigPath()
  if (existsSync(sourcePath)) {
    if (sourcePath === CONFIG_LEGACY_PATH) {
      console.log(c.yellow(`Loading defaults from legacy path ${shortenPath(sourcePath)}.`))
      console.log(c.dim("After you confirm, the new file will live under the cache dir; the legacy file stays put."))
    } else {
      console.log(c.dim("An existing config will be loaded as defaults; you can keep or change each value."))
    }
  } else {
    console.log(c.dim("No existing config — defaults come from the example template."))
  }
  console.log(c.dim("Press Enter to keep the value shown in [brackets]. Ctrl+C to abort.\n"))

  const existing = loadExistingDraft()
  const draft: ConfigDraft = structuredClone(existing)

  try {
    await stepProviders(rl, draft)
    // No headlessAgent config: jit-optimize / jit-boost resolve credentials
    // directly from providers.routes at runtime.
    await stepDefaultMode(rl, draft)
    await stepAdapters(rl, draft)
    await stepPathsHint(rl)

    printHeader("Review")
    const json = serialize(draft)
    console.log(json + "\n")

    const confirm = await ask(rl, c.bold(`Write to ${shortenPath(CONFIG_WRITE_PATH)}?`), "Y", true)
    if (!yes(confirm)) {
      console.log(c.yellow("Aborted. No changes written."))
      return
    }

    mkdirSync(path.dirname(CONFIG_WRITE_PATH), { recursive: true })
    if (existsSync(CONFIG_WRITE_PATH)) {
      const backup = `${CONFIG_WRITE_PATH}.bak.${Date.now()}`
      copyFileSync(CONFIG_WRITE_PATH, backup)
      try { chmodSync(backup, 0o600) } catch { /* best-effort, not fatal on Windows */ }
      console.log(c.dim(`Backed up previous config → ${shortenPath(backup)}`))
    }
    writeFileSync(CONFIG_WRITE_PATH, json + "\n")
    // 0600 because the file may now contain plaintext API keys.
    try { chmodSync(CONFIG_WRITE_PATH, 0o600) } catch { /* best-effort, not fatal on Windows */ }
    console.log(c.green(`✓ Wrote ${shortenPath(CONFIG_WRITE_PATH)} (chmod 0600)`))

    console.log(c.bold("\nNext steps"))
    console.log("  skvm config doctor       # verify env vars + paths")
    console.log("  skvm config show         # print resolved config")
    const smokeId = smokeTestModelId(draft.providers.routes)
    console.log(`  skvm profile --model=${smokeId} --primitives=gen.text.prose --instances=1`)
    console.log(c.dim("      # one-shot smoke test (swap the model if your endpoint serves different ids)"))
  } finally {
    rl.close()
  }
}

function loadExistingDraft(): ConfigDraft {
  const draft: ConfigDraft = {
    adapters: {},
    providers: { routes: [] },
  }
  // Try cache-dir first, fall back to legacy. tryReadJson swallows ENOENT so
  // we don't pre-check existence — that avoids a TOCTOU window and keeps the
  // path linear.
  const raw = tryReadJson(CONFIG_WRITE_PATH) ?? tryReadJson(CONFIG_LEGACY_PATH)
  if (!raw) return draft

  if (raw.adapters && typeof raw.adapters === "object") {
    for (const [k, v] of Object.entries(raw.adapters as Record<string, unknown>)) {
      if (typeof v === "string" && v && !v.startsWith("<")) {
        draft.adapters[k as AdapterName] = { repoPath: v }
      } else if (v && typeof v === "object") {
        const o = v as Record<string, unknown>
        const entry: AdapterDraft = {}
        if (typeof o.repoPath === "string" && !o.repoPath.startsWith("<")) entry.repoPath = o.repoPath
        if (typeof o.nativeSourceAgent === "string") entry.nativeSourceAgent = o.nativeSourceAgent
        if (typeof o.nativeAgent === "string") entry.nativeAgent = o.nativeAgent
        if (Array.isArray(o.extraCliArgs) && o.extraCliArgs.every((x) => typeof x === "string")) {
          entry.extraCliArgs = o.extraCliArgs as string[]
        }
        if (Object.keys(entry).length > 0) draft.adapters[k as AdapterName] = entry
      }
    }
  }
  if (raw.defaults && typeof raw.defaults === "object") {
    const d = raw.defaults as Record<string, unknown>
    if (d.adapterConfigMode === "native" || d.adapterConfigMode === "managed") {
      draft.defaults = { adapterConfigMode: d.adapterConfigMode }
    }
  }
  if (raw.providers && typeof raw.providers === "object") {
    const routes = (raw.providers as { routes?: unknown }).routes
    if (Array.isArray(routes)) {
      draft.providers.routes = routes.filter((r): r is RouteDraft => {
        if (!r || typeof r !== "object") return false
        const o = r as RouteDraft
        return typeof o.match === "string"
          && typeof o.kind === "string"
          && (typeof o.apiKey === "string" || typeof o.apiKeyEnv === "string")
      })
    }
  }
  // Preserve driver / opencodePath on re-init so users who hand-pinned those
  // don't lose them when re-running the wizard. Legacy providerOverride /
  // modelPrefix are intentionally dropped here (and flagged by
  // warnLegacyHeadlessFields in show/doctor).
  if (raw.headlessAgent && typeof raw.headlessAgent === "object") {
    const ha = raw.headlessAgent as Record<string, unknown>
    const preserved: HeadlessAgentDraft = {}
    if (ha.driver === "opencode") preserved.driver = "opencode"
    if (typeof ha.opencodePath === "string") preserved.opencodePath = ha.opencodePath
    if (Object.keys(preserved).length > 0) draft.headlessAgent = preserved
  }
  return draft
}

/** Read + JSON.parse a file, returning null on any error (ENOENT, parse). */
function tryReadJson(p: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

// --- Step 1: providers --------------------------------------------------------

async function stepProviders(rl: readline.Interface, draft: ConfigDraft): Promise<void> {
  printHeader("Step 1 / 4 — Providers (where SkVM sends LLM calls)")
  console.log(c.dim("Each 'route' tells skvm where to send a class of model ids. Add as many"))
  console.log(c.dim("as you want; the first match wins (so order matters)."))
  console.log(c.dim("Keys are stored in skvm.config.json (gitignored, chmod 0600), or you can"))
  console.log(c.dim("point at an env var name instead."))

  if (draft.providers.routes.length > 0) {
    console.log("\nCurrent routes:")
    for (const r of draft.providers.routes) {
      const tail = r.baseUrl ? ` ${c.dim(`@ ${r.baseUrl}`)}` : ""
      console.log(`  ${c.cyan(r.match)} → ${r.kind} via ${authBadge(r)}${tail}`)
    }
    const keep = await ask(rl, "Keep the current routes?", "Y", true)
    if (yes(keep)) return
    draft.providers.routes = []
  }

  // Unified loop. Each iteration shows the same menu; first iteration defaults
  // to OpenRouter (the easiest option for new users), later iterations default
  // to Done.
  let iteration = 0
  while (true) {
    const r = await askNextRoute(rl, draft, iteration)
    iteration++
    if (!r) break
    draft.providers.routes.push(r)
  }
}

async function askNextRoute(
  rl: readline.Interface,
  draft: ConfigDraft,
  iteration: number,
): Promise<RouteDraft | null> {
  console.log(c.bold("\nAdd a route — where should some model ids go?"))
  if (draft.providers.routes.length > 0) {
    console.log(c.dim("  Already added:"))
    for (const r of draft.providers.routes) {
      const tail = r.baseUrl ? c.dim(` @ ${r.baseUrl}`) : ""
      console.log(c.dim(`    ${r.match} → ${r.kind}${tail}`))
    }
  }
  console.log("  1) OpenRouter         " + c.dim("— `openrouter/*`, hundreds of models behind one key"))
  console.log("  2) Anthropic native   " + c.dim("— `anthropic/*`, via api.anthropic.com"))
  console.log("  3) OpenAI-compatible  " + c.dim("— OpenAI / DeepSeek / vLLM / Ollama / proxy / etc."))
  console.log("  4) Done")
  // No routes yet → default OpenRouter (the most common starter); otherwise
  // default to Done so the user only types when they actually want more.
  const fallback = iteration === 0 && draft.providers.routes.length === 0 ? "1" : "4"
  const choice = (await ask(rl, "Choice", fallback)).trim()
  switch (choice) {
    case "1": return await askOpenRouter(rl)
    case "2": return await askAnthropic(rl)
    case "3": return await askOpenAICompatible(rl)
    default: return null
  }
}

async function askOpenRouter(rl: readline.Interface): Promise<RouteDraft> {
  console.log(c.dim("\n→ OpenRouter route — matches `openrouter/*` model ids (e.g."))
  console.log(c.dim("  `openrouter/qwen/qwen3-30b`, `openrouter/anthropic/claude-sonnet-4.6`)."))
  console.log(c.dim("  Routes through openrouter.ai; the `openrouter/` prefix is stripped"))
  console.log(c.dim("  before sending, so OR sees its native vendor/model ids."))
  const auth = await askApiKey(rl, "OpenRouter", "OPENROUTER_API_KEY")
  return { match: "openrouter/*", kind: "openrouter", ...auth }
}

async function askAnthropic(rl: readline.Interface): Promise<RouteDraft> {
  console.log(c.dim("\n→ Anthropic native route — matches model ids starting with"))
  console.log(c.dim("  `anthropic/` (e.g. `anthropic/claude-sonnet-4.6`); routes to api.anthropic.com."))
  const auth = await askApiKey(rl, "Anthropic", "ANTHROPIC_API_KEY")
  return { match: "anthropic/*", kind: "anthropic", ...auth }
}

/**
 * One helper for every OpenAI-compatible endpoint (OpenAI, DeepSeek, Together,
 * vLLM, Ollama, proxies, …). Asks URL first because users know their endpoint
 * URL more readily than the abstract "prefix" concept; the prefix is then
 * auto-derived from the host. The match glob defaults to `<prefix>/*` but the
 * user can override to a more specific pattern (e.g. one exact model id).
 */
async function askOpenAICompatible(rl: readline.Interface): Promise<RouteDraft> {
  console.log(c.dim("\n→ OpenAI-compatible route — any endpoint implementing the OpenAI API"))
  console.log(c.dim("  Examples: https://api.openai.com/v1, https://api.deepseek.com/v1,"))
  console.log(c.dim("            http://localhost:8000/v1 (vLLM), http://localhost:11434/v1 (Ollama)"))
  const baseUrl = (await ask(rl, "Base URL", "https://api.openai.com/v1")).trim()
    || "https://api.openai.com/v1"

  const derivedPrefix = derivePrefixFromUrl(baseUrl)
  console.log(c.dim("  The prefix becomes the first segment of model ids you'll pass to skvm."))
  console.log(c.dim(`  Example: prefix \`${derivedPrefix}\` → use \`${derivedPrefix}/<model>\` on the CLI.`))
  const matchPrefix = (await ask(rl, "Route prefix", derivedPrefix)).trim() || derivedPrefix

  // Match defaults to `<prefix>/*`; advanced users can narrow it (single id,
  // sub-glob, etc.). Skipping the question entirely for the common case would
  // be cleaner, but folding Custom in here means one less menu option.
  const defaultMatch = `${matchPrefix}/*`
  console.log(c.dim(`  Match glob — defaults to \`${defaultMatch}\` (this route handles every`))
  console.log(c.dim(`  ${matchPrefix}/<model>). Override only if you want a more specific glob,`))
  console.log(c.dim("  e.g. one exact id like `openai/gpt-4o-mini`."))
  const match = (await ask(rl, "Match glob", defaultMatch)).trim() || defaultMatch

  const auth = await askApiKey(
    rl,
    match,
    `${matchPrefix.toUpperCase().replace(/-/g, "_")}_API_KEY`,
  )
  return { match, kind: "openai-compatible", baseUrl, ...auth }
}

/**
 * Best-effort prefix from a base URL. Recognises common local-server ports
 * (vLLM 8000, Ollama 11434), strips a leading `api.` from public hosts, and
 * otherwise takes the first hostname segment. The user can always override.
 */
export function derivePrefixFromUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl)
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
      if (u.port === "11434") return "ollama"
      if (u.port === "8000") return "vllm"
      return "self"
    }
    const parts = u.hostname.split(".")
    if (parts.length >= 3 && parts[0] === "api") return parts[1] ?? parts[0]!
    return parts[0] ?? "openai"
  } catch {
    return "openai"
  }
}

/**
 * Two paths to provide the API key:
 *   - Paste it now → stored as `apiKey` directly in skvm.config.json (default,
 *     simplest, file is gitignored + chmod'd 0600 on write).
 *   - Use an env var → stored as `apiKeyEnv` (good for direnv / 1password /
 *     vault setups, or shared CI).
 *
 * Returns the relevant subset of RouteDraft fields so callers can spread it
 * into the route they're building.
 */
async function askApiKey(
  rl: readline.Interface,
  routeLabel: string,
  defaultEnvName: string,
): Promise<{ apiKey?: string; apiKeyEnv?: string }> {
  console.log(c.dim(`\n  How should skvm get the API key for ${routeLabel}?`))
  console.log(c.dim("    1) Paste it now — stored in skvm.config.json (gitignored, chmod 0600)"))
  console.log(c.dim(`    2) Read from env var ${defaultEnvName} (or another name)`))
  const choice = (await ask(rl, "  Choice", "1")).trim()
  if (choice === "2") {
    const cur = process.env[defaultEnvName]
    const hint = cur ? c.green(" ✓ set in current shell") : c.yellow(" ⚠ not set in current shell")
    const name = (await ask(rl, `  Env var name${hint}`, defaultEnvName)).trim() || defaultEnvName
    if (!process.env[name]) {
      console.log(c.yellow(`   Reminder: export ${name}=<your-key> in your shell or add it to <repo>/.env before running skvm.`))
    }
    return { apiKeyEnv: name }
  }
  const key = (await ask(rl, `  ${routeLabel} API key`, "")).trim()
  if (!key) {
    console.log(c.yellow("   No key entered — skvm will fail to authenticate when this route is used."))
    console.log(c.yellow("   You can re-run `skvm config init` later, or edit skvm.config.json directly."))
  }
  return { apiKey: key }
}

// --- Headless agent — auto-derived, no prompt --------------------------------

// --- Step 2: adapters ---------------------------------------------------------

async function stepDefaultMode(rl: readline.Interface, draft: ConfigDraft): Promise<void> {
  printHeader("Step 2 / 4 — Default adapter-config mode")
  console.log(c.dim("Each run can be `native` (use your real harness config from ~/.openclaw,"))
  console.log(c.dim("~/.config/opencode, ~/.hermes) or `managed` (a clean sandbox with skvm-generated"))
  console.log(c.dim("config derived from providers.routes). This is the default; --adapter-config=<m>"))
  console.log(c.dim("on any command overrides per-run."))
  console.log(c.dim("  native  — real user environment; best for development / ad-hoc runs"))
  console.log(c.dim("  managed — clean reproducible baseline; best for bench / profile / jit-optimize"))
  const cur = draft.defaults?.adapterConfigMode ?? "managed"
  const ans = (await ask(rl, "Default mode", cur)).trim() || cur
  if (ans !== "native" && ans !== "managed") {
    console.log(c.yellow(`   ⚠ "${ans}" is not native/managed — keeping previous value (${cur}).`))
    draft.defaults = { adapterConfigMode: cur }
    return
  }
  draft.defaults = { adapterConfigMode: ans }
}

async function stepAdapters(rl: readline.Interface, draft: ConfigDraft): Promise<void> {
  printHeader("Step 3 / 4 — Local adapter checkouts + per-adapter options")
  console.log(c.dim("Adapters are external agent CLIs (opencode, openclaw, hermes, jiuwenclaw)."))
  console.log(c.dim("Point an adapter at a local git clone if you want skvm to build/run that"))
  console.log(c.dim("agent from source. Otherwise skvm tries `which <name>` on your PATH."))
  console.log(c.dim("You'll also be asked for the native-mode source agent where it applies."))
  console.log(c.dim("Most users can press Enter through this section."))
  console.log(c.dim("Path can use ~ for $HOME. Example: ~/Projects/opencode\n"))

  for (const a of ALL_ADAPTERS) {
    if (a === "bare-agent") continue
    const cur = draft.adapters[a] ?? {}
    console.log(c.bold(`\n  ${a}`))

    // 1. Repo path
    const repoCurrent = cur.repoPath ?? ""
    const repoAns = (await ask(rl, `    repo path`, repoCurrent || "(skip)")).trim()
    let nextEntry: AdapterDraft = {}
    if (repoAns && repoAns !== "(skip)") {
      const expanded = expandHome(repoAns)
      if (!existsSync(expanded)) {
        console.log(c.yellow(`     ⚠ ${shortenPath(expanded)} does not exist — saving anyway.`))
      }
      nextEntry.repoPath = repoAns
    }

    // 2. Per-adapter native settings
    if (a === "openclaw") {
      const agents = listOpenclawAgents()
      if (agents.length > 0) {
        console.log(c.dim(`    available agents under ~/.openclaw/agents: ${agents.join(", ")}`))
      } else {
        console.log(c.dim(`    (no ~/.openclaw/agents — native mode will error until you create one or pick another)`))
      }
      const curSrc = cur.nativeSourceAgent ?? (agents.includes("main") ? "main" : agents[0] ?? "main")
      const srcAns = (await ask(rl, `    native source agent`, curSrc)).trim() || curSrc
      nextEntry.nativeSourceAgent = srcAns
    }
    if (a === "opencode") {
      const agents = listOpencodeAgents()
      if (agents.length > 0) {
        console.log(c.dim(`    available agents under ~/.config/opencode/agent: ${agents.join(", ")}`))
      }
      const curAgent = cur.nativeAgent ?? (agents.includes("build") ? "build" : agents[0] ?? "build")
      const agentAns = (await ask(rl, `    native agent`, curAgent)).trim() || curAgent
      nextEntry.nativeAgent = agentAns
    }
    if (a === "hermes") {
      const cfg = expandHome("~/.hermes/config.yaml")
      const env = expandHome("~/.hermes/.env")
      if (existsSync(cfg)) {
        console.log(c.green(`    ✓ found ~/.hermes/config.yaml (native mode ready)`))
      } else {
        console.log(c.yellow(`    ⚠ ~/.hermes/config.yaml missing — native mode will error.`))
      }
      if (!existsSync(env)) {
        console.log(c.yellow(`    ⚠ ~/.hermes/.env missing — native mode may lack API keys.`))
      }
    }
    if (a === "jiuwenclaw") {
      console.log(c.yellow(`    note: jiuwenclaw only supports --adapter-config=managed.`))
      console.log(c.dim(`    (its set_user_home() does not isolate the AgentServer sidecar)`))
    }

    // 3. extraCliArgs escape hatch (space-separated; empty to skip).
    const curExtra = (cur.extraCliArgs ?? []).join(" ")
    const extraAns = (await ask(
      rl,
      `    extra CLI args (space-separated, appended verbatim)`,
      curExtra,
    )).trim()
    if (extraAns) {
      nextEntry.extraCliArgs = extraAns.split(/\s+/).filter(Boolean)
    }

    if (Object.keys(nextEntry).length > 0) {
      draft.adapters[a] = nextEntry
    } else {
      delete draft.adapters[a]
    }
  }
}

function listOpenclawAgents(): string[] {
  try {
    return readdirSync(expandHome("~/.openclaw/agents"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

function listOpencodeAgents(): string[] {
  try {
    return readdirSync(expandHome("~/.config/opencode/agent"), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name.replace(/\.md$/, ""))
      .sort()
  } catch {
    return []
  }
}

// --- Step 3: paths hint -------------------------------------------------------

async function stepPathsHint(rl: readline.Interface): Promise<void> {
  printHeader("Step 4 / 4 — Cache + data dirs")
  console.log(c.dim("Informational — these aren't part of skvm.config.json. The defaults below"))
  console.log(c.dim("fit most users; override via env var or flag only if your layout needs it"))
  console.log(c.dim("(CI, shared cluster, temp isolation, etc.).\n"))
  console.log(`  Cache root:  ${shortenPath(SKVM_CACHE)}      ${c.dim("$SKVM_CACHE / --skvm-cache")}`)
  console.log(`  Data dir:    ${shortenPath(SKVM_DATA_DIR)}   ${c.dim("$SKVM_DATA_DIR / --skvm-data-dir")}`)
  console.log(`  Profiles:    ${shortenPath(PROFILES_DIR)}    ${c.dim("$SKVM_PROFILES_DIR")}`)
  console.log(`  Logs:        ${shortenPath(LOGS_DIR)}        ${c.dim("$SKVM_LOGS_DIR")}`)
  console.log(`  Proposals:   ${shortenPath(PROPOSALS_ROOT)}  ${c.dim("$SKVM_PROPOSALS_DIR")}\n`)
  await ask(rl, "Press Enter to continue", "")
}

// ---------------------------------------------------------------------------
// `doctor` — environment health check
// ---------------------------------------------------------------------------

interface CheckResult {
  status: "ok" | "warn" | "fail"
  label: string
  detail?: string
}

async function runDoctor(): Promise<void> {
  const results: CheckResult[] = []

  // Config file — try to read directly; ENOENT is the missing-file case.
  const configPath = getConfigPath()
  try {
    JSON.parse(readFileSync(configPath, "utf8"))
    results.push({ status: "ok", label: `Config file parses (${shortenPath(configPath)})` })
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === "ENOENT") {
      results.push({
        status: "warn",
        label: "Config file present",
        detail: `${shortenPath(configPath)} not found — using defaults. Run \`skvm config init\` to create one.`,
      })
    } else {
      results.push({ status: "fail", label: `Config file parses`, detail: err.message })
    }
  }

  // Provider routes
  const providers = getProvidersConfig()
  if (providers.routes.length === 0) {
    results.push({
      status: process.env.OPENROUTER_API_KEY ? "ok" : "fail",
      label: "Default OpenRouter route",
      detail: process.env.OPENROUTER_API_KEY ? "OPENROUTER_API_KEY is set" : "OPENROUTER_API_KEY is unset",
    })
  } else {
    for (const r of providers.routes) {
      if (r.apiKey) {
        results.push({
          status: "ok",
          label: `Route ${r.match} (${r.kind})`,
          detail: `apiKey ${maskKey(r.apiKey)} stored in config`,
        })
      } else if (r.apiKeyEnv) {
        const present = !!process.env[r.apiKeyEnv]
        results.push({
          status: present ? "ok" : "fail",
          label: `Route ${r.match} (${r.kind})`,
          detail: present ? `${r.apiKeyEnv} is set` : `${r.apiKeyEnv} is unset — calls matching this route will fail`,
        })
      } else {
        results.push({
          status: "fail",
          label: `Route ${r.match} (${r.kind})`,
          detail: "neither apiKey nor apiKeyEnv configured",
        })
      }
      if (r.kind === "openai-compatible" && !r.baseUrl) {
        results.push({
          status: "fail",
          label: `Route ${r.match} baseUrl`,
          detail: "openai-compatible route is missing baseUrl",
        })
      }
    }
  }

  // Headless agent — credentials come from providers.routes, so no per-field
  // check here. Legacy providerOverride/modelPrefix (if present in the file)
  // are flagged by the legacy-field warning below.
  const legacyHeadless = detectLegacyHeadlessFields()
  if (legacyHeadless.length > 0) {
    results.push({
      status: "warn",
      label: "Legacy headlessAgent fields in config",
      detail: `ignored: ${legacyHeadless.join(", ")}. Re-run \`skvm config init\` to remove them.`,
    })
  }

  // Adapter checkouts + native-mode readiness
  for (const a of ALL_ADAPTERS) {
    if (a === "bare-agent") continue
    const dir = getAdapterRepoDir(a as Exclude<AdapterName, "bare-agent">)
    if (dir) {
      if (!existsSync(dir)) {
        results.push({ status: "fail", label: `Adapter ${a} checkout`, detail: `${shortenPath(dir)} does not exist` })
      } else {
        results.push({ status: "ok", label: `Adapter ${a} checkout`, detail: shortenPath(dir) })
      }
    }
    const settings = getAdapterSettings(a as Exclude<AdapterName, "bare-agent">)
    // Native-mode readiness: skip if user defaults to managed AND adapter has no native-specific setting.
    const defMode = getDefaultAdapterConfigMode() ?? "managed"
    const nativeCouldApply = defMode === "native"
      || settings.nativeSourceAgent !== undefined
      || settings.nativeAgent !== undefined
    if (!nativeCouldApply) continue

    if (a === "openclaw") {
      const srcAgent = settings.nativeSourceAgent ?? "main"
      const modelsJson = expandHome(`~/.openclaw/agents/${srcAgent}/agent/models.json`)
      results.push(existsSync(modelsJson)
        ? { status: "ok", label: `openclaw native source agent "${srcAgent}"`, detail: shortenPath(modelsJson) }
        : { status: "fail", label: `openclaw native source agent "${srcAgent}"`, detail: `${shortenPath(modelsJson)} missing — native mode will error` },
      )
    } else if (a === "opencode") {
      const cfg = expandHome("~/.config/opencode/opencode.jsonc")
      results.push(existsSync(cfg)
        ? { status: "ok", label: `opencode native config`, detail: shortenPath(cfg) }
        : { status: "fail", label: `opencode native config`, detail: `${shortenPath(cfg)} missing — native mode will error` },
      )
    } else if (a === "hermes") {
      const cfg = expandHome("~/.hermes/config.yaml")
      results.push(existsSync(cfg)
        ? { status: "ok", label: `hermes native config`, detail: shortenPath(cfg) }
        : { status: "fail", label: `hermes native config`, detail: `${shortenPath(cfg)} missing — native mode will error` },
      )
    } else if (a === "jiuwenclaw" && defMode === "native") {
      results.push({
        status: "fail",
        label: `jiuwenclaw native mode`,
        detail: `jiuwenclaw does not support native; change defaults.adapterConfigMode or pass --adapter-config=managed`,
      })
    }
  }

  // Cache root writability
  results.push(checkWritable("Cache root", SKVM_CACHE))
  // Data dir is optional — most commands don't need it
  if (existsSync(SKVM_DATA_DIR)) {
    results.push({ status: "ok", label: "Data dir present", detail: shortenPath(SKVM_DATA_DIR) })
  } else {
    results.push({
      status: "warn",
      label: "Data dir present",
      detail: `${shortenPath(SKVM_DATA_DIR)} missing — only needed for bench tasks shipped with the repo`,
    })
  }

  // Bundled opencode (best-effort, only if running from compiled binary)
  const installRoot = process.env.SKVM_INSTALL_ROOT
  if (installRoot) {
    const bundled = path.join(installRoot, "vendor", "opencode", "current", "bin", "opencode")
    results.push({
      status: existsSync(bundled) ? "ok" : "warn",
      label: "Bundled opencode binary",
      detail: existsSync(bundled) ? shortenPath(bundled) : "not present — reinstall via install.sh / npm",
    })
  }

  // Print results
  console.log()
  let fails = 0, warns = 0
  for (const r of results) {
    const mark = r.status === "ok" ? c.green("✓") : r.status === "warn" ? c.yellow("⚠") : c.red("✗")
    if (r.status === "fail") fails++
    if (r.status === "warn") warns++
    const detail = r.detail ? c.dim(`  — ${r.detail}`) : ""
    console.log(`  ${mark}  ${r.label}${detail}`)
  }
  console.log()

  if (fails > 0) {
    console.log(c.red(`${fails} check(s) failed.`) + " Fix the items marked ✗ before running skvm in earnest.")
    process.exit(1)
  } else if (warns > 0) {
    console.log(c.yellow(`${warns} warning(s).`) + " Things should work, but read the notes above.")
  } else {
    console.log(c.green("All checks passed."))
  }
}

function checkWritable(label: string, dir: string): CheckResult {
  try {
    if (existsSync(dir)) {
      accessSync(dir, fsConst.W_OK)
      return { status: "ok", label, detail: `${shortenPath(dir)} writable` }
    }
    // Walk up to nearest existing parent and check write there.
    let parent = path.dirname(dir)
    while (!existsSync(parent) && parent !== path.dirname(parent)) parent = path.dirname(parent)
    accessSync(parent, fsConst.W_OK)
    return { status: "ok", label, detail: `${shortenPath(dir)} will be created on first use` }
  } catch (e) {
    return { status: "fail", label, detail: `${shortenPath(dir)} not writable: ${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

async function ask(rl: readline.Interface, label: string, defaultVal: string, yesNo = false): Promise<string> {
  let def: string
  if (defaultVal === "") {
    def = ""
  } else if (yesNo) {
    // Show both options with the default capitalized: [Y/n] or [y/N].
    def = yes(defaultVal) ? " [Y/n]" : " [y/N]"
  } else {
    def = ` [${defaultVal}]`
  }
  const ans = await rl.question(`${label}${def}: `)
  if (ans.trim() === "") return defaultVal
  return ans
}

function yes(s: string): boolean {
  return /^(y|yes|true|1)$/i.test(s.trim())
}

function printHeader(title: string): void {
  const bar = "─".repeat(Math.max(8, title.length + 2))
  console.log(useColor ? c.bold(c.cyan(`\n${title}`)) : `\n${title}`)
  console.log(c.dim(bar))
}

function serialize(draft: ConfigDraft): string {
  // Drop empty optional fields so the output stays minimal.
  const out: Record<string, unknown> = {}
  if (draft.defaults && draft.defaults.adapterConfigMode !== undefined) {
    out.defaults = { adapterConfigMode: draft.defaults.adapterConfigMode }
  }
  const adaptersOut: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(draft.adapters)) {
    if (!v) continue
    // Keep the legacy string form when only repoPath is set, so users who
    // used the previous wizard see the same shape they had before.
    const onlyRepoPath = v.repoPath !== undefined
      && v.nativeSourceAgent === undefined
      && v.nativeAgent === undefined
      && (v.extraCliArgs === undefined || v.extraCliArgs.length === 0)
    if (onlyRepoPath) {
      adaptersOut[k] = v.repoPath
      continue
    }
    const entry: Record<string, unknown> = {}
    if (v.repoPath) entry.repoPath = v.repoPath
    if (v.nativeSourceAgent) entry.nativeSourceAgent = v.nativeSourceAgent
    if (v.nativeAgent) entry.nativeAgent = v.nativeAgent
    if (v.extraCliArgs && v.extraCliArgs.length > 0) entry.extraCliArgs = v.extraCliArgs
    if (Object.keys(entry).length > 0) adaptersOut[k] = entry
  }
  if (Object.keys(adaptersOut).length > 0) out.adapters = adaptersOut
  if (draft.providers.routes.length > 0) {
    out.providers = { routes: draft.providers.routes }
  }
  if (draft.headlessAgent && Object.keys(draft.headlessAgent).length > 0) {
    out.headlessAgent = draft.headlessAgent
  }
  return JSON.stringify(out, null, 2)
}
