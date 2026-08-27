import { describe, test, expect, beforeEach } from "bun:test"
import path from "node:path"
import { mkdtemp, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import type { AdapterConfig, AgentAdapter, RunResult, SkillBundle } from "../../src/core/types.ts"
import { emptyTokenUsage } from "../../src/core/types.ts"
import type { RuntimeHooks } from "../../src/runtime/types.ts"
import { saveBoostCandidates } from "../../src/jit-boost/persistence.ts"
import {
  SolidifyCasesFileSchema,
  invocationRecordsToCsv,
  runSolidifyExperiment,
  type InvocationRecord,
} from "../../src/jit-boost/experiment.ts"

/**
 * Fake adapter that mimics bare-agent's hook protocol:
 * beforeLLM first (replace → short-circuit, zero tokens); otherwise emit one
 * scripted LLM "response" through afterLLM and return an LLM-path RunResult.
 */
class FakeAdapter implements AgentAdapter {
  readonly name = "bare-agent"
  private hooks: RuntimeHooks = {}
  private invocationIndex = 0

  /** commands emitted per LLM-path invocation, in order (last entry repeats) */
  constructor(private script: string[][]) {}

  setHooks(hooks: RuntimeHooks) {
    this.hooks = hooks
  }
  async setup(_config: AdapterConfig): Promise<void> {}
  async teardown(): Promise<void> {}

  async run(task: { prompt: string; workDir: string; skill?: SkillBundle }): Promise<RunResult> {
    if (this.hooks.beforeLLM) {
      for (const hook of this.hooks.beforeLLM) {
        const result = await hook({ prompt: task.prompt, workDir: task.workDir, iteration: 0, previousToolCalls: [] })
        if (result.action === "replace") {
          return {
            text: result.text ?? "",
            steps: [],
            tokens: emptyTokenUsage(),
            cost: 0,
            durationMs: 1,
            llmDurationMs: 0,
            workDir: task.workDir,
            runStatus: "ok",
          }
        }
      }
    }
    const commands = this.script[Math.min(this.invocationIndex, this.script.length - 1)]!
    this.invocationIndex++
    if (this.hooks.afterLLM) {
      for (const hook of this.hooks.afterLLM) {
        await hook({
          response: {
            text: "done",
            toolCalls: commands.map((command, i) => ({ id: `tc-${i}`, name: "execute_command", arguments: { command } })),
            tokens: { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0 },
            durationMs: 42,
            stopReason: "end_turn",
          },
          iteration: 0,
          workDir: task.workDir,
        })
      }
    }
    return {
      text: "done",
      steps: [],
      tokens: { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      durationMs: 1234,
      llmDurationMs: 1200,
      workDir: task.workDir,
      runStatus: "ok",
    }
  }
}

async function makeSkillDir(root: string, name: string): Promise<string> {
  const dir = path.join(root, name)
  await mkdir(dir, { recursive: true })
  await Bun.write(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: test skill\n---\n# ${name}\n`)
  return dir
}

describe("runSolidifyExperiment", () => {
  let root: string
  let specPath: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "solidify-exp-"))
    await makeSkillDir(root, "weather")
    await saveBoostCandidates("weather", [{
      purposeId: "fetch-current-weather",
      keywords: ["weather"],
      codeSignature: "wttr\\.in",
      functionTemplate: 'echo "weather:${city}"',
      params: { city: { type: "string", description: "city", extractPattern: "in ([A-Za-z]+)\\??$" } },
      materializationType: "shell",
    }])
    const spec = {
      cases: [{
        id: "weather-current",
        purposeId: "fetch-current-weather",
        skill: "./weather",
        prompts: [
          "What is the current weather in London?",
          "What is the current weather in Paris?",
          "What is the current weather in Tokyo?",
          "What is the current weather in Berlin?",
          "What is the current weather in Rome?",
        ],
      }],
    }
    specPath = path.join(root, "cases.json")
    await Bun.write(specPath, JSON.stringify(spec))
  })

  test("promotes after 3 matched invocations; later invocations are JIT with zero tokens", async () => {
    const adapter = new FakeAdapter([
      ['curl -s "wttr.in/London?format=3"'],
      ['curl -s "wttr.in/Paris?format=3"'],
      ['curl -s "wttr.in/Tokyo?format=3"'],
    ])
    const { records } = await runSolidifyExperiment({
      specPath,
      model: "openrouter/fake/model",
      adapter,
      matchGranularity: "run",
    })
    expect(records.length).toBe(5)
    expect(records.slice(0, 3).map((r) => r.method)).toEqual(["LLM", "LLM", "LLM"])
    expect(records.slice(3).map((r) => r.method)).toEqual(["JIT", "JIT"])
    const jit = records[3]!
    expect(jit.tokens_in).toBe(0)
    expect(jit.tokens_out).toBe(0)
    expect(jit.purpose).toBe("fetch-current-weather")
    expect(jit.skill).toBe("weather")
    expect(jit.promoted).toBe(true)
    const llm = records[0]!
    expect(llm.tokens_in).toBe(1000)
    expect(llm.tokens_out).toBe(50)
    expect(llm.latency_ms).toBe(1234)
    expect(llm.invocation).toBe(1)
  })

  test("signature mismatch never promotes — all invocations stay LLM", async () => {
    const adapter = new FakeAdapter([["python3 fetch_weather.py London"]])
    const { records } = await runSolidifyExperiment({
      specPath,
      model: "openrouter/fake/model",
      adapter,
      matchGranularity: "run",
    })
    expect(records.length).toBe(5)
    expect(records.every((r) => r.method === "LLM")).toBe(true)
    expect(records.every((r) => r.promoted === false)).toBe(true)
  })

  test("missing candidate for purposeId runs the whole case on the LLM path", async () => {
    const spec = SolidifyCasesFileSchema.parse(JSON.parse(await Bun.file(specPath).text()))
    spec.cases[0]!.purposeId = "no-such-purpose"
    await Bun.write(specPath, JSON.stringify(spec))
    const adapter = new FakeAdapter([['curl -s "wttr.in/London?format=3"']])
    const { records } = await runSolidifyExperiment({
      specPath,
      model: "openrouter/fake/model",
      adapter,
      matchGranularity: "run",
    })
    expect(records.length).toBe(5)
    expect(records.every((r) => r.method === "LLM")).toBe(true)
  })

  test("invocations cap slices each case's prompts", async () => {
    const adapter = new FakeAdapter([['curl -s "wttr.in/X?format=3"']])
    const { records } = await runSolidifyExperiment({
      specPath,
      model: "openrouter/fake/model",
      adapter,
      matchGranularity: "run",
      invocations: 2,
    })
    expect(records.length).toBe(2)
  })

  test("online refine: rewrite after misses, promotion re-earned, then serves", async () => {
    // 8 prompts so there is room for: 3 misses -> refine -> 3 new matches -> 2 JIT
    const spec = SolidifyCasesFileSchema.parse(JSON.parse(await Bun.file(specPath).text()))
    spec.cases[0]!.prompts = [
      ...spec.cases[0]!.prompts,
      "What is the current weather in Madrid?",
      "What is the current weather in Sydney?",
      "What is the current weather in Cairo?",
    ]
    await Bun.write(specPath, JSON.stringify(spec))

    // agent consistently does something the AOT signature (wttr\.in) never matches
    const adapter = new FakeAdapter([["python3 weather.py --city London"]])
    const refineCalls: { observations: number; prompts: number }[] = []
    const { records, refinements } = await runSolidifyExperiment({
      specPath,
      model: "openrouter/fake/model",
      adapter,
      matchGranularity: "run",
      onlineRefine: true,
      refineAfterMisses: 3,
      refineFn: async (args) => {
        refineCalls.push({ observations: args.observations.length, prompts: args.prompts.length })
        return {
          candidate: {
            ...args.candidate,
            codeSignature: "weather\\.py",
            functionTemplate: 'echo "refined:${city}"',
          },
          costUsd: 0.01,
        }
      },
    })

    expect(records.length).toBe(8)
    expect(refinements.length).toBe(1)
    expect(refinements[0]!.invocation).toBe(3)
    expect(refineCalls[0]!.observations).toBeGreaterThanOrEqual(3)
    // promotion re-earned with the refined signature: invocations 4-6 LLM, 7-8 JIT
    expect(records.map((r) => r.method)).toEqual(["LLM", "LLM", "LLM", "LLM", "LLM", "LLM", "JIT", "JIT"])
    expect(records[6]!.tokens_in).toBe(0)
  })

  test("online refine + retro-promote: refined candidate serves on the very next invocation", async () => {
    const adapter = new FakeAdapter([["python3 weather.py --city London"]])
    const { records, refinements } = await runSolidifyExperiment({
      specPath,
      model: "openrouter/fake/model",
      adapter,
      matchGranularity: "run",
      onlineRefine: true,
      refineAfterMisses: 3,
      retroPromote: true,
      refineFn: async (args) => ({
        candidate: {
          ...args.candidate,
          codeSignature: "weather\\.py",
          functionTemplate: 'echo "refined:${city}"',
        },
        costUsd: 0.01,
      }),
    })
    expect(refinements.length).toBe(1)
    expect(refinements[0]!.invocation).toBe(3)
    // signature covers all 3 observed runs -> retroactive promotion -> JIT from invocation 4
    expect(records.map((r) => r.method)).toEqual(["LLM", "LLM", "LLM", "JIT", "JIT"])
    expect(records[3]!.tokens_in).toBe(0)
  })

  test("online refine: rejected refinement keeps the original candidate and never re-fires past maxRefines", async () => {
    const adapter = new FakeAdapter([["python3 weather.py --city London"]])
    let calls = 0
    const { records, refinements } = await runSolidifyExperiment({
      specPath,
      model: "openrouter/fake/model",
      adapter,
      matchGranularity: "run",
      onlineRefine: true,
      refineAfterMisses: 3,
      maxRefines: 1,
      refineFn: async () => {
        calls++
        return { candidate: null, costUsd: 0.01 }
      },
    })
    expect(calls).toBe(1)
    expect(refinements.length).toBe(0)
    expect(records.every((r) => r.method === "LLM")).toBe(true)
  })

describe("runSolidifyExperiment — served rows account for the whole run", () => {
  test("a serve after the first provider call adds to the run's usage, it does not replace it", async () => {
    // Reporting only the extraction cost here credited the run with a saving it
    // never made: one probe recorded 4 tokens for a run that really cost 1000/50.
    const { records } = await runSolidifyExperiment({
      specPath,
      model: "openrouter/fake/model",
      adapter: new LateServeAdapter(),
      matchGranularity: "run",
      promotionThreshold: 1,
    })

    const served = records.find((r) => r.method === "JIT")
    expect(served).toBeDefined()
    expect(served!.tokens_in).toBeGreaterThanOrEqual(1000)
    expect(served!.tokens_out).toBeGreaterThanOrEqual(50)
    expect(served!.latency_ms).toBeGreaterThanOrEqual(900)
  })
})

describe("runSolidifyExperiment — failure containment", () => {
  test("one broken case does not discard the records of the cases that ran", async () => {
    // A non-zero `_setup.sh`, or a 429 on a refinement call at invocation 3 of 5,
    // used to throw out of the driver entirely — a long run ending with no CSV.
    const twoCases = {
      cases: [
        { id: "weather-current", purposeId: "fetch-current-weather", skill: "./weather", prompts: ["What is the current weather in London?"] },
        { id: "broken", purposeId: "fetch-current-weather", skill: "./no-such-skill", prompts: ["What is the current weather in Paris?"] },
      ],
    }
    const twoCasePath = path.join(root, "two-cases.json")
    await Bun.write(twoCasePath, JSON.stringify(twoCases))

    const result = await runSolidifyExperiment({
      specPath: twoCasePath,
      model: "openrouter/fake/model",
      adapter: new FakeAdapter([['curl -s "wttr.in/London?format=3"']]),
      matchGranularity: "run",
    })

    expect(result.records.map((r) => r.case)).toEqual(["weather-current"])
    expect(result.failures.map((f) => f.case)).toEqual(["broken"])
  })
})
})

