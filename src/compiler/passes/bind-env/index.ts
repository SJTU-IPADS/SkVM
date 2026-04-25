import { runPass2 } from "./runner.ts"
import type { CompilerPass, PassContext, PassOutput } from "../types.ts"

/**
 * Pass 2 — environment binding. Extracts dependencies from SKILL.md + bundle
 * files, generates an idempotent env-setup.sh, and simulates the script with
 * auto-repair. No SKILL.md mutation.
 */
export const bindEnvPass: CompilerPass = {
  id: "bind-env",
  number: 2,
  description: "Detect skill dependencies and generate an idempotent env-setup script",
  consumes: [],
  produces: ["deps", "envScript", "envSimulation"],

  async run(ctx: PassContext): Promise<PassOutput> {
    const result = await runPass2(ctx.skillContent, ctx.workDir, ctx.provider)
    return {
      artifacts: {
        deps: result.dependencies,
        envScript: result.bindingScript,
        envSimulation: result.simulation,
      },
    }
  },
}
