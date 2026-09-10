/**
 * Client for the SkVM bench page: bench-type sessions from the index, each
 * expandable into its report.json — per-condition summary, deltas, and a
 * task × condition score matrix. Multi-model reports (a `reports` array)
 * render one section per sub-report.
 */

const state: { sessions: any[] } = { sessions: [] }

function el(id: string): HTMLElement {
  const node = document.getElementById(id)
  if (!node) throw new Error("missing element #" + id)
  return node
}

function esc(s: unknown): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
  return String(s).replace(/[&<>"']/g, (c) => map[c] ?? c)
}

function fmtStarted(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso)
  if (!m) return iso
  return m[1] + "-" + m[2] + " " + m[3] + ":" + m[4]
}

function fmt3(n: number | null | undefined): string { return n == null ? "n/a" : n.toFixed(3) }
function fmtPct(n: number | null | undefined): string { return n == null ? "n/a" : (n * 100).toFixed(0) + "%" }
function fmtUsd(n: number | null | undefined): string { return n == null ? "n/a" : "$" + n.toFixed(2) }
function fmtDelta(d: number | null | undefined): string {
  if (d == null) return "n/a"
  return (d >= 0 ? "+" : "") + d.toFixed(3)
}
function scoreClass(score: number, pass: boolean): string {
  return pass ? "heat-good" : score > 0 ? "heat-flat" : "heat-bad"
}

function renderEntries(): void {
  el("bench-count").textContent = String(state.sessions.length)
  const tbody = el("entries")
  if (state.sessions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="padding:32px;text-align:center;color:var(--fg-dim)">no bench sessions recorded</td></tr>'
    return
  }
  tbody.innerHTML = state.sessions.map((e) => {
    const model = e.models && e.models.length > 1 ? e.models.length + " models" : (e.models && e.models[0]) || "—"
    return (
      '<tr class="row" data-id="' + esc(e.id) + '" onclick="window.__bnToggle(this)">' +
        '<td><span class="c-status s-' + esc(e.effectiveStatus) + '">' + esc(e.effectiveStatus) + '</span></td>' +
        '<td><span class="c-model">' + esc(e.id) + '</span></td>' +
        '<td><span class="c-model">' + esc(model) + '</span></td>' +
        '<td>' + esc(e.harness || "—") + '</td>' +
        '<td><span class="c-skill">' + esc(e.skill || "—") + '</span></td>' +
        '<td class="num c-ts">' + esc(fmtStarted(e.startedAt)) + '</td>' +
      '</tr>' +
      '<tr class="detail-row" data-detail-for="' + esc(e.id) + '">' +
        '<td colspan="6"><div class="detail-box"></div></td>' +
      '</tr>'
    )
  }).join("")
}

function renderSummary(report: any): string {
  const summary = report.summary || {}
  const conditions = Object.keys(summary.perCondition || {})
  if (!conditions.length) return '<p class="dim">no summary in report</p>'

  const rows = conditions.map((c) => {
    const s = summary.perCondition[c]
    return '<tr>' +
      '<td><span class="c-harness">' + esc(c) + '</span></td>' +
      '<td class="num">' + fmt3(s.avgScore) + '</td>' +
      '<td class="num">' + fmtPct(s.passRate) + '</td>' +
      '<td class="num">' + (s.avgTokens == null ? "n/a" : Math.round(s.avgTokens)) + '</td>' +
      '<td class="num">' + fmtUsd(s.avgCost) + '</td>' +
      '<td class="num">' + Math.round((s.avgDurationMs || 0) / 1000) + 's</td>' +
      '<td class="num">' + (s.taintedCount ? s.evaluableCount + ' <span class="dim">(' + s.taintedCount + ' tainted)</span>' : (s.evaluableCount ?? "")) + '</td>' +
    '</tr>'
  }).join("")

  const d = summary.delta || {}
  const deltas =
    'original vs baseline <b>' + fmtDelta(d.originalVsBaseline) + '</b> · ' +
    'aot vs original <b>' + fmtDelta(d.aotVsOriginal) + '</b> · ' +
    'jit vs aot <b>' + fmtDelta(d.jitVsAot) + '</b>'

  return (
    '<table class="inner">' +
      '<tr><th>condition</th><th class="num">avg score</th><th class="num">pass</th><th class="num">tokens</th><th class="num">cost</th><th class="num">duration</th><th class="num">rows</th></tr>' +
      rows +
    '</table>' +
    '<p class="dim" style="margin:10px 0 0;font-size:12px">' + deltas + '</p>'
  )
}

