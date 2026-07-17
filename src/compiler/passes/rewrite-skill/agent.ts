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
import { deriveDirectives } from "./directives.ts"
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

export function buildSystemPrompt(tcp: TCP): string {
  return `You are the SkVM AOT compiler's rewrite pass (pass 1).

INPUT: a skill document (SKILL.md), the target model's capability profile, a capability-gap analysis with profiling evidence, and compilation directives DERIVED from that profile.
OUTPUT: a compiled SKILL.md optimized for this specific target model.

## Target
- Model: ${tcp.model}
- Harness: ${tcp.harness}

## Compilation calculus
A skill imposes capability demands; the target model has a measured capability supply. Your job is to reshape the skill so every demand lands at or below the model's reliable level:
- Where the model is BELOW a required level (a gap): compensate by inlining the exact artifact — command, lookup table, ready-to-run template — so the model copies instead of composing.
- Where the model is at L3: delete how-to teaching for that primitive — the model already knows how. Keep any domain facts, parameters, or requirements that teaching carried; capability does not substitute for task knowledge.
How aggressively to cut overall is NOT universal — it depends on this model's profile. The task message carries a size budget and model-derived directives computed from the capability analysis; follow them exactly. For a strong profile that means light, gap-targeted edits that respect the original structure; for a weak profile it means deep distillation into a compact execution card.

## Model-derived directives
The task message lists directives derived from this model's measured weaknesses, each with its evidence. Treat every directive as a hard requirement for the compiled skill. Do not add compensations for weaknesses the profile does not show — unneeded rules are noise for this model.

## Delete (scaled by the size budget)
- Background, rationale, education, "why this matters".
- Every "ask the user / wait for confirmation / propose a plan before acting" step — compiled skills run HEADLESS in an automated harness; there is no user mid-task, and a confirmation step stalls the run.
- Alternatives and option menus — pick one default path and state only it.
- How-to teaching for primitives the capability table shows at L3 (keep domain facts and requirements embedded in it).
- Restatements of the task, generic advice ("be careful", "double-check"), decorative structure.
You may restructure freely: drop or rename headings, remove code blocks, reorder sections. The guard does not require structural identity — only the task contract, frontmatter, and size budget.

## Preserve: the task contract
Never drop (distilled phrasing is fine):
- required outputs: file names, formats, schemas;
- correctness criteria and validation requirements;
- coverage requirements (what must be handled — not how verbosely it was explained);
- references to bundled files that actually exist (scripts/, templates/, ...). Never invent a file reference.
The card itself must NOT contain example output filenames or report formats of its own — a model will follow the card's example filename instead of the task's required one and misplace otherwise-correct output. Where the original showed an output example, replace it with: "write the output exactly where and how the task prompt specifies".
A smaller skill that asks the agent to produce less, check less, or cover less is NOT a valid compilation.

## Gap-driven decisions
For each listed gap: if profiling evidence shows the model failing a primitive the skill needs, compensate by LOWERING demand — inline the exact command, table, or template so the primitive is exercised at the model's level instead of above it. Apply the degradation guidance attached to each gap. If a gap has no concrete local compensation, ignore it; never add prose about a gap.

## Hard constraints
- Respect the size budget given in the task message.
- Keep YAML frontmatter present; its \`name:\` value must stay exactly the original's.
${tcp.harness === "bare-agent"
    ? "- Mention only tools this harness has: read_file, write_file, execute_command."
    : "- Never name specific agent tools in the compiled skill — the target harness has its own toolset. Phrase actions neutrally: \"write the file\", \"run the command\"."}
- Write the complete compiled SKILL.md in ONE write_file call, then stop. No commentary.`
}


// ---------------------------------------------------------------------------
// Initial User Message
// ---------------------------------------------------------------------------

