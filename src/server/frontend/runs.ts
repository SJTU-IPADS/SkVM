/**
 * Client for the SkVM runs page: the sessions index rendered live, with a
 * per-session logDir browser and an SSE tail viewer.
 *
 * Follows the proposals page's conventions (any-typed rows mirroring the
 * server payloads, string-built rows, window.__* inline handlers). The list
 * auto-refreshes every 5s, but only while no detail row is open — a refresh
 * would tear down an active tail's EventSource.
 */

const REFRESH_MS = 5_000
/** Keep at most this much text in the tail viewer; older output is dropped. */
const LOG_BUFFER_MAX = 512 * 1024

const state: {
  sessions: any[]
  openId: string | null
  es: EventSource | null
  activeFile: string | null
  follow: boolean
} = { sessions: [], openId: null, es: null, activeFile: null, follow: true }

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
  // "2026-08-28T07:03:59.123Z" → "08-28 07:03"
  const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso)
  if (!m) return iso
  return m[1] + "-" + m[2] + " " + m[3] + ":" + m[4]
}

function fmtDuration(startIso: string, endIso: string | undefined, running: boolean): string {
  const start = Date.parse(startIso)
  const end = endIso ? Date.parse(endIso) : (running ? Date.now() : NaN)
  if (Number.isNaN(start) || Number.isNaN(end)) return "—"
  const s = Math.max(0, Math.round((end - start) / 1000))
  if (s < 60) return s + "s"
  if (s < 3600) return Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s"
  return Math.floor(s / 3600) + "h " + String(Math.floor((s % 3600) / 60)).padStart(2, "0") + "m"
}

function fmtSize(n: number): string {
  if (n < 1024) return n + " B"
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB"
  return (n / (1024 * 1024)).toFixed(1) + " MB"
}

async function fetchSessions(): Promise<void> {
  const res = await fetch("/api/sessions")
  if (!res.ok) throw new Error("GET /api/sessions failed: " + res.status)
  const data: any = await res.json()
  state.sessions = data.sessions || []
}

function renderEntries(): void {
  const tbody = el("entries")
  el("runs-count").textContent = String(state.sessions.length)
  if (state.sessions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="padding:32px;text-align:center;color:var(--fg-dim)">no runs recorded</td></tr>'
    return
  }
  tbody.innerHTML = state.sessions.map(renderRow).join("")
}

function renderRow(e: any): string {
  const status = e.effectiveStatus as string
  const running = status === "running"
  const model = e.models && e.models.length > 1
    ? e.models.length + " models"
    : (e.models && e.models[0]) || "—"
  return (
    '<tr class="row" data-id="' + esc(e.id) + '" onclick="window.__srToggle(this)">' +
      '<td><span class="c-status s-' + esc(status) + '">' + esc(status) + '</span></td>' +
      '<td><span class="c-model">' + esc(e.id) + '</span></td>' +
      '<td><span class="c-harness">' + esc(e.type) + '</span></td>' +
      '<td><span class="c-model">' + esc(model) + '</span></td>' +
      '<td>' + esc(e.harness || "—") + '</td>' +
      '<td><span class="c-skill">' + esc(e.skill || "—") + '</span></td>' +
      '<td class="num c-ts">' + esc(fmtStarted(e.startedAt)) + '</td>' +
      '<td class="num c-rounds">' + esc(fmtDuration(e.startedAt, e.completedAt, running)) + '</td>' +
    '</tr>' +
    '<tr class="detail-row" data-detail-for="' + esc(e.id) + '">' +
      '<td colspan="8"><div class="detail-box"></div></td>' +
    '</tr>'
  )
}

