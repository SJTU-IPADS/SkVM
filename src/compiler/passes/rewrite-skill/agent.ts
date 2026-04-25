import path from "node:path"
import { readdir } from "node:fs/promises"
import type { SCR, TCP, CapabilityGap } from "../../../core/types.ts"
import { LEVEL_ORDER } from "../../../core/types.ts"
import type { LLMProvider } from "../../../providers/types.ts"
import type { Pass1Result, FailureContext } from "../../types.ts"
import { ARTIFACT_DIR } from "../../artifacts.ts"
import { runAgentLoop } from "../../../core/agent-loop.ts"
import { AGENT_TOOLS, createAgentToolExecutor } from "../../../core/agent-tools.ts"
import { extractSCR } from "./extractor.ts"
import { analyzeGaps } from "./gap-analyzer.ts"
import { getPrimitive } from "../../../core/primitives.ts"
import { createLogger } from "../../../core/logger.ts"

const log = createLogger("compiler-agent")

// ---------------------------------------------------------------------------
// WorkDir File Pre-loading
// ---------------------------------------------------------------------------

interface WorkDirFile {
  path: string
  content: string
}

const TEXT_EXTENSIONS = new Set([".md", ".json", ".py", ".sh", ".txt", ".yaml", ".yml", ".toml"])
const SKIP_FILES = new Set(["compilation-plan.json", "meta.json", "env-setup.sh", "jit-candidates.json"])
const SKIP_DIRS = new Set([ARTIFACT_DIR])
const MAX_FILE_SIZE = 10 * 1024   // 10KB per bundle file
const MAX_TOTAL_SIZE = 100 * 1024 // 100KB total (bundle + profiling artifacts)

/**
 * Read all text files from workDir (excluding SKILL.md and compilation artifacts).
 * When profiling artifacts exist in _profiling/ (eval scripts + conv logs), they get
 * a higher per-file limit (30KB) since they are the primary evidence for understanding
 * model failure patterns.
 * Returns file contents sorted by path for deterministic prompt ordering.
 */
async function readWorkDirFiles(workDir: string): Promise<WorkDirFile[]> {
  const files: WorkDirFile[] = []
  let totalSize = 0
  const PROFILING_FILE_SIZE = 30 * 1024 // 30KB for _profiling/ artifacts

  const entries = await readdir(workDir, { withFileTypes: true, recursive: true })

  for (const entry of entries) {
    if (!entry.isFile()) continue

    const fullPath = path.join(entry.parentPath ?? workDir, entry.name)
    const relPath = path.relative(workDir, fullPath)

    // Skip SKILL.md — provided via skillContent parameter
    if (relPath === "SKILL.md") continue

    // Skip compilation artifacts from previous runs (top-level metadata files
    // and the _artifacts directory written by the orchestrator).
    if (SKIP_FILES.has(relPath)) continue
    if (relPath.split(path.sep).some((seg) => SKIP_DIRS.has(seg))) continue

    // Skip non-text files (but allow .jsonl under _profiling/)
    const ext = path.extname(entry.name).toLowerCase()
    const isProfiling = relPath.startsWith("_profiling/")
    if (ext === ".jsonl" && !isProfiling) continue
    if (ext !== ".jsonl" && !TEXT_EXTENSIONS.has(ext)) continue

    // Size checks: profiling artifacts get a higher limit
    const file = Bun.file(fullPath)
    const size = file.size
    const maxSize = isProfiling ? PROFILING_FILE_SIZE : MAX_FILE_SIZE
    if (size > maxSize) continue
    if (totalSize + size > MAX_TOTAL_SIZE) break

    const content = await file.text()
    files.push({ path: relPath, content })
    totalSize += size
  }

  files.sort((a, b) => a.path.localeCompare(b.path))
  log.debug(`Pre-loaded ${files.length} files from workDir (${(totalSize / 1024).toFixed(1)}KB)`)
  return files
}

// ---------------------------------------------------------------------------
// Gap Details Formatter (inlined into prompt instead of a tool)
// ---------------------------------------------------------------------------

