/**
 * Task source resolvers.
 *
 * Three kinds:
 *  - synthetic-task: generate tasks by asking an LLM to derive them from the skill
 *  - real-task: load tasks from the task registry by id or from task.json paths
 *  - execution-log: load pre-existing conversation logs, producing Evidence directly
 *
 * synthetic and real sources produce RunnableTask[] (to be executed by the loop).
 * execution-log source produces Evidence[] directly (no rerun possible).
 */

import path from "node:path"
import {
  mkdtemp,
  readFile,
  mkdir,
  copyFile,
  readdir,
  rm,
  cp,
  rename,
  stat,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { z } from "zod"
import type { EvalCriterion } from "../core/types.ts"
import { EvalCriterionSchema } from "../core/types.ts"
import { BenchTaskFileSchema } from "../bench/types.ts"
import { hydrateEvalPayloads } from "../bench/evaluators/index.ts"
import { customEvaluators } from "../framework/types.ts"
import type { CostSlice, Evidence, EvidenceCriterion, TaskSource } from "./types.ts"
import { EvidenceCriterionSchema, emptyCostSlice, addCostSlice } from "./types.ts"
import { parseConvLogFile } from "./evidence.ts"
import { removeWorkspace } from "./workspace.ts"
import { createLogger } from "../core/logger.ts"
import { copySkillDir } from "../core/fs-utils.ts"
import {
  runHeadlessAgent,
  isHeadlessAgentError,
} from "../core/headless-agent.ts"
import { getHeadlessAgentConfig } from "../core/config.ts"

const log = createLogger("jit-optimize-source")

// ---------------------------------------------------------------------------
// RunnableTask — task ready to be executed by the loop runner
// ---------------------------------------------------------------------------

export interface RunnableTask {
  /** Stable identifier (for logs, dedup across rounds) */
  id: string
  /** The user prompt given to the agent */
  prompt: string
  /**
   * Evaluation criteria to score the run. For `custom` criteria, each one
   * carries its own `payload` (e.g. grade.py source) that was populated at
   * load time by the evaluator's loadPayload hook — no side-channel state
   * needs to be registered separately before the evaluator runs.
   */
  eval: EvalCriterion[]
  /** Fresh workDir for this run (the loop runner will recreate per-run for reruns) */
  workDir: string
  /** Optional fixture directory to copy into workDir before running */
  fixturesDir?: string
  /** Per-task timeout (ms) */
  timeoutMs: number
  /** Per-task max steps */
  maxSteps: number
}

// ---------------------------------------------------------------------------
// Dispatch — returns train/test split
// ---------------------------------------------------------------------------

export interface ResolvedTasks {
  train: RunnableTask[]
  test: RunnableTask[]
  testIsSeparate: boolean
  /**
   * Cost of any LLM calls made while resolving the task source. Only the
   * synthetic-task source charges anything here; real/log return an empty slice.
   */
  genCost: CostSlice & { calls: number }
}

/**
 * Context the synthetic-task generator needs. Supplied by the jit-optimize
 * loop runner once per generation attempt. Real-task and execution-log sources
 * ignore all of these fields — they're still threaded through
 * `resolveTrainTestTasks` so the dispatcher has a single uniform signature.
 */
export interface SyntheticTaskContext {
  /** Skill folder to derive tasks from. The generator agent reads this. */
  skillDir: string
  /** Optimizer model id — reused as the task-generation model. */
  optimizerModel: string
  /** Proposal directory where task-gen artifacts and logs persist. */
  proposalDir: string
  /**
   * Unique label for this generation attempt. `"run-0"` is the initial call;
   * regens pick their own (e.g. `"run-regen-round-2"`). Each label gets its
   * own subdir under `<proposalDir>/task-gen/` so artifacts don't collide.
   */
  runLabel: string
}

/**
 * Stable split of train and test runnable tasks resolved from a task source.
 * - `synthetic-task`: asks a headless agent to produce `trainCount + testCount`
 *   self-contained bench-task directories, then partitions them (first
 *   `trainCount` → train, remainder → test). The agent's cost is returned in
 *   `genCost`.
 * - `real-task`: returns trainTasks as train; if testTasks is provided, uses
 *   it as test, otherwise reuses trainTasks so the test set equals the train
 *   set (allowed as a simple fallback for small manual task lists).
 * - `execution-log`: returns empty lists (no runnable tasks).
 *
 * Both lists are resolved ONCE by the caller and stay stable across all rounds.
 */
export async function resolveTrainTestTasks(
  source: TaskSource,
  context: SyntheticTaskContext,
): Promise<ResolvedTasks> {
  if (source.kind === "execution-log") {
    return { train: [], test: [], testIsSeparate: false, genCost: { ...emptyCostSlice(), calls: 0 } }
  }
  if (source.kind === "synthetic-task") {
    const total = source.trainCount + source.testCount
    const { tasks: all, genCost } = await resolveSyntheticTasks(total, context)
    const train = all.slice(0, source.trainCount)
    const test = all.slice(source.trainCount)
    return { train, test, testIsSeparate: test.length > 0, genCost }
  }
  // real-task
  const train = await resolveRealTasks(source.trainTasks, "real-train")
  if (source.testTasks && source.testTasks.length > 0) {
    const test = await resolveRealTasks(source.testTasks, "real-test")
    return { train, test, testIsSeparate: true, genCost: { ...emptyCostSlice(), calls: 0 } }
  }
  // No separate test set — test equals train (by reference/reuse)
  return { train, test: train, testIsSeparate: false, genCost: { ...emptyCostSlice(), calls: 0 } }
}

export async function loadEvidencesFromLogs(source: TaskSource): Promise<Evidence[]> {
  if (source.kind !== "execution-log") return []
  const out: Evidence[] = []
  // Log source has no RunnableTask — each log file IS one evidence. Derive a
  // stable taskId from the log file's basename (sans extension) so downstream
  // per-task grouping in avgScore / pickBestRound still works. Collisions
  // across different directories are resolved by suffixing a 1-based index.
  const seen = new Map<string, number>()
  for (const inp of source.logs) {
    try {
      const parsed = await parseConvLogFile(inp.path)
      let criteria: EvidenceCriterion[] | undefined = parsed.criteria
      if (inp.criteriaPath) {
        try {
          const raw = JSON.parse(await readFile(inp.criteriaPath, "utf-8"))
          const arr = Array.isArray(raw) ? raw : [raw]
          criteria = arr.map((x) => EvidenceCriterionSchema.parse(x))
        } catch (err) {
          log.warn(`Failed to load criteria file ${inp.criteriaPath}: ${err}`)
        }
      }
      const base = path.basename(inp.path).replace(/\.(jsonl?|log|txt)$/i, "")
      const count = (seen.get(base) ?? 0) + 1
      seen.set(base, count)
      const taskId = count === 1 ? base : `${base}#${count}`
      out.push({
        taskId,
        conversationLog: parsed.conversationLog,
        taskPrompt: parsed.taskPrompt ?? "(task prompt not found in log)",
        criteria,
        // workDirSnapshot, runMeta are unavailable for log-only sources
      })
    } catch (err) {
      log.warn(`Failed to load execution log ${inp.path}: ${err}`)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Synthetic tasks — agent-driven
// ---------------------------------------------------------------------------
//
// The generator runs a headless agent inside a temp workspace that contains
// a read-only copy of the skill folder under `./skill/` and an empty
// `./tasks-out/` directory. The agent has full read/write/exec inside the
// workspace (opencode's `build` agent). Its job is to leave, on disk,
// one `./tasks-out/task-<k>/` directory per task — each a self-contained
// bench-task directory (same shape as `skvm-data/tasks/<name>/`). The
// engine then loads those directories via the existing `loadTaskFromPath`
// code path used by the real-task source, moves the artifacts into the
// proposal tree so they survive the per-rerun workDir churn, and returns
// `RunnableTask`s whose `fixturesDir` points into the proposal tree.
//
// No JSON-over-stdout, no schema invented here: the agent writes real
// `task.json` files and the engine validates them with the same Zod schema
// that gates real bench tasks.

/** Timeout for a single task-gen agent run. */
const TASK_GEN_TIMEOUT_MS = 15 * 60 * 1000

/** Per-task default execution bounds (if the generated task.json omits them). */
const DEFAULT_TASK_TIMEOUT_MS = 300_000
const DEFAULT_TASK_MAX_STEPS = 30

/** Fixture directory hard caps — rejected tasks are dropped (not truncated). */
const TASK_GEN_MAX_FILES = 20
const TASK_GEN_MAX_BYTES_PER_FILE = 64 * 1024
const TASK_GEN_MAX_TOTAL_BYTES = 512 * 1024

/**
 * Methods the agent is allowed to emit on generated tasks. A deliberate
 * subset of `EvalCriterion["method"]` — `script` is excluded so agents can't
 * smuggle arbitrary shell into the eval path.
 */
const ALLOWED_METHODS: ReadonlySet<EvalCriterion["method"]> = new Set([
  "llm-judge",
  "file-check",
  "custom",
])

/**
 * Custom evaluator ids the agent is allowed to wire up. Hand-maintained
 * rather than derived from the `customEvaluators` registry so new evaluator
 * registrations don't silently expand the synthetic contract.
 */
const ALLOWED_CUSTOM_EVALUATOR_IDS: ReadonlySet<string> = new Set([
  "python-grade",
  "junit-grade",
])

/**
 * Protocol template handed to the task-gen agent as its user prompt.
 *
 * Every value the engine actually enforces (counts, caps, allowed methods,
 * default timeouts) is interpolated from the same constants the loader
 * consumes, so drift between the prompt and the code it describes is a
 * single-file edit away from impossible.
 */
const TASK_GEN_PROTOCOL_TEMPLATE = `# Synthetic Task Generation Protocol

Your job: produce **{{count}} self-contained evaluation tasks** that stress-test the skill in \`./skill/\`. Start by reading \`./skill/SKILL.md\` and any sibling files so you understand what the skill does.

You have full read/write/exec in this workspace. Use \`bash\` / \`python3\` / etc. freely — the only thing that matters is the final state of \`./tasks-out/\` when you exit.

## What you must produce

One directory per task under \`./tasks-out/task-<k>/\`, where \`k\` = 0 .. {{countMinusOne}}:

\`\`\`
./tasks-out/task-0/
  task.json          # the task definition (schema below) — REQUIRED
  fixtures/          # optional: input files copied into the eval workDir verbatim
    data.csv
    config.json
  grade.py           # optional: only if a custom criterion uses python-grade
  my_task.test.ts    # optional: only if a custom criterion uses junit-grade
                     # (place junit test files inside fixtures/ as well)
\`\`\`

A task's \`task.json\` \`id\` field MUST equal its directory name (\`task-0\`, \`task-1\`, …). Mismatches are dropped.

## task.json schema

\`\`\`json
{
  "id": "task-0",
  "name": "Short human label",
  "prompt": "The user request, written exactly as a user would type it. Self-contained. No external URLs, APIs, or databases.",
  "timeoutMs": {{defaultTimeoutMs}},
  "maxSteps": {{defaultMaxSteps}},
  "category": "general",
  "difficulty": "easy",
  "eval": [ /* at least one criterion, see below */ ]
}
\`\`\`

If you omit \`timeoutMs\` / \`maxSteps\`, the loader applies {{defaultTimeoutMs}}ms / {{defaultMaxSteps}} steps — no need to state the default explicitly.

## Allowed eval methods

You may use ONLY these methods: {{allowedMethods}}. Custom criteria are further restricted to these \`evaluatorId\`s: {{allowedCustomEvaluatorIds}}. Any other method or evaluatorId drops the entire task.

### llm-judge — subjective rubric, scored by an LLM
\`\`\`json
{
  "method": "llm-judge",
  "id": "quality",
  "name": "Quality Judge",
  "rubric": "Clear criterion. 1.0 = perfect (specifics). 0.5 = partial. 0 = wrong.",
  "maxScore": 1,
  "weight": 1.0
}
\`\`\`
Use when correctness is subjective. No disk fixtures required.

### file-check — assert a file's existence / contents / shape
\`\`\`json
{
  "method": "file-check",
  "id": "output-exists",
  "name": "output.txt contains summary",
  "path": "output.txt",
  "mode": "contains",
  "expected": "summary",
  "weight": 0.5
}
\`\`\`
\`path\` is relative to the eval workDir (i.e. relative to anything you put under \`fixtures/\`). \`mode\` ∈ \`exact\` | \`contains\` | \`regex\` | \`json-schema\`. Alternatively pass a \`glob\` instead of \`path\`.

### custom/python-grade — Python grading function
Write \`grade.py\` at \`./tasks-out/task-<k>/grade.py\` (NOT inside fixtures/). The engine auto-loads its source into the criterion's payload.

\`\`\`python
# grade.py
def grade(transcript, workspace_path):
    # transcript: list[dict] of message events
    # workspace_path: str — the eval workDir
    import os
    records = []
    ok = os.path.exists(os.path.join(workspace_path, "output.json"))
    records.append({
        "id": "has-output",
        "score": 1.0 if ok else 0.0,
        "weight": 1.0,
        "description": "output.json was created",
        "details": None if ok else "file missing",
    })
    return records  # weights across all records MUST sum to 1.0 ± 1e-3
\`\`\`

\`\`\`json
{
  "method": "custom",
  "evaluatorId": "python-grade",
  "id": "grade",
  "name": "Automated Grade",
  "weight": 0.7
}
\`\`\`

Use for multi-checkpoint grading where Python logic is clearer than regex.

### custom/junit-grade — bun test file with regex-matched criteria
Put the test file at \`./tasks-out/task-<k>/fixtures/<name>.test.ts\`. It will be copied into the eval workDir and executed with \`bun test --reporter=junit\`.

\`\`\`json
{
  "method": "custom",
  "evaluatorId": "junit-grade",
  "id": "tests",
  "name": "Test suite",
  "weight": 0.7,
  "payload": {
    "testFile": "my_task.test.ts",
    "criteria": [
      {
        "id": "backlog-exists",
        "weight": 1.0,
        "description": "backlog.json file is present",
        "testPattern": "backlog.json > file exists"
      }
    ]
  }
}
\`\`\`

Inner \`criteria\` weights MUST sum to 1.0 (± 1e-3). \`testPattern\` is a case-insensitive regex matched against \`classname > name\` in the junit XML; pipe-separated alternatives are tried independently.

## Hard rules (violation → task dropped)

1. Task id in \`task.json\` must equal its directory name.
2. Prompts must be self-contained — no external URLs, APIs, or databases.
3. Every file under \`fixtures/\` must be a regular file with a **relative** path (no absolute paths, no \`..\` segments, no symlinks escaping the task directory).
4. Caps per task: ≤ {{maxFiles}} files in \`fixtures/\`, ≤ {{maxBytesPerFileKb}} KB per file, ≤ {{maxTotalBytesKb}} KB total under \`fixtures/\`.
5. Only eval methods listed above are accepted.
6. At least one eval criterion per task.

## Diversity

{{priorPromptsBlock}}

## Your output

When you finish, leave \`./tasks-out/task-0/\`, \`./tasks-out/task-1/\`, ... on disk. The engine reads directly from disk — print statements are ignored. Do not summarise your work; just make sure the files are there and the \`task.json\` files parse as valid JSON that matches the schema above.
`

/**
 * Render the task-gen user prompt. `stern` prepends a retry preamble used
 * when the previous attempt yielded zero valid tasks. Exported for unit testing.
 */
export function buildTaskGenPrompt(
  count: number,
  priorPrompts: readonly string[],
  stern: boolean = false,
): string {
  const priorBlock = priorPrompts.length === 0
    ? "No prior prompts this session — you have full freedom."
    : "You have already generated these prompts earlier this session. Do NOT produce a task similar in content, structure, or code path to any of them — aim for genuinely different scenarios:\n\n" +
      priorPrompts.map((p, i) => `${i + 1}. ${p}`).join("\n")

  const sternPreamble = stern
    ? "**RETRY**: Your previous attempt produced no valid tasks. Read the protocol end-to-end before starting. Make sure every task directory, every task.json, and every fixture file is written to disk before you exit — no matter how many tool calls it takes.\n\n"
    : ""

  const substitutions: Record<string, string> = {
    count: String(count),
    countMinusOne: String(Math.max(0, count - 1)),
    priorPromptsBlock: priorBlock,
    defaultTimeoutMs: String(DEFAULT_TASK_TIMEOUT_MS),
    defaultMaxSteps: String(DEFAULT_TASK_MAX_STEPS),
    maxFiles: String(TASK_GEN_MAX_FILES),
    maxBytesPerFileKb: String(TASK_GEN_MAX_BYTES_PER_FILE / 1024),
    maxTotalBytesKb: String(TASK_GEN_MAX_TOTAL_BYTES / 1024),
    allowedMethods: [...ALLOWED_METHODS].join(", "),
    allowedCustomEvaluatorIds: [...ALLOWED_CUSTOM_EVALUATOR_IDS].join(", "),
  }

  return Object.entries(substitutions).reduce(
    (body, [key, value]) => body.replaceAll(`{{${key}}}`, value),
    sternPreamble + TASK_GEN_PROTOCOL_TEMPLATE,
  )
}

/**
 * Create a fresh temp workspace for a task-gen agent run. The skill folder
 * is copied into `./skill/` read-only; `./tasks-out/` is created empty.
 */
async function prepareTaskGenWorkspace(
  skillDir: string,
): Promise<{ workspace: string; tasksOutDir: string }> {
  const workspace = await mkdtemp(path.join(tmpdir(), "jit-optimize-taskgen-"))
  await copySkillDir(skillDir, path.join(workspace, "skill"))
  const tasksOutDir = path.join(workspace, "tasks-out")
  await mkdir(tasksOutDir, { recursive: true })
  return { workspace, tasksOutDir }
}

/**
 * Schema for task.json files produced by the synthetic task-gen agent.
 * Derived from `BenchTaskFileSchema`:
 *
 * - `timeoutMs` / `maxSteps` are optional (no zod default) so the caller can
 *   apply its own synthetic-specific default. `BenchTaskFileSchema` eagerly
 *   defaults them to 120000/30, which would shadow the caller's intent.
 * - `eval` is deep-parsed via `EvalCriterionSchema` so a malformed criterion
 *   surfaces as a clean drop reason here instead of throwing later.
 * - Unused bench-only fields are omitted so agents can't smuggle meaningless
 *   shape (e.g. `hostReady`) through the synthetic path.
 */
const SyntheticTaskFileSchema = BenchTaskFileSchema
  .omit({
    timeoutMs: true,
    maxSteps: true,
    eval: true,
    hostReady: true,
    fixtures: true,
    origin: true,
    gradingWeights: true,
  })
  .extend({
    timeoutMs: z.number().int().positive().optional(),
    maxSteps: z.number().int().positive().optional(),
    eval: z.array(EvalCriterionSchema).min(1),
  })

type SyntheticTaskFile = z.infer<typeof SyntheticTaskFileSchema>

type Check = { ok: true } | { ok: false; reason: string }
type LoadResult<T> = { ok: true; value: T } | { ok: false; reason: string }

function errMsg(err: unknown): string {
  if (err instanceof z.ZodError) return err.issues.map((i) => i.message).join("; ")
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Parse + hydrate a single `task-<k>/task.json`. `expectedId` guards the
 * dir-name / id match. Each distinct failure gets its own drop reason so
 * warn logs stay actionable.
 */
async function loadSyntheticTaskDir(
  taskDir: string,
  expectedId: string,
): Promise<LoadResult<SyntheticTaskFile>> {
  const taskJsonPath = path.join(taskDir, "task.json")
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(taskJsonPath, "utf-8"))
  } catch (err) {
    return { ok: false, reason: `task.json missing or unparseable: ${errMsg(err)}` }
  }

  let parsed: SyntheticTaskFile
  try {
    parsed = SyntheticTaskFileSchema.parse(raw)
  } catch (err) {
    return { ok: false, reason: `task.json schema validation failed: ${errMsg(err)}` }
  }

  if (parsed.id !== expectedId) {
    return {
      ok: false,
      reason: `task.json id ${JSON.stringify(parsed.id)} != dir ${JSON.stringify(expectedId)}`,
    }
  }

  try {
    await hydrateEvalPayloads(parsed.eval, taskDir)
  } catch (err) {
    return { ok: false, reason: `payload hydration failed: ${errMsg(err)}` }
  }

  return { ok: true, value: parsed }
}

function checkEvalAllowlist(criteria: readonly EvalCriterion[]): Check {
  for (const c of criteria) {
    if (!ALLOWED_METHODS.has(c.method)) {
      return { ok: false, reason: `disallowed eval method ${c.method}` }
    }
    if (c.method === "custom" && !ALLOWED_CUSTOM_EVALUATOR_IDS.has(c.evaluatorId)) {
      return {
        ok: false,
        reason: `disallowed custom evaluatorId ${JSON.stringify(c.evaluatorId)}`,
      }
    }
  }
  return { ok: true }
}

/**
 * Delegate filesystem integrity checks to each custom evaluator's own
 * `checkIntegrity` hook. Evaluators that don't opt in (no hook registered)
 * are trusted — the allowlist above has already rejected anything outside
 * `ALLOWED_CUSTOM_EVALUATOR_IDS`.
 */
async function checkCustomPayloadIntegrity(
  criteria: readonly EvalCriterion[],
  ctx: { taskDir: string; fixturesDir: string },
): Promise<Check> {
  for (const c of criteria) {
    if (c.method !== "custom") continue
    const evaluator = customEvaluators.get(c.evaluatorId)
    if (!evaluator?.checkIntegrity) continue
    const result = await evaluator.checkIntegrity(c, ctx)
    if (!result.ok) return result
  }
  return { ok: true }
}

interface FixturesReport {
  ok: true
  /** Number of regular files under fixtures/ (0 when the dir is absent). */
  fileCount: number
}

async function validateFixturesTree(
  fixturesDir: string,
): Promise<FixturesReport | { ok: false; reason: string }> {
  let dirents
  try {
    dirents = await readdir(fixturesDir, { withFileTypes: true, recursive: true })
  } catch (err) {
    // Missing dir is the happy path ("no fixtures is fine"). Any other error
    // (EACCES, ENOTDIR, etc.) must surface — silently treating them as empty
    // would let a broken task through.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ok: true, fileCount: 0 }
    }
    return { ok: false, reason: `readdir fixtures/ failed: ${errMsg(err)}` }
  }
  const fixturesRoot = path.resolve(fixturesDir)
  const files = dirents.filter((e) => e.isFile())
  if (files.length > TASK_GEN_MAX_FILES) {
    return {
      ok: false,
      reason: `${files.length} fixture files > cap ${TASK_GEN_MAX_FILES}`,
    }
  }
  let totalBytes = 0
  for (const f of files) {
    const parent = f.parentPath ?? fixturesDir
    const full = path.join(parent, f.name)
    const resolved = path.resolve(full)
    // Escape guard: resolved path must live under fixturesRoot.
    if (
      resolved !== fixturesRoot &&
      !resolved.startsWith(fixturesRoot + path.sep)
    ) {
      return { ok: false, reason: `fixture path escapes task dir: ${f.name}` }
    }
    let s
    try {
      s = await stat(full)
    } catch (err) {
      return { ok: false, reason: `stat ${f.name} failed: ${errMsg(err)}` }
    }
    if (!s.isFile()) {
      return { ok: false, reason: `${f.name} is not a regular file` }
    }
    if (s.size > TASK_GEN_MAX_BYTES_PER_FILE) {
      return {
        ok: false,
        reason: `${f.name} (${s.size} B) > per-file cap ${TASK_GEN_MAX_BYTES_PER_FILE}`,
      }
    }
    totalBytes += s.size
    if (totalBytes > TASK_GEN_MAX_TOTAL_BYTES) {
      return {
        ok: false,
        reason: `fixtures total ${totalBytes} B > total cap ${TASK_GEN_MAX_TOTAL_BYTES}`,
      }
    }
  }
  return { ok: true, fileCount: files.length }
}

/**
 * Scan `tasksOutDir` for `task-<k>` subdirectories and load at most
 * `opts.count` validated `RunnableTask`s. Tasks that violate the allowlist,
 * caps, schema, or integrity checks are dropped with a precise reason.
 * Directories produced beyond `count` are reported as "over budget" without
 * incurring load work. Exported for unit testing.
 */
export async function loadGeneratedTasks(
  tasksOutDir: string,
  opts: { count: number; timeoutMs?: number; maxSteps?: number },
): Promise<{ tasks: RunnableTask[]; dropped: { id: string; reason: string }[] }> {
  const dropped: { id: string; reason: string }[] = []
  const accepted: RunnableTask[] = []

  let entries: string[]
  try {
    const all = await readdir(tasksOutDir, { withFileTypes: true })
    entries = all
      .filter((e) => e.isDirectory() && /^task-\d+$/.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => parseInt(a.slice(5), 10) - parseInt(b.slice(5), 10))
  } catch {
    return { tasks: [], dropped }
  }

  const defaultTimeout = opts.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS
  const defaultMaxSteps = opts.maxSteps ?? DEFAULT_TASK_MAX_STEPS

  for (const dirName of entries) {
    if (accepted.length >= opts.count) {
      // Over-budget: record without loading. Earlier drops (validation
      // failures on this same directory) are not possible here — we haven't
      // touched this entry yet.
      dropped.push({ id: dirName, reason: `exceeds requested count ${opts.count}` })
      continue
    }

    const taskDir = path.join(tasksOutDir, dirName)
    const fixturesDir = path.join(taskDir, "fixtures")

    const fixturesCheck = await validateFixturesTree(fixturesDir)
    if (!fixturesCheck.ok) {
      dropped.push({ id: dirName, reason: fixturesCheck.reason })
      continue
    }

    const loaded = await loadSyntheticTaskDir(taskDir, dirName)
    if (!loaded.ok) {
      dropped.push({ id: dirName, reason: loaded.reason })
      continue
    }

    const evalCheck = checkEvalAllowlist(loaded.value.eval)
    if (!evalCheck.ok) {
      dropped.push({ id: dirName, reason: evalCheck.reason })
      continue
    }

    const integrity = await checkCustomPayloadIntegrity(loaded.value.eval, {
      taskDir,
      fixturesDir,
    })
    if (!integrity.ok) {
      dropped.push({ id: dirName, reason: integrity.reason })
      continue
    }

    accepted.push({
      id: loaded.value.id,
      prompt: loaded.value.prompt,
      eval: loaded.value.eval,
      // `createRunWorkDir` in loop.ts creates a fresh mkdtemp per run and
      // ignores this value; leaving it empty avoids a useless mkdtemp per
      // task. Pre-existing interface requires a string.
      workDir: "",
      fixturesDir: fixturesCheck.fileCount > 0 ? fixturesDir : undefined,
      timeoutMs: loaded.value.timeoutMs ?? defaultTimeout,
      maxSteps: loaded.value.maxSteps ?? defaultMaxSteps,
    })
  }

  return { tasks: accepted, dropped }
}

/**
 * Move a freshly-generated `tasks-out/` tree and its agent output into the
 * proposal directory. `outcome` discriminates the ok (agent finished, tasks
 * loaded) and failed (subprocess threw) paths, which share the same layout
 * but use different sidecar filenames and a `-failed` suffix on runLabel.
 * Tries `rename` first; falls back to `cp + rm` only when the workspace and
 * proposal tree live on different devices.
 */
async function persistTaskGenArtifacts(
  tasksOutDir: string,
  proposalDir: string,
  runLabel: string,
  outcome:
    | { kind: "ok"; stdout: string; stderr: string }
    | { kind: "failed"; error: Error },
): Promise<string> {
  const labelSuffix = outcome.kind === "ok" ? "" : "-failed"
  const destBase = path.join(proposalDir, "task-gen", `${runLabel}${labelSuffix}`)
  await mkdir(destBase, { recursive: true })
  const destTasks = path.join(destBase, "tasks")

  try {
    await rename(tasksOutDir, destTasks)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EXDEV") {
      if (outcome.kind === "ok") throw err
      // Failed path: a missing tasks-out is common when the subprocess died
      // early; preserve the error sidecar below even if nothing was copied.
    } else {
      await cp(tasksOutDir, destTasks, { recursive: true })
      await rm(tasksOutDir, { recursive: true, force: true })
    }
  }

  if (outcome.kind === "ok") {
    await Bun.write(path.join(destBase, "agent-stdout.log"), outcome.stdout)
    if (outcome.stderr) {
      await Bun.write(path.join(destBase, "agent-stderr.log"), outcome.stderr)
    }
  } else {
    await Bun.write(
      path.join(destBase, "error.txt"),
      `${outcome.error.name}: ${outcome.error.message}\n`,
    )
  }
  return destTasks
}

/**
 * Rewrite each task's `fixturesDir` to point at the persisted copy under
 * `destTasks/<taskId>/fixtures/`. The original path lived under the now-moved
 * temp workspace.
 */
function repointFixturesDirs(
  tasks: readonly RunnableTask[],
  destTasks: string,
): RunnableTask[] {
  return tasks.map((t) =>
    t.fixturesDir
      ? { ...t, fixturesDir: path.join(destTasks, t.id, "fixtures") }
      : { ...t },
  )
}

/** Maximum number of retry attempts when the first attempt produces fewer
 *  tasks than requested. Each retry asks only for the remaining shortfall
 *  and carries the prompts of already-accepted tasks so the agent avoids
 *  generating duplicates. */
const TASK_GEN_MAX_RETRIES = 3

/**
 * Generate `count` synthetic tasks by running a headless agent inside a temp
 * workspace. On success returns up to `count` `RunnableTask`s whose
 * `fixturesDir` points into the proposal tree.
 *
 * When the first attempt yields fewer than `count` valid tasks (e.g. because
 * the provider dropped mid-session), up to {@link TASK_GEN_MAX_RETRIES}
 * follow-up attempts are made. Each retry requests only the shortfall and
 * includes the prompts of already-accepted tasks so the agent produces
 * genuinely different scenarios. Tasks accumulated across retries are
 * re-indexed to `task-0 … task-(n-1)` so downstream code sees a contiguous
 * sequence.
 *
 * Throws when all attempts together yield 0 valid tasks.
 */
export async function resolveSyntheticTasks(
  count: number,
  context: SyntheticTaskContext,
  priorPrompts: readonly string[] = [],
): Promise<{ tasks: RunnableTask[]; genCost: CostSlice & { calls: number } }> {
  const headlessAgent = getHeadlessAgentConfig()

  interface Attempt {
    tasks: RunnableTask[]
    cost: CostSlice & { calls: number }
    error?: Error
  }

  const runAttempt = async (
    runLabel: string,
    requestCount: number,
    prompt: string,
  ): Promise<Attempt> => {
    const { workspace, tasksOutDir } = await prepareTaskGenWorkspace(context.skillDir)
    try {
      let run
      try {
        run = await runHeadlessAgent({
          cwd: workspace,
          prompt,
          model: context.optimizerModel,
          driver: headlessAgent.driver,
          timeoutMs: TASK_GEN_TIMEOUT_MS,
        })
      } catch (err) {
        if (isHeadlessAgentError(err)) {
          await persistTaskGenArtifacts(tasksOutDir, context.proposalDir, runLabel, {
            kind: "failed",
            error: err,
          }).catch((persistErr) => {
            log.warn(`task-gen: failed to persist error workspace: ${errMsg(persistErr)}`)
          })
          return { tasks: [], cost: { ...emptyCostSlice(), calls: 0 }, error: err }
        }
        throw err
      }

      const cost: CostSlice & { calls: number } = {
        tokens: run.tokens,
        costUsd: run.cost,
        calls: 1,
      }

      const { tasks: loaded, dropped } = await loadGeneratedTasks(tasksOutDir, {
        count: requestCount,
      })
      for (const d of dropped) {
        log.warn(`task-gen (${runLabel}): dropped ${d.id}: ${d.reason}`)
      }

      const destTasks = await persistTaskGenArtifacts(
        tasksOutDir,
        context.proposalDir,
        runLabel,
        { kind: "ok", stdout: run.rawStdout, stderr: run.rawStderr },
      )
      return { tasks: repointFixturesDirs(loaded, destTasks), cost }
    } finally {
      await removeWorkspace(workspace).catch(() => {
        /* best effort */
      })
    }
  }

  const accumulated: RunnableTask[] = []
  let totalCost: CostSlice & { calls: number } = { ...emptyCostSlice(), calls: 0 }
  const allPriorPrompts = [...priorPrompts]
  let prevYieldedZero = false

  for (let attempt = 0; attempt <= TASK_GEN_MAX_RETRIES; attempt++) {
    const remaining = count - accumulated.length
    if (remaining <= 0) break

    const isFirst = attempt === 0
    const runLabel = isFirst
      ? context.runLabel
      : `${context.runLabel}-retry-${attempt}`

    // Stern preamble only when the previous attempt yielded zero valid tasks.
    const prompt = buildTaskGenPrompt(remaining, allPriorPrompts, prevYieldedZero)

    const result = await runAttempt(runLabel, remaining, prompt)
    totalCost = addCostSlice(totalCost, result.cost)

    if (result.tasks.length > 0) {
      prevYieldedZero = false
      const offset = accumulated.length
      for (const [i, task] of result.tasks.entries()) {
        allPriorPrompts.push(task.prompt)
        accumulated.push({ ...task, id: `task-${offset + i}` })
      }

      if (accumulated.length >= count) break

      log.info(
        `task-gen: attempt ${attempt + 1} produced ${result.tasks.length}/${remaining} task(s), ` +
          `${accumulated.length}/${count} total — retrying for remainder`,
      )
    } else {
      prevYieldedZero = true
      const reason = result.error
        ? `failed with ${result.error.name}: ${errMsg(result.error)}`
        : "produced 0 valid tasks"
      log.warn(
        `task-gen: attempt ${attempt + 1} ${reason}` +
          (attempt < TASK_GEN_MAX_RETRIES ? "; retrying" : ""),
      )
    }
  }

  if (accumulated.length === 0) {
    throw new Error(
      `synthetic task generation failed: 0 valid tasks after ${TASK_GEN_MAX_RETRIES + 1} attempt(s)`,
    )
  }

  if (accumulated.length < count) {
    log.warn(
      `task-gen: wanted ${count} task(s) but only ${accumulated.length} survived after all retries`,
    )
  }

  return { tasks: accumulated, genCost: totalCost }
}

// ---------------------------------------------------------------------------
// Real tasks (from bench registry or task.json paths)
// ---------------------------------------------------------------------------

async function resolveRealTasks(taskRefs: string[], label: string): Promise<RunnableTask[]> {
  const { loadTasks } = await import("../bench/loader.ts")
  const registry = await loadTasks()
  const byId = new Map(registry.map((t) => [t.id, t]))

  const out: RunnableTask[] = []
  for (const ref of taskRefs) {
    let task: import("../bench/types.ts").BenchTask | undefined
    if (ref.endsWith(".json") || ref.includes("/")) {
      // Path-based
      task = await loadTaskFromPath(ref)
    } else {
      // ID-based
      task = byId.get(ref)
    }
    if (!task) {
      log.warn(`${label}: ${ref} not found; skipping`)
      continue
    }

    const workDir = await mkdtemp(path.join(tmpdir(), "jit-optimize-real-"))
    const fixturesDir = task.taskDir ? path.join(task.taskDir, "fixtures") : undefined

    out.push({
      id: task.id,
      prompt: task.prompt,
      eval: task.eval,
      workDir,
      fixturesDir,
      timeoutMs: task.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
      maxSteps: task.maxSteps ?? DEFAULT_TASK_MAX_STEPS,
    })
  }
  return out
}

async function loadTaskFromPath(ref: string): Promise<import("../bench/types.ts").BenchTask | undefined> {
  try {
    const { BenchTaskFileSchema } = await import("../bench/types.ts")
    const { EvalCriterionSchema } = await import("../core/types.ts")
    const { hydrateEvalPayloads } = await import("../bench/evaluators/index.ts")
    const resolved = path.isAbsolute(ref) ? ref : path.resolve(ref)
    const isFile = resolved.endsWith(".json")
    const taskJsonPath = isFile ? resolved : path.join(resolved, "task.json")
    const taskDir = path.dirname(taskJsonPath)

    const raw = JSON.parse(await readFile(taskJsonPath, "utf-8"))
    const parsed = BenchTaskFileSchema.parse(raw)

    const eval_ = parsed.eval.map((e) => EvalCriterionSchema.parse(e))
    // Populate `payload` on every custom criterion (e.g. python-grade reads
    // the sibling grade.py via its loadPayload hook).
    await hydrateEvalPayloads(eval_, taskDir)

    return {
      id: parsed.id,
      name: parsed.name,
      prompt: parsed.prompt,
      fixtures: parsed.fixtures ? { ...parsed.fixtures } : undefined,
      eval: eval_,
      timeoutMs: parsed.timeoutMs,
      maxSteps: parsed.maxSteps,
      category: parsed.category,
      gradingType: parsed.gradingType,
      gradingWeights: parsed.gradingWeights,
      skill: parsed.skill,
      taskDir,
      hostReady: parsed.hostReady,
      difficulty: parsed.difficulty,
    }
  } catch (err) {
    log.warn(`Failed to load task from ${ref}: ${err}`)
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Fixture copying (used by the loop runner before each rerun)
// ---------------------------------------------------------------------------

export async function copyFixturesInto(
  workDir: string,
  fixturesDir: string | undefined,
): Promise<void> {
  if (!fixturesDir) return
  try {
    const entries = await readdir(fixturesDir, { withFileTypes: true, recursive: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const full = path.join(entry.parentPath ?? fixturesDir, entry.name)
      const rel = path.relative(fixturesDir, full)
      const dest = path.join(workDir, rel)
      await mkdir(path.dirname(dest), { recursive: true })
      await copyFile(full, dest)
    }
  } catch {
    // no fixtures
  }
}
