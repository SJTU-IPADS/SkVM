/**
 * Client for the SkVM proposals page. Ported from the former inline
 * template-string frontend (src/server/frontend.ts) — logic unchanged apart
 * from the auth-token plumbing on mutating requests.
 *
 * Data rows are deliberately any-typed: the payload shapes live server-side
 * (src/server/routes/proposals.ts) and are kept minimal; the client mirrors
 * them without duplicating the types.
 */

// ── auth token ─────────────────────────────────────────────────────
// `skvm ui` prints/opens a ?token=… URL; mutating routes require the token
// via the x-skvm-token header. Move it out of the address bar (and browser
// history) into sessionStorage on boot so refreshes keep working.
let token = ""
{
  const params = new URLSearchParams(location.search)
  const fromUrl = params.get("token")
  if (fromUrl) {
    token = fromUrl
    try { sessionStorage.setItem("skvm-token", fromUrl) } catch { /* storage may be blocked */ }
    params.delete("token")
    const qs = params.toString()
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : ""))
  } else {
    try { token = sessionStorage.getItem("skvm-token") ?? "" } catch { /* storage may be blocked */ }
  }
}

const state: {
  proposals: any[]
  filtered: any[]
  filters: { search: string; status: string; sort: string; sortDir: string; group: string; minDelta: number | null }
} = {
  proposals: [],
  filtered: [],
  filters: { search: "", status: "", sort: "delta", sortDir: "desc", group: "", minDelta: null },
}

function el(id: string): HTMLElement {
  const node = document.getElementById(id)
  if (!node) throw new Error("missing element #" + id)
  return node
}

