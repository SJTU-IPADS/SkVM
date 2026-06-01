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

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, chmodSync, accessSync, readdirSync, unlinkSync, constants as fsConst } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { stdin } from "node:process"

import { checkbox, confirm, input, password, select } from "@inquirer/prompts"
import { createPrompt, isEnterKey, useKeypress, useState } from "@inquirer/core"

import { c, useColor } from "../core/logger.ts"
import { withFileLock } from "../core/file-lock.ts"
import {
  PROJECT_ROOT,
  SKVM_CACHE,
  SKVM_DATA_DIR,
  PROFILES_DIR,
  LOGS_DIR,
  PROPOSALS_ROOT,
  JIT_OPTIMIZE_DIR,
  getConfigPath,
  expandHome,
  getProvidersConfig,
  getHeadlessAgentConfig,
  getAdapterRepoDir,
  getAdapterSettings,
  getDefaultAdapterConfigMode,
  detectLegacyHeadlessFields,
  invalidateConfigCache,
  resolveConfigWritePath,
} from "../core/config.ts"
import type { ProviderKind, ProviderRoute, AdapterConfigMode, HeadlessAgentDriverName } from "../core/types.ts"
import { HeadlessAgentDriverSchema } from "../core/types.ts"
import { appendDiscoveredRoute } from "../core/config-write.ts"
import { ALL_ADAPTERS, type AdapterName } from "../adapters/registry.ts"
import { resolveUserHermesDir as resolveHermesProfileDir } from "../adapters/hermes.ts"
import { resolveUserOpencodeConfigFile as resolveOpencodeConfigFile } from "../adapters/opencode.ts"
import { resolveUserClaudeDir } from "../adapters/claude-code.ts"
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
  driver?: HeadlessAgentDriverName
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

type ConfigurableAdapter = Exclude<AdapterName, "bare-agent">

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
    case "probes": {
      const probesSub = rawArgs[1]
      if (probesSub === "list") {
        runProbesList()
        return
      }
      if (probesSub === "clear") {
        await runProbesClear(rawArgs[2])
        return
      }
      if (probesSub === undefined) {
        printProbesHelp()
        return
      }
      console.error(c.red(`Unknown config probes subcommand: "${probesSub}"`))
      printProbesHelp()
      process.exit(1)
      return
    }
    case "probe": {
      const modelId = rawArgs[1]
      if (!modelId) {
        console.error(c.red("Usage: skvm config probe <modelId>"))
        process.exit(1)
      }
      await runProbeEager(modelId)
      return
    }
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
  init              Interactive wizard; writes ${shortenPath(resolveConfigWritePath())}
  show              Print the resolved config and where each value came from
  doctor            Verify that providers, adapters, and paths actually work
  probes list       Show auto-discovered provider routes
  probes clear      Remove auto-discovered routes (all, or matching a pattern)
  probe <modelId>   Eagerly probe one model id and write a route if clean

Examples:
  skvm config init                         # first-time setup or update existing config
  skvm config show                         # see what skvm currently sees
  skvm config doctor                       # sanity check before running a long bench
  skvm config probes list                  # show auto-discovered routes
  skvm config probes clear                 # remove all auto-discovered routes
  skvm config probe openrouter/qwen/foo    # probe one model id eagerly

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
      const auto = r.discoveredAt
        ? `  ${c.dim(`(auto-discovered ${r.discoveredAt.slice(0, 10)})`)}`
        : ""
      console.log(`  ${r.match.padEnd(colW)}  ${r.kind.padEnd(20)} ${authBadge(r)}${tail}${auto}`)
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
    const dir = getAdapterRepoDir(a as ConfigurableAdapter)
    if (!dir) {
      const probeName = a === "claude-code" ? "claude" : a
      const fallback = a === "opencode"
        ? "not configured (will use `which opencode` on PATH, then bundled copy)"
        : `not configured (will use \`which ${probeName}\` on PATH)`
      console.log(`  ${a.padEnd(labelW)}  ${c.dim(fallback)}`)
    } else {
      const ok = existsSync(dir)
      const tag = ok ? c.green("✓") : c.red("✗ missing")
      console.log(`  ${a.padEnd(labelW)}  ${shortenPath(dir)}  ${tag}`)
    }
    const settings = getAdapterSettings(a as ConfigurableAdapter)
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
// `init` — interactive wizard (arrow-key menus via @inquirer/prompts)
// ---------------------------------------------------------------------------

/** Cap on the number of `skvm.config.json.bak.<ts>` files kept alongside the
 *  active config. Older backups are pruned after each successful `init` write
 *  so repeated re-runs do not accumulate forever. */
const MAX_CONFIG_BACKUPS = 5

