import { z } from "zod"
import type { LLMProvider } from "../../providers/types.ts"
import { extractStructured } from "../../providers/structured.ts"
import { isProviderError } from "../../providers/errors.ts"
import type { SCR, TCP, WorkflowDAG, WorkflowStep, ParallelismAnnotation } from "../../core/types.ts"
import { WorkflowStepSchema } from "../../core/types.ts"
import type { Pass3Result } from "../types.ts"
import { createLogger } from "../../core/logger.ts"

const log = createLogger("pass3")

const ParallelismKind = z.enum(["dlp", "ilp", "tlp"])
type ParallelismKindValue = z.infer<typeof ParallelismKind>

const ParallelGroupSchema = z.object({
  type: ParallelismKind.default("tlp"),
  stepIds: z.array(z.string()).min(1),
  reason: z.string().default(""),
  mechanism: z.string().default(""),
})

const Pass3PlanSchema = z.object({
  hasParallelism: z.boolean(),
  reasoning: z.string().default(""),
  steps: z.array(WorkflowStepSchema).default([]),
  parallelGroups: z.array(ParallelGroupSchema).default([]),
})

interface RawParallelGroup {
  type?: ParallelismKindValue
  stepIds: string[]
  reason?: string
  mechanism?: string
}

export async function runPass3(
  skillContent: string,
  scr: SCR,
  tcp: TCP,
  provider: LLMProvider,
  bundleFiles?: Map<string, string>,
): Promise<Pass3Result> {
  void tcp
  void bundleFiles

  try {
    const { result } = await extractStructured({
      provider,
      schema: Pass3PlanSchema,
      schemaName: "pass3_parallel_plan",
      schemaDescription: "Classified parallelism plan (DLP/ILP/TLP) for a skill workflow",
      system: buildSystemPrompt(),
      prompt: buildUserPrompt(skillContent, scr),
      maxRetries: 2,
      maxTokens: 4000,
    })

    const dag = normalizePlan(result)
    log.info(
      `Parallel groups: ${dag.parallelism.length} (dlp=${countKind(dag, "dlp")}, ilp=${countKind(dag, "ilp")}, tlp=${countKind(dag, "tlp")}), DAG steps: ${dag.steps.length}`,
    )
    return { dag }
  } catch (err) {
    // Provider outages must surface — otherwise you silently get a compile
    // result that says "no parallelism detected" and can't tell whether
    // that's the real answer or a rate-limit masquerading as one.
    if (isProviderError(err)) throw err
    log.warn(`Pass 3 analysis failed, falling back to no parallelism: ${err}`)
    return { dag: emptyDag() }
  }
}

function countKind(dag: WorkflowDAG, kind: ParallelismKindValue): number {
  return dag.parallelism.filter((group) => group.type === kind).length
}

function buildSystemPrompt(): string {
  return [
    "You analyze a skill document and extract parallelism opportunities hiding in sequential prose.",
    "Classify each opportunity into one of three levels (Hennessy-Patterson mapped to agent workflows):",
    "",
    "- DLP (data-level parallelism): a single step applies the SAME operation to multiple independent",
    "  data items. Example: run the same analysis on each of 15 CSV files. Mechanism: inline language-",
    "  level parallel primitives like 'xargs -P', Python multiprocessing, or Promise.all. A DLP group",
    "  may reference exactly ONE step that iterates over a collection.",
    "",
    "- ILP (instruction-level parallelism): two or more independent steps each need a tool call with",
    "  no data dependency between them, and they can be issued in the SAME LLM turn via batched tool",
    "  use. Example: web_search plus read_file in one turn. An ILP group must contain >= 2 steps.",
    "",
    "- TLP (thread-level parallelism): two or more independent sub-tasks that each require multi-turn",
    "  reasoning and belong in their own sub-agent sessions. Example: debug backend and debug database",
    "  concurrently. A TLP group must contain >= 2 steps.",
    "",
    "Be conservative:",
    "- Prefer false negatives over speculative parallelism.",
    "- Only mark steps as parallel when they can start from the same available inputs and can be merged.",
    "- If the workflow is mostly linear with no iteration or independent tool calls, return hasParallelism=false.",
    "- Do not decompose into many tiny steps. Use 2-6 meaningful workflow nodes.",
    "- Prefer DLP over ILP when the work is homogeneous over a collection.",
    "- Prefer ILP over TLP when each branch is a single tool call (no multi-turn reasoning).",
  ].join("\n")
}

