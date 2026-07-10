import { mkdir } from "node:fs/promises"
import path from "node:path"
import type {
  AgentAdapter,
  AdapterConfig,
  AdapterConfigMode,
  RunResult,
  SkillBundle,
} from "../core/types.ts"
import { createLogger } from "../core/logger.ts"
import { getAdapterRepoDir, getAdapterSettings } from "../core/config.ts"
import { envForRoute, resolveRoute, resolveBackendModel, validateModelIdForRoute } from "../providers/registry.ts"
import { runSubprocess } from "../core/subprocess.ts"
import { subprocessVerdict } from "./subprocess-verdict.ts"
import { TASK_FILE_DEFAULTS } from "../core/ui-defaults.ts"
import {
  createSandbox,
  ensureDir,
  copyFileIfExists,
  symlinkIfExists,
  type Sandbox,
} from "../core/adapter-sandbox.ts"
import {
  piBuildRunRecordFromNDJSON,
  piBuildRunRecordFromFile,
  toPiModel,
  renderPiBaseUrlOverride,
  renderPiModelRegistration,
} from "../core/pi-runtime.ts"
import { startContainer, execInContainer } from "../core/docker-run.ts"

const log = createLogger("pi")

const HOME = process.env.HOME ?? ""
/** User-side pi config dir (`~/.pi/agent/`). Mirrored into sandbox in native mode. */
const PI_USER_AGENT_DIR = path.join(HOME, ".pi", "agent")

// ---------------------------------------------------------------------------
// Command Resolution (tiered)
// ---------------------------------------------------------------------------
//
// Contract matches opencode's: a Tier returns a hit or null (not configured,
// try next). A tier THROWS when configured-but-broken (e.g. repoPath set but
// nothing usable inside) so the user sees a clear error instead of silent
// fallthrough to a surprising alternative.

type TierHit = { cmd: string[]; logLine: string }
type Tier = () => Promise<TierHit | null>

const INSTALL_HELP =
  "Install with `npm i -g @mariozechner/pi-coding-agent`, or set `adapters.pi.repoPath` to a pi-mono checkout."

// Throws when repoPath is set but the checkout has neither source nor built
// entry — a misconfigured contributor checkout, not a silent-skip case.
const tierAdapterRepo: Tier = async () => {
  const repoDir = getAdapterRepoDir("pi")
  if (!repoDir) return null
  const pkgDir = path.join(repoDir, "packages/coding-agent")

  // Prefer source: contributors editing pi-mono get live behavior without
  // rebuilding dist/. Invoke via absolute path — do NOT use `bun --cwd`,
  // which would change the child process's cwd to pkgDir and break pi's
  // assumption that the user's workDir is the cwd.
  const srcEntry = path.join(pkgDir, "src/cli.ts")
  if (await Bun.file(srcEntry).exists()) {
    return {
      cmd: ["bun", srcEntry],
      logLine: `Using pi from source: ${repoDir}`,
    }
  }

  // Then the Bun-compiled single-file binary produced by `npm run build:binary`.
  const binary = path.join(pkgDir, "dist/pi")
  if (await Bun.file(binary).exists()) {
    return { cmd: [binary], logLine: `Using pi binary: ${binary}` }
  }

  // Finally the node entry from `npm run build`.
  const distJs = path.join(pkgDir, "dist/cli.js")
  if (await Bun.file(distJs).exists()) {
    return { cmd: ["node", distJs], logLine: `Using pi node entry: ${distJs}` }
  }

  throw new Error(
    `pi not found at ${repoDir} (no packages/coding-agent/src/cli.ts, dist/pi, or dist/cli.js)`,
  )
}

const tierGlobal: Tier = async () => {
  const { exitCode, stdout } = await runSubprocess(["which", "pi"])
  if (exitCode !== 0 || !stdout.trim()) return null
  const p = stdout.trim()
  return { cmd: [p], logLine: `Using global pi: ${p}` }
}

