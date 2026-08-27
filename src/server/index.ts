/**
 * Local HTTP server for the SkVM review UI (`skvm proposals serve`).
 *
 * Server core only: startServer(), the route dispatcher, and the frontend
 * shell route. Domain routes live in ./routes/ modules, each exporting a
 * RouteTable that is merged into the dispatch table here.
 *
 * Bound to 127.0.0.1 by default — accept/reject mutate files on disk, so we
 * don't want this on an external interface without auth.
 */

import { renderFrontend } from "./frontend.ts"
import { json, bad, html, type RouteTable } from "./http.ts"
import { proposalRoutes } from "./routes/proposals.ts"
import { createLogger } from "../core/logger.ts"

const log = createLogger("server")

export interface ServeOptions {
  port: number
  host: string
}

const routes: RouteTable = {
  "GET /": () => html(renderFrontend()),
  "GET /api/health": () => json({ ok: true }),
  ...proposalRoutes,
}

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const handler = routes[`${req.method} ${url.pathname}`]
  if (!handler) return new Response("Not found", { status: 404 })
  try {
    return await handler(req, url)
  } catch (err) {
    log.error(`${req.method} ${url.pathname} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
    return bad(500, err instanceof Error ? err.message : String(err))
  }
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export interface RunningServer {
  url: string
  stop: () => void
}

export function startServer(opts: ServeOptions): RunningServer {
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.host,
    fetch: route,
  })
  const url = `http://${opts.host}:${server.port}`
  log.info(`Listening on ${url}`)
  return {
    url,
    stop: () => server.stop(),
  }
}