function buildUserPrompt(skillContent: string, scr: SCR): string {
  const purposeSummary = scr.purposes
    .map((purpose) => {
      const primitives = purpose.currentPath.primitives
        .map((prim) => `${prim.id}(${prim.minLevel})`)
        .join(", ")
      return `- ${purpose.id}: ${purpose.description}\n  Primitives: ${primitives}`
    })
    .join("\n")

  return [
    "Analyze this skill for parallelism opportunities and classify each as DLP, ILP, or TLP.",
    "",
    "Return hasParallelism=false when:",
    "- the workflow is linear with no iteration and no independent sibling steps",
    "- branches would mostly duplicate context gathering rather than save time",
    "",
    "When you find parallelism:",
    "- include a small DAG with explicit dependsOn edges (use 2-6 workflow nodes total)",
    "- include one or more parallelGroups, each with:",
    '  - "type": one of "dlp" | "ilp" | "tlp"',
    '  - "stepIds": step IDs this group covers (DLP may be a single iterating step; ILP/TLP must have >= 2)',
    '  - "mechanism": a short phrase naming the concrete parallel primitive (e.g., "xargs -P", ',
    '    "Promise.all", "batched tool_use in one turn", "sub-agent per branch")',
    '  - "reason": why these items are independent',
    "",
    "Skill purposes:",
    purposeSummary,
    "",
    "Skill content:",
    "```markdown",
    skillContent,
    "```",
  ].join("\n")
}

function normalizePlan(plan: {
  hasParallelism: boolean
  reasoning?: string
  steps?: Array<{
    id: string
    description: string
    primitives: string[]
    dependsOn?: string[]
  }>
  parallelGroups?: RawParallelGroup[]
}): WorkflowDAG {
  if (!plan.hasParallelism) return emptyDag()

  const steps = normalizeSteps(plan.steps ?? [])
  if (steps.length < 2) return emptyDag()
  if (hasCycle(steps)) {
    log.warn("Pass 3 returned a cyclic DAG; dropping parallelism")
    return emptyDag()
  }

  const stepIds = new Set(steps.map((step) => step.id))
  const parallelism = (plan.parallelGroups ?? [])
    .map((group) => normalizeParallelGroup(group, stepIds))
    .filter((group): group is ParallelismAnnotation => group !== null)
    .filter((group) => groupIsViable(group, steps))

  if (parallelism.length === 0) return emptyDag()

  return { steps, parallelism }
}

function normalizeSteps(rawSteps: Array<{
  id: string
  description: string
  primitives: string[]
  dependsOn?: string[]
}>): WorkflowStep[] {
  const steps: WorkflowStep[] = []
  const seen = new Set<string>()

  for (const raw of rawSteps) {
    const id = raw.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    steps.push({
      id,
      description: raw.description.trim(),
      primitives: [...new Set(raw.primitives.map((value) => value.trim()).filter(Boolean))],
      dependsOn: [...new Set((raw.dependsOn ?? []).map((value) => value.trim()).filter(Boolean))],
    })
  }

  const validIds = new Set(steps.map((step) => step.id))
  for (const step of steps) {
    step.dependsOn = step.dependsOn.filter((dep) => validIds.has(dep) && dep !== step.id)
  }

  return steps
}

function normalizeParallelGroup(
  group: RawParallelGroup,
  stepIds: Set<string>,
): ParallelismAnnotation | null {
  const uniqueStepIds = [...new Set(group.stepIds.filter((stepId) => stepIds.has(stepId)))]
  const kind: ParallelismKindValue = group.type ?? "tlp"

  // DLP applies to a single iterating step; ILP/TLP need at least two siblings.
  if (kind === "dlp") {
    if (uniqueStepIds.length < 1) return null
  } else {
    if (uniqueStepIds.length < 2) return null
  }

  const reason = group.reason?.trim() ?? ""
  const explicitMechanism = group.mechanism?.trim() ?? ""
  const defaultMechanism = defaultMechanismFor(kind)
  const mechanismBase = explicitMechanism || defaultMechanism
  const mechanism = reason ? `${mechanismBase}: ${reason}` : mechanismBase

  return {
    type: kind,
    steps: uniqueStepIds,
    mechanism,
    fallback: "sequential_execution",
  }
}

function defaultMechanismFor(kind: ParallelismKindValue): string {
  switch (kind) {
    case "dlp":
      return "inline_parallel_primitive"
    case "ilp":
      return "batched_tool_use"
    case "tlp":
      return "sub_agent"
  }
}

/**
 * DLP is intra-step (same op, many data items) and does not require fan-out.
 * ILP/TLP require either shared entry or shared downstream merge to be real.
 */
