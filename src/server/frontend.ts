/**
 * Engineering-report frontend for `skvm proposals serve`.
 *
 * A functional dashboard in the spirit of Stripe / Linear / GitHub Insights.
 * Information-dense, calm, readable. No decorative flourishes — typography
 * is used to convey hierarchy through weight and size; color is reserved for
 * semantics (green = win Δ, red = loss Δ, blue = focus / interactive).
 *
 * Single HTML document with inline CSS and JS. Fonts from Google Fonts:
 * Host Grotesk (body + headings) and JetBrains Mono (data). Data fetched
 * from /api/proposals on load, or from window.__INITIAL_DATA if preseeded —
 * the same shell will later back the static `report` export.
 */

export function renderFrontend(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SkVM Proposals</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Host+Grotesk:ital,wght@0,300..800;1,300..800&family=JetBrains+Mono:ital,wght@0,300..700;1,300..700&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
${SHELL_HTML}
<script>${JS}</script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const CSS = `
:root {
  --bg:           #FAFAFA;
  --bg-elev:      #FFFFFF;
  --bg-subtle:    #F4F4F5;
  --fg:           #18181B;
  --fg-mid:       #52525B;
  --fg-dim:       #8B8B93;
  --border:       #E4E4E7;
  --border-soft:  #EEEEF1;
  --accent:       #2563EB;
  --accent-soft:  #EFF6FF;
  --good:         #15803D;
  --good-bg:      #DCFCE7;
  --bad:          #B91C1C;
  --bad-bg:       #FEE2E2;
  --flat:         #71717A;
  --shadow:       0 1px 2px rgba(0,0,0,0.04);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg:          #0A0A0B;
    --bg-elev:     #141416;
    --bg-subtle:   #1A1A1D;
    --fg:          #F4F4F5;
    --fg-mid:      #A1A1AA;
    --fg-dim:      #71717A;
    --border:      #27272A;
    --border-soft: #1C1C1F;
    --accent:      #60A5FA;
    --accent-soft: rgba(96, 165, 250, 0.08);
    --good:        #4ADE80;
    --good-bg:     rgba(74, 222, 128, 0.12);
    --bad:         #F87171;
    --bad-bg:      rgba(248, 113, 113, 0.12);
    --flat:        #71717A;
    --shadow:      0 1px 2px rgba(0,0,0,0.3);
  }
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
html { -webkit-text-size-adjust: 100%; }

body {
  font-family: "Host Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px;
  line-height: 1.55;
  color: var(--fg);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  font-feature-settings: "kern" 1, "ss01" 1;
}

.mono {
  font-family: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
  font-variant-numeric: tabular-nums;
}

.tnum { font-variant-numeric: tabular-nums; }
.dim  { color: var(--fg-dim); }

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

::selection { background: var(--accent); color: #fff; }

/* ═══════════════════════════════════════════════════════════════════════
   Layout — page container, header
   ═══════════════════════════════════════════════════════════════════════ */
.page {
  max-width: 1440px;
  margin: 0 auto;
  padding: 28px 40px 80px;
}
@media (max-width: 900px) {
  .page { padding: 20px 16px 48px; }
}

.page-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 18px;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--border);
}
.page-header h1 {
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 0;
  color: var(--fg);
}
.page-header .meta {
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
}

/* ═══════════════════════════════════════════════════════════════════════
   Stat tiles — horizontal strip, no container chrome
   ═══════════════════════════════════════════════════════════════════════ */
.stats {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 1px;
  background: var(--border);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  margin-bottom: 28px;
}
@media (max-width: 900px) {
  .stats { grid-template-columns: repeat(3, 1fr); }
}
.stat {
  background: var(--bg-elev);
  padding: 14px 18px;
}
.stat-value {
  font-size: 24px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  color: var(--fg);
  line-height: 1.1;
}
.stat-value.good { color: var(--good); }
.stat-value.bad  { color: var(--bad); }
.stat-label {
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--fg-dim);
  margin-top: 4px;
  font-weight: 500;
}

/* ═══════════════════════════════════════════════════════════════════════
   Spread — sidebar (filters) + main (table + figures)
   ═══════════════════════════════════════════════════════════════════════ */
.spread {
  display: grid;
  grid-template-columns: 200px 1fr;
  gap: 32px;
  align-items: start;
}
@media (max-width: 900px) {
  .spread { grid-template-columns: 1fr; gap: 20px; }
}

aside.sidebar {
  position: sticky;
  top: 20px;
  align-self: start;
  font-size: 13px;
  color: var(--fg-mid);
}
@media (max-width: 900px) {
  aside.sidebar { position: static; }
}

.sidebar h3 {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--fg-dim);
  margin: 22px 0 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border-soft);
  font-family: "JetBrains Mono", monospace;
}
.sidebar h3:first-child { margin-top: 0; }

.sidebar .field {
  display: block;
  margin-bottom: 12px;
}
.sidebar .field-label {
  display: block;
  font-size: 11px;
  color: var(--fg-dim);
  margin-bottom: 5px;
  font-weight: 500;
}
.sidebar input[type="search"],
.sidebar select {
  width: 100%;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  padding: 7px 10px;
  font-family: inherit;
  font-size: 13px;
  color: var(--fg);
  outline: none;
  border-radius: 4px;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
.sidebar input[type="search"]:focus,
.sidebar select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.sidebar select {
  -webkit-appearance: none;
  appearance: none;
  background: var(--bg-elev) url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6'><path d='M0 0L5 6L10 0' fill='%238B8B93'/></svg>") no-repeat right 10px center;
  padding-right: 28px;
  cursor: pointer;
}

.sidebar .sb-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sidebar .sb-row {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  font-family: "JetBrains Mono", monospace;
  font-variant-numeric: tabular-nums;
}
.sidebar .sb-row .k { color: var(--fg-dim); }
.sidebar .sb-row .v { color: var(--fg); }

/* ═══════════════════════════════════════════════════════════════════════
   Section headings
   ═══════════════════════════════════════════════════════════════════════ */
.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin: 0 0 12px;
}
.section-head h2 {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--fg-dim);
  margin: 0;
  font-family: "JetBrains Mono", monospace;
}
.section-head .count {
  font-size: 12px;
  font-family: "JetBrains Mono", monospace;
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
}

/* ═══════════════════════════════════════════════════════════════════════
   Main proposals table
   ═══════════════════════════════════════════════════════════════════════ */
.ptable-wrap {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
table.ptable {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
table.ptable thead th {
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--fg-dim);
  padding: 10px 14px;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
table.ptable thead th.num { text-align: right; }
table.ptable thead th:hover { color: var(--fg); }
table.ptable thead th.sort-asc::after  { content: " ↑"; color: var(--accent); }
table.ptable thead th.sort-desc::after { content: " ↓"; color: var(--accent); }

table.ptable tbody td {
  padding: 11px 14px;
  border-bottom: 1px solid var(--border-soft);
  vertical-align: middle;
  white-space: nowrap;
}
table.ptable tbody td.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-family: "JetBrains Mono", monospace;
  font-size: 12.5px;
}
table.ptable tbody tr.row {
  cursor: pointer;
}
table.ptable tbody tr.row:hover td {
  background: var(--bg-subtle);
}
table.ptable tbody tr.row.open td {
  background: var(--accent-soft);
  border-bottom-color: var(--border);
}

.c-status {
  display: inline-block;
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.02em;
  color: var(--fg-mid);
}
.c-status::before {
  content: "";
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--fg-dim);
  margin-right: 7px;
  vertical-align: 1px;
}
.c-status.s-pending::before       { background: var(--flat); }
.c-status.s-accepted              { color: var(--good); }
.c-status.s-accepted::before      { background: var(--good); }
.c-status.s-rejected              { color: var(--bad); }
.c-status.s-rejected::before      { background: var(--bad); }
.c-status.s-infra-blocked         { color: var(--fg-dim); font-style: italic; }
.c-status.s-infra-blocked::before { background: var(--border); }

.c-skill {
  font-weight: 600;
  color: var(--fg);
}
.c-harness {
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--fg-mid);
  padding: 2px 7px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: 3px;
}
.c-model {
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
  color: var(--fg);
}
.c-delta {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  font-family: "JetBrains Mono", monospace;
  font-size: 13px;
}
.c-delta.good { color: var(--good); }
.c-delta.bad  { color: var(--bad); }
.c-delta.flat { color: var(--fg-mid); }
.c-delta.na   { color: var(--fg-dim); }

.c-rounds { color: var(--fg-mid); }
.c-ts     { color: var(--fg-dim); }
.c-cost   { color: var(--fg-mid); }
.c-score {
  font-variant-numeric: tabular-nums;
  font-family: "JetBrains Mono", monospace;
  font-size: 12.5px;
  color: var(--fg);
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.c-score.na { color: var(--fg-dim); }
.c-score-base { color: var(--fg-dim); }
.c-score-arrow { color: var(--fg-dim); margin: 0 2px; }
.c-kind {
  display: inline-block;
  font-family: "JetBrains Mono", monospace;
  font-size: 9.5px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 1px 5px;
  border-radius: 2px;
  margin-left: 5px;
  vertical-align: 1px;
  line-height: 1.4;
}
.c-kind.kind-test  { background: var(--accent-soft); color: var(--accent); border: 1px solid var(--accent); }
.c-kind.kind-train { background: var(--bg-subtle); color: var(--fg-dim); border: 1px solid var(--border); }

/* group header row */
tr.group-header td {
  padding: 14px 14px 6px;
  background: var(--bg);
  border-bottom: none;
}
tr.group-header td .g-label {
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--accent);
}
tr.group-header td .g-count {
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  color: var(--fg-dim);
  margin-left: 10px;
}

/* ═══════════════════════════════════════════════════════════════════════
   Expanded detail row
   ═══════════════════════════════════════════════════════════════════════ */
tr.detail-row { display: none; }
tr.detail-row.open { display: table-row; }
tr.detail-row > td {
  padding: 0;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border);
  border-top: 1px solid var(--border);
  white-space: normal;
}

.detail-box {
  padding: 22px 26px 24px;
}
.detail-grid {
  display: grid;
  grid-template-columns: 1fr 280px;
  gap: 32px;
  margin-bottom: 4px;
}
@media (max-width: 900px) {
  .detail-grid { grid-template-columns: 1fr; gap: 20px; }
}

.d-section + .d-section { margin-top: 20px; }
.d-section h4 {
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--fg-dim);
  margin: 0 0 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border-soft);
}

/* rounds + per-task inner tables */
table.inner {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
table.inner th, table.inner td {
  text-align: left;
  padding: 7px 12px 7px 0;
  border-bottom: 1px solid var(--border-soft);
  vertical-align: baseline;
}
table.inner th:last-child, table.inner td:last-child { padding-right: 0; }
table.inner th {
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--fg-dim);
}
table.inner th.num, table.inner td.num {
  text-align: right;
  font-family: "JetBrains Mono", monospace;
  font-variant-numeric: tabular-nums;
}
table.inner .round-label {
  font-family: "JetBrains Mono", monospace;
  font-weight: 500;
  color: var(--fg);
}
table.inner .round-label.baseline { color: var(--fg-dim); }
table.inner .round-label.best { color: var(--accent); font-weight: 600; }
table.inner .files {
  font-family: "JetBrains Mono", monospace;
  font-size: 11.5px;
  color: var(--fg-mid);
}
table.inner .inner-delta.good { color: var(--good); }
table.inner .inner-delta.bad  { color: var(--bad); }
table.inner .inner-delta.na   { color: var(--fg-dim); }

/* root cause — plain block, no drop cap */
.root-cause {
  font-size: 13px;
  line-height: 1.6;
  color: var(--fg);
  background: var(--bg-elev);
  border-left: 3px solid var(--accent);
  padding: 12px 16px;
  margin: 0;
  white-space: pre-wrap;
  border-radius: 0 4px 4px 0;
}

/* side column */
.detail-side {
  font-size: 12.5px;
  color: var(--fg-mid);
}
.detail-side .spark-box {
  background: var(--bg-elev);
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  padding: 12px;
}
.detail-side .spark svg { display: block; width: 100%; }
.detail-side .spark path { fill: none; stroke: var(--accent); stroke-width: 1.5; }
.detail-side .spark circle { fill: var(--accent); }
.detail-side .spark .baseline-line { stroke: var(--fg-dim); stroke-dasharray: 2 3; stroke-width: 1; }
.detail-side dl.meta {
  margin: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 5px 14px;
  font-size: 12px;
}
.detail-side dl.meta dt {
  color: var(--fg-dim);
  font-size: 11px;
}
.detail-side dl.meta dd {
  margin: 0;
  color: var(--fg);
  word-break: break-all;
  font-family: "JetBrains Mono", monospace;
  font-size: 11.5px;
}

/* diff block */
.diff-wrap { margin-top: 16px; }
.diff-wrap button.diff-toggle {
  font-family: "JetBrains Mono", monospace;
  font-size: 11.5px;
  font-weight: 500;
  background: var(--bg-elev);
  color: var(--fg-mid);
  border: 1px solid var(--border);
  padding: 7px 14px;
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.12s ease;
}
.diff-wrap button.diff-toggle:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.diff-body {
  margin-top: 10px;
  background: var(--bg-elev);
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  padding: 14px 16px;
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
  line-height: 1.55;
  max-height: 520px;
  overflow-y: auto;
  overflow-x: hidden;
}
.diff-body pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.diff-body span {
  display: block;
  padding-left: 1.3em;
  text-indent: -1.3em;  /* hang the +/- marker so wrapped lines align under the content */
}
.diff-body .d-add { color: var(--good); background: var(--good-bg); }
.diff-body .d-del { color: var(--bad);  background: var(--bad-bg); }
.diff-body .d-hunk { color: var(--accent); }
.diff-body .d-file { color: var(--fg-dim); font-weight: 600; }
.diff-body .d-githeader { color: var(--fg-dim); }
.diff-body .loading, .diff-body .empty {
  color: var(--fg-dim); font-style: normal;
}

/* actions */
.actions {
  display: flex;
  gap: 8px;
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid var(--border-soft);
  align-items: center;
}
.actions button {
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 500;
  background: var(--bg-elev);
  color: var(--fg);
  border: 1px solid var(--border);
  padding: 8px 16px;
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.12s ease;
}
.actions button:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.actions button.accept {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.actions button.accept:hover {
  background: #1D4ED8;
  border-color: #1D4ED8;
  color: #fff;
}
.actions button.reject:hover {
  border-color: var(--bad);
  color: var(--bad);
}
.actions button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  background: var(--bg-elev);
  color: var(--fg-mid);
  border-color: var(--border);
}
.actions .round-select {
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--fg-mid);
  padding: 8px 10px;
  border-radius: 4px;
}

/* toast */
.toast {
  position: fixed;
  bottom: 20px;
  right: 20px;
  background: var(--fg);
  color: var(--bg);
  font-size: 12.5px;
  padding: 11px 16px;
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.16);
  z-index: 2000;
  max-width: 360px;
  animation: toast-in 0.18s ease-out;
}
.toast.error { background: var(--bad); color: #fff; }
.toast.good  { background: var(--good); color: #fff; }
@keyframes toast-in {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* ═══════════════════════════════════════════════════════════════════════
   Figures — heatmaps
   ═══════════════════════════════════════════════════════════════════════ */
.figures {
  margin-top: 40px;
  display: grid;
  gap: 24px;
}
.figure {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.figure-head {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-subtle);
}
.figure-head .title {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
}
.figure-head .sub {
  font-size: 11.5px;
  color: var(--fg-dim);
  margin-top: 2px;
}
.figure-body { overflow-x: auto; padding: 12px; }
table.heat {
  border-collapse: collapse;
  font-size: 11.5px;
  font-family: "JetBrains Mono", monospace;
  font-variant-numeric: tabular-nums;
}
table.heat th, table.heat td {
  padding: 7px 11px;
  border: 1px solid var(--border-soft);
  text-align: center;
  white-space: nowrap;
}
table.heat th {
  color: var(--fg-dim);
  font-weight: 500;
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: var(--bg-subtle);
}
table.heat th.row-head { text-align: left; color: var(--fg); font-weight: 600; }
table.heat td.heat-empty { color: var(--border); }
.heat-good { background: var(--good-bg); color: var(--good); }
.heat-bad  { background: var(--bad-bg);  color: var(--bad); }
.heat-flat { color: var(--flat); }

/* loading state */
.loading-state {
  text-align: center;
  padding: 64px 0;
  color: var(--fg-dim);
  font-size: 12.5px;
  font-family: "JetBrains Mono", monospace;
}
.loading-state .bar {
  display: inline-block;
  width: 32px;
  height: 2px;
  background: var(--accent);
  vertical-align: middle;
  margin: 0 8px;
  animation: pulse 1.2s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { transform: scaleX(0.3); opacity: 0.4; }
  50%      { transform: scaleX(1); opacity: 1; }
}
`

// ---------------------------------------------------------------------------
// HTML shell
// ---------------------------------------------------------------------------

const SHELL_HTML = `
<main class="page">
  <header class="page-header">
    <h1>SkVM Proposals</h1>
    <div class="meta" id="gen-date">—</div>
  </header>

  <div class="stats" id="stats">
    <div class="stat"><div class="stat-value">—</div><div class="stat-label">loading</div></div>
  </div>

  <div class="spread">
    <aside class="sidebar">
      <h3>Filters</h3>
      <div class="field">
        <label class="field-label" for="f-search">Search</label>
        <input type="search" id="f-search" placeholder="skill, model, harness…">
      </div>
      <div class="field">
        <label class="field-label" for="f-status">Status</label>
        <select id="f-status"><option value="">all</option></select>
      </div>
      <div class="field">
        <label class="field-label" for="f-group">Group by</label>
        <select id="f-group">
          <option value="">(none)</option>
          <option value="skill">skill</option>
          <option value="model">target model</option>
          <option value="harness">harness</option>
        </select>
      </div>
      <div class="field">
        <label class="field-label" for="f-mindelta">Min Δ train</label>
        <input type="search" id="f-mindelta" placeholder="e.g. 0.05">
      </div>

      <h3>Harnesses</h3>
      <div class="sb-list" id="sb-harnesses"></div>

      <h3>Target models</h3>
      <div class="sb-list" id="sb-models"></div>
    </aside>

    <section class="main">
      <div class="section-head">
        <h2>Proposals</h2>
        <div class="count" id="proposals-count">—</div>
      </div>
      <div class="ptable-wrap">
        <table class="ptable">
          <thead>
            <tr>
              <th data-sort="status" style="width:100px">status</th>
              <th data-sort="skill">skill</th>
              <th data-sort="harness">harness</th>
              <th data-sort="model">target model</th>
              <th data-sort="delta" class="num sort-desc">Δ</th>
              <th data-sort="score" class="num">score</th>
              <th data-sort="best" class="num">best/total</th>
              <th data-sort="ts" class="num">timestamp</th>
              <th data-sort="cost" class="num">cost</th>
            </tr>
          </thead>
          <tbody id="entries">
            <tr><td colspan="9"><div class="loading-state">Loading<span class="bar"></span>proposals</div></td></tr>
          </tbody>
        </table>
      </div>

      <div class="figures">
        <div class="section-head" style="margin-top:16px">
          <h2>Figures</h2>
        </div>
        <figure class="figure">
          <div class="figure-head">
            <div class="title">Δ train — skill × target model</div>
            <div class="sub">Mean Δ across proposals. Rows = skills, columns = target models.</div>
          </div>
          <div class="figure-body" id="heat-skill"></div>
        </figure>
        <figure class="figure">
          <div class="figure-head">
            <div class="title">Δ train — target model × skill</div>
            <div class="sub">Rows = target models, columns = skills.</div>
          </div>
          <div class="figure-body" id="heat-model"></div>
        </figure>
      </div>
    </section>
  </div>
</main>
`

// ---------------------------------------------------------------------------
// JS
// ---------------------------------------------------------------------------

const JS = String.raw`
(function () {
  const state = {
    proposals: [],
    filtered: [],
    filters: { search: "", status: "", sort: "delta", sortDir: "desc", group: "", minDelta: null },
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmt3(n) { return n == null ? "—" : n.toFixed(3); }
  function fmtDelta(d) {
    if (d == null) return "—";
    const sign = d >= 0 ? "+" : "";
    return sign + d.toFixed(3);
  }
  function deltaClass(d) {
    if (d == null) return "na";
    if (d >= 0.05) return "good";
    if (d <= -0.02) return "bad";
    return "flat";
  }
  function heatClass(d) {
    if (d == null) return "heat-empty";
    if (d >= 0.05) return "heat-good";
    if (d <= -0.02) return "heat-bad";
    return "heat-flat";
  }
  function fmtUsd(n) { return "$" + (n || 0).toFixed(2); }

  // "primary" = test if the best round has a test score, else train.
  // Test is the honest signal (held-out); train is what the optimizer saw.
  function primaryKind(summary) {
    if (summary.best && summary.best.testScore != null) return "test";
    return "train";
  }
  function primaryBest(summary) {
    if (!summary.best) return null;
    return summary.best.testScore != null ? summary.best.testScore : summary.best.trainScore;
  }
  function primaryBaseline(summary) {
    if (!summary.baseline) return null;
    return summary.baseline.testScore != null ? summary.baseline.testScore : summary.baseline.trainScore;
  }
  function primaryDelta(summary) {
    if (summary.best && summary.best.testScore != null && summary.baseline && summary.baseline.testScore != null) {
      return summary.best.testScore - summary.baseline.testScore;
    }
    return summary.trainDelta;
  }

  function fmtTs(ts) {
    // "20260415T041220Z" → "04-15 04:12"
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(ts);
    if (!m) return ts;
    return m[2] + "-" + m[3] + " " + m[4] + ":" + m[5];
  }

  async function loadData() {
    if (window.__INITIAL_DATA) return window.__INITIAL_DATA;
    const res = await fetch("/api/proposals");
    if (!res.ok) throw new Error("GET /api/proposals failed: " + res.status);
    return await res.json();
  }

  // ── filter / sort ─────────────────────────────────────────────────
  function applyFilters() {
    const f = state.filters;
    let rows = state.proposals.slice();
    if (f.search) {
      const q = f.search.toLowerCase();
      rows = rows.filter((r) => {
        const h = (r.meta.harness + " " + r.meta.targetModel + " " + r.meta.skillName + " " + r.meta.status).toLowerCase();
        return h.includes(q);
      });
    }
    if (f.status) rows = rows.filter((r) => r.meta.status === f.status);
    if (f.minDelta != null) rows = rows.filter((r) => (r.summary.trainDelta ?? -Infinity) >= f.minDelta);

    const dir = f.sortDir === "asc" ? 1 : -1;
    const cmp = (a, b) => {
      switch (f.sort) {
        case "status":  return a.meta.status.localeCompare(b.meta.status) * dir;
        case "skill":   return a.meta.skillName.localeCompare(b.meta.skillName) * dir;
        case "harness": return a.meta.harness.localeCompare(b.meta.harness) * dir;
        case "model":   return a.meta.targetModel.localeCompare(b.meta.targetModel) * dir;
        case "delta":   return ((primaryDelta(a.summary) ?? -Infinity) - (primaryDelta(b.summary) ?? -Infinity)) * dir;
        case "score":   return ((primaryBest(a.summary) ?? -Infinity) - (primaryBest(b.summary) ?? -Infinity)) * dir;
        case "best":    return (a.meta.bestRound - b.meta.bestRound) * dir;
        case "ts":      return a.meta.timestamp.localeCompare(b.meta.timestamp) * dir;
        case "cost":    return ((a.summary.totalCostUsd || 0) - (b.summary.totalCostUsd || 0)) * dir;
        default:        return 0;
      }
    };
    rows.sort(cmp);
    state.filtered = rows;
  }

  // ── stat tiles + sidebar lists ───────────────────────────────────
  function renderStats() {
    const N = state.proposals.length;
    const deltas = state.proposals.map((p) => primaryDelta(p.summary)).filter((d) => d != null);
    const avg = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;
    const wins = deltas.filter((d) => d >= 0.05).length;
    const losses = deltas.filter((d) => d <= -0.02).length;
    const skills = new Set(state.proposals.map((p) => p.meta.skillName)).size;
    const models = new Set(state.proposals.map((p) => p.meta.targetModel)).size;

    const avgCls = avg == null ? "" : (avg >= 0.05 ? "good" : avg <= -0.02 ? "bad" : "");
    const avgTxt = avg == null ? "—" : (avg >= 0 ? "+" : "") + avg.toFixed(3);

    const tiles = [
      { v: N, l: "proposals" },
      { v: skills, l: "skills" },
      { v: models, l: "target models" },
      { v: avgTxt, l: "avg Δ", cls: avgCls },
      { v: wins, l: "wins ≥ +0.05", cls: wins > 0 ? "good" : "" },
      { v: losses, l: "losses ≤ −0.02", cls: losses > 0 ? "bad" : "" },
    ];
    document.getElementById("stats").innerHTML = tiles.map((t) =>
      '<div class="stat"><div class="stat-value ' + (t.cls || "") + '">' + esc(String(t.v)) + '</div><div class="stat-label">' + esc(t.l) + '</div></div>'
    ).join("");

    const byH = new Map();
    for (const p of state.proposals) byH.set(p.meta.harness, (byH.get(p.meta.harness) || 0) + 1);
    document.getElementById("sb-harnesses").innerHTML = Array.from(byH.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => '<div class="sb-row"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>')
      .join("");

    const byM = new Map();
    for (const p of state.proposals) byM.set(p.meta.targetModel, (byM.get(p.meta.targetModel) || 0) + 1);
    document.getElementById("sb-models").innerHTML = Array.from(byM.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => '<div class="sb-row"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>')
      .join("");
  }

  // ── entries ──────────────────────────────────────────────────────
  function renderEntries() {
    const tbody = document.getElementById("entries");
    document.getElementById("proposals-count").textContent =
      state.filtered.length + " of " + state.proposals.length;

    if (state.filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" style="padding:32px;text-align:center;color:var(--fg-dim)">no matches</td></tr>';
      return;
    }

    const f = state.filters;
    const parts = [];
    if (f.group) {
      const groups = new Map();
      for (const r of state.filtered) {
        const key = f.group === "skill" ? r.meta.skillName : f.group === "harness" ? r.meta.harness : r.meta.targetModel;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      for (const [name, items] of groups) {
        parts.push(
          '<tr class="group-header"><td colspan="9">' +
          '<span class="g-label">' + esc(name) + '</span>' +
          '<span class="g-count">' + items.length + ' proposals</span>' +
          '</td></tr>'
        );
        for (const r of items) parts.push(renderRow(r));
      }
    } else {
      for (const r of state.filtered) parts.push(renderRow(r));
    }
    tbody.innerHTML = parts.join("");
  }

  function renderRow(r) {
    const kind = primaryKind(r.summary);
    const pDelta = primaryDelta(r.summary);
    const dCls = deltaClass(pDelta);
    const dTxt = fmtDelta(pDelta);
    const kindBadge = kind === "test"
      ? '<span class="c-kind kind-test" title="held-out test set">test</span>'
      : '<span class="c-kind kind-train" title="training set (optimizer-seen)">train</span>';
    const bestScore = primaryBest(r.summary);
    const baseScore = primaryBaseline(r.summary);
    const scoreCell = bestScore == null
      ? '<span class="c-score na">—</span>'
      : baseScore == null || baseScore === bestScore
        ? '<span class="c-score">' + fmt3(bestScore) + ' ' + kindBadge + '</span>'
        : '<span class="c-score"><span class="c-score-base">' + fmt3(baseScore) + '</span> <span class="c-score-arrow">→</span> ' + fmt3(bestScore) + ' ' + kindBadge + '</span>';
    const rid = encodeURIComponent(r.id);
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
    );
  }

  function renderDetail(r) {
    const s = r.summary;
    const hasTest = s.rounds.some((x) => x.testScore != null);
    const roundsHead = hasTest
      ? '<tr><th>round</th><th class="num">train</th><th class="num">test</th><th class="num">Δ vs r-0</th><th class="num">pass</th><th class="num">cost</th><th>changed</th></tr>'
      : '<tr><th>round</th><th class="num">train</th><th class="num">Δ vs r-0</th><th class="num">pass</th><th class="num">cost</th><th>changed</th></tr>';

    const roundsRows = s.rounds.map((rd) => {
      const labelCls = rd.isBest ? "round-label best" : rd.isBaseline ? "round-label baseline" : "round-label";
      const labelTxt = "r-" + rd.round + (rd.isBest ? " (best)" : rd.isBaseline ? " (baseline)" : "");
      const delta = rd.isBaseline ? "—" : fmtDelta(rd.deltaVsBaseline);
      const dCls = rd.isBaseline ? "na" : deltaClass(rd.deltaVsBaseline);
      const files = rd.changedFiles.length
        ? '<span class="files">' + rd.changedFiles.map(esc).join(", ") + '</span>'
        : '<span class="files">—</span>';
      if (hasTest) {
        return '<tr>' +
          '<td><span class="' + labelCls + '">' + esc(labelTxt) + '</span></td>' +
          '<td class="num">' + fmt3(rd.trainScore) + '</td>' +
          '<td class="num">' + fmt3(rd.testScore) + '</td>' +
          '<td class="num"><span class="inner-delta ' + dCls + '">' + delta + '</span></td>' +
          '<td class="num">' + rd.trainPassed + '/' + rd.trainTotal + '</td>' +
          '<td class="num">' + fmtUsd(rd.costTotalUsd) + '</td>' +
          '<td>' + files + '</td></tr>';
      }
      return '<tr>' +
        '<td><span class="' + labelCls + '">' + esc(labelTxt) + '</span></td>' +
        '<td class="num">' + fmt3(rd.trainScore) + '</td>' +
        '<td class="num"><span class="inner-delta ' + dCls + '">' + delta + '</span></td>' +
        '<td class="num">' + rd.trainPassed + '/' + rd.trainTotal + '</td>' +
        '<td class="num">' + fmtUsd(rd.costTotalUsd) + '</td>' +
        '<td>' + files + '</td></tr>';
    }).join("");

    const perTaskRows = s.perTaskDeltas.length
      ? s.perTaskDeltas.map((d) =>
          '<tr>' +
            '<td>' + esc(d.taskId) + '</td>' +
            '<td class="num">' + fmt3(d.baseline) + '</td>' +
            '<td class="num">' + fmt3(d.best) + '</td>' +
            '<td class="num"><span class="inner-delta ' + deltaClass(d.delta) + '">' + fmtDelta(d.delta) + '</span></td>' +
          '</tr>'
        ).join("")
      : '<tr><td colspan="4" class="dim">no per-task data</td></tr>';

    const rootCause = s.bestRoundRootCause
      ? '<p class="root-cause">' + esc(s.bestRoundRootCause) + '</p>'
      : '<p class="dim">no root-cause narrative (best round is baseline or optimizer abstained)</p>';

    const spark = renderSparkline(s.rounds);
    const roundOpts = s.rounds
      .filter((x) => !x.isBaseline)
      .map((x) => '<option value="' + x.round + '"' + (x.isBest ? ' selected' : '') + '>round ' + x.round + (x.isBest ? ' (best)' : '') + '</option>')
      .join("");
    const roundSelect = roundOpts ? '<select class="round-select" onclick="event.stopPropagation()">' + roundOpts + '</select>' : '';

    const isTerminal = r.meta.status === "accepted" || r.meta.status === "rejected";
    const acceptBtn = isTerminal
      ? '<button class="accept" disabled>' + (r.meta.status === "accepted" ? "accepted r-" + r.meta.acceptedRound : "accept") + '</button>'
      : '<button class="accept" onclick="event.stopPropagation();window.__accept(this,\'' + encodeURIComponent(r.id) + '\')">Accept</button>';
    const rejectBtn = isTerminal
      ? '<button class="reject" disabled>' + (r.meta.status === "rejected" ? "rejected" : "reject") + '</button>'
      : '<button class="reject" onclick="event.stopPropagation();window.__reject(this,\'' + encodeURIComponent(r.id) + '\')">Reject</button>';

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
    );
  }

  function renderSparkline(rounds) {
    const pts = rounds.map((r) => ({ r: r.round, s: r.trainScore })).filter((p) => p.s != null);
    if (pts.length < 2) return '<div class="dim" style="font-size:11px">(insufficient scored rounds)</div>';
    const W = 240, H = 72, pad = 10;
    const minS = Math.min.apply(null, pts.map((p) => p.s));
    const maxS = Math.max.apply(null, pts.map((p) => p.s));
    const rangeS = (maxS - minS) || 0.001;
    const minR = pts[0].r, maxR = pts[pts.length - 1].r;
    const rangeR = (maxR - minR) || 1;
    const xy = pts.map((p) => ({
      x: pad + ((p.r - minR) / rangeR) * (W - 2 * pad),
      y: H - pad - ((p.s - minS) / rangeS) * (H - 2 * pad),
      s: p.s, r: p.r,
    }));
    const d = xy.map((p, i) => (i === 0 ? "M" : "L") + p.x.toFixed(1) + "," + p.y.toFixed(1)).join(" ");
    const dots = xy.map((p) => '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="2.5"><title>r-' + p.r + ': ' + p.s.toFixed(3) + '</title></circle>').join("");
    const bY = H - pad - ((pts[0].s - minS) / rangeS) * (H - 2 * pad);
    const baselineLine = '<line class="baseline-line" x1="' + pad + '" x2="' + (W - pad) + '" y1="' + bY.toFixed(1) + '" y2="' + bY.toFixed(1) + '"/>';
    return '<svg viewBox="0 0 ' + W + ' ' + H + '">' + baselineLine + '<path d="' + d + '"/>' + dots + '</svg>';
  }

  function colorDiff(raw) {
    const lines = raw.split("\n");
    return lines.map((line) => {
      let cls = "";
      if (line.startsWith("+++") || line.startsWith("---")) cls = "d-file";
      else if (line.startsWith("@@")) cls = "d-hunk";
      else if (line.startsWith("diff --git")) cls = "d-githeader";
      else if (line.startsWith("+")) cls = "d-add";
      else if (line.startsWith("-")) cls = "d-del";
      return '<span class="' + cls + '">' + esc(line || " ") + '</span>';
    }).join("");
  }

  // ── heatmaps ─────────────────────────────────────────────────────
  function renderHeatmaps() {
    renderHeatmap("heat-skill", "skill", "model");
    renderHeatmap("heat-model", "model", "skill");
  }
  function renderHeatmap(elId, rowBy, colBy) {
    const rowKeys = Array.from(new Set(state.proposals.map((p) => rowBy === "skill" ? p.meta.skillName : p.meta.targetModel))).sort();
    const colKeys = Array.from(new Set(state.proposals.map((p) => colBy === "skill" ? p.meta.skillName : p.meta.targetModel))).sort();
    const bucket = new Map();
    for (const p of state.proposals) {
      const rk = rowBy === "skill" ? p.meta.skillName : p.meta.targetModel;
      const ck = colBy === "skill" ? p.meta.skillName : p.meta.targetModel;
      const d = primaryDelta(p.summary);
      if (d == null) continue;
      const key = rk + "||" + ck;
      const arr = bucket.get(key) || [];
      arr.push(d);
      bucket.set(key, arr);
    }
    const header = '<tr><th class="row-head">' + esc(rowBy) + '</th>' +
      colKeys.map((c) => '<th>' + esc(c) + '</th>').join("") + '</tr>';
    const body = rowKeys.map((rk) => {
      const cells = colKeys.map((ck) => {
        const arr = bucket.get(rk + "||" + ck);
        if (!arr || arr.length === 0) return '<td class="heat-empty">·</td>';
        const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
        return '<td class="' + heatClass(avg) + '" title="' + arr.length + ' proposal(s), avg ' + fmtDelta(avg) + '">' + fmtDelta(avg) + '</td>';
      }).join("");
      return '<tr><th class="row-head">' + esc(rk) + '</th>' + cells + '</tr>';
    }).join("");
    document.getElementById(elId).innerHTML = '<table class="heat">' + header + body + '</table>';
  }

  function populateStatusOptions() {
    const statuses = Array.from(new Set(state.proposals.map((p) => p.meta.status))).sort();
    const sel = document.getElementById("f-status");
    for (const s of statuses) {
      const opt = document.createElement("option");
      opt.value = s; opt.textContent = s;
      sel.appendChild(opt);
    }
  }

  // ── interactions ─────────────────────────────────────────────────
  window.__toggle = function (row) {
    const id = row.dataset.id;
    row.classList.toggle("open");
    const detail = document.querySelector('tr.detail-row[data-detail-for="' + CSS.escape(id) + '"]');
    if (!detail) return;
    const box = detail.querySelector(".detail-box");
    if (!box.dataset.rendered) {
      const r = state.proposals.find((p) => p.id === id);
      if (r) {
        box.innerHTML = renderDetail(r);
        box.dataset.rendered = "1";
      }
    }
    detail.classList.toggle("open");
  };

  window.__loadDiff = async function (btn, encodedId, round) {
    const id = decodeURIComponent(encodedId);
    const wrap = btn.parentElement;
    const body = wrap.querySelector(".diff-body");
    if (body.style.display === "block") {
      body.style.display = "none";
      btn.textContent = "Show diff (original → round " + round + ")";
      return;
    }
    body.style.display = "block";
    body.innerHTML = '<div class="loading">loading diff…</div>';
    btn.textContent = "Hide diff";
    try {
      const res = await fetch("/api/proposal/diff?id=" + encodeURIComponent(id) + "&round=" + round);
      const data = await res.json();
      if (data.ok === false) {
        body.innerHTML = '<div class="empty">' + esc(data.reason || "diff unavailable") + '</div>';
        return;
      }
      if (!data.unified || data.unified.trim() === "") {
        body.innerHTML = '<div class="empty">' + esc(data.note || "(no changes)") + '</div>';
        return;
      }
      body.innerHTML = '<pre>' + colorDiff(data.unified) + '</pre>';
    } catch (err) {
      body.innerHTML = '<div class="empty">failed: ' + esc(err.message) + '</div>';
    }
  };

  window.__accept = async function (btn, encodedId) {
    const id = decodeURIComponent(encodedId);
    const actions = btn.closest(".actions");
    const select = actions.querySelector(".round-select");
    const round = select ? parseInt(select.value, 10) : undefined;
    const roundLabel = round != null ? "round " + round : "best round";
    if (!confirm("Deploy " + roundLabel + " of this proposal?\n\n" + id + "\n\nThis will copy files into the live skill directory (with .bak backups of anything overwritten).")) {
      return;
    }
    btn.disabled = true;
    btn.textContent = "deploying…";
    try {
      const res = await fetch("/api/proposal/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, round }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "accept failed");
      toast("good", "accepted " + id.split("/").pop() + " · deployed " + data.filesDeployed.length + " file(s)");
      const target = state.proposals.find((p) => p.id === id);
      if (target) target.meta = data.meta;
      // Re-render: wipe lazy-rendered cache for this id so detail re-renders with new meta
      const detail = document.querySelector('tr.detail-row[data-detail-for="' + CSS.escape(id) + '"] .detail-box');
      if (detail) detail.dataset.rendered = "";
      applyFilters();
      renderEntries();
      renderStats();
    } catch (err) {
      toast("error", err.message);
      btn.disabled = false;
      btn.textContent = "Accept";
    }
  };

  window.__reject = async function (btn, encodedId) {
    const id = decodeURIComponent(encodedId);
    if (!confirm("Reject this proposal?\n\n" + id)) return;
    btn.disabled = true;
    btn.textContent = "rejecting…";
    try {
      const res = await fetch("/api/proposal/reject", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "reject failed");
      toast("good", "rejected " + id.split("/").pop());
      const target = state.proposals.find((p) => p.id === id);
      if (target) target.meta = data.meta;
      const detail = document.querySelector('tr.detail-row[data-detail-for="' + CSS.escape(id) + '"] .detail-box');
      if (detail) detail.dataset.rendered = "";
      applyFilters();
      renderEntries();
      renderStats();
    } catch (err) {
      toast("error", err.message);
      btn.disabled = false;
      btn.textContent = "Reject";
    }
  };

  function toast(kind, msg) {
    const t = document.createElement("div");
    t.className = "toast " + (kind || "");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2800);
  }

  // ── header sort click handling ───────────────────────────────────
  function wireHeaderSorts() {
    const headers = document.querySelectorAll("table.ptable thead th[data-sort]");
    headers.forEach((h) => {
      h.addEventListener("click", () => {
        const key = h.dataset.sort;
        if (state.filters.sort === key) {
          state.filters.sortDir = state.filters.sortDir === "asc" ? "desc" : "asc";
        } else {
          state.filters.sort = key;
          state.filters.sortDir = "desc";
        }
        headers.forEach((x) => x.classList.remove("sort-asc", "sort-desc"));
        h.classList.add(state.filters.sortDir === "asc" ? "sort-asc" : "sort-desc");
        applyFilters();
        renderEntries();
      });
    });
  }

  function wireControls() {
    document.getElementById("f-search").addEventListener("input", (e) => {
      state.filters.search = e.target.value.trim();
      applyFilters(); renderEntries();
    });
    document.getElementById("f-status").addEventListener("change", (e) => {
      state.filters.status = e.target.value;
      applyFilters(); renderEntries();
    });
    document.getElementById("f-group").addEventListener("change", (e) => {
      state.filters.group = e.target.value;
      applyFilters(); renderEntries();
    });
    document.getElementById("f-mindelta").addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      state.filters.minDelta = Number.isNaN(v) ? null : v;
      applyFilters(); renderEntries();
    });
  }

  // ── boot ─────────────────────────────────────────────────────────
  (async function boot() {
    document.getElementById("gen-date").textContent =
      new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
    try {
      const data = await loadData();
      state.proposals = data.proposals || [];
      applyFilters();
      populateStatusOptions();
      renderStats();
      renderEntries();
      renderHeatmaps();
      wireHeaderSorts();
      wireControls();
    } catch (err) {
      document.getElementById("entries").innerHTML =
        '<tr><td colspan="8" style="padding:32px;text-align:center;color:var(--bad)">Error: ' + esc(err.message) + '</td></tr>';
    }
  })();
})();
`
