/**
 * `skvm jit-optimize --detach` — fire-and-forget invocation.
 *
 * Two-process design: the CLI parent forks one hidden
 * `__jit-optimize-worker` subcommand per skill, awaits an IPC `ready`
 * handshake, prints `Proposal: <id>` for each, and exits. The workers
 * keep running detached; their progress lives in `<proposal>/run-status.json`
 * and `<proposal>/run.log`.
 *
 * Invariants worth knowing before editing:
 *
 *   - The worker acquires the optimize lock BEFORE sending `ready`. A
 *     printed `Proposal: <id>` is therefore a guarantee that the
 *     optimization will actually run.
 *
 *   - On lock contention (or any error before handshake) the worker
 *     deletes the proposal directory it created, so the disk does not
 *     accumulate dead dirs whose id was never announced to anyone.
 *
 *   - The parent must return in well under a second for the calling
 *     agent's UX. Everything heavy (createProposal's skill copy, a
 *     possibly-blocking lock reap, the full runLoop) runs inside the
 *     worker — after handshake for runLoop, before handshake for the
 *     other two.
 */

import path from "node:path"
import { rm } from "node:fs/promises"
import { createWriteStream } from "node:fs"
import { format } from "node:util"

import type { JitOptimizeConfig } from "./types.ts"
import { createLogger } from "../core/logger.ts"
import {
  createProposal,
  acquireOptimizeLock,
  releaseOptimizeLock,
  type CreateProposalResult,
} from "../proposals/storage.ts"
import {
  writeRunStatus,
  patchRunStatus,
  type RunStatus,
} from "./run-status.ts"

const log = createLogger("jit-optimize-detach")

/** argv[2] value that routes to runDetachWorker. Hidden from --help on purpose. */
export const JIT_OPTIMIZE_WORKER_SUBCOMMAND = "__jit-optimize-worker"

// ---------------------------------------------------------------------------
// Wire format between parent and worker
// ---------------------------------------------------------------------------

/**
 * Serialized worker input passed via argv[3] as a JSON string.
 *
 * `config` is a `JitOptimizeConfig` with the non-JSON-safe fields
 * (`evalProvider`, `adapter`) omitted — the CLI never sets those, and the
 * worker re-derives `evalProvider` from `optimizer.model` inside runLoop.
 */
export interface WorkerInput {
  config: JitOptimizeConfig
  lockKey: { harness: string; targetModel: string; skillName: string }
  source: string
}

/**
 * IPC handshake message from worker to parent.
 *
 * Worker sends exactly one message before disconnecting. After that the
 * parent has no further channel into the worker; everything observable goes
 * through `<proposalDir>/run-status.json` and `<proposalDir>/run.log`.
 */
export type HandshakeMsg =
  | { kind: "ready"; proposalId: string; proposalDir: string }
  | { kind: "error"; message: string; exitCode: number }

// 60s: the worker's pre-handshake work is createProposal (a full
// skill-folder copy) + acquireOptimizeLock. Skills with large bundle
// files can legitimately take >10s to copy on slow disks. 60s is still
// fast enough to surface true hangs (import crashes, deadlocks) without
// killing healthy workers mid-setup.
const HANDSHAKE_TIMEOUT_MS = 60_000

// ---------------------------------------------------------------------------
// Parent side: spawn and await handshake
// ---------------------------------------------------------------------------

export interface SpawnInput {
  skillName: string
  workerInput: WorkerInput
}

interface SpawnOutcome {
  skillName: string
  ok: boolean
  proposalId?: string
  proposalDir?: string
  error?: string
  exitCode?: number
}

/**
 * Spawn a single detached worker, await its handshake, print the proposal
 * id, and return an exit code (0 ok, 1 startup error) the caller should
 * pass to `process.exit`.
 *
 * Multi-skill / batch is intentionally unsupported: detached workers
 * outlive the parent, and there is no in-parent way to enforce
 * `--concurrency` against processes that are already running. The CLI
 * rejects `--detach` with multiple skills upstream of this call.
 *
 * The parent never mkdirs, writes files, or touches the optimize lock.
 * Every state side-effect lives inside the worker after spawn returns.
 */
