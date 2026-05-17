# Timeout Subsystem Unification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify SkVM's eight scattered timeouts behind a single `--timeout-ms` CLI flag (one per command) and a small set of per-actor helpers, closing #22 along the way.

**Architecture:** New module `src/core/timeouts.ts` holds `TIMEOUT_DEFAULTS` (single defaults table) and five per-actor resolver helpers (`resolveTaskTimeout`, `resolveCompilerTimeout`, `resolveOptimizerTimeout`, `resolveTaskGenTimeout`, `resolveCandidateGenTimeout`). Every command parses `flags["timeout-ms"]` into one `cliTimeoutMs` and routes it to whichever helpers apply. Old camelCase flags are deleted; the #18 "did you mean" handler covers migration.

**Tech Stack:** TypeScript, Bun, existing hand-rolled CLI in `src/index.ts` and `src/bench/index.ts`, existing `assertKnownFlags` from #18, existing `resolveTaskRuntime` from #19.

**Prerequisite:** PR #19 must be merged before this plan starts. The plan modifies files that PR #19 introduces (`src/core/task-runtime.ts`, `test/core/task-runtime.test.ts`) and removes CLI flags that PR #19 adds (`--timeoutMs` on `jit-optimize`, `--maxSteps` on `jit-optimize`). If #19 is not yet merged, pause this plan.

**Design doc:** `docs/skvm/2026-05-16-timeout-subsystem.md`. Refer to it for the full rationale; this plan implements the decisions there.

---

## File Structure

