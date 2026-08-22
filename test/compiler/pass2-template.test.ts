import { describe, test, expect } from "bun:test"
// Same import mode as generate-script.ts — the template ships inside the
// binary as text, so the test sees exactly what the LLM prompt embeds.
import TEMPLATE from "../../src/compiler/passes/bind-env/env-binding-template.sh" with { type: "text" }

// The env-binding script must work on hosts with NO usable pip (locked-down
// images, PEP 668 systems): the template carries the python
// bootstrap helpers, and the install policy routes pip deps through them.
describe("pass2 env-binding template", () => {
  test("carries the python bootstrap helpers", () => {
    for (const helper of ["bootstrap_venv()", "ensure_python()", "pip_check()", "pip_install()"]) {
      expect(TEMPLATE).toContain(helper)
    }
    expect(TEMPLATE).toContain("SKVM_ENV_DIR")
  })

  test("bootstraps the venv onto PATH so later processes inherit it", () => {
    expect(TEMPLATE).toContain('PATH="$ENV_DIR/bin:$PATH"')
    expect(TEMPLATE).toContain("export PATH")
  })

  test("never refreshes package repositories (policy also enforced at simulate time)", () => {
    expect(TEMPLATE).not.toMatch(/\b(?:apt-get|apt|yum|dnf|brew)\s+(?:update|upgrade)\b/)
  })

  test("is valid bash syntax", async () => {
    const proc = Bun.spawn(["bash", "-n", "/dev/stdin"], { stdin: new TextEncoder().encode(
      // the placeholder blocks are not valid bash — strip them, keep the helpers
      TEMPLATE.split("FAIL=0")[0]!,
    ) })
    expect(await proc.exited).toBe(0)
  })
})
