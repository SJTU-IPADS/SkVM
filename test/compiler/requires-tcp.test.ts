import { describe, expect, test } from "bun:test"
import { compileSkill } from "../../src/compiler/index.ts"
import type { LLMProvider } from "../../src/providers/types.ts"

// The orchestrator must reject a requiresTcp pass without a TCP *before* any
// side effect (no workDir, no pass runs) — and, symmetrically, a compile of
// only non-TCP passes must not demand one. The CLI-level counterpart (profile
// loading skipped for `--pass=bind-env`) lives in test/cli/aot-compile.test.ts.

// Never reached: compileSkill throws before any pass (and thus the provider)
// is exercised.
const unusedProvider = {} as LLMProvider

describe("compileSkill TCP requirement", () => {
  test("rejects a requiresTcp pass (rewrite-skill) without a TCP, before side effects", async () => {
    await expect(compileSkill({
      skillPath: "/nonexistent/SKILL.md",
      skillContent: "# skill\n",
      model: "x/y",
      harness: "bare-agent",
      passes: ["rewrite-skill"],
    }, unusedProvider)).rejects.toThrow(/pass\(es\) "rewrite-skill" require a TCP profile/)
  })

  test("numeric token resolves the same requirement", async () => {
    await expect(compileSkill({
      skillPath: "/nonexistent/SKILL.md",
      skillContent: "# skill\n",
      model: "x/y",
      harness: "bare-agent",
      passes: ["1", "2"],
    }, unusedProvider)).rejects.toThrow(/require a TCP profile/)
  })
})