| Path | Role |
| --- | --- |
| `src/core/timeouts.ts` | **New.** `TIMEOUT_DEFAULTS` constant + 5 `resolveX` helpers. Single source of truth for default timeout values. |
| `test/core/timeouts.test.ts` | **New.** Precedence matrix tests for all 5 helpers. |
| `src/core/task-runtime.ts` | **Modify.** `resolveTaskRuntime` (from #19) delegates its timeout half to `resolveTaskTimeout`. External shape unchanged. |
| `src/compiler/types.ts` | **Modify.** `CompileOptions` gains `timeoutMs?: number`. |
| `src/compiler/passes/types.ts` | **Modify.** `PassContext` gains `timeoutMs: number` (required). |
| `src/compiler/index.ts` | **Modify.** `compileSkill` resolves `ctx.timeoutMs` and propagates it. |
| `src/compiler/passes/rewrite-skill/index.ts` | **Modify.** Pass `ctx.timeoutMs` to `runPass1Agentic`. |
| `src/compiler/passes/rewrite-skill/agent.ts` | **Modify.** `runPass1Agentic` accepts `timeoutMs`; line 442's `300_000` literal replaced. |
| `test/compiler/timeout-passthrough.test.ts` | **New.** Mock provider sleeps; assert Pass 1 aborts on deadline. Doubles as #22's test. |
| `src/index.ts` | **Modify.** Add `--timeout-ms` to `aot-compile`/`pipeline`/`profile`; rename `--timeoutMs` → `--timeout-ms` on `run`/`jit-optimize`; rename `--maxSteps` → `--max-steps` on `jit-optimize`. Replace 3 hardcoded profile literals (lines 302, 312, 887). Update help text everywhere. |
| `src/profiler/index.ts` | **Modify.** Replace `300_000` literal at line 289. |
| `src/jit-optimize/loop.ts` | **Modify.** Replace `600_000` literals at lines 560, 1060 with `resolveOptimizerTimeout`. Accept `cliTimeoutMs` in `RunTasksParams`. |
| `src/jit-optimize/optimizer.ts` | **Modify.** Delete `DEFAULT_TIMEOUT_MS`; use `TIMEOUT_DEFAULTS.optimizer`. |
| `src/jit-optimize/task-source.ts` | **Modify.** Delete `TASK_GEN_TIMEOUT_MS`; use `resolveTaskGenTimeout`. Accept `cliTimeoutMs`. |
| `src/jit-boost/candidates.ts` | **Modify.** Replace fallbacks at lines 39, 338 with `TIMEOUT_DEFAULTS.taskExec` / `TIMEOUT_DEFAULTS.candidateGen`. |
| `src/bench/index.ts` | **Modify.** Remove `"timeout-mult"` from `BENCH_KNOWN_FLAGS`; remove parsing; remove help text. |
| `src/bench/conditions.ts` | **Modify.** Pass `resolveCandidateGenTimeout({ cli: cliTimeoutMs })` to `generateBoostCandidates`/`generateTemplates` at the three call sites. |
| `test/cli/deprecated-flag-hints.test.ts` | **New.** End-to-end smoke: removed flags exit non-zero with "did you mean" suggestion. |
| `test/bench/timeout-mult-removed.test.ts` | **New.** `bench --timeout-mult=2` exits non-zero (unknown flag). |
| `test/core/task-runtime.test.ts` | **Modify.** Existing assertions still hold; tests untouched unless the public shape changes (it shouldn't). |
| `test/jit-optimize/cli-timeout-args.test.ts` | **Modify.** Rename flag references from `--timeoutMs`/`--maxSteps` to `--timeout-ms`/`--max-steps`. |

The helper module is intentionally small — one constant + five thin functions — because adding actor-specific CLI overrides in the future should be a strictly local change. The compiler types ripple through three files (`CompileOptions` → `PassContext` → `runPass1Agentic`) by necessity; that's the smallest plumbing the existing pass architecture allows.

---

## Task 1 — Create `src/core/timeouts.ts` (foundation, TDD)

**Files:**
- Create: `src/core/timeouts.ts`
- Create: `test/core/timeouts.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/core/timeouts.test.ts
import { describe, test, expect } from "bun:test"
import {
  TIMEOUT_DEFAULTS,
  resolveTaskTimeout,
  resolveCompilerTimeout,
  resolveOptimizerTimeout,
  resolveTaskGenTimeout,
  resolveCandidateGenTimeout,
} from "../../src/core/timeouts.ts"
import { TASK_FILE_DEFAULTS } from "../../src/core/ui-defaults.ts"

describe("TIMEOUT_DEFAULTS", () => {
  test("taskExec mirrors TASK_FILE_DEFAULTS.timeoutMs", () => {
    expect(TIMEOUT_DEFAULTS.taskExec).toBe(TASK_FILE_DEFAULTS.timeoutMs)
  })
  test("documented numeric defaults", () => {
    expect(TIMEOUT_DEFAULTS.compiler).toBe(300_000)
    expect(TIMEOUT_DEFAULTS.optimizer).toBe(600_000)
    expect(TIMEOUT_DEFAULTS.taskGen).toBe(900_000)
    expect(TIMEOUT_DEFAULTS.candidateGen).toBe(180_000)
  })
})

describe("resolveTaskTimeout", () => {
  test("cli wins outright when given", () => {
    expect(resolveTaskTimeout({ cli: 5000, task: { timeoutMs: 999 }, multiplier: 99 })).toBe(5000)
  })
  test("falls back to task value", () => {
    expect(resolveTaskTimeout({ task: { timeoutMs: 7000 } })).toBe(7000)
  })
  test("applies multiplier to task value when cli absent", () => {
    expect(resolveTaskTimeout({ task: { timeoutMs: 1000 }, multiplier: 2.5 })).toBe(2500)
  })
  test("multiplier defaults to 1 when undefined", () => {
    expect(resolveTaskTimeout({ task: { timeoutMs: 4242 } })).toBe(4242)
  })
  test("multiplier is ignored when cli is given", () => {
    expect(resolveTaskTimeout({ cli: 100, task: { timeoutMs: 1000 }, multiplier: 5 })).toBe(100)
  })
})

describe("resolveCompilerTimeout", () => {
  test("cli wins", () => {
    expect(resolveCompilerTimeout({ cli: 12345 })).toBe(12345)
  })
  test("falls back to TIMEOUT_DEFAULTS.compiler", () => {
    expect(resolveCompilerTimeout({})).toBe(TIMEOUT_DEFAULTS.compiler)
  })
})

describe("resolveOptimizerTimeout", () => {
  test("cli wins", () => {
    expect(resolveOptimizerTimeout({ cli: 22222 })).toBe(22222)
  })
  test("falls back to TIMEOUT_DEFAULTS.optimizer", () => {
    expect(resolveOptimizerTimeout({})).toBe(TIMEOUT_DEFAULTS.optimizer)
  })
})

describe("resolveTaskGenTimeout", () => {
  test("cli wins", () => {
    expect(resolveTaskGenTimeout({ cli: 33333 })).toBe(33333)
  })
  test("falls back to TIMEOUT_DEFAULTS.taskGen", () => {
    expect(resolveTaskGenTimeout({})).toBe(TIMEOUT_DEFAULTS.taskGen)
  })
})

describe("resolveCandidateGenTimeout", () => {
  test("cli wins", () => {
    expect(resolveCandidateGenTimeout({ cli: 44444 })).toBe(44444)
  })
  test("falls back to TIMEOUT_DEFAULTS.candidateGen", () => {
    expect(resolveCandidateGenTimeout({})).toBe(TIMEOUT_DEFAULTS.candidateGen)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/core/timeouts.test.ts`
Expected: FAIL — module `src/core/timeouts.ts` does not exist yet.

- [ ] **Step 3: Implement the module**

```ts
// src/core/timeouts.ts
import { TASK_FILE_DEFAULTS } from "./ui-defaults.ts"

/**
 * Built-in defaults per actor (ms). Single source of truth for "how long
 * should X reasonably take if the user hasn't said otherwise."
 *
 * - taskExec: target adapter solving one task (mirrors TASK_FILE_DEFAULTS so
 *   the schema default and the actor default stay synchronized).
 * - compiler: compiler Pass 1 (rewrite-skill) agent loop.
 * - optimizer: jit-optimize per-round skill rewriter.
 * - taskGen: jit-optimize synthetic task-generation agent.
 * - candidateGen: jit-boost candidate-extraction agent.
 */
export const TIMEOUT_DEFAULTS = {
  taskExec:     TASK_FILE_DEFAULTS.timeoutMs,
  compiler:     300_000,
  optimizer:    600_000,
  taskGen:      900_000,
  candidateGen: 180_000,
} as const

/**
 * Resolve the effective timeout for one task-execution run.
 *
 * Precedence: CLI absolute > task.timeoutMs × multiplier > task.timeoutMs.
 * `multiplier` is sourced from custom-plan YAML's group-level `timeout-mult`
 * (the CLI `--timeout-mult` flag has been removed). When `cli` is given, the
 * multiplier is ignored — absolute beats relative.
 */
export function resolveTaskTimeout(opts: {
  cli?: number
  task: { timeoutMs: number }
  multiplier?: number
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/core/timeouts.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/timeouts.ts test/core/timeouts.test.ts
git commit -m "core: add timeouts module with TIMEOUT_DEFAULTS and per-actor resolvers"
```

---

## Task 2 — Delegate `resolveTaskRuntime`'s timeout half to `resolveTaskTimeout`

**Files:**
- Modify: `src/core/task-runtime.ts`
- Verify: `test/core/task-runtime.test.ts` (existing, from PR #19; tests stay green)

- [ ] **Step 1: Confirm the current shape**

Run: `grep -n "resolveTaskRuntime\|timeoutMs" src/core/task-runtime.ts`
Expected: see PR #19's implementation. The function computes effective `timeoutMs` and `maxSteps` from a CLI/task/multiplier mix.

- [ ] **Step 2: Modify `resolveTaskRuntime` to delegate the timeout computation**

Replace the inline timeout-resolution branch with a call into `resolveTaskTimeout`. The maxSteps branch stays untouched. Concretely, at the timeout-computation site in `src/core/task-runtime.ts`, replace:

```ts
// Before (PR #19 inline form):
const timeoutMs = overrides.timeoutMs !== undefined
  ? overrides.timeoutMs
  : task.timeoutMs * (overrides.timeoutMult ?? 1)
```

With:

```ts
// After:
import { resolveTaskTimeout } from "./timeouts.ts"
// ...
const timeoutMs = resolveTaskTimeout({
  cli: overrides.timeoutMs,
  task: { timeoutMs: task.timeoutMs },
  multiplier: overrides.timeoutMult,
})
```

(Adjust to match the exact variable names in #19's merged code; the semantics must be identical to before.)

- [ ] **Step 3: Run the existing tests to verify nothing regressed**

Run: `bun test test/core/task-runtime.test.ts`
Expected: PASS — all 7 of PR #19's tests still green.

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/task-runtime.ts
git commit -m "core: delegate resolveTaskRuntime's timeout half to resolveTaskTimeout"
```

---

## Task 3 — Plumb compiler timeout (issue #22 internals, TDD)

**Files:**
- Modify: `src/compiler/types.ts`
- Modify: `src/compiler/passes/types.ts`
- Modify: `src/compiler/index.ts`
- Modify: `src/compiler/passes/rewrite-skill/index.ts`
- Modify: `src/compiler/passes/rewrite-skill/agent.ts`
- Create: `test/compiler/timeout-passthrough.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/compiler/timeout-passthrough.test.ts
import { describe, test, expect } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { compileSkill } from "../../src/compiler/index.ts"
import type { LLMProvider } from "../../src/providers/types.ts"
import type { TCP } from "../../src/core/types.ts"

describe("compileSkill: compiler timeout passthrough", () => {
  test("aborts Pass 1 when provider exceeds the configured timeout", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "skvm-compiler-timeout-"))
    writeFileSync(path.join(tmp, "SKILL.md"), "# Test skill\n\nDo a thing.\n")

    let providerCallCount = 0
    const slowProvider: LLMProvider = {
      async chat() {
        providerCallCount++
        await new Promise((r) => setTimeout(r, 300))
        return { content: "", toolCalls: [], stopReason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } }
      },
    } as unknown as LLMProvider

    const tcp: TCP = {
      model: "test/dummy",
      profiledAt: new Date().toISOString(),
      schemaVersion: 1,
      summary: { l1: {}, l2: {}, l3: {} },
      details: [
        // At least one detail with a failing primitive so analyzeGaps yields gaps.
        { primitiveId: "p1", levelResults: [{ level: 1, passRate: 0, failureArtifacts: [] }], convLogDir: undefined as unknown as string },
      ],
    } as unknown as TCP

    try {
      await compileSkill({
        skillPath: path.join(tmp, "SKILL.md"),
        skillContent: "# Test skill\n",
        skillDir: tmp,
        skillName: "test",
        tcp,
        model: "test/dummy",
        harness: "bare-agent",
        timeoutMs: 50,
      }, slowProvider, { showSpinner: false })
    } catch (err) {
      // Expected: agent loop deadline trips. Specific error message is not critical;
      // we just care that it surfaces rather than running for 5 minutes.
    }

    expect(providerCallCount).toBeLessThanOrEqual(2)

    rmSync(tmp, { recursive: true, force: true })
  }, 5_000) // hard cap: if our timeout=50 didn't fire, this assertion would hang for 5min
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/compiler/timeout-passthrough.test.ts`
Expected: FAIL — `compileSkill` does not yet accept `timeoutMs` in `CompileOptions`, or the option is ignored and the test times out.

- [ ] **Step 3: Add `timeoutMs?: number` to `CompileOptions`**

In `src/compiler/types.ts`, inside the `CompileOptions` interface (around line 94+), append:

```ts
export interface CompileOptions {
  // ...existing fields...
  /** Optional override for the per-pass agent-loop timeout in milliseconds.
   *  When omitted, each pass uses TIMEOUT_DEFAULTS.compiler. */
  timeoutMs?: number
}
```

- [ ] **Step 4: Add `timeoutMs: number` to `PassContext`**

In `src/compiler/passes/types.ts`, inside the `PassContext` interface (around line 20+), append:

```ts
export interface PassContext {
  // ...existing fields...
  /** Resolved agent-loop deadline (ms) for this pass run. The orchestrator
   *  fills it from CompileOptions.timeoutMs, falling back to the per-actor
   *  default. */
  timeoutMs: number
}
```

- [ ] **Step 5: Resolve and propagate `timeoutMs` in `compileSkill`**

In `src/compiler/index.ts`, near the top:

```ts
import { resolveCompilerTimeout } from "../core/timeouts.ts"
```

In the loop that builds each `PassContext` (around line 88), add the new field:

```ts
const ctx: PassContext = {
  skillName,
  workDir,
  skillContent,
  tcp: opts.tcp,
  model: opts.model,
  harness: opts.harness,
  provider: wrappedProvider,
  failureContext: opts.failureContext,
  artifacts: store,
  timeoutMs: resolveCompilerTimeout({ cli: opts.timeoutMs }),
}
```

- [ ] **Step 6: Thread `ctx.timeoutMs` through `rewriteSkillPass.run`**

In `src/compiler/passes/rewrite-skill/index.ts`, update the call:

```ts
async run(ctx: PassContext): Promise<PassOutput> {
  const result = await runPass1Agentic(
    ctx.skillContent,
    ctx.tcp,
    ctx.provider,
    ctx.workDir,
    ctx.failureContext,
    ctx.timeoutMs,
  )
  // ...rest unchanged
}
```

- [ ] **Step 7: Make `runPass1Agentic` accept `timeoutMs` and drop the hardcoded literal**

In `src/compiler/passes/rewrite-skill/agent.ts`, change the function signature to accept the new parameter and use it in the agent-loop config (replaces the literal at line 442):

```ts
export async function runPass1Agentic(
  skillContent: string,
  tcp: TCP,
  provider: LLMProvider,
  workDir: string,
  failureContext: FailureContext | undefined,
  timeoutMs: number,
): Promise<Pass1Result> {
  // ...existing body unchanged until the runAgentLoop call...
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
  // ...rest unchanged
}
```

- [ ] **Step 8: Run the new test to verify it passes**

Run: `bun test test/compiler/timeout-passthrough.test.ts`
Expected: PASS — Pass 1 aborts on the 50 ms deadline; providerCallCount ≤ 2.

- [ ] **Step 9: Run the full compiler test suite to verify no regression**

Run: `bun test test/compiler/`
Expected: all pass.

- [ ] **Step 10: Typecheck**

Run: `bunx tsc --noEmit`
Expected: clean. The new required field on `PassContext` may surface call sites elsewhere — if so, supply `resolveCompilerTimeout({})` until they're explicitly wired in later tasks.

- [ ] **Step 11: Commit**

```bash
git add src/compiler/types.ts src/compiler/passes/types.ts src/compiler/index.ts \
        src/compiler/passes/rewrite-skill/index.ts src/compiler/passes/rewrite-skill/agent.ts \
        test/compiler/timeout-passthrough.test.ts
git commit -m "compiler: parameterize Pass 1 agent loop timeout via CompileOptions"
```

---

## Task 4 — Add `--timeout-ms` to `aot-compile` and `pipeline`

**Files:**
- Modify: `src/index.ts` (`COMPILE_KNOWN_FLAGS`, `runCompile`, `PIPELINE_KNOWN_FLAGS`, `runPipeline`, help text)

- [ ] **Step 1: Add `"timeout-ms"` to `COMPILE_KNOWN_FLAGS`**

In `src/index.ts`, near the `COMPILE_KNOWN_FLAGS` declaration (around line 522), add `"timeout-ms"` to the set:

```ts
const COMPILE_KNOWN_FLAGS: ReadonlySet<string> = new Set([
  // ...existing entries...
  "timeout-ms",
])
```

- [ ] **Step 2: Parse `--timeout-ms` in `runCompile`**

After the help-text branch in `runCompile`, before the `compileSkill` call, add the parser:

```ts
let cliCompilerTimeoutMs: number | undefined
if (flags["timeout-ms"] !== undefined) {
  const n = parseInt(flags["timeout-ms"], 10)
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`aot-compile: --timeout-ms must be a positive integer (got "${flags["timeout-ms"]}")`)
    process.exit(1)
  }
  cliCompilerTimeoutMs = n
}
```

Then thread it into the existing `compileSkill({...})` call at line 708 by adding the field:

```ts
const result = await compileSkill({
  // ...existing fields...
  timeoutMs: cliCompilerTimeoutMs,
}, ...)
```

- [ ] **Step 3: Add the help-text line in `runCompile`**

Inside the multi-line help string for `aot-compile`, add (placed near other LLM/compiler options):

```
  --timeout-ms=<n>      Cap on the compiler agent loop (Pass 1, rewrite-skill)
                        while it edits SKILL.md (ms). Default: 300000.
