/**
 * `skvm clean-jit` — clear persisted JIT artifacts for a model+adapter.
 * Migrated to the declarative flag layer (#49).
 */

import { defineFlags, UsageError, type ConfigOf } from "./flags.ts"
import { ALL_ADAPTERS } from "../adapters/registry.ts"

export const CLEAN_JIT_FLAGS = defineFlags(
  "clean-jit",
  "Clear persisted JIT artifacts for a model+adapter",
  {
    model: {
      kind: "string",
      required: true,
      placeholder: "<id>",
      help: "Model identifier, shaped as <provider>/<model-id>",
    },
    adapter: {
      kind: "enum",
      values: ALL_ADAPTERS,
      required: true,
      placeholder: "<name>",
      help: `Adapter: ${ALL_ADAPTERS.join(", ")}`,
    },
    "dry-run": { kind: "bool", help: "Show what would be deleted, but do not delete" },
    yes: { kind: "bool", help: "Confirm deletion (required unless --dry-run)" },
    "include-bench-logs": { kind: "bool", help: "Also delete matching logs/bench session folders" },
  },
  {
    usage: ["skvm clean-jit --model=<id> --adapter=<name> [options]"],
    epilogue: `Default cleanup targets:
  - ~/.skvm/log/runtime/{adapter}/{safeModel}
  - ~/.skvm/proposals/aot-compile/{adapter}/{safeModel}/**/solidification-state.json

Notes:
  - This command keeps compiled SKILL.md, jit-candidates.json, and profiles intact.
  - It is intended for clean JIT effect testing across repeated bench runs.`,
  },
)

export type CleanJITConfig = ConfigOf<typeof CLEAN_JIT_FLAGS>

export async function runCleanJIT(config: CleanJITConfig): Promise<void> {
  const { model, adapter, yes } = config
  const dryRun = config["dry-run"]
  const includeBenchLogs = config["include-bench-logs"]

  const path = await import("node:path")
  const { readdir, rm, stat, unlink } = await import("node:fs/promises")
  const { LOGS_DIR, safeModelName } = await import("../core/config.ts")
  const { getVariantModelDir } = await import("../proposals/storage.ts")

  const runtimeModelDir = path.join(LOGS_DIR, "runtime", adapter, safeModelName(model))
  const compiledModelDir = getVariantModelDir(adapter, model)
  const benchRootDir = path.join(LOGS_DIR, "bench")

  async function pathExists(p: string): Promise<boolean> {
    try {
      await stat(p)
      return true
    } catch {
      return false
    }
  }

  async function collectSolidificationFiles(rootDir: string): Promise<string[]> {
    if (!(await pathExists(rootDir))) return []
    const files: string[] = []
    const stack = [rootDir]

    while (stack.length > 0) {
      const dir = stack.pop()!
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        const entryName = String(entry.name)
        const fullPath = path.join(dir, entryName)
        if (entry.isDirectory()) {
          stack.push(fullPath)
        } else if (entry.isFile() && entryName === "solidification-state.json") {
          files.push(fullPath)
        }
      }
    }

    return files
  }

  async function collectBenchSessions(rootDir: string): Promise<string[]> {
    if (!includeBenchLogs || !(await pathExists(rootDir))) return []
    const matched: string[] = []
    const sessions = await readdir(rootDir, { withFileTypes: true })

    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const sessionDir = path.join(rootDir, session.name)
      const progressFile = path.join(sessionDir, "progress.json")
      if (!(await pathExists(progressFile))) continue
      try {
        const raw = await Bun.file(progressFile).text()
        const progress = JSON.parse(raw) as { model?: string; adapter?: string }
        if (progress.model === model && progress.adapter === adapter) {
          matched.push(sessionDir)
        }
      } catch {
        // Ignore malformed progress files and continue.
      }
    }

    return matched
  }

  const solidificationFiles = await collectSolidificationFiles(compiledModelDir)
  const benchSessionDirs = await collectBenchSessions(benchRootDir)

  const runtimeDirExists = await pathExists(runtimeModelDir)

  console.log(`\n=== clean-jit plan ===`)
  console.log(`Model: ${model}`)
  console.log(`Adapter: ${adapter}`)
  console.log(`Dry run: ${dryRun ? "yes" : "no"}`)
  console.log(`Include bench logs: ${includeBenchLogs ? "yes" : "no"}`)
  console.log(``)
  console.log(`Delete directory: ${runtimeModelDir}${runtimeDirExists ? "" : " (missing)"}`)
  console.log(`Delete files: ${solidificationFiles.length} solidification-state.json`)
  if (includeBenchLogs) {
    console.log(`Delete bench sessions: ${benchSessionDirs.length}`)
  }

  if (dryRun) {
    if (solidificationFiles.length > 0) {
      console.log(`\nsolidification-state targets:`)
      for (const f of solidificationFiles) {
        console.log(`  ${f}`)
      }
    }
    if (includeBenchLogs && benchSessionDirs.length > 0) {
      console.log(`\nbench session targets:`)
      for (const d of benchSessionDirs) {
        console.log(`  ${d}`)
      }
    }
    return
  }

  if (!yes) {
    throw new UsageError(
      "\nRefusing to delete without --yes. Re-run with --dry-run first, then add --yes.",
      CLEAN_JIT_FLAGS.help,
    )
  }

  const errors: string[] = []
  let deletedDirs = 0
  let deletedFiles = 0

  if (runtimeDirExists) {
    try {
      await rm(runtimeModelDir, { recursive: true, force: true })
      deletedDirs++
    } catch (err) {
      errors.push(`Failed to remove ${runtimeModelDir}: ${String(err)}`)
    }
  }

  for (const filePath of solidificationFiles) {
    try {
      await unlink(filePath)
      deletedFiles++
    } catch (err) {
      errors.push(`Failed to remove ${filePath}: ${String(err)}`)
    }
  }

  for (const sessionDir of benchSessionDirs) {
    try {
      await rm(sessionDir, { recursive: true, force: true })
      deletedDirs++
    } catch (err) {
      errors.push(`Failed to remove ${sessionDir}: ${String(err)}`)
    }
  }

  console.log(`\n=== clean-jit result ===`)
  console.log(`Deleted directories: ${deletedDirs}`)
  console.log(`Deleted files: ${deletedFiles}`)
  console.log(`Errors: ${errors.length}`)

  if (errors.length > 0) {
    for (const err of errors) {
      console.error(`  ${err}`)
    }
    process.exit(1)
  }
}
