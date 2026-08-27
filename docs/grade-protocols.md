# Grader Protocols

**Audience**: anyone authoring a new bench task under `skvm-data/tasks/**/` that
needs custom evaluation (anything beyond plain `script` / `file-check` /
`llm-judge`).

**Status**: active contracts. Enforced by `src/bench/evaluators/junit-grade.ts`
and `src/bench/evaluators/python-grade.ts`.

---

## 0. Two evaluators, one decision

SkVM ships two custom evaluators for multi-criterion grading. Most tasks
should pick one of them, not invent a third:

| Evaluator | Use when | Authored as |
|---|---|---|
| **`junit-grade`** | Grader is "run a bun test file, match criteria to testcase names, average the results" | Declarative JSON payload inline in `task.json` |
| **`python-grade`** | Grader needs real Python: numerical tolerance, image diff, parsing beyond junit, domain libraries (PIL, openpyxl, pandas, …) | Sibling `grade.py` file |

### Decision rule

**Default to `junit-grade`**. Only reach for `python-grade` when your
evaluation logic satisfies at least one of:

1. You need numerical tolerance (`math.isclose`, `abs(x - y) < ε`) — bun
   test's `expect(x).toBe(y)` is strict equality only.
2. You need a Python library to read the workspace output (PIL for image
   comparison, openpyxl / pandas for spreadsheet invariants, pypdf for PDF
   text extraction, …).
3. You need to inspect the agent's `transcript` (conversation history),
   not just the files it wrote.
4. Your output format is not amenable to test-file assertions — e.g. you
   need to parse a custom DSL, a binary format, or a non-deterministic
   output whose shape varies across runs.

If none of those apply, use `junit-grade`. The 184 tasks that previously
used copy-pasted "run bun test + regex match" grade.py boilerplate have
been migrated to `junit-grade` — there's no longer a "I'll start from a
neighbor's grade.py" path that regresses into cookie-cutter Python.

### Why this split matters

The evaluators are not equivalent with a tradeoff — they solve genuinely
different problems. `junit-grade` is pure configuration, statically
validated by Zod at task load time, zero Python process per run.
`python-grade` is an escape hatch for authors who need real code. Mixing
them up (writing Python for what should be declarative, or vice versa) is
how you end up with 184 broken grade.py files.

---

## 1. `junit-grade` — declarative bun-test grader

### 1.1 Payload shape

Inline in `task.json` under a `custom` criterion:

```json
{
  "method": "custom",
  "evaluatorId": "junit-grade",
  "id": "custom-0",
  "name": "Automated Grade",
  "weight": 0.7,
  "payload": {
    "testFile": "agile-product-owner_task_01.test.ts",
    "criteria": [
      {
        "id": "backlog-exists",
        "weight": 0.06,
        "description": "backlog.json is present at workspace root as a real file",
        "testPattern": "backlog.json > file exists"
      },
      {
        "id": "story-count",
        "weight": 0.10,
        "description": "backlog contains exactly 5 user stories — not 4, not 6",
        "testPattern": "exactly 5 user stories"
      }
    ]
  }
}
```

