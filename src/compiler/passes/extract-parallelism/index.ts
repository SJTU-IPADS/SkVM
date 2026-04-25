import { runPass3, generateParallelismSection } from "./parallelism.ts"
import type { CompilerPass, PassContext, PassOutput } from "../types.ts"

/**
 * Pass 3 — parallelism extraction. Classifies any opportunities into DLP /
 * ILP / TLP groups, producing a small workflow DAG. Appends an informational
 * hints section to SKILL.md when groups are found.
 */
export const extractParallelismPass: CompilerPass = {
  id: "extract-parallelism",
  number: 3,
  description: "Detect and classify DLP/ILP/TLP parallelism opportunities in the skill",
  consumes: [],
  produces: ["dag"],

  async run(ctx: PassContext): Promise<PassOutput> {
    const result = await runPass3(ctx.skillContent, ctx.provider)
    const section = generateParallelismSection(result.dag)
    return {
      artifacts: { dag: result.dag },
      skillPatch: section ? { kind: "append", content: section } : undefined,
    }
  },
}