const tierNpx: Tier = async () => ({
  cmd: ["npx", "-y", "@mariozechner/pi-coding-agent"],
  logLine: "Falling back to npx @mariozechner/pi-coding-agent",
})

export async function resolvePiCmd(): Promise<string[]> {
  for (const tier of [tierAdapterRepo, tierGlobal, tierNpx]) {
    const hit = await tier()
    if (hit) {
      log.info(hit.logLine)
      return hit.cmd
    }
  }
  throw new Error(`pi not found. ${INSTALL_HELP}`)
}

// ---------------------------------------------------------------------------
// Pi Adapter
// ---------------------------------------------------------------------------

export class PiAdapter implements AgentAdapter {
  readonly name = "pi"
  private model = ""
  private timeoutMs: number = TASK_FILE_DEFAULTS.timeoutMs
  private cmdPrefix: string[] = []
  private mode: AdapterConfigMode = "managed"
  private extraCliArgs: string[] = []
  private sandbox: Sandbox | undefined
  private piAgentDir: string | undefined
  /** Cached SDK env overlay derived from the skvm route at setup time. */
  private routeEnv: Record<string, string> = {}
  /** Cached models.json contents from setup(). Container-mode writes this
   * into its own sandbox path — cheaper and safer than re-resolving the
   * route from the pi-side model id (which strips the skvm prefix). */
  private modelsJson: string | null = null

  async setup(config: AdapterConfig): Promise<void> {
    this.timeoutMs = config.timeoutMs ?? TASK_FILE_DEFAULTS.timeoutMs
    this.mode = config.mode ?? "managed"

    const settings = getAdapterSettings("pi")
    this.extraCliArgs = config.extraCliArgs ?? settings.extraCliArgs ?? []

    this.cmdPrefix = await resolvePiCmd()

    // Fail-fast validation before sandbox setup so the user sees a clear
    // error at the adapter boundary instead of a cryptic failure inside pi.
    if (this.mode === "native") {
      const authExists = await Bun.file(path.join(PI_USER_AGENT_DIR, "auth.json")).exists()
      const modelsExists = await Bun.file(path.join(PI_USER_AGENT_DIR, "models.json")).exists()
      if (!authExists && !modelsExists) {
        throw new Error(
          `pi (native): ${PI_USER_AGENT_DIR} has no auth.json or models.json. ` +
          `Run pi's own setup (e.g. \`pi /login\`) first, or switch to --adapter-config=managed.`,
        )
      }
      // Native mode: pass the user's model id through unchanged; their pi
      // config (models.json / auth.json) owns resolution.
      this.model = config.model
    } else {
      let route
      try {
        route = resolveRoute(config.model)
        validateModelIdForRoute(config.model, route)
      } catch (err) {
        throw new Error(
          `pi (managed): ${(err as Error).message} Run \`skvm config init\` to add a route, ` +
          `or switch to --adapter-config=native.`,
        )
      }
      this.model = toPiModel(config.model, route)
      this.routeEnv = envForRoute(config.model)
    }

    this.sandbox = createSandbox("pi")
    const root = this.sandbox.root
    this.piAgentDir = root
    ensureDir(path.join(root, "sessions"))

    if (this.mode === "native") {
      // Copy writable state so runs in parallel sandboxes can't race on the
      // user's real config. Symlink static asset dirs so live edits show up.
      copyFileIfExists(path.join(PI_USER_AGENT_DIR, "auth.json"), path.join(root, "auth.json"))
      copyFileIfExists(path.join(PI_USER_AGENT_DIR, "models.json"), path.join(root, "models.json"))
      copyFileIfExists(path.join(PI_USER_AGENT_DIR, "settings.json"), path.join(root, "settings.json"))
      symlinkIfExists(path.join(PI_USER_AGENT_DIR, "skills"), path.join(root, "skills"))
      symlinkIfExists(path.join(PI_USER_AGENT_DIR, "prompts"), path.join(root, "prompts"))
      symlinkIfExists(path.join(PI_USER_AGENT_DIR, "themes"), path.join(root, "themes"))
      symlinkIfExists(path.join(PI_USER_AGENT_DIR, "tools"), path.join(root, "tools"))
      symlinkIfExists(path.join(PI_USER_AGENT_DIR, "bin"), path.join(root, "bin"))
    } else {
      // Managed: start from empty. The pi CLI has a relaxed fallback that
      // synthesises a model entry for uncatalogued ids, so we never need to
      // register model ids here — doing so would clobber built-in metadata
      // (reasoning / contextWindow / maxTokens) for any id pi already knows.
      // We only write models.json when an openai-compatible baseUrl override
      // is needed to redirect the endpoint. Auth flows in via env vars derived
      // from the route — no auth.json needed.
      const route = resolveRoute(config.model)
      // For openai-compatible routes (DeepSeek, vLLM, any OpenAI proxy), the
      // baseUrl-only override is NOT enough: pi's `openai` provider defaults
      // custom models to `openai-responses` (POST {baseUrl}/responses), which
      // non-OpenAI backends don't implement -> 404. Register the model
      // explicitly with `api: openai-completions` so pi uses /chat/completions.
      // Matches the headless library driver's behavior (see pi-runtime.ts).
      const modelId = resolveBackendModel(config.model)
      const doc = route.kind === "openai-compatible"
        ? renderPiModelRegistration(route, modelId)
        : renderPiBaseUrlOverride(route)
      if (doc) {
        await Bun.write(path.join(root, "models.json"), doc)
        this.modelsJson = doc
      }
    }

    log.info(`pi command: ${this.cmdPrefix.join(" ")}`)
    log.info(`pi model: ${this.model} (mode=${this.mode}, PI_CODING_AGENT_DIR=${root})`)
  }

