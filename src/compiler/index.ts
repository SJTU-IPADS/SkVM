import path from "node:path"
import { mkdir, writeFile, copyFile, rm, appendFile, readdir } from "node:fs/promises"
import type { LLMProvider } from "../providers/types.ts"
import { emptyTokenUsage, addTokenUsage } from "../core/types.ts"
import { copyDirRecursive } from "../core/fs-utils.ts"
import { toPassTag, getCompileLogDir } from "../core/config.ts"
import { getVariantDir } from "../proposals/storage.ts"
import { createLogger } from "../core/logger.ts"
import { createSpinner } from "../core/spinner.ts"
import { ConversationLog } from "../core/conversation-logger.ts"
import { LoggingProvider } from "../core/logging-provider.ts"
import type { CompileOptions, CompilationResult } from "./types.ts"
import { resolveCompilerTimeout } from "../core/timeouts.ts"
import type { ArtifactKey, PassRunMeta } from "./artifacts.ts"
import { ArtifactStore, ARTIFACT_DIR } from "./artifacts.ts"
import type { CompilerPass, PassContext, SkillPatch } from "./passes/types.ts"
import { defaultPasses, resolvePassTokens, topoSort, validateDeps } from "./registry.ts"
import { generateWorkflowDagDocument } from "./passes/extract-parallelism/parallelism.ts"
import { validateGuard } from "./guard.ts"

const log = createLogger("compiler")

function extractSkillName(_skillContent: string, skillPath: string): string {
  const base = path.basename(skillPath)
  return base.replace(/\.md$/i, "")
}

/**
 * Compile a skill for a target (model + harness).
 *
 * Resolves the requested passes from the registry, populates a per-job
 * `workDir`, then runs each pass in topological order. Each pass produces
 * `artifacts` (persisted under `workDir/_artifacts/{key}.json`) and may emit
 * a `skillPatch` that mutates SKILL.md on disk and in memory.
 */
