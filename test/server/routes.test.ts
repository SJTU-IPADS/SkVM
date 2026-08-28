/**
 * Route-level tests for the review server (src/server/).
 *
 * Exercises the dispatcher and error paths over real HTTP against the
 * hermetic temp cache the bunfig preload provides. That cache — and the
 * proposals root inside it — is shared by every test file in the worker,
 * and Bun's file execution order is arbitrary, so nothing here may assume
 * the proposals list is empty: the list test seeds its own proposal and
 * finds it by id instead.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import path from "node:path"
import os from "node:os"
import { mkdtemp, rm, mkdir, writeFile, unlink } from "node:fs/promises"
import { startServer, type RunningServer } from "../../src/server/index.ts"
import { createProposal } from "../../src/proposals/storage.ts"
import { RunSession } from "../../src/core/run-session.ts"
import { SKVM_CACHE, SESSIONS_INDEX_PATH } from "../../src/core/config.ts"

const TOKEN = "test-token"
let server: RunningServer
// Session tests append to the worker-shared sessions.jsonl; snapshot and
// restore it so files that assert on an empty index (test/cli/logs.test.ts)
// stay order-independent.
let priorIndex: string | null = null

beforeAll(async () => {
  priorIndex = await Bun.file(SESSIONS_INDEX_PATH).text().catch(() => null)
  server = startServer({ port: 0, host: "127.0.0.1", token: TOKEN })
})

afterAll(async () => {
  server.stop()
  if (priorIndex === null) await unlink(SESSIONS_INDEX_PATH).catch(() => {})
  else await Bun.write(SESSIONS_INDEX_PATH, priorIndex)
})

/** Read an SSE body until `until(buffer)` or the deadline, then cancel. */
async function readSse(res: Response, until: (buf: string) => boolean, timeoutMs = 5000): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline && !until(buf)) {
      const timer = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), Math.max(1, deadline - Date.now())))
      const result = await Promise.race([reader.read(), timer])
      if (result === "timeout") break
      if (result.done) break
      buf += decoder.decode(result.value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => { /* stream already closed */ })
  }
  return buf
}