The Zod schema is in `src/bench/evaluators/junit-grade.ts`
(`JunitGradePayloadSchema`). It is the authoritative contract and fails
tasks at load time (inside `hydrateEvalPayloads`, before any adapter runs
— so you can't waste LLM tokens on a task with a bad payload).

### 1.2 Hard rules (validated by the schema)

| Rule | Failure message (abbreviated) |
|---|---|
| `testFile` is a non-empty string | `testFile must be non-empty` |
| `criteria` is a non-empty array | `criteria must be a non-empty array` |
| Every criterion has `id`, `weight`, `description`, `testPattern` — all non-empty | Zod per-field errors |
| `Σ weight == 1.0 ± 1e-3` | `criterion weights must sum to 1.0 ± 1e-3, got <sum>` |
| All `id` values are unique | `duplicate criterion id: "<id>"` |
| Each `testPattern` alternative (split on unescaped `\|`) compiles as a JS regex | `criterion <id>: invalid regex alternative "<alt>": <reason>` |
| `testPattern` has at least one non-empty alternative | `criterion <id>: testPattern has no non-empty alternatives` |

Load-time validation means authoring bugs surface at `bun run skvm bench`
startup, before the first LLM call. There is no "hope it runs at eval
time" path.

### 1.3 How matching works

At bench time the evaluator spawns
`bun test <testFile> --reporter=junit --reporter-outfile=<tmp>/_junit_results.xml`
from the task's workDir, so a test can read the agent's output by relative
path. It parses the emitted junit XML and builds a
`{classname > name: pass/fail}` map over every `<testcase>`.

Two things about that workDir, which the agent can write to freely:

- The results XML is written to a harness-owned temp directory, never into
  the workDir. An agent that pre-creates a read-only `_junit_results.xml`
  full of passing testcases would otherwise have it parsed as the verdict.
- Agent-authored `bunfig.toml` / `bunfig.test.toml` are moved aside for the
  duration of the run and restored afterwards. Bun reads bunfig from cwd,
  and a `[test] preload` entry executes inside the grading process — where
  the test file's path is visible in `process.argv`.

For each criterion it splits `testPattern` on top-level `|` (respecting
`\|` as a literal pipe) and runs each alternative as a case-insensitive
JS regex over every full-name. Testcases that match at least one
alternative are collected; the criterion's score is
`passed / matched` (or `0.0` if nothing matched, with a
`"no tests matched pattern ..."` reason on the checkpoint).

The weighted total across all criteria becomes the evaluator's `score`
field; each criterion becomes one `EvalCheckpoint` with
`{name, score, weight, description, reason}`.

### 1.4 When to split on `|` vs use regex alternation

Both work; the difference is pragmatic:

- **Top-level `|`** (e.g. `"foo|bar"`): each alternative is tried
  independently with `re.search`. If either matches, the testcase is
  counted. Use this when the alternatives describe totally different test
  names ("old format name | new format name after a bun update").
- **Inline regex alternation** (e.g. `"(foo|bar) passes"`): standard regex
  alternation inside a single pattern. Use this when the alternatives are
  part of a larger pattern ("either 'foo' or 'bar' prefix, both followed
  by 'passes'").
- **Literal pipe** (`\|`): when you need to match a pipe character in the
  testcase name itself (e.g. a CLI tool's output `"Version: 1.0.0 | Data:"`).
  Write it as `"Version: 1\\.0\\.0 \\| Data:"` and `splitAlternatives` will
  treat the escaped pipe as a literal character rather than an alternative
  boundary.

### 1.5 Authoring a new junit-grade task

1. Decide where the test file lives. `fixtures/` (the default) is copied
   into the agent's workDir, so the agent can read the test and any
   `expected/` or golden files beside it — fine for a test that only
   inspects the agent's output, wrong when the test embeds the answer. Set
   `testFileFrom: "task"` to resolve `testFile` and its siblings against the
   task directory instead, which is never copied into the workDir. Note that
   `import.meta.dirname` and relative imports then resolve inside the task
   directory, while `cwd` stays the workDir.

2. Write your `.test.ts` file (under `fixtures/` or at the task root, per
   step 1) and verify it runs against a reference solution:
   `cd <workdir> && bun test`.
3. For each independent sub-check in your test file, pick a short kebab-
   case `id`, a `weight` (all weights must sum to 1.0), a one-sentence
   `description` that reads well to someone who has never seen the task,
   and a `testPattern` regex that uniquely selects the testcase(s) for
   this check via `classname > name` full-name matching.
4. Put the payload under the `custom` criterion in `task.json`.
5. Run `bun test` — the integration tests in
   `test/bench/evaluators/junit-grade-integration.test.ts` load every
   task via `loadTasks` and will fail loudly if your payload doesn't
   schema-validate.

---

## 2. `python-grade` — custom Python grader

### 2.1 Contract

`grade(transcript, workspace_path)` must return **a list of criterion records**.

```python
def grade(transcript, workspace_path):
    return [
        {
            "id":          str,              # required, unique within this list
            "score":       float,             # required, in [0.0, 1.0]
            "weight":      float,             # required, all weights must sum to 1.0
            "description": str,               # optional but strongly encouraged
            "details":     str,               # optional; omit when score == 1.0
        },
        ...
    ]
```

### 2.2 Hard rules (validated by the bridge at `src/bench/evaluators/python-grade.ts`)

| Rule | Failure message |
|---|---|
| Return value must be a `list` | `grade() must return a list of criterion records, got <type>` |
| Each element must be a `dict` | `record N is not a dict: ...` |
| Each element must have `id`, `score`, `weight` | `record N (<id>) missing required field '<field>'` |
| `id` values must be unique | `duplicate criterion id: '<id>'` |
| `score` must be numeric and in `[0, 1]` | `record <id> score <v> not in [0, 1]` |
| `weight` must be numeric and `>= 0` | `record <id> has negative weight <v>` |
| `Σ weight` must equal `1.0` (tol = 1e-3) | `criterion weights must sum to 1.0, got <sum>` |
| List must be non-empty | `grade() returned an empty list` |

On any violation the bridge logs a clear error, emits score `0.0`, and
the task condition is marked failed. There is no silent fallback.

### 2.3 Field semantics (shared with junit-grade)

- **`id`**: short, stable, kebab-case. Used as the stable key for
  jit-optimize so it can correlate the same criterion across rounds. Do
  not rename IDs casually — history entries reference them.
- **`score`**: pass/fail style logic (`1.0` or `0.0`) is the default.
  Partial credit (e.g. `0.5`) is fine when one sub-check has a natural
  spectrum, but avoid fake-precise values like `0.47`.
- **`weight`**: *relative importance of this criterion inside this one
  task*. Higher weight = more pressure for the agent to get this right.
  Weights are the main knob authors use to say "this is the thing being
  tested, the rest is schema plumbing".
- **`description`**: one sentence describing *what this criterion tests
  and why it matters*. **This text is shown to the jit-optimize optimizer
  LLM**, so write it for that audience: specific, observable, free of
  internal jargon. Include the underlying *invariant*, not just the test
  name.
  - Bad: `"posted-counts correct"`
  - Good: `"Posted column contains plain integer transaction counts per quarter, not formulas"`
- **`details`**: one sentence explaining *why* this specific run scored
  below `1.0`. Populate when you can (e.g. `"expected 28, got =COUNTIFS(...)"`).
  Omit when the criterion passed.

### 2.4 Reference implementations

See the following for canonical python-grade patterns:

- `skvm-data/tasks/excel-xlsx_task_01/grade.py` — openpyxl spreadsheet
  inspection with numerical tolerance and cross-sheet invariants.
- `skvm-data/tasks/image_task_01/grade.py` — PIL image comparison.
- `skvm-data/tasks/calendar_task_01/grade.py` — structured parsing of a
  date-heavy output with numerical tolerance on time differences.

### 2.5 Minimal example

```python
def grade(transcript, workspace_path):
    import os
    report_ok = os.path.exists(os.path.join(workspace_path, "report.md"))
    return [
        {
            "id": "report-exists",
            "score": 1.0 if report_ok else 0.0,
            "weight": 1.0,
            "description": "report.md exists at the workspace root",
        },
    ]
```

Single-criterion tasks still follow the protocol. `weight: 1.0` is
required even when there's only one record.

### 2.6 Authoring checklist

Before committing a new `grade.py`:

- [ ] You actually need Python (see the decision rule in §0 — if not, use
      `junit-grade` instead).
- [ ] `grade()` returns a list (not a dict, not a tuple, not a generator).
- [ ] Every record has `id`, `score`, `weight`.
- [ ] All IDs are unique and stable (kebab-case recommended).
- [ ] `sum(c["weight"] for c in records) == 1.0`.
- [ ] `description` is filled in for every criterion, reads like it was
      written for someone who never saw this task before.
- [ ] The reference solution for this task scores `1.0` overall.
- [ ] A deliberately broken solution scores `<1.0` with meaningful
      `details` strings for the failing criteria.

---

## 3. Where the data goes after grading

Understanding this helps when you're debugging why a criterion doesn't
appear where you expect. Both evaluators emit the same downstream shape:

```
grade result (list of records / junit checkpoints)
    │
    ▼
src/bench/evaluators/{python,junit}-grade.ts: validates records and returns
    Omit<EvalResult, "criterion"> with:
    - score          = Σ(weight · score)           (weighted average)
    - details        = "id1: 0.00, id2: 1.00, ... (avg=0.73)"
    - checkpoints[]  = one EvalCheckpoint per record
        { name, score, weight, description, reason }
    │
    ▼
src/framework/evaluator.ts:evaluateCustom:
    attaches the upstream `criterion` (id, name, weight, payload) onto
    the result — the evaluator cannot forge these fields
    │
    ├──▶ bench/conditions.ts: wraps into ConditionResult.evalDetails
    │     └──▶ bench/reporter.ts: renders per-checkpoint lines
    │           "[~] totals-correct w=0.20: 0.00 — 4 of 4 tests failed ..."
    │
    └──▶ jit-optimize/evidence.ts: buildEvidenceCriteria()
          └──▶ flattens EvalResult.checkpoints into EvidenceCriterion[]
                (one entry per grade record, weights renormalized to sum to 1
                across the whole task when multiple top-level eval entries exist)
                │
                └──▶ workspace.ts: renderEvidenceMarkdown
                      writes .optimize/evidence-N.md sections like:
                        ### ✗ totals-correct (weight 20.0%, score 0.00)
                        - id: `custom-0/totals-correct`
                        - method: custom
                        - what it tests: Total column equals ...
                        - why below max: 4 of 4 tests failed ...
```

The optimizer agent sees the rendered markdown. Good `description` and
`details` text is literally the input that drives root-cause analysis in
jit-optimize. Both evaluators contribute to the same evidence stream; the
optimizer doesn't know or care which one produced which checkpoint.

---

## 4. How the evaluator finds your grader

### 4.1 `junit-grade` — inline payload only

The payload lives inside `task.json` directly. There is no sibling file.
`hydrateEvalPayloads` in `src/framework/payload.ts` sees that
`criterion.payload` is already set and calls the evaluator's
`validatePayload` hook to Zod-parse it. A schema violation throws with a
path like:

```
[junit-grade] payload validation failed in skvm-data/tasks/<task_id>:
  criterion weights must sum to 1.0 ± 1e-3, got 0.9
```

Round-tripping via `writeTask` is symmetric — the payload serializes back
into `task.json` unchanged.

### 4.2 `python-grade` — sibling file

`grade.py` is authored as a sibling file next to `task.json`. At load
time the loaders (`src/bench/loader.ts`, `src/bench/custom-plan.ts`,
`src/jit-optimize/task-source.ts`) call `hydrateEvalPayloads`, which
dispatches to python-grade's `loadPayload` hook, reads the sibling
`grade.py`, and attaches its source to `criterion.payload`.

If you prefer to inline the grade source in `task.json` (e.g. for
programmatic task generation), write
`{"method": "custom", "evaluatorId": "python-grade", "payload": "<grade.py source>"}`
directly and omit the sibling file; the loader will see `payload` is
already set and skip the lookup.

---

## 5. Common mistakes

### 5.1 Cross-protocol confusion

| Symptom | Root cause | Fix |
|---|---|---|
| `grade() must return a list of criterion records, got dict` | You wrote a python-grade `grade.py` that returns a dict. This was the 184-file bug fixed by the junit-grade migration. | Return a list. If your grader is bun-test + regex matching, use `junit-grade` instead. |
| `[junit-grade] payload validation failed: criterion weights must sum to 1.0` | Arithmetic error when authoring or editing the payload. | Rebalance. Zod catches this at load time. |
| `[junit-grade] payload validation failed: invalid regex alternative` | `testPattern` has an unescaped bracket or a trailing backslash. | Fix the pattern. Use `\|` if you need a literal pipe. |
| Criterion appears in `task.json` but has no `description` | Phase 1 migration placeholder was never enriched. | Write a one-sentence description describing the invariant being checked. |

### 5.2 python-grade-specific

| Mistake | Bridge error |
|---|---|
| Returned a dict | `grade() must return a list of criterion records, got dict` |
| Forgot weight on one record | `record N (<id>) missing required field 'weight'` |
| Weights sum to 0.99 | `criterion weights must sum to 1.0, got 0.990000` |
| Two records share an id | `duplicate criterion id: '<id>'` |
| Score 1.5 (forgot to normalize) | `record <id> score 1.5 not in [0, 1]` |
| Raised an exception inside `grade()` | `grade() raised: <repr>` |
| Returned empty list | `grade() returned an empty list` |

All errors set the evaluator's score to `0.0` — there is no partial
credit when the protocol is violated. Fix the grader, do not work around
the error.

---

## 6. When not to use either

If the entire eval is one boolean, prefer `method: script` or
`method: file-check` in `task.json`. If the eval is a subjective rubric,
prefer `method: llm-judge` — don't wrap a judge call inside a custom
evaluator.

The custom evaluators are for structured, reproducible, multi-criterion
checks where you want *every* sub-check to be visible to the reporter
and the optimizer. For single-shot checks, the top-level methods exist
for a reason.
