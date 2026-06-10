/**
 * Unified-diff between two round directories inside a proposal.
 *
 * Implementation uses `git diff --no-index` as a standalone diff tool —
 * neither side needs to be inside a git repo, git is just an always-available
 * unified-diff engine on dev machines. Detected once per process; missing git
 * degrades gracefully to a reason string so HTML/CLI can show a hint instead
 * of crashing.
 */

import { spawn } from "node:child_process"
import { ORIGINAL_DIR_NAME, roundDirName } from "./storage.ts"

export interface DiffResult {
  ok: true
  unified: string
  leftLabel: string
  rightLabel: string
}

export interface DiffFailure {
  ok: false
  reason: string
}

let gitAvailable: boolean | null = null

async function hasGit(): Promise<boolean> {
  if (gitAvailable !== null) return gitAvailable
  gitAvailable = await new Promise<boolean>((resolve) => {
    const child = spawn("git", ["--version"], { stdio: ["ignore", "ignore", "ignore"] })
    child.once("error", () => resolve(false))
    child.once("exit", (code) => resolve(code === 0))
  })
  return gitAvailable
}

/**
 * Run `git diff --no-index` between two paths. Paths are interpreted relative
 * to `cwd` so diff headers stay short ("original/SKILL.md" rather than a full
 * absolute path). Exits 0 when identical, 1 when different — both are success
 * for us. Any other exit is a failure.
 */
async function runGitDiff(
  cwd: string,
  left: string,
  right: string,
): Promise<DiffResult | DiffFailure> {
  return new Promise((resolve) => {
    const child = spawn(
      "git",
      ["-c", "core.quotepath=false", "diff", "--no-index", "--no-color", "--", left, right],
      { stdio: ["ignore", "pipe", "pipe"], cwd },
    )
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (c) => (stdout += c.toString()))
    child.stderr.on("data", (c) => (stderr += c.toString()))
    child.once("error", (err) => resolve({ ok: false, reason: `git spawn failed: ${err.message}` }))
    child.once("exit", (code) => {
      if (code === 0 || code === 1) {
        resolve({ ok: true, unified: stdout, leftLabel: left, rightLabel: right })
      } else {
        resolve({ ok: false, reason: `git diff exited ${code}: ${stderr.trim() || "(no stderr)"}` })
      }
    })
  })
}

/**
 * Diff `original/` vs `round-N/` inside a proposal directory.
 * `round` defaults to the proposal's bestRound.
 */
export async function diffProposalRound(
  proposalDir: string,
  round: number,
): Promise<DiffResult | DiffFailure> {
  if (!(await hasGit())) {
    return {
      ok: false,
      reason: "git not found on PATH — install git to view proposal diffs",
    }
  }
  return runGitDiff(proposalDir, ORIGINAL_DIR_NAME, roundDirName(round))
}
