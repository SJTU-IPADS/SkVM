/**
 * Client for the SkVM profiles page: the TCP cache listed, with per-primitive
 * capability detail on expand. Follows the runs page's conventions.
 */

const state: { profiles: any[] } = { profiles: [] }

function el(id: string): HTMLElement {
  const node = document.getElementById(id)
  if (!node) throw new Error("missing element #" + id)
  return node
}

function esc(s: unknown): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
  return String(s).replace(/[&<>"']/g, (c) => map[c] ?? c)
}

function fmtTs(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso)
  if (!m) return iso
  return m[1] + "-" + m[2] + "-" + m[3] + " " + m[4] + ":" + m[5]
}

function levelBadge(level: string): string {
  return '<span class="lv lv-' + esc(level) + '">' + esc(level) + '</span>'
}

function renderEntries(): void {
  el("profiles-count").textContent = String(state.profiles.length)
  const tbody = el("entries")
  if (state.profiles.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" style="padding:32px;text-align:center;color:var(--fg-dim)">no profiles cached — run `skvm profile` first</td></tr>'
    return
  }
  tbody.innerHTML = state.profiles.map((p, i) =>
    '<tr class="row" data-idx="' + i + '" onclick="window.__pfToggle(this)">' +
      '<td><span class="c-harness">' + esc(p.harness) + '</span></td>' +
      '<td><span class="c-model">' + esc(p.model) + '</span></td>' +
      '<td class="num c-ts">' + esc(fmtTs(p.profiledAt)) + '</td>' +
    '</tr>' +
    '<tr class="detail-row" data-detail-for="' + i + '">' +
      '<td colspan="3"><div class="detail-box"></div></td>' +
    '</tr>'
  ).join("")
}

function renderProfile(tcp: any): string {
  const partial = tcp.isPartial
    ? '<span class="c-kind kind-train" title="profiling was interrupted; some primitives are missing">partial</span>'
    : ""
  const caps = Object.entries(tcp.capabilities as Record<string, string>).sort(([a], [b]) => a.localeCompare(b))
  const capGrid = caps.length
    ? '<div class="cap-grid">' + caps.map(([id, lv]) =>
        '<div class="cap-cell"><span class="cap-id">' + esc(id) + '</span>' + levelBadge(lv) + '</div>'
      ).join("") + '</div>'
    : '<p class="dim">no capabilities recorded</p>'

  const detailRows = (tcp.details as any[]).map((d) => {
    const levels = (d.levelResults as any[]).map((lr) =>
      '<span class="lv-result' + (lr.passed ? " passed" : "") + '" title="' + esc(lr.testDescription || "") + '">' +
        esc(lr.level) + " " + lr.passCount + "/" + lr.totalCount +
        (lr.skipCount ? " (" + lr.skipCount + " skipped)" : "") +
      '</span>'
    ).join(" ")
    return '<tr>' +
      '<td><span class="c-skill">' + esc(d.primitiveId) + '</span></td>' +
      '<td>' + levelBadge(d.highestLevel) + '</td>' +
      '<td>' + levels + '</td>' +
    '</tr>'
  }).join("")

  const cost = tcp.cost
    ? '$' + (tcp.cost.totalUsd || 0).toFixed(2) + " · " +
      Math.round((tcp.cost.durationMs || 0) / 1000) + "s · " +
      ((tcp.cost.totalTokens?.input || 0) + (tcp.cost.totalTokens?.output || 0)) + " tokens"
    : "—"

  return (
    '<div class="d-section"><h4>capabilities ' + partial + '</h4>' + capGrid + '</div>' +
    '<div class="d-section"><h4>per-primitive results</h4>' +
      '<table class="inner"><tr><th>primitive</th><th>highest</th><th>levels</th></tr>' +
      (detailRows || '<tr><td colspan="3" class="dim">no detail rows</td></tr>') +
      '</table>' +
    '</div>' +
    '<div class="d-section"><h4>profiling cost</h4><p style="margin:0" class="mono dim">' + esc(cost) + '</p></div>'
  )
}

;(window as any).__pfToggle = async function (row: HTMLElement): Promise<void> {
  const idx = parseInt(row.dataset["idx"]!, 10)
  const detail = document.querySelector('tr.detail-row[data-detail-for="' + idx + '"]')
  if (!detail) return
  row.classList.toggle("open")
  detail.classList.toggle("open")
  const box = detail.querySelector(".detail-box") as HTMLElement
  if (box.dataset["rendered"]) return

  const p = state.profiles[idx]
  if (!p) return
  box.innerHTML = '<p class="dim" style="margin:12px 0">loading…</p>'
  try {
    const res = await fetch("/api/profile?model=" + encodeURIComponent(p.model) + "&harness=" + encodeURIComponent(p.harness))
    const data: any = await res.json()
    if (!res.ok) throw new Error(data.error || "load failed")
    box.innerHTML = renderProfile(data.profile)
    box.dataset["rendered"] = "1"
  } catch (err: any) {
    box.innerHTML = '<p class="dim" style="margin:12px 0">failed: ' + esc(err.message) + '</p>'
  }
}

;(async function boot() {
  el("gen-date").textContent =
    new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC"
  try {
    const res = await fetch("/api/profiles")
    if (!res.ok) throw new Error("GET /api/profiles failed: " + res.status)
    const data: any = await res.json()
    state.profiles = (data.profiles || []).sort((a: any, b: any) =>
      (a.harness + a.model).localeCompare(b.harness + b.model))
    renderEntries()
  } catch (err: any) {
    el("entries").innerHTML =
      '<tr><td colspan="3" style="padding:32px;text-align:center;color:var(--bad)">Error: ' + esc(err.message) + '</td></tr>'
  }
})()