```

- [ ] **Step 4: Repeat the same three changes for `pipeline`**

In `PIPELINE_KNOWN_FLAGS` (around line 769), add `"timeout-ms"`. In `runPipeline`, parse `flags["timeout-ms"]` into `cliPipelineTimeoutMs` and pass it both to the compile call (line 923) as `timeoutMs: cliPipelineTimeoutMs` AND to the profile-setup branch as the per-probe timeout. Help text:

```
  --timeout-ms=<n>      Per-agent-loop ceiling for this pipeline run (ms).
                        Applies to BOTH the profile stage's per-probe agent
                        execution AND the compiler agent loop. Each is timed
                        independently — this is a per-loop ceiling, not a
                        total wall time.
```

For the pipeline profile-stage wiring, the existing call inside `runPipeline` that builds an `adapterConfig` for profiling needs its `timeoutMs` to come from `cliPipelineTimeoutMs ?? TIMEOUT_DEFAULTS.taskExec`. Add the import at the top of `src/index.ts`:

```ts
import { TIMEOUT_DEFAULTS, resolveTaskTimeout } from "./core/timeouts.ts"
```

- [ ] **Step 5: Smoke-test the new flags from the CLI**

Run: `bun run skvm aot-compile --timeout-ms=abc 2>&1 | head -3`
Expected: error message containing `--timeout-ms` and `positive integer`, exit non-zero.

Run: `bun run skvm aot-compile --help 2>&1 | grep timeout-ms`
Expected: the new help line appears.

Run: `bun run skvm pipeline --help 2>&1 | grep timeout-ms`
Expected: the new help line appears.

- [ ] **Step 6: Typecheck and run compiler tests**

Run: `bunx tsc --noEmit`
Expected: clean.

Run: `bun test test/compiler/`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "cli: add --timeout-ms to aot-compile and pipeline (closes #22)"
```