describe("proposals serve routes", () => {
  test("GET /api/health responds ok", async () => {
    const res = await fetch(`${server.url}/api/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test("GET / serves the HTML shell", async () => {
    const res = await fetch(`${server.url}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toStartWith("text/html")
    expect(await res.text()).toContain("<!DOCTYPE html>")
  })

  test("GET /api/proposals returns a seeded proposal with its summary", async () => {
    const skillDir = await mkdtemp(path.join(os.tmpdir(), "skvm-server-routes-skill-"))
    await writeFile(path.join(skillDir, "SKILL.md"), "# server-routes-probe\n\nfake skill body\n")
    const created = await createProposal({
      skillName: "server-routes-probe",
      skillDir,
      harness: "bare-agent",
      optimizerModel: "anthropic/claude-sonnet-4.6",
      targetModel: "openrouter/qwen/qwen3-30b",
      source: "synthetic",
    })
    try {
      const res = await fetch(`${server.url}/api/proposals`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        proposals: Array<{ id: string; meta: { skillName: string }; summary: unknown }>
      }
      const mine = body.proposals.find((p) => p.id === created.id)
      expect(mine).toBeDefined()
      expect(mine!.meta.skillName).toBe("server-routes-probe")
      expect(mine!.summary).toBeDefined()
    } finally {
      await rm(created.dir, { recursive: true, force: true })
      await rm(skillDir, { recursive: true, force: true })
    }
  })

  test("GET /api/proposal/diff without params is a 400", async () => {
    const res = await fetch(`${server.url}/api/proposal/diff`)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(false)
  })

  test("POST /api/proposal/accept without id is a 400", async () => {
    const res = await fetch(`${server.url}/api/proposal/accept`, {
      method: "POST",
      headers: { "x-skvm-token": TOKEN },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  test("POST /api/proposal/reject with a non-JSON body is a 400", async () => {
    const res = await fetch(`${server.url}/api/proposal/reject`, {
      method: "POST",
      headers: { "x-skvm-token": TOKEN },
      body: "not json",
    })
    expect(res.status).toBe(400)
  })

  test("POST without a token is a 401 before the handler runs", async () => {
    const res = await fetch(`${server.url}/api/proposal/reject`, {
      method: "POST",
      body: JSON.stringify({ id: "x" }),
    })
    expect(res.status).toBe(401)
  })

  test("POST with a wrong token is a 401", async () => {
    const res = await fetch(`${server.url}/api/proposal/reject`, {
      method: "POST",
      headers: { "x-skvm-token": "wrong" },
      body: JSON.stringify({ id: "x" }),
    })
    expect(res.status).toBe(401)
  })

  test("a non-local Host header is a 403 (DNS-rebinding guard)", async () => {
    const res = await fetch(`${server.url}/api/health`, {
      headers: { host: "evil.example.com" },
    })
    expect(res.status).toBe(403)
  })

  test("a local Host header with a port passes the guard", async () => {
    const res = await fetch(`${server.url}/api/health`, {
      headers: { host: "localhost:9999" },
    })
    expect(res.status).toBe(200)
  })

  test("unknown path is a 404", async () => {
    const res = await fetch(`${server.url}/api/nope`)
    expect(res.status).toBe(404)
  })

  test("wrong method on a known path is a 404", async () => {
    // Token included so the request clears the auth guard and the 404
    // genuinely comes from the dispatcher's table miss.
    const res = await fetch(`${server.url}/api/proposals`, {
      method: "POST",
      headers: { "x-skvm-token": TOKEN },
    })
    expect(res.status).toBe(404)
  })
})

describe("session routes", () => {
  test("GET /runs serves the runs page shell", async () => {
    const res = await fetch(`${server.url}/runs`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toStartWith("text/html")
    expect(await res.text()).toContain("SkVM Runs")
  })

  test("GET /api/sessions includes a seeded session with liveness applied", async () => {
    const logDir = path.join(SKVM_CACHE, "log", "bench", "server-routes-session")
    const { id } = await RunSession.start({
      type: "bench",
      tag: "server-routes-session",
      logDir,
      harness: "bare-agent",
      models: ["test/model"],
    })
    const res = await fetch(`${server.url}/api/sessions`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sessions: Array<{ id: string; pid?: number; effectiveStatus: string }> }
    const mine = body.sessions.find((s) => s.id === id)
    expect(mine).toBeDefined()
    expect(mine!.pid).toBe(process.pid)
    expect(mine!.effectiveStatus).toBe("running") // this test process is alive
  })

  test("GET /api/sessions rejects a non-integer limit", async () => {
    const res = await fetch(`${server.url}/api/sessions?limit=abc`)
    expect(res.status).toBe(400)
  })

  test("files listing + SSE tail over a real logDir", async () => {
    const logDir = path.join(SKVM_CACHE, "log", "run", "server-routes-tail")
    await mkdir(logDir, { recursive: true })
    await writeFile(path.join(logDir, "run.log"), "hello from the log\n")
    const { id } = await RunSession.start({ type: "run", tag: "server-routes-tail", logDir })

    const filesRes = await fetch(`${server.url}/api/session/files?id=${encodeURIComponent(id)}`)
    expect(filesRes.status).toBe(200)
    const files = (await filesRes.json()) as { files: Array<{ path: string }> }
    expect(files.files.map((f) => f.path)).toContain("run.log")

    const tailRes = await fetch(`${server.url}/api/session/tail?id=${encodeURIComponent(id)}&file=run.log`)
    expect(tailRes.status).toBe(200)
    expect(tailRes.headers.get("content-type")).toStartWith("text/event-stream")
    const buf = await readSse(tailRes, (b) => b.includes("hello from the log"))
    expect(buf).toContain("event: chunk")
    expect(buf).toContain("hello from the log")
  })

  test("tail rejects a path escaping the log dir", async () => {
    const logDir = path.join(SKVM_CACHE, "log", "run", "server-routes-guard")
    await mkdir(logDir, { recursive: true })
    const { id } = await RunSession.start({ type: "run", tag: "server-routes-guard", logDir })
    const res = await fetch(`${server.url}/api/session/tail?id=${encodeURIComponent(id)}&file=../../../../etc/passwd`)
    expect(res.status).toBe(400)
  })

  test("files for an unknown session id is a 404", async () => {
    const res = await fetch(`${server.url}/api/session/files?id=nope`)
    expect(res.status).toBe(404)
  })
})
