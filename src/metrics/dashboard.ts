// HTML for the operator dashboard. Rendering only: the router gathers the data.
// No JavaScript: charts are CSS columns with native tooltips, and every chart has a table view.

import { displayName } from "../auth/clients.js";
import type { ConnectionCount } from "../auth/model.js";
import { escapeHtml, FONT_PATH } from "../auth/pages.js";
import type { DailyCount } from "./model.js";
import { shiftDay, type PortalHealth } from "./recorder.js";

export const WINDOWS = [7, 30, 90];
export const REFRESH_SECONDS = 120;

export interface DashboardData {
  days: number;
  today: string;
  /** Daily totals from the first day of the window on. */
  counts: DailyCount[];
  activePerDay: { day: string; count: number }[];
  activeInWindow: number;
  connected: ConnectionCount[];
  portal: PortalHealth;
  host: string;
  version: string;
  startedAt: number;
  now: number;
  rssBytes: number;
}

const OUTCOMES: Record<string, string> = {
  ok: "Succeeded",
  portal_rejected: "Portal said no (bad input, past a deadline, revoked key)",
  portal_down: "Portal down or unreachable",
  error: "Server error",
};

const SIGN_INS: Record<string, string> = {
  connected: "Connected",
  rejected_key: "Key rejected",
  portal_unreachable: "Portal unreachable",
  cancelled: "Cancelled",
};

// Tokens follow the sign-in page (pages.ts). Series and status hues were checked for
// colorblind separation and 3:1 contrast against --panel in both modes.
const STYLE = `
@font-face { font-family: "Atkinson Hyperlegible Next"; font-weight: 200 800; font-display: swap; src: url(${FONT_PATH}) format("woff2"); }
:root {
  --bg: #f4f6f5; --panel: #fff; --fg: #14201a; --muted: #55635c; --faint: #7d8a84; --line: #d6dfda; --grid: #e6ece9; --axis: #b9c5bf;
  --accent: #17694a; --wash: rgba(20, 32, 26, .05);
  --ok: #2a78d6; --failed: #d03b3b; --good: #0ca30c; --critical: #d03b3b;
  --font: "Atkinson Hyperlegible Next", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #18201d; --panel: #1f2925; --fg: #e4ece8; --muted: #9aa8a1; --faint: #7d8a84; --line: #303b36; --grid: #2a3430; --axis: #43504a;
    --accent: #86c4a5; --wash: rgba(228, 236, 232, .06); --ok: #3987e5; color-scheme: dark; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 16px 48px; background: var(--bg); color: var(--fg); font: 15px/1.5 var(--font); }
main { max-width: 1040px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: end; gap: 12px 24px; margin-bottom: 8px; }
h1 { margin: 0; font-size: 26px; line-height: 1.2; font-weight: 720; letter-spacing: -.02em; }
h2 { margin: 0; font-size: 15px; font-weight: 700; }
p { margin: 0; color: var(--muted); }
nav { display: flex; gap: 4px; }
nav a { padding: 6px 12px; border: 1px solid var(--line); border-radius: 6px; color: var(--fg); text-decoration: none; font-weight: 650; font-size: 14px; }
nav a:hover { border-color: var(--muted); }
nav a[aria-current] { background: var(--fg); border-color: var(--fg); color: var(--bg); }
.controls { display: flex; flex-wrap: wrap; gap: 12px; }
.controls button { padding: 6px 12px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--muted); font: 650 14px/1.5 var(--font); cursor: pointer; }
.controls button:hover { border-color: var(--muted); color: var(--fg); }
a:focus-visible, summary:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; min-width: 0; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; }
.tile { display: flex; flex-direction: column; gap: 2px; }
.tile.hero { grid-column: span 2; }
.tile .label { color: var(--muted); font-size: 14px; }
.tile .value { font-size: 30px; font-weight: 700; line-height: 1.2; letter-spacing: -.01em; }
.tile.hero .value { font-size: 52px; line-height: 1.05; }
.tile .sub { color: var(--faint); font-size: 13px; }
.status { display: inline-flex; align-items: center; gap: 6px; font-weight: 650; }
.status .icon { font-size: 12px; }
.status.good .icon { color: var(--good); } .status.critical .icon { color: var(--critical); } .status.unknown .icon { color: var(--faint); }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
.stack { display: flex; flex-direction: column; gap: 20px; }
.chart-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 16px; margin-bottom: 16px; }
.legend { display: flex; gap: 14px; color: var(--muted); font-size: 13px; }
.legend span::before { content: ""; display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; background: var(--swatch); vertical-align: -1px; }
.plot { position: relative; height: 180px; margin-left: 40px; }
.tick { position: absolute; left: -40px; right: 0; height: 0; border-top: 1px solid var(--grid); }
.tick.base { border-color: var(--axis); }
.tick span { position: absolute; left: 0; width: 32px; transform: translateY(-50%); text-align: right; color: var(--faint); font-size: 12px; font-variant-numeric: tabular-nums; }
.cols { position: absolute; inset: 0; display: flex; gap: var(--gap); margin: 0; padding: 0; list-style: none; }
.cols li { flex: 1 1 0; display: flex; align-items: flex-end; justify-content: center; border-radius: 4px 4px 0 0; }
.cols li:hover { background: var(--wash); }
.bar { width: 100%; max-width: 24px; display: flex; flex-direction: column-reverse; gap: 2px; }
.seg { flex: 1 1 0; min-height: 2px; background: var(--swatch); }
.seg:last-child { border-radius: 4px 4px 0 0; }
.xaxis { position: relative; height: 20px; margin: 6px 0 0 40px; color: var(--faint); font-size: 12px; }
.xaxis span { position: absolute; top: 0; white-space: nowrap; transform: translateX(-50%); }
.xaxis span:first-child { transform: none; } .xaxis span:last-child { transform: translateX(-100%); }
details { margin-top: 10px; font-size: 14px; }
summary { cursor: pointer; color: var(--muted); }
.scroll { max-height: 280px; overflow: auto; margin-top: 8px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font-weight: 650; color: var(--muted); font-size: 13px; }
th, td { padding: 6px 8px 6px 0; border-bottom: 1px solid var(--grid); vertical-align: top; }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; padding-right: 0; padding-left: 8px; white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
code { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
.empty { color: var(--faint); font-size: 14px; padding: 8px 0; }
dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; font-size: 14px; }
dt { color: var(--muted); } dd { margin: 0; font-variant-numeric: tabular-nums; }
.fine { font-size: 13px; color: var(--faint); }
@media (max-width: 480px) { .tile.hero { grid-column: 1 / -1; } .tile.hero .value { font-size: 44px; } }
`;

