import type { LLMProvider } from "../../../providers/types.ts"
import type { Pass2Result } from "../../types.ts"
import { extractDependencies } from "./extract-deps.ts"
import { generateBindingScript } from "./generate-script.ts"
import { detectPlatformContext } from "./platform.ts"
import { createInstallPolicy, normalizeDependenciesForPlatform } from "./install-policy.ts"
import { simulateAndRepairScript } from "./simulate-and-repair.ts"
import { createLogger } from "../../../core/logger.ts"

const log = createLogger("pass2")

/**
 * Pass 2: Environment Binding.
 *
 * Pipeline: extract deps → detect platform → normalize → generate script
 * from template → simulate-and-repair (up to 3 LLM-driven attempts).
 */
export async function runPass2(
  skillContent: string,
  workDir: string,
  provider: LLMProvider,
): Promise<Pass2Result> {
  const { dependencies } = await extractDependencies(skillContent, workDir, provider)
  log.info(`Extracted ${dependencies.length} dependencies`)

  const platform = await detectPlatformContext()
  const policy = createInstallPolicy(platform)
  const normalizedDeps = normalizeDependenciesForPlatform(dependencies, platform)

  const { script: generatedScript } = await generateBindingScript(normalizedDeps, provider, platform, policy)

  const simulation = await simulateAndRepairScript({
    script: generatedScript,
    dependencies: normalizedDeps,
    platform,
    provider,
    workDir,
    maxAttempts: 3,
  })

  if (!simulation.success) {
    throw new Error(`Pass2 env simulation failed after ${simulation.attemptCount} attempts: ${simulation.failureReason ?? "unknown error"}`)
  }

  return {
    dependencies: normalizedDeps,
    bindingScript: simulation.finalScript,
    simulation: {
      attemptCount: simulation.attemptCount,
      success: simulation.success,
      failureReason: simulation.failureReason,
      finalScriptValidated: simulation.finalScriptValidated,
    },
  }
}
