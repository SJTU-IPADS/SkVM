/**
 * Python Grade Evaluator
 *
 * Custom evaluator that runs a Python `grade()` function against agent
 * execution results. The grade function receives:
 *
 *     transcript: list[dict]      # message events (agent steps)
 *     workspace_path: str         # path to the working directory
 *
 * and MUST return a list of criterion records, each with:
 *
 *     {
 *       "id":          str,           # unique within this task
 *       "score":       float,         # 0.0 .. 1.0
 *       "weight":      float,         # required; all weights must sum to 1.0 exactly
 *       "description": str (optional),# what this sub-criterion tests — shown to optimizer
 *       "details":     str (optional),# why below max; omit when score == 1.0
 *     }
 *
 * The evaluator validates shape/uniqueness/weight-sum in the Python runner
 * and builds an `EvalResult` whose `checkpoints` preserve each record's
 * metadata. Downstream consumers (bench reporter, jit-optimize evidence
 * builder) read weight/description from the checkpoints.
 *
 * Task-scoped state: the grade.py source lives on the criterion's `payload`
 * field, populated at load time via the `loadPayload` hook below. There is
 * no module-level map, no string matching on workDir, and no fallback.
 */

import path from "node:path"
import type { AgentStep } from "../../core/types.ts"
import type { CustomEvaluator } from "../../framework/types.ts"
import { registerCustomEvaluator } from "../../framework/types.ts"
import { createLogger } from "../../core/logger.ts"

const log = createLogger("python-grade")

// ---------------------------------------------------------------------------
// Transcript Conversion: SkVM AgentStep[] -> grade() transcript format
// ---------------------------------------------------------------------------

interface TranscriptEntry {
  type: "message"
  message: {
    role: string
    content: unknown[]
  }
}

function convertTranscript(steps: AgentStep[]): TranscriptEntry[] {
  const transcript: TranscriptEntry[] = []

  for (const step of steps) {
    if (step.role === "assistant") {
      const content: unknown[] = []
      if (step.text) content.push({ type: "text", text: step.text })
      for (const tc of step.toolCalls) {
        content.push({ type: "toolCall", name: tc.name, params: tc.input })
      }
      transcript.push({ type: "message", message: { role: "assistant", content } })
    } else if (step.role === "tool") {
      for (const tc of step.toolCalls) {
        transcript.push({
          type: "message",
          message: { role: "toolResult", content: [{ output: tc.output ?? "" }] },
        })
      }
    }
  }

  return transcript
}

// ---------------------------------------------------------------------------
// Python Grade Runner Template
// ---------------------------------------------------------------------------

const GRADE_RUNNER_TEMPLATE = `
import json
import sys
import os

sys.path.insert(0, os.getcwd())
from _grade_fn import grade

with open("_transcript.json", "r") as f:
    transcript = json.load(f)

WEIGHT_TOLERANCE = 1e-3

def _emit_error(msg):
    print(json.dumps({"error": msg, "records": [], "avg": 0.0}))
    sys.exit(0)

try:
    records = grade(transcript, os.getcwd())
except Exception as e:
    _emit_error(f"grade() raised: {e}")

if not isinstance(records, list):
    _emit_error(
        f"grade() must return a list of criterion records, got {type(records).__name__}"
    )

# Validate record shape, uniqueness of ids, and weights sum.
seen_ids = set()
normalized = []
total_weight = 0.0
for i, rec in enumerate(records):
    if not isinstance(rec, dict):
        _emit_error(f"record {i} is not a dict: {rec!r}")
    if "id" not in rec:
        _emit_error(f"record {i} missing required field 'id'")
    if "score" not in rec:
        _emit_error(f"record {i} ({rec['id']}) missing required field 'score'")
    if "weight" not in rec:
        _emit_error(f"record {i} ({rec['id']}) missing required field 'weight'")

    rid = str(rec["id"])
    if rid in seen_ids:
        _emit_error(f"duplicate criterion id: {rid!r}")
    seen_ids.add(rid)

    try:
        score = float(rec["score"])
    except (TypeError, ValueError):
        _emit_error(f"record {rid} has non-numeric score: {rec['score']!r}")
    if score < 0.0 or score > 1.0:
        _emit_error(f"record {rid} score {score} not in [0, 1]")

    try:
        weight = float(rec["weight"])
    except (TypeError, ValueError):
        _emit_error(f"record {rid} has non-numeric weight: {rec['weight']!r}")
    if weight < 0.0:
        _emit_error(f"record {rid} has negative weight {weight}")

    total_weight += weight
    entry = {"id": rid, "score": score, "weight": weight}
    if "description" in rec and rec["description"] is not None:
        entry["description"] = str(rec["description"])
    if "details" in rec and rec["details"] is not None:
        entry["details"] = str(rec["details"])
    normalized.append(entry)

if len(normalized) == 0:
    _emit_error("grade() returned an empty list")

if abs(total_weight - 1.0) > WEIGHT_TOLERANCE:
    _emit_error(
        f"criterion weights must sum to 1.0, got {total_weight:.6f}"
    )

avg = sum(r["score"] * r["weight"] for r in normalized)
print(json.dumps({"records": normalized, "avg": avg}))
`

