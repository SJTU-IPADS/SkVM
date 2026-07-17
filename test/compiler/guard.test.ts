import { test, expect, describe } from "bun:test"
import { validateGuard } from "../../src/compiler/guard.ts"

// The guard's job is to catch BROKEN artifacts (runaway expansion, lost
// identity, degenerate output, dangling references) — NOT to enforce
// structural identity with the original. Aggressive compression and full
// restructuring are the compiler's core value, so removing code blocks,
// headings, and prose must all pass.

describe("validateGuard", () => {
  test("passes when compiled is identical to original", () => {
    const skill = "# My Skill\n\nDo things.\n"
    const result = validateGuard(skill, skill)
    expect(result.passed).toBe(true)
    expect(result.violations).toHaveLength(0)
  })

  // --- Compression is the point: restructuring must pass -------------------

  test("passes when code blocks are removed (distillation)", () => {
    const original = "# Skill\n\n```python\nprint('hello world')\nresult = compute()\n```\n\nMore text.\nStep A.\nStep B.\nStep C.\n"
    const compiled = "# Skill\n\nRun `compute()` and print the result.\nStep A.\nStep B.\nStep C.\n"
    const result = validateGuard(original, compiled)
    expect(result.passed).toBe(true)
  })

  test("passes when headings are removed, renamed, or added", () => {
    const original = "# Title\n\n## Background\n\nLots of prose.\n\n## Section B\n\nMore.\nEven more.\n"
    const compiled = "# Title — Execution Card\n\n## Commands\n\nDo X.\nDo Y.\nDo Z.\n"
    const result = validateGuard(original, compiled)
    expect(result.passed).toBe(true)
  })

  test("passes on heavy compression (90% shrink of a long skill)", () => {
    const original = Array.from({ length: 400 }, (_, i) => `Line ${i}`).join("\n")
    const compiled = ["# Card", ...Array.from({ length: 39 }, (_, i) => `Cmd ${i}`)].join("\n")
    const result = validateGuard(original, compiled)
    expect(result.passed).toBe(true)
  })

  // --- Expansion ceiling (tiered, unchanged semantics) ---------------------

  test("fails when compiled exceeds tiered length limit", () => {
    // Short document (<100 lines) gets 2x expansion budget
    const original = "# Skill\n\nLine 1\nLine 2\n"
    const compiled = original + "\n".repeat(5) + "A\n".repeat(10)
    const result = validateGuard(original, compiled)
    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.includes("Length"))).toBe(true)
  })

  test("uses generous 2x limit for short skills (<100 lines)", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Line ${i}`).join("\n")
    const added = Array.from({ length: 19 }, (_, i) => `Added ${i}`).join("\n")
    const result = validateGuard(lines, lines + "\n" + added)
    expect(result.passed).toBe(true)
  })

  test("uses 1x limit for medium skills (100-200 lines)", () => {
    const lines = Array.from({ length: 150 }, (_, i) => `Line ${i}`).join("\n")
    const tooMuch = Array.from({ length: 160 }, (_, i) => `Added ${i}`).join("\n")
    const result = validateGuard(lines, lines + "\n" + tooMuch)
    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.includes("Length"))).toBe(true)
  })

  test("uses strict 0.5x limit for long skills (>200 lines)", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `Line ${i}`).join("\n")
    const tooMuch = Array.from({ length: 160 }, (_, i) => `Added ${i}`).join("\n")
    const result = validateGuard(lines, lines + "\n" + tooMuch)
    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.includes("Length"))).toBe(true)
  })

  // --- Degenerate output ----------------------------------------------------

  test("fails on empty compiled output", () => {
    const original = Array.from({ length: 100 }, (_, i) => `Line ${i}`).join("\n")
    const result = validateGuard(original, "   \n\n  ")
    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.includes("Degenerate"))).toBe(true)
  })

  test("fails when a long skill collapses below the content floor", () => {
    const original = Array.from({ length: 200 }, (_, i) => `Line ${i}`).join("\n")
    const compiled = "# Title\n\nok\n"
    const result = validateGuard(original, compiled)
    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.includes("Degenerate"))).toBe(true)
  })

  test("identity on a tiny original stays valid (floor is relative)", () => {
    const skill = "# T\n\nDo it.\n"
    const result = validateGuard(skill, skill)
    expect(result.passed).toBe(true)
  })

  // --- Frontmatter: identity kept, wording free -----------------------------

  test("passes when frontmatter description is reworded", () => {
    const original = "---\nname: my-skill\ndescription: Original wording.\n---\n\n# Skill\n\nStep 1.\nStep 2.\nStep 3.\nStep 4.\n"
    const compiled = "---\nname: my-skill\ndescription: Tightened trigger wording.\n---\n\n# Skill\n\nStep 1.\nStep 2.\nStep 3.\nStep 4.\n"
    const result = validateGuard(original, compiled)
    expect(result.passed).toBe(true)
  })

  test("fails when frontmatter is dropped entirely", () => {
    const original = "---\nname: my-skill\ndescription: D.\n---\n\n# Skill\n\nStep 1.\nStep 2.\nStep 3.\nStep 4.\n"
    const compiled = "# Skill\n\nStep 1.\nStep 2.\nStep 3.\nStep 4.\n"
    const result = validateGuard(original, compiled)
    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.includes("Frontmatter"))).toBe(true)
  })

  test("fails when frontmatter loses its name key", () => {
    const original = "---\nname: my-skill\n---\n\n# Skill\n\nStep 1.\nStep 2.\nStep 3.\nStep 4.\n"
    const compiled = "---\ndescription: no name anymore\n---\n\n# Skill\n\nStep 1.\nStep 2.\nStep 3.\nStep 4.\n"
    const result = validateGuard(original, compiled)
    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.includes("Frontmatter"))).toBe(true)
  })

  test("fails when the frontmatter name value changes", () => {
    const original = "---\nname: my-skill\n---\n\n# Skill\n\nStep 1.\nStep 2.\nStep 3.\nStep 4.\n"
    const compiled = "---\nname: my-skill-compiled\n---\n\n# Skill\n\nStep 1.\nStep 2.\nStep 3.\nStep 4.\n"
    const result = validateGuard(original, compiled)
    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.includes("name changed"))).toBe(true)
  })

  test("quoting differences around the name value are not identity changes", () => {
    const original = "---\nname: my-skill\n---\n\n# Skill\n\nStep 1.\nStep 2.\nStep 3.\nStep 4.\n"
    const compiled = "---\nname: \"my-skill\"\n---\n\n# Skill\n\nStep 1.\nStep 2.\nStep 3.\nStep 4.\n"
    expect(validateGuard(original, compiled).passed).toBe(true)
  })

  test("no frontmatter requirement when original has none", () => {
    const original = "# Skill\n\nContent.\nMore.\nMore.\nMore.\n"
    const compiled = "# Skill\n\nDistilled.\nA.\nB.\nC.\n"
    const result = validateGuard(original, compiled)
    expect(result.passed).toBe(true)
  })

  // --- Reference integrity ---------------------------------------------------

  test("passes when referenced bundle files exist", () => {
    const original = "# Skill\n\nUse scripts/helper.py to parse.\nStep.\nStep.\nStep.\n"
    const compiled = "# Skill\n\nRun `python3 scripts/helper.py input.txt`.\nStep.\nStep.\nStep.\n"
    const result = validateGuard(original, compiled, { bundlePaths: ["scripts/helper.py"] })
    expect(result.passed).toBe(true)
  })

  test("fails on dangling bundle reference in compiled output", () => {
    const original = "# Skill\n\nStep.\nStep.\nStep.\nStep.\n"
    const compiled = "# Skill\n\nRun `python3 scripts/does-not-exist.py`.\nStep.\nStep.\nStep.\n"
    const result = validateGuard(original, compiled, { bundlePaths: ["scripts/helper.py"] })
    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.includes("Dangling reference"))).toBe(true)
  })

  test("skips reference check when bundlePaths not provided", () => {
    const original = "# Skill\n\nStep.\nStep.\nStep.\nStep.\n"
    const compiled = "# Skill\n\nRun `python3 scripts/unknown.py`.\nStep.\nStep.\nStep.\n"
    const result = validateGuard(original, compiled)
    expect(result.passed).toBe(true)
  })

  test("checks references under any directory the bundle ships, not just conventional names", () => {
    const original = "# Skill\n\nStep.\nStep.\nStep.\nStep.\n"
    const compiled = "# Skill\n\nSee references/guide.md and references/missing.md.\nStep.\nStep.\nStep.\n"
    const result = validateGuard(original, compiled, { bundlePaths: ["references/guide.md"] })
    expect(result.passed).toBe(false)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toContain("references/missing.md")
  })

  test("ignores references inside the original that the compiled dropped", () => {
    const original = "# Skill\n\nUse scripts/old.py.\nStep.\nStep.\nStep.\n"
    const compiled = "# Skill\n\nInline the logic instead.\nStep.\nStep.\nStep.\n"
    const result = validateGuard(original, compiled, { bundlePaths: [] })
    expect(result.passed).toBe(true)
  })
})

describe("guard — identity and reference regressions", () => {
  const original = [
    "---",
    "name: pdf-forms",
    "description: Fill PDF AcroForm documents from a CSV. Use when the user has fillable PDFs.",
    "allowed-tools: read_file, write_file",
    "---",
    "# PDF forms",
    ...Array.from({ length: 40 }, (_, i) => `Step ${i + 1}: do the thing.`),
  ].join("\n")

  test("a gutted description is a violation, a reworded one is not", () => {
    // skill-loader substitutes a generic placeholder for a missing description, and that
    // placeholder is what the harness routes on — a skill nobody selects is not a compiled skill.
    const gutted = original.replace(
      "description: Fill PDF AcroForm documents from a CSV. Use when the user has fillable PDFs.",
      "description: forms",
    )
    expect(validateGuard(original, gutted).passed).toBe(false)
    expect(validateGuard(original, gutted).violations.join(" ")).toContain("description")

    const dropped = original.replace(
      "description: Fill PDF AcroForm documents from a CSV. Use when the user has fillable PDFs.\n",
      "",
    )
    expect(validateGuard(original, dropped).passed).toBe(false)

    const reworded = original.replace(
      "description: Fill PDF AcroForm documents from a CSV. Use when the user has fillable PDFs.",
      "description: Populates fillable PDF forms from tabular input; use for AcroForm PDFs.",
    )
    expect(validateGuard(original, reworded).passed).toBe(true)
  })

  test("a stub does not clear the degenerate floor on frontmatter alone", () => {
    // Four frontmatter lines used to satisfy a 5%-of-non-empty floor for any original under
    // ~80 lines, so `---\nname: x\n---\nTBD` passed as a compiled skill.
    const stub = ["---", "name: pdf-forms", "description: Fill PDF AcroForm documents from a CSV.", "---", "TBD"].join("\n")
    expect(validateGuard(original, stub).passed).toBe(false)
    expect(validateGuard(original, stub).violations.join(" ")).toContain("Degenerate")
  })

  test("a pre-existing dangling reference is not the compiler's breakage", () => {
    // validateGuard(x, x) must never fail: a skill that already mentioned a missing file is
    // broken upstream of this pass, and flagging it inflated the guard-failure count.
    const withRef = original + "\nRun scripts/setup.sh before starting.\n"
    expect(validateGuard(withRef, withRef, { bundlePaths: [] }).passed).toBe(true)

    // A reference the compilation INVENTED is still caught.
    const invented = original + "\nRun scripts/hallucinated.sh before starting.\n"
    const result = validateGuard(original, invented, { bundlePaths: [] })
    expect(result.passed).toBe(false)
    expect(result.violations.join(" ")).toContain("hallucinated.sh")
  })

  test("CRLF frontmatter is still checked", () => {
    // `/^---\n/` never matched a Windows-authored skill, so check 3 was silently skipped and the
    // frontmatter could be dropped entirely.
    const crlf = original.replace(/\n/g, "\r\n")
    const noFrontmatter = "# PDF forms\r\n" + Array.from({ length: 40 }, (_, i) => `Step ${i + 1}.`).join("\r\n")
    expect(validateGuard(crlf, noFrontmatter).passed).toBe(false)
    expect(validateGuard(crlf, noFrontmatter).violations.join(" ")).toContain("Frontmatter")
  })
})
