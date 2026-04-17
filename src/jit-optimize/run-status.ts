/**
 * run-status.json — execution-phase status for `skvm jit-optimize --detach`.
 *
 * This file is **independent** of `meta.json.status`:
 *   - meta.json.status tracks the human decision (pending → accepted/rejected).
 *   - run-status.json tracks the execution phase (running → done/failed).
 *
 * Only detached workers write run-status.json. Sync CLI runs and direct
 * library calls (bench) leave it absent; readers MUST treat absence as
 * "legacy/sync proposal — already finished".
 *
 * Best-round data lives only in meta.json (written by finalizeProposal) —
 * we do not duplicate it here.
 */

import path from "node:path"
import { readFile, writeFile, stat } from "node:fs/promises"
import { z } from "zod"
import { isPidAlive } from "../core/file-lock.ts"

export const RunPhaseSchema = z.enum(["running", "done", "failed"])
export type RunPhase = z.infer<typeof RunPhaseSchema>

export const RunStatusSchema = z.object({
  phase: RunPhaseSchema,
  pid: z.number().int(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
})
export type RunStatus = z.infer<typeof RunStatusSchema>

const RUN_STATUS_FILENAME = "run-status.json"

export function runStatusPath(proposalDir: string): string {
  return path.join(proposalDir, RUN_STATUS_FILENAME)
}

export async function readRunStatus(proposalDir: string): Promise<RunStatus | null> {
  try {
    const raw = await readFile(runStatusPath(proposalDir), "utf8")
    return RunStatusSchema.parse(JSON.parse(raw))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    // Malformed / partially written: treat as absent. The worker may be
    // mid-write; subsequent reads will catch the consistent state.
    return null
  }
}

export async function writeRunStatus(proposalDir: string, status: RunStatus): Promise<void> {
  const parsed = RunStatusSchema.parse(status)
  await writeFile(runStatusPath(proposalDir), JSON.stringify(parsed, null, 2))
}

export async function patchRunStatus(
  proposalDir: string,
  patch: Partial<RunStatus>,
): Promise<RunStatus | null> {
  const current = await readRunStatus(proposalDir)
  if (current === null) return null
  const merged: RunStatus = { ...current, ...patch }
  await writeRunStatus(proposalDir, merged)
  return merged
}

/**
 * Detect orphaned `running` workers and rewrite the file as `failed`.
 *
 * If the recorded pid is no longer alive, the worker died without updating
 * the status (SIGKILL, SEGV, hard reboot). We can't recover the run, but we
 * can stop the proposal from claiming to be in-progress forever.
 */
export async function selfHealRunStatus(proposalDir: string): Promise<RunStatus | null> {
  const status = await readRunStatus(proposalDir)
  if (status === null) return null
  if (status.phase !== "running") return status
  if (isPidAlive(status.pid)) return status
  return patchRunStatus(proposalDir, {
    phase: "failed",
    finishedAt: new Date().toISOString(),
    error: status.error ?? `worker pid ${status.pid} disappeared while phase=running`,
  })
}

export async function runStatusExists(proposalDir: string): Promise<boolean> {
  try {
    await stat(runStatusPath(proposalDir))
    return true
  } catch { return false }
}
