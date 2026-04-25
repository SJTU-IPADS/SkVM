import path from "node:path"
import { mkdir, readdir } from "node:fs/promises"
import type {
  SCR, CapabilityGap, DependencyEntry, WorkflowDAG, TokenUsage,
} from "../core/types.ts"

/**
 * Typed registry of intermediate compilation artifacts. Each key maps to a
 * structured payload that one pass produces and others may consume.
 *
 * Adding a new pass = add its output key here, and the orchestrator + storage
 * layer pick it up automatically.
 */
export interface ArtifactBag {
  scr: SCR
  gaps: CapabilityGap[]
  deps: DependencyEntry[]
  envScript: string
  envSimulation: {
    attemptCount: number
    success: boolean
    failureReason?: string
    finalScriptValidated: boolean
  }
  dag: WorkflowDAG
}

export type ArtifactKey = keyof ArtifactBag

/** Per-pass execution metadata (separate from artifacts: not consumed by other passes). */
export interface PassRunMeta {
  passId: string
  status: "ok" | "failed"
  tokens: TokenUsage
  durationMs: number
  iterations?: number
  error?: string
}

/**
 * Subdirectory of `workDir` that holds intermediate compiler artifacts. File
 * walkers (pass1's `readWorkDirFiles`, pass2's `readBundleFiles`, bench's
 * compiled-dir copier in `runAOTVariant`) must skip this directory — its
 * contents are compiler internals, not skill bundle files.
 */
export const ARTIFACT_DIR = "_artifacts"
const META_DIR = "_meta"

/**
 * File-backed store for ArtifactBag entries. One JSON file per artifact key
 * under `{workDir}/_artifacts/{key}.json`. Per-pass metadata goes under
 * `{workDir}/_artifacts/_meta/{passId}.json`.
 *
 * Solo-pass runs construct via `load()` to pick up cached artifacts produced
 * by prior runs in the same workDir.
 */
export class ArtifactStore {
  private bag: Partial<ArtifactBag> = {}
  private meta: Record<string, PassRunMeta> = {}

  private constructor(public readonly workDir: string) {}

  static async load(workDir: string): Promise<ArtifactStore> {
    const store = new ArtifactStore(workDir)
    const dir = path.join(workDir, ARTIFACT_DIR)
    const metaDir = path.join(dir, META_DIR)
    await Promise.all([mkdir(dir, { recursive: true }), mkdir(metaDir, { recursive: true })])

    const [entries, metaEntries] = await Promise.all([
      readdir(dir, { withFileTypes: true }).catch(() => []),
      readdir(metaDir, { withFileTypes: true }).catch(() => []),
    ])

    await Promise.all([
      ...entries
        .filter((e) => e.isFile() && e.name.endsWith(".json"))
        .map(async (e) => {
          const key = e.name.slice(0, -".json".length) as ArtifactKey
          store.bag[key] = await Bun.file(path.join(dir, e.name)).json()
        }),
      ...metaEntries
        .filter((e) => e.isFile() && e.name.endsWith(".json"))
        .map(async (e) => {
          const passId = e.name.slice(0, -".json".length)
          store.meta[passId] = await Bun.file(path.join(metaDir, e.name)).json() as PassRunMeta
        }),
    ])

    return store
  }

  get<K extends ArtifactKey>(key: K): ArtifactBag[K] | undefined {
    return this.bag[key]
  }

  snapshot(): Partial<ArtifactBag> {
    return { ...this.bag }
  }

  metaSnapshot(): Record<string, PassRunMeta> {
    return { ...this.meta }
  }

  async merge(partial: Partial<ArtifactBag>): Promise<void> {
    const dir = path.join(this.workDir, ARTIFACT_DIR)
    const writes: Promise<unknown>[] = []
    for (const [key, value] of Object.entries(partial)) {
      if (value === undefined) continue
      this.bag[key as ArtifactKey] = value as never
      writes.push(Bun.write(path.join(dir, `${key}.json`), JSON.stringify(value, null, 2)))
    }
    await Promise.all(writes)
  }

  async writeMeta(meta: PassRunMeta): Promise<void> {
    this.meta[meta.passId] = meta
    await Bun.write(
      path.join(this.workDir, ARTIFACT_DIR, META_DIR, `${meta.passId}.json`),
      JSON.stringify(meta, null, 2),
    )
  }
}