function groupIsViable(group: ParallelismAnnotation, steps: WorkflowStep[]): boolean {
  if (group.type === "dlp") return group.steps.length >= 1

  if (group.steps.length < 2) return false

  const stepMap = new Map(steps.map((step) => [step.id, step]))
  const dependencyKeys = group.steps.map((stepId) => {
    const deps = stepMap.get(stepId)?.dependsOn ?? []
    return deps.slice().sort().join("|")
  })
  const hasSharedEntry = new Set(dependencyKeys).size === 1

  const hasSharedDownstream = steps.some((step) => {
    const depSet = new Set(step.dependsOn)
    return group.steps.filter((member) => depSet.has(member)).length >= 2
  })

  return hasSharedEntry || hasSharedDownstream
}

function hasCycle(steps: WorkflowStep[]): boolean {
  const stepMap = new Map(steps.map((step) => [step.id, step]))
  const visited = new Set<string>()
  const inStack = new Set<string>()

  function visit(stepId: string): boolean {
    if (inStack.has(stepId)) return true
    if (visited.has(stepId)) return false

    visited.add(stepId)
    inStack.add(stepId)
    const step = stepMap.get(stepId)
    if (step) {
      for (const dep of step.dependsOn) {
        if (visit(dep)) return true
      }
    }
    inStack.delete(stepId)
    return false
  }

  for (const step of steps) {
    if (visit(step.id)) return true
  }

  return false
}

function emptyDag(): WorkflowDAG {
  return { steps: [], parallelism: [] }
}

export function generateParallelismSection(dag: WorkflowDAG): string {
  if (dag.parallelism.length === 0 || dag.steps.length === 0) return ""

  const stepMap = new Map(dag.steps.map((step) => [step.id, step]))
  let section = "\n\n---\n\n"
  section += "**Parallel execution hints:** the compiler identified the following opportunities. Apply each only if your harness supports the indicated primitive; otherwise fall back to sequential execution.\n\n"

  let groupIndex = 0
  for (const group of dag.parallelism) {
    groupIndex += 1
    section += renderGroup(group, groupIndex, stepMap)
  }
  return section
}

function renderGroup(
  group: ParallelismAnnotation,
  index: number,
  stepMap: Map<string, WorkflowStep>,
): string {
  const header = `**Group ${index} — ${group.type.toUpperCase()} (${humanLabel(group.type)}):**\n`
  const bullets = group.steps
    .map((stepId) => {
      const step = stepMap.get(stepId)
      return `- **${stepId}**: ${step?.description ?? "(no description)"}`
    })
    .join("\n")
  const mechanismLine = `\nMechanism: ${group.mechanism}\n`
  const guidance = guidanceFor(group.type)
  return `${header}${bullets}${mechanismLine}${guidance}\n`
}

function humanLabel(kind: ParallelismKindValue): string {
  switch (kind) {
    case "dlp":
      return "same operation over independent data items"
    case "ilp":
      return "independent tool calls batched in one LLM turn"
    case "tlp":
      return "independent sub-tasks dispatched to sub-agents"
  }
}

function guidanceFor(kind: ParallelismKindValue): string {
  switch (kind) {
    case "dlp":
      return "Execute the iteration concurrently using a language-level parallel primitive — shell `xargs -P`, GNU parallel, Python `multiprocessing.Pool`, or JavaScript `Promise.all` — instead of a sequential for-loop. Merge results after all items finish.\n"
    case "ilp":
      return "Issue the listed tool calls together in a single assistant turn (batched tool_use block). Do not narrate them one after another. Bind each tool result back to its downstream consumer before continuing.\n"
    case "tlp":
      return "Start one sub-agent per step in this group once their shared prerequisites are satisfied. Continue only after the required branch outputs are available, then merge.\n"
  }
}

export function generateWorkflowDagDocument(dag: WorkflowDAG): string {
  if (dag.parallelism.length === 0 || dag.steps.length === 0) return ""

  return [
    "## Workflow DAG",
    "",
    "```mermaid",
    generateMermaidGraph(dag),
    "```",
    "",
  ].join("\n")
}

function generateMermaidGraph(dag: WorkflowDAG): string {
  const lines = ["graph TD"]

  for (const step of dag.steps) {
    lines.push(`  ${sanitizeNodeId(step.id)}[\"${escapeMermaidLabel(step.description || step.id)}\"]`)
  }

  for (const step of dag.steps) {
    for (const dep of step.dependsOn) {
      lines.push(`  ${sanitizeNodeId(dep)} --> ${sanitizeNodeId(step.id)}`)
    }
  }

  return lines.join("\n")
}

function sanitizeNodeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_")
}

function escapeMermaidLabel(value: string): string {
  return value.replace(/"/g, "'")
}
