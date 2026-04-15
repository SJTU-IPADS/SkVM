/**
 * PinchBench Importer
 *
 * Converts PinchBench task markdown files into SkVM native bench task format.
 * This is a one-time conversion tool — the core bench framework never reads
 * PinchBench files directly.
 *
 * Usage:
 *   bun run skvm bench --import=pinchbench --pinchbench=~/Projects/pinchbench
 */

import path from "node:path"
import { readdir } from "node:fs/promises"
import type { EvalCriterion } from "../../core/types.ts"
import type { BenchTask } from "../types.ts"
import { writeTask, addFixtureFile } from "../loader.ts"
import { createLogger } from "../../core/logger.ts"
import { TASK_FILE_DEFAULTS } from "../../core/ui-defaults.ts"

const log = createLogger("import-pinchbench")

// ---------------------------------------------------------------------------
// YAML Frontmatter Parser (minimal, no dependency)
// ---------------------------------------------------------------------------

interface PinchBenchFrontmatter {
  id: string
  name: string
  category: string
  grading_type: "automated" | "llm_judge" | "hybrid"
  timeout_seconds: number
  workspace_files?: WorkspaceFileSpec[]
  grading_weights?: { automated: number; llm_judge: number }
  multi_session?: boolean
}

interface WorkspaceFileSpec {
  path?: string
  content?: string
  source?: string
  dest?: string
}

function parseFrontmatter(raw: string): { frontmatter: PinchBenchFrontmatter; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) throw new Error("No YAML frontmatter found")

  const yamlStr = match[1]!
  const body = match[2]!

  const fm: Record<string, unknown> = {}
  const lines = yamlStr.split("\n")
  let currentKey = ""
  let currentArray: unknown[] | null = null
  let currentObject: Record<string, unknown> | null = null
  let arrayItemObject: Record<string, unknown> | null = null
  let inMultilineString = false
  let multilineContent = ""
  let multilineKey = ""

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    if (inMultilineString) {
      if (line.match(/^\S/) || (line.match(/^  \S/) && !line.startsWith("    "))) {
        if (arrayItemObject) {
          arrayItemObject[multilineKey] = multilineContent.trimEnd()
        }
        inMultilineString = false
        multilineContent = ""
      } else {
        const stripped = line.replace(/^      |^    /, "")
        multilineContent += stripped + "\n"
        continue
      }
    }

    const topMatch = line.match(/^(\w[\w_]*):\s*(.*)$/)
    if (topMatch) {
      if (arrayItemObject && currentArray) {
        currentArray.push(arrayItemObject)
        arrayItemObject = null
      }
      if (currentArray && currentKey) {
        fm[currentKey] = currentArray
        currentArray = null
      }
      if (currentObject && currentKey) {
        fm[currentKey] = currentObject
        currentObject = null
      }

      currentKey = topMatch[1]!
      const val = topMatch[2]!.trim()

      if (val === "" || val === "[]") {
        if (val === "[]") fm[currentKey] = []
        const nextLine = lines[i + 1]
        if (nextLine && nextLine.trim().startsWith("-")) {
          currentArray = []
        } else if (nextLine && nextLine.match(/^  \w/)) {
          currentObject = {}
        }
      } else {
        fm[currentKey] = parseYamlValue(val)
      }
      continue
    }

    const nestedMatch = line.match(/^  (\w[\w_]*):\s*(.*)$/)
    if (nestedMatch && !currentArray) {
      if (!currentObject) currentObject = {}
      currentObject[nestedMatch[1]!] = parseYamlValue(nestedMatch[2]!.trim())
      continue
    }

    if (line.match(/^  - /) && currentArray !== null) {
      if (arrayItemObject) currentArray.push(arrayItemObject)

      const inlineMatch = line.match(/^  - (.+)$/)
      if (inlineMatch && !inlineMatch[1]!.includes(":")) {
        currentArray.push(parseYamlValue(inlineMatch[1]!.trim()))
        arrayItemObject = null
        continue
      }

      arrayItemObject = {}
      const firstPropMatch = line.match(/^  - (\w[\w_]*):\s*(.*)$/)
      if (firstPropMatch) {
        const val = firstPropMatch[2]!.trim()
        if (val === "|") {
          inMultilineString = true
          multilineKey = firstPropMatch[1]!
          multilineContent = ""
        } else {
          arrayItemObject[firstPropMatch[1]!] = parseYamlValue(val)
        }
      }
      continue
    }

    const arrayObjMatch = line.match(/^    (\w[\w_]*):\s*(.*)$/)
    if (arrayObjMatch && arrayItemObject) {
      const val = arrayObjMatch[2]!.trim()
      if (val === "|") {
        inMultilineString = true
        multilineKey = arrayObjMatch[1]!
        multilineContent = ""
      } else {
        arrayItemObject[arrayObjMatch[1]!] = parseYamlValue(val)
      }
      continue
    }

    if (nestedMatch && currentObject === null && currentKey) {
      currentObject = {}
      currentObject[nestedMatch[1]!] = parseYamlValue(nestedMatch[2]!.trim())
      continue
    }
  }

  if (inMultilineString && arrayItemObject) {
    arrayItemObject[multilineKey] = multilineContent.trimEnd()
  }
  if (arrayItemObject && currentArray) currentArray.push(arrayItemObject)
  if (currentArray && currentKey) fm[currentKey] = currentArray
  if (currentObject && currentKey) fm[currentKey] = currentObject

  return { frontmatter: fm as unknown as PinchBenchFrontmatter, body }
}

