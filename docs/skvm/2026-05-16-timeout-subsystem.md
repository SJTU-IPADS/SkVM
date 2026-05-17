# Timeout Subsystem — Design

**Status:** Approved design, awaiting implementation plan.
**Closes:** #22 (compiler agent loop timeout) — superseded by the unification.
**Related:** #19 (lands first, fixes the precedence bug independently), #18 (provides the did-you-mean hint that backs the hard-cut migration).

## Problem

SkVM has at least eight distinct "timeouts" scattered across the code, with inconsistent CLI exposure, inconsistent naming, and partially hardcoded defaults. The current state has three concrete failure modes:

1. **Naming split.** `skvm run` uses `--timeoutMs` (camelCase); `skvm bench` (after #19) uses `--timeout-ms` (kebab). PR #19 doubled down on the inconsistency rather than unifying. New commands inherit whichever spelling is nearby.
2. **Missing exposure.** `skvm aot-compile` and `skvm pipeline` have no way to override the compiler agent loop's hardcoded 5-minute timeout. Issue #22 documents this. `skvm jit-optimize`'s optimizer-agent timeout is hardcoded to 10 minutes in three places. `skvm profile` cannot override per-probe execution time.
3. **Defaults scattered.** Literals `120_000`, `180_000`, `300_000`, `600_000`, `900_000` live in seven different source files with no single authority on "how long should X take."

This design unifies the user-facing surface to a single `--timeout-ms` flag per command, centralizes defaults in one table, and refactors the call sites behind a small set of per-actor helper functions.

## Inventory: every timeout in the system

| # | Actor | Location | Default | Currently user-configurable |
|---|---|---|---|---|
| 1 | **Target adapter task execution** — harness solving one task | each adapter file's subprocess `timeout:` field | `TASK_FILE_DEFAULTS.timeoutMs = 120_000` | yes (`task.json`, CLI on `run`/`bench`/`jit-optimize` after #19) |
| 2 | **Compiler agent loop** — Pass 1 (rewrite-skill) editing SKILL.md | `src/compiler/passes/rewrite-skill/agent.ts:442` | `300_000` (hardcoded) | no (issue #22) |
| 3 | **Optimizer agent** — jit-optimize per-round skill rewriter | `src/jit-optimize/optimizer.ts:32`, `loop.ts:560`, `loop.ts:1060` | `600_000` (three separate literals) | no |
| 4 | **Task-gen agent** — `--task-source=synthetic` task synthesis | `src/jit-optimize/task-source.ts:204` | `900_000` (`TASK_GEN_TIMEOUT_MS`) | no |
| 5 | **Candidate-gen agent** — jit-boost template extractor | `src/jit-boost/candidates.ts:338` | `180_000` | no |
| 6 | **Profile probe execution** — `skvm profile` per-primitive microbenchmark | `src/profiler/index.ts:289`, `src/index.ts:302, 312, 887` | `300_000` (hardcoded) | no |
| 7 | **Subprocess / sidecar readiness** — `SIDECAR_READY_TIMEOUT_MS`, `HANDSHAKE_TIMEOUT_MS`, openclaw poll cap | various adapters | `60_000`–`600_000` | infrastructure, intentionally not exposed |
| 8 | **Tool-level / HTTP retry** — bash tool, fetch, provider backoff | `src/core/agent-tools.ts:101`, providers, adapters | `30_000`–`60_000` | infrastructure, intentionally not exposed |

The design covers categories 1–6. Categories 7 and 8 stay as internal constants — they limit lower-level operations (subprocess startup, HTTP retry) that have no meaningful user-facing knob.

## Mental model

Three candidate models were considered:

- **Per-command (one flag, command-defined meaning).** Every command has a single `--timeout-ms`; what it limits is fixed by the command. Simple, but `jit-optimize` runs two fundamentally different kinds of agent (per-task adapter + per-round optimizer) and one flag cannot serve both.
- **Per-actor (one flag per kind of agent).** `--task-timeout-ms`, `--compiler-timeout-ms`, `--optimizer-timeout-ms`, etc. Each command exposes the actors it actually runs. Maximum precision, maximum surface area.
- **Hierarchical (generic flag + per-actor overrides).** Generic `--timeout-ms` as a default for all agents in this command; per-actor overrides for power users.

**Decision: a hybrid biased toward the per-command model.** CLI surface is a single `--timeout-ms` per command, semantically defined as *"the per-loop ceiling on any agent loop within this command"*. Internally, the system still tracks five independent per-actor deadlines, but the CLI does not surface them individually.

Rationale:

- Only two of the five actors have concrete user demand for control: task execution (PR #19, existing `--timeoutMs`) and compiler (issue #22). The other three (`optimizer`, `task-gen`, `candidate-gen`) have no open issues. Exposing five named CLI flags pre-emptively is YAGNI.
- A bare `--timeout-ms` matches user instinct in commands with multiple agents: "give my whole jit-optimize run more time." The natural reading — *"cap any single agent loop at this value"* — is unambiguous as long as the help text states it.
- Per-actor override flags can be added as a strictly additive change when a concrete need surfaces. The internal helpers are already per-actor, so adding an override flag is a one-line CLI addition plus a parameter on one helper call.

## CLI design

Every command that runs a long-lived LLM agent loop exposes exactly one timeout flag: `--timeout-ms=<n>`. Its meaning is the same everywhere — a ceiling on each individual agent-loop execution within that command — but the set of loops it covers depends on the command.

| Command | Loops covered by `--timeout-ms` |
|---|---|
| `skvm run` | adapter task execution |
| `skvm bench` | adapter task execution; jit-boost candidate generation (when `--condition` includes jit-boost) |
| `skvm aot-compile` | compiler Pass 1 agent loop |
| `skvm pipeline` | profile-stage probe execution; compiler Pass 1 agent loop |
| `skvm jit-optimize` | per-task adapter execution; per-round optimizer agent; synthetic task-gen agent (when `--task-source=synthetic`) |
| `skvm profile` | per-probe adapter execution |

**Precedence**: CLI `--timeout-ms` > task.json `timeoutMs` (task-exec only) > built-in default for the actor.

**Help text** for each command must:

1. State the per-loop semantics explicitly: *"per-agent-loop ceiling, not a total wall time."*
2. List the loops the flag covers in this command.
3. List the built-in default per loop for commands that cover more than one.
4. Document precedence vs `task.json`'s `timeoutMs` for commands that read tasks.

Concrete help text drafts are recorded in the design discussion that produced this doc; an example for `jit-optimize`:

```
--timeout-ms=<n>      Per-agent-loop ceiling for this jit-optimize run (ms).
                      Applies to:
                        - each per-task adapter execution (default: 120000)
                        - each round's optimizer agent (default: 600000)
                        - the synthetic task-gen agent if used (default: 900000)
                      Each agent loop is timed independently — this is a
                      per-loop ceiling, not a total wall time.
```

### Removed flags

- `bench --timeout-mult` is removed. The flag multiplied each task's own `task.timeoutMs` by a scalar. In the actual dataset 213/216 task.json files have `timeoutMs: 300000` and the other three have `180000`, so variance is near zero and the multiplier is functionally equivalent to `--timeout-ms` for every realistic input. The group-level `timeout-mult` in custom-plan YAML is retained — per-group scaling in a config file remains expressive.
- `--timeoutMs` (camelCase) on `run` and `jit-optimize` is removed. Hard cut: invoking it raises an "unknown flag" error from the #18 handler with a "did you mean `--timeout-ms`" hint.
- `--maxSteps` (camelCase) on `jit-optimize` is removed in the same pass. Kebab form `--max-steps` is added; same hard-cut rationale.

## Internal architecture

A new module `src/core/timeouts.ts` becomes the single source of truth for default values and resolution logic.

```ts
import { TASK_FILE_DEFAULTS } from "./ui-defaults.ts"

/** Built-in defaults per actor (ms). Single source of truth. */
export const TIMEOUT_DEFAULTS = {
  taskExec:     TASK_FILE_DEFAULTS.timeoutMs,  // 120_000
  compiler:     300_000,
  optimizer:    600_000,
  taskGen:      900_000,
  candidateGen: 180_000,
} as const

export function resolveTaskTimeout(opts: {
  cli?: number
  task: { timeoutMs: number }
  multiplier?: number   // custom-plan YAML, NOT the removed --timeout-mult flag
}): number {
  if (opts.cli !== undefined) return opts.cli
  return opts.task.timeoutMs * (opts.multiplier ?? 1)
}

export function resolveCompilerTimeout(opts: { cli?: number }): number {
  return opts.cli ?? TIMEOUT_DEFAULTS.compiler
}

export function resolveOptimizerTimeout(opts: { cli?: number }): number {
  return opts.cli ?? TIMEOUT_DEFAULTS.optimizer
}

export function resolveTaskGenTimeout(opts: { cli?: number }): number {
  return opts.cli ?? TIMEOUT_DEFAULTS.taskGen
}

export function resolveCandidateGenTimeout(opts: { cli?: number }): number {
  return opts.cli ?? TIMEOUT_DEFAULTS.candidateGen
}
```

Each helper has an honest signature: `resolveCompilerTimeout` does not pretend to accept per-task data because the compiler has no task; `resolveTaskTimeout` accepts the multiplier only because custom-plan YAML still uses it. Adding a future per-actor CLI override is a strictly local change to one helper.

PR #19's `resolveTaskRuntime` in `src/core/task-runtime.ts` (returns `{ timeoutMs, maxSteps }`) keeps its shape but delegates the timeout half to `resolveTaskTimeout`. The `maxSteps` resolution logic is independent and unchanged.

### Call-site changes

| File | Change |
|---|---|
| `src/index.ts` | Each command's `runX` function parses `flags["timeout-ms"]` into a `cliTimeoutMs?: number` and passes it to the relevant helper. `RUN_KNOWN_FLAGS`, `COMPILE_KNOWN_FLAGS`, `PIPELINE_KNOWN_FLAGS`, `PROFILE_KNOWN_FLAGS`, `JIT_OPTIMIZE_KNOWN_FLAGS` get `"timeout-ms"`. `--timeoutMs` and `--maxSteps` entries are removed; `--max-steps` is added where `--maxSteps` was. Help text rewritten per the drafts above. |
| `src/compiler/types.ts` | `CompileOptions` gains `timeoutMs?: number`. |
| `src/compiler/passes/types.ts` | `PassContext` gains `timeoutMs: number` (required; orchestrator supplies it). |
| `src/compiler/index.ts` | `compileSkill` resolves `ctx.timeoutMs = opts.timeoutMs ?? TIMEOUT_DEFAULTS.compiler` and threads it through `PassContext`. |
| `src/compiler/passes/rewrite-skill/{index,agent}.ts` | `runPass1Agentic` accepts `timeoutMs`. The literal `300_000` on `agent.ts:442` is replaced. |
| `src/jit-optimize/optimizer.ts` | `DEFAULT_TIMEOUT_MS` deleted; `runOptimizer` uses `config.timeoutMs ?? TIMEOUT_DEFAULTS.optimizer` (or callers pre-resolve and pass it). |
| `src/jit-optimize/loop.ts` | Both `600_000` literals at `:560` and `:1060` replaced with the resolved value from `resolveOptimizerTimeout`. New `cliTimeoutMs` propagated from `runJitOptimize`. |
| `src/jit-optimize/task-source.ts` | `TASK_GEN_TIMEOUT_MS` constant deleted; call sites use `resolveTaskGenTimeout({ cli })`. |
| `src/jit-boost/candidates.ts` | Fallbacks `?? TASK_FILE_DEFAULTS.timeoutMs` and `?? 180_000` replaced with `TIMEOUT_DEFAULTS.taskExec` / `TIMEOUT_DEFAULTS.candidateGen`. |
| `src/profiler/index.ts`, `src/index.ts:302, 312, 887` | Hardcoded `timeoutMs: 300_000` in profile setup replaced with `resolveTaskTimeout` or `TIMEOUT_DEFAULTS.taskExec`. |
| `src/bench/index.ts` | `--timeout-mult` removed from `BENCH_KNOWN_FLAGS` and help text. |
| `src/bench/types.ts`, `src/bench/orchestrator.ts`, `src/bench/custom-plan.ts` | `BenchRunConfig.timeoutMult` stays for the YAML pathway; only the CLI source is removed. Orchestrator and custom-plan reader keep using it. |
| `src/core/task-runtime.ts` | `resolveTaskRuntime` internally calls `resolveTaskTimeout`. External shape unchanged. |

## Migration

Hard cut, in a single PR. Old flag names are not aliased.

- `skvm run --timeoutMs=600000` → `Error: unknown flag --timeoutMs. Did you mean --timeout-ms?` The user reruns with the kebab form.
- `skvm bench --timeout-mult=2` → unknown-flag error with no suggestion (the flag genuinely no longer exists).
- `skvm jit-optimize --maxSteps=50` → `Error: unknown flag --maxSteps. Did you mean --max-steps?`

Risk: any CI script or notebook depending on the old spellings breaks at first run. The error is loud and actionable. Release notes call this out explicitly.

## PR sequencing

1. **Land PR #19 as-is.** Independent precedence bug fix; valuable on its own; should not be blocked by this design's naming bikeshed.
2. **Unification PR** (this design's implementation). Closes #22. Acknowledges in its body that it removes the `--timeoutMs`/`--maxSteps` flags PR #19 just added, replacing them with the kebab equivalents. Reviewers see the apparent reversal explained.
3. **Filed separately**: a tracking issue for this design before the PR opens. Issue body links here.

## Test plan

- `test/core/timeouts.test.ts` — new. Each of the five `resolveX` helpers across the precedence matrix (cli only / task only / multiplier only / combined / none). Includes "cli given, multiplier ignored" for `resolveTaskTimeout`.
- `test/cli/timeout-ms-flags.test.ts` — new. For every command exposing `--timeout-ms`: `--timeout-ms=abc`, `--timeout-ms=0`, `--timeout-ms=-1` exit non-zero with the flag name in stderr.
- `test/cli/deprecated-flag-hints.test.ts` — new. `--timeoutMs=...` and `--maxSteps=...` on `run`/`jit-optimize` trigger the #18 unknown-flag handler; stderr contains "did you mean --timeout-ms" / "did you mean --max-steps".
- `test/compiler/timeout-passthrough.test.ts` — new. `compileSkill({ timeoutMs: 50 })` with a mock provider that sleeps 200 ms causes Pass 1 to abort on the first LLM call. Doubles as issue #22's test.
- `test/jit-optimize/optimizer-timeout-passthrough.test.ts` — new. `--timeout-ms=N` reaches `runOptimizer` via `config.timeoutMs`.
- `test/bench/timeout-mult-removed.test.ts` — new. `bench --timeout-mult=2` exits non-zero (unknown flag).
- Existing `test/core/task-runtime.test.ts` (added in #19) and `test/jit-optimize/cli-timeout-args.test.ts` are updated for the renamed flags but their precedence assertions remain unchanged.

## Non-goals

- **Actor-specific override flags** (`--compiler-timeout-ms`, `--optimizer-timeout-ms`, `--task-gen-timeout-ms`, `--candidate-gen-timeout-ms`). No open issue requests these. The internal helpers are already per-actor, so adding a CLI override later is roughly one line of flag parsing plus one helper-call argument. Deferred until a concrete need surfaces.
- **Subprocess startup / sidecar readiness / handshake timeouts** (`SIDECAR_READY_TIMEOUT_MS`, `HANDSHAKE_TIMEOUT_MS`, openclaw poll cap). Infrastructure timers on subprocess lifecycle, not on LLM agent work. Stay as named constants.
- **Tool-level timeouts** (bash tool 30 s, bare-agent fetch 30 s, provider retry backoff). Low-level operation limits with no meaningful user-facing knob.
- **Compiler Pass 1 `maxIterations: 15`**. This is an iteration cap, not a time cap. CLI exposes only the time dimension; the iteration cap stays internal.
- **Total wall-time ceiling** for an entire command (e.g., "cap the whole `jit-optimize` run at 1 hour"). Orthogonal to per-loop ceilings and would require a global deadline scheduler. Not addressed here.

## Open questions

None at design time. All decisions in the *Decisions summary* below were resolved during brainstorming and are reflected in the call-site table and help-text drafts above.

## Decisions summary

1. CLI surface: a single `--timeout-ms` per command. Semantics: per-loop ceiling on any agent loop in the command.
2. Five internal actors (task-exec, compiler, optimizer, task-gen, candidate-gen) tracked independently. CLI does not name them individually.
3. New module `src/core/timeouts.ts` with `TIMEOUT_DEFAULTS` table and five per-actor `resolveX` helpers.
4. Defaults: `taskExec=120_000` (delegated to `TASK_FILE_DEFAULTS.timeoutMs`), `compiler=300_000`, `optimizer=600_000`, `taskGen=900_000`, `candidateGen=180_000`.
5. Hard-cut migration. `--timeoutMs`, `--maxSteps`, `bench --timeout-mult` are deleted; the #18 handler covers the first two with did-you-mean hints.
6. Custom-plan YAML `timeout-mult` (group/item level) is retained.
7. PR sequencing: #19 lands first; one unification PR follows and closes #22.
