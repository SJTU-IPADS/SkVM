import type { CompilerPass, PassContext, PassOutput } from "../types.ts"

/**
 * Template compiler pass — copy this directory to `passes/<your-id>/`,
 * rename the export, fill in the fields, then register it in
 * `src/compiler/registry.ts` (`ALL_PASSES`).
 *
 * Quick checklist:
 *   1. Pick a kebab-case `id` and the next free integer for `number`.
 *   2. List artifacts you read (`consumes`) and write (`produces`).
 *      For new outputs, also add the key to `ArtifactBag` in
 *      `src/compiler/artifacts.ts`.
 *   3. Implement `run`. Read `ctx.skillContent` for the current SKILL.md;
 *      use `ctx.artifacts.get(key)` for upstream artifacts; emit a
 *      `SkillPatch` to mutate SKILL.md.
 *   4. Append the pass to `ALL_PASSES` in `src/compiler/registry.ts`.
 *
 * The orchestrator handles token accounting (via the wrapped
 * LoggingProvider), persistence to `_artifacts/`, log files, and the
 * `--pass=<id>` CLI plumbing automatically.
 *
 * Full guide: docs/skvm/extend-compiler-passes.md
 */
export const templatePass: CompilerPass = {
  id: "template",
  number: 0,
  description: "TODO: one-line description of what this pass does",
  consumes: [],
  produces: [],

  async run(ctx: PassContext): Promise<PassOutput> {
    void ctx
    return { artifacts: {} }
  },
}
