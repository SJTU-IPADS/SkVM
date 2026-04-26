# aot-compile pass-registry — follow-up debt

Items surfaced during the pass-registry refactor (commits `08a833f` →
`6316d98`) that I deliberately left unresolved. Listed by priority.
Each entry has: a one-line problem statement, where the code lives, why
it matters, and a concrete fix sketch.

## Real follow-up debt

### 1. `summarizePass` hardcodes artifact shapes

- **Where:** `src/compiler/index.ts` — function `summarizePass` near the
  end of `compileSkill`. Special-cases `dag` and `envSimulation`.
- **Why it matters:** Adding a 4th pass with a non-trivial artifact
  shape (anything beyond `Array.length` or `string.length`) means
  editing this central function instead of staying inside the new pass
  module. The whole point of the registry was to keep new-pass changes
  local.
- **Fix sketch:** Add `summarize?(artifacts: Partial<ArtifactBag>):
  string` to `CompilerPass` (in `src/compiler/passes/types.ts`). Have
  the orchestrator call `pass.summarize?.(out.artifacts)` and fall back
  to a generic `keys=…` printout when absent. Move the dag /
  envSimulation cases into `extract-parallelism/index.ts` and
  `bind-env/index.ts` respectively.
- **Effort:** ~30 minutes. Touches 4 files.
- **Skipped because:** with only 3 passes the central function isn't
  pulling its weight as an abstraction yet. Add when pass 4 lands.

### 2. `Pass1Result` / `Pass2Result` / `Pass3Result` live in the wrong file

- **Where:** `src/compiler/types.ts` lines 42-61.
- **Why it matters:** These are private return shapes of
  `runPass1Agentic` / `runPass2` / `runPass3`. They sit in the public
  `compiler/types.ts` next to `CompilationResult` and `CompileOptions`,
  which suggests to a new pass author "I should add `Pass4Result`
  here". The right home is alongside the producer, e.g.
  `src/compiler/passes/rewrite-skill/agent.ts`.
- **Fix sketch:** Inline each interface into the file that returns it.
  Drop the section from `compiler/types.ts`. Update imports in the
  three runner files. Pure rename — no behavior change.
- **Effort:** ~10 minutes.
- **Skipped because:** cosmetic; doesn't block anything.

### 3. Long relative import paths in `passes/<id>/<file>.ts`

- **Where:** every file under `src/compiler/passes/<id>/` except the
  `index.ts` wrappers. Example: `src/compiler/passes/rewrite-skill/agent.ts`
  imports `../../../core/types.ts`, `../../../providers/types.ts` etc.
- **Why it matters:** Paper-cut. Easy to miscount the `../` depth when
  copying the template.
- **Fix sketch:** Add path aliases in `tsconfig.json`:
  ```json
  "paths": {
    "@core/*": ["src/core/*"],
    "@providers/*": ["src/providers/*"],
    "@compiler/*": ["src/compiler/*"]
  }
  ```
  Then a sweep replaces `../../../core/foo.ts` with `@core/foo.ts`.
  Bun supports tsconfig paths natively.
- **Effort:** ~30 minutes for the sweep. Touches every file in `src/`.
- **Skipped because:** global tsconfig change, large blast radius for
  marginal benefit.

## UX bugs

### 4. Misleading `0 gaps` summary line on solo non-pass-1 runs

- **Where:** `src/index.ts` around lines 678-683 and 879-892. Reads
  `result.artifacts.gaps?.length ?? 0`.
- **Why it matters:** When the user runs `--pass=2` or `--pass=3`
  alone, `result.artifacts.gaps` is `undefined` (because pass 1 didn't
  run), but the summary prints `0 gaps`. Reads as "we checked and
  found none" instead of "we didn't check".
- **Fix sketch:** Branch on whether `gaps` is defined:
  ```ts
  const gapsLabel = result.artifacts.gaps !== undefined
    ? `${result.artifacts.gaps.length} gaps`
    : "gaps=skipped"
  ```
  Apply at both call sites. Same treatment for "Dependencies", "DAG
  steps", and "Parallelism" in the pipeline summary block.
- **Effort:** ~5 minutes. One file.
- **Recommended priority:** highest — small change, immediate UX win.

## Pre-existing test brittleness (unrelated to refactor)

### 5. `test/providers/registry.test.ts > missing env var throws ProviderAuthError` fails when `.env` is loaded