export async function compileSkill(
  opts: CompileOptions,
  provider: LLMProvider,
  options?: { showSpinner?: boolean },
): Promise<CompilationResult> {
  const startMs = performance.now()
  const showSpinner = options?.showSpinner !== false

  const requestedPasses = opts.passes && opts.passes.length > 0
    ? resolvePassTokens(opts.passes)
    : defaultPasses()
  const orderedPasses = topoSort(requestedPasses)
  const numericPasses = orderedPasses.map((p) => p.number)

  // Passes declare `requiresTcp` when they read the profile (pass 1). Reject
  // up front — before any workDir side effect — so a profile-less compile of
  // only pass 2/3 works, and a missing profile fails fast otherwise.
  const tcpConsumers = orderedPasses.filter((p) => p.requiresTcp)
  if (tcpConsumers.length > 0 && !opts.tcp) {
    throw new Error(
      `pass(es) ${tcpConsumers.map((p) => `"${p.id}"`).join(", ")} require a TCP profile but none was provided. Run 'skvm profile' first, or drop them from --pass.`,
    )
  }

  log.info(`Compiling skill for ${opts.model}--${opts.harness}`)

  const skillName = opts.skillName ?? extractSkillName(opts.skillContent, opts.skillDir ?? opts.skillPath)
  const passTag = toPassTag(numericPasses)
  const workDir = getVariantDir(opts.harness, opts.model, skillName, passTag)
  const compileLogDir = getCompileLogDir(opts.harness, opts.model, skillName)
  await Promise.all([
    mkdir(workDir, { recursive: true }),
    mkdir(compileLogDir, { recursive: true }),
  ])

  if (opts.skillDir) {
    await copyDirRecursive(opts.skillDir, workDir)
    log.info(`Pre-copied skill dir ${opts.skillDir} → ${workDir}`)
  } else {
    await Bun.write(path.join(workDir, "SKILL.md"), opts.skillContent)
  }

  await copyProfilingArtifacts(opts, workDir)

  const store = await ArtifactStore.load(workDir)

  const cachedKeys = new Set<ArtifactKey>(Object.keys(store.snapshot()) as ArtifactKey[])
  const depErrors = validateDeps(orderedPasses, cachedKeys)
  if (depErrors.length > 0) {
    throw new Error(`Pass dependency check failed:\n  - ${depErrors.join("\n  - ")}`)
  }

  // Canonical SKILL.md text held in memory across passes; flushed to disk by
  // applySkillPatch when a pass emits a SkillPatch. Avoids re-reading the
  // file in every pass and at the end.
  let skillContent = await Bun.file(path.join(workDir, "SKILL.md")).text()

  const passRuns: Record<string, PassRunMeta> = {}
  let totalTokens = emptyTokenUsage()

  for (const pass of orderedPasses) {
    const passStart = performance.now()
    const convLog = new ConversationLog(path.join(compileLogDir, `${pass.id}.jsonl`))
    const wrappedProvider = new LoggingProvider(provider, convLog)
    const ctx: PassContext = {
      skillName,
      workDir,
      skillContent,
      tcp: opts.tcp,
      model: opts.model,
      harness: opts.harness,
      provider: wrappedProvider,
      failureContext: opts.failureContext,
      artifacts: store,
      timeoutMs: resolveCompilerTimeout({ cli: opts.timeoutMs }),
    }
    const sp = showSpinner ? createSpinner(`Compiling — ${pass.id}...`) : null
    if (!sp) log.info(`Pass ${pass.number} (${pass.id})`)

    try {
      const out = await pass.run(ctx)
      await store.merge(out.artifacts)
      if (out.skillPatch) {
        skillContent = await applySkillPatch(workDir, skillContent, out.skillPatch)
      }
      const tokens = wrappedProvider.tokens
      totalTokens = addTokenUsage(totalTokens, tokens)
      const meta: PassRunMeta = {
        passId: pass.id,
        status: "ok",
        tokens,
        durationMs: performance.now() - passStart,
        ...(out.iterations !== undefined ? { iterations: out.iterations } : {}),
      }
      passRuns[pass.id] = meta
      await store.writeMeta(meta)
      sp?.succeed(`${pass.id}: ${summarizePass(pass, out.artifacts)}`)
    } catch (err) {
      const meta: PassRunMeta = {
        passId: pass.id,
        status: "failed",
        tokens: wrappedProvider.tokens,
        durationMs: performance.now() - passStart,
        error: err instanceof Error ? err.message : String(err),
      }
      passRuns[pass.id] = meta
      await store.writeMeta(meta).catch(() => {})
      sp?.fail(`${pass.id}: failed`)
      throw err
    } finally {
      await convLog.finalize()
    }
  }

  const guard = validateGuard(opts.skillContent, skillContent, {
    bundlePaths: await listBundleFilePaths(workDir),
  })
  if (!guard.passed) {
    log.warn(`Guard failed: ${guard.violations.join("; ")}`)
  }

  return {
    skillName,
    model: opts.model,
    harness: opts.harness,
    compiledAt: new Date().toISOString(),
    compiledSkill: skillContent,
    artifacts: store.snapshot(),
    passRuns,
    guardPassed: guard.passed,
    guardViolations: guard.violations,
    tokens: totalTokens,
    passes: numericPasses,
    costUsd: 0,
    durationMs: performance.now() - startMs,
  }
}

// Compilation metadata that lives in the variant dir but is not part of the
// shipped skill bundle — excluded from the guard's reference-integrity set.
const GUARD_SKIP_FILES = new Set(["SKILL.md", "compilation-plan.json", "meta.json", "env-setup.sh", "jit-candidates.json", "workflow-dag.md"])
const GUARD_SKIP_DIRS = new Set([ARTIFACT_DIR, "_profiling"])

/** Relative paths of the real bundle files in `workDir`, for the guard. */
async function listBundleFilePaths(workDir: string): Promise<string[]> {
  const entries = await readdir(workDir, { withFileTypes: true, recursive: true })
  const paths: string[] = []
  for (const e of entries) {
    if (!e.isFile()) continue
    const rel = path.relative(workDir, path.join(e.parentPath ?? workDir, e.name))
    const segs = rel.split(path.sep)
    if (segs.some((s) => GUARD_SKIP_DIRS.has(s))) continue
    if (GUARD_SKIP_FILES.has(rel)) continue
    paths.push(segs.join("/"))
  }
  return paths
}

