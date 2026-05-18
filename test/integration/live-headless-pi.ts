/**
 * Live smoke test for the pi headless driver. Runs against real LLMs;
 * NOT part of `bun test` (root is `test/`, integration scripts live in
 * `test/integration/` and are invoked manually).
 *
 * Usage:
 *   bun run test/integration/live-headless-pi.ts
 *
 * Requires:
 *   - skvm.config.json with a working route for the model below
 *   - ANTHROPIC_API_KEY (or apiKeyEnv pointing to one) in env
 */

import { runHeadlessAgent } from "../../src/core/headless-agent/index.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const workDir = mkdtempSync(path.join(tmpdir(), "skvm-pi-live-"))
try {
  console.log(`workDir: ${workDir}`)
  const result = await runHeadlessAgent({
    cwd: workDir,
    prompt: "Create a file called hello.txt with the contents 'hi from pi'.",
    model: "anthropic/claude-haiku-4-5-20251001",
    timeoutMs: 90_000,
  })

  console.log(`driver=${result.driver} exit=${result.exitCode} ` +
              `dur=${result.durationMs}ms cost=$${result.cost.toFixed(4)} ` +
              `tokens=in:${result.tokens.input} out:${result.tokens.output}`)

  const helloPath = path.join(workDir, "hello.txt")
  const file = Bun.file(helloPath)
  if (!(await file.exists())) {
    console.error(`FAIL: ${helloPath} not created`)
    process.exit(1)
  }
  const contents = await file.text()
  if (!contents.toLowerCase().includes("hi from pi")) {
    console.error(`FAIL: ${helloPath} has unexpected contents: ${contents}`)
    process.exit(1)
  }
  console.log("OK")
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
