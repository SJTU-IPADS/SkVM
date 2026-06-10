import path from "node:path"
import { mkdir, readdir, copyFile } from "node:fs/promises"
import type { SkillMeta, ResolvedSkill } from "../../core/skill-loader.ts"
import { contentHash, copySkillBundle } from "../../core/skill-loader.ts"

/** Copy bundle files for multiple skills */
export async function copySkillBundles(skills: ResolvedSkill[], workDir: string): Promise<void> {
  for (const skill of skills) {
    await copySkillBundle(skill, workDir)
  }
}

/**
 * Recursively copy every file from `srcDir` into `workDir`, except those
 * whose srcDir-relative path the `skip` predicate rejects. Tolerates a
 * missing/empty source (no bundle files is a normal state).
 */
export async function copyDirFiltered(
  srcDir: string,
  workDir: string,
  skip: (relPath: string) => boolean,
): Promise<void> {
  try {
    const entries = await readdir(srcDir, { withFileTypes: true, recursive: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const full = path.join(entry.parentPath ?? srcDir, entry.name)
      const rel = path.relative(srcDir, full)
      if (skip(rel)) continue
      const dest = path.join(workDir, rel)
      await mkdir(path.dirname(dest), { recursive: true })
      await copyFile(full, dest)
    }
  } catch { /* no bundle files */ }
}

/** Copy all non-SKILL.md files from a skill-shaped directory into a workDir. */
export async function copyBundleFromDir(srcDir: string, workDir: string): Promise<void> {
  await copyDirFiltered(srcDir, workDir, (rel) =>
    rel === "SKILL.md" || rel.startsWith(".") || rel.startsWith("_meta.json") || rel === "LICENSE.txt")
}

/** Join multiple skill bodies into one prompt-loadable document. */
export function concatContents(contents: string[]): string {
  if (contents.length === 1) return contents[0]!
  return contents.join("\n\n---\n\n")
}

/** Concatenate multiple skill contents into a single string */
export function concatSkillContents(skills: ResolvedSkill[]): string {
  return concatContents(skills.map(s => s.skillContent))
}

/** Combined identity for multi-skill condition runs ("skill-a+skill-b"). */
export function combinedSkillId(skills: ResolvedSkill[]): string {
  return skills.map(s => s.skillId).join("+")
}

/** Build combined skill metadata for multi-skill condition results */
export function buildSkillMeta(skills: ResolvedSkill[]): { skillId: string; skillContentHash: string } {
  return {
    skillId: combinedSkillId(skills),
    skillContentHash: contentHash(concatSkillContents(skills)),
  }
}

/** The skill-identity fields stamped on a ConditionResult for skill-bearing conditions. */
export function skillResultMeta(skills: ResolvedSkill[]): {
  skillId: string
  skillContentHash: string
  skillPath: string | undefined
  skillPaths: string[]
} {
  const skillPaths = skills.map((s) => s.skillPath)
  return { ...buildSkillMeta(skills), skillPath: skillPaths[0], skillPaths }
}

/** Frontmatter metadata for the staged bundle — single skill's own meta, or a synthetic multi-skill one. */
export function bundleSkillMeta(skills: ResolvedSkill[], combinedId: string): SkillMeta {
  return skills.length === 1
    ? skills[0]!.skillMeta
    : { name: combinedId, description: "Multi-skill bundle" }
}
