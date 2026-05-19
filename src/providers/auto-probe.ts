import type { LLMProvider, LLMResponse, CompletionParams, LLMToolResult } from "./types.ts"
import type { ProviderRoute } from "../core/types.ts"
import { isToolArgumentsParseError } from "./errors.ts"
import type { ProbeVerdictResult } from "./probe.ts"
import { createLogger } from "../core/logger.ts"

const log = createLogger("auto-probe")

/**
 * Per-process guard: each fully-prefixed modelId is probed at most once.
 * Prevents fan-out under bench/jit-optimize from amplifying probe cost.
 */
const probedThisProcess = new Set<string>()

/**
 * Result handed back from the probe orchestrator function passed to the
 * wrapper. Returning a clean `altProvider` and a `writeRoute` callback
 * means the wrapper should write the discovered route + retry the call
 * via altProvider.
 */
export interface ProbeOrchestratorResult {
  verdict: ProbeVerdictResult
  altProvider: LLMProvider | null
  writeRoute: (() => Promise<{ written: boolean }>) | null
}

export type ProbeOrchestrator = (modelId: string, route: ProviderRoute) => Promise<ProbeOrchestratorResult>

/**
 * Wraps an LLMProvider with lazy-reactive auto-probe semantics: on
 * ToolArgumentsParseError, run the probe orchestrator. If a clean
 * Anthropic-shaped alternative is found, write a literal route and
 * retry the original call via the alt provider; otherwise rethrow the
 * original error so structured.ts Layer 2 fallback can run.
 *
 * The orchestrator is injected to keep this wrapper testable without a
 * real network or config file. `createProviderForModel` wires it to the
 * concrete `runProbe` + `appendDiscoveredRoute` implementation.
 *
 * Spec: docs/skvm/2026-05-19-provider-auto-probe.md
 */
export class AutoProbeProvider implements LLMProvider {
  readonly name: string
  constructor(
    private readonly delegate: LLMProvider,
    private readonly modelId: string,
    private readonly route: ProviderRoute,
    private readonly orchestrator: ProbeOrchestrator,
  ) {
    this.name = `auto-probe(${delegate.name})`
  }

  async complete(params: CompletionParams): Promise<LLMResponse> {
    try {
      return await this.delegate.complete(params)
    } catch (err) {
      if (!isToolArgumentsParseError(err)) throw err
      // Per-modelId guard: only probe once per process.
      if (probedThisProcess.has(this.modelId)) throw err
      probedThisProcess.add(this.modelId)

      log.info(`auto-probe triggered for ${this.modelId} on parse failure`)
      const probed = await this.orchestrator(this.modelId, this.route)
      log.info(`auto-probe verdict: primary=${probed.verdict.primary} alt=${probed.verdict.alt ?? "-"}`)

      if (probed.altProvider && probed.writeRoute) {
        const writeResult = await probed.writeRoute()
        log.info(`auto-probe route ${writeResult.written ? "written" : "already present"} for ${this.modelId}`)
        return probed.altProvider.complete(params)
      }
      // No clean alternative; let the original error propagate.
      throw err
    }
  }

  async completeWithToolResults(
    params: CompletionParams,
    toolResults: LLMToolResult[],
    previousResponse: LLMResponse,
  ): Promise<LLMResponse> {
    return this.delegate.completeWithToolResults(params, toolResults, previousResponse)
  }
}

/** Test-only: clear the per-process probe guard between cases. */
export function __resetProbeGuardForTest(): void {
  probedThisProcess.clear()
}