function pruneOldConfigBackups(): number {
  const configPath = resolveConfigWritePath()
  const dir = path.dirname(configPath)
  const prefix = `${path.basename(configPath)}.bak.`
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  const backups = entries
    .filter(name => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .map(name => ({ name, ts: Number(name.slice(prefix.length)) }))
    .sort((a, b) => b.ts - a.ts)
  let removed = 0
  for (const stale of backups.slice(MAX_CONFIG_BACKUPS)) {
    try {
      unlinkSync(path.join(dir, stale.name))
      removed += 1
    } catch { /* best-effort */ }
  }
  return removed
}

async function runInit(): Promise<void> {
  if (!stdin.isTTY) {
    console.error(c.red("skvm config init requires an interactive terminal (TTY)."))
    console.error("Edit skvm.config.json directly, or copy the example template:")
    console.error(`  cp ${shortenPath(EXAMPLE_PATH)} ${shortenPath(resolveConfigWritePath())}`)
    process.exit(1)
  }

  const sourcePath = getConfigPath()
  const existing = loadExistingDraft()
  const draft: ConfigDraft = structuredClone(existing)

  let currentIndex = 0
  try {
    while (true) {
      tuiClear()
      printInitHeader(sourcePath)
      const action = await sectionPage({
        initialIndex: currentIndex,
        render: (i) => renderSectionBody(draft, i),
      })
      if (action.type === "cancel") {
        tuiClear()
        console.log(c.yellow("Aborted. No changes written."))
        return
      }
      if (action.type === "write") break
      // action.type === "edit"
      currentIndex = SECTIONS.findIndex(s => s.id === action.section)
      tuiClear()
      printInitHeader(sourcePath)
      printHeader(SECTIONS[currentIndex]!.label)
      console.log(c.dim("  Press Ctrl+C at any time to go back to the section picker.\n"))
      if (action.section === "providers") await stepProviders(draft)
      else if (action.section === "mode") await stepDefaultMode(draft)
      else if (action.section === "adapters") await stepAdapters(draft)
    }

    tuiClear()
    const configPath = resolveConfigWritePath()
    mkdirSync(path.dirname(configPath), { recursive: true })
    if (existsSync(configPath)) {
      const backup = `${configPath}.bak.${Date.now()}`
      copyFileSync(configPath, backup)
      try { chmodSync(backup, 0o600) } catch { /* best-effort, not fatal on Windows */ }
      console.log(c.dim(`Backed up previous config → ${shortenPath(backup)}`))
      const pruned = pruneOldConfigBackups()
      if (pruned > 0) {
        console.log(c.dim(`Pruned ${pruned} older backup${pruned === 1 ? "" : "s"} (keeping ${MAX_CONFIG_BACKUPS} most recent).`))
      }
    }
    const json = serialize(draft)
    writeFileSync(configPath, json + "\n")
    // 0600 because the file may now contain plaintext API keys.
    try { chmodSync(configPath, 0o600) } catch { /* best-effort, not fatal on Windows */ }
    console.log(c.green(`✓ Wrote ${shortenPath(configPath)} (chmod 0600)`))

    console.log(c.bold("\nNext steps"))
    console.log("  skvm config doctor       # verify env vars + paths")
    console.log("  skvm config show         # print resolved config")
    const smokeId = smokeTestModelId(draft.providers.routes)
    console.log(`  skvm profile --model=${smokeId} --primitives=gen.text.prose --instances=1`)
    console.log(c.dim("      # one-shot smoke test (swap the model if your endpoint serves different ids)"))
  } catch (e) {
    if (isExit(e)) {
      tuiClear()
      console.log(c.yellow("Aborted. No changes written."))
      return
    }
    throw e
  }
}

/** Clear visible area + scrollback and park cursor at top-left. Keeps the
 *  wizard feeling like a single TUI page instead of a scrolling transcript. */
function tuiClear(): void {
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H")
}

function printInitHeader(sourcePath: string): void {
  printHeader("skvm config")
  console.log(c.dim(`Writes ${c.bold(shortenPath(resolveConfigWritePath()))}`))
  if (existsSync(sourcePath) && sourcePath === CONFIG_LEGACY_PATH) {
    console.log(c.yellow(`Loading defaults from legacy path ${shortenPath(sourcePath)}.`))
  }
  console.log()
}

/** Ctrl+C inside inquirer throws ExitPromptError / AbortPromptError — match by name so we
 *  don't have to pull ExitPromptError from @inquirer/core (a transitive dep). */
function isExit(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name
  return name === "ExitPromptError" || name === "AbortPromptError"
}

/** Prepend "1.", "2.", ... to each choice name so users can visually reference options.
 *  The `const` type parameter keeps literal types on `value` (e.g. "keep" stays "keep",
 *  not widened to `string`) so inquirer's discriminated-union choice types line up. */
function numbered<const T extends { name: string }>(items: readonly T[]): T[] {
  return items.map((it, i) => ({ ...it, name: `${i + 1}. ${it.name}` } as T))
}

/** Render dim help text on the lines below the main question, inside the prompt's
 *  message. Ends with \n so inquirer's cursor/default indicator sits on the next line. */
function withHelp(message: string, ...helpLines: string[]): string {
  if (helpLines.length === 0) return message
  return message + "\n" + helpLines.map(l => `  ${c.dim(l)}`).join("\n") + "\n"
}

/** Inquirer `input` transformer that shows a dim "(type here)" placeholder when
 *  the field is empty — only meaningful for fields whose default is empty too.
 *  Inquirer skips `style.answer` when a transformer is set, so we have to paint
 *  the final value in cyan ourselves to match select's highlight color. */
function typeHint(value: string, { isFinal }: { isFinal: boolean }): string {
  if (isFinal) return value === "" ? "" : c.cyan(value)
  return value === "" ? c.dim("(type here)") : value
}

/** Applied to every `input` / `password` call:
 *    - on submit, collapse the message back to its first line so the dim help
 *      text inside `withHelp()` disappears (less scroll clutter),
 *    - render the submitted value in cyan so input answers match how select
 *      highlights the chosen choice. */
const INPUT_THEME = {
  style: {
    message: (text: string, status: "idle" | "done" | "loading") =>
      status === "done" ? (text.split("\n")[0] ?? text) : text,
    answer: (text: string) => c.cyan(text),
  },
}

function loadExistingDraft(): ConfigDraft {
  const draft: ConfigDraft = {
    adapters: {},
    providers: { routes: [] },
  }
  // Try cache-dir first, fall back to legacy. tryReadJson swallows ENOENT so
  // we don't pre-check existence — that avoids a TOCTOU window and keeps the
  // path linear.
  const raw = tryReadJson(resolveConfigWritePath()) ?? tryReadJson(CONFIG_LEGACY_PATH)
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
    const parsedDriver = HeadlessAgentDriverSchema.safeParse(ha.driver)
    if (parsedDriver.success) preserved.driver = parsedDriver.data
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

async function stepProviders(draft: ConfigDraft): Promise<void> {
  try {
    console.log(c.dim("Each 'route' tells skvm where to send a class of model ids. The first"))
    console.log(c.dim("match wins (order matters). Keys are stored in skvm.config.json"))
    console.log(c.dim("(gitignored, chmod 0600), or you can point at an env var name instead.\n"))

    const existingKinds = Array.from(new Set(draft.providers.routes.map(r => r.kind)))
    const selected = await checkbox<ProviderKind>({
      message: "Which providers do you want to configure?",
      choices: numbered([
        { name: "OpenRouter", value: "openrouter" as ProviderKind,
          checked: existingKinds.includes("openrouter"),
          description: "openrouter/*, hundreds of models behind one key" },
        { name: "Anthropic native", value: "anthropic" as ProviderKind,
          checked: existingKinds.includes("anthropic"),
          description: "anthropic/*, api.anthropic.com" },
        { name: "OpenAI-compatible", value: "openai-compatible" as ProviderKind,
          checked: existingKinds.includes("openai-compatible"),
          description: "OpenAI / DeepSeek / vLLM / Ollama / proxy / etc." },
      ]),
    })

    // Drop routes whose kind the user unchecked.
    draft.providers.routes = draft.providers.routes.filter(r => selected.includes(r.kind))

    for (const kind of selected) {
      if (kind === "openai-compatible") {
        await handleOpenAICompatible(draft)
      } else {
        await handleSingleKind(draft, kind)
      }
    }
  } catch (e) {
    // Ctrl+C inside this step = "go back to TUI" rather than "abort the wizard".
    // Any partial draft changes already made are preserved.
    if (isExit(e)) return
    throw e
  }
}

/** OpenRouter / Anthropic — at most one route per kind. */
async function handleSingleKind(draft: ConfigDraft, kind: Exclude<ProviderKind, "openai-compatible">): Promise<void> {
  const existing = draft.providers.routes.find(r => r.kind === kind)
  if (existing) {
    const action = await select<"keep" | "reedit" | "remove">({
      message: `${kind} route already configured (${authBadge(existing)}). What now?`,
      default: "keep",
      choices: numbered([
        { name: "Keep as-is", value: "keep" },
        { name: "Re-edit", value: "reedit" },
        { name: "Remove", value: "remove" },
      ]),
    })
    draft.providers.routes = draft.providers.routes.filter(r => r.kind !== kind)
    if (action === "keep") {
      draft.providers.routes.push(existing)
      return
    }
    if (action === "remove") return
    const r = await configureRoute(kind, existing)
    if (r) draft.providers.routes.push(r)
    else draft.providers.routes.push(existing) // cancelled — restore
    return
  }
  const r = await configureRoute(kind)
  if (r) draft.providers.routes.push(r)
}

/** OpenAI-compatible can host multiple routes (openai + deepseek + vllm …).
 *  Lets the user add, edit, or remove each one individually. */
async function handleOpenAICompatible(draft: ConfigDraft): Promise<void> {
  type Action =
    | "done"
    | "add"
    | { kind: "edit"; ref: RouteDraft }
    | { kind: "remove"; ref: RouteDraft }

  while (true) {
    const existing = draft.providers.routes.filter(r => r.kind === "openai-compatible")
    const fmt = (r: RouteDraft) => `${r.match}${r.baseUrl ? ` @ ${r.baseUrl}` : ""}`

    const choices: { name: string; value: Action; description?: string }[] = [
      { name: "Done — continue to next section", value: "done" },
      { name: existing.length === 0 ? "Add a route" : "Add another route", value: "add" },
      ...existing.map(r => ({
        name: `Edit ${fmt(r)}`,
        value: { kind: "edit" as const, ref: r },
        description: authBadge(r),
      })),
      ...existing.map(r => ({
        name: `Remove ${fmt(r)}`,
        value: { kind: "remove" as const, ref: r },
      })),
    ]

    // When no routes exist yet, default to "add" so Enter moves the user forward.
    const defaultAction: Action = existing.length === 0 ? "add" : "done"

    const action = await select<Action>({
      message: `OpenAI-compatible routes — ${existing.length} configured`,
      default: defaultAction,
      choices: numbered(choices),
    })

    if (action === "done") return
    if (action === "add") {
      const r = await configureRoute("openai-compatible")
      if (r) draft.providers.routes.push(r)
      continue
    }
    const idx = draft.providers.routes.indexOf(action.ref)
    if (idx < 0) continue
    if (action.kind === "edit") {
      const updated = await configureRoute("openai-compatible", action.ref)
      if (updated) draft.providers.routes[idx] = updated
      // null = user cancelled mid-edit → leave the original route untouched
    } else {
      draft.providers.routes.splice(idx, 1)
    }
  }
}

async function configureRoute(
  kind: ProviderKind,
  existing?: RouteDraft,
): Promise<RouteDraft | null> {
  try {
    if (kind === "openrouter") {
      console.log(c.dim("\n→ OpenRouter — matches `openrouter/*`; routes through openrouter.ai."))
      const auth = await askApiKey("OpenRouter", "OPENROUTER_API_KEY", existing)
      if (!auth) return null
      return { match: "openrouter/*", kind, ...auth }
    }
    if (kind === "anthropic") {
      console.log(c.dim("\n→ Anthropic native — matches `anthropic/*`; routes to api.anthropic.com."))
      const auth = await askApiKey("Anthropic", "ANTHROPIC_API_KEY", existing)
      if (!auth) return null
      return { match: "anthropic/*", kind, ...auth }
    }
    // openai-compatible
    console.log(c.dim("\n→ OpenAI-compatible — any endpoint implementing the OpenAI API"))
    console.log(c.dim("  Examples: https://api.openai.com/v1, https://api.deepseek.com/v1,"))
    console.log(c.dim("            http://localhost:8000/v1 (vLLM), http://localhost:11434/v1 (Ollama)"))
    const baseUrl = (await input({
      message: "API base URL",
      default: existing?.baseUrl ?? "https://api.openai.com/v1",
      theme: INPUT_THEME,
    })).trim() || "https://api.openai.com/v1"

    const derivedPrefix = derivePrefixFromUrl(baseUrl)
    const existingPrefix = existing?.match?.split("/")[0]
    const matchPrefix = (await input({
      message: withHelp(
        "Short name for this route",
        `Short name you'll use on the CLI — model ids become "<name>/<model>".`,
        `Example: name "openai" means you type \`openai/gpt-4o\` to hit this route.`,
      ),
      default: existingPrefix ?? derivedPrefix,
      theme: INPUT_THEME,
    })).trim() || derivedPrefix

    const defaultMatch = `${matchPrefix}/*`
    const match = (await input({
      message: withHelp(
        "Match pattern (optional)",
        `Which model ids this route handles (a glob pattern).`,
        `Default \`${defaultMatch}\` catches every ${matchPrefix}/<model>.`,
        `Override only if you want a narrower match, e.g. one exact id.`,
      ),
      default: existing?.match ?? defaultMatch,
      theme: INPUT_THEME,
    })).trim() || defaultMatch

    const auth = await askApiKey(
      match,
      `${matchPrefix.toUpperCase().replace(/-/g, "_")}_API_KEY`,
      existing,
    )
    if (!auth) return null
    return { match, kind: "openai-compatible", baseUrl, ...auth }
  } catch (e) {
    if (isExit(e)) return null
    throw e
  }
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
 *   - Paste it now → stored as `apiKey` directly in skvm.config.json.
 *   - Use an env var → stored as `apiKeyEnv` (good for direnv / 1password /
 *     vault setups, or shared CI).
 * Returns null only if the outer try-catch signals the user aborted.
 */
async function askApiKey(
  routeLabel: string,
  defaultEnvName: string,
  existing?: RouteDraft,
): Promise<{ apiKey?: string; apiKeyEnv?: string } | null> {
  try {
    const source = await select<"paste" | "env">({
      message: `How should skvm get the API key for ${routeLabel}?`,
      default: existing?.apiKeyEnv ? "env" : "paste",
      choices: numbered([
        { name: "Paste it now", value: "paste",
          description: "stored in skvm.config.json (chmod 0600)" },
        { name: "Read from env var", value: "env",
          description: "store env var name; skvm reads it at runtime" },
      ]),
    })
    if (source === "env") {
      const name = (await input({
        message: "Environment variable name",
        default: existing?.apiKeyEnv ?? defaultEnvName,
        theme: INPUT_THEME,
      })).trim() || defaultEnvName
      if (!process.env[name]) {
        console.log(c.yellow(`  Reminder: export ${name}=<your-key> in your shell (e.g. add it to ~/.zshrc or ~/.bashrc) before running skvm.`))
      } else {
        console.log(c.green(`  ✓ ${name} is set in current shell`))
      }
      return { apiKeyEnv: name }
    }
    const key = (await password({
      message: `${routeLabel} API key`,
      mask: "*",
      theme: INPUT_THEME,
    })).trim()
    if (!key) {
      console.log(c.yellow("  No key entered — skvm will fail to authenticate when this route is used."))
      console.log(c.yellow("  You can re-run `skvm config init` later, or edit skvm.config.json directly."))
    }
    return { apiKey: key }
  } catch (e) {
    if (isExit(e)) return null
    throw e
  }
}

// --- Step 2: default adapter mode --------------------------------------------

async function stepDefaultMode(draft: ConfigDraft): Promise<void> {
  try {
    console.log(c.dim("Each run can be `native` (use your real harness config from ~/.openclaw,"))
    console.log(c.dim("~/.config/opencode, ~/.hermes) or `managed` (a clean sandbox with skvm-generated"))
    console.log(c.dim("config derived from providers.routes). Override per-run with --adapter-config=<m>.\n"))
    const cur = draft.defaults?.adapterConfigMode ?? "managed"
    const mode = await select<AdapterConfigMode>({
      message: "Default mode",
      default: cur,
      choices: numbered([
        { name: "managed", value: "managed",
          description: "clean sandbox; best for bench / profile / jit-optimize" },
        { name: "native", value: "native",
          description: "real ~/.openclaw, ~/.config/opencode, ~/.hermes" },
      ]),
    })
    draft.defaults = { adapterConfigMode: mode }
  } catch (e) {
    if (isExit(e)) return
    throw e
  }
}

// --- Step 3: adapters --------------------------------------------------------

async function stepAdapters(draft: ConfigDraft): Promise<void> {
  try {
    console.log(c.dim("Adapters are external agent CLIs (opencode, openclaw, hermes, jiuwenclaw)."))
    console.log(c.dim("Point one at a local git clone if you want skvm to build/run the agent"))
    console.log(c.dim("from source. Otherwise skvm tries `which <name>` on your PATH.\n"))

    const configurable = ALL_ADAPTERS.filter((a): a is ConfigurableAdapter => a !== "bare-agent")
    const picked = await checkbox<ConfigurableAdapter>({
      message: "Which adapters do you want to configure?",
      choices: numbered(configurable.map(a => ({
        name: a,
        value: a,
        checked: !!draft.adapters[a],
        description: a === "jiuwenclaw" ? "managed-only (no native support)" : undefined,
      }))),
    })

    for (const a of configurable) {
      if (!picked.includes(a)) delete draft.adapters[a]
    }

    for (const a of picked) {
      console.log(c.bold(`\n  ${a}`))
      const cur = draft.adapters[a] ?? {}
      const next = await configureAdapter(a, cur)
      if (next === null) continue // Ctrl+C inside sub-flow — keep previous draft entry
      if (Object.keys(next).length > 0) draft.adapters[a] = next
      else delete draft.adapters[a]
    }
  } catch (e) {
    if (isExit(e)) return
    throw e
  }
}

async function configureAdapter(a: ConfigurableAdapter, cur: AdapterDraft): Promise<AdapterDraft | null> {
  try {
    const next: AdapterDraft = {}

    // claude-code is shipped as a single `claude` binary, not a buildable
    // checkout — the prompt copy reflects that and offers `which claude`
    // autodetect as the default.
    let repoMessage: string
    let repoDefault: string
    if (a === "claude-code") {
      const detected = whichBinary("claude")
      repoMessage = withHelp(
        "Path to the claude binary (optional)",
        "Absolute path to the `claude` executable.",
        detected
          ? `Leave empty to use ${shortenPath(detected)} (auto-detected via \`which claude\`).`
          : "Leave empty to use whatever `which claude` finds at run time.",
      )
      repoDefault = cur.repoPath ?? ""
    } else {
      repoMessage = withHelp(
        "Local checkout path (optional)",
        "Local git clone of the adapter — skvm will build / run it from source.",
        "Leave empty to use the binary already on your $PATH.",
      )
      repoDefault = cur.repoPath ?? ""
    }

    const repoAns = (await input({
      message: repoMessage,
      default: repoDefault,
      transformer: typeHint,
      theme: INPUT_THEME,
    })).trim()
    if (repoAns) {
      const expanded = expandHome(repoAns)
      if (!existsSync(expanded)) {
        console.log(c.yellow(`  ⚠ ${shortenPath(expanded)} does not exist — saving anyway.`))
      }
      next.repoPath = repoAns
    }

    if (a === "openclaw") {
      next.nativeSourceAgent = await pickNativeAgent({
        agents: listOpenclawAgents(),
        message: "Native source agent",
        existing: cur.nativeSourceAgent,
        preferredDefault: "main",
        missingNote: "  ⚠ no ~/.openclaw/agents found — native mode will error until you create one.",
      })
    }
    if (a === "opencode") {
      next.nativeAgent = await pickNativeAgent({
        agents: listOpencodeAgents(),
        message: "Native agent",
        existing: cur.nativeAgent,
        preferredDefault: "build",
      })
    }
    if (a === "hermes") {
      const srcDir = resolveHermesProfileDir()
      const cfg = path.join(srcDir, "config.yaml")
      const env = path.join(srcDir, ".env")
      const disp = shortenPath(srcDir)
      if (existsSync(cfg)) {
        console.log(c.green(`  ✓ found ${shortenPath(cfg)} (native mode ready, from ${disp})`))
      } else {
        console.log(c.yellow(`  ⚠ ${shortenPath(cfg)} missing — native mode will error.`))
      }
      if (!existsSync(env)) {
        console.log(c.yellow(`  ⚠ ${shortenPath(env)} missing — native mode may lack API keys.`))
      }
    }
    if (a === "claude-code") {
      const userDir = resolveUserClaudeDir()
      const settingsFile = path.join(userDir, "settings.json")
      if (existsSync(settingsFile)) {
        console.log(c.green(`  ✓ found ${shortenPath(settingsFile)} (native mode ready)`))
      } else {
        console.log(c.yellow(`  ⚠ ${shortenPath(settingsFile)} missing — native mode will error until you run \`claude /login\`.`))
      }
      console.log(c.dim("  Managed mode requires an `anthropic` route in providers.routes."))
    }
    if (a === "jiuwenclaw") {
      console.log(c.yellow("  note: jiuwenclaw only supports --adapter-config=managed."))
    }

    const extraAns = (await input({
      message: withHelp(
        "Extra CLI arguments (optional, space-separated)",
        "Extra flags appended to the adapter CLI invocation (power-user escape hatch).",
        `Example for opencode: \`--log-level=debug\`. Most users leave this empty.`,
      ),
      default: (cur.extraCliArgs ?? []).join(" "),
      transformer: typeHint,
      theme: INPUT_THEME,
    })).trim()
    if (extraAns) {
      next.extraCliArgs = extraAns.split(/\s+/).filter(Boolean)
    }

    return next
  } catch (e) {
    if (isExit(e)) return null
    throw e
  }
}

function whichBinary(name: string): string | null {
  try {
    const r = spawnSync("which", [name], { encoding: "utf8" })
    if (r.status === 0 && r.stdout) {
      const out = r.stdout.trim()
      return out || null
    }
  } catch { /* best-effort */ }
  return null
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

/** Pick an openclaw/opencode agent name: a numbered select when the on-disk list
 *  is non-empty, else a free-text input with an optional "directory missing" note. */
async function pickNativeAgent(opts: {
  agents: string[]
  message: string
  existing: string | undefined
  preferredDefault: string
  missingNote?: string
}): Promise<string> {
  const { agents, message, existing, preferredDefault, missingNote } = opts
  const def = existing ?? (agents.includes(preferredDefault) ? preferredDefault : agents[0] ?? preferredDefault)
  if (agents.length > 0) {
    return select<string>({
      message,
      default: agents.includes(def) ? def : agents[0]!,
      choices: numbered(agents.map(x => ({ name: x, value: x }))),
    })
  }
  if (missingNote) console.log(c.yellow(missingNote))
  return (await input({
    message,
    default: def,
    theme: INPUT_THEME,
  })).trim() || def
}

// --- TUI section pager -------------------------------------------------------

type SectionId = "providers" | "mode" | "adapters" | "write"

interface Section {
  id: SectionId
  label: string
}

const SECTIONS: Section[] = [
  { id: "providers", label: "Providers" },
  { id: "mode", label: "Default mode" },
  { id: "adapters", label: "Adapters" },
  { id: "write", label: "✓ Write & exit" },
]

type PageAction =
  | { type: "edit"; section: Exclude<SectionId, "write"> }
  | { type: "write" }
  | { type: "cancel" }

/** Single-page TUI: horizontal tab row at top, section body below. Left/right
 *  (or h/l) switch sections; Enter opens the current tab (edit, or write);
 *  q/Esc cancels. Body updates live as cursor moves. */
const sectionPage = createPrompt<PageAction, {
  initialIndex: number
  render: (index: number) => string
}>((config, done) => {
  const [cursor, setCursor] = useState<number>(config.initialIndex)

  useKeypress((key) => {
    if (key.name === "left" || key.name === "h") {
      setCursor(Math.max(0, cursor - 1))
    } else if (key.name === "right" || key.name === "l") {
      setCursor(Math.min(SECTIONS.length - 1, cursor + 1))
    } else if (isEnterKey(key)) {
      const sec = SECTIONS[cursor]!
      if (sec.id === "write") done({ type: "write" })
      else done({ type: "edit", section: sec.id })
    } else if (key.name === "q" || key.name === "escape") {
      done({ type: "cancel" })
    }
  })

  const tabRow = SECTIONS.map((s, i) =>
    i === cursor ? c.cyan(c.bold(`▸ ${s.label} ◂`)) : c.dim(`  ${s.label}  `),
  ).join("  ")
  const body = config.render(cursor)
  const hint = c.dim("←/→: switch section · Enter: open · q: cancel")
  return `  ${tabRow}\n\n${body}\n\n  ${hint}`
})

function renderSectionBody(draft: ConfigDraft, index: number): string {
  const section = SECTIONS[index]!
  switch (section.id) {
    case "providers":
      return indent(summarizeProviders(draft))
        + "\n\n  " + c.dim("Press Enter to configure providers.")
    case "mode":
      return indent(summarizeDefaultMode(draft).trimStart())
        + "\n\n  " + c.dim("Press Enter to change the default adapter mode.")
    case "adapters":
      return indent(summarizeAdapters(draft).trimStart())
        + "\n\n  " + c.dim("Press Enter to configure adapters.")
    case "write": {
      const full = [
        summarizeProviders(draft),
        summarizeDefaultMode(draft),
        summarizeAdapters(draft),
      ].join("\n")
      const target = shortenPath(resolveConfigWritePath())
      return indent(full.trimStart())
        + "\n\n  " + c.dim(`Press Enter to write ${target}.`)
    }
  }
}

/** Prepend two spaces to every line so the section body aligns with the tab row. */
function indent(s: string): string {
  return s.split("\n").map(l => l ? `  ${l}` : l).join("\n")
}

function summarizeProviders(draft: ConfigDraft): string {
  const lines: string[] = [c.bold("Providers:")]
  if (draft.providers.routes.length === 0) {
    lines.push(c.dim("  (none configured — falling back to OPENROUTER_API_KEY at runtime)"))
  } else {
    for (const r of draft.providers.routes) {
      const tail = r.kind === "openai-compatible" && r.baseUrl ? ` ${c.dim(`@ ${r.baseUrl}`)}` : ""
      lines.push(`  ${c.cyan(r.match)} → ${r.kind} via ${authBadge(r)}${tail}`)
    }
  }
  return lines.join("\n")
}

function summarizeDefaultMode(draft: ConfigDraft): string {
  const mode = draft.defaults?.adapterConfigMode ?? "managed"
  return `\n${c.bold("Default adapter mode:")} ${mode}`
}

function summarizeAdapters(draft: ConfigDraft): string {
  const lines: string[] = [`\n${c.bold("Adapters:")}`]
  const entries = Object.entries(draft.adapters).filter(([, v]) => v) as [AdapterName, AdapterDraft][]
  if (entries.length === 0) {
    lines.push(c.dim("  (none configured — PATH lookup will be used)"))
    return lines.join("\n")
  }
  const labelW = Math.max(...entries.map(([k]) => k.length))
  for (const [k, v] of entries) {
    const parts: string[] = []
    parts.push(v.repoPath ? shortenPath(v.repoPath) : c.dim("(PATH)"))
    if (v.nativeSourceAgent) parts.push(`${c.dim("src=")}${v.nativeSourceAgent}`)
    if (v.nativeAgent) parts.push(`${c.dim("agent=")}${v.nativeAgent}`)
    if (v.extraCliArgs?.length) parts.push(`${c.dim("extra=")}${v.extraCliArgs.join(" ")}`)
    lines.push(`  ${k.padEnd(labelW)}  ${parts.join("  ")}`)
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// `doctor` — environment health check
// ---------------------------------------------------------------------------

interface CheckResult {
  /** `info` = not configured (neutral `—`), distinct from `warn`/`fail` which flag problems. */
  status: "ok" | "info" | "warn" | "fail"
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
    results.push(process.env.OPENROUTER_API_KEY
      ? { status: "ok", label: "Default OpenRouter route", detail: "OPENROUTER_API_KEY is set" }
      : { status: "info", label: "Providers", detail: "not configured (run `skvm config init`)" },
    )
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

  // Headless driver pi — confirm @mariozechner/pi-coding-agent is importable.
  const ha = getHeadlessAgentConfig()
  if (ha.driver === "pi") {
    try {
      await import("@mariozechner/pi-coding-agent")
      results.push({ status: "ok", label: "headless driver pi resolvable" })
    } catch (err) {
      results.push({
        status: "fail",
        label: "headless driver pi resolvable",
        detail: `cannot import @mariozechner/pi-coding-agent (${(err as Error).message}). ` +
                `Reinstall skvm via install.sh or 'npm install' to restore node_modules.`,
      })
    }
  }

  // Adapter checkouts + native-mode readiness
  for (const a of ALL_ADAPTERS) {
    if (a === "bare-agent") continue
    const dir = getAdapterRepoDir(a as ConfigurableAdapter)
    const settings = getAdapterSettings(a as ConfigurableAdapter)
    const adapterHasConfig = !!dir
      || settings.nativeSourceAgent !== undefined
      || settings.nativeAgent !== undefined

    // Unconfigured adapters get a neutral `—` row and skip deeper checks —
    // the user didn't ask for this adapter, so we shouldn't flag anything red.
    if (!adapterHasConfig) {
      if (a === "claude-code") {
        const found = whichBinary("claude")
        results.push(found
          ? { status: "info", label: `Adapter ${a}`, detail: `not configured (will use ${shortenPath(found)} on PATH)` }
          : { status: "info", label: `Adapter ${a}`, detail: "not configured (no `claude` on PATH either)" },
        )
      } else {
        results.push({ status: "info", label: `Adapter ${a}`, detail: "not configured" })
      }
      continue
    }

    if (dir) {
      if (!existsSync(dir)) {
        results.push({ status: "fail", label: `Adapter ${a} checkout`, detail: `${shortenPath(dir)} does not exist` })
      } else {
        results.push({ status: "ok", label: `Adapter ${a} checkout`, detail: shortenPath(dir) })
      }
    } else if (a === "claude-code") {
      // claude-code is shipped as a binary; if the user didn't pin a path,
      // verify `which claude` finds something so they're not surprised at
      // run-time. This branch is conditional on adapter being configured
      // (we only get here if `adapterHasConfig` was true).
      const found = whichBinary("claude")
      results.push(found
        ? { status: "ok", label: `claude binary on PATH`, detail: shortenPath(found) }
        : { status: "fail", label: `claude binary on PATH`, detail: `\`which claude\` returned nothing — install Claude Code or set adapters.claude-code.repoPath` },
      )
    }
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
    } else if (a === "claude-code") {
      const userDir = resolveUserClaudeDir()
      const settingsFile = path.join(userDir, "settings.json")
      results.push(existsSync(settingsFile)
        ? { status: "ok", label: `claude-code native config`, detail: shortenPath(settingsFile) }
        : { status: "fail", label: `claude-code native config`, detail: `${shortenPath(settingsFile)} missing — run \`claude /login\` or switch to managed` },
      )
    } else if (a === "opencode") {
      const cfg = resolveOpencodeConfigFile()
      results.push(cfg
        ? { status: "ok", label: `opencode native config`, detail: shortenPath(cfg) }
        : { status: "fail", label: `opencode native config`, detail: `no opencode.{jsonc,json} / config.json in XDG_CONFIG_HOME, OPENCODE_CONFIG*, or ~/.opencode — native mode will error` },
      )
    } else if (a === "hermes") {
      const cfg = path.join(resolveHermesProfileDir(), "config.yaml")
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
    const mark = r.status === "ok" ? c.green("✓")
      : r.status === "info" ? c.dim("—")
      : r.status === "warn" ? c.yellow("⚠")
      : c.red("✗")
    if (r.status === "fail") fails++
    if (r.status === "warn") warns++
    const detail = r.detail ? c.dim(`  ${r.status === "info" ? "·" : "—"} ${r.detail}`) : ""
    console.log(`  ${mark}  ${r.label}${detail}`)
  }
  console.log()

  // Migration note: warn if prior opencode proposals exist but the config
  // does not pin headlessAgent.driver (meaning the user may not have noticed
  // that the default flipped from opencode to pi).
  const hasLegacyOpencodeProposals = existsSync(path.join(JIT_OPTIMIZE_DIR, "opencode"))
  const cfgWritePath = resolveConfigWritePath()
  const configRaw = existsSync(cfgWritePath) ? readFileSync(cfgWritePath, "utf-8") : ""
  const explicitDriverSet = configRaw.includes(`"driver"`)
  if (hasLegacyOpencodeProposals && !explicitDriverSet) {
    console.log(c.dim(
      `note: default headless-agent driver changed to "pi" in this release; ` +
      `prior proposals were produced by opencode. Set headlessAgent.driver ` +
      `explicitly in skvm.config.json to pin behavior.`
    ))
  }

  if (fails > 0) {
    console.log(c.yellow(`${fails} issue(s) to look at.`) + ` See the items above marked ${c.red("✗")}.`)
  } else if (warns > 0) {
    console.log(c.yellow(`${warns} warning(s).`) + " Things should work, but read the notes above.")
  } else {
    console.log(c.green("All checks passed."))
  }
  // No non-zero exit — doctor is informational, the caller can decide severity.
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
// Presentation helpers
// ---------------------------------------------------------------------------

function printHeader(title: string): void {
  const bar = "─".repeat(Math.max(8, title.length + 2))
  console.log(useColor ? c.bold(c.cyan(`\n${title}`)) : `\n${title}`)
  console.log(c.dim(bar))
}

// Re-export from core so the CLI and registry share the same implementation
// without any circular dependency. The function lives in src/core/config-write.ts
// which has no prompt or cli-config dependencies.
export { appendDiscoveredRoute } from "../core/config-write.ts"


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

// ---------------------------------------------------------------------------
// `probes list` / `probes clear` / `probe <modelId>` helpers
// ---------------------------------------------------------------------------

function runProbesList(): void {
  const configPath = resolveConfigWritePath()
  if (!existsSync(configPath)) {
    console.log(c.dim("No auto-discovered routes."))
    return
  }
  let cfg: { providers?: { routes?: ProviderRoute[] } }
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf-8")) as { providers?: { routes?: ProviderRoute[] } }
  } catch {
    cfg = {}
  }
  const routes = cfg.providers?.routes ?? []
  const discovered = routes.filter((r): r is ProviderRoute => Boolean(r.discoveredAt))
  if (discovered.length === 0) {
    console.log(c.dim("No auto-discovered routes."))
    return
  }
  console.log(c.bold("Auto-discovered routes"))
  for (const r of discovered) {
    console.log(
      `  ${c.green(r.match)} → ${r.kind} @ ${r.baseUrl ?? "(default)"}  ${c.dim(`(discovered ${r.discoveredAt})`)}`,
    )
  }
}

async function runProbesClear(pattern: string | undefined): Promise<void> {
  const configPath = resolveConfigWritePath()
  const lockPath = `${configPath}.lock`
  await withFileLock(lockPath, { timeoutMs: 5_000 }, async () => {
    if (!existsSync(configPath)) {
      console.log(c.dim("No config file."))
      return
    }
    const raw = readFileSync(configPath, "utf-8")
    const draft = JSON.parse(raw) as Record<string, unknown> & {
      providers?: { routes?: ProviderRoute[] }
    }
    const routes: ProviderRoute[] = draft.providers?.routes ?? []
    const before = routes.length
    const remaining = routes.filter((r) => {
      // Keep non-auto-discovered routes always.
      if (!r.discoveredAt) return true
      // For auto-discovered routes: drop if no pattern given, or if pattern matches.
      if (pattern && !simpleGlobMatch(pattern, r.match)) return true
      return false
    })
    if (!draft.providers) draft.providers = { routes: [] }
    draft.providers.routes = remaining
    writeFileSync(configPath, JSON.stringify(draft, null, 2) + "\n")
    try { chmodSync(configPath, 0o600) } catch { /* best-effort */ }
    invalidateConfigCache()
    console.log(c.green(`✓ Removed ${before - remaining.length} auto-discovered route(s).`))
  })
}

/**
 * Eagerly probe a single model id. Uses dynamic imports to avoid an import
 * cycle: providers/registry.ts already imports appendDiscoveredRoute from this
 * file, so a static top-level import back into registry.ts would form a cycle.
 */
async function runProbeEager(modelId: string): Promise<void> {
  console.log(`Probing ${modelId}…`)
  const saved = process.env.SKVM_AUTO_PROBE
  process.env.SKVM_AUTO_PROBE = "0"
  try {
    // Dynamic imports to avoid cli-config ↔ providers/registry circular dependency.
    const [
      { resolveRoute, createProviderForModel },
      { inferAnthropicBaseUrl, runProbe },
      { AnthropicProvider },
      { stripRoutingPrefix },
    ] = await Promise.all([
      import("../providers/registry.ts"),
      import("../providers/probe.ts"),
      import("../providers/anthropic.ts"),
      import("../core/config.ts"),
    ])

    const route = resolveRoute(modelId)
    if (route.kind !== "openai-compatible") {
      console.log(c.dim(`Skipping — route kind "${route.kind}" is not subject to issue #26.`))
      return
    }
    if (!route.baseUrl) {
      console.log(c.dim(`Skipping — route "${route.match}" has no baseUrl.`))
      return
    }
    const delegate = createProviderForModel(modelId)
    const altBase = inferAnthropicBaseUrl(route.baseUrl)
    if (!altBase) {
      console.log(c.yellow("No Anthropic-shape alternative could be inferred from the baseUrl."))
      return
    }
    const apiKey = route.apiKey ?? (route.apiKeyEnv ? process.env[route.apiKeyEnv] : undefined)
    const alt = new AnthropicProvider({
      apiKey,
      model: stripRoutingPrefix(modelId),
      baseUrl: altBase,
    })
    const verdict = await runProbe({ primary: delegate, alt: () => alt })
    console.log(`Verdict: primary=${verdict.primary} alt=${verdict.alt ?? "-"}`)
    if (verdict.primary === "polluted" && verdict.alt === "clean") {
      const result = await appendDiscoveredRoute({
        match: modelId,
        kind: "anthropic",
        baseUrl: altBase,
        apiKey: route.apiKey,
        apiKeyEnv: route.apiKeyEnv,
        discoveredAt: new Date().toISOString(),
        discoveredFrom: route.match,
      })
      console.log(c.green(result.written ? `✓ Wrote literal route for ${modelId}` : `(already present)`))
    } else {
      console.log(c.dim("No clean alternative — leaving config unchanged."))
    }
  } finally {
    if (saved === undefined) delete process.env.SKVM_AUTO_PROBE
    else process.env.SKVM_AUTO_PROBE = saved
  }
}

function printProbesHelp(): void {
  console.log(c.bold("skvm config probes"))
  console.log(`  list             Show auto-discovered routes`)
  console.log(`  clear [pattern]  Remove auto-discovered routes (all, or those matching pattern)`)
  console.log(`  Use \`skvm config probe <modelId>\` to trigger an eager probe.`)
}

function simpleGlobMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`).test(value)
}