---

## Task 5 — Add `--timeout-ms` to `profile` and clean profile-stage literals

**Files:**
- Modify: `src/index.ts` (`PROFILE_KNOWN_FLAGS`, `runProfile`, lines 302/312/887, help text)
- Modify: `src/profiler/index.ts` (line 289)

- [ ] **Step 1: Add `"timeout-ms"` to `PROFILE_KNOWN_FLAGS`**

In `src/index.ts` around line 144:

```ts
const PROFILE_KNOWN_FLAGS: ReadonlySet<string> = new Set([
  // ...existing entries...
  "timeout-ms",
])
```

- [ ] **Step 2: Parse `--timeout-ms` in `runProfile`**

Insert near other flag parses (around line 200):

```ts
let cliProfileTimeoutMs: number | undefined
if (flags["timeout-ms"] !== undefined) {
  const n = parseInt(flags["timeout-ms"], 10)
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`profile: --timeout-ms must be a positive integer (got "${flags["timeout-ms"]}")`)
    process.exit(1)
  }
  cliProfileTimeoutMs = n
}
const probeTimeoutMs = cliProfileTimeoutMs ?? TIMEOUT_DEFAULTS.taskExec
```

(If the `TIMEOUT_DEFAULTS` import was not added by Task 4, add it now.)

