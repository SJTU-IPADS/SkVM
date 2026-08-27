/**
 * Proposal-review routes — the JSON API behind `skvm proposals serve`.
 * Wraps the same storage helpers the CLI uses.
 *
 * Routes:
 *   GET  /api/proposals             → all proposals with derived summary
 *   GET  /api/proposal/diff?id=&round=
 *   POST /api/proposal/accept       body: {id, round?}
 *   POST /api/proposal/reject       body: {id}
 */

import { listProposals, loadProposal, updateStatus, proposalDirFromId } from "../../proposals/storage.ts"
import { summarizeProposal } from "../../proposals/summary.ts"
import { diffProposalRound } from "../../proposals/diff.ts"
import { deployProposal } from "../../proposals/deploy.ts"
import { json, bad, type RouteTable } from "../http.ts"

// ---------------------------------------------------------------------------
// Payload shapes — kept minimal, client mirrors these with any-typed access.
// ---------------------------------------------------------------------------

async function buildProposalsPayload() {
  const items = await listProposals({})
  const loaded = await Promise.all(items.map((s) => loadProposal(s.id)))
  return {
    proposals: loaded.map((p) => ({
      id: p.id,
      meta: p.meta,
      summary: summarizeProposal(p),
    })),
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleGetProposals(): Promise<Response> {
  const payload = await buildProposalsPayload()
  return json(payload)
}

async function handleGetDiff(_req: Request, url: URL): Promise<Response> {
  const id = url.searchParams.get("id")
  const roundParam = url.searchParams.get("round")
  if (!id) return bad(400, "missing id")
  if (!roundParam) return bad(400, "missing round")
  const round = parseInt(roundParam, 10)
  if (Number.isNaN(round)) return bad(400, "round must be integer")
  if (round === 0) return json({ ok: true, unified: "", note: "baseline — no diff" })
  const result = await diffProposalRound(proposalDirFromId(id), round)
  if (!result.ok) return json({ ok: false, reason: result.reason }, { status: 200 })
  return json({ ok: true, unified: result.unified })
}

async function handlePostAccept(req: Request): Promise<Response> {
  let body: { id?: string; round?: number }
  try {
    body = (await req.json()) as { id?: string; round?: number }
  } catch {
    return bad(400, "body must be JSON")
  }
  if (!body.id) return bad(400, "missing id")
  try {
    const result = await deployProposal(body.id, { round: body.round })
    // After accept, return the fresh meta for the client to update its row.
    const updated = await loadProposal(body.id)
    return json({
      ok: true,
      deployedRound: result.deployedRound,
      filesDeployed: result.filesDeployed,
      filesBackedUp: result.filesBackedUp,
      meta: updated.meta,
    })
  } catch (err) {
    return bad(500, err instanceof Error ? err.message : String(err))
  }
}

async function handlePostReject(req: Request): Promise<Response> {
  let body: { id?: string }
  try {
    body = (await req.json()) as { id?: string }
  } catch {
    return bad(400, "body must be JSON")
  }
  if (!body.id) return bad(400, "missing id")
  try {
    await updateStatus(body.id, "rejected")
    const updated = await loadProposal(body.id)
    return json({ ok: true, meta: updated.meta })
  } catch (err) {
    return bad(500, err instanceof Error ? err.message : String(err))
  }
}

export const proposalRoutes: RouteTable = {
  "GET /api/proposals": handleGetProposals,
  "GET /api/proposal/diff": handleGetDiff,
  "POST /api/proposal/accept": handlePostAccept,
  "POST /api/proposal/reject": handlePostReject,
}
