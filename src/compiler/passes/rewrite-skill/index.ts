import { runPass1Agentic } from "./agent.ts"
import type { CompilerPass, PassContext, PassOutput } from "../types.ts"

/**
 * Pass 1 — rewrite SKILL.md to compensate for the target model's capability
 * gaps. Extracts the SCR, computes gaps against the TCP, then runs an agent
 * loop that locally edits SKILL.md to lower capability demand.
 */
export const rewriteSkillPass: CompilerPass = {
  id: "rewrite-skill",
  number: 1,
  description: "Rewrite SKILL.md to compensate for the target model's capability gaps",
  consumes: [],
  produces: ["scr", "gaps"],

  async run(ctx: PassContext): Promise<PassOutput> {
    const result = await runPass1Agentic(
      ctx.skillContent,
      ctx.tcp,
      ctx.provider,
      ctx.workDir,
      ctx.failureContext,
    )
    return {
      artifacts: { scr: result.scr, gaps: result.gaps },
      skillPatch: { kind: "rewrite", content: result.compiledSkill },
    }
  },
}
