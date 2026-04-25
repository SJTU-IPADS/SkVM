# aot-compile Pass Registry

Refactor `src/compiler/` so each pass is independently runnable and new passes can be added without editing the orchestrator. Decision summary from the design discussion:

- `pass1` stays a single unit (do not split SCR extraction out).
- `pass3` drops its `scr` dependency entirely — it analyzes SKILL.md directly.
- `--pass=` accepts both numeric ids (`1,2,3`) and string ids (`rewrite-skill,bind-env,extract-parallelism`).
- One JSON file per artifact under `workDir/_artifacts/{key}.json`.
- `CompilationResult` is migrated cleanly to `artifacts` + `passRuns` (option A, no compat view).

## Goals

1. Every pass runs solo with the same CLI surface (`skvm aot-compile --pass=<id>`).
2. Adding a new pass is a single-directory change: drop `src/compiler/passes/<id>/index.ts`, register it, and add a key to `ArtifactBag`. No edits to the orchestrator, `writeVariant`, or CLI dispatch.
3. Existing artifacts on disk (`SKILL.md`, `env-setup.sh`, `workflow-dag.md`, `compilation-plan.json`) stay where they are — only internal types and intermediate-artifact storage change.

## Architecture

### Pass interface

```ts
// src/compiler/passes/types.ts
export interface CompilerPass {
  id: string                        // "rewrite-skill" | "bind-env" | "extract-parallelism" | ...
  number: number                    // 1, 2, 3, ... — used by `--pass=1,2,3` and in `passTag`
  consumes: ArtifactKey[]
  produces: ArtifactKey[]
  run(ctx: PassContext): Promise<PassOutput>
}

export interface PassContext {
  skillName: string
  skillDir?: string
  workDir: string                   // shared workdir; pass mutates SKILL.md in place
  tcp: TCP
  model: string
  harness: string
  provider: LLMProvider             // already wrapped with per-pass logging
  failureContext?: FailureContext
  artifacts: ArtifactStore          // get<K>(k): ArtifactBag[K] | undefined
  log: Logger
}

export interface PassOutput {
  artifacts: Partial<ArtifactBag>   // merged into store + persisted to _artifacts/{key}.json
  skillPatch?: SkillPatch           // optional in-memory + on-disk SKILL.md mutation
}

export type SkillPatch =
  | { kind: "rewrite"; content: string }   // pass1 — full SKILL.md replacement
  | { kind: "append"; content: string }    // pass3 — append parallelism section
```

### Artifact bag

```ts
// src/compiler/artifacts.ts
export interface ArtifactBag {
  scr: SCR
  gaps: CapabilityGap[]
  deps: DependencyEntry[]
  envScript: string
  envSimulation: { attemptCount: number; success: boolean; failureReason?: string; finalScriptValidated: boolean }
  dag: WorkflowDAG
}
export type ArtifactKey = keyof ArtifactBag
```

`ArtifactStore` is a thin wrapper over `Map<ArtifactKey, unknown>`:
- `load(workDir)` reads existing `_artifacts/*.json` on construction (enables solo-pass runs that consume prior cached output).
- `merge(partial)` writes one JSON file per key + updates in-memory map.
- `get<K>(k)` returns `ArtifactBag[K] | undefined`.

### Per-pass run metadata (separate from artifacts)

```ts
export interface PassRunMeta {
  passId: string
  status: "ok" | "skipped" | "failed"
  tokens: TokenUsage
  durationMs: number
  iterations?: number               // agent loop iteration count where applicable
  error?: string
}
```

Persisted to `workDir/_artifacts/_meta/{passId}.json`. Aggregated into `compilation-plan.json` by `writeVariant`.

### CompilationResult (new shape)

```ts
export interface CompilationResult {
  skillName: string
  model: string
  harness: string
  compiledAt: string
  compiledSkill: string

  artifacts: Partial<ArtifactBag>
  passRuns: Record<string, PassRunMeta>

  guardPassed: boolean
  guardViolations: string[]

  tokens: TokenUsage                // sum across passRuns
  passes: string[]                  // pass ids that actually ran (e.g. ["rewrite-skill","extract-parallelism"])
  costUsd: number
  durationMs: number
}
```

