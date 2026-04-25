import type { CompilerPass, PassContext, PassOutput } from "../types.ts"

// Template pass — copy this directory to `passes/<your-id>/`, rename the
// export, then register it in `src/compiler/registry.ts`. See the
// adjacent README.md and docs/skvm/extend-compiler-passes.md for the full
// checklist. Not registered: `number: 0` is a TODO placeholder, the
// registry validator never sees it.
export const templatePass: CompilerPass = {
  id: "template",
  number: 0,
  description: "TODO: one-line description of what this pass does",
  consumes: [],
  produces: [],

  async run(_ctx: PassContext): Promise<PassOutput> {
    return { artifacts: {} }
  },
}
