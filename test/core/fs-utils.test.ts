import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile, readdir, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { copySkillDir } from "../../src/core/fs-utils.ts"
import { loadSkill, copySkillBundle } from "../../src/core/skill-loader.ts"

async function makeFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "skvm-fs-utils-"))
  await writeFile(path.join(dir, "SKILL.md"), "# skill\n")
  await mkdir(path.join(dir, ".learnings"), { recursive: true })
  await writeFile(path.join(dir, ".learnings", "ERRORS.md"), "err\n")
  await writeFile(path.join(dir, ".learnings", "LEARNINGS.md"), "learn\n")
  await mkdir(path.join(dir, ".cache"), { recursive: true })
  await writeFile(path.join(dir, ".cache", "state.json"), "{}")
  await mkdir(path.join(dir, "scripts"), { recursive: true })
  await writeFile(path.join(dir, "scripts", "run.sh"), "#!/bin/sh\n")
  await mkdir(path.join(dir, ".git"), { recursive: true })
  await writeFile(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n")
  await writeFile(path.join(dir, ".DS_Store"), "junk")
  await writeFile(path.join(dir, "LICENSE.txt"), "mit")
  await writeFile(path.join(dir, "_meta.json"), "{}")
  return dir
}

describe("copySkillDir", () => {
  test("preserves hidden bundle directories like .learnings/ and .cache/", async () => {
    const src = await makeFixture()
    const dest = await mkdtemp(path.join(tmpdir(), "skvm-fs-utils-dest-"))
    try {
      await copySkillDir(src, dest)
      const top = (await readdir(dest)).sort()
      expect(top).toContain(".learnings")
      expect(top).toContain(".cache")
      expect(top).toContain("SKILL.md")
      expect(top).toContain("scripts")
      const learnings = (await readdir(path.join(dest, ".learnings"))).sort()
      expect(learnings).toEqual(["ERRORS.md", "LEARNINGS.md"])
      const cacheState = await stat(path.join(dest, ".cache", "state.json"))
      expect(cacheState.isFile()).toBe(true)
    } finally {
      await rm(src, { recursive: true, force: true })
      await rm(dest, { recursive: true, force: true })
    }
  })

  test("skips .git, .DS_Store, LICENSE.txt, and _meta.json", async () => {
    const src = await makeFixture()
    const dest = await mkdtemp(path.join(tmpdir(), "skvm-fs-utils-dest-"))
    try {
      await copySkillDir(src, dest)
      const top = (await readdir(dest)).sort()
      expect(top).not.toContain(".git")
      expect(top).not.toContain(".DS_Store")
      expect(top).not.toContain("LICENSE.txt")
      expect(top).not.toContain("_meta.json")
    } finally {
      await rm(src, { recursive: true, force: true })
      await rm(dest, { recursive: true, force: true })
    }
  })
})

describe("copySkillBundle", () => {
  test("copies subdirectory files preserving structure, excludes SKILL.md", async () => {
    const src = await makeFixture()
    const dest = await mkdtemp(path.join(tmpdir(), "skvm-bundle-dest-"))
    try {
      const skill = await loadSkill(src)
      await copySkillBundle(skill, dest)

      // Subdirectory files are copied with structure preserved
      const scriptStat = await stat(path.join(dest, "scripts", "run.sh"))
      expect(scriptStat.isFile()).toBe(true)

      // Root-level non-SKILL.md files are copied
      const top = (await readdir(dest)).sort()
      expect(top).toContain("scripts")
      expect(top).toContain(".learnings")
      expect(top).toContain(".cache")

      // SKILL.md, .git, .DS_Store are excluded
      expect(top).not.toContain("SKILL.md")
      expect(top).not.toContain(".git")
      expect(top).not.toContain(".DS_Store")
    } finally {
      await rm(src, { recursive: true, force: true })
      await rm(dest, { recursive: true, force: true })
    }
  })

  test("no-ops on empty bundleFiles", async () => {
    const src = await mkdtemp(path.join(tmpdir(), "skvm-empty-skill-"))
    const dest = await mkdtemp(path.join(tmpdir(), "skvm-bundle-dest-"))
    try {
      await writeFile(path.join(src, "SKILL.md"), "# empty skill\n")
      const skill = await loadSkill(src)
      expect(skill.bundleFiles).toHaveLength(0)
      await copySkillBundle(skill, dest)
      const entries = await readdir(dest)
      expect(entries).toHaveLength(0)
    } finally {
      await rm(src, { recursive: true, force: true })
      await rm(dest, { recursive: true, force: true })
    }
  })
})
