// test/cli/profile-exit-code.test.ts
//
// `skvm profile` must exit non-zero when a profile run fails (#83): both
// failure paths call process.exit(1), which would kill an in-process test —
// so these tests spawn the real CLI (same pattern as
// deprecated-flag-hints.test.ts) against a fresh SKVM_CACHE and assert the
// exit status plus the recorded session state. An unroutable model id is the
// forcing input: route resolution throws in adapter setup, fast and offline.
import { describe, test, expect } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const cli = path.resolve(__dirname, "../../src/index.ts")

function runProfileCli(models: string): {
  code: number | null
  stderr: string
  sessions: Array<{ type: string; status: string }>
} {
  const cache = mkdtempSync(path.join(os.tmpdir(), "skvm-profile-exit-"))
  // Hermetic child env: drop the developer's cache-subdir overrides
  // (src/core/config.ts — SKVM_PROFILES_DIR / SKVM_LOGS_DIR /
  // SKVM_PROPOSALS_DIR redirect individual subdirs out of SKVM_CACHE), so
  // everything the child writes lands under the fresh temp cache and the
  // sessions.jsonl assertion below reads what this run wrote.
  const env: Record<string, string | undefined> = { ...process.env, SKVM_CACHE: cache }
  delete env.SKVM_PROFILES_DIR
  delete env.SKVM_LOGS_DIR
  delete env.SKVM_PROPOSALS_DIR
  const r = spawnSync("bun", ["run", cli, "profile", `--model=${models}`], {
    encoding: "utf8",
    env,
    timeout: 60_000,
  })
  const sessionsPath = path.join(cache, "log", "sessions.jsonl")
  let sessions: Array<{ type: string; status: string }> = []
  try {
    sessions = readFileSync(sessionsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    // leave empty — assertions below will fail with a clear diff
  }
  return { code: r.status, stderr: r.stderr, sessions }
}

describe("skvm profile — non-zero exit on failure (#83)", () => {
  test("single job: unroutable --model exits 1 with the session marked failed", () => {
    const { code, stderr, sessions } = runProfileCli("bogus/nope")
    expect(code).toBe(1)
    // Single-job catch path prints the red FAILED line to stderr
    expect(stderr).toContain("FAILED")
    // sessions.jsonl is append-only: running first, then the failed update
    const last = sessions.at(-1)
    expect(last?.type).toBe("profile")
    expect(last?.status).toBe("failed")
  })

  test("multi job: unroutable models exit 1 with the session marked failed", () => {
    // Two models → profileMulti path. Adapter setup throws inside the
    // scheduler's createRunner, which escapes profileMulti entirely — the
    // post-start try/catch must still mark the session failed and the
    // process must exit non-zero (crash-handler path).
    const { code, sessions } = runProfileCli("bogus/a,bogus/b")
    expect(code).toBe(1)
    const last = sessions.at(-1)
    expect(last?.type).toBe("profile")
    expect(last?.status).toBe("failed")
  })
})
