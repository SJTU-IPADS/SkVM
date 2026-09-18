import { describe, expect, test } from "bun:test"
import {
  maskCodeBlocks,
  unmaskCodeBlocks,
} from "../../src/compiler/passes/rewrite-skill/agent.ts"

describe("rewrite-skill code-block masking", () => {
  test("preserves common fence forms and line endings verbatim", () => {
    const input = [
      "# Examples\r\n",
      "```c++\r\nint main() { return 0; }\r\n```\r\n",
      "```bash-session\n$ echo hello\n```\n",
      "````tsx {highlight: [1]}\nconst marker = '```'\n````\n",
      "~~~python linenums=1\nprint('ok')\n~~~\n",
    ].join("")

    const { masked, blocks } = maskCodeBlocks(input)

    expect(blocks).toHaveLength(4)
    expect(masked).toContain("[[SKVM_CODE_BLOCK_0]]")
    expect(masked).toContain("[[SKVM_CODE_BLOCK_3]]")
    expect(masked).not.toContain("int main")
    expect(unmaskCodeBlocks(masked, blocks)).toBe(input)
  })

  test("does not treat an unmatched opening fence as a code block", () => {
    const input = "before\n```tsx {demo}\nconst x = 1\n"

    expect(maskCodeBlocks(input)).toEqual({ masked: input, blocks: [] })
  })

  test("restores a duplicated placeholder exactly once", () => {
    const block = "```js\nconsole.log('once')\n```"
    const agentOutput = [
      "before",
      "[[SKVM_CODE_BLOCK_0]]",
      "middle",
      "[[SKVM_CODE_BLOCK_0]]",
      "after",
    ].join("\n")

    const restored = unmaskCodeBlocks(agentOutput, [block])

    expect(restored.split(block)).toHaveLength(2)
    expect(restored).not.toContain("[[SKVM_CODE_BLOCK_0]]")
    expect(restored).toContain("middle")
  })

  test("reattaches a block when its placeholder was dropped", () => {
    const block = "```sh\necho safe\n```"
    const restored = unmaskCodeBlocks("# Skill\n\nEdited prose.\n", [block])

    expect(restored).toBe(`# Skill\n\nEdited prose.\n\n${block}\n`)
  })
})
