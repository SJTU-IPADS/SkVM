/**
 * Profile routes — read-only views over the TCP cache (~/.skvm/profiles/),
 * wrapping the same cache helpers the profiler and compiler use.
 *
 * Routes:
 *   GET /api/profiles                    → all cached profiles (model, harness, profiledAt)
 *   GET /api/profile?model=&harness=     → full TCP JSON, partials included
 */

import { listProfiles, loadProfileAny } from "../../profiler/cache.ts"
import { json, bad, type RouteTable } from "../http.ts"

async function handleGetProfiles(): Promise<Response> {
  return json({ profiles: await listProfiles() })
}

async function handleGetProfile(_req: Request, url: URL): Promise<Response> {
  const model = url.searchParams.get("model")
  const harness = url.searchParams.get("harness")
  if (!model) return bad(400, "missing model")
  if (!harness) return bad(400, "missing harness")
  const tcp = await loadProfileAny(model, harness)
  if (!tcp) return bad(404, "no profile for this model/harness pair")
  return json({ profile: tcp })
}

export const profileRoutes: RouteTable = {
  "GET /api/profiles": handleGetProfiles,
  "GET /api/profile": handleGetProfile,
}