  async run(task: {
    prompt: string
    workDir: string
    skill?: SkillBundle
    taskId?: string
    convLog?: import("../core/conversation-logger.ts").ConversationLog
    timeoutMs?: number
    /** Terminal-Bench image — when set (and SKVM_PI_HOST_MODE is not), pi
     * runs inside skvm-pi-runtime with workDir bind-mounted at /app so
     * model-generated shell commands (find /, grep -r, etc.) execute in a
     * clean Ubuntu root rather than the Windows Git-Bash host. */
    tbDockerImage?: string
  }): Promise<RunResult> {
    if (task.tbDockerImage && !process.env.SKVM_PI_HOST_MODE) {
      return this.runInContainer(task)
    }
    return this.runOnHost(task)
  }

  private async runOnHost(task: {
    prompt: string
    workDir: string
    skill?: SkillBundle
    taskId?: string
    convLog?: import("../core/conversation-logger.ts").ConversationLog
    timeoutMs?: number
  }): Promise<RunResult> {
    let skillLoaded: boolean | undefined
    let skillPath: string | undefined

    if (task.skill) {
      if (task.skill.mode === "inject") {
        // Pi auto-loads AGENTS.md from CWD into the system prompt.
        await Bun.write(path.join(task.workDir, "AGENTS.md"), task.skill.content)
        skillLoaded = false
      } else {
        const skillName = task.skill.meta.name
        const skillDir = path.join(task.workDir, ".pi-skills", skillName)
        await mkdir(skillDir, { recursive: true })
        await Bun.write(path.join(skillDir, "SKILL.md"), task.skill.content)
        skillPath = skillDir
        skillLoaded = false
      }
    }

    const startMs = performance.now()

    const prompt = `IMPORTANT: Do not ask clarifying questions. Proceed directly with implementation. Execute all steps immediately without waiting for user input.\n\n${task.prompt}`

    const cmd = [
      ...this.cmdPrefix,
      "-p", prompt,
      "--mode", "json",
      "--no-session",
      "--model", this.model,
      "--tools", "read,bash,edit,write",
      "--no-extensions",
    ]

    if (task.skill) {
      if (task.skill.mode === "discover" && skillPath) {
        cmd.push("--skill", skillPath, "--no-skills", "--no-context-files")
      }
    } else {
      cmd.push("--no-context-files", "--no-skills")
    }

    cmd.push(...this.extraCliArgs)

    const envOverlay: Record<string, string> = { ...this.routeEnv }
    if (this.piAgentDir) envOverlay.PI_CODING_AGENT_DIR = this.piAgentDir

    // Stream pi's NDJSON stdout straight to the convLog file instead of
    // buffering it (agentic transcripts reach 0.3–1.7 GB → OOM). When a
    // convLog path exists, streaming IS the convLog write; the file parser
    // then reads it back. No convLog → fall back to the string path.
    const convLogPath = task.convLog?.filePath
    const { stdout, stderr, exitCode, timedOut } = await runSubprocess(cmd, {
      cwd: task.workDir,
      timeoutMs: task.timeoutMs ?? this.timeoutMs,
      env: envOverlay,
      stdoutSink: convLogPath,
    })

    const durationMs = performance.now() - startMs

    if (exitCode !== 0 && stderr) {
      log.warn(`pi exited with code ${exitCode}: ${stderr.slice(0, 200)}`)
    }

    const builder = convLogPath
      ? await piBuildRunRecordFromFile(convLogPath)
      : piBuildRunRecordFromNDJSON(stdout)

    if (task.skill && skillLoaded === false) {
      const skillSnippet = task.skill.content.replace(/^#.*\n/m, "").trim().slice(0, 60)
      if (task.skill.mode === "inject" && builder.stepCount > 0) {
        skillLoaded = true
      }
      if (!skillLoaded && skillSnippet.length > 20) {
        for (const step of builder.stepsSoFar) {
          if (step.role === "assistant" && step.text?.includes(skillSnippet)) {
            skillLoaded = true
            break
          }
        }
      }
    }

    const verdict = await subprocessVerdict({
      label: "pi",
      timedOut,
      exitCode,
      timeoutMs: task.timeoutMs ?? this.timeoutMs,
      stderr,
    })

    return builder.finish({ workDir: task.workDir, durationMs, skillLoaded, ...verdict })
  }

  /**
   * Container-mode pi: launch skvm-pi-runtime with workDir bind-mounted at
   * /app, then `docker exec pi …` there. Solves the "find /" host-traversal
   * timeout by giving pi a real Linux root to walk.
   *
   * Preconditions:
   *   • Docker daemon reachable (probed at startContainer).
   *   • skvm-pi-runtime:latest built (`docker build -f docker/skvm-pi-runtime.Dockerfile`).
   *   • task.workDir already seeded with the TB image's /app contents by
   *     `seedTbAppFiles` in run-condition.ts.
   *
   * Non-goals: does NOT run inside `task.tbDockerImage` — that image is the
   * VERIFIER's runtime and typically lacks node/npm. The agent's runtime is
   * skvm-pi-runtime; the verifier still runs in tbDockerImage via tb-grade.
   */
  private async runInContainer(task: {
    prompt: string
    workDir: string
    skill?: SkillBundle
    taskId?: string
    convLog?: import("../core/conversation-logger.ts").ConversationLog
    timeoutMs?: number
    tbDockerImage?: string
  }): Promise<RunResult> {
    let skillLoaded: boolean | undefined
    let skillDirInContainer: string | undefined

    // Skill staging is the SAME as host mode — files live under workDir and
    // the container sees them at /app/AGENTS.md or /app/.pi-skills/<name>.
    if (task.skill) {
      if (task.skill.mode === "inject") {
        await Bun.write(path.join(task.workDir, "AGENTS.md"), task.skill.content)
        skillLoaded = false
      } else {
        const skillName = task.skill.meta.name
        const hostSkillDir = path.join(task.workDir, ".pi-skills", skillName)
        await mkdir(hostSkillDir, { recursive: true })
        await Bun.write(path.join(hostSkillDir, "SKILL.md"), task.skill.content)
        skillDirInContainer = `/app/.pi-skills/${skillName}`
        skillLoaded = false
      }
    }

    // PI_CODING_AGENT_DIR: pi's config sandbox. Put it inside workDir so it
    // auto-mounts with the volume; models.json for the route override goes
    // here just like host mode.
    const sandboxRel = `.pi-sandbox`
    const hostSandbox = path.join(task.workDir, sandboxRel)
    await mkdir(hostSandbox, { recursive: true })
    const containerSandbox = `/app/${sandboxRel}`

    // Managed mode: reuse the models.json emitted at setup(). Native mode
    // has no models.json (auth comes from the user's real ~/.pi/agent dir on
    // the host) and would need extra work to bind-mount that — bench always
    // uses managed mode, so leaving native container-mode for later is fine.
    if (this.mode === "managed" && this.modelsJson) {
      await Bun.write(path.join(hostSandbox, "models.json"), this.modelsJson)
    }

    const startMs = performance.now()
    const timeoutMs = task.timeoutMs ?? this.timeoutMs

    // API keys and PI_CODING_AGENT_DIR are the env the container needs.
    // Route env vars (LONGCAT_API_KEY / DEEPSEEK_API_KEY / …) came from
    // envForRoute() at setup time.
    const env: Record<string, string> = {
      ...this.routeEnv,
      PI_CODING_AGENT_DIR: containerSandbox,
    }

    const container = await startContainer({
      image: "skvm-pi-runtime:latest",
      mounts: [{ host: task.workDir, container: "/app", mode: "rw" }],
      env,
      workDir: "/app",
      // Lifetime > task timeout so cleanup can rm -f cleanly even after a kill.
      lifetimeMs: timeoutMs + 60_000,
    })

    try {
      const prompt = `IMPORTANT: Do not ask clarifying questions. Proceed directly with implementation. Execute all steps immediately without waiting for user input.\n\n${task.prompt}`

      const piCmd = [
        "pi",
        "-p", prompt,
        "--mode", "json",
        "--no-session",
        "--model", this.model,
        "--tools", "read,bash,edit,write",
        "--no-extensions",
      ]
      if (task.skill?.mode === "discover" && skillDirInContainer) {
        piCmd.push("--skill", skillDirInContainer, "--no-skills", "--no-context-files")
      } else if (!task.skill) {
        piCmd.push("--no-context-files", "--no-skills")
      }
      piCmd.push(...this.extraCliArgs)

      log.info(`pi (container): image=skvm-pi-runtime:latest container=${container.name} model=${this.model}`)

      const convLogPath = task.convLog?.filePath
      const { stdout, stderr, exitCode, timedOut } = await execInContainer({
        cmd: piCmd,
        container,
        cwd: "/app",
        timeoutMs,
        stdoutSink: convLogPath,
      })

      const durationMs = performance.now() - startMs

      if (exitCode !== 0 && stderr) {
        log.warn(`pi (container) exited with code ${exitCode}: ${stderr.slice(0, 200)}`)
      }

      const builder = convLogPath
        ? await piBuildRunRecordFromFile(convLogPath)
        : piBuildRunRecordFromNDJSON(stdout)

      if (task.skill && skillLoaded === false) {
        const skillSnippet = task.skill.content.replace(/^#.*\n/m, "").trim().slice(0, 60)
        if (task.skill.mode === "inject" && builder.stepCount > 0) {
          skillLoaded = true
        }
        if (!skillLoaded && skillSnippet.length > 20) {
          for (const step of builder.stepsSoFar) {
            if (step.role === "assistant" && step.text?.includes(skillSnippet)) {
              skillLoaded = true
              break
            }
          }
        }
      }

      const verdict = await subprocessVerdict({
        label: "pi",
        timedOut,
        exitCode,
        timeoutMs,
        stderr,
      })

      return builder.finish({ workDir: task.workDir, durationMs, skillLoaded, ...verdict })
    } finally {
      await container.cleanup()
    }
  }

  async teardown(): Promise<void> {
    this.sandbox?.teardown()
    this.sandbox = undefined
    this.piAgentDir = undefined
  }
}
