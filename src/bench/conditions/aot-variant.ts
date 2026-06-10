import path from "node:path"
import { compileSkill, writeVariant } from "../../compiler/index.ts"
import { ARTIFACT_DIR } from "../../compiler/artifacts.ts"
import { toPassTag } from "../../core/config.ts"
import { getVariantDir } from "../../proposals/storage.ts"
import { contentHash, parseSkillMeta, buildSkillBundleFromContent } from "../../core/skill-loader.ts"
import { createLogger } from "../../core/logger.ts"
import { parseAotPasses } from "../types.ts"
import type { ConditionRunner } from "./types.ts"
import { runCondition, zeroConditionResult } from "./run-condition.ts"
import { concatSkillContents, combinedSkillId, copyDirFiltered } from "./staging.ts"

const log = createLogger("bench-conditions")

/**
 * Run an AOT variant with the passes encoded in the condition name
 * ("aot-compiled" = all passes, "aot-compiled-p12" = passes 1+2, …).
 * Checks the cache at <skill>/<passTag>/SKILL.md, compiles if missing.
 */
export const aotVariantRunner: ConditionRunner = {
  async run(ctx) {
    const { task, condition, skills, adapter, adapterConfig } = ctx
    const passes = parseAotPasses(condition)
    if (!passes) {
      throw new Error(`[aot-variant] not an AOT condition: ${condition}`)
    }
    if (!ctx.tcp || !ctx.compilerProvider) {
      throw new Error(`[aot-variant] ${condition} requires a TCP profile and a compiler provider`)
    }

    const skillContent = concatSkillContents(skills)
    const skillId = combinedSkillId(skills)
    const skillPath = skills[0]!.skillPath

    const passTag = toPassTag(passes)
    log.info(`[${condition}] ${task.id} with skill ${skillId} (passes=${passes}, tag=${passTag})`)
    const convLog = await ctx.createConvLog(condition)

    const harness = adapter.name
    const compiledPath = path.join(getVariantDir(harness, adapterConfig.model, skillId, passTag), "SKILL.md")

    let compiledContent: string
    let loadedSkillPath = compiledPath

    try {
      const existing = Bun.file(compiledPath)
      if (await existing.exists()) {
        compiledContent = await existing.text()
        loadedSkillPath = compiledPath
        log.info(`[${condition}] Using cached ${passTag} variant for ${skillId}`)
      } else if (passTag === "p1p2p3") {
        // Check legacy flat path (backward compatibility)
        const legacyPath = path.join(getVariantDir(harness, adapterConfig.model, skillId), "SKILL.md")
        const legacyFile = Bun.file(legacyPath)
        if (await legacyFile.exists()) {
          compiledContent = await legacyFile.text()
          loadedSkillPath = legacyPath
          log.info(`[${condition}] Using legacy cached variant for ${skillId}`)
        } else {
          throw new Error("not cached")
        }
      } else {
        throw new Error("not cached")
      }
    } catch {
      // Compile with the requested passes
      log.info(`[${condition}] Compiling ${skillId} for ${adapterConfig.model} (passes=${passes})`)
      try {
        const result = await compileSkill({
          skillPath,
          skillDir: path.dirname(skillPath),
          skillName: skillId,
          skillContent,
          tcp: ctx.tcp,
          model: adapterConfig.model,
          harness,
          passes: passes.map(String),
        }, ctx.compilerProvider, { showSpinner: false })
        compiledContent = result.compiledSkill
        await writeVariant(result)
      } catch (err) {
        log.error(`[${condition}] Compilation failed for ${skillId}: ${err}`)
        return zeroConditionResult(condition, { skillId, skillPath }, {
          error: `Compilation failed: ${err}`,
          runStatus: "adapter-crashed",
          statusDetail: `compiler failed: ${String(err).slice(0, 200)}`,
        })
      }
    }

    const aotSkillMeta = parseSkillMeta(compiledContent, path.dirname(skillPath))

    return runCondition({
      condition,
      task,
      adapter,
      adapterConfig,
      evaluatorConfig: ctx.evaluatorConfig,
      convLog,
      evalOptions: ctx.evalOptions,
      skill: buildSkillBundleFromContent(compiledContent, aotSkillMeta, ctx.skillMode),
      // Copy compiled bundled files to workDir (if the compiled variant has them)
      stage: (workDir) => {
        const SKIP_FILES = new Set(["SKILL.md", "compilation-plan.json", "meta.json", "env-setup.sh", "jit-candidates.json"])
        return copyDirFiltered(path.dirname(compiledPath), workDir, (relPath) =>
          SKIP_FILES.has(relPath)
          // Skip compiler-internal directories (e.g. _artifacts/scr.json,
          // _artifacts/_meta/*.json) — they are not part of the skill bundle.
          || relPath.split(path.sep).some((seg) => seg === ARTIFACT_DIR))
      },
      resultMeta: {
        skillId,
        skillPath: loadedSkillPath,
        skillContentHash: contentHash(compiledContent),
      },
    })
  },
}