function esc(s: unknown): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
  return String(s).replace(/[&<>"']/g, (c) => map[c] ?? c)
}
function fmt3(n: number | null | undefined): string { return n == null ? "—" : n.toFixed(3) }
function fmtDelta(d: number | null | undefined): string {
  if (d == null) return "—"
  const sign = d >= 0 ? "+" : ""
  return sign + d.toFixed(3)
}
function deltaClass(d: number | null | undefined): string {
  if (d == null) return "na"
  if (d >= 0.05) return "good"
  if (d <= -0.02) return "bad"
  return "flat"
}
function heatClass(d: number | null | undefined): string {
  if (d == null) return "heat-empty"
  if (d >= 0.05) return "heat-good"
  if (d <= -0.02) return "heat-bad"
  return "heat-flat"
}
function fmtUsd(n: number | null | undefined): string { return "$" + (n || 0).toFixed(2) }

// "primary" = test if the best round has a test score, else train.
// Test is the honest signal (held-out); train is what the optimizer saw.
function primaryKind(summary: any): string {
  if (summary.best && summary.best.testScore != null) return "test"
  return "train"
}
function primaryBest(summary: any): number | null {
  if (!summary.best) return null
  return summary.best.testScore != null ? summary.best.testScore : summary.best.trainScore
}
function primaryBaseline(summary: any): number | null {
  if (!summary.baseline) return null
  return summary.baseline.testScore != null ? summary.baseline.testScore : summary.baseline.trainScore
}
function primaryDelta(summary: any): number | null {
  if (summary.best && summary.best.testScore != null && summary.baseline && summary.baseline.testScore != null) {
    return summary.best.testScore - summary.baseline.testScore
  }
  return summary.trainDelta
}

function fmtTs(ts: string): string {
  // "20260415T041220Z" → "04-15 04:12"
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(ts)
  if (!m) return ts
  return m[2] + "-" + m[3] + " " + m[4] + ":" + m[5]
}

async function loadData(): Promise<any> {
  if ((window as any).__INITIAL_DATA) return (window as any).__INITIAL_DATA
  const res = await fetch("/api/proposals")
  if (!res.ok) throw new Error("GET /api/proposals failed: " + res.status)
  return await res.json()
}

// ── filter / sort ─────────────────────────────────────────────────
function applyFilters(): void {
  const f = state.filters
  let rows = state.proposals.slice()
  if (f.search) {
    const q = f.search.toLowerCase()
    rows = rows.filter((r) => {
      const h = (r.meta.harness + " " + r.meta.targetModel + " " + r.meta.skillName + " " + r.meta.status).toLowerCase()
      return h.includes(q)
    })
  }
  if (f.status) rows = rows.filter((r) => r.meta.status === f.status)
  if (f.minDelta != null) rows = rows.filter((r) => (r.summary.trainDelta ?? -Infinity) >= f.minDelta!)

  const dir = f.sortDir === "asc" ? 1 : -1
  const cmp = (a: any, b: any): number => {
    switch (f.sort) {
      case "status":  return a.meta.status.localeCompare(b.meta.status) * dir
      case "skill":   return a.meta.skillName.localeCompare(b.meta.skillName) * dir
      case "harness": return a.meta.harness.localeCompare(b.meta.harness) * dir
      case "model":   return a.meta.targetModel.localeCompare(b.meta.targetModel) * dir
      case "delta":   return ((primaryDelta(a.summary) ?? -Infinity) - (primaryDelta(b.summary) ?? -Infinity)) * dir
      case "score":   return ((primaryBest(a.summary) ?? -Infinity) - (primaryBest(b.summary) ?? -Infinity)) * dir
      case "best":    return (a.meta.bestRound - b.meta.bestRound) * dir
      case "ts":      return a.meta.timestamp.localeCompare(b.meta.timestamp) * dir
      case "cost":    return ((a.summary.totalCostUsd || 0) - (b.summary.totalCostUsd || 0)) * dir
      default:        return 0
    }
  }
  rows.sort(cmp)
  state.filtered = rows
}

// ── stat tiles + sidebar lists ───────────────────────────────────
function renderStats(): void {
  const N = state.proposals.length
  const deltas = state.proposals.map((p) => primaryDelta(p.summary)).filter((d): d is number => d != null)
  const avg = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null
  const wins = deltas.filter((d) => d >= 0.05).length
  const losses = deltas.filter((d) => d <= -0.02).length
  const skills = new Set(state.proposals.map((p) => p.meta.skillName)).size
  const models = new Set(state.proposals.map((p) => p.meta.targetModel)).size

  const avgCls = avg == null ? "" : (avg >= 0.05 ? "good" : avg <= -0.02 ? "bad" : "")
  const avgTxt = avg == null ? "—" : (avg >= 0 ? "+" : "") + avg.toFixed(3)

  const tiles = [
    { v: N, l: "proposals" },
    { v: skills, l: "skills" },
    { v: models, l: "target models" },
    { v: avgTxt, l: "avg Δ", cls: avgCls },
    { v: wins, l: "wins ≥ +0.05", cls: wins > 0 ? "good" : "" },
    { v: losses, l: "losses ≤ −0.02", cls: losses > 0 ? "bad" : "" },
  ]
  el("stats").innerHTML = tiles.map((t) =>
    '<div class="stat"><div class="stat-value ' + ((t as any).cls || "") + '">' + esc(String(t.v)) + '</div><div class="stat-label">' + esc(t.l) + '</div></div>'
  ).join("")

  const byH = new Map<string, number>()
  for (const p of state.proposals) byH.set(p.meta.harness, (byH.get(p.meta.harness) || 0) + 1)
  el("sb-harnesses").innerHTML = Array.from(byH.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => '<div class="sb-row"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>')
    .join("")

  const byM = new Map<string, number>()
  for (const p of state.proposals) byM.set(p.meta.targetModel, (byM.get(p.meta.targetModel) || 0) + 1)
  el("sb-models").innerHTML = Array.from(byM.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => '<div class="sb-row"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>')
    .join("")
}

// ── entries ──────────────────────────────────────────────────────
function renderEntries(): void {
  const tbody = el("entries")
  el("proposals-count").textContent =
    state.filtered.length + " of " + state.proposals.length

  if (state.filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="padding:32px;text-align:center;color:var(--fg-dim)">no matches</td></tr>'
    return
  }

  const f = state.filters
  const parts: string[] = []
  if (f.group) {
    const groups = new Map<string, any[]>()
    for (const r of state.filtered) {
      const key = f.group === "skill" ? r.meta.skillName : f.group === "harness" ? r.meta.harness : r.meta.targetModel
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(r)
    }
    for (const [name, items] of groups) {
      parts.push(
        '<tr class="group-header"><td colspan="9">' +
        '<span class="g-label">' + esc(name) + '</span>' +
        '<span class="g-count">' + items.length + ' proposals</span>' +
        '</td></tr>'
      )
      for (const r of items) parts.push(renderRow(r))
    }
  } else {
    for (const r of state.filtered) parts.push(renderRow(r))
  }
  tbody.innerHTML = parts.join("")
}

function renderRow(r: any): string {
  const kind = primaryKind(r.summary)
  const pDelta = primaryDelta(r.summary)
  const dCls = deltaClass(pDelta)
  const dTxt = fmtDelta(pDelta)
  const kindBadge = kind === "test"
    ? '<span class="c-kind kind-test" title="held-out test set">test</span>'
    : '<span class="c-kind kind-train" title="training set (optimizer-seen)">train</span>'
  const bestScore = primaryBest(r.summary)
  const baseScore = primaryBaseline(r.summary)
  const scoreCell = bestScore == null
    ? '<span class="c-score na">—</span>'
    : baseScore == null || baseScore === bestScore
      ? '<span class="c-score">' + fmt3(bestScore) + ' ' + kindBadge + '</span>'
      : '<span class="c-score"><span class="c-score-base">' + fmt3(baseScore) + '</span> <span class="c-score-arrow">→</span> ' + fmt3(bestScore) + ' ' + kindBadge + '</span>'
  const rid = encodeURIComponent(r.id)
  return (
    '<tr class="row" data-id="' + esc(r.id) + '" onclick="window.__toggle(this)">' +
      '<td><span class="c-status s-' + esc(r.meta.status) + '">' + esc(r.meta.status) + '</span></td>' +
      '<td><span class="c-skill">' + esc(r.meta.skillName) + '</span></td>' +
      '<td><span class="c-harness">' + esc(r.meta.harness) + '</span></td>' +
      '<td><span class="c-model">' + esc(r.meta.targetModel) + '</span></td>' +
      '<td class="num"><span class="c-delta ' + dCls + '">' + dTxt + '</span></td>' +
      '<td class="num">' + scoreCell + '</td>' +
      '<td class="num c-rounds">r-' + r.meta.bestRound + ' / ' + r.meta.roundCount + '</td>' +
      '<td class="num c-ts">' + esc(fmtTs(r.meta.timestamp)) + '</td>' +
      '<td class="num c-cost">' + fmtUsd(r.summary.totalCostUsd) + '</td>' +
    '</tr>' +
    '<tr class="detail-row" data-detail-for="' + esc(r.id) + '">' +
      '<td colspan="9"><div class="detail-box" data-lazy-id="' + rid + '"></div></td>' +
    '</tr>'
  )
}

function renderDetail(r: any): string {
  const s = r.summary
  const hasTest = s.rounds.some((x: any) => x.testScore != null)
  const roundsHead = hasTest
    ? '<tr><th>round</th><th class="num">train</th><th class="num">test</th><th class="num">Δ vs r-0</th><th class="num">pass</th><th class="num">cost</th><th>changed</th></tr>'
    : '<tr><th>round</th><th class="num">train</th><th class="num">Δ vs r-0</th><th class="num">pass</th><th class="num">cost</th><th>changed</th></tr>'

  const roundsRows = s.rounds.map((rd: any) => {
    const labelCls = rd.isBest ? "round-label best" : rd.isBaseline ? "round-label baseline" : "round-label"
    const labelTxt = "r-" + rd.round + (rd.isBest ? " (best)" : rd.isBaseline ? " (baseline)" : "")
    const delta = rd.isBaseline ? "—" : fmtDelta(rd.deltaVsBaseline)
    const dCls = rd.isBaseline ? "na" : deltaClass(rd.deltaVsBaseline)
    const files = rd.changedFiles.length
      ? '<span class="files">' + rd.changedFiles.map(esc).join(", ") + '</span>'
      : '<span class="files">—</span>'
    if (hasTest) {
      return '<tr>' +
        '<td><span class="' + labelCls + '">' + esc(labelTxt) + '</span></td>' +
        '<td class="num">' + fmt3(rd.trainScore) + '</td>' +
        '<td class="num">' + fmt3(rd.testScore) + '</td>' +
        '<td class="num"><span class="inner-delta ' + dCls + '">' + delta + '</span></td>' +
        '<td class="num">' + rd.trainPassed + '/' + rd.trainTotal + '</td>' +
        '<td class="num">' + fmtUsd(rd.costTotalUsd) + '</td>' +
        '<td>' + files + '</td></tr>'
    }
    return '<tr>' +
      '<td><span class="' + labelCls + '">' + esc(labelTxt) + '</span></td>' +
      '<td class="num">' + fmt3(rd.trainScore) + '</td>' +
      '<td class="num"><span class="inner-delta ' + dCls + '">' + delta + '</span></td>' +
      '<td class="num">' + rd.trainPassed + '/' + rd.trainTotal + '</td>' +
      '<td class="num">' + fmtUsd(rd.costTotalUsd) + '</td>' +
      '<td>' + files + '</td></tr>'
  }).join("")

  const perTaskRows = s.perTaskDeltas.length
    ? s.perTaskDeltas.map((d: any) =>
        '<tr>' +
          '<td>' + esc(d.taskId) + '</td>' +
          '<td class="num">' + fmt3(d.baseline) + '</td>' +
          '<td class="num">' + fmt3(d.best) + '</td>' +
          '<td class="num"><span class="inner-delta ' + deltaClass(d.delta) + '">' + fmtDelta(d.delta) + '</span></td>' +
        '</tr>'
      ).join("")
    : '<tr><td colspan="4" class="dim">no per-task data</td></tr>'

  const rootCause = s.bestRoundRootCause
    ? '<p class="root-cause">' + esc(s.bestRoundRootCause) + '</p>'
    : '<p class="dim">no root-cause narrative (best round is baseline or optimizer abstained)</p>'

  const spark = renderSparkline(s.rounds)
  const roundOpts = s.rounds
    .filter((x: any) => !x.isBaseline)
    .map((x: any) => '<option value="' + x.round + '"' + (x.isBest ? ' selected' : '') + '>round ' + x.round + (x.isBest ? ' (best)' : '') + '</option>')
    .join("")
  const roundSelect = roundOpts ? '<select class="round-select" onclick="event.stopPropagation()">' + roundOpts + '</select>' : ''

  const isTerminal = r.meta.status === "accepted" || r.meta.status === "rejected"
  const acceptBtn = isTerminal
    ? '<button class="accept" disabled>' + (r.meta.status === "accepted" ? "accepted r-" + r.meta.acceptedRound : "accept") + '</button>'
    : '<button class="accept" onclick="event.stopPropagation();window.__accept(this,\'' + encodeURIComponent(r.id) + '\')">Accept</button>'
  const rejectBtn = isTerminal
    ? '<button class="reject" disabled>' + (r.meta.status === "rejected" ? "rejected" : "reject") + '</button>'
    : '<button class="reject" onclick="event.stopPropagation();window.__reject(this,\'' + encodeURIComponent(r.id) + '\')">Reject</button>'

  return (
    '<div class="detail-grid">' +
      '<div>' +
        '<div class="d-section"><h4>rounds</h4>' +
          '<table class="inner">' + roundsHead + roundsRows + '</table>' +
        '</div>' +
        '<div class="d-section"><h4>per-task at best round</h4>' +
          '<table class="inner"><tr><th>task</th><th class="num">baseline</th><th class="num">best</th><th class="num">Δ</th></tr>' + perTaskRows + '</table>' +
        '</div>' +
        '<div class="d-section"><h4>root cause (best round)</h4>' + rootCause + '</div>' +
      '</div>' +
      '<div class="detail-side">' +
        '<div class="d-section"><h4>score by round</h4>' +
          '<div class="spark-box"><div class="spark">' + spark + '</div></div>' +
        '</div>' +
        '<div class="d-section"><h4>metadata</h4>' +
          '<dl class="meta">' +
            '<dt>optimizer</dt><dd>' + esc(r.meta.optimizerModel) + '</dd>' +
            '<dt>source</dt><dd>' + esc(r.meta.source) + '</dd>' +
            '<dt>reason</dt><dd style="font-family:inherit">' + esc(r.meta.bestRoundReason || "—") + '</dd>' +
            '<dt>id</dt><dd>' + esc(r.id) + '</dd>' +
          '</dl>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="d-section"><h4>changes</h4>' +
      '<div class="diff-wrap">' +
        '<button class="diff-toggle" onclick="event.stopPropagation();window.__loadDiff(this, \'' + encodeURIComponent(r.id) + '\', ' + r.meta.bestRound + ')">Show diff (original → round ' + r.meta.bestRound + ')</button>' +
        '<div class="diff-body" style="display:none"></div>' +
      '</div>' +
    '</div>' +
    '<div class="actions">' + acceptBtn + rejectBtn + roundSelect + '</div>'
  )
}

function renderSparkline(rounds: any[]): string {
  const pts = rounds.map((r) => ({ r: r.round as number, s: r.trainScore as number | null })).filter((p): p is { r: number; s: number } => p.s != null)
  if (pts.length < 2) return '<div class="dim" style="font-size:11px">(insufficient scored rounds)</div>'
  const W = 240, H = 72, pad = 10
  const minS = Math.min.apply(null, pts.map((p) => p.s))
  const maxS = Math.max.apply(null, pts.map((p) => p.s))
  const rangeS = (maxS - minS) || 0.001
  const minR = pts[0]!.r, maxR = pts[pts.length - 1]!.r
  const rangeR = (maxR - minR) || 1
  const xy = pts.map((p) => ({
    x: pad + ((p.r - minR) / rangeR) * (W - 2 * pad),
    y: H - pad - ((p.s - minS) / rangeS) * (H - 2 * pad),
    s: p.s, r: p.r,
  }))
  const d = xy.map((p, i) => (i === 0 ? "M" : "L") + p.x.toFixed(1) + "," + p.y.toFixed(1)).join(" ")
  const dots = xy.map((p) => '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="2.5"><title>r-' + p.r + ': ' + p.s.toFixed(3) + '</title></circle>').join("")
  const bY = H - pad - ((pts[0]!.s - minS) / rangeS) * (H - 2 * pad)
  const baselineLine = '<line class="baseline-line" x1="' + pad + '" x2="' + (W - pad) + '" y1="' + bY.toFixed(1) + '" y2="' + bY.toFixed(1) + '"/>'
  return '<svg viewBox="0 0 ' + W + ' ' + H + '">' + baselineLine + '<path d="' + d + '"/>' + dots + '</svg>'
}

function colorDiff(raw: string): string {
  const lines = raw.split("\n")
  return lines.map((line) => {
    let cls = ""
    if (line.startsWith("+++") || line.startsWith("---")) cls = "d-file"
    else if (line.startsWith("@@")) cls = "d-hunk"
    else if (line.startsWith("diff --git")) cls = "d-githeader"
    else if (line.startsWith("+")) cls = "d-add"
    else if (line.startsWith("-")) cls = "d-del"
    return '<span class="' + cls + '">' + esc(line || " ") + '</span>'
  }).join("")
}

// ── heatmaps ─────────────────────────────────────────────────────
function renderHeatmaps(): void {
  renderHeatmap("heat-skill", "skill", "model")
  renderHeatmap("heat-model", "model", "skill")
}
function renderHeatmap(elId: string, rowBy: string, colBy: string): void {
  const rowKeys = Array.from(new Set(state.proposals.map((p) => rowBy === "skill" ? p.meta.skillName : p.meta.targetModel))).sort()
  const colKeys = Array.from(new Set(state.proposals.map((p) => colBy === "skill" ? p.meta.skillName : p.meta.targetModel))).sort()
  const bucket = new Map<string, number[]>()
  for (const p of state.proposals) {
    const rk = rowBy === "skill" ? p.meta.skillName : p.meta.targetModel
    const ck = colBy === "skill" ? p.meta.skillName : p.meta.targetModel
    const d = primaryDelta(p.summary)
    if (d == null) continue
    const key = rk + "||" + ck
    const arr = bucket.get(key) || []
    arr.push(d)
    bucket.set(key, arr)
  }
  const header = '<tr><th class="row-head">' + esc(rowBy) + '</th>' +
    colKeys.map((c) => '<th>' + esc(c) + '</th>').join("") + '</tr>'
  const body = rowKeys.map((rk) => {
    const cells = colKeys.map((ck) => {
      const arr = bucket.get(rk + "||" + ck)
      if (!arr || arr.length === 0) return '<td class="heat-empty">·</td>'
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length
      return '<td class="' + heatClass(avg) + '" title="' + arr.length + ' proposal(s), avg ' + fmtDelta(avg) + '">' + fmtDelta(avg) + '</td>'
    }).join("")
    return '<tr><th class="row-head">' + esc(rk) + '</th>' + cells + '</tr>'
  }).join("")
  el(elId).innerHTML = '<table class="heat">' + header + body + '</table>'
}

function populateStatusOptions(): void {
  const statuses = Array.from(new Set(state.proposals.map((p) => p.meta.status))).sort()
  const sel = el("f-status")
  for (const s of statuses) {
    const opt = document.createElement("option")
    opt.value = s
    opt.textContent = s
    sel.appendChild(opt)
  }
}

// ── interactions ─────────────────────────────────────────────────
;(window as any).__toggle = function (row: HTMLElement): void {
  const id = row.dataset["id"]!
  row.classList.toggle("open")
  const detail = document.querySelector('tr.detail-row[data-detail-for="' + CSS.escape(id) + '"]')
  if (!detail) return
  const box = detail.querySelector(".detail-box") as HTMLElement
  if (!box.dataset["rendered"]) {
    const r = state.proposals.find((p) => p.id === id)
    if (r) {
      box.innerHTML = renderDetail(r)
      box.dataset["rendered"] = "1"
    }
  }
  detail.classList.toggle("open")
}

;(window as any).__loadDiff = async function (btn: HTMLElement, encodedId: string, round: number): Promise<void> {
  const id = decodeURIComponent(encodedId)
  const wrap = btn.parentElement!
  const body = wrap.querySelector(".diff-body") as HTMLElement
  if (body.style.display === "block") {
    body.style.display = "none"
    btn.textContent = "Show diff (original → round " + round + ")"
    return
  }
  body.style.display = "block"
  body.innerHTML = '<div class="loading">loading diff…</div>'
  btn.textContent = "Hide diff"
  try {
    const res = await fetch("/api/proposal/diff?id=" + encodeURIComponent(id) + "&round=" + round)
    const data: any = await res.json()
    if (data.ok === false) {
      body.innerHTML = '<div class="empty">' + esc(data.reason || "diff unavailable") + '</div>'
      return
    }
    if (!data.unified || data.unified.trim() === "") {
      body.innerHTML = '<div class="empty">' + esc(data.note || "(no changes)") + '</div>'
      return
    }
    body.innerHTML = '<pre>' + colorDiff(data.unified) + '</pre>'
  } catch (err: any) {
    body.innerHTML = '<div class="empty">failed: ' + esc(err.message) + '</div>'
  }
}

;(window as any).__accept = async function (btn: HTMLButtonElement, encodedId: string): Promise<void> {
  const id = decodeURIComponent(encodedId)
  const actions = btn.closest(".actions")!
  const select = actions.querySelector(".round-select") as HTMLSelectElement | null
  const round = select ? parseInt(select.value, 10) : undefined
  const roundLabel = round != null ? "round " + round : "best round"
  if (!confirm("Deploy " + roundLabel + " of this proposal?\n\n" + id + "\n\nThis will copy files into the live skill directory (with .bak backups of anything overwritten).")) {
    return
  }
  btn.disabled = true
  btn.textContent = "deploying…"
  try {
    const res = await fetch("/api/proposal/accept", {
      method: "POST",
      headers: { "content-type": "application/json", "x-skvm-token": token },
      body: JSON.stringify({ id, round }),
    })
    const data: any = await res.json()
    if (!data.ok) throw new Error(data.error || "accept failed")
    toast("good", "accepted " + id.split("/").pop() + " · deployed " + data.filesDeployed.length + " file(s)")
    const target = state.proposals.find((p) => p.id === id)
    if (target) target.meta = data.meta
    // Re-render: wipe lazy-rendered cache for this id so detail re-renders with new meta
    const detail = document.querySelector('tr.detail-row[data-detail-for="' + CSS.escape(id) + '"] .detail-box') as HTMLElement | null
    if (detail) detail.dataset["rendered"] = ""
    applyFilters()
    renderEntries()
    renderStats()
  } catch (err: any) {
    toast("error", err.message)
    btn.disabled = false
    btn.textContent = "Accept"
  }
}

;(window as any).__reject = async function (btn: HTMLButtonElement, encodedId: string): Promise<void> {
  const id = decodeURIComponent(encodedId)
  if (!confirm("Reject this proposal?\n\n" + id)) return
  btn.disabled = true
  btn.textContent = "rejecting…"
  try {
    const res = await fetch("/api/proposal/reject", {
      method: "POST",
      headers: { "content-type": "application/json", "x-skvm-token": token },
      body: JSON.stringify({ id }),
    })
    const data: any = await res.json()
    if (!data.ok) throw new Error(data.error || "reject failed")
    toast("good", "rejected " + id.split("/").pop())
    const target = state.proposals.find((p) => p.id === id)
    if (target) target.meta = data.meta
    const detail = document.querySelector('tr.detail-row[data-detail-for="' + CSS.escape(id) + '"] .detail-box') as HTMLElement | null
    if (detail) detail.dataset["rendered"] = ""
    applyFilters()
    renderEntries()
    renderStats()
  } catch (err: any) {
    toast("error", err.message)
    btn.disabled = false
    btn.textContent = "Reject"
  }
}

function toast(kind: string, msg: string): void {
  const t = document.createElement("div")
  t.className = "toast " + (kind || "")
  t.textContent = msg
  document.body.appendChild(t)
  setTimeout(() => t.remove(), 2800)
}

// ── header sort click handling ───────────────────────────────────
function wireHeaderSorts(): void {
  const headers = document.querySelectorAll<HTMLElement>("table.ptable thead th[data-sort]")
  headers.forEach((h) => {
    h.addEventListener("click", () => {
      const key = h.dataset["sort"]!
      if (state.filters.sort === key) {
        state.filters.sortDir = state.filters.sortDir === "asc" ? "desc" : "asc"
      } else {
        state.filters.sort = key
        state.filters.sortDir = "desc"
      }
      headers.forEach((x) => x.classList.remove("sort-asc", "sort-desc"))
      h.classList.add(state.filters.sortDir === "asc" ? "sort-asc" : "sort-desc")
      applyFilters()
      renderEntries()
    })
  })
}

function wireControls(): void {
  el("f-search").addEventListener("input", (e) => {
    state.filters.search = (e.target as HTMLInputElement).value.trim()
    applyFilters(); renderEntries()
  })
  el("f-status").addEventListener("change", (e) => {
    state.filters.status = (e.target as HTMLSelectElement).value
    applyFilters(); renderEntries()
  })
  el("f-group").addEventListener("change", (e) => {
    state.filters.group = (e.target as HTMLSelectElement).value
    applyFilters(); renderEntries()
  })
  el("f-mindelta").addEventListener("input", (e) => {
    const v = parseFloat((e.target as HTMLInputElement).value)
    state.filters.minDelta = Number.isNaN(v) ? null : v
    applyFilters(); renderEntries()
  })
}

// ── boot ─────────────────────────────────────────────────────────
;(async function boot() {
  el("gen-date").textContent =
    new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC"
  try {
    const data = await loadData()
    state.proposals = data.proposals || []
    applyFilters()
    populateStatusOptions()
    renderStats()
    renderEntries()
    renderHeatmaps()
    wireHeaderSorts()
    wireControls()
  } catch (err: any) {
    el("entries").innerHTML =
      '<tr><td colspan="9" style="padding:32px;text-align:center;color:var(--bad)">Error: ' + esc(err.message) + '</td></tr>'
  }
})()
