/**
 * Headless agent runner — minimal one-shot agent invocation for internal
 * tooling (JIT-optimize optimizer, JIT-boost candidate generation).
 *
 * One driver per file under this folder. Callers (jit-optimize,
 * jit-boost) should import only from this index.
 */

import { assertNoLegacyHeadlessFields, getHeadlessAgentConfig } from "../config.ts"
import { runOpenCodeDriver } from "./opencode-driver.ts"
import { runPiDriver } from "./pi-driver.ts"
import {
  HeadlessAgentError,
  isHeadlessAgentError,
  type HeadlessAgentDriver,
  type HeadlessAgentRunOptions,
  type HeadlessAgentRunResult,
} from "./shared.ts"

export {
  HeadlessAgentError,
  isHeadlessAgentError,
  type HeadlessAgentDriver,
  type HeadlessAgentRunOptions,
  type HeadlessAgentRunResult,
}

/**
 * Run a headless agent with the given prompt inside a working directory and
 * wait for it to complete. Returns exit status, tokens, cost, and raw output.
 */
export async function runHeadlessAgent(
  opts: HeadlessAgentRunOptions,
): Promise<HeadlessAgentRunResult> {
  assertNoLegacyHeadlessFields()
  const driver = opts.driver ?? getHeadlessAgentConfig().driver
  if (driver === "opencode") return runOpenCodeDriver(opts)
  if (driver === "pi") return runPiDriver(opts)
  throw new Error(`Unknown headless agent driver: ${driver}`)
}
