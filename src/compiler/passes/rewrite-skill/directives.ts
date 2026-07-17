/**
 * Profile-derived compilation directives.
 *
 * The pass-1 rewriter must not hard-code any particular model's failure
 * modes: what a weak model needs (script scaffolds, anti-retry rules, deep
 * distillation) is noise or harm for a strong one. This module is the single
 * place where the target's TCP is analyzed into concrete, evidence-annotated
 * directives; the prompt stays model-neutral and simply relays what is
 * derived here.
 *
 * Pure computation — no LLM calls, unit-testable in isolation.
 */

import type { TCP, Level } from "../../../core/types.ts"
import { LEVEL_ORDER } from "../../../core/types.ts"

export interface CompilationRule {
  /** The instruction to embed in the compiled skill / follow while compiling. */
  directive: string
  /** Which capability measurement triggered this rule. */
  evidence: string
}

/**
 * How hard to distill. A first-class tier rather than a threshold consumers
 * re-derive from `sizeBudgetFraction`: two consumers reading `< 1.0` as "weak"
 * disagreed about what 0.7 means, and the middle tier ended up receiving both
 * "make only evidence-targeted edits" and "a net negative diff is expected".
 */
export type DistillationTier = "keep" | "moderate" | "deep"

export interface CompilationDirectives {
  /** How aggressively this target's profile licenses cutting. */
  tier: DistillationTier
  /** Target compiled size as a fraction of the original (1.0 = light edit). */
  sizeBudgetFraction: number
  /** One-line justification of the chosen budget. */
  budgetRationale: string
  /** Overall capability score in [0,1] (share of maximum primitive levels). */
  capabilityScore: number
  /** Model-conditional rules, each annotated with its triggering evidence. */
  rules: CompilationRule[]
}

// Weak-model threshold on the overall capability score — used for the
// engagement contract (skill injection can suppress tool use in weak
// models), NOT for the size budget.
const MID_SCORE = 0.7

/**
 * Tool wording for directive text. Only bare-agent's built-in tool names are
 * known to this module; every other harness has its own toolset, so directive
 * text falls back to action phrasing — a compiled skill must never name a
 * tool the target harness does not expose.
 */
function toolWording(tcp: TCP): { writeTool: string; runTool: string } {
  const bare = tcp.harness === "bare-agent"
  return {
    writeTool: bare ? " with write_file" : "",
    runTool: bare ? " with execute_command" : "",
  }
}

function levelOf(tcp: TCP, primitiveId: string): Level | undefined {
  return tcp.capabilities[primitiveId] as Level | undefined
}

function atOrBelow(tcp: TCP, primitiveId: string, level: Level): boolean {
  const actual = levelOf(tcp, primitiveId)
  if (actual === undefined) return false // unprofiled → no claim, no rule
  return LEVEL_ORDER[actual] <= LEVEL_ORDER[level]
}

function fmt(tcp: TCP, ids: string[]): string {
  return ids
    .filter((id) => levelOf(tcp, id) !== undefined)
    .map((id) => `${id}=${levelOf(tcp, id)}`)
    .join(", ")
}

