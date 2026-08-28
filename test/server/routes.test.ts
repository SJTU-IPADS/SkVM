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
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { startServer, type RunningServer } from "../../src/server/index.ts"
import { createProposal } from "../../src/proposals/storage.ts"

const TOKEN = "test-token"
let server: RunningServer

beforeAll(() => {
  server = startServer({ port: 0, host: "127.0.0.1", token: TOKEN })
})

afterAll(() => {
  server.stop()
})

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