function renderDetail(e: any): string {
  const summary = e.summary ? '<p style="margin:0 0 12px">' + esc(e.summary) + '</p>' : ""
  const error = e.error
    ? '<div class="d-section"><h4>error</h4><div class="error-block">' + esc(e.error) + '</div></div>'
    : ""
  return (
    '<div class="session-detail-grid">' +
      '<div>' +
        '<div class="d-section"><h4>session</h4>' +
          summary +
          '<dl class="meta detail-side">' +
            '<dt>log dir</dt><dd>' + esc(e.logDir) + '</dd>' +
            (e.pid ? '<dt>pid</dt><dd>' + esc(e.pid) + '</dd>' : '') +
            (e.conditions ? '<dt>conditions</dt><dd>' + esc(e.conditions.join(", ")) + '</dd>' : '') +
          '</dl>' +
        '</div>' +
        error +
        '<div class="d-section"><h4>log files</h4>' +
          '<div class="file-list" data-files-for="' + esc(e.id) + '"><span class="dim" style="font-size:11.5px">loading…</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="d-section"><h4>tail</h4>' +
        '<div class="log-head">' +
          '<span data-tail-name>select a file to tail</span>' +
          '<label><input type="checkbox" checked onchange="window.__srFollow(this)"> follow</label>' +
        '</div>' +
        '<pre class="log-view empty" data-tail-view>—</pre>' +
        '<div class="log-view conv" data-conv-view style="display:none"></div>' +
      '</div>' +
    '</div>'
  )
}

async function loadFiles(id: string): Promise<void> {
  const list = document.querySelector('[data-files-for="' + CSS.escape(id) + '"]') as HTMLElement | null
  if (!list) return
  try {
    const res = await fetch("/api/session/files?id=" + encodeURIComponent(id))
    const data: any = await res.json()
    if (!res.ok) throw new Error(data.error || "listing failed")
    if (!data.files.length) {
      list.innerHTML = '<span class="dim" style="font-size:11.5px">no files in log dir</span>'
      return
    }
    list.innerHTML = data.files.map((f: any) => {
      // Conversation logs get a second affordance: a parsed chat view.
      const isConv = /(^|\/)conv-.*\.jsonl$/.test(f.path)
      const chat = isConv
        ? '<span class="fchat" onclick="event.stopPropagation();window.__srConv(this,\'' + encodeURIComponent(id) + '\',\'' + encodeURIComponent(f.path) + '\')">chat</span>'
        : ""
      return '<div class="file-row" data-file="' + esc(f.path) + '" onclick="window.__srTail(this,\'' + encodeURIComponent(id) + '\',\'' + encodeURIComponent(f.path) + '\')">' +
        '<span class="fname">' + esc(f.path) + '</span>' +
        chat +
        '<span class="fsize">' + esc(fmtSize(f.size)) + '</span>' +
      '</div>'
    }).join("") + (data.truncated ? '<span class="dim" style="font-size:11px">listing truncated</span>' : "")
  } catch (err: any) {
    list.innerHTML = '<span class="dim" style="font-size:11.5px">failed: ' + esc(err.message) + '</span>'
  }
}

function closeTail(): void {
  if (state.es) {
    state.es.close()
    state.es = null
  }
  state.activeFile = null
}

;(window as any).__srToggle = function (row: HTMLElement): void {
  const id = row.dataset["id"]!
  const detail = document.querySelector('tr.detail-row[data-detail-for="' + CSS.escape(id) + '"]')
  if (!detail) return
  const wasOpen = detail.classList.contains("open")

  // Single-open: close everything (and any live tail) first.
  closeTail()
  document.querySelectorAll("tr.row.open, tr.detail-row.open").forEach((x) => x.classList.remove("open"))
  state.openId = null
  if (wasOpen) return

  const box = detail.querySelector(".detail-box") as HTMLElement
  const e = state.sessions.find((s) => s.id === id)
  if (!e) return
  box.innerHTML = renderDetail(e)
  row.classList.add("open")
  detail.classList.add("open")
  state.openId = id
  void loadFiles(id)
}

function showPane(which: "tail" | "conv"): void {
  const tail = document.querySelector("[data-tail-view]") as HTMLElement
  const conv = document.querySelector("[data-conv-view]") as HTMLElement
  tail.style.display = which === "tail" ? "" : "none"
  conv.style.display = which === "conv" ? "" : "none"
}

