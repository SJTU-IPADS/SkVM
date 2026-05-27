import path from "node:path"

export interface PathFlag {
  flag: string                    // e.g. "--skill"
  kind: "file" | "dir"
  mode: "ro" | "rw"
  required: boolean               // is the host path expected to exist?
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
  { flag: "--skill",          kind: "dir",  mode: "ro", required: true  },
  { flag: "--task",           kind: "file", mode: "ro", required: true  },
  { flag: "--out",            kind: "dir",  mode: "rw", required: false },
  { flag: "--workspace",      kind: "dir",  mode: "rw", required: false },

  // global path overrides
  { flag: "--skvm-cache",     kind: "dir",  mode: "rw", required: false },
  { flag: "--skvm-data-dir",  kind: "dir",  mode: "ro", required: false },
  { flag: "--profiles-dir",   kind: "dir",  mode: "rw", required: false },
  { flag: "--logs-dir",       kind: "dir",  mode: "rw", required: false },
  { flag: "--proposals-dir",  kind: "dir",  mode: "rw", required: false },

  // jit-optimize specifics
  { flag: "--skill-source",   kind: "dir",  mode: "ro", required: false },
  { flag: "--log-source",     kind: "file", mode: "ro", required: false },

  // proposals
  { flag: "--proposal",       kind: "dir",  mode: "ro", required: false },

  // bench
  { flag: "--bench-config",   kind: "file", mode: "ro", required: false },
  { flag: "--bench-report",   kind: "dir",  mode: "rw", required: false },

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
