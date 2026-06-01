import path from "node:path"
import { existsSync as fsExistsSync } from "node:fs"
import { PATH_FLAGS, resolvePathFlagValue, looksLikePath, type PathFlag } from "./path-flags.ts"

// The composeMounts default is fsExistsSync (real fs check). Tests that
// exercise non-existent paths inject `() => true` or `() => false`.
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
  configExtraMounts?: Array<{ host: string; inner: string; mode: "ro" | "rw" }>
  cliExtraMounts?: Array<{ host: string; inner: string; mode: "ro" | "rw" }>
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
 *  - Entries are processed in input (CLI arg) order.
 *  - If a new entry's host root starts with an already-registered group's
 *    host root, the new entry joins that group.
 *  - Sibling paths (neither is a prefix of the other) each get their own group.
 *  - A group's mode widens to rw if any participant contributes rw.
 */
export function composeMounts({
  args,
  roots,
  existsSync = fsExistsSync,
  configExtraMounts = [],
  cliExtraMounts = [],
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
    // Config-level extra mounts (sandbox.docker.extraMounts).
    ...configExtraMounts,
    // CLI-level extra mounts (--mount-extra=host:inner:ro|rw).
    ...cliExtraMounts,
  ]

  // ── 2. Walk args for path flags ──────────────────────────────────────────
  //
  // Each path-flag arg expands into one or more *elements* (single flags have
  // one; csv flags split on ","). Every element is rewritten independently:
  // fixed-root elements are resolved here; out-of-root elements are deferred to
  // the dynamic-mount grouping below and back-filled into their slot. After
  // grouping, each arg is reassembled from its (now-complete) element list.
  interface OutOfRootEntry {
    argIndex: number    // index in rewrittenArgs array
    elementSlot: number // which csv element of that arg this is
    hostPath: string    // absolute resolved host path
    hostRoot: string    // the path to mount (parent for file-kind, self for dir-kind)
    kind: "file" | "dir"
    mode: "ro" | "rw"
    flagName: string
  }

  interface PendingArg {
    argIndex: number
    flagName: string
    elements: Array<string | null>  // inner value per element; null = out-of-root pending
  }

  const rewrittenArgs: string[] = [...args]
  const outOfRoot: OutOfRootEntry[] = []
  const pendingByIndex = new Map<number, PendingArg>()

  for (let i = 0; i < args.length; i++) {
    const raw = args[i]
    if (raw === undefined) continue
    const parsed = parsePathArg(raw)
    if (parsed === null) continue

    const { flag, value } = parsed
    const rawElements = (flag.shape ?? "single") === "csv" ? value.split(",") : [value]
    const elements: Array<string | null> = new Array(rawElements.length).fill(null)

    for (let slot = 0; slot < rawElements.length; slot++) {
      const el = rawElements[slot]!

      // pathLikeOnly: leave non-path tokens (e.g. bench task IDs) verbatim.
      if (flag.pathLikeOnly && !looksLikePath(el)) {
        elements[slot] = el
        continue
      }

      const hostPath = resolvePathFlagValue(el, roots.cwd)

      // Try to rewrite under a fixed root (no new mount needed).
      const innerFixed = rewriteUnderFixedRoots(hostPath, roots)
      if (innerFixed !== null) {
        elements[slot] = innerFixed
        continue
      }

      // Out-of-root path: check existence for required flags before mounting.
      if (flag.required && !existsSync(hostPath)) {
        throw new Error(
          `${flag.flag}: required path does not exist: ${hostPath}`,
        )
      }

      // Out-of-root: register for dynamic mount assignment; slot stays null.
      outOfRoot.push({
        argIndex: i,
        elementSlot: slot,
        hostPath,
        hostRoot: getHostRoot(hostPath, flag.kind),
        kind: flag.kind,
        mode: flag.mode,
        flagName: flag.flag,
      })
    }

    pendingByIndex.set(i, { argIndex: i, flagName: flag.flag, elements })
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

    // Back-fill each member's element slot with its computed inner path.
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
      const pending = pendingByIndex.get(member.argIndex)
      if (pending !== undefined) pending.elements[member.elementSlot] = innerPath
    }
  }

  // ── 5. Reassemble each path-flag arg from its (now-complete) elements ─────
  for (const pending of pendingByIndex.values()) {
    const joined = pending.elements.map(e => e ?? "").join(",")
    rewrittenArgs[pending.argIndex] = pending.flagName + "=" + joined
  }

  // ── 6. Assemble result ────────────────────────────────────────────────────
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
