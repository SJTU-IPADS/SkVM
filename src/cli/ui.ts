/**
 * `skvm ui` — serve the SkVM web UI.
 *
 * One local server over the on-disk state the CLI reads and writes
 * (proposals now; runs, profiles, and bench results follow — #115).
 * `skvm proposals serve` is a deprecated alias that lands here.
 */

import { defineFlags, type ConfigOf } from "./flags.ts"
import { CLI_DEFAULTS } from "../core/ui-defaults.ts"

export const UI_FLAGS = defineFlags("ui", "Serve the SkVM web UI", {
  port: { kind: "int", min: 1, max: 65535, default: CLI_DEFAULTS.reportPort, help: "Port" },
  host: { kind: "string", placeholder: "<h>", default: CLI_DEFAULTS.reportHost, help: "Host" },
  "no-open": { kind: "bool", help: "Do not open a browser" },
}, { usage: ["skvm ui [--port=<n>] [--host=<h>] [--no-open]"] })

export type UiConfig = ConfigOf<typeof UI_FLAGS>

export async function runUi(config: UiConfig): Promise<void> {
  const { startServer } = await import("../server/index.ts")
  const server = startServer({ port: config.port, host: config.host })
  console.log(`SkVM UI listening on ${server.url}`)
  console.log(`  Open: ${server.tokenUrl}`)
  console.log(`  Press Ctrl+C to stop.`)
  if (!config["no-open"]) {
    const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
    try {
      Bun.spawn([openCmd, server.tokenUrl], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
    } catch {
      // ignore — user can still navigate manually
    }
  }
  // Keep the process alive until SIGINT/SIGTERM.
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      console.log("\nShutting down…")
      server.stop()
      resolve()
    }
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
  })
}
