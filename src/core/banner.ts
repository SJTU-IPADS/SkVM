/**
 * Startup banner — prints key environment info at the beginning of each
 * command so the user immediately sees which adapter, provider route,
 * and directories are in play.
 */

import { getProvidersConfig, getAdapterRepoDir } from "./config.ts"
import { findMatchingRoute } from "../providers/registry.ts"
import { c } from "./logger.ts"
import pkgJson from "../../package.json" with { type: "json" }

const HOME = process.env.HOME ?? ""

/** Replace $HOME prefix with `~` for display. */
export function shortenPath(p: string): string {
  if (HOME && p.startsWith(HOME)) return "~" + p.slice(HOME.length)
  return p
}

/** Human-readable label for how a model is routed to a provider. */
export function describeModelRoute(modelId: string): string {
  const config = getProvidersConfig()
  const route = findMatchingRoute(modelId, config)
  if (route) {
    if (route.kind === "openai-compatible" && route.baseUrl) {
      return `${modelId} ${c.dim(`via ${route.kind} (${route.baseUrl})`)}`
    }
    return `${modelId} ${c.dim(`via ${route.kind}`)}`
  }
  return `${modelId} ${c.dim("via openrouter (default fallback)")}`
}

/** Human-readable label for an adapter and its binary source. */
export function describeAdapter(name: string): string {
  if (name === "bare-agent") return `${name} ${c.dim("(built-in)")}`
  const repoDir = getAdapterRepoDir(name as "opencode" | "openclaw" | "hermes" | "jiuwenclaw" | "pi")
  if (repoDir) return `${name} ${c.dim(`(${shortenPath(repoDir)})`)}`
  return `${name} ${c.dim("(not configured)")}`
}

/**
 * Print a startup banner for a command.
 *
 * ```
 * skvm profile v0.1.1
 *   Adapter   bare-agent (built-in)
 *   Model     qwen/qwen3-30b via openrouter
 *   Cache     ~/.skvm
 *   Output    ~/.skvm/profiles
 * ```
 */
export function printBanner(command: string, lines: [string, string][]): void {
  console.log(`\nskvm ${command} v${pkgJson.version}`)
  const maxLabel = Math.max(...lines.map(([l]) => l.length))
  for (const [label, value] of lines) {
    console.log(`  ${label.padEnd(maxLabel)}  ${value}`)
  }
  console.log()
}