function formatAllGapDetails(
  gaps: CapabilityGap[],
  scr: SCR,
  tcp: TCP,
  failureContext?: FailureContext,
): string {
  if (gaps.length === 0) return ""

  const sections: string[] = [`## Gap Details\n`]

  for (const gap of gaps) {
    const primitive = getPrimitive(gap.primitiveId)
    if (!primitive) continue

    const lines: string[] = [
      `### ${gap.primitiveId}: ${primitive.description}`,
      ``,
      `**Gap**: ${gap.gapType} — requires ${gap.requiredLevel}, model has ${gap.modelLevel}`,
      `**Purpose**: ${gap.purposeId}`,
    ]

    // 1. SCR evidence: what the skill needs this primitive for
    const purpose = scr.purposes.find(p => p.id === gap.purposeId)
    const scrPrimitive = purpose?.currentPath.primitives.find(p => p.id === gap.primitiveId)
    if (scrPrimitive?.evidence) {
      lines.push(``, `#### 1. Skill Requirement`)
      lines.push(`The skill needs ${gap.primitiveId} at ${scrPrimitive.minLevel} because:`)
      lines.push(`> ${scrPrimitive.evidence}`)
    }

    // 2. Profiling evidence: what the model actually does
    const tcpDetail = tcp.details.find(d => d.primitiveId === gap.primitiveId)
    if (tcpDetail) {
      lines.push(``, `#### 2. Profiling Evidence`)
      for (const lr of tcpDetail.levelResults) {
        const status = lr.passed ? "PASS" : "FAIL"
        lines.push(`- ${lr.level}: ${status} (${lr.passCount}/${lr.totalCount})`)
        if (lr.testDescription) {
          lines.push(`  Test: ${lr.testDescription}`)
        }
        if (!lr.passed && lr.failureDetails.length > 0) {
          for (const detail of lr.failureDetails.slice(0, 3)) {
            lines.push(`  Failure: ${detail.slice(0, 200)}`)
          }
        }
      }

      // Profiling artifacts: conv logs + eval scripts for failed levels
      const artifactPaths: string[] = []
      for (const lr of tcpDetail.levelResults) {
        if (!lr.failureArtifacts?.length || !tcpDetail.convLogDir) continue
        for (const artifact of lr.failureArtifacts) {
          const evalRel = `_profiling/${gap.primitiveId}/${path.relative(tcpDetail.convLogDir, artifact.evalScript)}`
          const convRel = `_profiling/${gap.primitiveId}/${path.relative(tcpDetail.convLogDir, artifact.convLog)}`
          artifactPaths.push(`- Eval script: ${evalRel}`)
          artifactPaths.push(`- Conv log: ${convRel}`)
        }
      }
      if (artifactPaths.length > 0) {
        lines.push(``, `#### Profiling Artifacts`)
        lines.push(`If included in the Bundled Files section above, study them directly. Otherwise use \`read_file\`:`)
        lines.push(...artifactPaths)
      }
    }

    // Runtime failure patterns if available (JIT recompilation)
    if (failureContext) {
      const relevantPatterns = failureContext.patterns.filter(
        p => p.category === "tool-error" || p.category === "logic-error"
      )
      if (relevantPatterns.length > 0) {
        lines.push(``, `#### Runtime Failure Patterns`)
        for (const pattern of relevantPatterns) {
          lines.push(`- ${pattern.toolName} (${pattern.frequency}x, ${pattern.category})`)
          for (const err of pattern.sampleErrors.slice(0, 2)) {
            lines.push(`  Error: ${err.slice(0, 150)}`)
          }
        }
      }
    }

    // 3. Degradation guidance from primitive definition
    lines.push(``, `#### 3. Degradation Guidance`)
    const levelPairs: Array<"L3->L2" | "L2->L1"> = []
    if (LEVEL_ORDER[gap.requiredLevel] >= 3 && LEVEL_ORDER[gap.modelLevel] < 3) {
      levelPairs.push("L3->L2")
    }
    if (LEVEL_ORDER[gap.requiredLevel] >= 2 && LEVEL_ORDER[gap.modelLevel] < 2) {
      levelPairs.push("L2->L1")
    }
    if (levelPairs.length === 0) {
      lines.push(`No standard degradation path for this gap.`)
    }
    for (const pair of levelPairs) {
      const guidance = primitive.degradations[pair]
      if (guidance) {
        lines.push(`- ${pair}: ${guidance}`)
      } else {
        lines.push(`- ${pair}: No feasible degradation — this capability cannot be downgraded at this level. Consider leaving unchanged.`)
      }
    }

    // 4. Level descriptions for reference
    lines.push(``, `#### 4. Level Descriptions`)
    lines.push(`- L1: ${primitive.levels.L1}`)
    lines.push(`- L2: ${primitive.levels.L2}`)
    lines.push(`- L3: ${primitive.levels.L3}`)

    sections.push(lines.join("\n"))
  }

  return sections.join("\n\n")
}

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(tcp: TCP): string {
  return `You are a SkVM pass-1 compensation editor.

Your job is not to generally improve the writing.
Your job is to reduce the mismatch between:
- what the skill requires from the agent, and
- what the target model can reliably do, primitive by primitive.

You are compiling a skill against a target capability profile.
That means: for each justified edit, lower the primitive capability demand of the skill while preserving the skill's intent, structure, and main workflow.

## Target Model
- Model: ${tcp.model}
- Harness: ${tcp.harness}

## Compilation Semantics
A skill imposes capability demands through its instructions.
A model has limited capability supply, represented by primitive levels.
A capability gap means the current wording of the skill likely asks the model to do something above its reliable level.

Your task is to edit the skill so that the demanded primitive level is reduced toward the model's available level.

Think in this chain:
purpose -> primitive -> required level -> model level -> degradation direction -> local text edit

An edit is good only if it makes that chain more executable for this model.
An edit is bad if it merely adds explanation, verbosity, or extra process without lowering primitive demand.

## Core Objective
Prefer the smallest set of local edits that reduce capability demand.
Do not try to "cover every gap".
Do not optimize for sounding clearer in general.
Optimize for making the skill executable by this model with less branching, less hidden state, and less multi-step inference.

## Priority Rules
- Prioritize gaps marked as missing over weak gaps.
- Prioritize larger level mismatches over smaller ones.
- Prioritize edits that directly lower primitive demand over edits that only add hints.
- If a gap cannot be mapped to a specific local span in the skill, skip it.
- If the degradation guidance does not imply a concrete wording change, skip it.

## How To Interpret Primitive Gaps
Treat each primitive gap as a demand mismatch, not as a topic label.

Examples of valid compensation logic:
- If the skill currently requires conditional recovery or branching beyond the model's planning level, replace that local instruction with a fixed linear default path.
- If the skill currently requires multi-file or multi-step tool coordination beyond the model's tool-use level, rewrite that local instruction so the agent performs one explicit operation at a time.
- If the skill currently requires complex generation patterns above the model's generation level, replace them with simpler explicit patterns, smaller outputs, or more concrete templates.

Do not copy these examples literally. Apply the same reasoning to the actual primitive and degradation guidance provided in the task.

## What You May Do
- Rephrase a local sentence so it requires less reasoning, planning, or tool coordination.
- Replace an open-ended instruction with one explicit default path.
- Add at most 1 short clarifying sentence when it directly lowers ambiguity tied to a listed primitive gap.
- Simplify execution patterns, output shape, or file interaction when that lowers primitive demand.

## What You Must NOT Do
- Do not add new sections or headings.
- Do not remove checklist items, quality criteria, or validation requirements unless they are explicitly optional in the original skill.
- Do not narrow the task scope, output scope, or required coverage to compensate for a capability gap.
- Do not reduce the number of workflow steps, bullet items, numbered items, or other enumerated items.
- Do not rewrite the document wholesale.
- Do not turn concise instructions into long procedures or checklists.
- Do not add generic advice like "verify carefully", "double-check", "read first", or "retry if needed".
- Do not add process that increases primitive demand, such as extra branching, extra passes, extra rewrites, or unnecessary verification loops.
- Do not edit more than 3 local regions.
- Do not mention tools the agent does not have. In this compiler run, the available tools are: read_file, write_file, execute_command.

## Gap Mapping Rule
For each candidate edit, explicitly validate all of the following before writing:
1. Which purpose does this edit support?
2. Which primitive is being compensated?
3. What is the current required level, and what level does the model have?
4. What local text span is creating that demand?
5. Which degradation direction applies?
6. How exactly does the new wording reduce the primitive demand?

If you cannot answer all six, do not make the edit.

## Structural Constraints
Preserve:
- YAML frontmatter
- all markdown headings
- all original code blocks, unless a specific degradation requires a local simplification inside one
- the overall workflow shape of the skill

## Workflow
The full SKILL.md and bundled files are already provided.
Do not reread provided files unless one specific detail is missing.

1. Triage the listed gaps by severity and editability.
2. Map each viable gap to one concrete local text span.
3. Reject edits that increase process more than they reduce primitive demand.
4. Keep only the highest-confidence local edits.
5. If no high-confidence edit survives, leave the skill unchanged.
6. Otherwise write the full edited SKILL.md once via write_file and stop.

## Quality Bar
- Reduce capability demand, not just ambiguity.
- Favor linear defaults over branches.
- Favor explicit local actions over inferred strategy.
- Favor smaller output, simpler structure, and fewer moving parts when aligned with the degradation guidance.
- Keep added rationale extremely short.
- When in doubt, preserve the original text.

## Task-Contract Preservation
A compensation edit must preserve the task contract of the skill.

Do not improve executability by removing or weakening:
- correctness checks
- quality bars
- acceptance criteria
- checklist items
- required outputs
- coverage requirements
- comparison dimensions
- safety or validation constraints

A smaller or simpler skill is NOT better if it asks the agent to do less, check less, or justify less.

Valid compensation reduces capability demand while preserving task scope and output expectations.
Invalid compensation reduces task scope, output quality, or evaluation coverage in order to appear easier.`
}


