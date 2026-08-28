import { test, expect, describe } from "bun:test"
import { parseSkillMeta } from "../../src/core/skill-loader.ts"

const FRONTMATTER = [
  "---",
  "name: pdf-forms",
  "description: Fill PDF AcroForm documents from a CSV.",
  "---",
  "",
  "# PDF forms",
  "Step 1: do the thing.",
].join("\n")

describe("parseSkillMeta", () => {
  test("reads name and description from LF frontmatter", () => {
    expect(parseSkillMeta(FRONTMATTER, "/skills/some-dir")).toEqual({
      name: "pdf-forms",
      description: "Fill PDF AcroForm documents from a CSV.",
    })
  })

  test("reads them from CRLF frontmatter too", () => {
    // A Windows-authored skill (or a checkout with core.autocrlf=true) used to
    // miss its own frontmatter entirely and fall back to the directory name
    // plus the generic placeholder description — which is what a harness routes
    // on, so the skill was injected and then never selected.
    expect(parseSkillMeta(FRONTMATTER.replace(/\n/g, "\r\n"), "/skills/some-dir")).toEqual({
      name: "pdf-forms",
      description: "Fill PDF AcroForm documents from a CSV.",
    })
  })

  test("falls back when there is no frontmatter at all", () => {
    const meta = parseSkillMeta("# PDF forms\nno frontmatter here\n", "/skills/some-dir")
    expect(meta.name).toBe("some-dir")
    expect(meta.description).toBe("User-specified skill injected by SkVM")
  })
})
