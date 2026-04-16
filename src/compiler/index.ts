import path from "node:path"
import { mkdir, writeFile, copyFile, rm } from "node:fs/promises"
import type { LLMProvider } from "../providers/types.ts"
import type { TCP } from "../core/types.ts"
import { emptyTokenUsage, addTokenUsage } from "../core/types.ts"
import { copyDirRecursive } from "../core/fs-utils.ts"
import { AOT_COMPILE_DIR, toPassTag, safeModelName, getCompileLogDir } from "../core/config.ts"
import { createLogger } from "../core/logger.ts"
import { createSpinner, type Spinner } from "../core/spinner.ts"
import { ConversationLog } from "../core/conversation-logger.ts"
import { LoggingProvider } from "../core/logging-provider.ts"
import type { CompileOptions, CompilationResult, Pass1Result, Pass2Result, Pass3Result } from "./types.ts"
import { runPass1 } from "./pass1/index.ts"
import { runPass2 } from "./pass2/index.ts"
import { runPass3, generateParallelismSection, generateWorkflowDagDocument } from "./pass3/index.ts"
import { validateGuard } from "./guard.ts"

const log = createLogger("compiler")

/** Extract skill name from the skill directory path or SKILL.md file path. */
function extractSkillName(_skillContent: string, skillPath: string): string {
  const base = path.basename(skillPath)
  return base.replace(/\.md$/i, "")
}

/**
 * Compile a skill for a target (model + harness).
 *
 * Runs 3 sequential agentic passes:
 * 1. Capability-Based Compilation (agent explores skill, analyzes gaps, writes compiled files)
 * 2. Environment Binding (agent checks dependencies, generates install script)
 * 3. Concurrency Extraction (agent decomposes workflow → pure DAG + parallelism)
 */