export function buildInitialMessage(
  scr: SCR,
  gaps: CapabilityGap[],
  tcp: TCP,
  skillContent: string,
  bundledFiles: WorkDirFile[],
  failureContext?: FailureContext,
): string {
  const sections: string[] = []

  // Size budget and rules come from the profile analysis, not from any
  // hard-coded model assumption: a weak profile yields deep distillation
  // (floored at 60 lines so templates fit, capped at 200 to stay a card);
  // a strong profile keeps the original length and gets no extra rules.
  const directives = deriveDirectives(tcp)
  const origLines = skillContent.split("\n").length
  // Floored at 60 lines so templates still fit and capped at 200 to stay a card —
  // but never above the original, or a 45-line skill on the weakest tier would be
  // handed a 60-line budget while the rationale above it says "distill deeply".
  const sizeBudget = directives.tier === "keep"
    ? origLines
    : Math.min(origLines, Math.max(60, Math.min(200, Math.ceil(origLines * directives.sizeBudgetFraction))))

  sections.push(`# Compilation Task

COMPILE the SKILL.md below for model **${tcp.model}** on harness **${tcp.harness}**.
All file contents are provided. Decide what this model actually needs, then write the compiled SKILL.md.

## Size budget (derived from capability profile)
${directives.budgetRationale}.
The original is ${origLines} lines; the compiled SKILL.md must be **at most ${sizeBudget} lines**.`)

  // Model-derived directives: the profile-conditional rules the compiled
  // skill must obey. Empty for strong profiles by design.
  if (directives.rules.length > 0) {
    sections.push(`\n## Model-Derived Directives (from capability profile)
${directives.rules.map((r) => `- ${r.directive}\n  [evidence: ${r.evidence}]`).join("\n")}`)
  } else {
    sections.push(`\n## Model-Derived Directives (from capability profile)
None — the profile shows no systematic weaknesses. Make only gap-targeted edits and preserve the original structure.`)
  }

  // Capability table: strengths tell the compiler what guidance to DELETE,
  // weaknesses what to compensate with templates.
  const byLevel: Record<string, string[]> = { L3: [], L2: [], L1: [], L0: [] }
  for (const [prim, level] of Object.entries(tcp.capabilities)) byLevel[level]?.push(prim)
  sections.push(`\n## Target Model Capability Table
- L3 (reliable — delete how-to teaching for these; keep domain facts): ${byLevel.L3!.join(", ") || "—"}
- L2: ${byLevel.L2!.join(", ") || "—"}
- L1 (weak — compensate with exact commands/templates): ${byLevel.L1!.join(", ") || "—"}
- L0 (failing — route around entirely): ${byLevel.L0!.join(", ") || "—"}`)

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
    sections.push(`\nNo capability gaps detected — the model meets every level this skill requires, so compensation templates are unnecessary. Cleanup still is: apply the size budget and the model-derived directives, delete headless-hostile steps (confirmation prompts, option menus), and remove content that would mislead the model away from the task prompt's requirements. If after that the original is already optimal, write it back unchanged.`)
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
Use the gaps to decide which exact commands, tables, or templates to inline — those carry the knowledge this model lacks. Everything not needed for a gap or for the task contract is a deletion candidate. Then write the complete compiled SKILL.md (one write_file call).`)
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
  failureContext: FailureContext | undefined,
  timeoutMs: number,
): Promise<Pass1Result> {
  const scr = await extractSCR(skillContent, provider)
  log.info(`SCR: ${scr.purposes.length} purposes`)

  const gaps = analyzeGaps(scr, tcp)
  log.info(`Gaps: ${gaps.length}`)

  // No early return on zero gaps: "no capability gap" does not mean "nothing
  // to compile". With an early return, skills whose content actively harms a
  // fully-capable model (misleading examples, verbose noise) pass through
  // verbatim and the compiled variant inherits the original's failures — the
  // cleanup never runs. With zero gaps the agent still applies the size
  // budget, the derived directives, and the universal cleanup rules.
  //
  // What bounds the downside is the guard VERDICT, not the guard itself: a
  // failed guard is recorded on the variant's meta and logged, but nothing here
  // rolls the variant back, so a consumer that ignores `guardPassed` will run a
  // rejected artifact. Treat the verdict as load-bearing when consuming a
  // compiled variant.

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
      timeoutMs,
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
