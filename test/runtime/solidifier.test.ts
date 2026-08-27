import { test, expect, describe } from "bun:test"
import { Solidifier, extractParamsFromPrompt, instantiateTemplate } from "../../src/jit-boost/solidifier.ts"
import type { BoostCandidate, SolidificationState } from "../../src/jit-boost/types.ts"
import type { LLMResponse } from "../../src/providers/types.ts"

const CANDIDATE: BoostCandidate = {
  purposeId: "fetch-weather",
  keywords: ["weather", "temperature", "forecast"],
  codeSignature: "curl.*api\\.weather\\.com.*jq",
  functionTemplate: 'curl -s "https://api.weather.com/v1/${city}" | jq .temperature',
  params: {
    city: {
      type: "string",
      description: "City name for weather query",
      extractPattern: "(?:in|for)\\s+([A-Z][a-zA-Z]+)",
    },
  },
  materializationType: "shell",
}

/** Backward-compat candidate with old-style string params */
const LEGACY_CANDIDATE: BoostCandidate = {
  purposeId: "fetch-weather-legacy",
  keywords: ["weather"],
  codeSignature: "curl.*api\\.weather\\.com.*jq",
  functionTemplate: 'curl -s "https://api.weather.com/v1/${city}" | jq .temperature',
  params: { city: "string" },
  materializationType: "shell",
}

function makeLLMResponse(toolCalls: Array<{ name: string; args: Record<string, unknown> }>): LLMResponse {
  return {
    text: "",
    toolCalls: toolCalls.map((tc, i) => ({
      id: `tc_${i}`,
      name: tc.name,
      arguments: tc.args,
    })),
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    durationMs: 0,
    stopReason: "tool_use",
  }
}

describe("Solidifier - Stage 2 (monitoring)", () => {
  test("skeleton match increments consecutiveMatches", async () => {
    const solidifier = new Solidifier([CANDIDATE])
    const hook = solidifier.createAfterLLMHook()

    await hook({
      response: makeLLMResponse([{
        name: "execute_command",
        args: { command: 'curl -s "https://api.weather.com/v1/Tokyo" | jq .temperature' },
      }]),
      iteration: 1,
      workDir: "/tmp",
    })

    const entries = solidifier.getEntries()
    expect(entries[0]!.state.consecutiveMatches).toBe(1)
    expect(entries[0]!.state.hitCount).toBe(1)
    expect(entries[0]!.state.promoted).toBe(false)
  })

  test("non-matching tool call resets consecutiveMatches", async () => {
    const solidifier = new Solidifier([CANDIDATE])
    const hook = solidifier.createAfterLLMHook()

    // First match
    await hook({
      response: makeLLMResponse([{
        name: "execute_command",
        args: { command: 'curl -s "https://api.weather.com/v1/Tokyo" | jq .temp' },
      }]),
      iteration: 1,
      workDir: "/tmp",
    })
    expect(solidifier.getEntries()[0]!.state.consecutiveMatches).toBe(1)

    // Non-match resets
    await hook({
      response: makeLLMResponse([{
        name: "execute_command",
        args: { command: "echo hello" },
      }]),
      iteration: 2,
      workDir: "/tmp",
    })
    expect(solidifier.getEntries()[0]!.state.consecutiveMatches).toBe(0)
    expect(solidifier.getEntries()[0]!.state.hitCount).toBe(1) // total still 1
  })

  test("3 consecutive matches promotes candidate", async () => {
    const solidifier = new Solidifier([CANDIDATE])
    const hook = solidifier.createAfterLLMHook()

    for (let i = 1; i <= 3; i++) {
      await hook({
        response: makeLLMResponse([{
          name: "execute_command",
          args: { command: `curl -s "https://api.weather.com/v1/City${i}" | jq .temperature` },
        }]),
        iteration: i,
        workDir: "/tmp",
      })
    }

    const entry = solidifier.getEntries()[0]!
    expect(entry.state.promoted).toBe(true)
    expect(entry.state.consecutiveMatches).toBe(3)
    expect(entry.promotedAt).toBeDefined()
  })

  test("2 matches + miss + 2 matches does NOT promote", async () => {
    const solidifier = new Solidifier([CANDIDATE])
    const hook = solidifier.createAfterLLMHook()

    // 2 matches
    for (let i = 0; i < 2; i++) {
      await hook({
        response: makeLLMResponse([{
          name: "execute_command",
          args: { command: `curl -s "https://api.weather.com/v1/A" | jq .temperature` },
        }]),
        iteration: i,
        workDir: "/tmp",
      })
    }
    expect(solidifier.getEntries()[0]!.state.consecutiveMatches).toBe(2)

    // Miss
    await hook({
      response: makeLLMResponse([{ name: "execute_command", args: { command: "ls" } }]),
      iteration: 3,
      workDir: "/tmp",
    })
    expect(solidifier.getEntries()[0]!.state.consecutiveMatches).toBe(0)

    // 2 more matches
    for (let i = 0; i < 2; i++) {
      await hook({
        response: makeLLMResponse([{
          name: "execute_command",
          args: { command: `curl -s "https://api.weather.com/v1/B" | jq .temperature` },
        }]),
        iteration: 4 + i,
        workDir: "/tmp",
      })
    }

    expect(solidifier.getEntries()[0]!.state.consecutiveMatches).toBe(2)
    expect(solidifier.getEntries()[0]!.state.promoted).toBe(false) // NOT promoted
  })

  test("ignores non-exec/write tool calls", async () => {
    const solidifier = new Solidifier([CANDIDATE])
    const hook = solidifier.createAfterLLMHook()

    await hook({
      response: makeLLMResponse([{
        name: "read_file",
        args: { path: 'curl api.weather.com jq' },
      }]),
      iteration: 1,
      workDir: "/tmp",
    })

    expect(solidifier.getEntries()[0]!.state.hitCount).toBe(0)
  })
})

