#!/usr/bin/env bun
/**
 * Spinner smoke test — run manually to visually verify spinner behavior.
 *
 *   bun run test/core/spinner-smoke.ts
 *
 * Expected output:
 *   ✓ Phase 1: setup complete  (1s)
 *   12:00:00.000 [INFO ] [test] log line during spinner
 *   ✓ Phase 2: work done  (1s)
 *   ✓ Progress [3/3]  (0s)
 *   ✗ Phase 3: intentional failure  (1s)
 */

import { createSpinner, createProgressSpinner, spinnerLog } from "../../src/core/spinner.ts"
import { createLogger } from "../../src/core/logger.ts"

const log = createLogger("test")

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  console.log("=== Spinner smoke test ===\n")

  // 1. Basic spinner with succeed
  const s1 = createSpinner("Phase 1: setting up...")
  await sleep(1000)
  s1.succeed("Phase 1: setup complete")

  // 2. Spinner with log interleaving
  const s2 = createSpinner("Phase 2: working...")
  await sleep(500)
  log.info("log line during spinner")
  await sleep(500)
  s2.succeed("Phase 2: work done")

  // 3. Progress spinner
  const progress = createProgressSpinner("Progress", 3)
  await sleep(300)
  progress.tick()
  await sleep(300)
  progress.tick()
  await sleep(300)
  progress.tick("Progress [3/3]")

  // 4. Spinner with fail
  const s3 = createSpinner("Phase 3: will fail...")
  await sleep(1000)
  s3.fail("Phase 3: intentional failure")

  // 5. spinnerLog during active spinner
  const s4 = createSpinner("Phase 4: spinnerLog test...")
  await sleep(300)
  spinnerLog("  interleaved line via spinnerLog()")
  await sleep(300)
  s4.succeed("Phase 4: done")

  // 6. Error path — spinner cleaned up
  const s5 = createSpinner("Phase 5: error handling...")
  await sleep(500)
  try {
    throw new Error("simulated failure")
  } catch {
    s5.fail("Phase 5: caught error, spinner cleaned up")
  }

  console.log("\n=== All phases complete ===")
}

main()
