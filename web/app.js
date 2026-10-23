(() => {
"use strict";

/* ===== Server state ===== */
let D = null, META, DAYS, WIN, START, W0, P0, A, byId, flagsOf, DARK, LEADS, leadsOf, METRO_CPL, METROS, totals, cur, prv, activeCount, tasksOf;

function ingest(data) {
  D = data; META = D.meta; DAYS = META.days; WIN = META.window;
  START = new Date(META.start + "T12:00:00");
  W0 = DAYS - WIN; P0 = DAYS - 2 * WIN;
  A = D.accounts;
  A.forEach((a, i) => { a.i = i; a.daily = D.daily[i]; });
  byId = Object.fromEntries(A.map(a => [a.account_id, a]));
  flagsOf = {}; D.flags.forEach(f => (flagsOf[f.account_id] ||= []).push(f));
  DARK = Object.fromEntries(D.dark.map(d => [d.account_id, d]));
  LEADS = D.leads.map(r => ({ id: r[0], a: A[r[1]], day: r[2], hour: r[3], type: r[4], cat: r[5], charged: !!r[6], cost: r[7],
    status: r[8], rating: r[9], ratingSrc: r[10], secs: r[11], dispute: r[12], dstatus: r[13] }));
  leadsOf = {}; LEADS.forEach(l => (leadsOf[l.a.account_id] ||= []).push(l));
  tasksOf = {}; D.tasks.forEach(t => (tasksOf[t.account_id] ||= []).push(t));
  METRO_CPL = D.metro_cpl; METROS = Object.keys(METRO_CPL).sort();
  totals = Array.from({ length: DAYS }, (_, d) => {
    const t = { imp: 0, leads: 0, charged: 0, cost: 0, active: 0 };
    A.forEach(a => { const r = a.daily[d]; if (r) { t.imp += r[0]; t.leads += r[1]; t.charged += r[2]; t.cost += r[3]; if (r[0] > 0) t.active++; } });
    return t;
  });
  const sumT = (from, to, k) => { let s = 0; for (let d = from; d < to; d++) s += totals[d][k]; return s; };
  cur = { cost: sumT(W0, DAYS, "cost"), leads: sumT(W0, DAYS, "leads"), charged: sumT(W0, DAYS, "charged"), imp: sumT(W0, DAYS, "imp") };
  prv = { cost: sumT(P0, W0, "cost"), leads: sumT(P0, W0, "leads"), charged: sumT(P0, W0, "charged"), imp: sumT(P0, W0, "imp") };
  activeCount = A.filter(a => a.status === "ACTIVE").length;
}

let busyN = 0;
function busy(on) {
  busyN += on ? 1 : -1;
  let el = document.querySelector(".busy");
  if (busyN > 0 && !el) { el = document.createElement("div"); el.className = "busy"; document.body.append(el); }
  if (busyN <= 0 && el) el.remove();
}
async function load() {
  const r = await fetch("/api/state", { cache: "no-store" });
  if (!r.ok) throw new Error("Could not load data from the server");
  ingest(await r.json());
}
async function api(path, body = {}, { quiet = false, reload = true } = {}) {
  if (!quiet) busy(true);
  try {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `Request failed (${r.status})`);
    if (reload) { await load(); refresh(); }
    return out;
  } catch (e) { toast(e.message); throw e; }
  finally { if (!quiet) busy(false); }
}

/* ===== Format ===== */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n, d = 0) => n == null || !isFinite(n) ? "–" : (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const kmoney = n => n >= 1e6 ? "$" + (n / 1e6).toFixed(2) + "M" : n >= 1e4 ? "$" + (n / 1e3).toFixed(1) + "k" : money(n);
const num = n => n == null ? "–" : Math.round(n).toLocaleString("en-US");
const pct = (x, d = 0) => x == null || !isFinite(x) ? "–" : (x * 100).toFixed(d) + "%";
const dayDate = i => new Date(START.getTime() + i * 864e5);
const fdate = i => dayDate(i).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const fdateLong = i => dayDate(i).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const fiso = s => new Date(s + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const ftime = d => new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
const fmtField = (f, v) => v == null ? "–" : f === "weekly_budget" || f === "max_per_lead" ? money(v) : f === "service_zips" ? `${Math.round(v)} ZIPs` : `${Math.round(v)} h/wk`;
const deltaHtml = (c, p, goodUp = true) => {
  if (!p) return `<span>no prior data</span>`;
  const ch = (c - p) / p, good = goodUp ? ch >= 0 : ch <= 0;
  return `<span class="${Math.abs(ch) < 0.005 ? "" : good ? "delta-up" : "delta-down"}">${ch >= 0 ? "▲" : "▼"} ${Math.abs(ch * 100).toFixed(1)}%</span> vs prior 14 days`;
};
const stars = (r, n) => `<span class="stars"><i>★</i> ${Number(r).toFixed(1)} <span class="idc">(${n})</span></span>`;
const statusPill = s => s === "ACTIVE" ? `<span class="pill good">Active</span>` : s === "PAUSED" ? `<span class="pill mute">Paused</span>` : `<span class="pill crit">Suspended</span>`;
const sevPill = s => s === "critical" ? `<span class="pill crit">Critical</span>` : s === "warn" ? `<span class="pill warn">Warning</span>` : `<span class="pill info">Info</span>`;
const decisionPill = (d, applied) => ({
  applied: `<span class="pill good">Applied</span>`, dry_run: `<span class="pill mute">Dry run</span>`,
  needs_approval: `<span class="pill info">Needs approval</span>`, approved: applied ? `<span class="pill good">Approved · applied</span>` : `<span class="pill good">Approved · dry run</span>`,
  rejected: `<span class="pill mute">Rejected</span>`, blocked: `<span class="pill warn">Blocked · daily limit</span>`,
  ok: META.write_mode === "apply" ? `<span class="pill good">Within cap · applies</span>` : `<span class="pill mute">Within cap · dry run</span>`,
  noop: `<span class="pill mute">No change</span>`, already_pending: `<span class="pill info">Already pending</span>`,
}[d] || `<span class="pill mute">${esc(d)}</span>`);
const ICONS = {
  overview: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM13 3v6h8V3zM3 21h8v-6H3z"/>',
  accounts: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  health: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  diagnosis: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M11 8v3M11 14h.01"/>',
  leads: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.18 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.1 9.9a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
  changes: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  automation: '<path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/><circle cx="12" cy="12" r="3"/>',
  log: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  report: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>',
  about: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  theme: '<path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  play: '<path d="M6 4l14 8-14 8z"/>', next: '<path d="M5 4l10 8-10 8zM19 5v14"/>',
};
const icon = n => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[n] || ""}</svg>`;

/* ===== Toast / copy ===== */
let toastT;
function toast(msg) {
  let el = document.querySelector(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status"); document.body.append(el); }
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => el.hidden = true, 3200);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied to clipboard"); }
  catch (e) { const ta = document.createElement("textarea"); ta.value = text; document.body.append(ta); ta.select(); try { document.execCommand("copy"); toast("Copied to clipboard"); } catch (_) { toast("Select the text and copy it manually"); } ta.remove(); }
}

/* ===== Charts ===== */
function niceStep(max, n = 4) {
  const raw = max / n, mag = Math.pow(10, Math.floor(Math.log10(raw || 1))), f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
}
function timeChart(el, o) {
  if (!el) return;
  const Wd = Math.max(260, el.clientWidth || 600), H = o.height || 200;
  const m = { l: 46, r: 14, t: 12, b: 26 };
  const v = o.values, n = v.length, pw = Wd - m.l - m.r, ph = H - m.t - m.b;
  const top = Math.max(...v.map(x => x ?? 0), o.ref || 0) * 1.08 || 1;
  const step = o.bars ? Math.max(1, Math.ceil(niceStep(top))) : niceStep(top), max = Math.ceil(top / step) * step;
  const bw = pw / n;
  const x = i => o.bars ? m.l + bw * i + bw / 2 : m.l + (n === 1 ? 0 : i * pw / (n - 1));
  const y = val => m.t + ph * (1 - val / max);
  let g = "";
  for (let t = 0; t <= max + 1e-9; t += step) g += `<line class="grid-l" x1="${m.l}" x2="${Wd - m.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis-t" x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${o.fmtAxis ? o.fmtAxis(t) : num(t)}</text>`;
  const every = Math.ceil(n / Math.max(2, Math.floor(pw / 70)));
  for (let i = n - 1; i >= 0; i -= every) g += `<text class="axis-t" x="${x(i)}" y="${H - 6}" text-anchor="middle">${o.labels[i]}</text>`;
  let marks = "";
  if (o.bars) {
    const w = Math.max(1.5, bw - 2);
    v.forEach((val, i) => { if (val) marks += `<rect x="${x(i) - w / 2}" y="${y(val)}" width="${w}" height="${ph * val / max}" rx="${Math.min(2, w / 2)}" fill="${o.color}"/>`; });
  } else {
    const pts = v.map((val, i) => [x(i), y(val ?? 0)]);
    const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join("");
    marks += `<path d="${line}L${pts[n - 1][0]} ${y(0)}L${pts[0][0]} ${y(0)}Z" fill="${o.color}" opacity=".10"/><path d="${line}" fill="none" stroke="${o.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    const lp = pts[n - 1];
    marks += `<circle cx="${lp[0]}" cy="${lp[1]}" r="4" fill="${o.color}" stroke="var(--surface)" stroke-width="2"/>`;
  }
  if (o.ref) marks += `<line x1="${m.l}" x2="${Wd - m.r}" y1="${y(o.ref)}" y2="${y(o.ref)}" stroke="var(--ink-2)" stroke-width="1.5" stroke-dasharray="4 4"/><text class="axis-t" x="${Wd - m.r}" y="${y(o.ref) - 5}" text-anchor="end">${esc(o.refLabel)}</text>`;
  el.innerHTML = `<svg viewBox="0 0 ${Wd} ${H}" height="${H}" role="img" aria-label="${esc(o.aria)}">${g}${marks}<line class="xh" x1="0" x2="0" y1="${m.t}" y2="${m.t + ph}" stroke="var(--ink-2)" stroke-width="1" opacity="0"/><circle class="xd" r="4.5" fill="${o.color}" stroke="var(--surface)" stroke-width="2" opacity="0"/><rect x="${m.l}" y="0" width="${pw}" height="${H}" fill="transparent" class="hit"/></svg><div class="tip" hidden></div>`;
  const svg = el.querySelector("svg"), tip = el.querySelector(".tip"), xh = svg.querySelector(".xh"), xd = svg.querySelector(".xd");
  const hit = svg.querySelector(".hit");
  hit.addEventListener("pointermove", ev => {
    const r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) * Wd / r.width;
    const i = Math.max(0, Math.min(n - 1, o.bars ? Math.floor((px - m.l) / bw) : Math.round((px - m.l) / pw * (n - 1))));
    const cx = x(i), cy = y(v[i] ?? 0);
    xh.setAttribute("x1", cx); xh.setAttribute("x2", cx); xh.setAttribute("opacity", ".35");
    if (!o.bars) { xd.setAttribute("cx", cx); xd.setAttribute("cy", cy); xd.setAttribute("opacity", "1"); }
    tip.hidden = false;
    tip.innerHTML = `<b>${o.fmt(v[i] ?? 0)}</b><span class="k">${esc(o.tipLabels ? o.tipLabels[i] : o.labels[i])}${o.tipExtra ? " · " + o.tipExtra(i) : ""}</span>`;
    tip.style.left = (cx * r.width / Wd) + "px"; tip.style.top = (cy * r.height / H) + "px";
  });
  hit.addEventListener("pointerleave", () => { tip.hidden = true; xh.setAttribute("opacity", "0"); xd.setAttribute("opacity", "0"); });
}
function scatter(el, pts, o) {
  if (!el || !pts.length) return;
  const Wd = Math.max(260, el.clientWidth || 600), H = o.height || 300;
  const m = { l: 50, r: 16, t: 14, b: 40 }, pw = Wd - m.l - m.r, ph = H - m.t - m.b;
  const xmax = Math.max(...pts.map(p => p.x)) * 1.05, ymax = Math.max(...pts.map(p => p.y)) * 1.08;
  const xs = niceStep(xmax, 5), ys = niceStep(ymax, 4), X = Math.ceil(xmax / xs) * xs, Y = Math.ceil(ymax / ys) * ys;
  const x = v => m.l + pw * v / X, y = v => m.t + ph * (1 - v / Y);
  let g = "";
  for (let t = 0; t <= Y + 1e-9; t += ys) g += `<line class="grid-l" x1="${m.l}" x2="${Wd - m.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis-t" x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${(t * 100).toFixed(1)}%</text>`;
  for (let t = 0; t <= X + 1e-9; t += xs) g += `<text class="axis-t" x="${x(t)}" y="${H - 22}" text-anchor="middle">${num(t)}</text>`;
  g += `<text class="axis-t" x="${m.l + pw / 2}" y="${H - 4}" text-anchor="middle">Impressions, last 14 days</text>`;
  g += `<rect x="${x(o.xRef)}" y="${y(o.yRef)}" width="${Math.max(0, Wd - m.r - x(o.xRef))}" height="${m.t + ph - y(o.yRef)}" fill="var(--crit)" opacity=".06"/>`;
  g += `<line x1="${x(o.xRef)}" x2="${x(o.xRef)}" y1="${m.t}" y2="${m.t + ph}" stroke="var(--ink-2)" stroke-dasharray="4 4" opacity=".6"/><line x1="${m.l}" x2="${Wd - m.r}" y1="${y(o.yRef)}" y2="${y(o.yRef)}" stroke="var(--ink-2)" stroke-dasharray="4 4" opacity=".6"/>`;
  g += `<text class="axis-t" x="${Wd - m.r - 4}" y="${y(o.yRef) - 6}" text-anchor="end">Showing, few leads</text>`;
  let dots = "";
  pts.filter(p => !p.hl).concat(pts.filter(p => p.hl)).forEach(p => {
    dots += `<circle data-id="${p.id}" cx="${x(p.x)}" cy="${y(p.y)}" r="${p.hl ? 5 : 4}" fill="${p.hl ? "var(--s-leads)" : "var(--s-dim)"}" stroke="var(--surface)" stroke-width="1.5" style="cursor:pointer"/>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${Wd} ${H}" height="${H}" role="img" aria-label="${esc(o.aria)}">${g}${dots}</svg><div class="tip" hidden></div>`;
  const svg = el.querySelector("svg"), tip = el.querySelector(".tip");
  svg.querySelectorAll("circle[data-id]").forEach(c => {
    const p = pts.find(q => q.id === c.dataset.id);
    c.addEventListener("pointerenter", () => {
      const r = svg.getBoundingClientRect(); tip.hidden = false;
      tip.innerHTML = `<b>${esc(p.label)}</b><span class="k">${num(p.x)} impressions · ${(p.y * 100).toFixed(2)}% lead rate</span>`;
      tip.style.left = (x(p.x) * r.width / Wd) + "px"; tip.style.top = (y(p.y) * r.height / H) + "px";
    });
    c.addEventListener("pointerleave", () => tip.hidden = true);
    c.addEventListener("click", () => openAccount(p.id));
  });
}
const hbars = (rows, o = {}) => {
  const max = o.max || Math.max(...rows.map(r => r.v)) || 1;
  return rows.map(r => `<div class="hbar"><span>${esc(r.label)}</span><div class="track"><span style="width:${(r.v / max * 100).toFixed(1)}%;background:${r.color || "var(--s-spend)"}"></span>${r.ref ? `<i class="median" style="left:${(r.ref / max * 100).toFixed(1)}%"></i>` : ""}</div><span class="num" style="text-align:right">${r.text}</span></div>`).join("");
};

/* ===== Shell ===== */
const VIEWS = [
  ["overview", "Overview"], ["accounts", "Accounts"], ["health", "Health"], ["diagnosis", "Showing, no leads"],
  ["leads", "Lead quality"], ["changes", "Changes"], ["automation", "Automation"], ["log", "Activity log"], ["report", "Weekly report"], ["about", "How it works"],
];
const main = document.getElementById("main"), layer = document.getElementById("layer");
let current = "overview", openId = null;
const pendingProps = () => D.proposals.filter(p => p.decision === "needs_approval");
const disputeQueue = () => LEADS.filter(l => l.day >= W0 && l.dispute && l.charged && !l.dstatus);
const winLabel = () => `Last 14 days · ${fdate(W0)} – ${fdate(DAYS - 1)}`;

function renderNav() {
  const crit = new Set(D.flags.filter(f => f.severity === "critical" && !f.acked).map(f => f.account_id)).size;
  const c = { accounts: [A.length], health: [crit, 1], diagnosis: [D.dark.length], leads: [disputeQueue().length], changes: [pendingProps().length, pendingProps().length > 0] };
  document.getElementById("nav").innerHTML = VIEWS.map(([id, label], i) =>
    (i === 0 ? `<div class="nav-label">Program</div>` : i === 6 ? `<div class="nav-label">Operations</div>` : "") +
    `<a href="#${id}" ${id === current ? 'aria-current="page"' : ""}>${icon(id)}<span>${label}</span>${c[id] ? `<span class="count ${c[id][1] ? "hot" : ""}">${c[id][0]}</span>` : ""}</a>`).join("");
  renderAuto();
}
function renderAuto() {
  const lr = D.runs[0];
  const ap = META.autopilot_secs;
  document.getElementById("auto-panel").innerHTML = `
    <div><span class="live ${ap ? "on" : ""}"></span>${ap ? `Autopilot · every ${ap}s` : "Autopilot off"}</div>
    <div class="day">${fiso(META.today)}</div>
    <div>Data through ${fdate(DAYS - 1)} · last run ${lr ? new Date(lr.ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" }) : "–"}</div>
    <div class="row2"><button class="btn sm" id="ap-run" title="Run checks, diagnosis and recommendations on current data">${icon("play")}Run</button><button class="btn sm primary" id="ap-next" title="Simulate the next day, then run the pipeline">${icon("next")}Next day</button></div>
    <label class="field" style="color:var(--ink-2)">Autopilot<select id="ap-secs">${[[0, "Off"], [10, "Next day every 10s"], [30, "Next day every 30s"], [60, "Next day every 60s"], [300, "Next day every 5 min"]].map(([v, l]) => `<option value="${v}" ${ap == v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <div class="env">Demo environment · ${A.length} synthetic accounts</div>`;
  document.getElementById("ap-run").onclick = async () => { const s = await api("/api/run"); toast(`Pipeline ran: ${s.flags} flags, ${s.dark} showing without leads, ${s.applied + s.dry_run} changes within cap, ${s.needs_approval} for approval`); };
  document.getElementById("ap-next").onclick = async () => { const s = await api("/api/advance", { days: 1 }); toast(`New day simulated and pipeline ran: ${s.new_flags} new flags, ${s.cleared} cleared`); };
  document.getElementById("ap-secs").onchange = e => api("/api/settings", { autopilot_secs: Number(e.target.value) }).then(() => toast(Number(e.target.value) ? "Autopilot on" : "Autopilot off"));
}
function topbar(title, sub) {
  return `<div class="topbar"><div><h1>${title}</h1><div class="sub">${sub}</div></div><span class="spacer"></span>
    <div class="search">${icon("search")}<input id="acct-search" type="search" placeholder="Find agent, team or account ID" autocomplete="off" aria-label="Find an account"><div class="search-results" hidden></div></div>
    <button class="icon-btn" id="theme-btn" title="Switch theme" aria-label="Switch theme">${icon("theme")}</button></div>`;
}
function wireCommon() {
  const inp = document.getElementById("acct-search"), box = main.querySelector(".search-results");
  if (inp) {
    let sel = 0, hits = [];
    const draw = () => {
      const q = inp.value.trim().toLowerCase();
      if (!q) { box.hidden = true; return; }
      hits = A.filter(a => (a.name + " " + a.business + " " + a.account_id + " " + a.metro).toLowerCase().includes(q)).slice(0, 8);
      box.innerHTML = hits.length ? hits.map((a, i) => `<button data-id="${a.account_id}" class="${i === sel ? "on" : ""}"><span>${esc(a.name)}</span><span class="idc">${a.account_id} · ${esc(a.metro)}</span></button>`).join("") : `<div class="empty">No account matches “${esc(inp.value)}”</div>`;
      box.hidden = false;
      box.querySelectorAll("button").forEach(b => b.onmousedown = () => { box.hidden = true; inp.value = ""; openAccount(b.dataset.id); });
    };
    inp.addEventListener("input", () => { sel = 0; draw(); });
    inp.addEventListener("keydown", e => {
      if (e.key === "ArrowDown") { sel = Math.min(hits.length - 1, sel + 1); draw(); e.preventDefault(); }
      if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
      if (e.key === "Enter" && hits[sel]) { box.hidden = true; const id = hits[sel].account_id; inp.value = ""; openAccount(id); }
      if (e.key === "Escape") box.hidden = true;
    });
    inp.addEventListener("blur", () => setTimeout(() => box.hidden = true, 150));
  }
  const tb = document.getElementById("theme-btn");
  if (tb) tb.onclick = () => {
    const root = document.documentElement, t = root.dataset.theme;
    const dark = t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("lsa-ops-theme", root.dataset.theme); } catch (e) {}
    refresh();
  };
  main.querySelectorAll("[data-open]").forEach(el => el.addEventListener("click", e => { e.stopPropagation(); openAccount(el.dataset.open); }));
}

/* ===== Overview ===== */
function viewOverview() {
  const flagged = new Set(D.flags.filter(f => f.severity !== "info").map(f => f.account_id));
  const critAcc = new Set(D.flags.filter(f => f.severity === "critical").map(f => f.account_id));
  const waiting = D.new_agents.filter(n => n.days_to_first_lead == null);
  const cpl = cur.cost / cur.charged, pcpl = prv.cost / prv.charged;
  const metroRows = METROS.map(m => {
    const as = A.filter(a => a.metro === m);
    const cost = as.reduce((s, a) => s + a.cost, 0), ch = as.reduce((s, a) => s + a.charged, 0), le = as.reduce((s, a) => s + a.leads, 0);
    return { m, n: as.length, cost, ch, le, cpl: ch ? cost / ch : 0 };
  }).sort((a, b) => b.cost - a.cost);
  const med = (() => { const v = metroRows.map(r => r.cpl).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; })();
  const topCrit = D.flags.filter(f => f.severity === "critical" && !f.acked).slice(0, 6);
  const lr = D.runs[0];
  main.innerHTML = topbar("Program overview", winLabel()) + `
  <div class="kpis">
    <div class="kpi"><div class="l">Spend</div><div class="v">${kmoney(cur.cost)}</div><div class="d">${deltaHtml(cur.cost, prv.cost)}</div></div>
    <div class="kpi"><div class="l">Leads</div><div class="v">${num(cur.leads)}</div><div class="d">${deltaHtml(cur.leads, prv.leads)}</div></div>
    <div class="kpi"><div class="l">Cost per charged lead</div><div class="v">${money(cpl, 2)}</div><div class="d">${deltaHtml(cpl, pcpl, false)}</div></div>
    <div class="kpi"><div class="l">Active accounts</div><div class="v">${activeCount}<span style="font-size:15px;color:var(--muted);font-weight:500"> / ${A.length}</span></div><div class="d">${A.length - activeCount} paused or suspended</div></div>
    <div class="kpi alert"><div class="l">Accounts needing attention</div><div class="v">${flagged.size}</div><div class="d"><span class="delta-down">${critAcc.size} critical</span> · ${flagged.size - critAcc.size} warnings only</div></div>
  </div>
  <div class="grid g-2">
    <div class="panel"><div class="panel-h"><h2>Daily spend</h2><span class="hint">All accounts · ${DAYS} days</span></div><div class="panel-b"><div class="chart" id="ch-spend"></div></div></div>
    <div class="panel"><div class="panel-h"><h2>Daily leads</h2><span class="hint">All accounts · ${DAYS} days</span></div><div class="panel-b"><div class="chart" id="ch-leads"></div></div></div>
  </div>
  <div class="grid g-21 section-gap">
    <div class="panel"><div class="panel-h"><h2>Critical right now</h2><span class="hint">From the latest pipeline run</span><div class="right"><a class="btn sm" href="#health">All ${D.flags.length} flags</a></div></div>
      <div class="panel-b"><div class="qlist">${topCrit.map(f => { const a = byId[f.account_id]; return `<div class="qitem">${sevPill(f.severity)}<div><div class="t">${esc(a.name)} · ${esc(f.check)}</div><div class="s">${esc(f.detail)} → ${esc(f.action)}</div></div><button class="btn sm" data-open="${a.account_id}">Open</button></div>`; }).join("") || `<div class="empty">No open critical flags</div>`}</div></div></div>
    <div class="panel"><div class="panel-h"><h2>Today's queue</h2></div><div class="panel-b">
      <div class="stat-line"><span>Changes awaiting approval</span><b>${pendingProps().length}</b></div>
      <div class="stat-line"><span>Accounts showing without leads</span><b>${D.dark.length}</b></div>
      <div class="stat-line"><span>Leads ready to dispute</span><b>${disputeQueue().length}</b></div>
      <div class="stat-line"><span>Open fix tasks</span><b>${D.tasks.filter(t => t.status === "open").length}</b></div>
      <div class="stat-line"><span>New agents waiting on first lead</span><b>${waiting.length}</b></div>
      ${lr ? `<p class="note" style="margin:10px 0 0">Last run ${ftime(lr.ts)} (${esc(lr.trigger)}): ${lr.summary.new_flags} new flags, ${lr.summary.cleared} cleared, ${lr.summary.applied + lr.summary.dry_run} changes within cap, ${lr.summary.needs_approval} sent for approval.</p>` : ""}
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><a class="btn primary" href="#changes">Review changes</a><a class="btn" href="#diagnosis">Diagnose accounts</a></div>
    </div></div>
  </div>
  <div class="grid g-2 section-gap">
    <div class="panel"><div class="panel-h"><h2>Cost per lead by metro</h2><span class="hint">Marker: program median, ${money(med, 2)}. Orange: more than 10% above it.</span></div><div class="panel-b">
      ${hbars(metroRows.map(r => ({ label: r.m, v: r.cpl, ref: med, text: money(r.cpl, 2), color: r.cpl > med * 1.1 ? "var(--s-leads)" : "var(--s-spend)" })), { max: Math.max(...metroRows.map(r => r.cpl)) * 1.1 })}
    </div></div>
    <div class="panel"><div class="panel-h"><h2>Metros</h2><span class="hint">${winLabel()}</span></div><div class="panel-b tbl-wrap"><table>
      <thead><tr><th>Metro</th><th class="r">Accounts</th><th class="r">Spend</th><th class="r">Leads</th><th class="r">CPL</th></tr></thead>
      <tbody>${metroRows.map(r => `<tr class="click" data-metro="${esc(r.m)}"><td>${esc(r.m)}</td><td class="r">${r.n}</td><td class="r">${money(r.cost)}</td><td class="r">${num(r.le)}</td><td class="r">${money(r.cpl, 2)}</td></tr>`).join("")}</tbody></table></div></div>
  </div>
  <div class="panel section-gap"><div class="panel-h"><h2>New agents</h2><span class="hint">Accounts under 30 days old · speed to first lead</span></div><div class="panel-b tbl-wrap"><table>
    <thead><tr><th>Agent</th><th>Metro</th><th class="r">Account age</th><th>First lead</th><th>Verification</th><th class="r">Leads 14d</th></tr></thead>
    <tbody>${D.new_agents.map(n => { const a = byId[n.account_id]; return `<tr class="click" data-open="${a.account_id}"><td class="who"><b>${esc(a.name)}</b><span>${esc(a.business)}</span></td><td>${esc(a.metro)}</td><td class="r">${n.age_days} days</td><td>${n.days_to_first_lead == null ? `<span class="pill warn">Waiting</span>` : `<span class="pill good">Day ${n.days_to_first_lead}</span>`}</td><td>${a.license === "VERIFIED" && a.background === "CLEARED" ? `<span class="pill good">Verified</span>` : `<span class="pill crit">Pending</span>`}</td><td class="r">${a.leads}</td></tr>`; }).join("") || `<tr><td colspan="6" class="empty">No accounts under 30 days old</td></tr>`}</tbody></table></div></div>`;
  const labels = Array.from({ length: DAYS }, (_, i) => fdate(i)), tips = Array.from({ length: DAYS }, (_, i) => fdateLong(i));
  timeChart(document.getElementById("ch-spend"), { values: totals.map(t => t.cost), labels, tipLabels: tips, color: "var(--s-spend)", fmt: v => money(v), fmtAxis: v => kmoney(v), aria: "Daily spend across all accounts", tipExtra: i => `${totals[i].active} accounts serving` });
  timeChart(document.getElementById("ch-leads"), { values: totals.map(t => t.leads), labels, tipLabels: tips, color: "var(--s-leads)", fmt: v => num(v) + " leads", aria: "Daily leads across all accounts", tipExtra: i => `${money(totals[i].cost / Math.max(1, totals[i].charged), 2)} CPL` });
  main.querySelectorAll("[data-metro]").forEach(r => r.onclick = () => { accState.metro = r.dataset.metro; location.hash = "accounts"; });
}

/* ===== Accounts ===== */
const accState = { q: "", metro: "", status: "", flag: "", sort: "cost", dir: -1, limit: 50 };
function viewAccounts() {
  const st = accState;
  const rows = A.filter(a =>
    (!st.q || (a.name + " " + a.business + " " + a.account_id).toLowerCase().includes(st.q.toLowerCase())) &&
    (!st.metro || a.metro === st.metro) && (!st.status || a.status === st.status) &&
    (!st.flag || (st.flag === "any" ? (flagsOf[a.account_id] || []).some(f => f.severity !== "info") : st.flag === "critical" ? (flagsOf[a.account_id] || []).some(f => f.severity === "critical") : st.flag === "dark" ? DARK[a.account_id] : (flagsOf[a.account_id] || []).some(f => f.check === st.flag))));
  const key = { name: a => a.name, metro: a => a.metro, budget: a => a.weekly_budget, cost: a => a.cost, leads: a => a.leads, cpl: a => a.cpl ?? 1e9, rating: a => a.rating, flags: a => (flagsOf[a.account_id] || []).length, pace: a => a.cost / (a.weekly_budget * 2) }[st.sort];
  rows.sort((x, y) => { const p = key(x), q = key(y); return (p > q ? 1 : p < q ? -1 : 0) * st.dir; });
  const checksList = [...new Set(D.flags.map(f => f.check))].sort();
  const th = (k, label, r) => `<th class="sortable ${r ? "r" : ""}" data-sort="${k}">${label}${st.sort === k ? `<span class="arrow">${st.dir > 0 ? "▲" : "▼"}</span>` : ""}</th>`;
  main.innerHTML = topbar("Accounts", `${rows.length} of ${A.length} accounts · ${winLabel()}`) + `
  <div class="filters">
    <label class="field">Filter<input id="f-q" value="${esc(st.q)}" placeholder="Name, team or ID"></label>
    <label class="field">Metro<select id="f-metro"><option value="">All metros</option>${METROS.map(m => `<option ${st.metro === m ? "selected" : ""}>${m}</option>`).join("")}</select></label>
    <label class="field">Status<select id="f-status"><option value="">Any status</option>${["ACTIVE", "PAUSED", "SUSPENDED"].map(s => `<option value="${s}" ${st.status === s ? "selected" : ""}>${s[0] + s.slice(1).toLowerCase()}</option>`).join("")}</select></label>
    <label class="field">Flags<select id="f-flag"><option value="">All accounts</option><option value="any" ${st.flag === "any" ? "selected" : ""}>Any warning or critical</option><option value="critical" ${st.flag === "critical" ? "selected" : ""}>Critical only</option><option value="dark" ${st.flag === "dark" ? "selected" : ""}>Showing, no leads</option>${checksList.map(c => `<option ${st.flag === c ? "selected" : ""}>${c}</option>`).join("")}</select></label>
    ${st.q || st.metro || st.status || st.flag ? `<button class="btn" id="f-clear">Clear filters</button>` : ""}
  </div>
  <div class="panel"><div class="tbl-wrap"><table>
    <thead><tr>${th("name", "Agent")}${th("metro", "Metro")}<th>Status</th>${th("budget", "Budget / wk", 1)}${th("pace", "Spend vs budget")}${th("leads", "Leads", 1)}${th("cpl", "CPL", 1)}${th("rating", "Rating")}${th("flags", "Flags")}</tr></thead>
    <tbody>${rows.slice(0, st.limit).map(a => {
      const fl = flagsOf[a.account_id] || [], crit = fl.filter(f => f.severity === "critical").length, warn = fl.filter(f => f.severity === "warn").length;
      const pace = a.cost / (a.weekly_budget * 2), m = METRO_CPL[a.metro];
      const ld = a.prev_leads ? (a.leads - a.prev_leads) / a.prev_leads : null;
      return `<tr class="click" data-open="${a.account_id}">
        <td class="who"><b>${esc(a.name)}</b><span>${esc(a.business)} · <span class="idc">${a.account_id}</span></span></td>
        <td>${esc(a.metro)}, ${a.state}</td><td>${statusPill(a.status)}</td><td class="r">${money(a.weekly_budget)}</td>
        <td><div class="pace"><div class="bar ${pace > 1.02 ? "over" : ""}"><span style="width:${Math.min(100, pace * 100).toFixed(0)}%"></span></div><small>${money(a.cost)} · ${pct(pace)}</small></div></td>
        <td class="r">${a.leads}${ld != null && Math.abs(ld) >= 0.15 ? ` <small class="${ld > 0 ? "delta-up" : "delta-down"}">${ld > 0 ? "▲" : "▼"}${Math.abs(ld * 100).toFixed(0)}%</small>` : ""}</td>
        <td class="r">${a.cpl ? money(a.cpl, 2) : "–"}${a.cpl && m && a.cpl > 1.5 * m ? ` <small class="delta-down">high</small>` : ""}</td>
        <td>${stars(a.rating, a.reviews)}</td>
        <td>${crit ? `<span class="pill crit">${crit}</span> ` : ""}${warn ? `<span class="pill warn">${warn}</span>` : ""}${!crit && !warn ? `<span class="pill good">OK</span>` : ""}</td></tr>`;
    }).join("") || `<tr><td colspan="9" class="empty">No accounts match these filters</td></tr>`}</tbody></table></div>
    ${rows.length > st.limit ? `<div class="more"><button class="btn" id="more">Show ${Math.min(50, rows.length - st.limit)} more (${rows.length - st.limit} hidden)</button></div>` : ""}</div>`;
  const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
  on("f-q", "input", e => { st.q = e.target.value; st.limit = 50; const pos = e.target.selectionStart; viewAccounts(); wireCommon(); const el = document.getElementById("f-q"); el.focus(); el.setSelectionRange(pos, pos); });
  on("f-metro", "change", e => { st.metro = e.target.value; st.limit = 50; refresh(); });
  on("f-status", "change", e => { st.status = e.target.value; st.limit = 50; refresh(); });
  on("f-flag", "change", e => { st.flag = e.target.value; st.limit = 50; refresh(); });
  on("f-clear", "click", () => { Object.assign(st, { q: "", metro: "", status: "", flag: "", limit: 50 }); refresh(); });
  on("more", "click", () => { st.limit += 50; refresh(); });
  main.querySelectorAll("th[data-sort]").forEach(t => t.onclick = () => { const k = t.dataset.sort; st.dir = st.sort === k ? -st.dir : (k === "name" || k === "metro" ? 1 : -1); st.sort = k; refresh(); });
}

/* ===== Health ===== */
const healthState = { tab: "flags", check: "", sev: "", showAck: false };
function viewHealth() {
  const st = healthState;
  const counts = {}; D.flags.forEach(f => counts[f.check] = (counts[f.check] || 0) + 1);
  const sevC = { critical: 0, warn: 0, info: 0 }; D.flags.forEach(f => sevC[f.severity]++);
  const order = { critical: 0, warn: 1, info: 2 };
  const rows = D.flags.filter(f => (!st.check || f.check === st.check) && (!st.sev || f.severity === st.sev) && (st.showAck || !f.acked))
    .sort((a, b) => order[a.severity] - order[b.severity] || b.first_seen.localeCompare(a.first_seen));
  const acked = D.flags.filter(f => f.acked).length, open = D.tasks.filter(t => t.status === "open");
  main.innerHTML = topbar("Health monitor", `${D.flags.length} flags from the latest run · ${winLabel()}`) + `
  <div class="tabs" role="tablist"><button role="tab" data-tab="flags" aria-selected="${st.tab === "flags"}">Flags<span class="count">${D.flags.length}</span></button><button role="tab" data-tab="tasks" aria-selected="${st.tab === "tasks"}">Fix tasks<span class="count">${open.length}</span></button></div>
  <div id="h-tab"></div>`;
  const tab = document.getElementById("h-tab");
  if (st.tab === "flags") {
    tab.innerHTML = `<div class="chips" style="margin-bottom:10px">${["critical", "warn", "info"].map(s => `<button class="chip" data-sev="${s}" aria-pressed="${st.sev === s}">${s === "warn" ? "Warning" : s[0].toUpperCase() + s.slice(1)} <b>${sevC[s]}</b></button>`).join("")}</div>
    <div class="chips" style="margin-bottom:14px">${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([c, n]) => `<button class="chip" data-check="${esc(c)}" aria-pressed="${st.check === c}">${esc(c)} <b>${n}</b></button>`).join("")}</div>
    <div class="panel"><div class="panel-h"><h2>${rows.length} open flag${rows.length === 1 ? "" : "s"} on ${new Set(rows.map(f => f.account_id)).size} accounts</h2><span class="hint">Flags clear on their own when the next run no longer sees the problem</span>
      <div class="right"><label class="note" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="show-ack" ${st.showAck ? "checked" : ""}> Show acknowledged (${acked})</label></div></div>
      <div class="panel-b tbl-wrap"><table><thead><tr><th>Severity</th><th>Agent</th><th>Check</th><th>What we saw</th><th>Suggested action</th><th>Since</th><th></th></tr></thead>
      <tbody>${rows.slice(0, 250).map(f => { const a = byId[f.account_id]; return `<tr>
        <td>${sevPill(f.severity)}</td><td class="who" data-open="${a.account_id}" style="cursor:pointer"><b>${esc(a.name)}</b><span>${esc(a.metro)} · <span class="idc">${a.account_id}</span></span></td>
        <td>${esc(f.check)}</td><td>${esc(f.detail)}</td><td style="color:var(--ink-2)">${esc(f.action)}</td><td class="note" style="white-space:nowrap">${f.first_seen === META.today ? `<span class="pill info">New</span>` : fiso(f.first_seen)}</td>
        <td style="white-space:nowrap"><button class="btn sm" data-open="${a.account_id}">Open</button> <button class="btn sm" data-ack="${esc(f.key)}" data-on="${f.acked ? 0 : 1}">${f.acked ? "Reopen" : "Acknowledge"}</button></td></tr>`; }).join("") || `<tr><td colspan="7" class="empty">Nothing open for this filter</td></tr>`}</tbody></table></div></div>`;
    tab.querySelectorAll("[data-sev]").forEach(b => b.onclick = () => { st.sev = st.sev === b.dataset.sev ? "" : b.dataset.sev; refresh(); });
    tab.querySelectorAll("[data-check]").forEach(b => b.onclick = () => { st.check = st.check === b.dataset.check ? "" : b.dataset.check; refresh(); });
    document.getElementById("show-ack").onchange = e => { st.showAck = e.target.checked; refresh(); };
    tab.querySelectorAll("[data-ack]").forEach(b => b.onclick = async () => { await api("/api/flags/ack", { key: b.dataset.ack, on: b.dataset.on === "1" }); toast(b.dataset.on === "1" ? "Flag acknowledged" : "Flag reopened"); });
  } else {
    tab.innerHTML = `<div class="panel"><div class="panel-h"><h2>Fix tasks</h2><span class="hint">Created from the cause checks. Marking a task done records the agent's fix on the account; the next day's results reflect it.</span></div>
      <div class="panel-b tbl-wrap"><table><thead><tr><th>Agent</th><th>Cause</th><th>Fix</th><th>Created</th><th>Status</th><th></th></tr></thead><tbody>
      ${D.tasks.map(t => { const a = byId[t.account_id]; return `<tr><td class="who" data-open="${a.account_id}" style="cursor:pointer"><b>${esc(a.name)}</b><span>${esc(a.metro)}</span></td><td>${esc(t.cause)}<div class="note">${esc(t.detail)}</div></td><td>${esc(t.fix)}</td><td class="note">${fiso(t.sim_day)}</td><td>${t.status === "open" ? `<span class="pill warn">Open</span>` : `<span class="pill good">Done</span>`}</td><td>${t.status === "open" ? `<button class="btn sm primary" data-done="${t.id}">Mark done</button>` : ""}</td></tr>`; }).join("") || `<tr><td colspan="6" class="empty">No tasks yet. Create them from “Showing, no leads” or an account.</td></tr>`}</tbody></table></div></div>`;
    tab.querySelectorAll("[data-done]").forEach(b => b.onclick = async () => { await api(`/api/tasks/${b.dataset.done}/done`); toast("Task done; account updated"); });
  }
  main.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { st.tab = b.dataset.tab; refresh(); });
}

/* ===== Diagnosis ===== */
function ladderHtml(rows) {
  return `<div class="ladder">${rows.map(r => `<div class="rung ${r.failing ? "fail" : "pass"}"><span class="ic">${r.failing ? "!" : "✓"}</span><span class="nm">${esc(r.cause)}</span><span class="fix">${r.failing ? `<b>${esc(r.fix)}</b> · ${esc(r.detail)}` : esc(r.detail)}</span></div>`).join("")}</div>`;
}
function viewDiagnosis() {
  const live = A.filter(a => a.status === "ACTIVE" && a.imp > 0 && a.days >= 10);
  const d0 = D.dark[0], impMed = d0 ? d0.cohort_imp : 0, rateMed = d0 ? d0.cohort_rate : 0;
  main.innerHTML = topbar("Showing, but not getting leads", `${D.dark.length} accounts · ${winLabel()}`) + `
  <div class="panel"><div class="panel-h"><h2>Exposure vs lead rate</h2><span class="hint">${d0 ? `Each dot is an active account. Shaded: at least half the median impressions (${num(impMed)}) and a lead rate under 40% of the median (${(rateMed * 100).toFixed(2)}%).` : "No accounts flagged in the latest run."}</span></div>
    <div class="panel-b"><div class="legend" style="margin-bottom:6px"><span><i style="background:var(--s-leads);height:8px;width:8px;border-radius:50%"></i>Flagged</span><span><i style="background:var(--s-dim);height:8px;width:8px;border-radius:50%"></i>Other active accounts</span></div><div class="chart" id="ch-scatter"></div></div></div>
  <p class="note" style="margin:14px 2px">For each flagged account the cause checks run in order and the fix is attached. Create tasks, mark them done once the agent fixes the cause, then run the next day to see the effect.</p>
  <div class="grid g-2">${D.dark.map(d => { const a = byId[d.account_id], open = (tasksOf[a.account_id] || []).filter(t => t.status === "open").length, fails = a.ladder.filter(r => r.failing).length; return `<div class="dcard">
    <div class="dcard-h"><div class="who"><b>${esc(a.name)}</b><span>${esc(a.business)} · ${esc(a.metro)} · <span class="idc">${a.account_id}</span></span></div><span class="metric">${num(a.imp)} impressions · ${a.leads} leads · ${(d.lead_rate * 100).toFixed(2)}% vs ${(d.cohort_rate * 100).toFixed(2)}%</span></div>
    ${ladderHtml(a.ladder)}
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm" data-open="${a.account_id}">Open account</button>${fails ? (open ? `<span class="pill warn">${open} open task${open > 1 ? "s" : ""}</span>` : `<button class="btn sm primary" data-task="${a.account_id}">Create fix tasks (${fails})</button>`) : ""}</div>
  </div>`; }).join("") || `<div class="empty">Every active account is converting impressions at a normal rate.</div>`}</div>`;
  scatter(document.getElementById("ch-scatter"), live.map(a => ({ id: a.account_id, x: a.imp, y: a.leads / a.imp, hl: !!DARK[a.account_id], label: a.name })), { xRef: impMed * 0.5, yRef: rateMed * 0.4, aria: "Impressions against lead rate", height: 320 });
  main.querySelectorAll("[data-task]").forEach(b => b.onclick = async () => { const r = await api("/api/tasks", { account_id: b.dataset.task }); toast(`${r.created} fix task${r.created === 1 ? "" : "s"} created`); });
}

/* ===== Lead quality ===== */
const leadState = { tab: "disputes", sel: {} };
function viewLeads() {
  const L14 = LEADS.filter(l => l.day >= W0);
  const rated = L14.filter(l => l.rating != null), poor = rated.filter(l => l.rating <= 2);
  const credits = LEADS.filter(l => l.dstatus === "credited").reduce((s, l) => s + l.cost, 0);
  const submitted = LEADS.filter(l => l.dstatus === "submitted");
  const dq = disputeQueue();
  const types = ["Phone call", "Message", "Booking"].map(t => ({ label: t, v: L14.filter(l => l.type === t).length }));
  const cats = ["Buyer", "Seller", "Buyer & seller"].map(t => ({ label: t, v: L14.filter(l => l.cat === t).length }));
  const dist = [5, 4, 3, 2, 1].map(r => ({ label: "★".repeat(r), v: rated.filter(l => l.rating === r).length }));
  const st = leadState;
  for (const id of Object.keys(st.sel)) if (!dq.some(l => l.id === id)) delete st.sel[id];
  main.innerHTML = topbar("Lead quality", `${num(L14.length)} leads · ${winLabel()}`) + `
  <div class="kpis">
    <div class="kpi"><div class="l">Leads</div><div class="v">${num(L14.length)}</div><div class="d">${pct(L14.filter(l => l.charged).length / Math.max(1, L14.length))} charged</div></div>
    <div class="kpi"><div class="l">Rated</div><div class="v">${pct(rated.length / Math.max(1, L14.length))}</div><div class="d">${num(rated.length)} leads have feedback</div></div>
    <div class="kpi"><div class="l">Rated 1-2 stars</div><div class="v">${pct(poor.length / Math.max(1, rated.length))}</div><div class="d">${num(poor.length)} poor leads</div></div>
    <div class="kpi"><div class="l">Ready to dispute</div><div class="v">${num(dq.length)}</div><div class="d">${money(dq.reduce((s, l) => s + l.cost, 0))} · ${submitted.length} with Google</div></div>
    <div class="kpi"><div class="l">Credits recovered</div><div class="v">${money(credits)}</div><div class="d">last ${META.lead_days} days</div></div>
  </div>
  <div class="grid g-3">
    <div class="panel"><div class="panel-h"><h2>Lead type</h2></div><div class="panel-b">${hbars(types.map(t => ({ ...t, text: pct(t.v / Math.max(1, L14.length)) })))}</div></div>
    <div class="panel"><div class="panel-h"><h2>Request</h2></div><div class="panel-b">${hbars(cats.map(t => ({ ...t, text: pct(t.v / Math.max(1, L14.length)) })))}</div></div>
    <div class="panel"><div class="panel-h"><h2>Ratings given</h2></div><div class="panel-b">${hbars(dist.map(t => ({ ...t, text: num(t.v), color: t.label.length <= 2 ? "var(--s-leads)" : "var(--s-spend)" })))}</div></div>
  </div>
  <div class="panel section-gap"><div class="panel-b">
    <div class="tabs" role="tablist"><button role="tab" data-tab="disputes" aria-selected="${st.tab === "disputes"}">Dispute queue<span class="count">${dq.length}</span></button><button role="tab" data-tab="feedback" aria-selected="${st.tab === "feedback"}">Rate leads at scale<span class="count">${D.suggestions.length}</span></button><button role="tab" data-tab="sub" aria-selected="${st.tab === "sub"}">Dispute outcomes</button><button role="tab" data-tab="all" aria-selected="${st.tab === "all"}">Recent leads</button></div>
    <div id="lead-tab"></div></div></div>`;
  const tab = document.getElementById("lead-tab");
  if (st.tab === "disputes") {
    const n = Object.keys(st.sel).length;
    tab.innerHTML = `<div class="filters" style="justify-content:space-between"><p class="note" style="margin:0;max-width:640px">Charged leads matching a dispute reason: spam, out of area, rentals, duplicates, non-real-estate. Google decides within a day; outcomes appear under Dispute outcomes and credits roll into the total.</p>
      <div style="display:flex;gap:8px"><button class="btn" id="sel-all" ${dq.length ? "" : "disabled"}>${n && n === dq.length ? "Clear selection" : "Select all " + dq.length}</button><button class="btn primary" id="submit-d" ${n ? "" : "disabled"}>Submit ${n || ""} dispute${n === 1 ? "" : "s"}</button></div></div>
      <div class="tbl-wrap"><table><thead><tr><th></th><th>Lead</th><th>Agent</th><th>Received</th><th>Type</th><th>Reason</th><th class="r">Call</th><th class="r">Charge</th></tr></thead><tbody>
      ${dq.slice(0, 200).map(l => `<tr><td><input type="checkbox" data-sel="${l.id}" ${st.sel[l.id] ? "checked" : ""} aria-label="Select lead ${l.id}"></td><td class="idc">${l.id}</td><td class="who" data-open="${l.a.account_id}" style="cursor:pointer"><b>${esc(l.a.name)}</b><span>${esc(l.a.metro)}</span></td><td>${fdate(l.day)}, ${l.hour}:00</td><td>${l.type}</td><td>${esc(l.dispute)}</td><td class="r">${l.secs != null ? l.secs + "s" : "–"}</td><td class="r">${money(l.cost)}</td></tr>`).join("") || `<tr><td colspan="8" class="empty">Dispute queue is empty</td></tr>`}</tbody></table></div>`;
    tab.querySelectorAll("[data-sel]").forEach(c => c.onchange = () => { c.checked ? st.sel[c.dataset.sel] = 1 : delete st.sel[c.dataset.sel]; refresh(); });
    document.getElementById("sel-all").onclick = () => { if (n && n === dq.length) st.sel = {}; else dq.forEach(l => st.sel[l.id] = 1); refresh(); };
    document.getElementById("submit-d").onclick = async () => { const ids = Object.keys(st.sel); st.sel = {}; const r = await api("/api/leads/dispute", { ids }); toast(`${r.submitted} disputes submitted to Google`); };
  } else if (st.tab === "feedback") {
    tab.innerHTML = `<div class="filters" style="justify-content:space-between"><p class="note" style="margin:0;max-width:640px">Unrated leads from the last 14 days with a clear signal: very short calls and disputable leads score 1★, booked appointments 5★. Sent with ProvideLeadFeedback so Google learns what a good lead looks like.</p>
      <button class="btn primary" id="send-fb" ${D.suggestions.length ? "" : "disabled"}>Send ${D.suggestions.length} ratings</button></div>
      <div class="tbl-wrap"><table><thead><tr><th>Lead</th><th>Agent</th><th>Received</th><th>Type</th><th>Status</th><th>Rating</th><th>Why</th></tr></thead><tbody>
      ${D.suggestions.slice(0, 150).map(([id, r, why]) => { const l = LEADS.find(x => x.id === id); return l ? `<tr><td class="idc">${l.id}</td><td>${esc(l.a.name)}</td><td>${fdate(l.day)}</td><td>${l.type}</td><td>${l.status}</td><td class="stars"><i>${"★".repeat(r)}</i>${"☆".repeat(5 - r)}</td><td>${esc(why)}</td></tr>` : ""; }).join("") || `<tr><td colspan="7" class="empty">Every lead with a clear signal is rated</td></tr>`}</tbody></table>${D.suggestions.length > 150 ? `<p class="note">Showing 150 of ${D.suggestions.length}</p>` : ""}</div>`;
    const b = document.getElementById("send-fb");
    if (b) b.onclick = async () => { const r = await api("/api/leads/feedback"); toast(`${r.rated} ratings sent`); };
  } else if (st.tab === "sub") {
    const outs = LEADS.filter(l => l.dstatus).sort((a, b) => b.day - a.day);
    tab.innerHTML = `<div class="tbl-wrap"><table><thead><tr><th>Lead</th><th>Agent</th><th>Received</th><th>Reason</th><th class="r">Charge</th><th>Outcome</th></tr></thead><tbody>
      ${outs.slice(0, 200).map(l => `<tr><td class="idc">${l.id}</td><td>${esc(l.a.name)}</td><td>${fdate(l.day)}</td><td>${esc(l.dispute)}</td><td class="r">${money(l.cost)}</td><td>${l.dstatus === "credited" ? `<span class="pill good">Credited</span>` : l.dstatus === "rejected" ? `<span class="pill mute">Rejected</span>` : `<span class="pill info">With Google</span>`}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">No disputes yet</td></tr>`}</tbody></table></div>`;
  } else {
    tab.innerHTML = `<div class="tbl-wrap"><table><thead><tr><th>Lead</th><th>Agent</th><th>Received</th><th>Type</th><th>Request</th><th>Status</th><th>Rating</th><th class="r">Charge</th></tr></thead><tbody>
      ${LEADS.slice(0, 120).map(l => `<tr><td class="idc">${l.id}</td><td class="who" data-open="${l.a.account_id}" style="cursor:pointer"><b>${esc(l.a.name)}</b><span>${esc(l.a.metro)}</span></td><td>${fdate(l.day)}, ${l.hour}:00</td><td>${l.type}</td><td>${l.cat}</td><td>${l.status}</td><td>${l.rating ? `<span class="stars"><i>${"★".repeat(l.rating)}</i></span>${l.ratingSrc === "ops" ? ' <small class="note">ops</small>' : ""}` : `<span class="note">–</span>`}</td><td class="r">${l.charged ? money(l.cost) : `<span class="note">not charged</span>`}</td></tr>`).join("")}</tbody></table></div>`;
  }
  main.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { st.tab = b.dataset.tab; refresh(); });
}

/* ===== Changes ===== */
const chState = { tab: "queue", filter: "pending", metro: "", cond: "early", field: "weekly_budget", val: { weekly_budget: 10, max_per_lead: 10, service_zips: 6, hours_per_week: 60 }, preview: null, previewKey: "" };
function viewChanges() {
  const st = chState, pend = pendingProps();
  main.innerHTML = topbar("Changes", "Budget, bid, service area and schedule changes pass the guardrails, then apply, dry-run or wait for approval") + `
  <div class="tabs" role="tablist">
    <button role="tab" data-tab="queue" aria-selected="${st.tab === "queue"}">Proposals<span class="count">${pend.length} pending</span></button>
    <button role="tab" data-tab="bulk" aria-selected="${st.tab === "bulk"}">Bulk change</button>
    <button role="tab" data-tab="guard" aria-selected="${st.tab === "guard"}">Guardrails</button>
  </div><div id="ch-tab"></div>`;
  const tab = document.getElementById("ch-tab");
  if (st.tab === "queue") {
    const F = { pending: ["Waiting for approval", p => p.decision === "needs_approval"], today: ["Today", p => p.sim_day === META.today], all: ["All", () => true] };
    const rows = D.proposals.filter(F[st.filter][1]);
    tab.innerHTML = `<div class="filters" style="justify-content:space-between"><div class="chips">${Object.entries(F).map(([k, v]) => `<button class="chip" data-f="${k}" aria-pressed="${st.filter === k}">${v[0]} <b>${D.proposals.filter(v[1]).length}</b></button>`).join("")}</div>
      ${pend.length ? `<button class="btn primary" id="approve-all">Approve all ${pend.length}</button>` : ""}</div>
      <p class="note" style="margin:-4px 0 12px">Write mode is <b>${META.write_mode === "apply" ? "apply" : "dry run"}</b>: within-cap changes ${META.write_mode === "apply" ? "are written to the account" : "are logged but not written"}. Changes over ±${META.guard.max_pct}% wait here for a person.</p>
      <div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Agent</th><th>Field</th><th class="r">Value</th><th class="r">Change</th><th>Why</th><th>Source</th><th>Day</th><th>Decision</th><th></th></tr></thead><tbody>
      ${rows.slice(0, 250).map(p => { const a = byId[p.account_id]; return `<tr>
        <td class="who" data-open="${a.account_id}" style="cursor:pointer"><b>${esc(a.name)}</b><span>${esc(a.metro)} · <span class="idc">${a.account_id}</span></span></td>
        <td>${esc(META.fields[p.field])}</td><td class="r" style="white-space:nowrap">${fmtField(p.field, p.old)} → <b>${fmtField(p.field, p.new)}</b></td>
        <td class="r ${p.pct > 0 ? "delta-up" : "delta-down"}">${p.pct > 0 ? "+" : ""}${Number(p.pct).toFixed(0)}%</td>
        <td style="max-width:340px">${esc(p.reason)}</td><td><span class="pill ${p.source === "claude" ? "info" : "mute"}">${esc(p.source)}</span></td><td class="note" style="white-space:nowrap">${fiso(p.sim_day)}</td><td>${decisionPill(p.decision, p.applied)}</td>
        <td style="white-space:nowrap">${p.decision === "needs_approval" ? `<button class="btn sm primary" data-approve="${p.id}">Approve</button> <button class="btn sm" data-reject="${p.id}">Reject</button>` : ""}</td></tr>`; }).join("") || `<tr><td colspan="9" class="empty">${st.filter === "pending" ? "Nothing waiting for approval" : "No changes"}</td></tr>`}</tbody></table></div></div>`;
    tab.querySelectorAll("[data-f]").forEach(b => b.onclick = () => { st.filter = b.dataset.f; refresh(); });
    tab.querySelectorAll("[data-approve]").forEach(b => b.onclick = async () => { await api(`/api/proposals/${b.dataset.approve}/approve`); toast(META.write_mode === "apply" ? "Approved and applied" : "Approved (dry run)"); });
    tab.querySelectorAll("[data-reject]").forEach(b => b.onclick = async () => { await api(`/api/proposals/${b.dataset.reject}/reject`); toast("Rejected"); });
    const aa = document.getElementById("approve-all");
    if (aa) aa.onclick = async () => { const r = await api("/api/proposals/approve-all"); toast(`${r.approved} changes approved`); };
  } else if (st.tab === "bulk") {
    const conds = META.bulk_conds;
    const inputLabel = { weekly_budget: "Change by (%)", max_per_lead: "Change by (%)", service_zips: "Add ZIP codes", hours_per_week: "At least (hours / week)" }[st.field];
    const rule = { weekly_budget: `Over ±${META.guard.max_pct}% needs approval. Budgets round to $10 and stay within $${META.guard.floor}–$${META.guard.ceiling} a week.`, max_per_lead: `Only accounts bidding with a max per lead. Over ±${META.guard.max_pct}% needs approval.`, service_zips: `Adding more than ${META.guard.max_zip_add} ZIPs at once needs approval.`, hours_per_week: "Extends the ad schedule; accounts already at or above the target are skipped." }[st.field];
    const pv = st.preview, rows = pv ? pv.rows : [];
    const by = { ok: 0, needs_approval: 0, blocked: 0, noop: 0 }; rows.forEach(r => by[r.decision] = (by[r.decision] || 0) + 1);
    const delta = st.field === "weekly_budget" ? rows.filter(r => r.decision === "ok" || r.decision === "needs_approval").reduce((s, r) => s + r.new - r.old, 0) : null;
    tab.innerHTML = `<div class="panel"><div class="panel-b">
      <div class="filters">
        <label class="field">Change<select id="b-field">${Object.entries(META.fields).map(([k, v]) => `<option value="${k}" ${st.field === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
        <label class="field">${inputLabel}<input id="b-val" type="number" step="1" value="${st.val[st.field]}" style="width:130px"></label>
        <label class="field">Accounts where<select id="b-cond">${Object.entries(conds).map(([k, v]) => `<option value="${k}" ${st.cond === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
        <label class="field">Metro<select id="b-metro"><option value="">All metros</option>${METROS.map(m => `<option ${st.metro === m ? "selected" : ""}>${m}</option>`).join("")}</select></label>
      </div>
      <p class="note" style="margin:0 0 10px">${rule}</p>
      <div class="preview">${pv ? `<div class="row"><b>${rows.length} accounts</b><span>${decisionPill("ok")} ${by.ok}</span><span>${decisionPill("needs_approval")} ${by.needs_approval}</span>${by.blocked ? `<span>${decisionPill("blocked")} ${by.blocked}</span>` : ""}${by.noop ? `<span>${decisionPill("noop")} ${by.noop}</span>` : ""}${delta != null ? `<span class="note">Net ${delta >= 0 ? "+" : ""}${money(delta)} / week</span>` : ""}</div>
      <div class="row"><button class="btn primary" id="b-run" ${by.ok + by.needs_approval ? "" : "disabled"}>Run ${by.ok} now${by.needs_approval ? ` · send ${by.needs_approval} for approval` : ""}</button></div>` : `<div class="note">Calculating…</div>`}</div>
    </div></div>
    <div class="panel section-gap"><div class="tbl-wrap"><table><thead><tr><th>Agent</th><th>Metro</th><th class="r">CPL</th><th class="r">Leads 14d</th><th class="r">Now</th><th class="r">New</th><th>Guardrail</th></tr></thead><tbody>
      ${rows.slice(0, 200).map(r => `<tr><td class="who" data-open="${r.account_id}" style="cursor:pointer"><b>${esc(r.name)}</b><span class="idc">${r.account_id}</span></td><td>${esc(r.metro)}</td><td class="r">${money(r.cpl, 2)}</td><td class="r">${r.leads}</td><td class="r">${fmtField(st.field, r.old)}</td><td class="r"><b>${fmtField(st.field, r.new)}</b>${r.note ? ` <small class="note">${esc(r.note)}</small>` : ""}</td><td>${decisionPill(r.decision)}</td></tr>`).join("") || (pv ? `<tr><td colspan="7" class="empty">No active accounts match${st.field === "max_per_lead" ? ". Max-per-lead changes only apply to accounts using that bid strategy." : ""}</td></tr>` : "")}</tbody></table></div></div>`;
    const spec = () => ({ field: st.field, value: st.val[st.field], cond: st.cond, metro: st.metro });
    const key = JSON.stringify(spec()) + META.version;
    if (st.previewKey !== key) {
      st.previewKey = key;
      fetch("/api/preview/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(spec()) }).then(r => r.json()).then(p => { if (st.previewKey === key && !p.error) { st.preview = p; if (current === "changes" && st.tab === "bulk") refresh(); } });
    }
    const repv = () => { st.preview = null; refresh(); };
    document.getElementById("b-field").onchange = e => { st.field = e.target.value; repv(); };
    document.getElementById("b-cond").onchange = e => { st.cond = e.target.value; repv(); };
    document.getElementById("b-metro").onchange = e => { st.metro = e.target.value; repv(); };
    document.getElementById("b-val").onchange = e => { st.val[st.field] = Number(e.target.value) || 0; repv(); };
    const run = document.getElementById("b-run");
    if (run) run.onclick = async () => { const r = await api("/api/bulk", spec()); st.preview = null; const c = r.counts || {}; toast(`Bulk change: ${c.applied || 0} applied, ${c.dry_run || 0} dry run, ${c.needs_approval || 0} sent for approval`); st.tab = "queue"; st.filter = "today"; refresh(); };
  } else {
    const g = META.guard;
    tab.innerHTML = `<div class="grid g-2"><div class="panel"><div class="panel-h"><h2>Guardrails</h2><span class="hint">Applied to rules, Claude, bulk edits and manual changes</span></div><div class="panel-b">
      <div class="filters" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr))">
        <label class="field">Largest budget or bid change without approval (%)<input id="g-max_pct" type="number" min="1" max="100" value="${g.max_pct}"></label>
        <label class="field">Changes per account per day<input id="g-per_day" type="number" min="1" max="10" value="${g.per_day}"></label>
        <label class="field">Budget floor ($ / week)<input id="g-floor" type="number" min="0" step="10" value="${g.floor}"></label>
        <label class="field">Budget ceiling ($ / week)<input id="g-ceiling" type="number" min="100" step="50" value="${g.ceiling}"></label>
        <label class="field">ZIPs added without approval<input id="g-max_zip_add" type="number" min="0" max="50" value="${g.max_zip_add}"></label>
        <label class="field">Days between automatic budget changes<input id="g-cooldown_days" type="number" min="0" max="30" value="${g.cooldown_days}"></label>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" id="g-save">Save guardrails</button></div></div></div>
      <div class="panel"><div class="panel-h"><h2>Write mode</h2></div><div class="panel-b" style="display:grid;gap:10px">
        <div class="mode" role="group" aria-label="Write mode"><button data-mode="apply" aria-pressed="${META.write_mode === "apply"}">Apply</button><button data-mode="dry_run" aria-pressed="${META.write_mode === "dry_run"}">Dry run</button></div>
        <p class="note" style="margin:0">Apply: within-cap changes and approvals are written to the account (in this demo, the demo database; in production, the Google Ads API). Dry run: every change is evaluated and logged, nothing is written.</p>
      </div></div></div>`;
    document.getElementById("g-save").onclick = async () => {
      const guard = {}; ["max_pct", "per_day", "floor", "ceiling", "max_zip_add", "cooldown_days"].forEach(k => guard[k] = Number(document.getElementById("g-" + k).value));
      await api("/api/settings", { guard }); toast("Guardrails saved");
    };
    tab.querySelectorAll("[data-mode]").forEach(b => b.onclick = async () => { await api("/api/settings", { write_mode: b.dataset.mode }); toast(`Write mode: ${b.dataset.mode === "apply" ? "apply" : "dry run"}`); });
  }
  main.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { st.tab = b.dataset.tab; refresh(); });
}

/* ===== Automation ===== */
function viewAutomation() {
  const ap = META.autopilot_secs;
  main.innerHTML = topbar("Automation", `Simulated date ${fiso(META.today)} · data through ${fdate(DAYS - 1)}`) + `
  <div class="grid g-21">
    <div class="panel"><div class="panel-h"><h2>Daily pipeline</h2><span class="hint">Pull → check → diagnose → recommend → guardrail → apply or queue → log</span></div><div class="panel-b" style="display:grid;gap:14px">
      <div class="flow"><div><b>Pull</b>Account reports, leads, verification</div><div><b>Check</b>Spend, CPL, verification, suspensions, drops</div><div><b>Diagnose</b>Showing without leads, cause ladder</div><div><b>Recommend</b>Rules engine${META.claude ? " and Claude" : ""}</div><div><b>Guardrail</b>Caps, limits, cooldown</div><div><b>Act</b>${META.write_mode === "apply" ? "Apply within cap" : "Dry run within cap"}; queue the rest</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="a-run">${icon("play")}Run pipeline now</button>
        <button class="btn primary" id="a-next">${icon("next")}Simulate next day + run</button>
        <button class="btn" id="a-week">Simulate 7 days</button>
      </div>
      <div class="filters" style="margin:0">
        <label class="field">Autopilot<select id="a-secs">${[[0, "Off"], [10, "Next day every 10 seconds"], [30, "Next day every 30 seconds"], [60, "Next day every minute"], [300, "Next day every 5 minutes"]].map(([v, l]) => `<option value="${v}" ${ap == v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <div class="field">Write mode<div class="mode" role="group"><button data-mode="apply" aria-pressed="${META.write_mode === "apply"}">Apply</button><button data-mode="dry_run" aria-pressed="${META.write_mode === "dry_run"}">Dry run</button></div></div>
      </div>
      <p class="note" style="margin:0">In production the pipeline runs on a schedule (6:00 AM ET) against the live accounts. Here, “next day” simulates a day of account activity from each account's current settings, so budget, service-area, schedule and verification changes show up in the following days' results.</p>
    </div></div>
    <div class="panel"><div class="panel-h"><h2>Demo data</h2></div><div class="panel-b" style="display:grid;gap:10px">
      <div class="stat-line"><span>Accounts</span><b>${A.length}</b></div><div class="stat-line"><span>Days of history</span><b>${DAYS}</b></div><div class="stat-line"><span>Leads, last ${META.lead_days} days</span><b>${num(LEADS.length)}</b></div>
      <div id="reset-box"><button class="btn danger" id="a-reset">Reset demo data</button></div>
    </div></div>
  </div>
  <div class="panel section-gap"><div class="panel-h"><h2>Pipeline runs</h2></div><div class="panel-b tbl-wrap"><table>
    <thead><tr><th>Ran at</th><th>Day</th><th>Trigger</th><th class="r">Flags</th><th class="r">New</th><th class="r">Cleared</th><th class="r">Critical</th><th class="r">No-lead accts</th><th class="r">Within cap</th><th class="r">For approval</th><th class="r">Cooldown</th><th class="r">Time</th></tr></thead>
    <tbody>${D.runs.map(r => { const s = r.summary; return `<tr><td class="mono" style="white-space:nowrap">${ftime(r.ts)}</td><td>${fiso(r.sim_day)}</td><td>${esc(r.trigger)}</td><td class="r">${s.flags}</td><td class="r">${s.new_flags}</td><td class="r">${s.cleared}</td><td class="r">${s.critical}</td><td class="r">${s.dark}</td><td class="r">${s.applied + s.dry_run}</td><td class="r">${s.needs_approval}</td><td class="r">${s.cooldown ?? "–"}</td><td class="r">${r.duration_ms} ms</td></tr>`; }).join("")}</tbody></table></div></div>`;
  document.getElementById("a-run").onclick = async () => { const s = await api("/api/run"); toast(`Pipeline ran: ${s.flags} flags, ${s.needs_approval} sent for approval`); };
  document.getElementById("a-next").onclick = async () => { const s = await api("/api/advance", { days: 1 }); toast(`Next day done: ${s.new_flags} new flags, ${s.cleared} cleared`); };
  document.getElementById("a-week").onclick = async () => { await api("/api/advance", { days: 7 }); toast("Simulated 7 days, pipeline ran after each"); };
  document.getElementById("a-secs").onchange = e => api("/api/settings", { autopilot_secs: Number(e.target.value) });
  main.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => api("/api/settings", { write_mode: b.dataset.mode }));
  document.getElementById("a-reset").onclick = () => {
    document.getElementById("reset-box").innerHTML = `<div class="preview"><div>Rebuild all ${A.length} accounts and history, and clear the log, proposals and tasks?</div><div class="row"><button class="btn danger" id="a-reset-yes">Reset</button><button class="btn" id="a-reset-no">Cancel</button></div></div>`;
    document.getElementById("a-reset-no").onclick = refresh;
    document.getElementById("a-reset-yes").onclick = async () => { await api("/api/reset"); toast("Demo data rebuilt"); };
  };
}

/* ===== Activity log ===== */
const logState = { kind: "" };
function viewLog() {
  const all = D.log;
  const kinds = { pipeline: "Pipeline", day: "New day", change: "Change", approval: "Approval", dispute: "Dispute", feedback: "Feedback", flag: "Flag", task: "Task", account: "Account", ai: "AI review", settings: "Settings", system: "System" };
  const rows = all.filter(e => !logState.kind || e.kind === logState.kind);
  const pillFor = k => ({ pipeline: "mute", day: "info", change: "info", approval: "good", ai: "info", task: "warn" }[k] || "mute");
  main.innerHTML = topbar("Activity log", `${all.length} most recent entries · append-only`) + `
  <div class="filters" style="justify-content:space-between"><div class="chips"><button class="chip" data-k="" aria-pressed="${!logState.kind}">All <b>${all.length}</b></button>${Object.entries(kinds).map(([k, l]) => { const n = all.filter(e => e.kind === k).length; return n ? `<button class="chip" data-k="${k}" aria-pressed="${logState.kind === k}">${l} <b>${n}</b></button>` : ""; }).join("")}</div>
  <button class="btn" id="copy-log">${icon("copy")}Copy as JSONL</button></div>
  <div class="panel"><div class="panel-b">${rows.slice(0, 400).map(e => `<div class="log-row"><span class="ts">${ftime(e.ts)}<br><span style="font-size:11px">day ${esc(e.sim_day.slice(5))} · ${esc(e.actor)}</span></span><span><span class="pill ${pillFor(e.kind)}">${kinds[e.kind] || esc(e.kind)}</span></span><div class="msg">${esc(e.msg)}${e.sub ? `<small>${esc(e.sub)}</small>` : ""}</div></div>`).join("") || `<div class="empty">No entries</div>`}</div></div>`;
  main.querySelectorAll("[data-k]").forEach(b => b.onclick = () => { logState.kind = b.dataset.k; refresh(); });
  document.getElementById("copy-log").onclick = () => copyText(rows.map(e => JSON.stringify(e)).join("\n"));
}

/* ===== Weekly report ===== */
function viewReport() {
  const sumDays = (a, from, to, k) => { let s = 0; for (let d = from; d < to; d++) { const r = a.daily[d]; if (r) s += r[k]; } return s; };
  const weeks = [];
  for (let end = DAYS; end - 7 >= 0; end -= 7) {
    const s = end - 7; let cost = 0, leads = 0, ch = 0, imp = 0;
    for (let d = s; d < end; d++) { cost += totals[d].cost; leads += totals[d].leads; ch += totals[d].charged; imp += totals[d].imp; }
    const serving = A.filter(a => { for (let d = s; d < end; d++) if (a.daily[d] && a.daily[d][0] > 0) return true; return false; }).length;
    weeks.push({ s, e: end - 1, cost, leads, ch, imp, cpl: cost / ch, serving });
  }
  const [w, lw] = weeks;
  const metro = METROS.map(m => {
    const as = A.filter(a => a.metro === m);
    const f = (s, e, k) => as.reduce((t, a) => t + sumDays(a, s, e, k), 0);
    const c1 = f(w.s, w.e + 1, 3), ch1 = f(w.s, w.e + 1, 2), l1 = f(w.s, w.e + 1, 1), c0 = f(lw.s, lw.e + 1, 3), ch0 = f(lw.s, lw.e + 1, 2), l0 = f(lw.s, lw.e + 1, 1);
    return { m, c1, l1, cpl1: c1 / ch1, l0, cpl0: c0 / ch0 };
  }).sort((a, b) => b.c1 - a.c1);
  const ch = (a, b) => `${a >= b ? "+" : ""}${((a - b) / b * 100).toFixed(1)}%`;
  const crit = D.flags.filter(f => f.severity === "critical").length;
  const mv = r => (r.cpl1 - r.cpl0) / r.cpl0;
  const best = metro.slice().sort((a, b) => mv(a) - mv(b))[0], worst = metro.slice().sort((a, b) => mv(b) - mv(a))[0];
  const weekStart = dayDate(w.s).toISOString().slice(0, 10);
  const wkChanges = D.proposals.filter(p => (p.decision === "applied" || (p.decision === "approved" && p.applied)) && p.sim_day >= weekStart).length;
  const text = `LSA program, week of ${fdate(w.s)} – ${fdate(w.e)}

Spend ${money(w.cost)} (${ch(w.cost, lw.cost)} week over week), ${num(w.leads)} leads (${ch(w.leads, lw.leads)}), cost per charged lead ${money(w.cpl, 2)} (${ch(w.cpl, lw.cpl)}). ${w.serving} of ${A.length} accounts served ads.

Best CPL movement: ${best.m}, ${money(best.cpl0, 2)} → ${money(best.cpl1, 2)}. Watch: ${worst.m}, ${money(worst.cpl0, 2)} → ${money(worst.cpl1, 2)}.

Changes applied this week: ${wkChanges}. Open items: ${crit} critical flags, ${D.dark.length} accounts showing without leads, ${pendingProps().length} changes waiting for approval, ${disputeQueue().length} leads ready to dispute, ${D.tasks.filter(t => t.status === "open").length} open fix tasks, ${D.new_agents.filter(n => n.days_to_first_lead == null).length} new agents waiting on a first lead.`;
  main.innerHTML = topbar("Weekly report", `Week of ${fdate(w.s)} – ${fdate(w.e)}`) + `
  <div class="grid g-21">
    <div class="panel"><div class="panel-h"><h2>Summary</h2><div class="right"><button class="btn sm" id="copy-rep">${icon("copy")}Copy</button></div></div><div class="panel-b"><div class="report-text" id="rep-text">${esc(text)}</div><p class="note">Built from the numbers below. Paste into Slack or email for the weekly check-in.</p></div></div>
    <div class="panel"><div class="panel-h"><h2>This week</h2></div><div class="panel-b">
      <div class="stat-line"><span>Spend</span><b>${money(w.cost)}</b></div><div class="stat-line"><span>Leads</span><b>${num(w.leads)}</b></div><div class="stat-line"><span>Cost per charged lead</span><b>${money(w.cpl, 2)}</b></div><div class="stat-line"><span>Accounts serving</span><b>${w.serving}</b></div></div></div>
  </div>
  <div class="panel section-gap"><div class="panel-h"><h2>Week by week</h2></div><div class="panel-b tbl-wrap"><table><thead><tr><th>Week</th><th class="r">Spend</th><th class="r">Leads</th><th class="r">Charged</th><th class="r">CPL</th><th class="r">Lead rate</th><th class="r">Accounts serving</th></tr></thead>
    <tbody>${weeks.map(x => `<tr><td>${fdate(x.s)} – ${fdate(x.e)}</td><td class="r">${money(x.cost)}</td><td class="r">${num(x.leads)}</td><td class="r">${num(x.ch)}</td><td class="r">${money(x.cpl, 2)}</td><td class="r">${pct(x.leads / x.imp, 2)}</td><td class="r">${x.serving}</td></tr>`).join("")}</tbody></table></div></div>
  <div class="panel section-gap"><div class="panel-h"><h2>Metros, this week vs last</h2></div><div class="panel-b tbl-wrap"><table><thead><tr><th>Metro</th><th class="r">Spend</th><th class="r">Leads</th><th class="r">Leads WoW</th><th class="r">CPL</th><th class="r">CPL WoW</th></tr></thead>
    <tbody>${metro.map(r => `<tr><td>${r.m}</td><td class="r">${money(r.c1)}</td><td class="r">${num(r.l1)}</td><td class="r ${r.l1 >= r.l0 ? "delta-up" : "delta-down"}">${ch(r.l1, r.l0)}</td><td class="r">${money(r.cpl1, 2)}</td><td class="r ${r.cpl1 <= r.cpl0 ? "delta-up" : "delta-down"}">${ch(r.cpl1, r.cpl0)}</td></tr>`).join("")}</tbody></table></div></div>`;
  document.getElementById("copy-rep").onclick = () => copyText(document.getElementById("rep-text").textContent);
}

/* ===== About ===== */
function viewAbout() {
  main.innerHTML = topbar("How it works", "Pipeline, data sources and safety rails") + `
  <div class="grid g-2">
    <div class="panel"><div class="panel-h"><h2>Data sources in production</h2></div><div class="panel-b"><pre class="code">GET localservices.googleapis.com/v1/accountReports:search
    ?query=manager_customer_id:&lt;MCC&gt;
GET localservices.googleapis.com/v1/detailedLeadReports:search

-- Google Ads API (where LSA is moving)
SELECT local_services_lead.id, local_services_lead.lead_type,
       local_services_lead.lead_status, local_services_lead.lead_charged,
       local_services_lead.creation_date_time
FROM local_services_lead
WHERE local_services_lead.creation_date_time DURING LAST_14_DAYS

SELECT local_services_verification_artifact.status,
       local_services_verification_artifact.artifact_type
FROM local_services_verification_artifact

LocalServicesLeadService.ProvideLeadFeedback   -- lead ratings
CampaignBudgetService.MutateCampaignBudgets    -- budget changes</pre></div></div>
    <div class="panel"><div class="panel-h"><h2>Stack</h2></div><div class="panel-b"><dl class="kv">
      <dt>Engine</dt><dd>Python: pull, checks, diagnosis, recommendations, guardrails, actions</dd>
      <dt>Storage</dt><dd>SQL (SQLite here; Postgres or BigQuery in production). Every number on these pages is computed from it on request.</dd>
      <dt>AI</dt><dd>${META.claude ? "Claude is connected on this server." : "Claude connects when the server has an API key."} It reviews an account and proposes a change; it never writes directly, and every proposal goes through the same guardrails.</dd>
      <dt>Console</dt><dd>This page, served by the same Python process with a JSON API</dd>
      <dt>Demo data</dt><dd>${A.length} generated agent accounts. Each new day is simulated from the accounts' current settings.</dd>
    </dl></div></div>
  </div>
  <div class="panel section-gap"><div class="panel-h"><h2>Detection rules</h2></div><div class="panel-b tbl-wrap"><table><thead><tr><th>Check</th><th>Fires when</th><th>Severity</th></tr></thead><tbody>
    <tr><td>Suspended</td><td>Account status is suspended</td><td>${sevPill("critical")}</td></tr>
    <tr><td>Verification</td><td>License pending or expired, or background check pending</td><td>${sevPill("critical")}</td></tr>
    <tr><td>License expiring</td><td>License expires within 30 days</td><td>${sevPill("warn")}</td></tr>
    <tr><td>Budget runs out early</td><td>Out of budget before 2pm on at least 7 of 14 days</td><td>${sevPill("warn")}</td></tr>
    <tr><td>High cost per lead</td><td>CPL above 1.5x the metro median, 5+ charged leads</td><td>${sevPill("warn")}</td></tr>
    <tr><td>Lead quality</td><td>Over 35% of rated leads at 1-2 stars, 5+ rated</td><td>${sevPill("warn")}</td></tr>
    <tr><td>Lead drop</td><td>Leads down 50% or more vs the prior 14 days</td><td>${sevPill("warn")}</td></tr>
    <tr><td>Missed calls</td><td>Answers fewer than 70% of calls</td><td>${sevPill("warn")}</td></tr>
    <tr><td>Disputable leads</td><td>5+ charged leads matching dispute reasons and over 15% of leads</td><td>${sevPill("info")}</td></tr>
    <tr><td>Showing, no leads</td><td>Impressions at least half the cohort median, lead rate under 40% of median</td><td>Diagnosis</td></tr>
  </tbody></table></div></div>
  <div class="panel section-gap"><div class="panel-h"><h2>Budget rules</h2></div><div class="panel-b tbl-wrap"><table><thead><tr><th>When</th><th>Proposal</th></tr></thead><tbody>
    <tr><td>Over a third of rated leads at 1-2 stars</td><td>Budget −15%</td></tr>
    <tr><td>Out of budget before 2pm on 5+ days and CPL under 80% of the metro median</td><td>Budget +40% (needs approval)</td></tr>
    <tr><td>Out of budget before 2pm on 7+ days and CPL under the metro median</td><td>Budget +15%</td></tr>
    <tr><td>CPL over 1.5x the metro median</td><td>Budget −20%</td></tr>
  </tbody></table></div></div>`;
}

/* ===== Account drawer ===== */
function closeDrawer() { layer.innerHTML = ""; openId = null; document.removeEventListener("keydown", escClose); }
const escClose = e => { if (e.key === "Escape") closeDrawer(); };
const drawerState = { field: "weekly_budget", value: null, reason: "", source: "manual", ai: null };
function openAccount(id) {
  const a = byId[id]; if (!a) return;
  if (openId !== id) Object.assign(drawerState, { field: "weekly_budget", value: null, reason: "", source: "manual", ai: null });
  const scroll = openId === id ? layer.querySelector(".drawer")?.scrollTop : 0;
  openId = id;
  const fl = flagsOf[id] || [], m = METRO_CPL[a.metro], rec = a.rec, leads = (leadsOf[id] || []).slice(0, 12), tasks = tasksOf[id] || [];
  const changes = D.proposals.filter(p => p.account_id === id).slice(0, 8);
  const pace = a.cost / (a.weekly_budget * 2), ds = drawerState;
  const expDays = Math.round((new Date(a.license_expires + "T12:00") - new Date(META.today + "T12:00")) / 864e5);
  layer.innerHTML = `<div class="scrim"></div><aside class="drawer" role="dialog" aria-modal="true" aria-label="${esc(a.name)}">
    <div class="drawer-h"><div><h2>${esc(a.name)}</h2><div class="meta">${statusPill(a.status)}<span>${esc(a.business)}</span><span>·</span><span>${esc(a.metro)}, ${a.state}</span><span class="idc">${a.account_id}</span></div></div><button class="icon-btn x" aria-label="Close">${icon("close")}</button></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${a.status === "ACTIVE" ? `<button class="btn sm" data-act="pause">Pause ads</button>` : a.status === "PAUSED" ? `<button class="btn sm primary" data-act="resume">Resume ads</button>` : ""}
      ${a.license !== "VERIFIED" || expDays <= 30 ? `<button class="btn sm" data-act="renew">Record renewed license</button>` : ""}
      ${a.ladder.some(r => r.failing) ? `<button class="btn sm" data-act="tasks">Create fix tasks</button>` : ""}
      <button class="btn sm" data-act="rate">Rate this agent's leads</button>
    </div>
    <div class="mini-kpis">
      <div class="kpi"><div class="l">Spend, 14d</div><div class="v">${money(a.cost)}</div><div class="d">${pct(pace)} of budget</div></div>
      <div class="kpi"><div class="l">Leads, 14d</div><div class="v">${a.leads}</div><div class="d">${a.prev_leads} prior 14d</div></div>
      <div class="kpi"><div class="l">CPL</div><div class="v">${a.cpl ? money(a.cpl, 2) : "–"}</div><div class="d">${esc(a.metro)} median ${money(m, 2)}</div></div>
      <div class="kpi"><div class="l">Lead rate</div><div class="v">${a.imp ? pct(a.leads / a.imp, 2) : "–"}</div><div class="d">${num(a.imp)} impressions</div></div>
    </div>
    <div class="panel"><div class="panel-h"><h2>Daily spend</h2><span class="hint">Dashed line: daily budget (${money(a.weekly_budget / 7)})</span></div><div class="panel-b"><div class="chart" id="d-spend"></div></div></div>
    <div class="panel"><div class="panel-h"><h2>Daily leads</h2></div><div class="panel-b"><div class="chart" id="d-leads"></div></div></div>
    ${fl.length ? `<div class="panel"><div class="panel-h"><h2>Flags</h2></div><div class="panel-b"><div class="qlist">${fl.map(f => `<div class="qitem">${sevPill(f.severity)}<div><div class="t">${esc(f.check)}</div><div class="s">${esc(f.detail)} → ${esc(f.action)}</div></div><span></span></div>`).join("")}</div></div></div>` : ""}
    <div class="panel"><div class="panel-h"><h2>Cause checks</h2><span class="hint">${DARK[id] ? "Flagged: showing without leads" : "Not flagged as showing without leads"}</span></div><div class="panel-b">${ladderHtml(a.ladder)}
      ${tasks.length ? `<div style="margin-top:12px;display:grid;gap:6px">${tasks.map(t => `<div class="preview"><div class="row">${t.status === "open" ? `<span class="pill warn">Open task</span>` : `<span class="pill good">Done</span>`}<b>${esc(t.fix)}</b>${t.status === "open" ? `<button class="btn sm primary" data-done="${t.id}">Mark done</button>` : ""}</div></div>`).join("")}</div>` : ""}</div></div>
    <div class="panel"><div class="panel-h"><h2>Make a change</h2><span class="hint">Goes through the same guardrails as the pipeline</span><div class="right"><button class="btn sm" id="ai-btn" ${a.status !== "ACTIVE" ? "disabled" : ""}>${icon("spark")}AI review</button></div></div><div class="panel-b" style="display:grid;gap:12px">
      <div id="ai-out">${ds.ai || ""}</div>
      ${rec ? `<div class="preview"><div class="row"><span class="pill mute">rules</span><b>Recommend ${money(rec.new)} / week</b><span class="note">from ${money(a.weekly_budget)}</span></div><div>${esc(rec.reason)}</div><div class="row"><button class="btn sm" id="use-rec">Use this</button></div></div>` : `<p class="note" style="margin:0">Rules engine: no budget change recommended for this account today.</p>`}
      <div class="filters" style="margin:0">
        <label class="field">Field<select id="d-field">${Object.entries(META.fields).filter(([k]) => a[k] != null).map(([k, v]) => `<option value="${k}" ${ds.field === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
        <label class="field">New value<input id="d-val" type="number" step="1" value="${ds.value ?? a[ds.field]}" style="width:120px"></label>
        <label class="field" style="flex:1;min-width:180px">Reason<input id="d-reason" value="${esc(ds.reason)}" placeholder="Why this change"></label>
      </div>
      <div id="d-prev"></div>
      ${changes.length ? `<div><div class="note" style="margin-bottom:4px">Recent changes</div>${changes.map(p => `<div class="stat-line" style="padding:6px 0"><span>${fiso(p.sim_day)} · ${esc(META.fields[p.field])} ${fmtField(p.field, p.old)} → ${fmtField(p.field, p.new)} <span class="note">(${esc(p.source)})</span></span>${decisionPill(p.decision, p.applied)}</div>`).join("")}</div>` : ""}
    </div></div>
    <div class="panel"><div class="panel-h"><h2>Profile</h2></div><div class="panel-b"><div class="facts">
      ${[["Weekly budget", money(a.weekly_budget)], ["Bidding", a.bid_mode + (a.max_per_lead ? ` · ${money(a.max_per_lead)}` : "")], ["Rating", `${Number(a.rating).toFixed(1)}★ · ${a.reviews} reviews`],
        ["License", `${a.license.toLowerCase()} · ${expDays > 0 ? "expires in " + expDays + " days" : "expired"}`], ["Background check", a.background.toLowerCase()], ["Calls answered", pct(a.response_rate)],
        ["Service area", `${a.service_zips} ZIP codes`], ["Hours open", `${a.hours_per_week} / week`], ["Account created", new Date(a.created + "T12:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })]]
        .map(([l, v]) => `<div class="fact"><div class="l">${l}</div><div class="v">${esc(v)}</div></div>`).join("")}
    </div></div></div>
    <div class="panel"><div class="panel-h"><h2>Recent leads</h2></div><div class="panel-b tbl-wrap"><table><thead><tr><th>Received</th><th>Type</th><th>Request</th><th>Status</th><th>Rating</th><th class="r">Charge</th></tr></thead><tbody>
      ${leads.map(l => `<tr><td>${fdate(l.day)}, ${l.hour}:00</td><td>${l.type}${l.secs != null ? ` <span class="note">${l.secs < 60 ? l.secs + "s" : Math.round(l.secs / 60) + "m"}</span>` : ""}</td><td>${l.cat}</td><td>${l.status}${l.dispute ? ` <span class="pill ${l.dstatus === "credited" ? "good" : "warn"}">${esc(l.dstatus ? l.dstatus : l.dispute)}</span>` : ""}</td><td>${l.rating ? `<span class="stars"><i>${"★".repeat(l.rating)}</i></span>` : "–"}</td><td class="r">${l.charged ? money(l.cost) : "–"}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">No leads in the last ${META.lead_days} days</td></tr>`}</tbody></table></div></div>
  </aside>`;
  const drawer = layer.querySelector(".drawer"); if (scroll) drawer.scrollTop = scroll;
  layer.querySelector(".scrim").onclick = closeDrawer;
  layer.querySelector(".x").onclick = closeDrawer;
  document.removeEventListener("keydown", escClose); document.addEventListener("keydown", escClose);
  const labels = Array.from({ length: DAYS }, (_, i) => fdate(i)), tips = Array.from({ length: DAYS }, (_, i) => fdateLong(i));
  timeChart(document.getElementById("d-spend"), { values: a.daily.map(r => r ? r[3] : 0), labels, tipLabels: tips, color: "var(--s-spend)", fmt: v => money(v), ref: a.weekly_budget / 7, refLabel: "daily budget", height: 160, aria: "Daily spend", tipExtra: i => a.daily[i] && a.daily[i][4] != null ? `out of budget at ${a.daily[i][4]}:00` : a.daily[i] && a.daily[i][0] ? "budget lasted the day" : "not serving" });
  timeChart(document.getElementById("d-leads"), { values: a.daily.map(r => r ? r[1] : 0), labels, tipLabels: tips, color: "var(--s-leads)", fmt: v => `${v} lead${v === 1 ? "" : "s"}`, bars: true, height: 140, aria: "Daily leads", tipExtra: i => a.daily[i] ? `${a.daily[i][0]} impressions` : "not live" });

  drawer.querySelectorAll("[data-act]").forEach(b => b.onclick = async () => {
    const act = b.dataset.act;
    if (act === "pause" || act === "resume") { await api("/api/accounts/status", { account_id: id, status: act === "pause" ? "PAUSED" : "ACTIVE" }); toast(act === "pause" ? "Ads paused" : "Ads resumed"); }
    if (act === "renew") { await api("/api/accounts/renew-license", { account_id: id }); toast("License recorded as renewed"); }
    if (act === "tasks") { const r = await api("/api/tasks", { account_id: id }); toast(`${r.created} fix task${r.created === 1 ? "" : "s"} created`); }
    if (act === "rate") { const r = await api("/api/leads/feedback", { account_id: id }); toast(r.rated ? `${r.rated} leads rated` : "No unrated leads with a clear signal"); }
  });
  drawer.querySelectorAll("[data-done]").forEach(b => b.onclick = async () => { await api(`/api/tasks/${b.dataset.done}/done`); toast("Task done; account updated"); });

  const fSel = document.getElementById("d-field"), vIn = document.getElementById("d-val"), rIn = document.getElementById("d-reason"), prevEl = document.getElementById("d-prev");
  let pvT;
  const preview = () => {
    ds.field = fSel.value; ds.value = vIn.value === "" ? null : Number(vIn.value); ds.reason = rIn.value;
    clearTimeout(pvT);
    if (ds.value == null || ds.value === a[ds.field]) { prevEl.innerHTML = ""; return; }
    pvT = setTimeout(async () => {
      const r = await fetch("/api/preview/change", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account_id: id, field: ds.field, value: ds.value }) }).then(x => x.json());
      if (r.error) { prevEl.innerHTML = `<div class="err">${esc(r.error)}</div>`; return; }
      prevEl.innerHTML = `<div class="preview"><div class="row"><b>${fmtField(ds.field, a[ds.field])} → ${fmtField(ds.field, r.new)}</b><span class="${r.pct > 0 ? "delta-up" : "delta-down"}">${r.pct > 0 ? "+" : ""}${r.pct}%</span>${decisionPill(r.decision)}${r.note ? `<span class="note">${esc(r.note)}</span>` : ""}</div>
        <div class="note">${r.decision === "ok" ? (META.write_mode === "apply" ? "Within the guardrails: applies now and is logged." : "Within the guardrails: dry run, logged but not written.") : r.decision === "needs_approval" ? "Over the cap: goes to the approval queue." : r.decision === "blocked" ? `This account already had ${META.guard.per_day} change today.` : "Same as the current value."}</div>
        ${r.decision === "ok" || r.decision === "needs_approval" ? `<div class="row"><button class="btn sm primary" id="d-go">${r.decision === "needs_approval" ? "Send for approval" : META.write_mode === "apply" ? "Apply change" : "Run dry run"}</button></div>` : ""}</div>`;
      const go = document.getElementById("d-go");
      if (go) go.onclick = async () => {
        const body = { account_id: id, field: ds.field, value: ds.value, reason: ds.reason || (ds.source === "rules" && rec ? rec.reason : ds.source === "claude" ? "Claude recommendation" : "Manual change"), source: ds.source };
        Object.assign(ds, { value: null, reason: "", source: "manual" });
        const res = await api("/api/change", body);
        toast({ applied: "Change applied", dry_run: "Dry run logged", needs_approval: "Sent for approval", blocked: "Blocked by the daily limit", already_pending: "A change for this field is already waiting for approval" }[res.decision] || "Done");
      };
    }, 200);
  };
  fSel.onchange = () => { ds.value = null; vIn.value = a[fSel.value]; ds.source = "manual"; preview(); };
  vIn.oninput = preview;
  rIn.oninput = () => { ds.reason = rIn.value; };
  if (ds.value != null) preview();
  const useRec = document.getElementById("use-rec");
  if (useRec) useRec.onclick = () => { fSel.value = "weekly_budget"; vIn.value = rec.new; rIn.value = rec.reason; ds.source = "rules"; preview(); };

  document.getElementById("ai-btn").onclick = async () => {
    const out = document.getElementById("ai-out");
    if (!META.claude) { ds.ai = `<div class="ai-box"><div class="h">${icon("spark")}AI review</div><div>Claude isn't connected on this server. Start it with an ANTHROPIC_API_KEY to enable reviews. The rules recommendation below uses the same inputs.</div></div>`; out.innerHTML = ds.ai; return; }
    out.innerHTML = `<div class="ai-box"><div class="h">${icon("spark")}Claude is reviewing ${esc(a.name)}…</div><div class="note">Reads the last 14 days, flags and cause checks. Proposes; never writes.</div></div>`;
    busy(true);
    try {
      const r = await fetch("/api/ai-review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account_id: id }) }).then(x => x.json());
      if (r.error) throw new Error(r.error);
      const nb = Number(r.new_weekly_budget) || a.weekly_budget;
      ds.ai = `<div class="ai-box"><div class="h">${icon("spark")}Claude · ${esc(String(r.action || "").replace("_", " "))} → ${money(nb)} / week</div><div>${esc(r.summary || "")}</div>
        ${Array.isArray(r.reasons) && r.reasons.length ? `<ul>${r.reasons.slice(0, 3).map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        ${Array.isArray(r.account_fixes) && r.account_fixes.length ? `<div><b>Account fixes</b><ul>${r.account_fixes.slice(0, 3).map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
        ${nb !== a.weekly_budget ? `<button class="btn sm" data-ai-use="${nb}" data-ai-why="${esc(r.summary || "")}">Check against guardrails</button>` : ""}</div>`;
      await load(); refresh();
    } catch (e) { ds.ai = `<div class="ai-box"><div class="h">${icon("spark")}AI review</div><div>${esc(e.message)}</div></div>`; refresh(); }
    finally { busy(false); }
  };
  const aiUse = drawer.querySelector("[data-ai-use]");
  if (aiUse) aiUse.onclick = () => { fSel.value = "weekly_budget"; vIn.value = aiUse.dataset.aiUse; rIn.value = aiUse.dataset.aiWhy; ds.source = "claude"; preview(); };
}

/* ===== Router ===== */
const RENDER = { overview: viewOverview, accounts: viewAccounts, health: viewHealth, diagnosis: viewDiagnosis, leads: viewLeads, changes: viewChanges, automation: viewAutomation, log: viewLog, report: viewReport, about: viewAbout };
function refresh() {
  if (!D) return;
  const y = window.scrollY;
  renderNav();
  RENDER[current]();
  wireCommon();
  window.scrollTo(0, y);
  if (openId) openAccount(openId);
}
function route() {
  const h = location.hash.replace("#", "");
  const deep = h.startsWith("acct-") && byId && byId[h.slice(5)];
  current = deep ? "accounts" : RENDER[h] ? h : "overview";
  closeDrawer();
  refresh();
  window.scrollTo(0, 0);
  if (deep) openAccount(h.slice(5));
}
window.addEventListener("hashchange", route);
let rz; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (["overview", "diagnosis"].includes(current) || openId) refresh(); }, 200); });
try { const t = localStorage.getItem("lsa-ops-theme"); if (t) document.documentElement.dataset.theme = t; } catch (e) {}

// Pick up changes made by the autopilot or another browser.
async function poll() {
  try {
    const r = await fetch("/api/health", { cache: "no-store" }).then(x => x.json());
    const typing = document.activeElement && ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName);
    if (D && r.version !== META.version && !typing && busyN === 0) { await load(); refresh(); }
  } catch (e) {}
  setTimeout(poll, 3000);
}
(async () => {
  main.innerHTML = `<div class="empty">Loading the program…</div>`;
  try { await load(); route(); poll(); }
  catch (e) { main.innerHTML = `<div class="empty">${esc(e.message)}. Is the server running?</div>`; }
})();
})();