describe("extractParamsFromPrompt", () => {
  test("extracts city via regex extractPattern", async () => {
    const result = await extractParamsFromPrompt("What's the weather in Tokyo?", CANDIDATE)
    expect(result.complete).toBe(true)
    expect(result.method).toBe("regex")
    expect(result.params.city).toBe("Tokyo")
  })

  test("extracts city via regex extractPattern (for variant)", async () => {
    const result = await extractParamsFromPrompt("Get forecast for London", CANDIDATE)
    expect(result.complete).toBe(true)
    expect(result.method).toBe("regex")
    expect(result.params.city).toBe("London")
  })

  test("returns incomplete when regex fails and no LLM provider", async () => {
    const result = await extractParamsFromPrompt("Show me the temperature", CANDIDATE)
    expect(result.complete).toBe(false)
    expect(result.method).toBe("none")
  })

  test("legacy string params (no extractPattern) returns incomplete without LLM", async () => {
    const result = await extractParamsFromPrompt("What's the weather in Tokyo?", LEGACY_CANDIDATE)
    expect(result.complete).toBe(false)
    expect(result.method).toBe("none")
  })

  test("empty params returns complete", async () => {
    const candidate: BoostCandidate = {
      ...CANDIDATE,
      params: {},
    }
    const result = await extractParamsFromPrompt("anything", candidate)
    expect(result.complete).toBe(true)
  })

  test("multi-param regex extraction", async () => {
    const candidate: BoostCandidate = {
      ...CANDIDATE,
      params: {
        inputPdf: { type: "string", description: "Input PDF file", extractPattern: "(\\S+\\.pdf)" },
        outputTxt: { type: "string", description: "Output text file", extractPattern: "(\\S+\\.txt)" },
      },
    }
    const result = await extractParamsFromPrompt("Extract text from report.pdf to output.txt", candidate)
    expect(result.complete).toBe(true)
    expect(result.method).toBe("regex")
    expect(result.params.inputPdf).toBe("report.pdf")
    expect(result.params.outputTxt).toBe("output.txt")
  })

  test("partial regex extraction returns incomplete", async () => {
    const candidate: BoostCandidate = {
      ...CANDIDATE,
      params: {
        inputPdf: { type: "string", description: "Input PDF", extractPattern: "(\\S+\\.pdf)" },
        outputTxt: { type: "string", description: "Output text", extractPattern: "(\\S+\\.txt)" },
      },
    }
    // Only mentions .pdf, not .txt
    const result = await extractParamsFromPrompt("Process report.pdf", candidate)
    expect(result.complete).toBe(false)
  })
})

