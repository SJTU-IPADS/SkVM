import path from "node:path"
import { compileSkill, writeVariant } from "../../compiler/index.ts"
import { ARTIFACT_DIR } from "../../compiler/artifacts.ts"
import { toPassTag } from "../../core/config.ts"
import { getVariantDir } from "../../proposals/storage.ts"
import { contentHash, parseSkillMeta, buildSkillBundleFromContent } from "../../core/skill-loader.ts"
import { createLogger } from "../../core/logger.ts"
import { parseAotPasses, AOT_FALLBACK_DEFAULT, type AotFallbackMode } from "../types.ts"
import type { ConditionRunner } from "./types.ts"
import { runCondition, zeroConditionResult } from "./run-condition.ts"
import {
  concatSkillContents, combinedSkillId, copyDirFiltered, copySkillBundles, bundleSkillMeta,
} from "./staging.ts"

const log = createLogger("bench-conditions")

/**
 * Whether a compiled AOT variant should be discarded in favour of the original
 * skill: only when it failed the compiler guard AND the operator did not opt
 * into `use-anyway`. Keeping this a pure predicate makes the gate unit-testable
 * without spinning up a compile.
 */
export function shouldFallbackToOriginal(guardPassed: boolean, mode: AotFallbackMode): boolean {
  return !guardPassed && mode === "original"
}

/**
 * Read a compiled variant's guard verdict from its `meta.json`
 * (`guardPassed`). Conservative on the absence of a clear FAIL: a missing,
 * malformed, or pre-guard (`guardPassed` absent) meta returns `true` so we
 * never fall back on an artifact we can't prove failed the guard.
 */
export async function readVariantGuardPassed(variantDir: string): Promise<boolean> {
  const metaFile = Bun.file(path.join(variantDir, "meta.json"))
  if (!(await metaFile.exists())) return true
  try {
    const meta = JSON.parse(await metaFile.text()) as { guardPassed?: boolean }
    return meta.guardPassed !== false
  } catch {
    return true
  }
}

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
    // Guard verdict for the variant we end up running (cached meta.json or the
    // fresh compile). Determines whether the fallback gate fires below.
    let guardPassed = true

    try {
      const existing = Bun.file(compiledPath)
      if (await existing.exists()) {
        compiledContent = await existing.text()
        loadedSkillPath = compiledPath
        guardPassed = await readVariantGuardPassed(path.dirname(compiledPath))
        log.info(`[${condition}] Using cached ${passTag} variant for ${skillId}`)
      } else if (passTag === "p1p2p3") {
        // Check legacy flat path (backward compatibility)
        const legacyPath = path.join(getVariantDir(harness, adapterConfig.model, skillId), "SKILL.md")
        const legacyFile = Bun.file(legacyPath)
        if (await legacyFile.exists()) {
          compiledContent = await legacyFile.text()
          loadedSkillPath = legacyPath
          guardPassed = await readVariantGuardPassed(path.dirname(legacyPath))
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
        guardPassed = result.guardPassed
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

    // Guard gate: a guard-failing compiled variant is not shipped (its bench
    // score would misrepresent the deployed system). Fall back to the original
    // skill, keeping the AOT condition label so the row still aggregates into
    // the aot-compiled column, and mark `aotFallback`. `--aot-fallback=use-anyway`
    // opts out for A/B diagnosis of how much guard-failing artifacts hurt.
    const fallbackMode = ctx.aotFallback ?? AOT_FALLBACK_DEFAULT
    if (shouldFallbackToOriginal(guardPassed, fallbackMode)) {
      log.warn(`[${condition}] compiled ${skillId} failed the guard; running the original skill instead (--aot-fallback=original)`)
      return runCondition({
        condition,
        task,
        adapter,
        adapterConfig,
        evaluatorConfig: ctx.evaluatorConfig,
        convLog,
        evalOptions: ctx.evalOptions,
        skill: buildSkillBundleFromContent(skillContent, bundleSkillMeta(skills, skillId), ctx.skillMode),
        stage: (workDir) => copySkillBundles(skills, workDir),
        resultMeta: {
          skillId,
          skillPath,
          skillContentHash: contentHash(skillContent),
          aotFallback: true,
        },
      })
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
