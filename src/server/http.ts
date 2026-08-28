/**
 * Shared HTTP plumbing for the local review server: response helpers and the
 * route-table types every route module builds against.
 *
 * A RouteTable maps "<METHOD> <pathname>" (exact match, no patterns) to a
 * handler. Handlers may throw — the dispatcher in index.ts converts uncaught
 * errors into a logged 500 JSON response.
 */

export type RouteHandler = (req: Request, url: URL) => Response | Promise<Response>

export type RouteTable = Record<string, RouteHandler>

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers ?? {}),
    },
  })
}

export function bad(status: number, message: string): Response {
  return json({ ok: false, error: message }, { status })
}
