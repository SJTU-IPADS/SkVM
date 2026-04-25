import path from "node:path"
import { readdir } from "node:fs/promises"
import { z } from "zod"
import type { LLMProvider } from "../../../providers/types.ts"
import type { DependencyEntry, TokenUsage } from "../../../core/types.ts"
import { extractStructured } from "../../../providers/structured.ts"
import { createLogger } from "../../../core/logger.ts"
import { ARTIFACT_DIR } from "../../artifacts.ts"

const log = createLogger("pass2:extract")

const SKIP_DIRS = new Set(["_profiling", "node_modules", ".git", ARTIFACT_DIR])
const BINARY_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip", ".tar", ".gz", ".bin", ".exe", ".woff", ".woff2", ".ttf"])
const MAX_FILE_SIZE = 64 * 1024 // 64 KB

const DependencySchema = z.object({
  name: z.string(),
  type: z.enum(["pip", "npm", "system", "service"]),
  checkCommand: z.string(),
  installCommand: z.string().optional(),
  required: z.boolean(),
  source: z.enum(["python-import", "shell-command", "comment", "inferred", "model"]).default("model"),
  confidence: z.number().min(0).max(1).default(0.7),
  pythonModules: z.array(z.string()).optional(),
})

const ExtractionSchema = z.object({
  dependencies: z.array(DependencySchema),
})

const PYTHON_STDLIB = new Set([
  "argparse", "asyncio", "collections", "csv", "datetime", "functools", "glob", "hashlib",
  "io", "itertools", "json", "logging", "math", "os", "pathlib", "random", "re", "shutil",
  "statistics", "subprocess", "sys", "tempfile", "time", "typing", "unittest", "urllib",
  "uuid", "warnings", "xml", "zipfile",
])

interface PythonImportHint {
  module: string
  count: number
}

/**
 * Read all text files from workDir, skipping profiling artifacts and binaries.
 */
async function readBundleFiles(workDir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const entries = await readdir(workDir, { withFileTypes: true, recursive: true })

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const fullPath = path.join(entry.parentPath ?? workDir, entry.name)
    const relPath = path.relative(workDir, fullPath)

    // Skip profiling artifacts and hidden dirs
    if (relPath.split(path.sep).some(seg => SKIP_DIRS.has(seg))) continue

    // Skip binary files
    if (BINARY_EXTS.has(path.extname(entry.name).toLowerCase())) continue

    // Skip oversized files
    const file = Bun.file(fullPath)
    const size = file.size
    if (size > MAX_FILE_SIZE) {
      log.debug(`Skipping large file: ${relPath} (${size} bytes)`)
      continue
    }

    try {
      const content = await file.text()
      files.set(relPath, content)
    } catch {
      log.debug(`Skipping unreadable file: ${relPath}`)
    }
  }

  return files
}

/**
 * Build a concatenated context string from skill content + bundle files.
 */
function buildFileContext(skillContent: string, bundleFiles: Map<string, string>): string {
  const parts: string[] = [`--- SKILL.md ---\n${skillContent}`]

  for (const [relPath, content] of bundleFiles) {
    if (relPath === "SKILL.md") continue // already included
    parts.push(`--- ${relPath} ---\n${content}`)
  }

  return parts.join("\n\n")
}

// Single-line capture: `\s` in a character class also matches newlines, so
// a naive `[..\s]+` would let a greedy capture span across multiple `import`
// lines. Use literal space + tab instead.
const IMPORT_RE = /^[\t ]*import[\t ]+([a-zA-Z0-9_.,\t ]+)$/gm
const FROM_RE = /^[\t ]*from[\t ]+([a-zA-Z0-9_.]+)[\t ]+import[\t ]+/gm

export function extractPythonImportHints(bundleFiles: Map<string, string>): PythonImportHint[] {
  const counts = new Map<string, number>()

  for (const [relPath, content] of bundleFiles) {
    if (!relPath.endsWith(".py") && !relPath.endsWith("SKILL.md") && !relPath.endsWith(".md")) continue

    for (const m of content.matchAll(IMPORT_RE)) {
      const raw = m[1] ?? ""
      for (const seg of raw.split(",")) {
        const name = seg.trim().split(" as ")[0]?.trim()
        if (!name) continue
        const top = name.split(".")[0] ?? name
        if (!top || PYTHON_STDLIB.has(top)) continue
        counts.set(top, (counts.get(top) ?? 0) + 1)
      }
    }

    for (const m of content.matchAll(FROM_RE)) {
      const raw = m[1] ?? ""
      const top = raw.split(".")[0] ?? raw
      if (!top || PYTHON_STDLIB.has(top)) continue
      counts.set(top, (counts.get(top) ?? 0) + 1)
    }
  }

  return [...counts.entries()]
    .map(([module, count]) => ({ module, count }))
    .sort((a, b) => b.count - a.count)
}

const VALID_PACKAGE_NAME = /^[a-zA-Z0-9._\-]+$/

/**
 * Drop entries the LLM clearly hallucinated:
 *  - names containing whitespace or characters not allowed in a real package
 *    name (signals the LLM concatenated multiple imports into one `name`),
 *  - Python stdlib top-level modules tagged as `pip` deps,
 *  - low-confidence pip deps the LLM attributed to `python-import` but
 *    the local import scan didn't find — these are typically hallucinated
 *    package names invented from non-stdlib-looking identifiers.
 */
