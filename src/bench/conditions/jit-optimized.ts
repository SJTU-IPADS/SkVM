import path from "node:path"
import { buildSkillBundleFromContent } from "../../core/skill-loader.ts"
import { createLogger } from "../../core/logger.ts"
import type { ConditionRunner } from "./types.ts"
import { runCondition, zeroConditionResult } from "./run-condition.ts"
import { copyBundleFromDir, skillResultMeta, bundleSkillMeta, concatContents } from "./staging.ts"

const log = createLogger("bench-conditions")

/** Run the task with the latest best-round jit-optimized skill variant(s). */
export const jitOptimizedRunner: ConditionRunner = {
  async run(ctx) {
    const { task, skills } = ctx
    // The jit-optimize proposal lookup key is (harness, target model).
    const harness = ctx.adapter.name
    const model = ctx.adapterConfig.model
    const meta = skillResultMeta(skills)
    log.info(`[jit-optimized] ${task.id} with skill(s) ${meta.skillId}`)
    const convLog = await ctx.createConvLog("jit-optimized")

    // Load latest best-round skill folder from the proposals tree, keyed by
    // (harness, target model, skillName). `lookupLatestProposal` skips
    // `infra-blocked` proposals and distinguishes "nothing at all" (operator
    // bug → throw) from "only infra-blocked" (graceful skip: return a tainted
    // ConditionResult so the skill shows in report.md's Tainted runs table).
    const { lookupLatestProposal } = await import("../../proposals/storage.ts")
    const jitOptimizedContents: string[] = []
    const jitOptimizedBundleDirs: string[] = []
    for (const s of skills) {
      const { state, bestDir } = await lookupLatestProposal(harness, model, s.skillId)
      if (state === "only-blocked") {
        const detail = `skill ${s.skillId}: latest jit-optimize proposal is infra-blocked and no non-blocked fallback exists`
        log.warn(`[jit-optimized] Skipping ${task.id}: ${detail}`)
        return zeroConditionResult("jit-optimized", meta, {
          runStatus: "tainted",
          statusDetail: `skipped: only infra-blocked proposals available (${detail})`,
        })
      }
      if (state === "none" || !bestDir) {
        throw new Error(`No jit-optimized proposals found for skill ${s.skillId} on ${harness}/${model}`)
      }
      const bestSkillMd = path.join(bestDir, "SKILL.md")
      jitOptimizedContents.push(await Bun.file(bestSkillMd).text())
      jitOptimizedBundleDirs.push(bestDir)
      log.info(`[jit-optimized] Loaded ${s.skillId} from ${bestDir}`)
    }
    const jitSkillContent = concatContents(jitOptimizedContents)
    const jitSkillMeta = bundleSkillMeta(skills, meta.skillId)

    return runCondition({
      condition: "jit-optimized",
      task,
      adapter: ctx.adapter,
      adapterConfig: ctx.adapterConfig,
      evaluatorConfig: ctx.evaluatorConfig,
      convLog,
      evalOptions: ctx.evalOptions,
      skill: buildSkillBundleFromContent(jitSkillContent, jitSkillMeta, ctx.skillMode),
      // Copy bundle files from the jit-optimized best-round directories
      // (instead of the original skill dir)
      stage: async (workDir) => {
        for (const bundleDir of jitOptimizedBundleDirs) {
          await copyBundleFromDir(bundleDir, workDir)
        }
      },
      resultMeta: meta,
    })
  },
}
