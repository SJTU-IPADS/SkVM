import { test, expect, describe } from "bun:test"
import { estimateCost, resolveMeasuredCost } from "../../src/core/cost.ts"

const TOKENS = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }
const MODEL = "anthropic/claude-opus-4.6"

describe("resolveMeasuredCost", () => {
  test("every call priced: the provider's own total wins", () => {
    expect(resolveMeasuredCost(MODEL, TOKENS, { costUsd: 0.42, pricedCostUsd: 0.42 })).toBe(0.42)
  })

  test("partial pricing reports the measured subtotal, not a table re-estimate", () => {
    // The bug this exists for: one unpriced retry cleared costUsd, and the
    // caller then re-priced the whole token count from the local table — a
    // figure orders of magnitude off, still presented as a measurement.
    const floor = resolveMeasuredCost(MODEL, TOKENS, { costUsd: undefined, pricedCostUsd: 0.002 })
    expect(floor).toBe(0.002)
    expect(floor).toBeLessThan(estimateCost(MODEL, TOKENS))
  })

  test("nothing priced: falls back to the pricing table", () => {
    const estimated = resolveMeasuredCost(MODEL, TOKENS, { costUsd: undefined, pricedCostUsd: 0 })
    expect(estimated).toBe(estimateCost(MODEL, TOKENS))
    expect(estimated).toBeGreaterThan(0)
  })

  test("an absent subtotal behaves like nothing priced", () => {
    expect(resolveMeasuredCost(MODEL, TOKENS, {})).toBe(estimateCost(MODEL, TOKENS))
  })

  test("a genuine zero from the provider is reported as zero, not re-estimated", () => {
    expect(resolveMeasuredCost(MODEL, TOKENS, { costUsd: 0, pricedCostUsd: 0 })).toBe(0)
  })
})