// ---------------------------------------------------------------------------
// Initial User Message
// ---------------------------------------------------------------------------

function buildInitialMessage(
  scr: SCR,
  gaps: CapabilityGap[],
  tcp: TCP,
  skillContent: string,
  bundledFiles: WorkDirFile[],
  failureContext?: FailureContext,
): string {
  const sections: string[] = []

  sections.push(`# Compilation Task

EDIT the existing SKILL.md for model **${tcp.model}** on harness **${tcp.harness}**.
All file contents are provided below. Plan your edits based on the gap details, then write the edited SKILL.md.`)

  // Inline SKILL.md content
  sections.push(`\n## Current SKILL.md\n\n\`\`\`markdown\n${skillContent}\n\`\`\``)

  // Inline bundled files
  if (bundledFiles.length > 0) {
    sections.push(`\n## Bundled Files`)
    for (const f of bundledFiles) {
      const ext = path.extname(f.path).replace(".", "") || "text"
      sections.push(`\n### ${f.path}\n\n\`\`\`${ext}\n${f.content}\n\`\`\``)
    }
  }

  // Gap summary table
  if (gaps.length === 0) {
    sections.push(`\nNo capability gaps detected — the model meets all skill requirements. No edits needed.`)
  } else {
    sections.push(`\n## Capability Gaps (${gaps.length})

| Primitive | Required | Model Has | Gap Type | Purpose | Skill Uses It For |
|-----------|----------|-----------|----------|---------|-------------------|`)
    for (const gap of gaps) {
      const purpose = scr.purposes.find(p => p.id === gap.purposeId)
      const prim = purpose?.currentPath.primitives.find(p => p.id === gap.primitiveId)
      const evidence = prim?.evidence ? prim.evidence.slice(0, 80) : "—"
      sections.push(`| ${gap.primitiveId} | ${gap.requiredLevel} | ${gap.modelLevel} | ${gap.gapType} | ${gap.purposeId} | ${evidence} |`)
    }

    // Inline gap details
    sections.push("")
    sections.push(formatAllGapDetails(gaps, scr, tcp, failureContext))

    sections.push(`
For each gap above, determine:
1. Where in the skill text does this primitive get exercised?
2. What specific failure pattern does the model exhibit in profiling?
3. Does the degradation guidance suggest a concrete wording change?

Only edit for gaps where all three answers point to a specific, localized change.`)
  }

  // Failure context summary for JIT
  if (failureContext) {
    sections.push(`\n## Runtime Failure Context (JIT Recompilation)
- Classification: ${failureContext.classification}
- Failure rate: ${(failureContext.failureRate * 100).toFixed(0)}% over ${failureContext.runCount} runs
- Patterns: ${failureContext.patterns.length}
- Recovery traces: ${failureContext.recoveryTraces.length}`)
  }

  return sections.join("\n")
}

