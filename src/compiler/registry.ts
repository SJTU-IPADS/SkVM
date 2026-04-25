import type { CompilerPass } from "./passes/types.ts"
import type { ArtifactKey } from "./artifacts.ts"
import { rewriteSkillPass } from "./passes/rewrite-skill/index.ts"
import { bindEnvPass } from "./passes/bind-env/index.ts"
import { extractParallelismPass } from "./passes/extract-parallelism/index.ts"

/**
 * Single source of truth for available compiler passes. Adding a new pass =
 * append it to this array (and its module under `src/compiler/passes/<id>/`).
 */
export const ALL_PASSES: readonly CompilerPass[] = [
  rewriteSkillPass,
  bindEnvPass,
  extractParallelismPass,
]

export function getPassById(id: string): CompilerPass | undefined {
  return ALL_PASSES.find((p) => p.id === id)
}

export function getPassByNumber(n: number): CompilerPass | undefined {
  return ALL_PASSES.find((p) => p.number === n)
}

/**
 * Resolve `--pass=` tokens to passes. Tokens are matched first as numeric
 * `pass.number`, then as string `pass.id`. Throws on unknown tokens. Result
 * is deduped and sorted by `number`.
 */
export function resolvePassTokens(tokens: string[]): CompilerPass[] {
  const resolved = new Map<string, CompilerPass>()
  for (const raw of tokens) {
    const token = raw.trim()
    if (!token) continue
    const asNumber = Number(token)
    let pass: CompilerPass | undefined
    if (Number.isInteger(asNumber) && asNumber > 0) {
      pass = getPassByNumber(asNumber)
    }
    pass ??= getPassById(token)
    if (!pass) throw new Error(`Unknown pass: "${token}". Run 'skvm aot-compile --list-passes' to see available passes.`)
    resolved.set(pass.id, pass)
  }
  return [...resolved.values()].sort((a, b) => a.number - b.number)
}

export function defaultPasses(): CompilerPass[] {
  return [...ALL_PASSES].sort((a, b) => a.number - b.number)
}

/** Topo-sort by consumes/produces; tie-broken by `number`. Throws on cycle. */
export function topoSort(passes: CompilerPass[]): CompilerPass[] {
  const producers = new Map<ArtifactKey, CompilerPass>()
  for (const pass of passes) {
    for (const key of pass.produces) producers.set(key, pass)
  }

  const visited = new Set<string>()
  const inStack = new Set<string>()
  const order: CompilerPass[] = []

  const visit = (pass: CompilerPass) => {
    if (visited.has(pass.id)) return
    if (inStack.has(pass.id)) {
      throw new Error(`Cyclic pass dependency detected at ${pass.id}`)
    }
    inStack.add(pass.id)
    for (const key of pass.consumes) {
      const producer = producers.get(key)
      if (producer && producer.id !== pass.id) visit(producer)
    }
    inStack.delete(pass.id)
    visited.add(pass.id)
    order.push(pass)
  }

  for (const pass of [...passes].sort((a, b) => a.number - b.number)) {
    visit(pass)
  }
  return order
}

/**
 * Returns one error per unsatisfied consume — a consumed artifact must be
 * produced by another enabled pass or already in `cachedKeys`. Empty array =
 * OK.
 */
export function validateDeps(
  passes: CompilerPass[],
  cachedKeys: Set<ArtifactKey>,
): string[] {
  const produced = new Set<ArtifactKey>()
  for (const pass of passes) for (const key of pass.produces) produced.add(key)

  const errors: string[] = []
  for (const pass of passes) {
    for (const key of pass.consumes) {
      if (produced.has(key) || cachedKeys.has(key)) continue
      errors.push(`Pass "${pass.id}" consumes artifact "${key}" but no enabled pass produces it and no cached value exists. Run a producer pass first or include it in --pass.`)
    }
  }
  return errors
}

/** Format the registry as a human-readable table for `--list-passes`. */
export function formatRegistry(): string {
  if (ALL_PASSES.length === 0) return "(no passes registered)"
  const rows = [...ALL_PASSES]
    .sort((a, b) => a.number - b.number)
    .map((p) => ({
      n: String(p.number),
      id: p.id,
      consumes: p.consumes.join(",") || "—",
      produces: p.produces.join(",") || "—",
      description: p.description,
    }))
  const widths = {
    n: Math.max(1, ...rows.map((r) => r.n.length)),
    id: Math.max(2, ...rows.map((r) => r.id.length)),
    consumes: Math.max(8, ...rows.map((r) => r.consumes.length)),
    produces: Math.max(8, ...rows.map((r) => r.produces.length)),
  }
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length))
  const header = `${pad("#", widths.n)}  ${pad("id", widths.id)}  ${pad("consumes", widths.consumes)}  ${pad("produces", widths.produces)}  description`
  const sep = "-".repeat(header.length)
  const body = rows
    .map((r) => `${pad(r.n, widths.n)}  ${pad(r.id, widths.id)}  ${pad(r.consumes, widths.consumes)}  ${pad(r.produces, widths.produces)}  ${r.description}`)
    .join("\n")
  return `${header}\n${sep}\n${body}`
}
