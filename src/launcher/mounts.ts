import path from "node:path"
import { existsSync as fsExistsSync } from "node:fs"
import { PATH_FLAGS, resolvePathFlagValue, type PathFlag } from "./path-flags.ts"

// fsExistsSync is used by callers who want real filesystem checks.
// The composeMounts default is () => true (pure path manipulation) — callers
// that need hard existence validation inject fsExistsSync or a stub.
export { fsExistsSync }

export interface HostRoots {
  cwd: string
  skvmCache: string
  skvmDataDir: string | null
  sanitizedConfigPath: string
}

export interface DockerMount {
  host: string
  inner: string
  mode: "ro" | "rw"
}

export interface ComposeMountsArgs {
  args: string[]
  roots: HostRoots
  existsSync?: (p: string) => boolean
}

export interface ComposeMountsResult {
  mounts: DockerMount[]
  rewrittenArgs: string[]
  argv: string[]
}

/** Inner paths for the three fixed host roots. */
const INNER_WORKSPACE = "/workspace"
const INNER_CACHE = "/skvm-cache"
const INNER_DATA = "/skvm-data"

/**
 * Widen mode: rw beats ro.
 */
function widenMode(a: "ro" | "rw", b: "ro" | "rw"): "ro" | "rw" {
  return a === "rw" || b === "rw" ? "rw" : "ro"
}

/**
 * Convert a DockerMount to its `-v host:inner:mode` string (without the "-v"
 * prefix; callers interleave "-v" separately for argv).
 */
function mountToSpec(m: DockerMount): string {
  return `${m.host}:${m.inner}:${m.mode}`
}

/**
 * Given a host absolute path and the three fixed host roots, return the inner
 * rewritten path if the host path falls under one of those roots, or null if
 * it is outside all of them.
 */
function rewriteUnderFixedRoots(
  hostPath: string,
  roots: HostRoots,
): string | null {
  // Normalise to ensure prefix matching works correctly.
  const fixed: Array<{ hostRoot: string; innerRoot: string }> = [
    { hostRoot: roots.cwd, innerRoot: INNER_WORKSPACE },
    { hostRoot: roots.skvmCache, innerRoot: INNER_CACHE },
    ...(roots.skvmDataDir !== null
      ? [{ hostRoot: roots.skvmDataDir, innerRoot: INNER_DATA }]
      : []),
  ]

  for (const { hostRoot, innerRoot } of fixed) {
    if (hostPath === hostRoot) {
      return innerRoot
    }
    const prefix = hostRoot.endsWith("/") ? hostRoot : hostRoot + "/"
    if (hostPath.startsWith(prefix)) {
      const rel = hostPath.slice(prefix.length)
      return innerRoot + "/" + rel
    }
  }

  return null
}

/**
 * Parse a single raw arg string for a known path flag.
 * Returns `{ flag: PathFlag, value: string }` or null.
 */
function parsePathArg(
  raw: string,
): { flag: PathFlag; value: string } | null {
  for (const flag of PATH_FLAGS) {
    const prefix = flag.flag + "="
    if (raw.startsWith(prefix)) {
      return { flag, value: raw.slice(prefix.length) }
    }
  }
  return null
}

/**
 * For an out-of-root path-flag entry, compute the canonical "host root" that
 * should be mounted:
 *  - dir-kind: the path itself is treated as a directory; host root = hostPath.
 *  - file-kind: mount the parent directory; host root = dirname(hostPath).
 */
function getHostRoot(hostPath: string, kind: "file" | "dir"): string {
  return kind === "file" ? path.dirname(hostPath) : hostPath
}

/**
 * For an out-of-root path-flag entry, compute the inner path (what the flag
 * value should become inside the container) given the group's inner mount root
 * and the group's host root.
 *
 * For singleton groups (no prefix dedup):
 *  - dir-kind: inner = innerGroupRoot + "/" + basename(hostPath)
 *  - file-kind: inner = innerGroupRoot + "/" + basename(hostPath)
 *    (host root is the parent dir; basename is the filename)
 *
 * For dedup'd groups:
 *  - inner = path.posix.join(innerGroupRoot, path.relative(groupHostRoot, hostPath))
 *    where groupHostRoot is the broader (shorter) root shared by the group.
 */
