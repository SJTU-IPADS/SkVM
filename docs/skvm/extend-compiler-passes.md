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

`PassContext` (defined in `src/compiler/passes/types.ts`) is the
envelope handed to `run`. The fields that need extra guidance beyond
their JSDoc:

- `skillContent` — canonical SKILL.md text, reflects every prior
  `SkillPatch`. **Don't re-read from disk.** Use this.
- `workDir` — free to write inside, but **never** under `_artifacts/`
  or `_profiling/` (reserved for the orchestrator and prior compiles).
- `provider` — already wrapped with conversation logging and per-pass
  token accounting. Use it for every LLM call; tokens tally
  automatically.
- `failureContext` — only set during JIT recompilation. Currently
  consumed by `rewrite-skill` only; other passes may ignore.

The other fields (`skillName`, `tcp`, `model`, `harness`, `artifacts`)
have descriptive comments at the type definition.

### `PassOutput`

See `src/compiler/passes/types.ts`. Two things to know:

- The `artifacts` you return are merged into the store and persisted
  one-JSON-per-key under `{workDir}/_artifacts/{key}.json`.
- A `SkillPatch` is the only sanctioned way to mutate SKILL.md. The
  orchestrator applies it both to disk and to the in-memory
  `skillContent` that downstream passes will receive.

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
which passes run when the user omits `--pass`. The default is
intentionally narrow to keep a bare `skvm aot-compile` cheap — passes
with non-trivial cost (extra LLM calls, sandbox simulation) should
not be added to the default unless they are essential. Users opt
into heavier passes explicitly via `--pass=1,N` or `--pass=<your-id>`.

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