`Pass1Result` / `Pass2Result` / `Pass3Result` and the `pass1/pass2/pass3` fields are deleted. All call sites migrate in the same change.

### Orchestrator

```ts
// src/compiler/index.ts (sketch)
async function compileSkill(opts, provider, options) {
  const enabled = resolvePassIds(opts.passes)            // ["rewrite-skill","bind-env","extract-parallelism"]
  const passes = topoSort(enabled.map(getPassById))      // by consumes/produces
  validateDeps(passes, opts)                             // strict: error if a consume isn't produced or cached

  setupWorkDir(opts)                                     // copy skillDir, copy _profiling
  const store = await ArtifactStore.load(workDir)        // pick up cached artifacts from prior runs
  const passRuns: Record<string, PassRunMeta> = {}

  for (const pass of passes) {
    const t0 = performance.now()
    const passLog = new ConversationLog(path.join(compileLogDir, `${pass.id}.jsonl`))
    const passProvider = new LoggingProvider(provider, passLog)
    const ctx = buildContext(pass, store, passProvider, opts)
    const sp = options?.showSpinner ? createSpinner(`Compiling — ${pass.id}...`) : null
    try {
      const out = await pass.run(ctx)
      await store.merge(out.artifacts)
      if (out.skillPatch) await applySkillPatch(workDir, out.skillPatch)
      passRuns[pass.id] = { passId: pass.id, status: "ok", tokens: ..., durationMs: performance.now() - t0 }
      sp?.succeed(`${pass.id}: ok`)
    } catch (err) {
      sp?.fail(`${pass.id}: failed`)
      throw err
    } finally {
      await passLog.finalize()
    }
  }

  const compiledSkill = await Bun.file(path.join(workDir, "SKILL.md")).text()
  const guard = validateGuard(opts.skillContent, compiledSkill)
  return assembleResult(store, passRuns, compiledSkill, guard, opts)
}
```

`writeVariant` reads from the new shape:
- `result.artifacts.scr` / `result.artifacts.gaps` / `result.artifacts.deps` / `result.artifacts.envScript` / `result.artifacts.dag`
- writes `compilation-plan.json` from artifacts + passRuns
- writes `env-setup.sh` only if `envScript` artifact exists
- writes `workflow-dag.md` only if `dag` artifact exists

## Pass3 → SCR decoupling

`runPass3` currently consumes `scr.purposes` only to render a purpose summary in the user prompt (pass3/index.ts:106-114). Change:

- Remove `scr` parameter from `runPass3`.
- Drop the "Skill purposes:" section from the prompt; leave the SKILL.md content as the sole source of truth.
- Tighten the system prompt's "use 2-6 meaningful workflow nodes" rule so the model still produces a small DAG without the SCR scaffolding.

If quality regresses noticeably in benchmarks, fallback plan: have pass3 inline a minimal "list 2-6 workflow purposes from this SKILL.md" pre-step (single LLM call) — kept inside pass3, no cross-pass dependency.

## Storage layout

```
$AOT_COMPILE_DIR/{harness}/{model}/{skill}/{passTag}/
  SKILL.md                    # unchanged — final compiled skill
  env-setup.sh                # written iff envScript artifact present
  workflow-dag.md             # written iff dag artifact present
  compilation-plan.json       # restructured: { skillName, ..., artifacts, passRuns }
  meta.json                   # unchanged

  _artifacts/                 # NEW — per-artifact JSON, one file per key
    scr.json
    gaps.json
    deps.json
    envScript.json
    envSimulation.json
    dag.json
    _meta/
      rewrite-skill.json
      bind-env.json
      extract-parallelism.json
```

`{passTag}` is built from each enabled pass's numeric `number`, sorted ascending: `p1p2p3` for the current three. Adding a 4th pass extends the tag to `p1p2p3p4`. `toPassTag` / `fromPassTag` keep their existing string-form contract.

## CLI