export async function compileSkill(
  opts: CompileOptions,
  provider: LLMProvider,
  options?: { showSpinner?: boolean },
): Promise<CompilationResult> {
  const startMs = performance.now()
  const passes = opts.passes ?? [1, 2, 3]

  log.info(`Compiling skill for ${opts.model}--${opts.harness}`)

  // Compute workDir for the compiler agent to operate on real files
  const skillName = opts.skillName ?? extractSkillName(opts.skillContent, opts.skillDir ?? opts.skillPath)
  const passTag = toPassTag(passes)
  const workDir = path.join(AOT_COMPILE_DIR, opts.harness, safeModelName(opts.model), skillName, passTag)
  await mkdir(workDir, { recursive: true })

  // Conversation log directory: logs/compile/{harness}/{safeModel}/{skill}/
  const compileLogDir = getCompileLogDir(opts.harness, opts.model, skillName)
  await mkdir(compileLogDir, { recursive: true })

  // Pre-copy: populate workDir with skill files
  if (opts.skillDir) {
    await copyDirRecursive(opts.skillDir, workDir)
    log.info(`Pre-copied skill dir ${opts.skillDir} → ${workDir}`)
  } else {
    await Bun.write(path.join(workDir, "SKILL.md"), opts.skillContent)
  }

  // Copy profiling artifacts (conv logs + eval scripts) to workDir/_profiling/
  for (const detail of opts.tcp.details) {
    if (!detail.convLogDir) continue
    for (const lr of detail.levelResults) {
      if (!lr.failureArtifacts?.length) continue
      for (const artifact of lr.failureArtifacts) {
        for (const src of [artifact.convLog, artifact.evalScript]) {
          const rel = path.relative(detail.convLogDir, src)
          const dest = path.join(workDir, "_profiling", detail.primitiveId, rel)
          try {
            await mkdir(path.dirname(dest), { recursive: true })
            await copyFile(src, dest)
          } catch { /* source may not exist for older profiles */ }
        }
      }
    }
  }

  let compiledSkill = opts.skillContent
  let totalTokens = emptyTokenUsage()

  // Pass 1: Capability-Based Compilation
  let pass1: Pass1Result = {
    scr: { skillName: "", purposes: [] },
    gaps: [],
    pathSelections: [],
    transforms: [],
    compiledSkill: opts.skillContent,
    tokens: emptyTokenUsage(),
  }

  const showSpinner = options?.showSpinner !== false

  if (passes.includes(1)) {
    const sp = showSpinner ? createSpinner("Compiling — Pass 1: capability analysis...") : null
    if (!sp) log.info("Pass 1: Capability-Based Compilation")
    try {
      const p1Log = new ConversationLog(path.join(compileLogDir, "pass1.jsonl"))
      const p1Provider = new LoggingProvider(provider, p1Log)
      pass1 = await runPass1(opts.skillContent, opts.tcp, p1Provider, workDir, opts.failureContext)
      await p1Log.finalize()
      compiledSkill = pass1.compiledSkill
      totalTokens = addTokenUsage(totalTokens, pass1.tokens)
      if (sp) sp.succeed(`Pass 1: ${pass1.scr.purposes.length} purposes, ${pass1.gaps.length} gaps`)
    } catch (err) {
      sp?.fail("Pass 1: failed")
      throw err
    }
    log.info(`  SCR: ${pass1.scr.purposes.length} purposes`)
    log.info(`  Gaps: ${pass1.gaps.length}`)
  }

  // Pass 2: Environment Binding
  let pass2: Pass2Result = {
    dependencies: [],
    presenceResults: new Map(),
    bindingScript: "#!/bin/bash\n# No dependencies detected\nexit 0\n",
    simulation: {
      attemptCount: 0,
      success: true,
      finalScriptValidated: true,
    },
  }

  if (passes.includes(2)) {
    const sp = showSpinner ? createSpinner("Compiling — Pass 2: environment binding...") : null
    if (!sp) log.info("Pass 2: Environment Binding")
    try {
      const p2Log = new ConversationLog(path.join(compileLogDir, "pass2.jsonl"))
      const p2Provider = new LoggingProvider(provider, p2Log)
      pass2 = await runPass2(compiledSkill, workDir, p2Provider)
      await p2Log.finalize()
      if (sp) {
        const missing = [...pass2.presenceResults.entries()].filter(([_, v]) => !v).length
        sp.succeed(`Pass 2: ${pass2.dependencies.length} deps, ${missing} missing`)
      }
    } catch (err) {
      sp?.fail("Pass 2: failed")
      throw err
    }
    log.info(`  Dependencies: ${pass2.dependencies.length}`)
    const missing = [...pass2.presenceResults.entries()].filter(([_, v]) => !v).length
    log.info(`  Missing: ${missing}`)
  }

  // Pass 3: Parallel Opportunity Detection
  let pass3: Pass3Result = {
    dag: { steps: [], parallelism: [] },
  }

  if (passes.includes(3)) {
    const sp = showSpinner ? createSpinner("Compiling — Pass 3: parallel extraction...") : null
    if (!sp) log.info("Pass 3: Parallel Opportunity Detection")
    try {
      const p3Log = new ConversationLog(path.join(compileLogDir, "pass3.jsonl"))
      const p3Provider = new LoggingProvider(provider, p3Log)
      pass3 = await runPass3(compiledSkill, pass1.scr, opts.tcp, p3Provider)
      await p3Log.finalize()
      const parallelismSection = generateParallelismSection(pass3.dag)
      if (parallelismSection) {
        compiledSkill += parallelismSection
      }
      if (sp) sp.succeed(`Pass 3: ${pass3.dag.steps.length} DAG nodes, ${pass3.dag.parallelism.length} groups`)
    } catch (err) {
      sp?.fail("Pass 3: failed")
      throw err
    }
    log.info(`  DAG nodes: ${pass3.dag.steps.length}`)
    log.info(`  Parallel groups: ${pass3.dag.parallelism.length}`)
    log.info(`  Guidance injected: ${pass3.dag.parallelism.length > 0 ? "yes" : "no"}`)
  }

  // Guard
  const guard = validateGuard(opts.skillContent, compiledSkill)
  if (!guard.passed) {
    log.warn(`Guard failed: ${guard.violations.join("; ")}`)
  }

  const durationMs = performance.now() - startMs

  return {
    skillName,
    model: opts.model,
    harness: opts.harness,
    compiledAt: new Date().toISOString(),
    pass1,
    pass2,
    pass3,
    compiledSkill,
    guardPassed: guard.passed,
    guardViolations: guard.violations,
    tokens: totalTokens,
    passes,
    costUsd: 0,
    durationMs,
  }
}

/**
 * Write a compiled skill variant to disk.
 */
export async function writeVariant(result: CompilationResult): Promise<string> {
  const safeModel = result.model.replace(/\//g, "--")
  const passTag = toPassTag(result.passes)
  const dir = path.join(AOT_COMPILE_DIR, result.harness, safeModel, result.skillName, passTag)
  await mkdir(dir, { recursive: true })

  await writeFile(path.join(dir, "SKILL.md"), result.compiledSkill)

  const workflowDagPath = path.join(dir, "workflow-dag.md")
  const workflowDagDocument = generateWorkflowDagDocument(result.pass3.dag)
  if (workflowDagDocument) {
    await writeFile(workflowDagPath, workflowDagDocument)
  } else {
    await rm(workflowDagPath, { force: true })
  }

  const plan = {
    skillName: result.skillName,
    model: result.model,
    harness: result.harness,
    compiledAt: result.compiledAt,
    scr: result.pass1.scr,
    gaps: result.pass1.gaps,
    dependencies: result.pass2.dependencies,
    pass3: {
      hasParallelism: result.pass3.dag.parallelism.length > 0,
      dagNodeCount: result.pass3.dag.steps.length,
      parallelGroupCount: result.pass3.dag.parallelism.length,
      dag: result.pass3.dag,
    },
    guardPassed: result.guardPassed,
    guardViolations: result.guardViolations,
  }
  await writeFile(path.join(dir, "compilation-plan.json"), JSON.stringify(plan, null, 2))

  await writeFile(path.join(dir, "env-setup.sh"), result.pass2.bindingScript)

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
  await writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2))

  log.info(`Variant written to ${dir}`)
  return dir
}
