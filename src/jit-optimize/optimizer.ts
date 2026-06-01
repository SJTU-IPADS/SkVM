/**
 * JIT-Optimize optimizer — agent-based.
 *
 * Runs a headless agent inside a temp workspace that is a full copy of the
 * skill folder. The agent edits files in place; the engine snapshots the
 * result. The concrete agent backend is selected via the headless-agent
 * runner (currently opencode by default), so this module has no hard
 * dependency on any particular agent tool.
 */

import path from "node:path"
import type {
  OptimizeInput,
  OptimizeConfig,
  OptimizeResult,
  OptimizeSubmission,
} from "./types.ts"
import { OptimizeSubmissionSchema } from "./types.ts"
import { runHeadlessAgent } from "../core/headless-agent/index.ts"
import { createLogger } from "../core/logger.ts"
import {
  createWorkspace,
  serializeContext,
  computeDiff,
  stripOptimizeDir,
  exists,
} from "./workspace.ts"
import { mkdir } from "node:fs/promises"
import { copySkillDir } from "../core/fs-utils.ts"
import { TIMEOUT_DEFAULTS } from "../core/timeouts.ts"

const log = createLogger("jit-optimize-optimizer")

/**
 * Run one optimizer pass over the given evidence. Returns a workspace directory
 * containing the edited skill; the caller is responsible for snapshotting it
 * into a proposal round and then cleaning up.
 */
export async function runOptimizer(
  input: OptimizeInput,
  config: OptimizeConfig,
): Promise<OptimizeResult> {
  const timeoutMs = config.timeoutMs ?? TIMEOUT_DEFAULTS.optimizer

  // 1. Create workspace from skill copy
  const workspace = await createWorkspace(input.skillDir)
  log.info(`Workspace: ${workspace.dir}`)

  // 2. Serialize evidence + history into .optimize/
  await serializeContext(
    workspace.optimizeDir,
    input.evidences,
    input.history ?? [],
  )

  // 3. Build the prompt
  const prompt = buildOptimizerPrompt(input.evidences.length, (input.history ?? []).length)

  // 4. Run the headless agent with the workspace as its cwd
  const absWorkspace = path.resolve(workspace.dir)
  log.info(`Running optimizer agent with model=${config.model}`)

  const run = await runHeadlessAgent({
    cwd: absWorkspace,
    prompt,
    model: config.model,
    timeoutMs,
    driver: config.driver,
  })

  // 5. Persist the agent's stdout/stderr at the head of the step record.
  // Prompt, submission.json, diff, and optimize-context/ land here too, but
  // only after the diff is computed and before .optimize/ is stripped (steps
  // 9 + 10 below). We log stdout/stderr first so even a crash mid-write of
  // the other artifacts leaves the raw agent trace intact.
  if (config.recordDir) {
    await mkdir(config.recordDir, { recursive: true })
    await Bun.write(path.join(config.recordDir, "stdout.log"), run.rawStdout)
    if (run.rawStderr) {
      await Bun.write(path.join(config.recordDir, "stderr.log"), run.rawStderr)
    }
    await Bun.write(path.join(config.recordDir, "prompt.md"), prompt)
  }

  // Non-zero exit / timeout already threw a HeadlessAgentError inside
  // runHeadlessAgent — if we reach here the subprocess succeeded. A missing
  // or malformed submission.json below is still a legitimate "agent ran
  // normally but didn't follow the output contract" case.

  // 6. Read submission.json
  let submission: OptimizeSubmission
  if (await exists(workspace.submissionPath)) {
    try {
      const raw = await Bun.file(workspace.submissionPath).json()
      const parsed = OptimizeSubmissionSchema.parse(raw)
      submission = normalizeSubmission(parsed)
    } catch (err) {
      log.warn(`Failed to parse submission.json: ${err}`)
      submission = emptySubmission(`Failed to parse submission.json: ${err}`)
    }
  } else {
    log.warn("Optimizer did not produce .optimize/submission.json")
    submission = emptySubmission("Optimizer did not produce a submission file")
  }

  // 7. Compute actual diff (workspace vs original)
  const diff = await computeDiff(absWorkspace, input.skillDir)
  const actualChangedFiles = [...diff.added, ...diff.modified]
  const changed = actualChangedFiles.length > 0 || diff.removed.length > 0

  // 8. Self-declared vs actual mismatch — warn but trust filesystem
  if (!submission.noChanges && !submission.infraBlocked && submission.changedFiles.length > 0) {
    const declared = new Set(submission.changedFiles)
    const actual = new Set(actualChangedFiles)
    const onlyDeclared = [...declared].filter((f) => !actual.has(f))
    const onlyActual = [...actual].filter((f) => !declared.has(f))
    if (onlyDeclared.length > 0 || onlyActual.length > 0) {
      log.warn(
        `Submission changedFiles mismatch: declared-not-actual=${onlyDeclared.join(",")} actual-not-declared=${onlyActual.join(",")}`,
      )
    }
  }
  if (submission.noChanges && changed) {
    log.warn(
      `Submission claims noChanges but workspace has diffs: ${actualChangedFiles.join(", ")}`,
    )
  }
  if (submission.infraBlocked && changed) {
    log.warn(
      `Submission claims infraBlocked but workspace has diffs: ${actualChangedFiles.join(", ")}`,
    )
  }
  if (submission.infraBlocked) {
    if ((submission.blockedEvidenceIds?.length ?? 0) === 0) {
      log.warn("Submission claims infraBlocked but blockedEvidenceIds is empty")
    }
    if (!submission.blockedReason || submission.blockedReason.trim().length === 0) {
      log.warn("Submission claims infraBlocked but blockedReason is empty")
    }
  }

  // 9. Persist the rest of the optimizer step record while `.optimize/` is
  // still intact. submission.json lands as the (already-normalized) parsed
  // object so consumers don't need to re-validate; diff.json carries the
  // file-level diff against the original; optimize-context/ is a copy of
  // exactly what the agent read. Together with stdout/stderr/prompt this is
  // a complete, durable trace of one optimizer pass.
  if (config.recordDir) {
    await Bun.write(
      path.join(config.recordDir, "submission.json"),
      JSON.stringify(submission, null, 2),
    )
    await Bun.write(
      path.join(config.recordDir, "diff.json"),
      JSON.stringify(diff, null, 2),
    )
    await copySkillDir(workspace.optimizeDir, path.join(config.recordDir, "optimize-context"))
  }

  // 10. Strip .optimize/ so the workspace becomes a clean snapshot candidate
  await stripOptimizeDir(absWorkspace)

  return {
    changed,
    workspaceDir: absWorkspace,
    submission,
    actualChangedFiles,
    cost: run.cost,
    tokens: run.tokens,
  }
}

