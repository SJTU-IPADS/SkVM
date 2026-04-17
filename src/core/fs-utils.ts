import path from "node:path"
import { mkdir, readdir, copyFile } from "node:fs/promises"

export interface CopyDirOptions {
  /** Return true to skip an entry (matched by its basename). */
  skip?: (name: string, isDirectory: boolean) => boolean
}

/** Recursively copy a directory tree. */
export async function copyDirRecursive(
  src: string,
  dest: string,
  opts: CopyDirOptions = {},
): Promise<void> {
  await mkdir(dest, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    if (opts.skip?.(entry.name, entry.isDirectory())) continue
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath, opts)
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath)
    }
  }
}

const SKILL_BUNDLE_EXCLUDED = new Set([
  "LICENSE.txt",
  "_meta.json",
  ".git",
  ".DS_Store",
])

/**
 * Copy a skill bundle folder, skipping VCS metadata, OS junk, and a small
 * allowlist of skill-bundle metadata. All other entries — including hidden
 * bundle directories like `.learnings/` — are copied verbatim. A blanket
 * `name.startsWith(".")` skip silently lost runtime-state files for skills
 * that depend on them (e.g. self-improving-agent).
 */
export async function copySkillDir(src: string, dest: string): Promise<void> {
  await copyDirRecursive(src, dest, {
    skip: (name) => SKILL_BUNDLE_EXCLUDED.has(name),
  })
}

const LOG_TAIL_CHUNK_BYTES = 64 * 1024

/**
 * Read the last `n` lines of a (possibly large) log file.
 *
 * Returns null when the file is missing or empty. Reads at most
 * LOG_TAIL_CHUNK_BYTES from the end of the file — sufficient for dozens of
 * typical log lines; a single line longer than the chunk is clipped at
 * chunk start, which is acceptable for diagnostic tailing.
 *
 * The trailing newline (if present) does not count as its own empty line,
 * and the first line of the chunk is dropped when we started mid-file so
 * we never emit a half line.
 */
export async function readLastLines(filePath: string, n: number): Promise<string | null> {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return null
  const size = file.size
  if (size === 0) return null
  const start = Math.max(0, size - LOG_TAIL_CHUNK_BYTES)
  const text = await file.slice(start).text()
  const lines = text.split("\n")
  const first = start > 0 ? 1 : 0
  const last = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length
  if (last <= first) return null
  return lines.slice(Math.max(first, last - n), last).join("\n")
}