function computeInnerPath(
  hostPath: string,
  kind: "file" | "dir",
  innerGroupRoot: string,
  groupHostRoot: string,
  singleton: boolean,
): string {
  if (singleton) {
    // dir-kind: mount = /extra/<idx>/<basename(hostPath)>
    // file-kind: mount = /extra/<idx> (parent), flag = /extra/<idx>/<basename>
    const base = path.basename(hostPath)
    return innerGroupRoot + "/" + base
  }
  // Dedup'd: compute relative from the group's host root.
  const rel = path.relative(groupHostRoot, hostPath)
  if (rel === "") {
    return innerGroupRoot
  }
  return innerGroupRoot + "/" + rel
}

/**
 * Compose all Docker bind-mount arguments and rewritten CLI args for the
 * Strategy-C launcher.
 *
 * Algorithm:
 *  1. Emit three fixed default mounts (cwd, skvm-cache, skvm-data?).
 *  2. Emit the sanitised-config overlay mount.
 *  3. Walk the input args. For each path-flag:
 *     a. Resolve the value to an absolute host path.
 *     b. If required and does not exist, throw.
 *     c. If it falls under a fixed root, rewrite in place — no new mount.
 *     d. Otherwise, register it as an out-of-root path entry.
 *  4. Group out-of-root entries by prefix dedup (see below).
 *  5. Assign /extra/<idx> indices; emit one mount per group.
 *  6. Compute rewritten arg values from group inner roots.
 *
 * Prefix dedup:
 *  - Entries are processed in order of their host root length (shorter first).
 *  - If a new entry's host root starts with an already-registered group's
 *    host root, the new entry joins that group.
 *  - Sibling paths (neither is a prefix of the other) each get their own group.
 *  - A group's mode widens to rw if any participant contributes rw.
 */
