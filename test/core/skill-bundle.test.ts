import { describe, expect, test } from "bun:test"
import { buildSkillBundle } from "../../src/core/skill-loader.ts"
import { CLI_DEFAULTS } from "../../src/core/ui-defaults.ts"
import type { ResolvedSkill } from "../../src/core/skill-loader.ts"

function fakeSkill(): ResolvedSkill {
  return {
    skillId: "fake",
    skillDir: "/tmp/fake",
    skillPath: "/tmp/fake/SKILL.md",
    skillContent: "# Fake skill body",
    skillMeta: { name: "fake", description: "fake skill" },
    bundleFiles: [],
  }
}

describe("buildSkillBundle", () => {
  test("returns undefined when skill is absent", () => {
    expect(buildSkillBundle(undefined, "inject")).toBeUndefined()
    expect(buildSkillBundle(undefined, undefined)).toBeUndefined()
  })

  test("applies CLI_DEFAULTS.skillMode when mode is omitted", () => {
    const bundle = buildSkillBundle(fakeSkill(), undefined)
    expect(bundle).toBeDefined()
    expect(bundle!.mode).toBe(CLI_DEFAULTS.skillMode)
    expect(bundle!.content).toBe("# Fake skill body")
    expect(bundle!.meta).toEqual({ name: "fake", description: "fake skill" })
  })

  test("preserves an explicit mode", () => {
    const inject = buildSkillBundle(fakeSkill(), "inject")
    const discover = buildSkillBundle(fakeSkill(), "discover")
    expect(inject!.mode).toBe("inject")
    expect(discover!.mode).toBe("discover")
  })
})