- [ ] **Step 3: Replace the three hardcoded `300_000` literals in `runProfile`'s adapter-config blocks**

In `src/index.ts`:
- Line 302: `adapterConfig: { model: job.model, maxSteps: 25, timeoutMs: 300_000, mode: adapterMode }` → replace `300_000` with `probeTimeoutMs`.
- Line 312: same substitution inside the `adapterFactory` arrow function.
- Line 887 (the parallel/batched branch in `runProfile`): same substitution.

- [ ] **Step 4: Replace the `300_000` literal in `src/profiler/index.ts:289`**

`src/profiler/index.ts:289` currently has:

```ts
await adapter.setup({ model, maxSteps: 25, timeoutMs: 300_000, mode: opts.adapterMode })
```

The `profile()` function does not currently accept a per-call timeout. Add an optional parameter:

```ts
// In ProfileOptions (or the equivalent interface in profiler/index.ts) add:
timeoutMs?: number

// Then at line 289:
await adapter.setup({
  model,
  maxSteps: 25,
  timeoutMs: opts.timeoutMs ?? TIMEOUT_DEFAULTS.taskExec,
  mode: opts.adapterMode,
})
```

Update both `runProfile` callers in `src/index.ts` to forward `timeoutMs: probeTimeoutMs` into the `profile({...})` call.

- [ ] **Step 5: Add the help-text line in `runProfile`**

Inside `runProfile`'s help string:

```
  --timeout-ms=<n>      Cap on each microbenchmark probe's adapter execution
                        (ms). Default: 120000.
```

(Note: `taskExec` default = 120 000, not 300 000 — we are intentionally lowering the implicit default to match the rest of the system. If this matters operationally, profile runs that previously implicitly relied on 5 minutes per probe can now pass `--timeout-ms=300000` explicitly.)

- [ ] **Step 6: Smoke-test**

Run: `bun run skvm profile --timeout-ms=abc 2>&1 | head -3`
Expected: positive-integer error, exit non-zero.

Run: `bun run skvm profile --help 2>&1 | grep timeout-ms`
Expected: the new help line.

- [ ] **Step 7: Typecheck and run profile tests**

Run: `bunx tsc --noEmit`
Expected: clean.

Run: `bun test test/profiler/`
Expected: all pass (one pre-existing flaky randomized test acceptable per CLAUDE.md context).

- [ ] **Step 8: Commit**

```bash
git add src/index.ts src/profiler/index.ts
git commit -m "cli: add --timeout-ms to profile and unify profile-stage probe timeouts"
```

---

## Task 6 — Rename `--timeoutMs` → `--timeout-ms` on `skvm run` (hard cut)

**Files:**
- Modify: `src/index.ts` (`RUN_KNOWN_FLAGS`, `runRun`, help text around lines 366–456)

- [ ] **Step 1: Replace `"timeoutMs"` with `"timeout-ms"` in `RUN_KNOWN_FLAGS`**

At line 372:

```ts
const RUN_KNOWN_FLAGS: ReadonlySet<string> = new Set([
  "task",
  "skill",
  "model",
  "adapter",
  "workdir",
  "timeout-ms",   // was: "timeoutMs"
  "maxSteps",
  "adapter-config",
])
```

(Leave `"maxSteps"` for now — `run` does not currently expose `--max-steps`; only `jit-optimize` does. If `run` actually reads `--maxSteps`, leave it. If it does not, remove it. Verify by searching `flags.maxSteps` references in `runRun`.)

- [ ] **Step 2: Update the parser in `runRun`**

At line 454 (the `timeoutMs` extraction):

```ts
timeoutMs: flags["timeout-ms"] ? parseInt(flags["timeout-ms"], 10) : task.timeoutMs,
```

If `runRun` does the parsing in multiple places, update each.

- [ ] **Step 3: Update help text**

At line 394:

```
  --timeout-ms=<n>      Override the per-task agent execution timeout (ms).
                        This caps how long the target adapter spends solving
                        one task. Falls back to task.json's `timeoutMs`,
                        then to the built-in default (120000).
```

- [ ] **Step 4: Smoke-test**

Run: `bun run skvm run --timeoutMs=600000 --task=/tmp/nope 2>&1 | head -5`
Expected: unknown-flag error from `assertKnownFlags`, with "did you mean --timeout-ms".