export function composeMounts({
  args,
  roots,
  existsSync = () => true,
}: ComposeMountsArgs): ComposeMountsResult {
  // ── 1. Fixed default mounts ──────────────────────────────────────────────
  const defaultMounts: DockerMount[] = [
    { host: roots.cwd, inner: INNER_WORKSPACE, mode: "rw" },
    { host: roots.skvmCache, inner: INNER_CACHE, mode: "rw" },
    ...(roots.skvmDataDir !== null
      ? [{ host: roots.skvmDataDir, inner: INNER_DATA, mode: "ro" as const }]
      : []),
    // Sanitized-config overlay: mounts on top of the cache directory.
    {
      host: roots.sanitizedConfigPath,
      inner: INNER_CACHE + "/skvm.config.json",
      mode: "ro" as const,
    },
  ]

  // ── 2. Walk args for path flags ──────────────────────────────────────────
  interface OutOfRootEntry {
    argIndex: number    // index in rewrittenArgs array
    hostPath: string    // absolute resolved host path
    hostRoot: string    // the path to mount (parent for file-kind, self for dir-kind)
    kind: "file" | "dir"
    mode: "ro" | "rw"
    flagName: string
  }

  const rewrittenArgs: string[] = [...args]
  const outOfRoot: OutOfRootEntry[] = []

  for (let i = 0; i < args.length; i++) {
    const raw = args[i]
    if (raw === undefined) continue
    const parsed = parsePathArg(raw)
    if (parsed === null) continue

    const { flag, value } = parsed
    const hostPath = resolvePathFlagValue(value, roots.cwd)

    // Try to rewrite under a fixed root (no new mount needed).
    const innerFixed = rewriteUnderFixedRoots(hostPath, roots)
    if (innerFixed !== null) {
      rewrittenArgs[i] = flag.flag + "=" + innerFixed
      continue
    }

    // Out-of-root path: check existence for required flags before mounting.
    if (flag.required && !existsSync(hostPath)) {
      throw new Error(
        `${flag.flag}: required path does not exist: ${hostPath}`,
      )
    }

    // Out-of-root: register for dynamic mount assignment.
    const hostRoot = getHostRoot(hostPath, flag.kind)
    outOfRoot.push({
      argIndex: i,
      hostPath,
      hostRoot,
      kind: flag.kind,
      mode: flag.mode,
      flagName: flag.flag,
    })
  }

  // ── 3. Group out-of-root entries by prefix dedup ─────────────────────────
  //
  // A "group" represents one Docker mount. Each group has:
  //   - hostRoot: the host path to mount (the broadest covering root)
  //   - mode: widened across all participants
  //   - members: the out-of-root entries that belong to this group
  //
  // We assign entries in input order. For each entry we check whether its
  // hostRoot is a descendant of any existing group's hostRoot. If so, it joins
  // that group. Otherwise, we also check whether the new entry's hostRoot is a
  // prefix of an existing group — in that case the new entry becomes the new
  // (broader) hostRoot for that group. If neither applies, a new group is
  // created.

  interface MountGroup {
    hostRoot: string
    mode: "ro" | "rw"
    members: OutOfRootEntry[]
  }

  const groups: MountGroup[] = []

  for (const entry of outOfRoot) {
    const entryRoot = entry.hostRoot

    // Try to find an existing group where entryRoot is a descendant.
    let placed = false
    for (const group of groups) {
      const gRoot = group.hostRoot
      if (
        entryRoot === gRoot ||
        entryRoot.startsWith(gRoot.endsWith("/") ? gRoot : gRoot + "/")
      ) {
        // Entry falls under an existing broader group.
        group.mode = widenMode(group.mode, entry.mode)
        group.members.push(entry)
        placed = true
        break
      }
      // Check if the new entry's root is BROADER (prefix) than the group's root.
      if (
        gRoot.startsWith(
          entryRoot.endsWith("/") ? entryRoot : entryRoot + "/",
        )
      ) {
        // New entry is broader — expand the group's host root.
        group.hostRoot = entryRoot
        group.mode = widenMode(group.mode, entry.mode)
        group.members.push(entry)
        placed = true
        break
      }
    }

    if (!placed) {
      groups.push({
        hostRoot: entryRoot,
        mode: entry.mode,
        members: [entry],
      })
    }
  }

  // ── 4. Assign /extra/<idx> indices and build dynamic mounts ──────────────
  const dynamicMounts: DockerMount[] = []

  for (const [idx, group] of groups.entries()) {
    const innerGroupRoot = `/extra/${idx}`
    const singleton = group.members.length === 1

    // Determine the host path to actually mount.
    // For a singleton:
    //   - dir-kind: mount the dir itself (hostRoot = hostPath). The inner mount
    //     path becomes /extra/<idx>/<basename>.
    //   - file-kind: mount the parent (hostRoot = dirname(hostPath)). The inner
    //     path becomes /extra/<idx>/<basename>.
    // For dedup'd groups: mount the broader hostRoot; inner paths are computed
    // via relative().

    let mountHost: string
    let mountInner: string

    if (singleton) {
      const member = group.members[0]
      if (member === undefined) continue  // unreachable; satisfies TS
      if (member.kind === "dir") {
        // Mount = /extra/<idx>/<basename(hostPath)>
        const base = path.basename(member.hostPath)
        mountHost = member.hostPath
        mountInner = innerGroupRoot + "/" + base
      } else {
        // file-kind: mount parent dir at /extra/<idx>
        mountHost = member.hostRoot  // already dirname(hostPath)
        mountInner = innerGroupRoot
      }
    } else {
      // Dedup'd group: mount the broader hostRoot at /extra/<idx>.
      mountHost = group.hostRoot
      mountInner = innerGroupRoot
    }

    dynamicMounts.push({
      host: mountHost,
      inner: mountInner,
      mode: group.mode,
    })

    // Rewrite each member's arg.
    for (const member of group.members) {
      let innerPath: string
      if (singleton) {
        if (member.kind === "dir") {
          innerPath = mountInner  // /extra/<idx>/<basename>
        } else {
          // file-kind: innerGroupRoot + "/" + basename(hostPath)
          innerPath = innerGroupRoot + "/" + path.basename(member.hostPath)
        }
      } else {
        // Dedup'd: compute relative from the group's host root.
        const rel = path.relative(group.hostRoot, member.hostPath)
        innerPath = rel === "" ? mountInner : mountInner + "/" + rel
      }
      rewrittenArgs[member.argIndex] = member.flagName + "=" + innerPath
    }
  }

  // ── 5. Assemble result ────────────────────────────────────────────────────
  const allMounts: DockerMount[] = [...defaultMounts, ...dynamicMounts]

  const argv: string[] = []
  for (const m of allMounts) {
    argv.push("-v", mountToSpec(m))
  }

  return {
    mounts: allMounts,
    rewrittenArgs,
    argv,
  }
}