export function sanitizeDependencies(
  deps: DependencyEntry[],
  importHints: PythonImportHint[],
): DependencyEntry[] {
  const localPipNames = new Set(importHints.map((h) => h.module.toLowerCase()))
  const cleaned: DependencyEntry[] = []
  for (const dep of deps) {
    const name = dep.name.trim()
    if (!VALID_PACKAGE_NAME.test(name)) {
      log.warn(`Dropping dependency with malformed name ${JSON.stringify(name)} (likely LLM parser confusion)`)
      continue
    }
    if (dep.type === "pip" && PYTHON_STDLIB.has(name.toLowerCase())) {
      log.debug(`Dropping Python stdlib module from pip deps: ${name}`)
      continue
    }
    if (
      dep.type === "pip" &&
      dep.source === "python-import" &&
      !localPipNames.has(name.toLowerCase()) &&
      (dep.confidence ?? 0) < 0.9
    ) {
      log.debug(`Dropping unverified pip dep "${name}" (LLM-claimed import not found in local scan)`)
      continue
    }
    cleaned.push({ ...dep, name })
  }
  return cleaned
}

function dedupeDependencies(dependencies: DependencyEntry[]): DependencyEntry[] {
  const byKey = new Map<string, DependencyEntry>()
  for (const dep of dependencies) {
    const key = `${dep.type}:${dep.name.toLowerCase()}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, dep)
      continue
    }

    byKey.set(key, {
      ...existing,
      checkCommand: existing.checkCommand || dep.checkCommand,
      installCommand: existing.installCommand || dep.installCommand,
      required: existing.required || dep.required,
      source: existing.source === "model" ? dep.source : existing.source,
      confidence: Math.max(existing.confidence ?? 0, dep.confidence ?? 0),
      pythonModules: [...new Set([...(existing.pythonModules ?? []), ...(dep.pythonModules ?? [])])],
    })
  }
  return [...byKey.values()]
}

function mergeImportHints(
  extracted: DependencyEntry[],
  importHints: PythonImportHint[],
): DependencyEntry[] {
  const existingPipNames = new Set(
    extracted
      .filter((d) => d.type === "pip")
      .map((d) => d.name.toLowerCase()),
  )

  const inferred: DependencyEntry[] = []
  for (const hint of importHints) {
    const pkg = hint.module
    if (existingPipNames.has(pkg.toLowerCase())) continue
    inferred.push({
      name: pkg,
      type: "pip",
      checkCommand: `python -m pip show ${pkg}`,
      installCommand: `python -m pip install ${pkg}`,
      required: true,
      source: "python-import",
      confidence: 0.6,
      pythonModules: [hint.module],
    })
  }

  return dedupeDependencies([...extracted, ...inferred])
}

/**
 * Phase A: Extract dependencies from skill document + bundle files.
 *
 * Reads all files from workDir, concatenates them as context, and uses
 * extractStructured() to get a typed DependencyEntry[] in a single LLM call.
 */
export async function extractDependencies(
  skillContent: string,
  workDir: string,
  provider: LLMProvider,
): Promise<{ dependencies: DependencyEntry[]; tokens: TokenUsage }> {
  const bundleFiles = await readBundleFiles(workDir)
  log.info(`Read ${bundleFiles.size} bundle files from ${workDir}`)

  const fileContext = buildFileContext(skillContent, bundleFiles)
  const pythonImportHints = extractPythonImportHints(bundleFiles)

  const importHintText = pythonImportHints.length > 0
    ? pythonImportHints.map((h) => `- ${h.module} (count=${h.count})`).join("\n")
    : "- None detected"

  const { result, tokens } = await extractStructured({
    provider,
    schema: ExtractionSchema,
    schemaName: "report_dependencies",
    schemaDescription: "Report all external dependencies found in the skill and its bundle files.",
    system: `You are a dependency analyzer for SkVM, a system that compiles LLM agent skills.

Analyze the provided skill document and all bundle files to identify every external dependency the skill requires at runtime.

## What to look for
- Python import statements (e.g., \`import pandas\`, \`from pypdf import PdfReader\`)
- pip/npm install commands or comments referencing packages
- CLI tools invoked via shell commands (e.g., \`ffmpeg\`, \`curl\`, \`jq\`)
- Service endpoints that require running daemons (e.g., database servers)
- Shebang lines that reference specific interpreters

## What to exclude
- Python standard library modules (os, sys, json, pathlib, etc.)
- The LLM itself or the agent harness
- Files or data that are part of the skill bundle

## For each dependency, provide:
- \`name\`: package or tool name (e.g., "pandas", "ffmpeg")
- \`type\`: one of "pip", "npm", "system", "service"
- \`checkCommand\`: shell command to verify presence (e.g., "pip show pandas", "command -v ffmpeg")
- \`installCommand\`: shell command to install (e.g., "pip install pandas", "brew install ffmpeg")
- \`required\`: true if strictly required, false if optional

Also include:
- \`source\`: one of "python-import", "shell-command", "comment", "inferred", "model"
- \`confidence\`: float in [0, 1]
- \`pythonModules\`: optional array of linked Python module names

Use conventional check/install commands:
- pip: checkCommand = "pip show <pkg>", installCommand = "pip install <pkg>"
- npm: checkCommand = "npm list -g <pkg>", installCommand = "npm install -g <pkg>"
- system: checkCommand = "command -v <tool>", installCommand = platform-appropriate command`,
    prompt: `Analyze the following skill files and extract all external dependencies.

Python import hints (high-signal candidates):
${importHintText}

Skill files:
${fileContext}`,
  })

  const normalized = result.dependencies.map((dep) => ({
    ...dep,
    source: dep.source ?? "model",
    confidence: dep.confidence ?? 0.7,
  }))

  const sanitized = sanitizeDependencies(normalized, pythonImportHints)
  const enriched = mergeImportHints(sanitized, pythonImportHints)
  log.info(`Extracted ${enriched.length} dependencies (post-merge, ${normalized.length - sanitized.length} dropped)`)
  return { dependencies: enriched, tokens }
}
