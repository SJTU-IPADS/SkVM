import path from "node:path"
import { compileSkill, writeVariant } from "../../compiler/index.ts"
import { resolvePassTokens } from "../../compiler/registry.ts"
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
 * Whether an AOT condition's selected passes include one that consumes the
 * TCP profile (pass 1). Conditions made only of profile-free passes (e.g.
 * aot-compiled-p3) can compile — and always run from cache — without one.
 */
export function aotConditionNeedsTcp(condition: string): boolean {
  const passes = parseAotPasses(condition)
  if (!passes) return false
  return resolvePassTokens(passes.map(String)).some((p) => p.requiresTcp)
}

/**
 * Is a usable compiled variant already on disk for this (harness, model, skill,
 * condition)?
 *
 * The scheduler skips a TCP-consuming AOT condition when no profile is
 * available — correct when it would have to compile, wrong when the variant is
 * already cached and nothing will be compiled at all. That gap blocked the whole
 * "pre-compile the proposals, then bench them" workflow for the default
 * `aot-compiled` condition, which is precisely the one that needs pass 1.
 *
 * "Usable" means the same thing the runner means by it: SKILL.md plus a readable
 * meta.json. A half-written variant directory is a cache miss, so the condition
 * still needs its profile.
 */
export async function hasUsableCachedVariant(
  harness: string,
  model: string,
  skillId: string,
  condition: string,
): Promise<boolean> {
  const passes = parseAotPasses(condition)
  if (!passes) return false
  const candidates = [getVariantDir(harness, model, skillId, toPassTag(passes))]
  if (toPassTag(passes) === "p1p2p3") candidates.push(getVariantDir(harness, model, skillId))
  for (const dir of candidates) {
    if (!(await Bun.file(path.join(dir, "SKILL.md")).exists())) continue
    if ((await readVariantGuardPassed(dir)) !== "unusable") return true
  }
  return false
}

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
 * A cached variant's guard verdict, read from its `meta.json`.
 *
 * - `"pass"` / `"fail"` — the recorded verdict.
 * - `"unusable"` — SKILL.md is on disk but its meta is missing or unreadable.
 *   `writeVariant` always writes SKILL.md and meta.json together, and
 *   `compileSkill`'s workDir IS the published variant directory, so a variant
 *   with no meta is a compile that crashed, timed out, or was interrupted
 *   partway. Treating that as a pass (the previous behaviour) benched an
 *   uncompiled or half-patched skill under the `aot-compiled` label — silently,
 *   and scoring 1.0 in a probe. It is a cache miss instead.
 *
 * A meta that parses but has no `guardPassed` key still counts as a pass: the
 * field has been written since the first public release, so its absence means
 * an artifact from a build that predates it rather than a crashed one.
 */
export type CachedGuardVerdict = "pass" | "fail" | "unusable"

export async function readVariantGuardPassed(variantDir: string): Promise<CachedGuardVerdict> {
  const metaFile = Bun.file(path.join(variantDir, "meta.json"))
  if (!(await metaFile.exists())) return "unusable"
  try {
    const meta = JSON.parse(await metaFile.text()) as { guardPassed?: boolean }
    return meta.guardPassed === false ? "fail" : "pass"
  } catch {
    return "unusable"
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
      const cachedVerdict = (await existing.exists())
        ? await readVariantGuardPassed(path.dirname(compiledPath))
        : undefined
      if (cachedVerdict === "unusable") {
        log.warn(`[${condition}] cached ${passTag} variant for ${skillId} has no readable meta.json — treating as an incomplete compile`)
      }
      if (cachedVerdict !== undefined && cachedVerdict !== "unusable") {
        compiledContent = await existing.text()
        loadedSkillPath = compiledPath
        guardPassed = cachedVerdict === "pass"
        log.info(`[${condition}] Using cached ${passTag} variant for ${skillId}`)
      } else if (passTag === "p1p2p3") {
        // Check legacy flat path (backward compatibility)
        const legacyPath = path.join(getVariantDir(harness, adapterConfig.model, skillId), "SKILL.md")
        const legacyFile = Bun.file(legacyPath)
        const legacyVerdict = (await legacyFile.exists())
          ? await readVariantGuardPassed(path.dirname(legacyPath))
          : undefined
        if (legacyVerdict !== undefined && legacyVerdict !== "unusable") {
          compiledContent = await legacyFile.text()
          loadedSkillPath = legacyPath
          guardPassed = legacyVerdict === "pass"
          log.info(`[${condition}] Using legacy cached variant for ${skillId}`)
        } else {
          throw new Error("not cached")
        }
      } else {
        throw new Error("not cached")
      }
    } catch {
      // Compile with the requested passes. A TCP profile is only needed when
      // one of them consumes it (pass 1) — a cached variant above needs
      // neither the TCP nor a compiler provider. Mirrors compileSkill's own
      // per-pass gate; checked here first to fail as a scored zero rather
      // than an exception from inside the compiler.
      if (!ctx.compilerProvider) {
        return zeroConditionResult(condition, { skillId, skillPath }, {
          error: `[aot-variant] ${condition} needs to compile ${skillId} but no compiler provider is configured`,
          runStatus: "adapter-crashed",
          statusDetail: "aot compile impossible: no compiler provider",
        })
      }
      if (!ctx.tcp && resolvePassTokens(passes.map(String)).some((p) => p.requiresTcp)) {
        return zeroConditionResult(condition, { skillId, skillPath }, {
          error: `[aot-variant] ${condition} includes a TCP-consuming pass but no --profile was provided`,
          runStatus: "adapter-crashed",
          statusDetail: "aot compile impossible: missing TCP profile",
        })
      }
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
          aotGuardPassed: false,
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
        aotGuardPassed: guardPassed,
      },
    })
  },
}