describe("invocationRecordsToCsv", () => {
  test("emits one row per invocation in a stable column order", () => {
    const records: InvocationRecord[] = [
      { case: "pdf-extract", invocation: 1, method: "LLM", latency_ms: 13327, tokens_in: 11999, tokens_out: 289, purpose: "extract-pdf-text-tables", skill: "document-pdf", runStatus: "timeout", promoted: false },
      { case: "pdf-extract", invocation: 4, method: "JIT", latency_ms: 108, tokens_in: 0, tokens_out: 0, purpose: "extract-pdf-text-tables", skill: "document-pdf", runStatus: "ok", promoted: true },
    ]
    expect(invocationRecordsToCsv(records)).toBe(
      "case,invocation,method,latency_ms,tokens_in,tokens_out,purpose,skill,run_status,promoted\n" +
      "pdf-extract,1,LLM,13327,11999,289,extract-pdf-text-tables,document-pdf,timeout,false\n" +
      "pdf-extract,4,JIT,108,0,0,extract-pdf-text-tables,document-pdf,ok,true\n",
    )
  })

})


/**
 * An adapter whose serve lands AFTER the run has already spent tokens: the
 * agent makes a matching tool call, and only the next provider call is served.
 * This is the ordinary shape once a candidate is promoted mid-run — beforeLLM
 * fires before every provider call, not just the first.
 */