function parseYamlValue(val: string): string | number | boolean {
  if (val === "true") return true
  if (val === "false") return false
  if (/^-?\d+$/.test(val)) return parseInt(val, 10)
  if (/^-?\d+\.\d+$/.test(val)) return parseFloat(val)
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1)
  }
  return val
}

// ---------------------------------------------------------------------------
// Section Extraction
// ---------------------------------------------------------------------------

function extractSections(body: string) {
  const sections: Record<string, string> = {}
  const parts = body.split(/^## /m)

  for (const part of parts) {
    if (!part.trim()) continue
    const newlineIdx = part.indexOf("\n")
    if (newlineIdx === -1) continue
    const heading = part.slice(0, newlineIdx).trim().toLowerCase()
    const content = part.slice(newlineIdx + 1).trim()

    if (heading.includes("prompt")) sections.prompt = content
    else if (heading.includes("automated checks")) sections.automatedChecks = content
    else if (heading.includes("llm judge rubric")) sections.llmJudgeRubric = content
  }

  return sections
}

function extractPythonCode(section: string): string | undefined {
  const match = section.match(/```python\n([\s\S]*?)```/)
  return match?.[1]?.trim()
}

// ---------------------------------------------------------------------------
// Eval Criteria Builder
// ---------------------------------------------------------------------------

function buildEvalCriteria(
  gradingType: string,
  gradeCode: string | undefined,
  rubric: string,
  gradingWeights?: { automated: number; llmJudge: number },
): EvalCriterion[] {
  const criteria: EvalCriterion[] = []
  const isHybrid = gradingType === "hybrid"
  const totalWeight = gradingWeights ? gradingWeights.automated + gradingWeights.llmJudge : 1.0

  if ((gradingType === "automated" || isHybrid) && gradeCode) {
    criteria.push({
      method: "custom" as const,
      evaluatorId: "python-grade",
      id: "custom",
      name: "Automated Grade",
      weight: isHybrid && gradingWeights ? gradingWeights.automated / totalWeight : 1.0,
      payload: gradeCode,
    })
  }

  if (gradingType === "llm_judge" || isHybrid) {
    criteria.push({
      method: "llm-judge" as const,
      rubric: rubric || "Evaluate the agent's performance on this task.",
      maxScore: 1.0,
      id: "llm-judge",
      name: "Quality Judge",
      weight: isHybrid && gradingWeights ? gradingWeights.llmJudge / totalWeight : 1.0,
    })
  }

  if (criteria.length === 0) {
    criteria.push({
      method: "llm-judge" as const,
      rubric: "Evaluate whether the agent successfully completed the requested task.",
      maxScore: 1.0,
      id: "llm-judge",
      name: "Quality Judge",
      weight: 1.0,
    })
  }

  return criteria
}

// ---------------------------------------------------------------------------
// Import Entry Point
// ---------------------------------------------------------------------------

/**
 * Import all PinchBench tasks from a pinchbench repo directory
 * into SkVM native bench task format.
 */
export async function importPinchBench(
  pinchbenchDir: string,
  opts?: { excludedTasks?: string[] },
): Promise<{ imported: string[]; skipped: string[]; errors: string[] }> {
  const tasksDir = path.join(pinchbenchDir, "tasks")
  const assetsDir = path.join(pinchbenchDir, "assets")
  const excluded = new Set(opts?.excludedTasks ?? [])

  const files = await readdir(tasksDir)
  const taskFiles = files.filter(f => f.startsWith("task_") && f.endsWith(".md")).sort()

  const imported: string[] = []
  const skipped: string[] = []
  const errors: string[] = []
  const BINARY_EXTS = [".pdf", ".xlsx", ".xls", ".png", ".jpg", ".jpeg", ".gif", ".zip"]

  for (const file of taskFiles) {
    const filePath = path.join(tasksDir, file)
    const raw = await Bun.file(filePath).text()

    try {
      const { frontmatter: fm, body } = parseFrontmatter(raw)

      if (excluded.has(fm.id)) {
        skipped.push(`${fm.id} (excluded)`)
        continue
      }
      if (fm.multi_session) {
        skipped.push(`${fm.id} (multi-session)`)
        continue
      }

      const sections = extractSections(body)
      const gradeCode = extractPythonCode(sections.automatedChecks ?? "")

      // Process workspace files
      const fixtures: Record<string, string> = {}
      const binaryFiles: { dest: string; source: string }[] = []

      if (fm.workspace_files) {
        for (const spec of fm.workspace_files) {
          if (spec.path && spec.content !== undefined) {
            fixtures[spec.path] = spec.content
          } else if (spec.source && spec.dest) {
            const ext = path.extname(spec.source).toLowerCase()
            if (BINARY_EXTS.includes(ext)) {
              binaryFiles.push({ dest: spec.dest, source: path.join(assetsDir, spec.source) })
            } else {
              try {
                fixtures[spec.dest] = await Bun.file(path.join(assetsDir, spec.source)).text()
              } catch (err) {
                log.warn(`Failed to read asset ${spec.source}: ${err}`)
                binaryFiles.push({ dest: spec.dest, source: path.join(assetsDir, spec.source) })
              }
            }
          }
        }
      }

      const gradingType = fm.grading_type === "llm_judge" ? "llm_judge"
        : fm.grading_type === "hybrid" ? "hybrid" : "automated"

      const gradingWeights = fm.grading_weights
        ? { automated: fm.grading_weights.automated, llmJudge: fm.grading_weights.llm_judge }
        : undefined

      const eval_ = buildEvalCriteria(gradingType, gradeCode, sections.llmJudgeRubric ?? "", gradingWeights)

      const benchTask: BenchTask = {
        id: fm.id,
        name: fm.name,
        prompt: sections.prompt ?? "",
        fixtures: Object.keys(fixtures).length > 0 ? fixtures : undefined,
        eval: eval_,
        timeoutMs: (fm.timeout_seconds ?? 120) * 1000,
        maxSteps: TASK_FILE_DEFAULTS.maxSteps,
        category: fm.category,
        gradingType,
        gradingWeights,
        origin: {
          source: "pinchbench",
          repo: "https://github.com/pinchbench/skill",
          file: `tasks/${file}`,
          importedAt: new Date().toISOString(),
        },
      }

      const outDir = await writeTask(benchTask, {})

      // Copy binary fixtures into task's fixtures/ dir
      for (const bf of binaryFiles) {
        try {
          await addFixtureFile(fm.id, bf.dest, bf.source, {})
        } catch (err) {
          log.warn(`Failed to copy fixture ${bf.dest}: ${err}`)
        }
      }

      imported.push(`${fm.id} -> ${outDir}`)
      log.debug(`Imported: ${fm.id}`)
    } catch (err) {
      errors.push(`${file}: ${err}`)
    }
  }

  log.info(`Imported ${imported.length} tasks, skipped ${skipped.length}, errors ${errors.length}`)
  return { imported, skipped, errors }
}