// ---------------------------------------------------------------------------
// Evaluator implementation
// ---------------------------------------------------------------------------

interface GradeRecord {
  id: string
  score: number
  weight: number
  description?: string
  details?: string
}

export const pythonGrade: CustomEvaluator = {
  async run({ criterion, runResult }) {
    const gradeCode = criterion.payload
    if (typeof gradeCode !== "string") {
      return {
        pass: false,
        score: 0.0,
        details:
          "python-grade: criterion.payload missing or not a string (expected grade.py source). " +
          "Ensure the task directory has a grade.py file or that the task loader calls hydrateEvalPayloads.",
      }
    }

    const workDir = runResult.workDir
    try {
      await Bun.write(path.join(workDir, "_grade_fn.py"), gradeCode)
      await Bun.write(path.join(workDir, "_grade_runner.py"), GRADE_RUNNER_TEMPLATE)
      await Bun.write(
        path.join(workDir, "_transcript.json"),
        JSON.stringify(convertTranscript(runResult.steps), null, 2),
      )

      const proc = Bun.spawn(["python3", "_grade_runner.py"], {
        cwd: workDir,
        stdout: "pipe",
        stderr: "pipe",
      })

      const [, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      if (stderr) log.debug(`Grade stderr: ${stderr.slice(0, 500)}`)

      // Grade functions may print diagnostic output (e.g. unittest print()
      // statements) before the final JSON line. Extract the last line that
      // looks like JSON rather than trying to parse the whole stdout.
      const lines = stdout.trim().split("\n")
      let jsonStr: string | undefined
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!.trim()
        if (line.startsWith("{")) {
          jsonStr = line
          break
        }
      }
      if (!jsonStr) {
        return {
          pass: false,
          score: 0.0,
          details: `Grader no JSON output. stdout: ${stdout.slice(0, 300)}. stderr: ${stderr.slice(0, 200)}`,
        }
      }

      const parsed = JSON.parse(jsonStr) as {
        records: GradeRecord[]
        avg: number
        error?: string
      }
      if (parsed.error) log.warn(`Grade error: ${parsed.error}`)

      const score = parsed.avg
      const records = parsed.records ?? []
      const breakdown = records
        .map((r) => `${r.id}: ${r.score.toFixed(2)}`)
        .join(", ")
      const checkpoints = records.map((r) => ({
        name: r.id,
        score: Math.max(0, Math.min(1, Number(r.score))),
        weight: r.weight,
        description: r.description,
        reason: r.score >= 1.0 ? undefined : (r.details ?? `scored ${r.score.toFixed(2)}`),
      }))

      return {
        pass: score >= 0.5,
        score,
        details: parsed.error ? `Error: ${parsed.error}` : `${breakdown} (avg=${score.toFixed(2)})`,
        checkpoints,
      }
    } catch (err) {
      return { pass: false, score: 0.0, details: `Evaluator error: ${err}` }
    }
  },

  async loadPayload(taskDir: string) {
    const f = Bun.file(path.join(taskDir, "grade.py"))
    if (!(await f.exists())) return undefined
    return await f.text()
  },

  async savePayload(taskDir: string, payload: unknown) {
    if (typeof payload !== "string") return
    await Bun.write(path.join(taskDir, "grade.py"), payload)
  },

  async checkIntegrity(criterion) {
    // `loadPayload` returns undefined when grade.py is absent; an undefined
    // or non-string payload here means the agent authored a python-grade
    // criterion without the sibling file it depends on.
    if (typeof criterion.payload !== "string" || criterion.payload.length === 0) {
      const label = criterion.id ? `"${criterion.id}"` : "(unnamed)"
      return {
        ok: false,
        reason: `python-grade criterion ${label}: missing or empty grade.py in task directory`,
      }
    }
    return { ok: true }
  },
}

// Module-top side-effect registration. Importing this module (directly or
// via the `bench/evaluators/index.ts` barrel) is sufficient to register the
// evaluator. There is no exported `register…()` function — the barrel is the
// single extensibility point.
registerCustomEvaluator("python-grade", pythonGrade)