Run: `bun run skvm run --help 2>&1 | grep timeout`
Expected: only the new `--timeout-ms` form, no `--timeoutMs`.

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "cli: rename --timeoutMs to --timeout-ms on skvm run (hard cut)"
```

---

## Task 7 — `jit-optimize`: rename flags + wire optimizer + task-gen actors

**Files:**
- Modify: `src/index.ts` (`JIT_OPTIMIZE_KNOWN_FLAGS`, `runJitOptimize`, help text around lines 1555–1600+)
- Modify: `src/jit-optimize/loop.ts` (lines 330, 560, 1060; `RunTasksParams` interface)
- Modify: `src/jit-optimize/optimizer.ts` (delete `DEFAULT_TIMEOUT_MS`)
- Modify: `src/jit-optimize/task-source.ts` (delete `TASK_GEN_TIMEOUT_MS`)
- Modify: `test/jit-optimize/cli-timeout-args.test.ts` (rename flag references)

- [ ] **Step 1: Rename the flags in `JIT_OPTIMIZE_KNOWN_FLAGS`**

In `src/index.ts` around line 1555: replace `"timeoutMs"` with `"timeout-ms"` and `"maxSteps"` with `"max-steps"` in the set.

- [ ] **Step 2: Update `runJitOptimize` to read the new flag names**

Replace every read of `flags.timeoutMs` with `flags["timeout-ms"]` and every read of `flags.maxSteps` with `flags["max-steps"]` inside `runJitOptimize`. Validate as positive integers; error message names the new flag.

Resolve all three actor timeouts from `cliTimeoutMs`:

```ts
import { resolveTaskTimeout, resolveOptimizerTimeout, resolveTaskGenTimeout, TIMEOUT_DEFAULTS } from "./core/timeouts.ts"

// ...inside runJitOptimize, after parsing cliTimeoutMs and cliMaxSteps:

await runTasks({
  // ...existing params...
  cliTimeoutMs,     // forwards to per-task resolveTaskTimeout in loop.ts
  cliMaxSteps,
  optimizerTimeoutMs: resolveOptimizerTimeout({ cli: cliTimeoutMs }),
  taskGenTimeoutMs: resolveTaskGenTimeout({ cli: cliTimeoutMs }),
})
```

- [ ] **Step 3: Update help text in `runJitOptimize`**

Replace any existing `--timeoutMs`/`--maxSteps` help lines with:

```
  --timeout-ms=<n>      Per-agent-loop ceiling for this jit-optimize run (ms).
                        Applies to:
                          - each per-task adapter execution (default: 120000)
                          - each round's optimizer agent (default: 600000)
                          - the synthetic task-gen agent if used (default: 900000)
                        Each agent loop is timed independently — this is a
                        per-loop ceiling, not a total wall time.
  --max-steps=<n>       Override max steps for the adapter.
```

- [ ] **Step 4: Extend `RunTasksParams` in `src/jit-optimize/loop.ts`**

Add the two new optional fields to the params interface:

```ts
export interface RunTasksParams {
  // ...existing fields...
  optimizerTimeoutMs?: number
  taskGenTimeoutMs?: number
}
```

- [ ] **Step 5: Replace the hardcoded `600_000` at lines 560 and 1060**

Both sites are calls to `runOptimizer({ ..., timeoutMs: 600_000, ... })` (or similar). Replace with the resolved value:

```ts
// At line 560:
timeoutMs: params.optimizerTimeoutMs ?? TIMEOUT_DEFAULTS.optimizer,

// At line 1060:
timeoutMs: params.optimizerTimeoutMs ?? TIMEOUT_DEFAULTS.optimizer,
```

Add the import at the top of `loop.ts`:

```ts
import { TIMEOUT_DEFAULTS } from "../core/timeouts.ts"
```

- [ ] **Step 6: Replace line 330's fallback**

Currently: `timeoutMs: config.targetAdapter.adapterConfig?.timeoutMs ?? 300_000`.
Change to: `timeoutMs: config.targetAdapter.adapterConfig?.timeoutMs ?? TIMEOUT_DEFAULTS.taskExec`.

(Same conceptual default, just sourced from the central table.)

- [ ] **Step 7: Delete `DEFAULT_TIMEOUT_MS` in `optimizer.ts`**

In `src/jit-optimize/optimizer.ts`:

```ts
// Remove:
const DEFAULT_TIMEOUT_MS = 600_000

// Update the fallback in runOptimizer:
const timeoutMs = config.timeoutMs ?? TIMEOUT_DEFAULTS.optimizer

// Add the import:
import { TIMEOUT_DEFAULTS } from "../core/timeouts.ts"
```

- [ ] **Step 8: Delete `TASK_GEN_TIMEOUT_MS` in `task-source.ts`**

In `src/jit-optimize/task-source.ts`:

```ts
// Remove:
const TASK_GEN_TIMEOUT_MS = 15 * 60 * 1000

// At every call site that previously used TASK_GEN_TIMEOUT_MS:
//   - If the call site receives a config object that can carry cliTimeoutMs,
//     use resolveTaskGenTimeout({ cli: cfg.cliTimeoutMs }).
//   - Otherwise use TIMEOUT_DEFAULTS.taskGen directly.
import { TIMEOUT_DEFAULTS, resolveTaskGenTimeout } from "../core/timeouts.ts"
```

Thread `taskGenTimeoutMs` from `RunTasksParams` down to the task-source invocation in `loop.ts` if there's a clean conduit; if not, use the default.

- [ ] **Step 9: Update `test/jit-optimize/cli-timeout-args.test.ts`**

Rename every `--timeoutMs` → `--timeout-ms` and every `--maxSteps` → `--max-steps` in the test arguments. Assertions about flag behavior should still pass unchanged.

- [ ] **Step 10: Run jit-optimize tests**

Run: `bun test test/jit-optimize/`
Expected: all pass (164 from PR #19's baseline, now using renamed flags).

- [ ] **Step 11: Smoke-test the deprecated form gets a hint**

Run: `bun run skvm jit-optimize --timeoutMs=1000 --skill=/tmp/nope 2>&1 | head -5`
Expected: unknown-flag error, "did you mean --timeout-ms".

Run: `bun run skvm jit-optimize --maxSteps=10 --skill=/tmp/nope 2>&1 | head -5`
Expected: unknown-flag error, "did you mean --max-steps".

- [ ] **Step 12: Typecheck**

Run: `bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 13: Commit**