export async function spawnDetachedJitOptimize(input: SpawnInput): Promise<number> {
  const r = await spawnOne(input)
  if (r.ok) {
    // The two-line format is the contract the skvm-jit skill's regex
    // parses ("Proposal: <id>" on its own line).
    console.log(`Proposal: ${r.proposalId}`)
    console.log(`Proposal dir: ${r.proposalDir}`)
    console.log(`Detached; watch with 'skvm proposals show ${r.proposalId}'`)
    return 0
  }
  console.error(`error: ${r.error}`)
  return r.exitCode ?? 1
}

async function spawnOne(input: SpawnInput): Promise<SpawnOutcome> {
  const workerScript = process.argv[1]
  if (!workerScript) {
    return { skillName: input.skillName, ok: false, error: "process.argv[1] is empty; cannot locate skvm entry" }
  }

  const cmd = [process.execPath, workerScript, JIT_OPTIMIZE_WORKER_SUBCOMMAND, JSON.stringify(input.workerInput)]

  return new Promise<SpawnOutcome>((resolve) => {
    let settled = false
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    const finish = (outcome: SpawnOutcome) => {
      if (settled) return
      settled = true
      if (timeoutHandle !== null) clearTimeout(timeoutHandle)
      resolve(outcome)
    }

    let child: ReturnType<typeof Bun.spawn>
    try {
      // stdio: ignore — worker reopens its own stdout/stderr to
      // <proposalDir>/run.log once it knows the path. Pre-handshake errors
      // surface via IPC; native crashes (SEGV) are discarded, which we
      // accept as the cost of not keeping a parent pipe alive.
      child = Bun.spawn({
        cmd,
        stdio: ["ignore", "ignore", "ignore"],
        ipc(message) {
          const msg = message as HandshakeMsg
          if (msg.kind === "ready") {
            // Release the IPC channel and free the parent's event loop.
            try { child.disconnect?.() } catch { /* ignore */ }
            try { child.unref() } catch { /* ignore */ }
            finish({
              skillName: input.skillName,
              ok: true,
              proposalId: msg.proposalId,
              proposalDir: msg.proposalDir,
            })
          } else {
            finish({
              skillName: input.skillName,
              ok: false,
              error: msg.message,
              exitCode: msg.exitCode,
            })
          }
        },
        detached: true,
      })
    } catch (err) {
      finish({ skillName: input.skillName, ok: false, error: `spawn failed: ${err}` })
      return
    }

    // Safety net: child died without reporting — import error, native
    // crash. Pre-handshake output is discarded by design, so direct the
    // user toward rerunning without --detach to see the failure.
    child.exited.then((code) => {
      finish({
        skillName: input.skillName,
        ok: false,
        error: `worker exited with code ${code} before reporting ready ` +
          `(pre-handshake output is not captured; rerun without --detach to see it)`,
      })
    }).catch(() => { /* spawn failure already handled */ })

    timeoutHandle = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      finish({
        skillName: input.skillName,
        ok: false,
        error: `worker did not report ready within ${HANDSHAKE_TIMEOUT_MS / 1000}s ` +
          `(likely stalled before acquiring the optimize lock; rerun without --detach to see what happened)`,
      })
    }, HANDSHAKE_TIMEOUT_MS)
  })
}

// ---------------------------------------------------------------------------
// Child side: worker entry
// ---------------------------------------------------------------------------

function nowIso(): string { return new Date().toISOString() }

/** Best-effort removal — callers invoke this only when the dir is about to be orphaned. */
async function cleanupProposalDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => { /* best effort */ })
}

/**
 * Send a handshake error to the parent and exit.
 *
 * If process.send is not present (the worker was invoked manually rather
 * than via spawn), fall back to stderr so an interactive user still sees
 * the message.
 */
function reportErrorAndExit(message: string, exitCode = 1): never {
  try {
    if (typeof process.send === "function") {
      process.send({ kind: "error", message, exitCode } satisfies HandshakeMsg)
    } else {
      console.error(message)
    }
  } catch { /* ignore */ }
  process.exit(exitCode)
}

