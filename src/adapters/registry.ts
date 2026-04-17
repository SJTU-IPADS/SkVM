/**
 * Canonical registry of agent adapters.
 *
 * Single source of truth for: valid adapter names, the `AdapterName` type,
 * the `isAdapterName` guard, and the `createAdapter` factory. All CLI flag
 * parsing, bench orchestrator, jit-optimize loop, and profile entry points
 * route through here so that adding or renaming an adapter is a single edit.
 */

import type { AgentAdapter, AdapterConfig } from "../core/types.ts"
import type { LLMProvider } from "../providers/types.ts"
import { BareAgentAdapter } from "./bare-agent.ts"
import { OpenClawAdapter } from "./openclaw.ts"
import { OpenCodeAdapter } from "./opencode.ts"
import { HermesAdapter } from "./hermes.ts"
import { JiuwenClawAdapter } from "./jiuwenclaw.ts"
import { PiAdapter } from "./pi.ts"
import { createProviderForModel } from "../providers/registry.ts"

export const ALL_ADAPTERS = ["bare-agent", "openclaw", "opencode", "hermes", "jiuwenclaw", "pi"] as const

export type AdapterName = typeof ALL_ADAPTERS[number]

export function isAdapterName(s: string): s is AdapterName {
  return (ALL_ADAPTERS as readonly string[]).includes(s)
}

/**
 * Construct an adapter instance by name.
 *
 * `providerFactory` is consulted only for `bare-agent`; CLI-wrapping adapters
 * own their own LLM plumbing. If omitted for bare-agent, defaults to the
 * provider registry, which routes the `cfg.model` id to the correct backend
 * via `skvm.config.json` `providers.routes`.
 */
export function createAdapter(
  name: AdapterName,
  providerFactory?: (cfg: AdapterConfig) => LLMProvider,
): AgentAdapter {
  switch (name) {
    case "openclaw": return new OpenClawAdapter()
    case "opencode": return new OpenCodeAdapter()
    case "hermes": return new HermesAdapter()
    case "jiuwenclaw": return new JiuwenClawAdapter()
    case "pi": return new PiAdapter()
    case "bare-agent": {
      const factory = providerFactory ?? ((cfg: AdapterConfig) =>
        createProviderForModel(cfg.model, cfg.apiKey ? { apiKey: cfg.apiKey } : undefined))
      return new BareAgentAdapter(factory)
    }
  }
}
