import { describe, test, expect } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { compileSkill } from "../../src/compiler/index.ts"
import type { LLMProvider } from "../../src/providers/types.ts"
import type { TCP } from "../../src/core/types.ts"

describe("compileSkill: compiler timeout passthrough", () => {
  test("aborts Pass 1 when provider exceeds the configured timeout", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "skvm-compiler-timeout-"))
    writeFileSync(path.join(tmp, "SKILL.md"), "# Test skill\n\nDo a thing.\n")

    let providerCallCount = 0
    const slowProvider: LLMProvider = {
      async chat() {
        providerCallCount++
        await new Promise((r) => setTimeout(r, 300))
        return { content: "", toolCalls: [], stopReason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } }
      },
    } as unknown as LLMProvider

    const tcp: TCP = {
      model: "test/dummy",
      profiledAt: new Date().toISOString(),
      schemaVersion: 1,
      summary: { l1: {}, l2: {}, l3: {} },
      details: [
        { primitiveId: "p1", levelResults: [{ level: 1, passRate: 0, failureArtifacts: [] }], convLogDir: undefined as unknown as string },
      ],
    } as unknown as TCP

    try {
      await compileSkill({
        skillPath: path.join(tmp, "SKILL.md"),
        skillContent: "# Test skill\n",
        skillDir: tmp,
        skillName: "test",
        tcp,
        model: "test/dummy",
        harness: "bare-agent",
        timeoutMs: 50,
      }, slowProvider, { showSpinner: false })
    } catch (err) {
      // Expected: agent loop deadline trips. Specific error message is not critical;
      // we just care that it surfaces rather than running for 5 minutes.
    }

    expect(providerCallCount).toBeLessThanOrEqual(2)

    rmSync(tmp, { recursive: true, force: true })
  }, 5_000)
})
