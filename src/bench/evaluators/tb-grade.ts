/**
 * Terminal-Bench Verifier Evaluator
 *
 * Custom evaluator that runs a TB 2.1 task's `tests/test.sh` INSIDE the
 * task's docker image and reads the `reward.txt` (0 or 1) it writes. This is
 * the container-verifier half of the host-agent + bind-mount architecture
 * validated by the path-C pilot (see memory skvm-tb-pilot-pi-adapter):
 *
 *   - The agent ran on the HOST against workDir (the adapter owns that).
 *   - This evaluator mounts that same workDir into the TB image at /app
 *     (the image's WORKDIR) and the LF-normalised tests/ at /tests:ro, then
 *     runs `bash /tests/test.sh`. The verifier writes /logs/verifier/reward.txt.
 *
 * The container is created and destroyed within a single `run()` call — one
 * container per task, torn down in `finally` so errored tasks don't leak
 * (pilot坑: orphan containers lingering across the wave).
 *
 * Task-scoped data (dockerImage, testsDir, verifierTimeoutSec) arrives via
 * the criterion's `payload`, written by the terminalbench importer.
 */

import path from "node:path"
import type { CustomEvaluator } from "../../framework/types.ts"
import { registerCustomEvaluator } from "../../framework/types.ts"
import { runSubprocess } from "../../core/subprocess.ts"
import { createLogger } from "../../core/logger.ts"

const log = createLogger("tb-grade")

interface TbGradePayload {
  dockerImage: string
  /** Absolute path to tests/, stamped by the Terminal-Bench importer. */
  testsDir: string
  /** Always set by resolvePayload (defaults to 1200). */
  verifierTimeoutSec: number
}

/** Monotonic counter so parallel tasks get distinct container names. */
let containerSeq = 0
function uniqueContainerName(workDir: string): string {
  containerSeq += 1
  const safe = path.basename(workDir).replace(/[^a-zA-Z0-9_.-]/g, "-")
  return `skvm-tb-${safe}-${process.pid}-${containerSeq}`
}

async function docker(args: string[], opts?: { timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return runSubprocess(["docker", ...args], {
    timeoutMs: opts?.timeoutMs,
    // Git Bash mangles /app /tests /logs into Windows paths without this.
    env: { MSYS_NO_PATHCONV: "1" },
  })
}

/** Parse the payload and enforce the importer's absolute testsDir contract. */
function resolvePayload(payload: unknown): TbGradePayload | { error: string } {
  if (typeof payload !== "object" || payload === null) {
    return { error: "tb-grade: criterion.payload missing (expected {dockerImage, testsDir})" }
  }
  const p = payload as Record<string, unknown>
  if (typeof p.dockerImage !== "string" || !p.dockerImage) {
    return { error: "tb-grade: payload.dockerImage missing" }
  }
  if (typeof p.testsDir !== "string" || !p.testsDir) {
    return { error: "tb-grade: payload.testsDir missing" }
  }
  if (!path.isAbsolute(p.testsDir)) {
    return { error: "tb-grade: payload.testsDir must be an absolute path" }
  }
  const verifierTimeoutSec = typeof p.verifierTimeoutSec === "number" && p.verifierTimeoutSec > 0
    ? p.verifierTimeoutSec
    : 1200
  return { dockerImage: p.dockerImage, testsDir: p.testsDir, verifierTimeoutSec }
}

export const tbGrade: CustomEvaluator = {
  async run({ criterion, runResult }) {
    const workDir = runResult.workDir
    // CustomEvalContext has no taskDir, so the importer stamps an absolute
    // testsDir into the payload before task.json is serialized.
    const resolved = resolvePayload(criterion.payload)
    if ("error" in resolved) {
      return { pass: false, score: 0.0, details: resolved.error }
    }
    const { dockerImage, testsDir, verifierTimeoutSec } = resolved

    const container = uniqueContainerName(workDir)
    // Outer cap: verifier timeout + slack for docker run/exec/rm.
    const outerCapMs = (verifierTimeoutSec + 120) * 1000

    // Pre-flight: a dead docker daemon produces confusing 0-score noise.
    const probe = await docker(["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 15000 })
    if (probe.exitCode !== 0) {
      return {
        pass: false,
        score: 0.0,
        details: `tb-grade: docker daemon unreachable: ${probe.stderr.slice(0, 200) || probe.stdout.slice(0, 200)}`,
      }
    }

    try {
      // 1. Start the container: workDir -> /app (image WORKDIR), tests -> /tests:ro.
      //    Sleep keeps it alive for the exec calls; the verifier runs inside.
      const start = await docker([
        "run", "-d", "--name", container,
        "-v", `${workDir}:/app`,
        "-v", `${testsDir}:/tests:ro`,
        dockerImage,
        "sleep", "36000",
      ], { timeoutMs: 120000 })
      if (start.exitCode !== 0) {
        return {
          pass: false,
          score: 0.0,
          details: `tb-grade: docker run failed: ${start.stderr.slice(0, 300)}`,
        }
      }

      // 2. Verifier writes reward.txt here.
      await docker(["exec", container, "mkdir", "-p", "/logs/verifier"], { timeoutMs: 15000 })

      // 3. Run the TB verifier entrypoint. test.sh runs pytest and writes
      //    /logs/verifier/reward.txt (1 = pass, 0 = fail).
      const verify = await docker(
        ["exec", "-w", "/app", container, "bash", "/tests/test.sh"],
        { timeoutMs: outerCapMs },
      )
      const verifyTail = (verify.stdout + verify.stderr).trim().slice(-800)

      if (verify.timedOut) {
        return {
          pass: false,
          score: 0.0,
          details: `tb-grade: verifier timed out after ${verifierTimeoutSec}s. tail:\n${verifyTail}`,
        }
      }

      // 4. Read reward.txt.
      const reward = await docker(["exec", container, "cat", "/logs/verifier/reward.txt"], { timeoutMs: 15000 })
      const rewardStr = reward.stdout.trim()
      const passed = rewardStr === "1"
      const score = passed ? 1.0 : 0.0

      return {
        pass: passed,
        score,
        details: passed
          ? "Terminal-Bench verifier: PASS (reward=1)"
          : `Terminal-Bench verifier: FAIL (reward=${rewardStr || "(missing)"}). tail:\n${verifyTail}`,
        checkpoints: [{
          name: "tb-verifier",
          score,
          weight: 1.0,
          reason: passed ? undefined : `reward=${rewardStr || "(missing)"}`,
        }],
      }
    } catch (err) {
      return { pass: false, score: 0.0, details: `tb-grade: evaluator error: ${err}` }
    } finally {
      // Always tear down — errored tasks must not leak containers (pilot坑).
      await docker(["rm", "-f", container], { timeoutMs: 30000 }).catch(() => {})
    }
  },

  async checkIntegrity(criterion) {
    const resolved = resolvePayload(criterion.payload)
    if ("error" in resolved) return { ok: false, reason: resolved.error }
    return { ok: true }
  },
}

// Module-top side-effect registration. Importing this module (directly or via
// the bench/evaluators/index.ts barrel) is sufficient to register it.
registerCustomEvaluator("tb-grade", tbGrade)
