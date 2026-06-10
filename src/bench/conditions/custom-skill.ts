import path from "node:path"
import type { AgentAdapter, AdapterConfig, SkillMode } from "../../core/types.ts"
import type { EvaluatorConfig, EvaluateAllOptions } from "../../framework/evaluator.ts"
import type { ConversationLog } from "../../core/conversation-logger.ts"
import { contentHash, parseSkillMeta, buildSkillBundleFromContent } from "../../core/skill-loader.ts"
import { createLogger } from "../../core/logger.ts"
import type { BenchTask, ConditionResult } from "../types.ts"
import { runCondition } from "./run-condition.ts"
import { copyDirFiltered } from "./staging.ts"

const log = createLogger("bench-conditions")

/**
 * Run the task with an arbitrary skill directory under a caller-chosen
 * condition label. Not part of the `--conditions=` registry — this is the
 * custom-plan (`bench --custom=`) entry point, where each YAML item binds
 * its own label and skill dir.
 */
export async function runCustomSkill(
  task: BenchTask,
  adapter: AgentAdapter,
  adapterConfig: AdapterConfig,
  conditionLabel: string,
  skillDir: string,
  skillMode?: SkillMode,
  evaluatorConfig?: EvaluatorConfig,
  convLog?: ConversationLog,
  evalOptions?: EvaluateAllOptions,
): Promise<ConditionResult> {
  log.info(`[${conditionLabel}] ${task.id} with skill dir ${skillDir}`)

  const skillContent = await Bun.file(path.join(skillDir, "SKILL.md")).text()
  const skillId = path.basename(skillDir)
  const customSkillMeta = parseSkillMeta(skillContent, skillDir)

  return runCondition({
    condition: conditionLabel,
    task, adapter, adapterConfig,
    evaluatorConfig, convLog, evalOptions,
    skill: buildSkillBundleFromContent(skillContent, customSkillMeta, skillMode),
    // Copy bundle files from the custom skill directory
    stage: (workDir) => copyDirFiltered(skillDir, workDir, (rel) =>
      rel === "SKILL.md" || rel.startsWith(".")),
    resultMeta: {
      skillId,
      skillPath: path.join(skillDir, "SKILL.md"),
      skillContentHash: contentHash(skillContent),
    },
  })
}
