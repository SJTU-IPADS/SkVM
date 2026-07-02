import { describe, test, expect } from "bun:test"
import { suggestFlag, formatUnknownFlagErrors, GLOBAL_FLAGS } from "../../src/core/cli-flags.ts"

describe("suggestFlag", () => {
  test("suggests the nearest within Levenshtein distance 2", () => {
    expect(suggestFlag("adpter", ["adapter", "model", "task"])).toBe("adapter")
    expect(suggestFlag("modle", ["adapter", "model", "task"])).toBe("model")
  })

  test("returns null when nothing is within distance 2", () => {
    expect(suggestFlag("zzz", ["adapter", "model", "task"])).toBeNull()
  })

  test("prefers exact-distance ties by lexical order (stable)", () => {
    // 'aabb' is distance 2 from both 'aaaa' and 'bbbb'; lexical order wins.
    expect(suggestFlag("aabb", ["aaaa", "bbbb"])).toBe("aaaa")
  })
})

describe("formatUnknownFlagErrors", () => {
  test("returns no lines when every flag is known", () => {
    expect(formatUnknownFlagErrors("profile", ["adapter", "model"], new Set(["adapter", "model"]))).toEqual([])
  })

  test("accepts global flags without per-command declaration", () => {
    expect(formatUnknownFlagErrors("profile", [...GLOBAL_FLAGS], new Set())).toEqual([])
  })

  test("rejects an unknown flag with a 'did you mean' hint", () => {
    const lines = formatUnknownFlagErrors("profile", ["adpter", "model"], new Set(["adapter", "model"]))
    expect(lines.join("\n")).toContain("Unknown flag --adpter")
    expect(lines.join("\n")).toContain("Did you mean --adapter?")
    expect(lines.join("\n")).toContain("profile") // command label appears
  })

  test("rejects an unknown flag with no close match (no hint line)", () => {
    const lines = formatUnknownFlagErrors("profile", ["zzz"], new Set(["adapter", "model"]))
    expect(lines.join("\n")).toContain("Unknown flag --zzz")
    expect(lines.join("\n")).not.toContain("Did you mean")
  })

  test("reports all unknown flags in a single call", () => {
    const lines = formatUnknownFlagErrors("profile", ["adpter", "modle"], new Set(["adapter", "model"]))
    expect(lines.join("\n")).toContain("--adpter")
    expect(lines.join("\n")).toContain("--modle")
  })
})
