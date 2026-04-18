import { test, expect, describe } from "bun:test"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import {
  diagnoseHermes,
  diagnoseOpenclaw,
  diagnoseOpencode,
  diagnoseJiuwenclaw,
} from "../../src/adapters/diagnose-failure.ts"

function freshSandbox(tag: string): string {
  const dir = path.join(os.tmpdir(), `skvm-diagnose-test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe("diagnoseHermes", () => {
  test("extracts reason + model from request_dump_*.json", async () => {
    const sandbox = freshSandbox("hermes")
    try {
      mkdirSync(path.join(sandbox, "sessions"))
      const dump = {
        timestamp: "2026-04-18T06:40:59",
        session_id: "abc",
        reason: "non_retryable_client_error",
        request: { method: "POST", url: "https://openrouter.ai/api/v1/chat/completions", body: { model: "openrouter/bogus" } },
        error: { response_body: { error: { message: "invalid model id" } } },
      }
      writeFileSync(path.join(sandbox, "sessions", "request_dump_abc_xyz.json"), JSON.stringify(dump))
      const out = await diagnoseHermes({ sandboxRoot: sandbox, stdout: "", stderr: "", exitCode: 1 })
      expect(out).not.toBeNull()
      expect(out!.summary).toContain("non_retryable_client_error")
      expect(out!.summary).toContain("invalid model id")
      expect(out!.summary).toContain("openrouter/bogus")
      expect(out!.source).toBe("hermes:request_dump")
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("falls back to stderr error line when no dump", async () => {
    const sandbox = freshSandbox("hermes")
    try {
      const out = await diagnoseHermes({
        sandboxRoot: sandbox,
        stdout: "",
        stderr: "random noise\nTraceback (most recent call last):\n  File ...\nValueError: bad thing\n",
        exitCode: 1,
      })
      expect(out).not.toBeNull()
      expect(out!.source).toBe("hermes:stderr")
      expect(out!.summary).toMatch(/Traceback|ValueError/)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("returns null when no artifacts and no stderr", async () => {
    const sandbox = freshSandbox("hermes")
    try {
      const out = await diagnoseHermes({ sandboxRoot: sandbox, stdout: "", stderr: "", exitCode: 1 })
      expect(out).toBeNull()
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

describe("diagnoseOpenclaw", () => {
  test("extracts error from transcript JSONL tail", async () => {
    const sandbox = freshSandbox("openclaw")
    try {
      const sessionsDir = path.join(sandbox, "agents", "skvm-0", "sessions", "s1")
      mkdirSync(sessionsDir, { recursive: true })
      const lines = [
        JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
        JSON.stringify({ type: "error", message: "upstream 503: model overloaded" }),
      ].join("\n")
      writeFileSync(path.join(sessionsDir, "transcript.jsonl"), lines)
      const out = await diagnoseOpenclaw({
        sandboxRoot: sandbox,
        agentId: "skvm-0",
        stdout: "",
        stderr: "",
        exitCode: 1,
      })
      expect(out).not.toBeNull()
      expect(out!.summary).toContain("upstream 503")
      expect(out!.source).toBe("openclaw:transcript")
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("falls back to lane task error regex in stderr", async () => {
    const sandbox = freshSandbox("openclaw")
    try {
      const out = await diagnoseOpenclaw({
        sandboxRoot: sandbox,
        agentId: "skvm-0",
        stdout: "",
        stderr: `[diagnostic] lane task error: lane=main durationMs=8 error="FailoverError: Unknown model: foo/bar"`,
        exitCode: 1,
      })
      expect(out).not.toBeNull()
      expect(out!.summary).toContain("FailoverError: Unknown model: foo/bar")
      expect(out!.source).toBe("openclaw:stderr")
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

describe("diagnoseOpencode", () => {
  test("extracts last NDJSON error event from stdout", async () => {
    const events = [
      JSON.stringify({ type: "step_start", part: {} }),
      JSON.stringify({ type: "error", part: { error: { data: "provider returned 400: bad model" } } }),
    ].join("\n")
    const out = await diagnoseOpencode({
      sandboxRoot: "/nonexistent",
      stdout: events,
      stderr: "",
      exitCode: 1,
    })
    expect(out).not.toBeNull()
    expect(out!.summary).toContain("provider returned 400: bad model")
    expect(out!.source).toBe("opencode:error-event")
  })

  test("returns null when no error events and no stderr", async () => {
    const out = await diagnoseOpencode({
      sandboxRoot: "/nonexistent",
      stdout: JSON.stringify({ type: "step_start", part: {} }),
      stderr: "",
      exitCode: 1,
    })
    expect(out).toBeNull()
  })
})

describe("diagnoseJiuwenclaw", () => {
  test("extracts chat.error content from history.json", async () => {
    const sandbox = freshSandbox("jiuwenclaw")
    try {
      const sessionDir = path.join(sandbox, "agent", "sessions", "sess1")
      mkdirSync(sessionDir, { recursive: true })
      const history = [
        { event_type: "chat.user", content: "hello" },
        { event_type: "chat.error", content: "sidecar: auth failed — 401" },
      ]
      writeFileSync(path.join(sessionDir, "history.json"), JSON.stringify(history))
      const out = await diagnoseJiuwenclaw({
        sandboxRoot: sandbox,
        sessionId: "sess1",
        stdout: "",
        stderr: "",
        exitCode: 1,
      })
      expect(out).not.toBeNull()
      expect(out!.summary).toContain("sidecar: auth failed — 401")
      expect(out!.source).toBe("jiuwenclaw:history")
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("returns null when sessionId unknown and no stderr", async () => {
    const sandbox = freshSandbox("jiuwenclaw")
    try {
      const out = await diagnoseJiuwenclaw({
        sandboxRoot: sandbox,
        sessionId: undefined,
        stdout: "",
        stderr: "",
        exitCode: 1,
      })
      expect(out).toBeNull()
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})
