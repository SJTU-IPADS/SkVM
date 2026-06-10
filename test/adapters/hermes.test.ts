import { test, expect, describe } from "bun:test"
import { buildMinimalRecord, parseHermesSession } from "../../src/adapters/hermes.ts"

// Regression coverage for docs/skvm/bench-adapter-error-false-positive.md.
// The full `.run()` method orchestrates real subprocesses; these tests
// exercise the building blocks most likely to regress:
//   - buildMinimalRecord + finish() propagates the run-level verdict
//   - parseHermesSession stamps 'ok' on the happy path
// (subprocess timeout semantics are covered in test/core/subprocess.test.ts)

describe("hermes: buildMinimalRecord", () => {
  test("timeout path — runStatus=timeout, usage unavailable", () => {
    const r = buildMinimalRecord("some partial stdout\nsession_id: abc").finish({
      workDir: "/tmp/wd",
      durationMs: 300004,
      runStatus: "timeout",
      statusDetail: "hermes chat subprocess killed after 300000ms",
    })
    expect(r.runStatus).toBe("timeout")
    expect(r.statusDetail).toContain("300000ms")
    expect(r.tokens.input).toBe(0)
    expect(r.tokens.output).toBe(0)
    expect(r.cost).toBe(0)
    expect(r.usageAvailable).toBe(false)
    expect(r.durationMs).toBe(300004)
    expect(r.workDir).toBe("/tmp/wd")
    // The session_id trailer is stripped from the displayable text
    expect(r.text).toBe("some partial stdout")
  })

  test("adapter-crashed path — runStatus=adapter-crashed", () => {
    const r = buildMinimalRecord("").finish({
      workDir: "/tmp/wd",
      durationMs: 42,
      runStatus: "adapter-crashed",
      statusDetail: "exited 1",
    })
    expect(r.runStatus).toBe("adapter-crashed")
    expect(r.statusDetail).toBe("exited 1")
    expect(r.steps).toHaveLength(0)
  })

  test("clean-exit reduced-telemetry path — runStatus=ok with parser note", () => {
    // Regression for round-3 Codex P1/P2: when the chat subprocess exits
    // cleanly but auxiliary telemetry (session_id trailer / sessions export)
    // is unavailable, the run should still be 'ok' so the runner gate
    // evaluates the workDir. Marking these as parse-failed (round-2 behavior)
    // forced false negatives on environments where the binary doesn't print
    // the trailer or where `sessions export` is broken.
    const r = buildMinimalRecord("hello from agent",
      "hermes sessions export exited 1 — telemetry unavailable")
      .finish({ workDir: "/tmp/wd", durationMs: 10 })
    expect(r.runStatus).toBe("ok")
    expect(r.statusDetail).toContain("telemetry unavailable")
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0]!.role).toBe("assistant")
    expect(r.text).toBe("hello from agent")
  })

  test("run-level verdict beats the parser note", () => {
    const r = buildMinimalRecord("partial", "parser-level note").finish({
      workDir: "/tmp/wd",
      durationMs: 1,
      runStatus: "timeout",
      statusDetail: "killed",
    })
    expect(r.runStatus).toBe("timeout")
    expect(r.statusDetail).toBe("killed")
  })
})

describe("hermes: parseHermesSession", () => {
  test("stamps runStatus='ok' on the happy path", () => {
    const r = parseHermesSession(
      {
        id: "s1",
        source: "hermes",
        model: "test",
        started_at: 1000,
        ended_at: 2000,
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        estimated_cost_usd: 0.01,
        actual_cost_usd: null,
        messages: [{
          id: 1,
          session_id: "s1",
          role: "assistant",
          content: "done",
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          timestamp: 1500,
          token_count: 50,
          finish_reason: "end_turn",
          reasoning: null,
        }],
      },
    ).finish({ workDir: "/tmp/wd", durationMs: 1000 })
    expect(r.runStatus).toBe("ok")
    expect(r.tokens.input).toBe(100)
    expect(r.tokens.output).toBe(50)
    expect(r.cost).toBe(0.01)
    expect(r.usageAvailable).toBe(true)
  })
})
