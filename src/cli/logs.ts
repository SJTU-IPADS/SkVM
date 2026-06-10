/**
 * `skvm logs` — list recent runs across all subsystems.
 *
 * First subcommand migrated to the declarative flag layer (#49): flags are
 * declared once via `defineFlags`, help is generated from the declarations,
 * and `runLogs` takes the typed config so it is unit-testable without
 * spawning the CLI.
 */

import { defineFlags, type ConfigOf } from "./flags.ts"
import { CLI_DEFAULTS } from "../core/ui-defaults.ts"
import { c, noColor } from "../core/logger.ts"

export const LOGS_FLAGS = defineFlags("logs", "List recent runs across all subsystems", {
  type: {
    kind: "string",
    placeholder: "<type>",
    help: "Filter by type (profile, aot-compile, bench, run, pipeline)",
  },
  limit: {
    kind: "int",
    min: 1,
    default: CLI_DEFAULTS.listLimit,
    help: "Show last N entries",
  },
  all: {
    kind: "bool",
    help: "Show all entries (no limit)",
  },
})

export type LogsConfig = ConfigOf<typeof LOGS_FLAGS>

export async function runLogs(config: LogsConfig): Promise<void> {
  const { readSessions } = await import("../core/run-session.ts")

  const limit = config.all ? undefined : config.limit
  const entries = await readSessions({ type: config.type, limit })

  if (entries.length === 0) {
    console.log("No sessions found.")
    return
  }

  console.log(`\nRecent runs${config.type ? ` (type: ${config.type})` : ""}:\n`)

  const statusColor: Record<string, (s: string) => string> = {
    COMPLETED: c.green, FAILED: c.red, RUNNING: c.yellow,
  }
  for (const e of entries) {
    const label = e.status.toUpperCase().padEnd(10)
    const colorFn = statusColor[label.trim()] ?? noColor
    console.log(`  ${colorFn(label)} ${e.id}`)

    const details: string[] = []
    details.push(`Type: ${e.type}`)
    if (e.models && e.models.length > 1) {
      details.push(`Models: ${e.models.length}`)
    } else if (e.models && e.models.length === 1) {
      details.push(`Model: ${e.models[0]}`)
    }
    if (e.harness) details.push(`Harness: ${e.harness}`)
    if (e.skill) details.push(`Skill: ${e.skill}`)
    if (e.conditions) details.push(`Conditions: ${e.conditions.join(", ")}`)
    if (e.summary) details.push(e.summary)
    if (e.error) details.push(`Error: ${e.error}`)
    console.log(`             ${details.join(" | ")}`)

    console.log(`             Log: ${e.logDir}`)
    console.log()
  }
}
