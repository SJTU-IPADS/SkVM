import { describe, test, expect } from "bun:test"
import { ProposalMetaSchema } from "../../src/proposals/storage.ts"

describe("ProposalMetaSchema with optimizerDriver", () => {
  const base = {
    skillName: "s", skillDir: "/tmp/s",
    harness: "opencode" as const,
    optimizerModel: "anthropic/claude-sonnet-4.6",
    targetModel: "anthropic/claude-sonnet-4.6",
    source: "synthetic",
    timestamp: "t",
    status: "pending" as const,
    acceptedRound: null,
    bestRound: 0,
    bestRoundReason: "",
    roundCount: 0,
  }

  test("accepts optimizerDriver = pi", () => {
    const meta = ProposalMetaSchema.parse({ ...base, optimizerDriver: "pi" })
    expect(meta.optimizerDriver).toBe("pi")
  })

  test("accepts optimizerDriver = opencode", () => {
    const meta = ProposalMetaSchema.parse({ ...base, optimizerDriver: "opencode" })
    expect(meta.optimizerDriver).toBe("opencode")
  })

  test("tolerates missing optimizerDriver (legacy)", () => {
    const meta = ProposalMetaSchema.parse(base)
    expect(meta.optimizerDriver).toBeUndefined()
  })
})