// ---------------------------------------------------------------------------
// Submission helpers
// ---------------------------------------------------------------------------

export function normalizeSubmission(raw: Partial<OptimizeSubmission>): OptimizeSubmission {
  // infraBlocked is the strongest signal — if both it and noChanges are set,
  // infraBlocked wins (negative statement about evidence quality beats the
  // positive statement about skill quality). The two are mutually exclusive
  // in the schema; this branch just codifies the tiebreak.
  if (raw.infraBlocked) {
    if (raw.noChanges) {
      log.warn("Submission has both infraBlocked and noChanges — treating as infraBlocked")
    }
    return {
      rootCause: raw.rootCause ?? "",
      reasoning: raw.reasoning ?? "",
      confidence: raw.confidence ?? 0,
      changedFiles: [],
      changes: [],
      noChanges: false,
      infraBlocked: true,
      blockedEvidenceIds: raw.blockedEvidenceIds ?? [],
      blockedReason: raw.blockedReason ?? "",
    }
  }
  if (raw.noChanges) {
    return {
      rootCause: raw.rootCause ?? "",
      reasoning: raw.reasoning ?? "",
      confidence: raw.confidence ?? 1,
      changedFiles: [],
      changes: [],
      noChanges: true,
    }
  }
  return {
    rootCause: raw.rootCause ?? "",
    reasoning: raw.reasoning ?? "",
    confidence: raw.confidence ?? 0,
    changedFiles: raw.changedFiles ?? [],
    changes: raw.changes ?? [],
    noChanges: false,
  }
}