describe("instantiateTemplate", () => {
  test("replaces placeholders", () => {
    const result = instantiateTemplate(
      'curl -s "https://api.weather.com/v1/${city}" | jq .temperature',
      { city: "Tokyo" },
    )
    expect(result).toBe('curl -s "https://api.weather.com/v1/Tokyo" | jq .temperature')
  })

  test("replaces multiple placeholders", () => {
    const result = instantiateTemplate(
      'python3 process.py --input ${input} --output ${output}',
      { input: "data.csv", output: "result.json" },
    )
    expect(result).toBe("python3 process.py --input data.csv --output result.json")
  })

  test("leaves unknown placeholders as-is", () => {
    const result = instantiateTemplate('echo ${unknown}', {})
    expect(result).toBe("echo ${unknown}")
  })
})

describe("Solidifier - state restoration", () => {
  test("restores promotion state from persisted data", () => {
    const savedState: SolidificationState = {
      skillId: "weather",
      entries: [{
        candidate: CANDIDATE,
        state: {
          candidateId: "fetch-weather",
          hitCount: 10,
          consecutiveMatches: 3,
          promoted: true,
          fallbackCount: 0,
        },
        promotedAt: "2026-04-04T00:00:00Z",
      }],
      updatedAt: "2026-04-04T00:00:00Z",
    }

    const solidifier = new Solidifier([CANDIDATE], { savedState })
    const entries = solidifier.getEntries()

    expect(entries).toHaveLength(1)
    expect(entries[0]!.state.promoted).toBe(true)
    expect(entries[0]!.state.hitCount).toBe(10)
    expect(entries[0]!.state.consecutiveMatches).toBe(3)
    expect(entries[0]!.promotedAt).toBe("2026-04-04T00:00:00Z")
  })

  test("fresh init when no saved state", () => {
    const solidifier = new Solidifier([CANDIDATE])
    const entries = solidifier.getEntries()

    expect(entries).toHaveLength(1)
    expect(entries[0]!.state.promoted).toBe(false)
    expect(entries[0]!.state.hitCount).toBe(0)
  })
})

