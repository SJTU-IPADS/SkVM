import { buildSkillBundleFromContent } from "../../core/skill-loader.ts"
import { createLogger } from "../../core/logger.ts"
import type { ConditionRunner } from "./types.ts"
import { runCondition } from "./run-condition.ts"
import { copySkillBundles, concatSkillContents, skillResultMeta, bundleSkillMeta } from "./staging.ts"

const log = createLogger("bench-conditions")

/** Run the task with the original, unmodified skill(s) staged. */
export const originalRunner: ConditionRunner = {
  async run(ctx) {
    const { task, skills } = ctx
    const meta = skillResultMeta(skills)
    log.info(`[original] ${task.id} with skill(s) ${meta.skillId}`)

    const originalSkillContent = concatSkillContents(skills)
    const originalSkillMeta = bundleSkillMeta(skills, meta.skillId)

    return runCondition({
      condition: "original",
      task,
      adapter: ctx.adapter,
      adapterConfig: ctx.adapterConfig,
      evaluatorConfig: ctx.evaluatorConfig,
      convLog: await ctx.createConvLog("original"),
      evalOptions: ctx.evalOptions,
      skill: buildSkillBundleFromContent(originalSkillContent, originalSkillMeta, ctx.skillMode),
      stage: (workDir) => copySkillBundles(skills, workDir),
      resultMeta: meta,
    })
  },
}
