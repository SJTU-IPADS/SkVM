/**
 * Local HTTP server for the SkVM web UI (`skvm ui`; `skvm proposals serve`
 * is a deprecated alias).
 *
 * Server core only: startServer(), the route dispatcher, and the auth
 * guards. Domain routes live in ./routes/ modules, each exporting a
 * RouteTable that is merged into the dispatch table here. The frontend
 * shell is an HTML import served through Bun's static `routes` option,
 * which bundles ./frontend/{index.html,app.ts,style.css} — on the fly under
 * `bun run`, embedded into the binary under `bun build --compile`.
 *
 * Security model: bound to 127.0.0.1 by default, but a localhost bind alone
 * does not stop a hostile web page from firing cross-origin POSTs at the
 * port (CSRF), nor DNS rebinding from re-pointing an attacker hostname at
 * it. Two guards close those on every /api request:
 *
 *   - the Host header must name an allowed host (kills DNS rebinding);
 *   - mutating (non-GET/HEAD) requests must present the per-process token
 *     via the x-skvm-token header (kills CSRF — a cross-origin page cannot
 *     read the token). The token is generated at startup and embedded in
 *     the URL the CLI prints and opens; the client moves it into
 *     sessionStorage on boot.
 *
 * The "/" shell bypasses the guards (Bun's route table serves it before
 * fetch runs) — acceptable because it contains no data; everything
 * sensitive flows through /api/*.
 */

import indexHtml from "./frontend/index.html"
import runsHtml from "./frontend/runs.html"
import { json, bad, type RouteTable } from "./http.ts"
import { proposalRoutes } from "./routes/proposals.ts"
import { sessionRoutes } from "./routes/sessions.ts"
import { createLogger } from "../core/logger.ts"

const log = createLogger("server")

export interface ServeOptions {
  port: number
  host: string
  /** Auth token for mutating routes. Generated when omitted; tests inject a known one. */
  token?: string
}

const routes: RouteTable = {
  "GET /api/health": () => json({ ok: true }),
  ...proposalRoutes,
  ...sessionRoutes,
}

/**
 * Host-header allowlist. The port is stripped before comparison; loopback
 * names are always allowed alongside the bound host, so a custom
 * `--host=<lan-ip>` bind still accepts local requests.
 */
function hostAllowed(req: Request, boundHost: string): boolean {
  const raw = req.headers.get("host") ?? ""
  // IPv6 authorities keep their brackets ("[::1]:7878" → "[::1]").
  const hostname = raw.startsWith("[") ? raw.replace(/\]:\d+$/, "]") : raw.replace(/:\d+$/, "")
  return hostname === boundHost || hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]"
}

function makeRouter(guard: { host: string; token: string }) {
  return async function route(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (!hostAllowed(req, guard.host)) return bad(403, "forbidden host")
    if (req.method !== "GET" && req.method !== "HEAD") {
      // Plain string compare: the token is a 122-bit random UUID and the
      // attacker model is a cross-origin page that cannot read responses,
      // let alone time localhost string comparisons char-by-char.
      if (req.headers.get("x-skvm-token") !== guard.token) return bad(401, "missing or invalid token")
    }
    const handler = routes[`${req.method} ${url.pathname}`]
    if (!handler) return new Response("Not found", { status: 404 })
    try {
      return await handler(req, url)
    } catch (err) {
      log.error(`${req.method} ${url.pathname} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
      return bad(500, err instanceof Error ? err.message : String(err))
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export interface RunningServer {
  url: string
  token: string
  /** url + ?token=… — what the CLI prints and opens; the client stores the token and strips it from the address bar. */
  tokenUrl: string
  stop: () => void
}

export function startServer(opts: ServeOptions): RunningServer {
  const token = opts.token ?? crypto.randomUUID()
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.host,
    development: false,
    routes: { "/": indexHtml, "/runs": runsHtml },
    fetch: makeRouter({ host: opts.host, token }),
  })
  const url = `http://${opts.host}:${server.port}`
  log.info(`Listening on ${url}`)
  return {
    url,
    token,
    tokenUrl: `${url}/?token=${token}`,
    stop: () => server.stop(),
  }
}
