/**
 * Unit tests for the defineGenerator toolkit (issue #47).
 *
 * The toolkit must be strictly behavior-preserving: the default rng reads
 * unseeded Math.random at call time (so tests that pin Math.random keep
 * steering generators), and pyEval produces checkpoint scripts the framework
 * evaluator scores exactly like the hand-rolled ones.
 */
import { test, expect, describe } from "bun:test"
import {
  defineGenerator,
  mathRandomRng,
  pyEval,
  requirePyModule,
  PY_EMIT_CHECKPOINTS,
  type Rng,
} from "../../src/profiler/generator-toolkit.ts"
import type { MicrobenchmarkInstance } from "../../src/profiler/types.ts"
import { evaluate } from "../../src/framework/evaluator.ts"
import { baseResult, makeWorkDir, removeWorkDir } from "../helpers/eval-ground-truth.ts"

/** Run `fn` with Math.random pinned to `value`, then restore it. */
function withPinnedRandom<T>(value: number, fn: () => T): T {
  const orig = Math.random
  Math.random = () => value
  try {
    return fn()
  } finally {
    Math.random = orig
  }
}

function dummyInstance(tag: string): MicrobenchmarkInstance {
  return {
    prompt: `prompt-${tag}`,
    eval: { method: "script", command: `echo ${tag}`, expectedExitCode: 0 },
  }
}

describe("mathRandomRng", () => {
  test("randInt covers [min, max] inclusive", () => {
    const seen = new Set<number>()
    for (let i = 0; i < 500; i++) seen.add(mathRandomRng.randInt(1, 4))
    expect([...seen].sort()).toEqual([1, 2, 3, 4])
  })

  test("randChoice returns a member of the array", () => {
    const arr = ["a", "b", "c"] as const
    for (let i = 0; i < 100; i++) {
      expect(arr).toContain(mathRandomRng.randChoice(arr))
    }
  })

  test("reads Math.random at call time (pinnable, like the legacy helpers)", () => {
    withPinnedRandom(0, () => {
      expect(mathRandomRng.randInt(5, 9)).toBe(5)
      expect(mathRandomRng.randChoice(["x", "y", "z"])).toBe("x")
    })
    withPinnedRandom(0.9999999, () => {
      expect(mathRandomRng.randInt(5, 9)).toBe(9)
      expect(mathRandomRng.randChoice(["x", "y", "z"])).toBe("z")
    })
  })

  test("shuffle returns a permutation without mutating the input", () => {
    const arr = [1, 2, 3, 4, 5]
    const copy = [...arr]
    const shuffled = mathRandomRng.shuffle(arr)
    expect(arr).toEqual(copy)
    expect([...shuffled].sort()).toEqual(copy)
  })

  test("sample returns n distinct members", () => {
    const arr = ["a", "b", "c", "d", "e"]
    const picked = mathRandomRng.sample(arr, 3)
    expect(picked).toHaveLength(3)
    expect(new Set(picked).size).toBe(3)
    for (const p of picked) expect(arr).toContain(p)
  })
})

describe("defineGenerator", () => {
  const gen = defineGenerator({
    primitiveId: "test.primitive",
    descriptions: { L1: "one", L2: "two", L3: "three" },
    levels: {
      L1: () => dummyInstance("L1"),
      L2: () => dummyInstance("L2"),
      L3: () => dummyInstance("L3"),
    },
  })

  test("satisfies the MicrobenchmarkGenerator interface", () => {
    expect(gen.primitiveId).toBe("test.primitive")
    expect(gen.descriptions).toEqual({ L1: "one", L2: "two", L3: "three" })
  })

  test("dispatches L1/L2/L3 to the matching builder", () => {
    expect(gen.generate("L1").prompt).toBe("prompt-L1")
    expect(gen.generate("L2").prompt).toBe("prompt-L2")
    expect(gen.generate("L3").prompt).toBe("prompt-L3")
  })

  test("passes the default Math.random rng to builders", () => {
    let received: Rng | undefined
    const probe = defineGenerator({
      primitiveId: "test.rng",
      descriptions: { L1: "", L2: "", L3: "" },
      levels: {
        L1: (rng) => {
          received = rng
          return dummyInstance("rng")
        },
        L2: () => dummyInstance("2"),
        L3: () => dummyInstance("3"),
      },
    })
    withPinnedRandom(0, () => {
      probe.generate("L1")
      expect(received!.randInt(3, 8)).toBe(3)
    })
  })
})