/**
 * Re-route the worker's log output into a file.
 *
 * We override `console.*` directly instead of `process.stdout.write`.
 * Bun's native `console` implementation writes to fd 1/2 without going
 * through the JS-level process.stdout.write, so replacing only the stream
 * write method (as Node would allow) leaves all logger output going to
 * the stdio: "ignore" sink the parent set up — i.e., silently to
 * /dev/null. Replacing the console methods themselves intercepts the
 * logger calls (createLogger uses console.log / warn / error / debug).
 *
 * Bun runtime panic traces that go through native writes to fd 1/2 are
 * still lost — acceptable, since the parent's stdio is "ignore" and we
 * do not want a live pipe keeping the parent's event loop alive.
 */
function redirectStdioToFile(filePath: string): void {
  const stream = createWriteStream(filePath, { flags: "a" })
  const writeLine = (...args: unknown[]): void => {
    stream.write(format(...args) + "\n")
  }
  console.log = writeLine
  console.info = writeLine
  console.warn = writeLine
  console.error = writeLine
  console.debug = writeLine
}

/**
 * Worker entry point.
 *
 * Invoked by `src/index.ts` when argv[2] === JIT_OPTIMIZE_WORKER_SUBCOMMAND.
 * `jsonArg` is the JSON-stringified `WorkerInput` from argv[3].
 */
export async function runDetachWorker(jsonArg: string): Promise<void> {
  const { runLoop } = await import("./loop.ts")

  let input: WorkerInput
  try {
    input = JSON.parse(jsonArg) as WorkerInput
  } catch (err) {
    reportErrorAndExit(`failed to parse worker input JSON: ${err}`, 2)
  }
  const { config, lockKey } = input

  let proposal: CreateProposalResult
  try {
    proposal = await createProposal({
      skillName: lockKey.skillName,
      skillDir: config.skillDir,
      harness: lockKey.harness,
      optimizerModel: config.optimizer.model,
      targetModel: lockKey.targetModel,
      source: input.source,
    })
  } catch (err) {
    reportErrorAndExit(`createProposal failed: ${err}`, 1)
  }

  // From here on, console.* lands in run.log. Errors before this point
  // were surfaced via IPC above.
  redirectStdioToFile(path.join(proposal.dir, "run.log"))

  // Lock-before-ready: a printed `Proposal: <id>` is a guarantee the
  // optimization will run. On contention we delete our fresh proposal dir
  // so nothing about this attempt lands on disk.
  const acquired = await acquireOptimizeLock(lockKey.harness, lockKey.targetModel, lockKey.skillName)
  if (!acquired) {
    await cleanupProposalDir(proposal.dir)
    reportErrorAndExit(
      `another optimization is in progress for ${lockKey.harness}/${lockKey.targetModel}/${lockKey.skillName}`,
      1,
    )
  }

  // Write phase=running up front so any reader that beats the patch below
  // still sees a valid state. The queued state was eliminated — there is
  // no observable window between createProposal and handshake where the
  // worker hasn't committed to running.
  const initialStatus: RunStatus = {
    phase: "running",
    pid: process.pid,
    startedAt: nowIso(),
    finishedAt: null,
    error: null,
  }
  try {
    await writeRunStatus(proposal.dir, initialStatus)
  } catch (err) {
    await releaseOptimizeLock(lockKey.harness, lockKey.targetModel, lockKey.skillName)
    await cleanupProposalDir(proposal.dir)
    reportErrorAndExit(`writeRunStatus failed: ${err}`, 1)
  }

  try {
    if (typeof process.send === "function") {
      process.send({
        kind: "ready",
        proposalId: proposal.id,
        proposalDir: proposal.dir,
      } satisfies HandshakeMsg)
      // Disconnect so the IPC channel doesn't hold the parent's event
      // loop alive and we don't accidentally send more messages.
      process.disconnect?.()
    }
  } catch { /* ignore */ }

  try {
    const result = await runLoop(config, { proposal })
    await patchRunStatus(proposal.dir, {
      phase: "done",
      finishedAt: nowIso(),
    })
    log.info(`worker done: best=round-${result.bestRound} (${result.bestRoundReason})`)
    process.exit(0)
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : `${err}`
    await patchRunStatus(proposal.dir, {
      phase: "failed",
      finishedAt: nowIso(),
      error: message,
    }).catch(() => { /* best effort */ })
    log.error(`worker failed: ${message}`)
    process.exit(1)
  } finally {
    await releaseOptimizeLock(lockKey.harness, lockKey.targetModel, lockKey.skillName).catch(() => { /* best effort */ })
  }
}