function renderTaskMatrix(report: any): string {
  const tasks: any[] = report.tasks || []
  if (!tasks.length) return '<p class="dim">no tasks in report</p>'
  const conditions: string[] = Array.from(new Set(tasks.flatMap((t) => t.conditions.map((c: any) => c.condition))))

  const header = '<tr><th class="row-head">task</th>' + conditions.map((c) => '<th>' + esc(c) + '</th>').join("") + '</tr>'
  const body = tasks.map((t) => {
    const cells = conditions.map((c) => {
      const r = t.conditions.find((x: any) => x.condition === c)
      if (!r) return '<td class="heat-empty">·</td>'
      return '<td class="' + scoreClass(r.score, r.pass) + '" title="' + esc(t.taskName) + ' · ' + esc(c) + (r.pass ? " · pass" : " · fail") + '">' + r.score.toFixed(2) + '</td>'
    }).join("")
    return '<tr><th class="row-head">' + esc(t.taskId) + '</th>' + cells + '</tr>'
  }).join("")
  return '<div class="figure-body" style="padding:0"><table class="heat">' + header + body + '</table></div>'
}

function renderReport(report: any): string {
  // Multi-model report: one section per sub-report.
  if (Array.isArray(report.reports)) {
    return report.reports.map((r: any) =>
      '<div class="d-section"><h4>' + esc(r.model) + ' · ' + esc(r.adapter) + '</h4>' +
        renderSummary(r) +
      '</div>' +
      '<div class="d-section"><h4>tasks — ' + esc(r.model) + '</h4>' + renderTaskMatrix(r) + '</div>'
    ).join("")
  }
  return (
    '<div class="d-section"><h4>summary — ' + esc(report.model) + ' · ' + esc(report.adapter) + '</h4>' + renderSummary(report) + '</div>' +
    '<div class="d-section"><h4>tasks × conditions</h4>' + renderTaskMatrix(report) + '</div>'
  )
}

;(window as any).__bnToggle = async function (row: HTMLElement): Promise<void> {
  const id = row.dataset["id"]!
  const detail = document.querySelector('tr.detail-row[data-detail-for="' + CSS.escape(id) + '"]')
  if (!detail) return
  row.classList.toggle("open")
  detail.classList.toggle("open")
  const box = detail.querySelector(".detail-box") as HTMLElement
  if (box.dataset["rendered"]) return

  box.innerHTML = '<p class="dim" style="margin:12px 0">loading report…</p>'
  try {
    const res = await fetch("/api/bench/report?id=" + encodeURIComponent(id))
    const data: any = await res.json()
    if (!res.ok) throw new Error(data.error || "load failed")
    box.innerHTML = renderReport(data.report)
    box.dataset["rendered"] = "1"
  } catch (err: any) {
    box.innerHTML = '<p class="dim" style="margin:12px 0">' + esc(err.message) + '</p>'
  }
}

;(async function boot() {
  el("gen-date").textContent =
    new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC"
  try {
    const res = await fetch("/api/sessions?type=bench")
    if (!res.ok) throw new Error("GET /api/sessions failed: " + res.status)
    const data: any = await res.json()
    state.sessions = data.sessions || []
    renderEntries()
  } catch (err: any) {
    el("entries").innerHTML =
      '<tr><td colspan="6" style="padding:32px;text-align:center;color:var(--bad)">Error: ' + esc(err.message) + '</td></tr>'
  }
})()