```bash
git add src/index.ts src/jit-optimize/loop.ts src/jit-optimize/optimizer.ts \
        src/jit-optimize/task-source.ts test/jit-optimize/cli-timeout-args.test.ts
git commit -m "jit-optimize: rename to kebab flags and wire optimizer/task-gen timeouts"
```

---

## Task 8 — `bench`: remove `--timeout-mult` CLI flag and wire candidate-gen

**Files:**
- Modify: `src/bench/index.ts` (`BENCH_KNOWN_FLAGS`, parsing, help text)
- Modify: `src/bench/conditions.ts` (three candidate-gen call sites)
- Modify: `src/jit-boost/candidates.ts` (replace fallbacks at lines 39, 338)
- Create: `test/bench/timeout-mult-removed.test.ts`

- [ ] **Step 1: Write the failing removal-smoke test**

```ts
// test/bench/timeout-mult-removed.test.ts
import { describe, test, expect } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"

describe("bench --timeout-mult", () => {
  test("is rejected as unknown flag", () => {
    const result = spawnSync(
      "bun",
      ["run", path.resolve(__dirname, "../../src/index.ts"), "bench", "--timeout-mult=2"],
      { encoding: "utf8" },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr.toLowerCase()).toContain("unknown flag")
    expect(result.stderr).toContain("--timeout-mult")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/bench/timeout-mult-removed.test.ts`
