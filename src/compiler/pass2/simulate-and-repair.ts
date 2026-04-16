import path from "node:path"
import { readdir, unlink } from "node:fs/promises"
import { createLogger } from "../../core/logger.ts"
import type { LLMProvider } from "../../providers/types.ts"
import type { DependencyEntry } from "../../core/types.ts"
import type { PlatformContext } from "./platform.ts"

const log = createLogger("pass2:simulate")

const DISALLOWED_REPO_UPDATE_RE = /\b(?:apt-get|apt|yum|dnf|brew|choco|winget)\s+(?:update|upgrade)\b/i

async function snapshotFiles(dir: string): Promise<Set<string>> {
  const entries = await readdir(dir, { recursive: true })
  return new Set(entries)
}

async function cleanNewFiles(dir: string, snapshot: Set<string>): Promise<void> {
  const current = await readdir(dir, { recursive: true })
  for (const entry of current) {
    if (!snapshot.has(entry)) {
      try {
        await unlink(path.join(dir, entry))
      } catch { /* may be a directory or already removed */ }
    }
  }
}

export interface ScriptSimulationResult {
  attemptCount: number
  success: boolean
  finalScript: string
  finalScriptValidated: boolean
  failureReason?: string
}

async function runScriptOnce(script: string, workDir: string, attempt: number): Promise<{ success: boolean; output: string }> {
  const scriptPath = path.join(workDir, `.skvm-env-setup-attempt-${attempt}.sh`)
  await Bun.write(scriptPath, script)

  try {
    const proc = Bun.spawn(["bash", scriptPath], {
      cwd: workDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const output = [stdout, stderr].filter(Boolean).join("\n").trim()
    return { success: exitCode === 0, output }
  } catch (error) {
    return { success: false, output: `Script execution error: ${String(error)}` }
  }
}

async function repairScriptWithLLM(opts: {
  provider: LLMProvider
  currentScript: string
  dependencies: DependencyEntry[]
  platform: PlatformContext
  failureOutput: string
  attempt: number
}): Promise<string> {
  const response = await opts.provider.complete({
    system: `You are an expert shell troubleshooting agent for SkVM.

Your job is to repair an env-setup bash script after a failed dependency installation attempt.

Requirements:
- Keep script idempotent.
- Keep all text in English.
- Preserve strict mode (set -euo pipefail).
- Keep check-before-install behavior for each dependency.
- Add defensive fallback checks when commands can fail due to missing package managers.
- Do NOT add repository refresh or upgrade commands (no apt-get update/upgrade, apt update/upgrade, yum update, dnf update/upgrade, brew update/upgrade, choco/winget upgrade).
- Output ONLY the repaired bash script.`,
    messages: [{
      role: "user",
      content: `Repair this env-setup script using the failure logs.

Attempt number: ${opts.attempt}

Platform context:
${JSON.stringify(opts.platform, null, 2)}

Dependencies:
${JSON.stringify(opts.dependencies, null, 2)}

Failure output:
${opts.failureOutput}

Current script:
${opts.currentScript}`,
    }],
    temperature: 0,
    maxTokens: 4096,
  })

  let script = response.text.trim()
  script = script.replace(/^```(?:bash)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim()
  if (!script.startsWith("#!/bin/bash")) {
    script = `#!/bin/bash\n${script}`
  }
  return script
}

function hasDisallowedRepoUpdate(script: string): boolean {
  return DISALLOWED_REPO_UPDATE_RE.test(script)
}

export async function simulateAndRepairScript(opts: {
  script: string
  dependencies: DependencyEntry[]
  platform: PlatformContext
  provider: LLMProvider
  workDir: string
  maxAttempts?: number
}): Promise<ScriptSimulationResult> {
  const maxAttempts = opts.maxAttempts ?? 3
  let currentScript = opts.script
  let lastFailure = "Unknown script failure"
  const fileSnapshot = await snapshotFiles(opts.workDir)

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (hasDisallowedRepoUpdate(currentScript)) {
      lastFailure = "Policy violation: env-setup script contains disallowed repository update/upgrade commands."
      log.warn(`Pass2 simulation failed on attempt ${attempt}: ${lastFailure}`)

      if (attempt < maxAttempts) {
        currentScript = await repairScriptWithLLM({
          provider: opts.provider,
          currentScript,
          dependencies: opts.dependencies,
          platform: opts.platform,
          failureOutput: lastFailure,
          attempt,
        })
        continue
      }

      break
    }

    const run = await runScriptOnce(currentScript, opts.workDir, attempt)
    if (run.success) {
      log.info(`Pass2 simulation succeeded on attempt ${attempt}`)
      return {
        attemptCount: attempt,
        success: true,
        finalScript: currentScript,
        finalScriptValidated: true,
      }
    }

    lastFailure = run.output || "Script exited non-zero without output"
    log.warn(`Pass2 simulation failed on attempt ${attempt}: ${lastFailure.slice(0, 240)}`)

    // Remove any files created by the failed script to avoid polluting workDir
    await cleanNewFiles(opts.workDir, fileSnapshot)

    if (attempt < maxAttempts) {
      currentScript = await repairScriptWithLLM({
        provider: opts.provider,
        currentScript,
        dependencies: opts.dependencies,
        platform: opts.platform,
        failureOutput: lastFailure,
        attempt,
      })
    }
  }

  return {
    attemptCount: maxAttempts,
    success: false,
    finalScript: currentScript,
    finalScriptValidated: false,
    failureReason: lastFailure,
  }
}
