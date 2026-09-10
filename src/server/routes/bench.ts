/**
 * Bench routes — read-only views over bench result artifacts. A bench
 * session's logDir carries `report.json` (a BenchReport, or a multi-model
 * report with a `reports` array); this passes it through for the bench
 * page to render. The session list itself comes from /api/sessions.
 *
 * Routes:
 *   GET /api/bench/report?id=<sessionId>   → report.json content
 */

import path from "node:path"
import { readSessions, resolveLogDir } from "../../core/run-session.ts"
import { json, bad, type RouteTable } from "../http.ts"

async function handleGetBenchReport(_req: Request, url: URL): Promise<Response> {
  const id = url.searchParams.get("id")
  if (!id) return bad(400, "missing id")
  const entry = (await readSessions()).find((e) => e.id === id)
  if (!entry) return bad(404, "unknown session id")
  const reportFile = Bun.file(path.join(resolveLogDir(entry), "report.json"))
  if (!(await reportFile.exists())) return bad(404, "no report.json for this session (run still in progress, or it predates reports)")
  try {
    return json({ id, report: await reportFile.json() })
  } catch {
    return bad(500, "report.json is not valid JSON")
  }
}

export const benchRoutes: RouteTable = {
  "GET /api/bench/report": handleGetBenchReport,
}