Expected: FAIL — the flag is still recognized (because PR #19's parser still reads it).

- [ ] **Step 3: Remove `"timeout-mult"` from `BENCH_KNOWN_FLAGS`**

In `src/bench/index.ts` around line 30:

```ts
// Before:
"jit-runs", "timeout-mult", "max-steps", "judge-model", "compiler-model",
// After:
"jit-runs", "max-steps", "judge-model", "compiler-model",
```

- [ ] **Step 4: Remove the `--timeout-mult` parsing block**

Around line 124, remove:

```ts
timeoutMult: flags["timeout-mult"] ? parseFloat(flags["timeout-mult"]) : CLI_DEFAULTS.timeoutMult,
```

Replace with:

```ts
timeoutMult: CLI_DEFAULTS.timeoutMult,
```

(`BenchRunConfig.timeoutMult` stays in the type because custom-plan YAML still uses it; only the CLI source is dead.)

- [ ] **Step 5: Remove the help-text lines for `--timeout-mult`**

Around line 545, delete:

```
  --timeout-mult=<n>     Multiply task timeouts (default: ${CLI_DEFAULTS.timeoutMult.toFixed(1)})
```

And remove any cross-reference to it from the `--timeout-ms` help text (PR #19 added a line "Ignored when --timeout-ms is set" — delete that since the flag no longer exists).

- [ ] **Step 6: Run the removal test to verify it now passes**

Run: `bun test test/bench/timeout-mult-removed.test.ts`
Expected: PASS — unknown-flag error.

- [ ] **Step 7: Wire candidate-gen timeout in `bench/conditions.ts`**

Locate the three call sites in `src/bench/conditions.ts`:
- Line 725: `await generateTemplates(genResult.candidates, genResult.snippets, skillDir, outputDir)`
- Line 730: `await generateBoostCandidates(skillDir, outputDir)`
- Line 744: `await generateBoostCandidates(skillDir, outputDir)`

Update each to pass the resolved candidate-gen timeout. The surrounding scope already has access to the bench config; locate `cliTimeoutMs` (added by PR #19 to `BenchRunConfig`):

```ts
import { resolveCandidateGenTimeout } from "../core/timeouts.ts"

// At each call site:
const candidateGenTimeoutMs = resolveCandidateGenTimeout({ cli: config.cliTimeoutMs })
await generateTemplates(
  genResult.candidates, genResult.snippets, skillDir, outputDir,
  { timeoutMs: candidateGenTimeoutMs },
)
await generateBoostCandidates(skillDir, outputDir, { timeoutMs: candidateGenTimeoutMs })
```

(If `config.cliTimeoutMs` is not directly available at the call sites, plumb it through the surrounding function signature.)

- [ ] **Step 8: Replace the two fallbacks in `src/jit-boost/candidates.ts`**

At line 39:

```ts
// Before:
const timeoutMs = opts?.timeoutMs ?? TASK_FILE_DEFAULTS.timeoutMs
// After:
const timeoutMs = opts?.timeoutMs ?? TIMEOUT_DEFAULTS.taskExec
```

At line 338:

```ts
// Before:
const timeoutMs = opts?.timeoutMs ?? 180_000
// After:
const timeoutMs = opts?.timeoutMs ?? TIMEOUT_DEFAULTS.candidateGen
```

Add the import at the top:

```ts
import { TIMEOUT_DEFAULTS } from "../core/timeouts.ts"
```

(`TASK_FILE_DEFAULTS` import can stay if other code references it; remove only if it becomes unused.)

- [ ] **Step 9: Run bench tests**

Run: `bun test test/bench/`
Expected: all pass.

- [ ] **Step 10: Typecheck**

Run: `bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add src/bench/index.ts src/bench/conditions.ts src/jit-boost/candidates.ts \
        test/bench/timeout-mult-removed.test.ts
git commit -m "bench: remove --timeout-mult CLI flag and wire candidate-gen via TIMEOUT_DEFAULTS"
```

---

## Task 9 — Cross-cutting deprecated-flag hint smoke + final verification

**Files:**
- Create: `test/cli/deprecated-flag-hints.test.ts`

- [ ] **Step 1: Write the cross-cutting smoke test**

```ts
// test/cli/deprecated-flag-hints.test.ts
import { describe, test, expect } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"

const cli = path.resolve(__dirname, "../../src/index.ts")

function run(args: string[]): { code: number | null; stderr: string } {
  const r = spawnSync("bun", ["run", cli, ...args], { encoding: "utf8" })
  return { code: r.status, stderr: r.stderr }
}

describe("deprecated CLI flag → did-you-mean hint", () => {
  test("skvm run --timeoutMs suggests --timeout-ms", () => {
    const { code, stderr } = run(["run", "--timeoutMs=1000", "--task=/tmp/x"])
    expect(code).not.toBe(0)
    expect(stderr).toContain("--timeoutMs")
    expect(stderr).toContain("--timeout-ms")
  })

  test("skvm jit-optimize --timeoutMs suggests --timeout-ms", () => {
    const { code, stderr } = run(["jit-optimize", "--timeoutMs=1000", "--skill=/tmp/x"])
    expect(code).not.toBe(0)
    expect(stderr).toContain("--timeoutMs")
    expect(stderr).toContain("--timeout-ms")
  })

  test("skvm jit-optimize --maxSteps suggests --max-steps", () => {
    const { code, stderr } = run(["jit-optimize", "--maxSteps=10", "--skill=/tmp/x"])
    expect(code).not.toBe(0)
    expect(stderr).toContain("--maxSteps")
    expect(stderr).toContain("--max-steps")
  })

  test("skvm bench --timeout-mult is rejected with no suggestion", () => {
    const { code, stderr } = run(["bench", "--timeout-mult=2"])
    expect(code).not.toBe(0)
    expect(stderr.toLowerCase()).toContain("unknown flag")
    expect(stderr).toContain("--timeout-mult")
  })
})
```

- [ ] **Step 2: Run the test**

Run: `bun test test/cli/deprecated-flag-hints.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 3: Run the full suite**

Run: `bun test`
Expected: every existing test still passes, plus the new ones added by tasks 1, 3, 8, 9.

If any test fails:
- For tests that referenced old flag names directly (most likely under `test/bench/` and `test/jit-optimize/`), update the reference to the new name.
- Do not loosen assertions — the flag-naming intent is the point of the migration.

- [ ] **Step 4: Final typecheck**

Run: `bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Grep for any leftover hardcoded timeout literals**

Run: `grep -rn "300_000\|600_000\|900_000\|180_000\|TASK_GEN_TIMEOUT_MS\|DEFAULT_TIMEOUT_MS" src/`
Expected: every remaining hit is either inside `src/core/timeouts.ts` itself (the defaults table), inside infrastructure files explicitly out of scope (subprocess startup / sidecar / handshake / openclaw poll cap / provider retry backoff / tool-level), or inside a comment. No hit should sit on a real call site that resolves a timeout for an agent loop in categories 1–6 of the design doc.

If any non-infrastructure hit remains, replace it with the appropriate `TIMEOUT_DEFAULTS.*` lookup or `resolveX` call before committing.

- [ ] **Step 6: Commit and prepare the PR**

```bash
git add test/cli/deprecated-flag-hints.test.ts
git commit -m "tests: cross-cutting smoke for deprecated timeout/step flag rejection"
```

- [ ] **Step 7: Draft the PR description**

Open the PR with title `core: unify timeout flags as --timeout-ms across all commands` and body referencing `Closes #22`, `Refs #18`, and the design doc. Call out explicitly that the PR removes `--timeoutMs`/`--maxSteps` flags PR #19 just added; this reversal is intentional and the design doc explains why.

---

## Self-Review

Before handing off:

- **Spec coverage**:
  - Defaults table → Task 1.
  - Helper API → Task 1.
  - `resolveTaskRuntime` delegation → Task 2.
  - Compiler timeout (issue #22) → Task 3.
  - CLI `--timeout-ms` on `aot-compile`/`pipeline` → Task 4.
  - CLI `--timeout-ms` on `profile` + hardcoded 300_000 cleanup → Task 5.
  - Rename `--timeoutMs` on `run` → Task 6.
  - Rename `--timeoutMs`/`--maxSteps` on `jit-optimize` + wire optimizer/task-gen actors → Task 7.
  - Remove `--timeout-mult` CLI on `bench` + wire candidate-gen + clean jit-boost candidates.ts → Task 8.
  - Cross-cutting deprecated-flag tests + final cleanup grep → Task 9.

- **Placeholder scan**: no "TBD"/"TODO"/"as appropriate" remain. The one `(If config.cliTimeoutMs is not directly available, plumb it through)` in Task 8 Step 7 is conditional guidance, not a placeholder — it depends on what the merged shape of PR #19 looks like and gives the implementer the rule (plumb it through), not a vague gesture.

- **Type consistency**: `TIMEOUT_DEFAULTS`, `resolveTaskTimeout`, `resolveCompilerTimeout`, `resolveOptimizerTimeout`, `resolveTaskGenTimeout`, `resolveCandidateGenTimeout` — same names used throughout. `cliTimeoutMs` field on `BenchRunConfig` and `RunTasksParams` matches PR #19's naming. `CompileOptions.timeoutMs` and `PassContext.timeoutMs` consistent across Tasks 3, 4, 5.

- **Order dependencies**: Task 1 (foundation) is a hard prerequisite for everything else. Task 3 (compiler plumbing) is a prerequisite for Task 4 (which exposes the CLI flag that uses it). Task 2 (delegate `resolveTaskRuntime`) is independent and could go anywhere after Task 1; placed early so the rest of the plan sees the unified shape. Tasks 4–8 are independent of each other and could be parallelized if reviewing as separate sub-PRs (not recommended — keep as one PR for the unification narrative). Task 9 must come last because it verifies the cleaned-up state.
