import path from "node:path"
import { readdir, mkdir, copyFile } from "node:fs/promises"
import { createHash } from "node:crypto"

// ---------------------------------------------------------------------------
// Content hash helper
// ---------------------------------------------------------------------------

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16)
}

// ---------------------------------------------------------------------------
// Shared skill-loading primitives
// ---------------------------------------------------------------------------
//
// A *skill* is a directory containing a `SKILL.md` file. Frontmatter (YAML)
// at the top of SKILL.md carries human-facing metadata (name, description).
// All other files under the directory are "bundle files" (scripts, templates,
// reference docs) that get shipped with the skill when it runs.
//
// This module has no knowledge of the bench registry, skill.json, or version
// directories — those concepts are dead. Callers hand it a path and get back
// a self-contained `ResolvedSkill`.

export interface SkillMeta {
  name: string
  description: string
}

export interface ResolvedSkill {
  /** Stable identity: the directory basename. */
  skillId: string
  /** Absolute path to the skill directory. */
  skillDir: string
  /** Absolute path to SKILL.md inside the directory. */
  skillPath: string
  /** Contents of SKILL.md. */
  skillContent: string
  /** Parsed frontmatter metadata (fallback name = directory name). */
  skillMeta: SkillMeta
  /** All files under skillDir except SKILL.md itself, as paths relative to skillDir. */
  bundleFiles: string[]
}

/**
 * Load a skill from a directory or a SKILL.md file path.
 * - If the input ends with `.md`, it is treated as the SKILL.md file.
 * - Otherwise it is treated as the skill directory.
 * Throws if SKILL.md is missing.
 */
export async function loadSkill(input: string): Promise<ResolvedSkill> {
  const resolved = path.resolve(input)
  const skillPath = resolved.endsWith(".md")
    ? resolved
    : path.join(resolved, "SKILL.md")
  const skillDir = path.dirname(skillPath)

  const file = Bun.file(skillPath)
  if (!(await file.exists())) {
    throw new Error(`SKILL.md not found at ${skillPath}`)
  }

  const skillContent = await file.text()
  const skillMeta = parseSkillMeta(skillContent, skillDir)
  const bundleFiles = await listBundleFiles(skillDir)
  const skillId = path.basename(skillDir)

  return { skillId, skillDir, skillPath, skillContent, skillMeta, bundleFiles }
}

/**
 * Parse YAML frontmatter from the top of a SKILL.md.
 * Falls back to the directory name / a generic description if frontmatter
 * is missing or incomplete.
 */
export function parseSkillMeta(skillContent: string, skillDir: string): SkillMeta {
  const fallbackName = path.basename(skillDir)
  const fallbackDescription = "User-specified skill injected by SkVM"

  const match = /^---\n([\s\S]*?)\n---\n/.exec(skillContent)
  if (!match) {
    return { name: fallbackName, description: fallbackDescription }
  }

  let name = fallbackName
  let description = fallbackDescription

  const frontmatter = match[1] ?? ""
  for (const line of frontmatter.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.startsWith("name:")) {
      name = trimmed.slice("name:".length).trim().replace(/^['"]|['"]$/g, "") || fallbackName
    } else if (trimmed.startsWith("description:")) {
      description = trimmed.slice("description:".length).trim().replace(/^['"]|['"]$/g, "") || fallbackDescription
    }
  }

  return { name, description }
}

/**
 * Copy skill bundle files (scripts, templates) into a target directory,
 * preserving subdirectory structure. Used by callers that pre-populate
 * the agent's workDir before running the adapter.
 */
export async function copySkillBundle(skill: ResolvedSkill, destDir: string): Promise<void> {
  if (skill.bundleFiles.length === 0) return
  for (const relPath of skill.bundleFiles) {
    const src = path.join(skill.skillDir, relPath)
    const dest = path.join(destDir, relPath)
    await mkdir(path.dirname(dest), { recursive: true })
    await copyFile(src, dest)
  }
}

/** VCS metadata and OS junk that should never appear in a skill bundle. */
const BUNDLE_EXCLUDED = new Set([".git", ".DS_Store"])

async function listBundleFiles(skillDir: string, prefix = ""): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await readdir(skillDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (BUNDLE_EXCLUDED.has(entry.name)) continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...await listBundleFiles(path.join(skillDir, entry.name), rel))
    } else if (entry.isFile()) {
      if (rel === "SKILL.md") continue
      out.push(rel)
    }
  }
  return out
}