async function copyProfilingArtifacts(opts: CompileOptions, workDir: string): Promise<void> {
  if (!opts.tcp) return
  type CopyJob = { src: string; dest: string }
  const jobs: CopyJob[] = []
  for (const detail of opts.tcp.details) {
    if (!detail.convLogDir) continue
    for (const lr of detail.levelResults) {
      if (!lr.failureArtifacts?.length) continue
      for (const artifact of lr.failureArtifacts) {
        for (const src of [artifact.convLog, artifact.evalScript]) {
          const rel = path.relative(detail.convLogDir, src)
          jobs.push({ src, dest: path.join(workDir, "_profiling", detail.primitiveId, rel) })
        }
      }
    }
  }
  await Promise.all(jobs.map(async (job) => {
    try {
      await mkdir(path.dirname(job.dest), { recursive: true })
      await copyFile(job.src, job.dest)
    } catch { /* source may not exist for older profiles */ }
  }))
}

async function applySkillPatch(workDir: string, current: string, patch: SkillPatch): Promise<string> {
  const skillPath = path.join(workDir, "SKILL.md")
  switch (patch.kind) {
    case "rewrite":
      await Bun.write(skillPath, patch.content)
      return patch.content
    case "append":
      await appendFile(skillPath, patch.content)
      return current + patch.content
  }
}

function summarizePass(pass: CompilerPass, artifacts: Record<string, unknown>): string {
  const parts: string[] = []
  for (const key of pass.produces) {
    const value = artifacts[key]
    if (value === undefined) continue
    if (Array.isArray(value)) {
      parts.push(`${key}=${value.length}`)
    } else if (key === "dag" && isDag(value)) {
      parts.push(`dag.steps=${value.steps.length}`, `dag.parallelism=${value.parallelism.length}`)
    } else if (key === "envSimulation" && isEnvSim(value)) {
      parts.push(`env=${value.success ? "ok" : "fail"}(${value.attemptCount})`)
    } else if (typeof value === "string") {
      parts.push(`${key}=${value.length}b`)
    } else {
      parts.push(`${key}=set`)
    }
  }
  return parts.length > 0 ? parts.join(", ") : "ok"
}

function isDag(value: unknown): value is { steps: unknown[]; parallelism: unknown[] } {
  return typeof value === "object" && value !== null && "steps" in value && "parallelism" in value
}

function isEnvSim(value: unknown): value is { success: boolean; attemptCount: number } {
  return typeof value === "object" && value !== null && "success" in value && "attemptCount" in value
}

/** Write a compiled skill variant to disk under the aot-compile proposal tree. */
export async function writeVariant(result: CompilationResult): Promise<string> {
  // getVariantDir owns the layout — including safeModelName, which also
  // escapes ":" (the old inline slug here only handled "/", so writer and
  // readers disagreed for ids containing a colon).
  const passTag = toPassTag(result.passes)
  const dir = getVariantDir(result.harness, result.model, result.skillName, passTag)
  await mkdir(dir, { recursive: true })

  const writes: Promise<unknown>[] = [
    writeFile(path.join(dir, "SKILL.md"), result.compiledSkill),
  ]

  const dag = result.artifacts.dag
  const workflowDagPath = path.join(dir, "workflow-dag.md")
  const workflowDagDocument = dag ? generateWorkflowDagDocument(dag) : ""
  if (workflowDagDocument) {
    writes.push(writeFile(workflowDagPath, workflowDagDocument))
  } else {
    writes.push(rm(workflowDagPath, { force: true }))
  }

  const plan = {
    skillName: result.skillName,
    model: result.model,
    harness: result.harness,
    compiledAt: result.compiledAt,
    artifacts: result.artifacts,
    passRuns: result.passRuns,
    guardPassed: result.guardPassed,
    guardViolations: result.guardViolations,
  }
  writes.push(writeFile(path.join(dir, "compilation-plan.json"), JSON.stringify(plan, null, 2)))

  if (result.artifacts.envScript !== undefined) {
    writes.push(writeFile(path.join(dir, "env-setup.sh"), result.artifacts.envScript))
  }

  const meta = {
    compiledAt: result.compiledAt,
    model: result.model,
    harness: result.harness,
    passes: result.passes,
    passTag,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    guardPassed: result.guardPassed,
  }
  writes.push(writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2)))

  await Promise.all(writes)
  log.info(`Variant written to ${dir}`)
  return dir
}