// ---------------------------------------------------------------------------
// Agentic Pass 1
// ---------------------------------------------------------------------------

/**
 * Pass 1 via compiler agent: an agentic loop that explores the skill directory,
 * analyzes gaps, plans edits, and writes compiled files to disk.
 *
 * The agent operates on real files in `workDir` (pre-populated with skill files).
 */
export async function runPass1Agentic(
  skillContent: string,
  tcp: TCP,
  provider: LLMProvider,
  workDir: string,
  failureContext?: FailureContext,
): Promise<Pass1Result> {
  const scr = await extractSCR(skillContent, provider)
  log.info(`SCR: ${scr.purposes.length} purposes`)

  const gaps = analyzeGaps(scr, tcp)
  log.info(`Gaps: ${gaps.length}`)

  if (gaps.length === 0) {
    return { scr, gaps, compiledSkill: skillContent }
  }

  const bundledFiles = await readWorkDirFiles(workDir)
  const system = buildSystemPrompt(tcp)
  const initialMessage = buildInitialMessage(scr, gaps, tcp, skillContent, bundledFiles, failureContext)
  const executeTool = createAgentToolExecutor(workDir, { requireReadBeforeWrite: false })

  const loopResult = await runAgentLoop(
    {
      provider,
      model: tcp.model,
      tools: AGENT_TOOLS,
      executeTool,
      system,
      maxIterations: 15,
      timeoutMs: 300_000,
      maxTokens: 32768,
      temperature: 0,
    },
    [{ role: "user", content: initialMessage }],
  )

  const compiledSkillFile = Bun.file(path.join(workDir, "SKILL.md"))
  let compiledSkill: string
  if (await compiledSkillFile.exists()) {
    compiledSkill = await compiledSkillFile.text()
  } else {
    log.warn("Compiler agent did not write SKILL.md — using original")
    compiledSkill = skillContent
  }

  log.info(`Agent completed in ${loopResult.iterations} iterations`)

  return { scr, gaps, compiledSkill }
}