function emptySubmission(reason: string): OptimizeSubmission {
  return {
    rootCause: "",
    reasoning: reason,
    confidence: 0,
    changedFiles: [],
    changes: [],
    noChanges: false,
  }
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export function buildOptimizerPrompt(evidenceCount: number, historyCount: number): string {
  return `You are a skill optimization agent.

A "skill" is a markdown instruction file (SKILL.md) plus optional bundle files
(scripts, references) that guide an LLM agent when performing tasks. Your job
is to analyze execution evidence from one or more task runs and improve the
skill so that agents perform better on similar tasks in the future.

## Your Workspace

Your current directory is a complete copy of the skill folder. Edit any file
here using your normal tools (read, edit, write, glob, grep, bash). The files
you leave behind when you finish ARE the optimized skill — there is no other
submission mechanism for content changes.

## Context Files

Read \`.optimize/PER_TASK_SUMMARY.md\` FIRST. It lists every task in round 0,
bucketed as FAILING / MARGINAL / PASSING / TAINTED, with each task's mean
score and where to find its evidence. This is the landscape you're working
against and the anchor for the No-trade-off rule below.

Then read \`.optimize/README.md\` — it explains the full layout. In short:

- \`.optimize/PER_TASK_SUMMARY.md\` — per-task status table. The PASSING
  rows are tasks you must NOT make worse.
- \`.optimize/tasks/<safeTaskId>/summary.md\` — one task's aggregate status
  and per-run breakdown. There are ${evidenceCount} total run(s) grouped
  under these directories.
- \`.optimize/tasks/<safeTaskId>/run-N.md\` — the full evidence for one run
  of that task: prompt, conversation log, evaluation criteria, run metadata.
  Multiple runs of the same task live in the same directory so you can tell
  "same task failed N times" apart from "N different tasks failed once".
- \`.optimize/tasks/<safeTaskId>/run-N.json\` — same data in structured form.
- \`.optimize/tasks/<safeTaskId>/run-N-workdir/\` — files the agent left in
  its work directory on that run.
${historyCount > 0 ? `- \`.optimize/history.md\` — ${historyCount} previous optimization round(s) with their root causes and whether they improved scores. READ THIS BEFORE PROPOSING CHANGES.` : ""}

## Method

1. Read \`PER_TASK_SUMMARY.md\` to get the per-task landscape. Identify the
   FAILING and MARGINAL tasks (those are what you're here to fix) and the
   PASSING tasks (those are what you must not make worse).
2. Read the relevant task directories under \`.optimize/tasks/\` —
   **failing/marginal first, passing last**. You read the passing tasks'
   evidence only to understand what you must not break, not to fix them.
   For each failing task, look at every run-N.md it has: if a task failed
   on the same criterion across multiple runs, that is a skill defect; if
   it failed differently each time, the failure is task-or-infra-specific
   and is probably NOT a skill defect.
3. ${historyCount > 0 ? "Read history.md. Do not repeat diagnoses that previous rounds tried and failed to improve. If previous rounds clarified something and it didn't help, the problem is elsewhere — look harder." : "Read the skill files you need to understand (SKILL.md is the entry point)."}
4. Identify the root cause of the failures. State it as an underlying gap in
   the skill's instructions, not as a list of changes. Good root causes are
   specific and causal ("the skill tells the agent to do X but never explains
   what Y means, so the agent guesses wrong when Y comes up"), not vague
   ("the instructions could be clearer").

5. **Pre-Edit Checklist.** Before you write any edit, answer these FOUR
   questions in \`reasoning\`. If any answer is weak, the fix is probably
   wrong — go back to step 4 or emit \`noChanges: true\`.

   a) **Generality test.** For the fix you're about to make, name at least
      one *other* plausible task on this skill that would benefit from the
      same change. If you can only name the task in the evidence, the fix
      is task-specific — do NOT make it. Instead, write \`noChanges: true\`
      with a rootCause explaining that the failure is particular to this
      task's prompt or fixture, not to a gap in the skill.

   b) **Rewrite-in-place test.** If the root cause is that an existing
      section is vague or ambiguous, edit that section in place — tighten
      the wording or make the ordering explicit — instead of appending a
      new section below it. Appending a second rule that overlaps with an
      existing one is the most common way skills accumulate dead weight.

      Do NOT delete existing rules unless you can show they directly
      contradict the fix. If you're unsure whether a rule still applies,
      leave it.

   c) **Budget.** Aim for a net diff under ~50 added lines across all
      files for this round. If your diagnosis needs more than that, the
      root cause is probably wrong — go back to step 4.

   d) **No-trade-off test.** List every task in \`PER_TASK_SUMMARY.md\` with
      status \`PASSING\`. For each one, ask yourself: "Could the change I'm
      about to make plausibly lower this task's score?" If the answer is
      "yes" or "maybe" for even one PASSING task, **stop**. You are trading
      one task for another, and the selection engine's per-task regression
      gate will reject this round. Your options are:
        (i) find a narrower framing that cannot hurt the passing tasks,
        (ii) emit \`noChanges: true\` if no narrow framing exists,
        (iii) if you believe the concern is a false alarm because the
             passing task's requirements genuinely align with the fix,
             say so explicitly in \`reasoning\` by naming the specific
             passing task id and explaining why it will not regress.
      Do NOT skip this check. The generality test (a) defends against
      hard-coding task content; this test (d) defends against semantic
      trade-offs that hide behind content-agnostic edits.

6. Edit files in this workspace to fix the root cause. You can modify SKILL.md,
   scripts, references — anything under this directory. The diff between what
   you leave behind and the original folder is your proposed change.
7. When done, write \`.optimize/submission.json\` with your structured summary.

## Output Format

Write \`.optimize/submission.json\` with these fields (see
\`.optimize/submission.template.json\` for the shape):

- \`rootCause\` (string, required): one paragraph describing the underlying
  problem you diagnosed. This is *the problem*, not what you changed.
- \`reasoning\` (string, required): your full analysis. Explain why this root
  cause is the most likely one given the evidence, and why your fix addresses
  it without overfitting.
- \`confidence\` (number 0-1, required): your confidence that the fix will
  improve scores on similar tasks.
- \`changedFiles\` (array of string, required): list of files you edited
  (relative to workspace root).
- \`changes\` (array, REQUIRED unless \`noChanges\`): structured per-file change
  summary. Each item: \`{"file", "section"?, "description", "generality", "linesDelta"?}\`.
  - \`description\`: what and why of this change, one sentence.
  - \`generality\`: one sentence naming a DIFFERENT task on this skill that
    would also benefit from this change. This is your proof — from the
    Pre-Edit Checklist step 5(a) — that the fix isn't overfit to the
    specific task in the evidence. If you cannot articulate generality for
    a change, remove that change and reconsider the root cause.
  - \`linesDelta\` (optional): net line delta for this change
    (\`linesAdded - linesRemoved\`). Used for concise-diff auditing.

If you determine the skill needs no changes — the evidence shows the skill is
fine and any failure is due to the task, fixture, or model — write only
\`{"noChanges": true}\` to submission.json and do NOT edit any files. This is a
legitimate outcome, not a failure: the Pre-Edit Checklist in step 4(a) is
designed to surface task-specific failures that should NOT be patched into
the skill.

### Abstaining on infra-broken evidence — \`infraBlocked\`

Each \`run-N.md\` has a \`Run Metadata\` section whose first line is
\`runStatus: <value>\`. When that value is anything other than \`ok\` (values:
\`timeout\`, \`adapter-crashed\`, \`parse-failed\`, \`tainted\`), the run did NOT
execute normally: the agent subprocess crashed, timed out, or produced
unparseable output. The evaluator was NOT run against the work directory for
these runs — any criteria you see are stubs carrying \`infraError\`, not real
evaluations. Don't try to diagnose a skill defect from a run whose agent
never actually got to work.

If at least one run has \`runStatus !== 'ok'\` AND the remaining clean
evidence (if any) is insufficient to support a skill-level root cause, write:

\`\`\`json
{
  "infraBlocked": true,
  "blockedEvidenceIds": ["0", "2"],
  "blockedReason": "Runs with Evidence Index 0 and 2 both show runStatus=timeout with tokens=0; the agent never produced any LLM output. The remaining clean runs are insufficient for a skill-level diagnosis."
}
\`\`\`

Rules for \`infraBlocked\`:
- Do NOT edit any files. Do not fill \`changes\` / \`changedFiles\`.
- \`blockedEvidenceIds\` must list the **Evidence Indices** — the flat
  0..N-1 integers shown in the last column of \`PER_TASK_SUMMARY.md\` and
  at the top of every \`run-N.md\`. They are independent of the per-task
  directory layout.
- \`blockedReason\` must cite the specific infra signals you saw (e.g.
  \`runStatus=timeout\`, \`tokens=0\`, \`adapter error exit 143\`, \`statusDetail=...\`).
- \`infraBlocked\` and \`noChanges\` are mutually exclusive. \`noChanges\` is a
  positive statement about the skill ("it's fine"); \`infraBlocked\` is a
  negative statement about the evidence ("I can't judge the skill from this").
  Pick the one that matches what you actually observed.
- If the infra failure is on some runs but you can still cleanly diagnose
  the skill from the remaining clean runs, do NOT use \`infraBlocked\` —
  treat this as a normal edit (or noChanges) round based on the clean half.

## Hard Rules

- **Task-content-agnostic**: the skill is used for MANY tasks. Do NOT hard-code
  values, file names, or examples from the evidence into the skill. Every fix
  must generalize — this is enforced via the \`generality\` field in each
  change (step 5(a) of the Method).
- **No task trade-off**: a fix that improves one task's score by regressing
  another task's — even when both edits look general and touch no
  task-specific content — is NOT an improvement. The optimized skill must be
  Pareto-non-inferior to the baseline across every task listed in
  \`PER_TASK_SUMMARY.md\`. The selection engine's per-task regression gate
  will reject any round that lowers any task's mean by more than its
  tolerance, so a trade-off edit is not just bad style; it will not ship.
  If the only diagnosis you have requires a trade-off, emit
  \`noChanges: true\` and state the trade-off in \`rootCause\`.
- **Preserve scope**: do not narrow the skill's capabilities.
- **Be concise**: prefer rewriting existing sections to appending new ones.
  Every instruction costs tokens. Do NOT delete existing rules unless you can
  show they contradict your fix.
- **Diagnose before prescribing**: know the root cause before you write any
  edits. A fix without a clear diagnosis is a guess.
- **Do not delete evidence**: the \`.optimize/\` directory is read-only to you
  conceptually. Do not remove or modify files under it.

Start by reading \`.optimize/PER_TASK_SUMMARY.md\`, then \`.optimize/README.md\`,
then the per-task directories.`
}