export function renderDashboard(d: DashboardData): string {
  const days = Array.from({ length: d.days }, (_, i) => shiftDay(d.today, i - d.days + 1));
  const calls = perDay(d.counts, "tool_calls");
  const failures = perDay(d.counts, "tool_failures");
  const active = new Map(d.activePerDay.map((a) => [a.day, a.count]));
  const totalCalls = total(d.counts, "tool_calls");
  const totalFailed = total(d.counts, "tool_failures");
  const signIns = perLabel(d.counts, "sign_in");
  const revoked = total(d.counts, "revoked");
  const connected = connectionsByApp(d.connected);
  const connectedTotal = connected.reduce((n, c) => n + c.count, 0);
  const range = `in the last ${d.days} days`;

  const tiles = `
<section class="tiles" aria-label="Summary">
  ${tile("Active users", compact(d.activeInWindow), `${range} · ${active.get(d.today) ?? 0} today`, "hero")}
  ${tile("Connected now", compact(connectedTotal), "working connections")}
  ${tile("Tool calls", compact(totalCalls), `${calls.get(d.today) ?? 0} today`)}
  ${tile("Failed calls", totalCalls ? percent(totalFailed / totalCalls) : "–", `${totalFailed} of ${totalCalls}`)}
  ${tile("Sign-ins", compact(signIns.get("connected") ?? 0), `${signIns.get("rejected_key") ?? 0} rejected keys`)}
</section>`;

  const callChart = columnChart({
    title: "Tool calls per day",
    days,
    series: [
      { label: "Succeeded", color: "var(--ok)", values: new Map(days.map((day) => [day, (calls.get(day) ?? 0) - (failures.get(day) ?? 0)])) },
      { label: "Failed", color: "var(--failed)", values: failures },
    ],
  });
  const activeChart = columnChart({
    title: "Active users per day",
    days,
    series: [{ label: "Active users", color: "var(--ok)", values: active }],
  });

  const tools = toolRows(d.counts);
  const toolTable = tools.length
    ? `<table><thead><tr><th>Tool</th><th class="n">Calls</th><th class="n">Failed</th><th class="n">Avg time</th></tr></thead><tbody>${tools
        .map((t) => `<tr><td><code>${escapeHtml(t.tool)}</code></td><td class="n">${t.calls}</td><td class="n">${t.failed ? `${t.failed} (${percent(t.failed / t.calls)})` : "0"}</td><td class="n">${seconds(t.ms / t.calls)}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="empty">No tool calls ${range}.</p>`;

  const appTable = connected.length
    ? simpleTable(["App", "Connections"], connected.map((c) => [escapeHtml(c.app), String(c.count)]))
    : `<p class="empty">Nobody is connected.</p>`;
  const outcomeTable = simpleTable(["Outcome", "Calls"], Object.entries(OUTCOMES).map(([key, label]) => [label, String(perLabel(d.counts, "tool_outcome").get(key) ?? 0)]));
  const signInTable = simpleTable(
    ["Sign-in page", "Count"],
    [...Object.entries(SIGN_INS).map(([key, label]) => [label, String(signIns.get(key) ?? 0)]), ["Revoked after the portal refused a stored key", String(revoked)]],
  );

  const body = `
<header>
  <div>
    <h1>IIITH Mess MCP</h1>
    <p>${escapeHtml(d.host)} · updated ${istTime(d.now)} IST · refreshes every ${REFRESH_SECONDS / 60} minutes</p>
  </div>
  <div class="controls">
    <nav aria-label="Time range">${WINDOWS.map((w) => `<a href="?days=${w}"${w === d.days ? ' aria-current="page"' : ""}>${w} days</a>`).join("")}</nav>
    <form method="post" action="/dashboard/sign-out"><button type="submit">Sign out</button></form>
  </div>
</header>
${tiles}
<section class="panel">${callChart}</section>
<section class="panel">${activeChart}</section>
<div class="grid2">
  <section class="panel"><h2>Tools ${range}</h2><div class="scroll">${toolTable}</div></section>
  <div class="stack">
    <section class="panel"><h2>Connected apps</h2>${appTable}</section>
    <section class="panel"><h2>Call outcomes ${range}</h2>${outcomeTable}</section>
    <section class="panel"><h2>Sign-ins ${range}</h2>${signInTable}</section>
  </div>
</div>
<section class="panel">
  <h2 style="margin-bottom:10px">Server</h2>
  <dl>
    <dt>Mess portal</dt><dd>${portalStatus(d.portal, d.now)}</dd>
    <dt>Version</dt><dd>${escapeHtml(d.version)}</dd>
    <dt>Up for</dt><dd>${duration(d.now - d.startedAt)}</dd>
    <dt>Memory</dt><dd>${Math.round(d.rssBytes / 1024 / 1024)} MB</dd>
    <dt>Node.js</dt><dd>${escapeHtml(process.version)}</dd>
  </dl>
</section>
<p class="fine">Users are counted per connection, so someone using two apps counts twice. Days are IST. Only totals are kept: no keys, tokens, names or meal data.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="${REFRESH_SECONDS}">
<title>Mess MCP metrics</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

interface Series {
  label: string;
  color: string;
  values: Map<string, number>;
}

// Stacked columns, one per day, bottom series first. Two or more series get a legend.
function columnChart({ title, days, series }: { title: string; days: string[]; series: Series[] }): string {
  const totals = days.map((day) => series.reduce((n, s) => n + (s.values.get(day) ?? 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const legend = series.length > 1 ? `<div class="legend">${series.map((s) => `<span style="--swatch:${s.color}">${s.label}</span>`).join("")}</div>` : "";
  const ticks = [max, max / 2, 0].map((v) => `<div class="tick${v === 0 ? " base" : ""}" style="bottom:${(v / max) * 100}%"><span>${compact(v)}</span></div>`).join("");

  const columns = days
    .map((day, i) => {
      const values = series.map((s) => s.values.get(day) ?? 0);
      const tip = [longDay(day), ...series.map((s, j) => `${s.label}: ${values[j]}`)].join("\n");
      const segments = series
        .map((s, j) => (values[j] > 0 ? `<span class="seg" style="--swatch:${s.color};flex-grow:${values[j]}"></span>` : ""))
        .join("");
      return `<li title="${escapeHtml(tip)}">${totals[i] > 0 ? `<span class="bar" style="height:${(totals[i] / max) * 100}%">${segments}</span>` : ""}</li>`;
    })
    .join("");

  const labelled = [...new Set([0, Math.floor(days.length / 2), days.length - 1])];
  const xaxis = labelled.map((i) => `<span style="left:${((i + 0.5) / days.length) * 100}%">${shortDay(days[i])}</span>`).join("");

  const tableRows = days
    .map((day) => [shortDay(day), ...series.map((s) => String(s.values.get(day) ?? 0))])
    .reverse();

  return `
<figure style="margin:0">
  <div class="chart-head"><h2>${title}</h2>${legend}</div>
  <div class="plot" role="img" aria-label="${escapeHtml(title)}, ${days.length} days, peak ${Math.max(0, ...totals)}">
    ${ticks}
    <ol class="cols" style="--gap:${days.length > 45 ? 1 : 2}px">${columns}</ol>
  </div>
  <div class="xaxis" aria-hidden="true">${xaxis}</div>
  <details><summary>Show as table</summary><div class="scroll">${simpleTable(["Day", ...series.map((s) => s.label)], tableRows)}</div></details>
</figure>`;
}

function tile(label: string, value: string, sub: string, kind = ""): string {
  return `<div class="panel tile ${kind}"><span class="label">${escapeHtml(label)}</span><span class="value">${value}</span><span class="sub">${escapeHtml(sub)}</span></div>`;
}

// The portal's state is only known from real calls: whichever happened last, a reply or a failure to connect
function portalStatus(portal: PortalHealth, now: number): string {
  const { lastReachedAt: ok, lastUnreachableAt: down } = portal;
  const since = down !== undefined ? ` · last unreachable ${ago(now - down)}` : "";
  if (down !== undefined && (ok === undefined || down > ok)) return `<span class="status critical"><span class="icon" aria-hidden="true">▲</span>Unreachable</span>${since}`;
  if (ok !== undefined) return `<span class="status good"><span class="icon" aria-hidden="true">●</span>Reachable</span>${since}`;
  return `<span class="status unknown"><span class="icon" aria-hidden="true">○</span>No calls since start</span>`;
}

function simpleTable(head: string[], rows: string[][]): string {
  return `<table><thead><tr>${head.map((h, i) => `<th${i ? ' class="n"' : ""}>${h}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="n"' : ""}>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function toolRows(counts: DailyCount[]) {
  const calls = perLabel(counts, "tool_calls");
  const failed = perLabel(counts, "tool_failures");
  const ms = perLabel(counts, "tool_ms");
  return [...calls]
    .map(([tool, n]) => ({ tool, calls: n, failed: failed.get(tool) ?? 0, ms: ms.get(tool) ?? 0 }))
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
}

// Dynamically registered clients get a new ID per registration, so group by what users would call the app
export function connectionsByApp(connections: ConnectionCount[]): { app: string; count: number }[] {
  const byApp = new Map<string, number>();
  for (const c of connections) {
    const app = displayName(c);
    byApp.set(app, (byApp.get(app) ?? 0) + c.count);
  }
  return [...byApp].map(([app, count]) => ({ app, count })).sort((a, b) => b.count - a.count);
}

function perDay(counts: DailyCount[], name: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of counts) if (c.name === name) out.set(c.day, (out.get(c.day) ?? 0) + c.value);
  return out;
}

function perLabel(counts: DailyCount[], name: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of counts) if (c.name === name) out.set(c.label, (out.get(c.label) ?? 0) + c.value);
  return out;
}

function total(counts: DailyCount[], name: string): number {
  return counts.reduce((n, c) => (c.name === name ? n + c.value : n), 0);
}

/** Smallest of 2, 4, 6, 8, 10 × a power of ten that fits the value, so the half-way tick is a round number too. */
function niceMax(value: number): number {
  if (value <= 2) return 2;
  for (let power = 10 ** Math.floor(Math.log10(value) - 1); ; power *= 10) {
    for (const m of [2, 4, 6, 8, 10]) if (m * power >= value) return m * power;
  }
}

const compactFormat = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const compact = (n: number) => compactFormat.format(n);
const percent = (fraction: number) => `${(fraction * 100).toFixed(fraction < 0.1 ? 1 : 0)}%`;
const seconds = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

const dayFormat = (options: Intl.DateTimeFormatOptions) => {
  const format = new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" });
  return (day: string) => format.format(new Date(`${day}T00:00:00Z`));
};
const shortDay = dayFormat({ day: "numeric", month: "short" });
const longDay = dayFormat({ weekday: "short", day: "numeric", month: "short" });
const istTime = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(ms);

function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} days ${hours % 24} h`;
}

function ago(ms: number): string {
  return ms < 60_000 ? "just now" : `${duration(ms)} ago`;
}
