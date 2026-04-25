# Pass template

Copy this directory to `src/compiler/passes/<your-id>/` and start editing.

```bash
cp -r src/compiler/passes/_template src/compiler/passes/extract-tools
```

Then:

1. Rename the export in `index.ts` (`templatePass` → `extractToolsPass`).
2. Set `id`, `number` (next free integer), `description`, `consumes`, `produces`.
3. If your pass produces a new artifact key, add it to `ArtifactBag` in
   `src/compiler/artifacts.ts`.
4. Append the export to `ALL_PASSES` in `src/compiler/registry.ts`.
5. Implement `run`.

The registry validates uniqueness of ids and numbers at import time —
if you pick a duplicate, every `bun test` and `bunx tsc --noEmit` will
fail loudly with a clear message.

This `_template` directory is **not** registered, so the placeholder
`number: 0` is harmless. Don't reference `_template` from `ALL_PASSES`.

For the full extension guide (folder conventions, `PassContext`
semantics, workDir write boundaries, import-path notes), see
`docs/skvm/extend-compiler-passes.md`.