describe("pyEval", () => {
  test("wraps the body in the python3 heredoc checkpoint scaffold", () => {
    const criterion = pyEval({
      imports: ["re", "os"],
      body: `cp.append({"name": "x", "score": 1.0, "reason": None})`,
    })
    expect(criterion.method).toBe("script")
    if (criterion.method !== "script") throw new Error("unreachable")
    expect(criterion.expectedExitCode).toBe(0)
    expect(criterion.command).toBe(`python3 << 'PYEOF'
import json, re, os
cp = []
cp.append({"name": "x", "score": 1.0, "reason": None})
${PY_EMIT_CHECKPOINTS}
PYEOF`)
  })

  test("places the preamble before the import scaffold", () => {
    const criterion = pyEval({
      preamble: requirePyModule("pandas", "test L3"),
      body: "pass",
    })
    if (criterion.method !== "script") throw new Error("expected script")
    const guardIdx = criterion.command.indexOf("importlib.util")
    const importIdx = criterion.command.indexOf("import json\ncp = []")
    expect(guardIdx).toBeGreaterThan(-1)
    expect(importIdx).toBeGreaterThan(guardIdx)
  })

  test("a passing body scores pass with checkpoints", async () => {
    const wd = await makeWorkDir("toolkit")
    try {
      const criterion = pyEval({
        body: `cp.append({"name": "ok", "score": 1.0, "reason": None})`,
      })
      const result = await evaluate(criterion, baseResult(wd))
      expect(result.pass).toBe(true)
      expect(result.checkpoints).toHaveLength(1)
      expect(result.checkpoints![0]!.name).toBe("ok")
    } finally {
      await removeWorkDir(wd)
    }
  })

  test("a failing checkpoint scores fail", async () => {
    const wd = await makeWorkDir("toolkit")
    try {
      const criterion = pyEval({
        body: `cp.append({"name": "bad", "score": 0.0, "reason": "nope"})`,
      })
      const result = await evaluate(criterion, baseResult(wd))
      expect(result.pass).toBe(false)
    } finally {
      await removeWorkDir(wd)
    }
  })

  test("early exit via PY_EMIT_CHECKPOINTS works inside the body", async () => {
    const wd = await makeWorkDir("toolkit")
    try {
      const criterion = pyEval({
        body: `cp.append({"name": "first", "score": 1.0, "reason": None})
${PY_EMIT_CHECKPOINTS}
raise SystemExit(0)
cp.append({"name": "unreachable", "score": 0.0, "reason": "should not run"})`,
      })
      const result = await evaluate(criterion, baseResult(wd))
      expect(result.pass).toBe(true)
      expect(result.checkpoints).toHaveLength(1)
    } finally {
      await removeWorkDir(wd)
    }
  })
})

describe("requirePyModule", () => {
  test("missing module yields infraError, not a score-0 failure", async () => {
    const wd = await makeWorkDir("toolkit")
    try {
      const criterion = pyEval({
        preamble: requirePyModule("nonexistent_pkg_xyz", "test.primitive L3"),
        body: `cp.append({"name": "ok", "score": 1.0, "reason": None})`,
      })
      const result = await evaluate(criterion, baseResult(wd))
      expect(result.infraError).toBeDefined()
      expect(result.infraError).toContain("nonexistent_pkg_xyz")
      expect(result.infraError).toContain("test.primitive L3")
    } finally {
      await removeWorkDir(wd)
    }
  })

  test("installed module falls through to the body", async () => {
    const wd = await makeWorkDir("toolkit")
    try {
      const criterion = pyEval({
        preamble: requirePyModule("json", "test.primitive L3"),
        body: `cp.append({"name": "ok", "score": 1.0, "reason": None})`,
      })
      const result = await evaluate(criterion, baseResult(wd))
      expect(result.infraError).toBeUndefined()
      expect(result.pass).toBe(true)
    } finally {
      await removeWorkDir(wd)
    }
  })
})
