import path from "node:path"

/**
 * Whether a flag carries a single path value or a comma-separated list of
 * them. `--skill`, `--logs`, `--tasks` etc. accept `a,b,c`; each element is a
 * path that must be mounted / rewritten independently.
 */
export type PathValueShape = "single" | "csv"

export interface PathFlag {
  flag: string                    // e.g. "--skill"
  kind: "file" | "dir"
  mode: "ro" | "rw"
  required: boolean               // is the host path expected to exist?
  shape?: PathValueShape          // default "single"
  /**
   * When true, only rewrite elements that look like filesystem paths; leave
   * non-path tokens untouched. Used by `--tasks` / `--test-tasks`, whose
   * values are either bench task IDs (e.g. `bench_foo`) or paths to task JSON
   * files. The predicate mirrors the JIT/bench resolver: a value is path-like
   * if it ends in `.json` or contains a `/`.
   */
  pathLikeOnly?: boolean
}

/**
 * Mirror of the JIT/bench task-ref resolver: a value is treated as a path
 * (and therefore mounted / rewritten) only when it ends in `.json` or contains
 * a slash. Bare identifiers like `bench_task_id` are left alone.
 */
export function looksLikePath(ref: string): boolean {
  return ref.endsWith(".json") || ref.includes("/")
}

/**
 * Every CLI flag whose value is a filesystem path. The launcher uses this to
 * decide which arg values need mount placement / path rewriting before the
 * container starts.
 *
 * Adding a path-shaped flag elsewhere in the codebase requires a matching
 * entry here — otherwise the launcher will pass the host path through
 * unchanged and the container will see a non-existent path.
 *
 * Before committing this file, manually grep for path-shaped CLI flags
 * across `src/index.ts` and the per-command entry files, and verify each
 * is present below. Add any missed flag with the right kind / mode /
 * required.
 *
 * Keep alphabetised within each command group.
 */
export const PATH_FLAGS: PathFlag[] = [
  // run / bench / jit-optimize — primary inputs
  { flag: "--skill",          kind: "dir",  mode: "ro", required: true,  shape: "csv" },
  { flag: "--skill-list",     kind: "file", mode: "ro", required: false },
  { flag: "--task",           kind: "file", mode: "ro", required: true  },
  { flag: "--out",            kind: "dir",  mode: "rw", required: false },
  { flag: "--workspace",      kind: "dir",  mode: "rw", required: false },
  { flag: "--workdir",        kind: "dir",  mode: "rw", required: false },

  // global path overrides
  { flag: "--skvm-cache",     kind: "dir",  mode: "rw", required: false },
  { flag: "--skvm-data-dir",  kind: "dir",  mode: "ro", required: false },
  { flag: "--profiles-dir",   kind: "dir",  mode: "rw", required: false },
  { flag: "--logs-dir",       kind: "dir",  mode: "rw", required: false },
  { flag: "--proposals-dir",  kind: "dir",  mode: "rw", required: false },

  // aot-compile / pipeline / bench — profile TCP file
  { flag: "--profile",        kind: "file", mode: "ro", required: false },

  // jit-optimize specifics
  { flag: "--skill-source",   kind: "dir",  mode: "ro", required: false },
  { flag: "--log-source",     kind: "file", mode: "ro", required: false },
  // --task-source=log: comma-separated lists of execution-log / failures files.
  { flag: "--logs",           kind: "file", mode: "ro", required: true,  shape: "csv" },
  { flag: "--failures",       kind: "file", mode: "ro", required: false, shape: "csv" },
  // --task-source=real: comma-separated list of bench task IDs *or* task JSON
  // paths. pathLikeOnly leaves bare IDs untouched and rewrites only paths.
  { flag: "--tasks",          kind: "file", mode: "ro", required: false, shape: "csv", pathLikeOnly: true },
  { flag: "--test-tasks",     kind: "file", mode: "ro", required: false, shape: "csv", pathLikeOnly: true },

  // proposals
  { flag: "--proposal",       kind: "dir",  mode: "ro", required: false },
  { flag: "--target",         kind: "dir",  mode: "rw", required: false },

  // bench
  { flag: "--bench-config",   kind: "file", mode: "ro", required: false },
  { flag: "--bench-report",   kind: "dir",  mode: "rw", required: false },
  { flag: "--custom",         kind: "file", mode: "ro", required: false },
  { flag: "--manifest",       kind: "dir",  mode: "ro", required: false },
  { flag: "--output-dir",     kind: "dir",  mode: "rw", required: false },
  { flag: "--path",           kind: "dir",  mode: "ro", required: false },
  { flag: "--report",         kind: "file", mode: "rw", required: false },
  { flag: "--skill-path",     kind: "dir",  mode: "ro", required: false },

  // logs / clean
  { flag: "--log-dir",        kind: "dir",  mode: "rw", required: false },
]

/**
 * Resolve a CLI path-flag value to an absolute host path. Handles `~/`,
 * relative paths (against the provided cwd, not `process.cwd()` so the
 * launcher can be tested deterministically), and normalisation.
 *
 * Does **not** check that the path exists — that is the caller's job and is
 * controlled per-flag by `required`.
 */
export function resolvePathFlagValue(value: string, cwd: string): string {
  let expanded = value
  if (expanded.startsWith("~/")) {
    expanded = path.join(process.env.HOME ?? "", expanded.slice(2))
  }
  return path.resolve(cwd, expanded)
}