class LateServeAdapter implements AgentAdapter {
  readonly name = "bare-agent"
  private hooks: RuntimeHooks = {}

  setHooks(hooks: RuntimeHooks) { this.hooks = hooks }
  async setup(_config: AdapterConfig): Promise<void> {}
  async teardown(): Promise<void> {}

  async run(task: { prompt: string; workDir: string; skill?: SkillBundle }): Promise<RunResult> {
    // Step 1: a real LLM turn that emits the matching call — real tokens spent.
    if (this.hooks.afterLLM) {
      for (const hook of this.hooks.afterLLM) {
        await hook({
          response: {
            text: "done",
            toolCalls: [{ id: "tc-0", name: "execute_command", arguments: { command: 'curl -s "wttr.in/London?format=3"' } }],
            tokens: { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0 },
            durationMs: 900,
            stopReason: "tool_use",
          },
          iteration: 1,
          workDir: task.workDir,
        })
      }
    }
    // Step 2: the next provider call is intercepted and served.
    if (this.hooks.beforeLLM) {
      for (const hook of this.hooks.beforeLLM) {
        await hook({ prompt: task.prompt, workDir: task.workDir, iteration: 1, previousToolCalls: [] })
      }
    }
    return {
      text: "served",
      steps: [],
      tokens: { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      durationMs: 900,
      llmDurationMs: 900,
      workDir: task.workDir,
      runStatus: "ok",
    }
  }
}
