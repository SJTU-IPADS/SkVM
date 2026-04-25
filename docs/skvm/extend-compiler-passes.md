# Extending the AOT compiler with a new pass

The `aot-compile` pipeline is driven by a pass registry at
`src/compiler/registry.ts`. Each pass is a `CompilerPass` object exposing
an `id`, `number`, what artifacts it `consumes`/`produces`, and a `run`
function. The orchestrator (`src/compiler/index.ts` `compileSkill`) topo-
sorts enabled passes, runs each, persists its artifacts, and applies any
`SkillPatch` it returned.

## Quick start

The fastest path is to copy the template directory:

```bash
cp -r src/compiler/passes/_template src/compiler/passes/extract-tools
```

Then four edits across three files:

1. **`src/compiler/passes/extract-tools/index.ts`** — rename the export,
   set `id`, `number` (next free integer), `description`, `consumes`,
   `produces`. Implement `run`.
2. **`src/compiler/artifacts.ts`** — if your pass writes a new artifact
   key, add the field to `ArtifactBag`. Skip if you only mutate
   `SKILL.md`.
3. **`src/compiler/registry.ts`** — append your export to `ALL_PASSES`.

That's it. `--pass=<number>`, `--pass=<id>`, `--list-passes`, the
`passTag` segment of the variant directory, artifact persistence, log
files, and per-pass token tallies all start working automatically.

## Anatomy

### `CompilerPass`

```ts
export interface CompilerPass {
  id: string                       // kebab-case, used by --pass=<id>
  number: number                   // unique positive integer
  description: string              // shown by --list-passes
  consumes: ArtifactKey[]          // artifacts this pass reads
  produces: ArtifactKey[]          // artifacts this pass writes
  run(ctx: PassContext): Promise<PassOutput>
}
```

Both `id` and `number` must be unique across the registry. Module-load-
time validation in `registry.ts` enforces this — pick a duplicate and
every `bun test` / `bunx tsc --noEmit` fails loudly.

### `PassContext`

What your `run` receives:

| Field | Meaning |
|---|---|
| `skillName` | Name segment used in the variant path. Don't override. |
| `workDir` | Per-job working dir, already populated with the skill bundle. Free to write inside, but **never** under `_artifacts/` or `_profiling/` (reserved for the orchestrator). |
| `skillContent` | Canonical SKILL.md text. Reflects every prior `SkillPatch`. Don't re-read from disk — use this. |
| `tcp` | Target capability profile. Useful if your pass adapts to model capabilities (rewrite-skill does); ignore otherwise. |
| `model`, `harness` | Target model/adapter, mostly informational. |
| `provider` | An `LLMProvider` already wrapped with conversation logging and per-pass token accounting. Use it for any LLM call — tokens are tallied automatically. |
| `failureContext` | Only set during JIT recompilation. Currently consumed by `rewrite-skill` only. Other passes may ignore it. |
| `artifacts` | Read upstream artifacts via `ctx.artifacts.get("scr")` etc. |

### `PassOutput`

```ts
export interface PassOutput {
  artifacts: Partial<ArtifactBag>     // merged into store + persisted
  skillPatch?: SkillPatch              // optional SKILL.md mutation
  iterations?: number                  // for agent-loop passes (informational)
}

export type SkillPatch =
  | { kind: "rewrite"; content: string }
  | { kind: "append"; content: string }
```

The orchestrator merges your `artifacts` into the typed store (one JSON
file per key under `{workDir}/_artifacts/{key}.json`), applies any
`SkillPatch`, and writes per-pass execution metadata to
`_artifacts/_meta/{passId}.json`.

## Folder convention

The three existing passes have different layouts because their
implementation surface area differs. The convention is:

- `index.ts` — thin `CompilerPass` definition; imports the heavier
  implementation from sibling files. Keep this small and obvious.
- Everything else — implementation. Names should describe what they
  do (`agent.ts`, `extractor.ts`, `runner.ts`, `parallelism.ts`).

If your pass is a single LLM call you can keep everything in
`index.ts`. If it's an agent loop, split out `agent.ts`. There's no
enforced structure beyond `index.ts` exporting the pass.

## Workspace boundaries

What a pass may write inside `workDir`:

- `SKILL.md` — only via the returned `SkillPatch`. Don't write it
  directly; let the orchestrator handle the patch.
- Skill bundle files — fine, but unusual. `rewrite-skill`'s agent does
  this when its compensation strategy involves new helper files.

What a pass must **not** touch:

- `_artifacts/**` — orchestrator-owned. Writing here from a pass will
  be picked up as bundle input on subsequent runs and contaminate
  prompts.
- `_profiling/**` — pre-populated by the orchestrator from TCP details
  for reference only.
- Anything outside `workDir`.

## Default `--pass`

`CLI_DEFAULTS.compilerPasses` in `src/core/ui-defaults.ts` controls
which passes run when the user omits `--pass`. Currently `[1]` — only
`rewrite-skill` runs by default to keep the bare `skvm aot-compile`
cheap. If your new pass should be in the default set, change that
array; otherwise users opt in via `--pass=1,N` or `--pass=<your-id>`.

## Import paths

Pass files live at depth 3 (`src/compiler/passes/<id>/file.ts`). To
reach `core/`, `providers/`, or other top-level src dirs, write
`../../../core/...` etc. Within the same pass directory, use `./`.
The compiler-level shared types (`CompileOptions`, `Pass1Result`, ...)
are at `../../types.ts`.

## Testing

Drop a test file alongside the existing ones in `test/compiler/`. The
`MockProvider` pattern in `test/compiler/pass3.test.ts` is the smallest
working example for a non-agentic LLM-driven pass.

The registry's invariants are exercised by `test/compiler/registry.test.ts`
and run on every `bun test` — duplicate-id / duplicate-number bugs
surface immediately.

## Removing or renaming a pass

Numbers are append-only by convention; once assigned, never reuse for a
different pass. If you delete a pass, the gap is fine — the registry
allows non-contiguous numbers as long as they remain unique. Rename
the `id` only if you are willing to break any user shell scripts that
reference the old string id; numeric `--pass=N` references stay stable
across renames.