- **Where:** `test/providers/registry.test.ts` line 93-112.
- **Why it matters:** The test does `delete process.env.OPENROUTER_API_KEY`
  before calling `createProviderForModel`, but the call doesn't throw.
  Reproduces in the main worktree too — surfaces whenever
  `<repo>/.env` exists. Not a regression of the refactor; only became
  visible during this session because I symlinked `.env` into the
  worktree to enable live LLM testing.
- **Hypothesis:** somewhere in the chain `createProviderForModel` →
  `resolveRoute` → `instantiate` is reading the key from a path other
  than `process.env.OPENROUTER_API_KEY` (cached config? hardcoded
  `apiKey` in a route entry? overrides leaking from a previous test
  case?). The two `getProvidersConfig()` cache and the literal-`apiKey`
  field on `ProviderRoute` are the most likely suspects.
- **Fix sketch:** Trace `createProviderForModel("openrouter/qwen/qwen3-30b")`
  with the env var deleted, see who returns a non-null key. Either
  reset the relevant cache in the test's `beforeEach`, or fix the
  underlying state leak.
- **Effort:** ~30 minutes investigation, fix likely small.

## Test infrastructure

### 6. `MockProvider` re-implemented in every pass test

- **Where:** `test/compiler/pass3.test.ts`, `test/compiler/extract-deps.test.ts`,
  potentially others.
- **Fix sketch:** Extract to `test/helpers/mock-llm.ts`. Variants:
  - canned-text mock (current pass3 use)
  - canned-tool-use mock
  - sequential-response mock for multi-call passes
- **Effort:** ~20 minutes.
- **Skipped because:** two duplicates is fine; abstract on the third
  one. Worth doing the next time a new pass test is added.

### 7. `bench/conditions.ts` `runAOTVariant` still types `passes: number[]`

- **Where:** `src/bench/conditions.ts` line 462. Calls
  `compileSkill({ ..., passes: passes.map(String) })` to convert.
- **Why it matters:** Mild typing inconsistency — the rest of the
  pipeline uses `string[]` (CLI tokens). The `.map(String)` is a
  conversion artifact.
- **Fix sketch:** Lift `passes: string[]` up through `runAOTVariant`'s
  signature. Audit upstream callers in `src/bench/orchestrator.ts`.
- **Effort:** ~15 minutes.

## Cleanup tasks (this session's leftovers)

### 8. Test cache directories under `/tmp/`

`/tmp/skvm-aot-test-1777119473/` and `/tmp/skvm-aot-test-fix-1777139310/`
are left over from manual live testing. Plus the helper paths
`/tmp/.skvm-aot-test-cache-path` and `/tmp/.skvm-aot-test-fix-cache-path`.

```bash
rm -rf /tmp/skvm-aot-test-* /tmp/.skvm-aot-test-cache-path /tmp/.skvm-aot-test-fix-cache-path
```

### 9. `.env` symlink in the worktree

`<worktree>/.env` is a symlink to `<main repo>/.env`. Created so
`env-bootstrap.ts` could find the API keys when running `bun run skvm`
inside the worktree.

If you keep the worktree: leave the symlink.
If you remove the worktree: `git worktree remove` cleans it up
automatically (it's a per-worktree file, not in HEAD).

### 10. The worktree itself

`worktree-aot-compile-pass-registry` branch and the on-disk worktree
at `.claude/worktrees/aot-compile-pass-registry/` are both still live.
All 5 commits are already fast-forwarded into `main`. Two options:

- `keep` — leave it for follow-up work on the same branch
- `remove` — `git worktree remove .claude/worktrees/aot-compile-pass-registry`
  + `git branch -d worktree-aot-compile-pass-registry`

## Decided not to fix

These came up in reviews but I judged not worth the cost:

- **`PassContext` is a large blob** — every pass receives every field
  even if it only uses two. With 3 passes, fine. Revisit at 6+ passes
  or if a clean abstraction emerges naturally.
- **`failureContext` only used by `rewrite-skill`** — same as above.
  Mild leakiness, but isolating it would mean a tagged-union pass
  context which adds complexity for a single field.
- **`_template/` could be picked up by file walkers** — it's in the
  source tree, not a workDir. The walkers in pass1/pass2/bench only
  walk per-job workDirs (per-skill bundles), never the source tree.
  Documented in the template README.
- **Registry validator collects-all vs throw-first** — fixed in
  `41a119b`; consistent with `validateDeps` now.
- **`--pass=` default `[1]`** — fixed in `165c108` after Codex review;
  help text is now templated from the constant.