export function deriveDirectives(tcp: TCP): CompilationDirectives {
  const entries = Object.entries(tcp.capabilities)

  // No profile data → nothing to derive; compile conservatively.
  if (entries.length === 0) {
    return {
      tier: "keep",
      sizeBudgetFraction: 1.0,
      budgetRationale: "no capability data — conservative light edit",
      capabilityScore: 1.0,
      rules: [],
    }
  }

  const score = entries.reduce((s, [, lvl]) => s + LEVEL_ORDER[lvl as Level], 0) / (entries.length * 3)

  // Size budget is keyed on follow.procedure — the primitive that measures
  // whether the model can navigate long instruction documents. Keying on the
  // global score instead misfires both ways: a model strong at
  // procedure-following but mid overall would get a distillation that strips
  // procedure content it handles well, while a globally-strong model weak at
  // long documents would keep length it cannot use. The global score stays
  // as the engagement-contract signal only.
  const followLevel = levelOf(tcp, "follow.procedure")
  let tier: DistillationTier
  let sizeBudgetFraction: number
  let budgetRationale: string
  if (followLevel === undefined) {
    // Absent from the profile is not evidence of strength. A scoped profile
    // (--primitives=, --skip-primitives=) or an externally supplied TCP can omit
    // this primitive entirely, and claiming "long documents are safe" on that
    // basis manufactures a capability from missing data — the same policy
    // `atOrBelow` already applies: unprofiled → no claim, no rule.
    tier = "keep"
    sizeBudgetFraction = 1.0
    budgetRationale = "follow.procedure=unprofiled — no evidence either way; keep original length, apply only gap-targeted edits"
  } else if (followLevel === "L3") {
    tier = "keep"
    sizeBudgetFraction = 1.0
    budgetRationale = "follow.procedure=L3 — long instruction documents are safe for this model; keep original length, apply only gap-targeted edits"
  } else if (followLevel === "L2") {
    tier = "moderate"
    sizeBudgetFraction = 0.7
    budgetRationale = "follow.procedure=L2 — trim to the parts this model will actually follow; cut noise, keep the procedure"
  } else {
    tier = "deep"
    sizeBudgetFraction = 0.4
    budgetRationale = `follow.procedure=${followLevel} — long instruction documents are unreliable for this model (attention dilution, suppressed tool use); distill deeply`
  }

  const rules: CompilationRule[] = []
  const { writeTool, runTool } = toolWording(tcp)

  // Script scaffold: weak structured tool-call formatting or shell generation
  // means inline one-liners with embedded newlines/nested quoting fail and
  // send the model into retry loops.
  const scaffoldTriggers = ["tool.call.format", "gen.code.shell"].filter((id) => atOrBelow(tcp, id, "L2"))
  if (scaffoldTriggers.length > 0) {
    rules.push({
      directive:
        `For any step needing more than one line of code, instruct: write the script to a file${writeTool}, then run it${runTool} (e.g. \`python3 script.py\`). Never show \`python3 -c\`/\`bash -c\` one-liner templates with embedded newlines or nested quoting.`,
      evidence: fmt(tcp, scaffoldTriggers),
    })
  }

  // Anti-retry: weak tool execution/formatting correlates with verbatim
  // re-issuing of a command whose output was unexpected; harnesses kill runs
  // that repeat an identical action.
  const repeatTriggers = ["tool.exec", "tool.call.format"].filter((id) => atOrBelow(tcp, id, "L2"))
  if (repeatTriggers.length > 0) {
    rules.push({
      directive:
        "Include the rule: never run the same command twice in a row — if its output was not what you needed, change the command or switch to a script file.",
      evidence: fmt(tcp, repeatTriggers),
    })
  }

  // Linear path: weak procedure-following or planning cannot navigate
  // branching workflows; give one fixed default path.
  const linearTriggers = ["follow.procedure", "reason.planning"].filter((id) => atOrBelow(tcp, id, "L1"))
  if (linearTriggers.length > 0) {
    rules.push({
      directive:
        "Structure the workflow as a single fixed sequence of steps — no branches, no alternatives, no conditional recovery paths.",
      evidence: fmt(tcp, linearTriggers),
    })
  }

  // Engagement contract: below the weak-model threshold, skill injection is
  // measured to suppress tool use (empty first-turn completions, stalling on
  // confirmation prompts). The compiled card must force immediate action.
  if (score < MID_SCORE) {
    rules.push({
      directive:
        `Close the card with a behavioral contract: start immediately with the first tool call; never ask questions or announce plans; write required output files${writeTool} (never merely describe results); after the outputs are written, stop.`,
      evidence: `capability score ${score.toFixed(2)} < ${MID_SCORE} — weak-model tier; the card must force immediate tool engagement`,
    })
  }

  return { tier, sizeBudgetFraction, budgetRationale, capabilityScore: score, rules }
}