```
skvm aot-compile --skill=... --model=... [--pass=<list>]

--pass forms (mix freely, comma-separated):
  --pass=1,2,3                        legacy
  --pass=rewrite-skill,bind-env       new
  --pass=1,extract-parallelism        mixed
  --pass=                             default = all registered passes

skvm aot-compile --list-passes        prints registry: number | id | consumes | produces
```

Resolver: each token is looked up first as a numeric `number`, then as a string `id`. Unknown token errors out with the registry table printed.

Strict-deps: if pass A consumes an artifact that no enabled pass produces and no cached `_artifacts/{key}.json` exists, error out with a clear message. No `--auto-deps` in this change.

## Pass migrations

| Existing | New pass id | Notes |
|---|---|---|
| `pass1/runPass1Agentic` | `rewrite-skill` (number=1) | Produces `scr`, `gaps`, `skillPatch: { kind: "rewrite" }`. Wraps existing `extractSCR` + `analyzeGaps` + agent loop unchanged. `transforms` field dropped from result. |
| `pass2/runPass2` | `bind-env` (number=2) | Produces `deps`, `envScript`, `envSimulation`. No `skillPatch`. |
| `pass3/runPass3` | `extract-parallelism` (number=3) | Produces `dag`, `skillPatch: { kind: "append", content: parallelismSection }` when groups exist. SCR parameter removed. |

`generateParallelismSection` and `generateWorkflowDagDocument` stay in pass3's module — `writeVariant` imports them from the registry-resolved pass module, not via index re-export.

## Migration steps

1. **Add types & registry, no behavior change.** New `src/compiler/passes/types.ts`, `src/compiler/artifacts.ts`, `src/compiler/registry.ts`. `ArtifactStore` with file persistence. Verify with a unit test that load/merge round-trip works.
2. **Wrap each existing pass.** `src/compiler/passes/rewrite-skill/index.ts`, `bind-env/index.ts`, `extract-parallelism/index.ts` — each implements `CompilerPass` and calls into the existing `runPass1/2/3` for now (thin adapters). Pass3 SCR parameter removed at this step.
3. **Replace orchestrator.** Rewrite `compileSkill` against the registry. Delete `Pass1Result/Pass2Result/Pass3Result`. Update `CompilationResult`. Update `writeVariant` to read from `artifacts` + `passRuns`.
4. **Migrate call sites.** `src/index.ts` lines 678/683/878-883/891 → use `result.artifacts.*`. `src/compiler/index.ts` self-references in the orchestrator → resolved by step 3.
5. **Inline old pass code into pass directories.** Move `pass1/compiler-agent.ts` → `passes/rewrite-skill/agent.ts` etc., delete the old `pass1/`, `pass2/`, `pass3/` directories. CLI flag `--pass=1,2,3` continues to work via the pass `number` field.
6. **Tests.**
   - New unit test: pass registry resolves numeric + string ids.
   - New unit test: `ArtifactStore` round-trip + cache-load on solo-pass run.
   - Existing `test/compiler/*` tests adjusted for new types.
   - Integration smoke: `skvm aot-compile --pass=3 --skill=... --model=...` runs solo without `_artifacts/scr.json` (since pass3 no longer consumes scr).

Each step is a self-contained commit; the tree compiles and `bun test` passes after every step.

## Decisions

1. **Pass numbering.** Every pass has a numeric `number` field, appended sequentially as new passes are added (4, 5, ...). Strings ids never appear in the directory tag — `passTag` stays `p{n1}p{n2}...`. Adding a pass = pick the next free integer.
2. **`--auto-deps`.** Not implemented in this change. Each pass still declares `consumes` / `produces` for documentation and topo-sort, and the orchestrator validates that consumed artifacts are produced by some other enabled pass or available in cache (strict). No automatic upstream scheduling.
3. **`transforms` field.** Removed entirely. `Pass1Result.transforms` was always `[]` since the agent-loop refactor (compiler-agent.ts:473). The `Transform` zod schema in `core/types.ts` stays untouched (used by guard's substitution-exempt branch — currently never triggered, but the type is shared infrastructure).