describe("Solidifier - exportState", () => {
  test("exports current state for persistence", () => {
    const solidifier = new Solidifier([CANDIDATE])
    const exported = solidifier.exportState("weather")

    expect(exported.skillId).toBe("weather")
    expect(exported.entries).toHaveLength(1)
    expect(exported.entries[0]!.candidate.purposeId).toBe("fetch-weather")
    expect(exported.updatedAt).toBeDefined()
  })

  test("exports updated state after monitoring", async () => {
    const solidifier = new Solidifier([CANDIDATE])
    const hook = solidifier.createAfterLLMHook()

    await hook({
      response: makeLLMResponse([{
        name: "execute_command",
        args: { command: 'curl -s "https://api.weather.com/v1/Tokyo" | jq .temperature' },
      }]),
      iteration: 1,
      workDir: "/tmp",
    })

    const exported = solidifier.exportState("weather")
    expect(exported.entries[0]!.state.hitCount).toBe(1)
    expect(exported.entries[0]!.state.consecutiveMatches).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// matchGranularity: "run" + serve events (experiment driver support)
// ---------------------------------------------------------------------------

const RUN_GRANULARITY_CANDIDATE: BoostCandidate = {
  purposeId: "fetch-current-weather",
  keywords: ["weather"],
  codeSignature: "wttr\\.in",
  functionTemplate: 'echo "weather for ${city}"',
  params: {
    city: { type: "string", description: "city name", extractPattern: "weather in ([A-Za-z ]+?)\\??$" },
  },
  materializationType: "shell",
}

function wttrCommand(city: string): { name: string; args: Record<string, unknown> } {
  return { name: "execute_command", args: { command: `curl -s "wttr.in/${city}?format=3"` } }
}

describe("Solidifier - matchGranularity=run", () => {
  test("multiple matching tool calls in one run count once", async () => {
    const solidifier = new Solidifier([RUN_GRANULARITY_CANDIDATE], { matchGranularity: "run" })
    const hook = solidifier.createAfterLLMHook()
    // one run with 3 matching commands — must NOT promote by itself
    await hook({
      response: makeLLMResponse([wttrCommand("London"), wttrCommand("London"), wttrCommand("London")]),
      iteration: 1,
      workDir: "/tmp",
    })
    solidifier.finalizeRun()
    expect(solidifier.getEntries()[0]!.state.consecutiveMatches).toBe(1)
    expect(solidifier.getEntries()[0]!.state.promoted).toBe(false)
  })

  test("promotes after 3 matched runs", async () => {
    const solidifier = new Solidifier([RUN_GRANULARITY_CANDIDATE], { matchGranularity: "run" })
    const hook = solidifier.createAfterLLMHook()
    for (let run = 0; run < 3; run++) {
      await hook({ response: makeLLMResponse([wttrCommand("Paris")]), iteration: 1, workDir: "/tmp" })
      solidifier.finalizeRun()
    }
    expect(solidifier.getEntries()[0]!.state.promoted).toBe(true)
    expect(solidifier.getEntries()[0]!.state.hitCount).toBe(3)
  })

  test("a run without any match resets consecutive count", async () => {
    const solidifier = new Solidifier([RUN_GRANULARITY_CANDIDATE], { matchGranularity: "run" })
    const hook = solidifier.createAfterLLMHook()
    await hook({ response: makeLLMResponse([wttrCommand("Rome")]), iteration: 1, workDir: "/tmp" })
    solidifier.finalizeRun()
    await hook({
      response: makeLLMResponse([{ name: "execute_command", args: { command: "ls -la" } }]),
      iteration: 1,
      workDir: "/tmp",
    })
    solidifier.finalizeRun()
    expect(solidifier.getEntries()[0]!.state.consecutiveMatches).toBe(0)
    expect(solidifier.getEntries()[0]!.state.promoted).toBe(false)
  })

  test("tool-call granularity (default) is unchanged: 3 matches in one run promote", async () => {
    const solidifier = new Solidifier([RUN_GRANULARITY_CANDIDATE])
    const hook = solidifier.createAfterLLMHook()
    await hook({
      response: makeLLMResponse([wttrCommand("London"), wttrCommand("London"), wttrCommand("London")]),
      iteration: 1,
      workDir: "/tmp",
    })
    expect(solidifier.getEntries()[0]!.state.promoted).toBe(true)
  })

  test("finalizeRun is a no-op in tool-call granularity", async () => {
    const solidifier = new Solidifier([RUN_GRANULARITY_CANDIDATE])
    const hook = solidifier.createAfterLLMHook()
    await hook({ response: makeLLMResponse([wttrCommand("Tokyo")]), iteration: 1, workDir: "/tmp" })
    solidifier.finalizeRun()
    expect(solidifier.getEntries()[0]!.state.consecutiveMatches).toBe(1)
  })
})

describe("Solidifier - miss observations and candidate replacement (online refine)", () => {
  test("miss count accumulates across interleaved matches; observations keep every variant", async () => {
    const solidifier = new Solidifier([RUN_GRANULARITY_CANDIDATE], { matchGranularity: "run" })
    const hook = solidifier.createAfterLLMHook()

    // two non-matching runs with similar content
    for (const city of ["London", "Paris"]) {
      await hook({
        response: makeLLMResponse([{ name: "execute_command", args: { command: `python3 weather.py --city ${city}` } }]),
        iteration: 1,
        workDir: "/tmp",
      })
      solidifier.finalizeRun()
    }
    let miss = solidifier.getMissInfo("fetch-current-weather")
    expect(miss.missRuns).toBe(2)
    expect(miss.observations.length).toBe(2)
    expect(miss.observations[0]!.tool).toBe("execute_command")
    expect(miss.observations[0]!.content).toContain("weather.py")

    // an interleaved matching run does NOT erase the evidence — alternating
    // match/miss is exactly the pattern refinement exists for, and the
    // refiner must see both variants
    await hook({ response: makeLLMResponse([wttrCommand("Tokyo")]), iteration: 1, workDir: "/tmp" })
    solidifier.finalizeRun()
    miss = solidifier.getMissInfo("fetch-current-weather")
    expect(miss.missRuns).toBe(2)
    expect(miss.observations.length).toBe(3)
    expect(miss.observations[2]!.content).toContain("wttr.in")
  })

  test("replaceCandidate with creditObservedRuns replays the gate against history", async () => {
    const solidifier = new Solidifier([RUN_GRANULARITY_CANDIDATE], { matchGranularity: "run" })
    const hook = solidifier.createAfterLLMHook()
    // 3 runs the AOT signature misses, but with a stable observable pattern
    for (const city of ["London", "Paris", "Tokyo"]) {
      await hook({
        response: makeLLMResponse([{ name: "execute_command", args: { command: `python3 weather.py --city ${city}` } }]),
        iteration: 1,
        workDir: "/tmp",
      })
      solidifier.finalizeRun()
    }
    expect(solidifier.getEntries()[0]!.state.promoted).toBe(false)

    // refined signature covers all 3 observed runs -> immediate promotion
    solidifier.replaceCandidate("fetch-current-weather", {
      ...RUN_GRANULARITY_CANDIDATE,
      codeSignature: "weather\\.py",
    }, { creditObservedRuns: true })
    const entry = solidifier.getEntries()[0]!
    expect(entry.state.promoted).toBe(true)
    expect(entry.state.consecutiveMatches).toBe(3)
    expect(entry.promotedAt).toBeDefined()
  })

  test("creditObservedRuns counts only the TRAILING covered streak", async () => {
    const solidifier = new Solidifier([RUN_GRANULARITY_CANDIDATE], { matchGranularity: "run" })
    const hook = solidifier.createAfterLLMHook()
    // run 1: weather.py; run 2: unrelated; runs 3-4: weather.py
    const commands = ["python3 weather.py --city London", "ls -la", "python3 weather.py --city Paris", "python3 weather.py --city Rome"]
    for (const command of commands) {
      await hook({ response: makeLLMResponse([{ name: "execute_command", args: { command } }]), iteration: 1, workDir: "/tmp" })
      solidifier.finalizeRun()
    }
    solidifier.replaceCandidate("fetch-current-weather", {
      ...RUN_GRANULARITY_CANDIDATE,
      codeSignature: "weather\\.py",
    }, { creditObservedRuns: true })
    const entry = solidifier.getEntries()[0]!
    // trailing streak is runs 4,3 = 2 (run 2 breaks it) -> not promoted yet
    expect(entry.state.promoted).toBe(false)
    expect(entry.state.consecutiveMatches).toBe(2)

    // one live match completes the gate
    await hook({
      response: makeLLMResponse([{ name: "execute_command", args: { command: "python3 weather.py --city Oslo" } }]),
      iteration: 1,
      workDir: "/tmp",
    })
    solidifier.finalizeRun()
    expect(solidifier.getEntries()[0]!.state.promoted).toBe(true)
  })

  test("creditObservedRuns does not step over unobserved runs", async () => {
    const solidifier = new Solidifier([RUN_GRANULARITY_CANDIDATE], { matchGranularity: "run" })
    const hook = solidifier.createAfterLLMHook()
    // run 1: covered; run 2: NO tool calls at all; runs 3-4: covered.
    // Nonconsecutive covered runs (1 and 3-4) must not form a streak of 3.
    await hook({ response: makeLLMResponse([{ name: "execute_command", args: { command: "python3 weather.py --city London" } }]), iteration: 1, workDir: "/tmp" })
    solidifier.finalizeRun()
    solidifier.finalizeRun() // empty run — a miss with nothing observed
    for (const city of ["Paris", "Rome"]) {
      await hook({ response: makeLLMResponse([{ name: "execute_command", args: { command: `python3 weather.py --city ${city}` } }]), iteration: 1, workDir: "/tmp" })
      solidifier.finalizeRun()
    }
    solidifier.replaceCandidate("fetch-current-weather", {
      ...RUN_GRANULARITY_CANDIDATE,
      codeSignature: "weather\\.py",
    }, { creditObservedRuns: true })
    const entry = solidifier.getEntries()[0]!
    expect(entry.state.promoted).toBe(false)
    expect(entry.state.consecutiveMatches).toBe(2) // runs 4,3 only — run 2 is a hole
  })

  test("creditObservedRuns gives zero credit when the most recent run is unobserved", async () => {
    const solidifier = new Solidifier([RUN_GRANULARITY_CANDIDATE], { matchGranularity: "run" })
    const hook = solidifier.createAfterLLMHook()
    for (const city of ["London", "Paris", "Tokyo"]) {
      await hook({ response: makeLLMResponse([{ name: "execute_command", args: { command: `python3 weather.py --city ${city}` } }]), iteration: 1, workDir: "/tmp" })
      solidifier.finalizeRun()
    }
    solidifier.finalizeRun() // run 4: empty — the streak must end here, not at run 3
    solidifier.replaceCandidate("fetch-current-weather", {
      ...RUN_GRANULARITY_CANDIDATE,
      codeSignature: "weather\\.py",
    }, { creditObservedRuns: true })
    const entry = solidifier.getEntries()[0]!
    expect(entry.state.promoted).toBe(false)
    expect(entry.state.consecutiveMatches).toBe(0)
  })

  test("replaceCandidate swaps the candidate and resets promotion state", async () => {
    const solidifier = new Solidifier([RUN_GRANULARITY_CANDIDATE], { matchGranularity: "run" })
    const hook = solidifier.createAfterLLMHook()
    for (let run = 0; run < 3; run++) {
      await hook({ response: makeLLMResponse([wttrCommand("Rome")]), iteration: 1, workDir: "/tmp" })
      solidifier.finalizeRun()
    }
    expect(solidifier.getEntries()[0]!.state.promoted).toBe(true)

    solidifier.replaceCandidate("fetch-current-weather", {
      ...RUN_GRANULARITY_CANDIDATE,
      codeSignature: "weather\\.py",
    })
    const entry = solidifier.getEntries()[0]!
    expect(entry.candidate.codeSignature).toBe("weather\\.py")
    expect(entry.state.promoted).toBe(false)
    expect(entry.state.consecutiveMatches).toBe(0)

    // promotion must be re-earned with the NEW signature
    for (let run = 0; run < 3; run++) {
      await hook({
        response: makeLLMResponse([{ name: "execute_command", args: { command: "python3 weather.py --city Oslo" } }]),
        iteration: 1,
        workDir: "/tmp",
      })
      solidifier.finalizeRun()
    }
    expect(solidifier.getEntries()[0]!.state.promoted).toBe(true)
  })
})

describe("Solidifier - serve events", () => {
  test("successful template execution is recorded and drainable", async () => {
    const solidifier = new Solidifier([RUN_GRANULARITY_CANDIDATE], { matchGranularity: "run" })
    // force promotion via 3 matched runs
    const afterLLM = solidifier.createAfterLLMHook()
    for (let run = 0; run < 3; run++) {
      await afterLLM({ response: makeLLMResponse([wttrCommand("Tokyo")]), iteration: 1, workDir: "/tmp" })
      solidifier.finalizeRun()
    }
    expect(solidifier.getEntries()[0]!.state.promoted).toBe(true)

    const beforeLLM = solidifier.createBeforeLLMHook()
    const result = await beforeLLM({
      prompt: "What is the current weather in Berlin?",
      workDir: "/tmp",
      iteration: 0,
      previousToolCalls: [],
    })
    expect(result.action).toBe("replace")

    const events = solidifier.drainServeEvents()
    expect(events.length).toBe(1)
    expect(events[0]!.purposeId).toBe("fetch-current-weather")
    expect(events[0]!.durationMs).toBeGreaterThan(0)
    // extraction accounting: regex path spends time but no tokens
    expect(events[0]!.extractionMethod).toBe("regex")
    expect(events[0]!.extractionMs).toBeGreaterThanOrEqual(0)
    expect(events[0]!.extractionTokens).toEqual({ input: 0, output: 0 })
    // drained — second call is empty
    expect(solidifier.drainServeEvents().length).toBe(0)
  })
})

describe("Solidifier - configurable monitor scope", () => {
  test("web_fetch is monitored by default", async () => {
    const candidate: BoostCandidate = {
      ...CANDIDATE,
      codeSignature: "weather\\.com",
    }
    const solidifier = new Solidifier([candidate])
    const hook = solidifier.createAfterLLMHook()

    await hook({
      response: makeLLMResponse([{
        name: "web_fetch",
        args: { url: "https://api.weather.com/v1/Tokyo" },
      }]),
      iteration: 1,
      workDir: "/tmp",
    })

    const entries = solidifier.getEntries()
    expect(entries[0]!.state.hitCount).toBe(1)
  })

  test("per-candidate monitoredTools override", async () => {
    const candidate: BoostCandidate = {
      ...CANDIDATE,
      codeSignature: "weather\\.com",
      monitoredTools: ["web_fetch"],
    }
    const solidifier = new Solidifier([candidate])
    const hook = solidifier.createAfterLLMHook()

    await hook({
      response: makeLLMResponse([{
        name: "execute_command",
        args: { command: 'curl https://api.weather.com/v1/Tokyo' },
      }]),
      iteration: 1,
      workDir: "/tmp",
    })
    expect(solidifier.getEntries()[0]!.state.hitCount).toBe(0)

    await hook({
      response: makeLLMResponse([{
        name: "web_fetch",
        args: { url: "https://api.weather.com/v1/Tokyo" },
      }]),
      iteration: 2,
      workDir: "/tmp",
    })
    expect(solidifier.getEntries()[0]!.state.hitCount).toBe(1)
  })

  test("custom default monitored tools", async () => {
    const candidate: BoostCandidate = {
      ...CANDIDATE,
      codeSignature: "test",
    }
    const solidifier = new Solidifier([candidate], { monitoredTools: new Set(["read_file"]) })
    const hook = solidifier.createAfterLLMHook()

    await hook({
      response: makeLLMResponse([{
        name: "execute_command",
        args: { command: "test" },
      }]),
      iteration: 1,
      workDir: "/tmp",
    })
    expect(solidifier.getEntries()[0]!.state.hitCount).toBe(0)

    await hook({
      response: makeLLMResponse([{
        name: "read_file",
        args: { path: "test" },
      }]),
      iteration: 2,
      workDir: "/tmp",
    })
    expect(solidifier.getEntries()[0]!.state.hitCount).toBe(1)
  })
})

describe("Solidifier — retro credit matches the live gate", () => {
  test("credit is not given for matches in tools the candidate does not monitor", async () => {
    // afterLLM only tests a candidate against its monitoredTools. Replaying the
    // gate without that filter is MORE permissive than the gate it replays, so a
    // candidate could promote on evidence its own live path rejects.
    const candidate: BoostCandidate = {
      ...RUN_GRANULARITY_CANDIDATE,
      monitoredTools: ["execute_command"],
    }
    const solidifier = new Solidifier([candidate], { matchGranularity: "run", monitoredTools: new Set(["execute_command", "web_fetch"]) })
    const hook = solidifier.createAfterLLMHook()

    // Three runs of web_fetch — observed, but not on a tool this candidate watches.
    for (const city of ["London", "Paris", "Rome"]) {
      await hook({
        response: makeLLMResponse([{ name: "web_fetch", args: { url: `https://wttr.in/${city}` } }]),
        iteration: 1, workDir: "/tmp",
      })
      solidifier.finalizeRun()
    }
    expect(solidifier.getEntries()[0]!.state.consecutiveMatches).toBe(0)

    solidifier.replaceCandidate("fetch-current-weather", {
      ...candidate,
      codeSignature: "wttr\\.in",
    }, { creditObservedRuns: true })

    const entry = solidifier.getEntries()[0]!
    expect(entry.state.consecutiveMatches).toBe(0)
    expect(entry.state.promoted).toBe(false)
  })
})

describe("Solidifier — extraction rejects empty params", () => {
  test("a whitespace-only capture is not an extraction", async () => {
    // `match[1]` is truthy for "  ", and trimming afterwards produced an empty
    // param that still counted as complete — so a template ran with nothing
    // substituted where a real argument belonged.
    const candidate: BoostCandidate = {
      ...RUN_GRANULARITY_CANDIDATE,
      functionTemplate: 'echo "city=${city}"',
      params: {
        city: { type: "string", description: "city", extractPattern: "weather in (.*) please" },
      },
    }
    const solidifier = new Solidifier([candidate], { matchGranularity: "run", promotionThreshold: 1 })
    const hook = solidifier.createAfterLLMHook()
    await hook({ response: makeLLMResponse([wttrCommand("London")]), iteration: 1, workDir: "/tmp" })
    solidifier.finalizeRun()
    expect(solidifier.getEntries()[0]!.state.promoted).toBe(true)

    const before = solidifier.createBeforeLLMHook()
    const served = await before({ prompt: "weather in   please", messages: [], workDir: "/tmp", iteration: 1 } as never)

    // No serve: the param did not extract, so the agent handles it.
    expect(served?.action).not.toBe("replace")
  })
})
