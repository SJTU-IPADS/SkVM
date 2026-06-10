import { createLogger } from "../../core/logger.ts"
import type { ConditionRunner } from "./types.ts"
import { runCondition } from "./run-condition.ts"

const log = createLogger("bench-conditions")

/**
 * Baseline condition: run the task bare, with no skill loaded. (The
 * custom-plan flow runs its bare items through `runCondition` directly,
 * under the plan item's own label.)
 */
export const noSkillRunner: ConditionRunner = {
  async run(ctx) {
    log.info(`[no-skill] ${ctx.task.id}`)
    return runCondition({
      condition: "no-skill",
      task: ctx.task,
      adapter: ctx.adapter,
      adapterConfig: ctx.adapterConfig,
      evaluatorConfig: ctx.evaluatorConfig,
      convLog: await ctx.createConvLog("no-skill"),
      evalOptions: ctx.evalOptions,
    })
  },
}