;(window as any).__srTail = function (fileRow: HTMLElement, encodedId: string, encodedFile: string): void {
  const id = decodeURIComponent(encodedId)
  const file = decodeURIComponent(encodedFile)
  closeTail()
  document.querySelectorAll(".file-row.active").forEach((x) => x.classList.remove("active"))
  fileRow.classList.add("active")
  showPane("tail")

  const view = document.querySelector("[data-tail-view]") as HTMLElement
  const name = document.querySelector("[data-tail-name]") as HTMLElement
  name.textContent = file
  view.textContent = ""
  view.classList.remove("empty")

  const es = new EventSource("/api/session/tail?id=" + encodeURIComponent(id) + "&file=" + encodeURIComponent(file))
  state.es = es
  state.activeFile = file
  es.addEventListener("chunk", (ev) => {
    const data = JSON.parse((ev as MessageEvent).data)
    view.textContent = (view.textContent + data.text).slice(-LOG_BUFFER_MAX)
    if (state.follow) view.scrollTop = view.scrollHeight
  })
  es.onerror = () => {
    // EventSource retries on its own; nothing to render.
  }
}

;(window as any).__srFollow = function (box: HTMLInputElement): void {
  state.follow = box.checked
}

function renderTurn(t: any): string {
  if (t.kind === "request") {
    const msg = t.lastMessage
    if (!msg) return ""
    const role = typeof msg.role === "string" ? msg.role : "user"
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content, null, 2)
    return (
      '<div class="turn turn-req">' +
        '<div class="turn-role">' + esc(role) + '</div>' +
        '<div class="turn-body">' + esc(content) + '</div>' +
      '</div>'
    )
  }
  const text = t.text ? '<div class="turn-body">' + esc(t.text) + '</div>' : ""
  const tools = (t.toolCalls || []).map((tc: any) =>
    '<div class="tool-call"><div class="tool-name">' + esc(tc.name || "tool") + '</div>' +
      '<pre>' + esc(JSON.stringify(tc.arguments ?? tc.input ?? {}, null, 2)) + '</pre></div>'
  ).join("")
  const tokens = t.tokens ? (t.tokens.input || 0) + "→" + (t.tokens.output || 0) + " tok · " : ""
  const meta = '<div class="turn-meta">' + esc(tokens + Math.round((t.durationMs || 0) / 1000) + "s · " + (t.stopReason || "")) + '</div>'
  return '<div class="turn turn-res"><div class="turn-role">assistant</div>' + text + tools + meta + '</div>'
}

;(window as any).__srConv = async function (chatBtn: HTMLElement, encodedId: string, encodedFile: string): Promise<void> {
  const id = decodeURIComponent(encodedId)
  const file = decodeURIComponent(encodedFile)
  closeTail()
  document.querySelectorAll(".file-row.active").forEach((x) => x.classList.remove("active"))
  chatBtn.closest(".file-row")?.classList.add("active")
  showPane("conv")

  const view = document.querySelector("[data-conv-view]") as HTMLElement
  const name = document.querySelector("[data-tail-name]") as HTMLElement
  name.textContent = file + " (conversation)"
  view.innerHTML = '<span class="dim">parsing…</span>'
  try {
    const res = await fetch("/api/session/conv?id=" + encodeURIComponent(id) + "&file=" + encodeURIComponent(file))
    const data: any = await res.json()
    if (!res.ok) throw new Error(data.error || "parse failed")
    view.innerHTML = data.turns.length
      ? data.turns.map(renderTurn).join("")
      : '<span class="dim">no parseable turns in this file</span>'
  } catch (err: any) {
    view.innerHTML = '<span class="dim">failed: ' + esc(err.message) + '</span>'
  }
}

async function refresh(): Promise<void> {
  // Skip while a detail is open: re-rendering would destroy the tail view.
  if (state.openId !== null) return
  try {
    await fetchSessions()
    renderEntries()
  } catch {
    // transient — retry on the next tick
  }
}

;(async function boot() {
  el("gen-date").textContent =
    new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC"
  try {
    await fetchSessions()
    renderEntries()
    setInterval(refresh, REFRESH_MS)
  } catch (err: any) {
    el("entries").innerHTML =
      '<tr><td colspan="8" style="padding:32px;text-align:center;color:var(--bad)">Error: ' + esc(err.message) + '</td></tr>'
  }
})()
