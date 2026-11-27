/* eSoccer Radar — UI. Reads data/esoccer.json (built by fetch_esoccer.py). */
"use strict";

const DATA_URL = "data/esoccer.json";
const FORM = {
  hot:  { label: "Hot",       icon: "🔥", cls: "f-hot",  v: "--hot" },
  up:   { label: "Improving", icon: "▲",  cls: "f-up",   v: "--up" },
  flat: { label: "Steady",    icon: "●",  cls: "f-flat", v: "--flat" },
  down: { label: "Declining", icon: "▼",  cls: "f-down", v: "--down" },
  cold: { label: "Cold",      icon: "❄",  cls: "f-cold", v: "--cold" },
};
const VIEWS = ["summary", "analyst", "matches", "players", "h2h", "method"];
const TAB_INTRO = {
  summary: "Overview: top-rated players, who is hot or cold, the tournaments, and the next matches with the best value against Kalshi.",
  analyst: "For every upcoming match: our win/draw/loss probability, the Kalshi price, and the pick with the most value, with the reasons.",
  matches: "Upcoming matches with model vs Kalshi prices, and the latest results.",
  players: "Every player with record, Elo rating, form, streaks and last 10 results.",
  h2h: "Head-to-head records between players who meet often — in eSoccer the same pairs play hundreds of times.",
  method: "Where the data comes from, how the ratings and probabilities are calculated, and a backtest of their accuracy.",
};

let D = null, P = {}, charts = [], modalCharts = [];
const st = { tour: "all", q: "", sort: "elo", dir: -1, h2hA: "", minGames: 20 };

/* ---------------- helpers */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const pct = (x) => (x == null ? "–" : Math.round(x * 100) + "%");
const cents = (x) => (x == null ? "–" : Math.round(x * 100) + "¢");
const sgn = (x, d = 0) => (x > 0 ? "+" : "") + Number(x).toFixed(d);
const tShort = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
const dtShort = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const dShort = (iso) => new Date(iso + (iso.length === 10 ? "T12:00:00Z" : "")).toLocaleDateString("en-US", { month: "short", day: "2-digit" });
const initials = (n) => n.slice(0, 2).toUpperCase();
const minsTo = (iso) => Math.round((new Date(iso) - Date.now()) / 60000);
const kUrl = (id) => `https://kalshi.com/markets/kxesoccergame/esoccer-game/${id.toLowerCase()}`;
const kLink = (id) => `<a class="kal-link" href="${esc(kUrl(id))}" target="_blank" rel="noopener" title="Open the match on Kalshi">Kalshi</a>`;
const tourShort = (t) => t.replace("Valhalla Cup 4", "VC4").replace("Valhalla Cup", "VC").replace("Valkyrie Cup", "VK");

function chip(form) { const f = FORM[form] || FORM.flat; return `<span class="chip ${f.cls}"><span class="ic" aria-hidden="true">${f.icon}</span>${f.label}</span>`; }
function chipMini(form) { const f = FORM[form] || FORM.flat; return `<span style="color:var(${f.v})" title="${f.label}">${f.icon}</span>`; }
function av(name, size = "sm") { return `<span class="av ${size}" aria-hidden="true">${esc(initials(name))}</span>`; }
function resStrip(s) { return `<span class="st-res">${[...s].map((c) => `<i class="${c === "W" ? "W" : c === "D" ? "OTL" : "L"}" title="${c}"></i>`).join("")}</span>`; }
function edgeCell(ours, ask) {
  if (ours == null || ask == null || ask <= 0) return `<span class="dim">–</span>`;
  const d = Math.round((ours - ask) * 100);
  const cls = d >= 4 ? "edge-pos" : d <= -4 ? "edge-neg" : "edge-flat";
  return `<span class="edge ${cls}" title="Our probability minus the Kalshi Yes price">${d > 0 ? "+" : ""}${d} pts</span>`;
}
const started = (m) => minsTo(m.start) <= 0;
const inTour = (p) => st.tour === "all" || p.tours.includes(st.tour);
const mInTour = (m) => st.tour === "all" || m.tour === st.tour;

function tourSeg(id) {
  const opts = [["all", "All"], ...D.tournaments.map((t) => [t.name, t.name])];
  return `<div class="seg" id="${id}">${opts.map(([v, l]) => `<button type="button" data-v="${esc(v)}" aria-pressed="${st.tour === v}">${esc(l)}</button>`).join("")}</div>`;
}
function bindTour(id) { $("#" + id)?.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { st.tour = b.dataset.v; route(); } }); }

/* ---------------- charts */
function baseOpts(extra = {}) {
  const grid = css("--chart-grid"), tick = css("--fg-3");
  return Object.assign({
    responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
    plugins: { legend: { labels: { color: css("--fg-2"), boxWidth: 10, boxHeight: 10, usePointStyle: true, font: { size: 11 } } },
      tooltip: { backgroundColor: css("--panel-2"), titleColor: css("--fg"), bodyColor: css("--fg-2"), borderColor: css("--line"), borderWidth: 1, padding: 10 } },
    scales: { x: { grid: { color: grid, drawTicks: false }, ticks: { color: tick, font: { size: 10.5 }, maxRotation: 0, autoSkipPadding: 10 }, border: { color: grid } },
      y: { grid: { color: grid, drawTicks: false }, ticks: { color: tick, font: { size: 10.5 }, padding: 6 }, border: { display: false } } },
  }, extra);
}
function mk(canvas, cfg, bucket) { const c = new Chart(canvas, cfg); bucket.push(c); return c; }
function destroy(b) { b.forEach((c) => c.destroy()); b.length = 0; }
function candleChart(canvas, candles, bucket) {
  const up = css("--candle-up"), dn = css("--candle-down");
  const isUp = candles.map((c) => c[4] >= c[1]);
  const span = Math.max(1, ...candles.map((c) => c[2] - c[3]));
  const body = candles.map((c) => (Math.abs(c[4] - c[1]) < span * 0.02 ? [c[1] - span * 0.01, c[1] + span * 0.01] : [c[1], c[4]]));
  const o = baseOpts();
  o.plugins.legend = { display: false };
  o.plugins.tooltip.filter = (it) => it.datasetIndex === 1;
  o.plugins.tooltip.callbacks = { title: (it) => dShort(candles[it[0].dataIndex][0]), label: (it) => { const c = candles[it.dataIndex]; return [`Open ${c[1]} · Close ${c[4]}`, `High ${c[2]} · Low ${c[3]}`, `Change ${sgn(c[4] - c[1], 1)}`]; } };
  o.scales.y.beginAtZero = false; o.scales.y.grace = "6%";
  return mk(canvas, { type: "bar", data: { labels: candles.map((c) => dShort(c[0])), datasets: [
    { data: candles.map((c) => [c[3], c[2]]), backgroundColor: isUp.map((u) => (u ? up : dn)), barThickness: 2, grouped: false, order: 2 },
    { data: body, backgroundColor: isUp.map((u) => (u ? up : dn)), borderRadius: 3, barPercentage: 0.6, grouped: false, order: 1 }] }, options: o }, bucket);
}

/* ---------------- boot / routing */
async function boot() {
  try { const r = await fetch(DATA_URL, { cache: "no-cache" }); if (!r.ok) throw 0; D = await r.json(); }
  catch (e) { $("#app").innerHTML = `<div class="panel"><div class="empty">Could not load <code>${DATA_URL}</code>. Run <code>python nhl_dashboard/fetch_esoccer.py</code>.</div></div>`; return; }
  D.players.forEach((p) => (P[p.name] = p));
  const gen = new Date(D.generatedAt);
  $("#meta").innerHTML = `<span><span class="live-dot" aria-hidden="true"></span>Updated <b>${gen.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</b></span>
    <span>Last result <b>${D.lastMatch ? dtShort(D.lastMatch) : "–"}</b></span>
    <span><a class="nhl-link" href="../">NHL Radar ↗</a></span>
    <button class="theme-btn" id="theme-btn" type="button">Theme</button>`;
  $("#theme-btn").addEventListener("click", () => { const r = document.documentElement; const cur = r.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"); r.dataset.theme = cur === "dark" ? "light" : "dark"; try { localStorage.setItem("es-theme", r.dataset.theme); } catch (e) {} route(); });
  window.addEventListener("hashchange", route);
  route();
}
try { const t = localStorage.getItem("es-theme"); if (t) document.documentElement.dataset.theme = t; } catch (e) {}

function route() {
  let v = (location.hash || "#summary").slice(1);
  if (!VIEWS.includes(v)) v = "summary";
  document.querySelectorAll(".tab").forEach((a) => a.setAttribute("aria-current", a.getAttribute("href") === "#" + v ? "page" : "false"));
  destroy(charts);
  const app = $("#app");
  ({ summary: viewSummary, analyst: viewAnalyst, matches: viewMatches, players: viewPlayers, h2h: viewH2H, method: viewMethod })[v](app);
  const view = app.querySelector(".view");
  if (view && TAB_INTRO[v]) view.insertAdjacentHTML("afterbegin", `<p class="tab-intro">${TAB_INTRO[v]}</p>`);
  app.querySelectorAll("[data-pl]").forEach((el) => el.addEventListener("click", (e) => { if (e.target.closest("a")) return; openPlayer(el.dataset.pl); }));
}

/* ---------------- analyst core */
function analyze(m) {
  const opts = [
    ["A", `${m.a} wins`, m.ma, m.pa.ask],
    ["T", "Draw", m.md, m.pt.ask],
    ["B", `${m.b} wins`, m.mb, m.pb.ask],
  ].map(([k, label, p, ask]) => ({ k, label, p, ask, edge: ask != null && ask > 0 && ask < 1 ? p - ask : null }));
  const best = opts.filter((o) => o.edge != null).sort((x, y) => y.edge - x.edge)[0] || null;
  return { opts, best };
}
function rating(edge) { return edge >= 0.06 ? ["Strong", "rt-strong"] : edge >= 0.035 ? ["Good", "rt-good"] : ["Moderate", "rt-mod"]; }
function reasons(m, pick) {
  const A = P[m.a], B = P[m.b];
  const r = [];
  r.push(`<b>Value:</b> our ${pct(pick.p)} vs ${cents(pick.ask)} on Kalshi (${sgn(Math.round(pick.edge * 100))} pts).`);
  if (A && B) r.push(`Elo ${m.a} ${Math.round(m.ea)} vs ${m.b} ${Math.round(m.eb)} (${sgn(Math.round(m.ea - m.eb))}).`);
  const [hw, hd, hl] = m.h2h; const hn = hw + hd + hl;
  if (hn) r.push(`Head-to-head: ${m.a} ${hw}W ${hd}D ${hl}L in ${hn} meetings.`);
  const sub = pick.k === "B" ? B : pick.k === "A" ? A : null;
  if (sub) {
    if (sub.form === "hot" || sub.form === "up") r.push(`${FORM[sub.form].icon} ${sub.name} is ${FORM[sub.form].label.toLowerCase()}: last 10 ${sub.l10} (Elo ${sgn(sub.elo7, 0)} in 7 days).`);
    else r.push(`${sub.name} last 10: ${sub.l10}${sub.streak ? ` · streak ${sub.streak}` : ""}.`);
  } else r.push(`Draws happen in ${pct(D.tournaments.find((t) => t.name === m.tour)?.drawRate)} of ${esc(m.tour)} matches.`);
  return r;
}
function matchCard(m, withReasons = true) {
  const { opts, best } = analyze(m);
  const mins = minsTo(m.start);
  const when = mins > 0 ? `in ${mins} min · ${tShort(m.start)}` : `started ${-mins} min ago`;
  const show = best && best.edge >= 0.02;
  const [rl, rc] = show ? rating(best.edge) : ["", ""];
  return `<article class="pickc">
    <div class="pickc-h">${av(m.a)}<div style="min-width:0"><div class="nm"><span data-pl="${esc(m.a)}" style="cursor:pointer">${esc(m.a)}</span>&nbsp;<span class="dim">vs</span>&nbsp;<span data-pl="${esc(m.b)}" style="cursor:pointer">${esc(m.b)}</span> ${kLink(m.id)}</div>
      <div class="dim" style="font-size:12px">${esc(m.tour)} · ${esc(m.ta)} vs ${esc(m.tb)} · ${when}</div></div>${show ? `<span class="rt ${rc}">${rl}</span>` : ""}</div>
    <div class="tbl-wrap"><table class="tbl" style="min-width:0"><thead><tr><th class="l">Outcome</th><th>Ours</th><th>Kalshi</th><th>Edge</th></tr></thead><tbody>
      ${opts.map((o) => `<tr style="cursor:default${show && o.k === best.k ? ";font-weight:700" : ""}"><td class="l">${esc(o.label)}</td><td class="pct">${pct(o.p)}</td><td>${cents(o.ask)}</td><td>${edgeCell(o.p, o.ask)}</td></tr>`).join("")}</tbody></table></div>
    ${show && withReasons ? `<div class="pickc-m"><span class="mk mk-point">Pick: ${esc(best.label)}</span></div><ul class="why">${reasons(m, best).map((t) => `<li>${t}</li>`).join("")}</ul>` : show ? "" : `<div class="dim" style="font-size:12px">No value: Kalshi prices are at or above our probabilities.</div>`}
  </article>`;
}
const upcomingOpen = () => D.upcoming.filter((m) => !started(m) && mInTour(m));

/* ---------------- views */
function viewSummary(app) {
  const pl = D.players.filter((p) => p.gp >= st.minGames && inTour(p));
  const counts = { hot: 0, up: 0, flat: 0, down: 0, cold: 0 }; pl.forEach((p) => counts[p.form]++);
  const lists = ["hot", "cold"].map((f) => [f, pl.filter((p) => p.form === f).sort((a, b) => (f === "hot" ? b.trend - a.trend : a.trend - b.trend)).slice(0, 8)]);
  const val = upcomingOpen().map((m) => ({ m, a: analyze(m) })).filter((x) => x.a.best && x.a.best.edge >= 0.02).sort((x, y) => y.a.best.edge - x.a.best.edge).slice(0, 4);
  app.innerHTML = `<div class="view">
    <div>${tourSeg("tour-seg")}</div>
    <section class="kpis">
      <div class="kpi"><div class="lbl">Players</div><div class="val">${pl.length}</div><div class="hint">${st.minGames}+ matches</div></div>
      <div class="kpi"><div class="lbl">Matches analyzed</div><div class="val">${D.matches.toLocaleString("en-US")}</div><div class="hint">last ${D.days} days</div></div>
      <div class="kpi"><div class="lbl">Draw rate</div><div class="val">${pct(D.model.drawRate)}</div><div class="hint">all tournaments</div></div>
      <div class="kpi"><div class="lbl">Upcoming on Kalshi</div><div class="val">${upcomingOpen().length}</div><div class="hint">not started yet</div></div>
    </section>
    <section class="panel"><div class="panel-h"><h2>Form meter</h2><span class="sub">Elo change over 7 days + results vs expectation, last 10</span></div><div class="panel-b">
      <div style="display:flex;height:16px;border-radius:8px;overflow:hidden;gap:2px">${Object.keys(FORM).map((f) => `<div title="${FORM[f].label}: ${counts[f]}" style="flex:${counts[f]};background:var(${FORM[f].v})"></div>`).join("")}</div>
      <div class="legend" style="margin-top:10px">${Object.keys(FORM).map((f) => `${chip(f)} <span class="num" style="margin-right:8px">${counts[f]}</span>`).join("")}</div></div></section>
    <div class="grid g-main">
      <section class="panel"><div class="panel-h"><h2>Top rated</h2><span class="sub">Elo rating</span><a class="right" href="#players" style="font-size:12px">See all →</a></div>
        <div class="panel-b"><div class="cands">${pl.slice().sort((a, b) => b.elo - a.elo).slice(0, 12).map((p, i) => `<button class="cand" data-pl="${esc(p.name)}" type="button">${av(p.name, "")}
          <span style="min-width:0"><div class="nm"><span class="rank">${i + 1}</span>${esc(p.name)}</div><div class="sub">${p.tours.map(tourShort).join(", ")} · ${p.w}-${p.d}-${p.l}</div><div class="sub" style="margin-top:3px">${chip(p.form)} ${resStrip(p.l10)}</div></span>
          <span class="score"><b class="num">${Math.round(p.elo)}</b><small>Elo</small></span></button>`).join("")}</div></div></section>
      <section class="panel"><div class="panel-h"><h2>Best value now</h2><a class="right" href="#analyst" style="font-size:12px">All matches →</a></div>
        <div class="panel-b" style="display:grid;gap:10px">${val.length ? val.map((x) => matchCard(x.m, false)).join("") : `<div class="empty">No upcoming match with value at the last update.</div>`}</div></section>
    </div>
    <div class="grid g2">${lists.map(([f, arr]) => `<section class="panel top-${f}"><div class="panel-h trend-head"><h3>${chip(f)}</h3></div><div class="panel-b"><div class="tlist">
      ${arr.map((p) => `<button class="trow" data-pl="${esc(p.name)}" type="button">${av(p.name)}<span><div class="nm">${esc(p.name)}</div><div class="sub">${p.tours.map(tourShort).join(", ")} · Elo ${Math.round(p.elo)} · streak ${p.streak}</div></span>${resStrip(p.l10)}<span class="delta ${p.elo7 >= 0 ? "pos" : "neg"}">${sgn(p.elo7)}</span></button>`).join("") || `<div class="empty">Nobody right now.</div>`}</div></div></section>`).join("")}</div>
    <section class="panel"><div class="panel-h"><h2>Tournaments</h2></div><div class="panel-b"><div class="tbl-wrap"><table class="tbl" style="min-width:420px"><thead><tr><th class="l">Tournament</th><th>Matches</th><th>Players</th><th>Draw rate</th></tr></thead><tbody>
      ${D.tournaments.map((t) => `<tr style="cursor:default"><td class="l">${esc(t.name)}</td><td>${t.matches.toLocaleString("en-US")}</td><td>${t.players}</td><td>${pct(t.drawRate)}</td></tr>`).join("")}</tbody></table></div></div></section>
  </div>`;
  bindTour("tour-seg");
}

function viewAnalyst(app) {
  const ups = upcomingOpen();
  const analyzed = ups.map((m) => ({ m, a: analyze(m) }));
  const withVal = analyzed.filter((x) => x.a.best && x.a.best.edge >= 0.02).sort((x, y) => y.a.best.edge - x.a.best.edge);
  app.innerHTML = `<div class="view">
    <section class="panel"><div class="panel-b" style="display:grid;gap:10px">
      <div style="font-size:13px;color:var(--fg-2)">For each upcoming match the analyst compares our win / draw / loss probabilities with the Kalshi Yes prices and picks the outcome with the biggest edge (only if it beats the price by 2+ points). Prices are a snapshot from the last update; matches start every few minutes, so always open <b>Kalshi</b> for the live price.</div>
      ${tourSeg("tour-seg")}
      <div class="legend"><span class="rt rt-strong">Strong</span> +6 pts or more <span class="rt rt-good">Good</span> +3.5 to +6 <span class="rt rt-mod">Moderate</span> +2 to +3.5</div>
    </div></section>
    <section class="panel"><div class="panel-h"><h2>Value picks</h2><span class="sub">${withVal.length} of ${ups.length} upcoming matches</span></div>
      <div class="panel-b"><div class="ana-top">${withVal.map((x) => matchCard(x.m)).join("") || `<div class="empty">No value picks among the upcoming matches. Ask for an update closer to the next matches.</div>`}</div></div></section>
    <section class="panel"><div class="panel-h"><h2>Other upcoming matches</h2></div>
      <div class="panel-b"><div class="ana-top">${analyzed.filter((x) => !withVal.includes(x)).map((x) => matchCard(x.m, false)).join("") || `<div class="empty">None.</div>`}</div></div></section>
  </div>`;
  bindTour("tour-seg");
}

function viewMatches(app) {
  const ups = D.upcoming.filter(mInTour);
  const rec = D.recent.filter(mInTour).slice(-80).reverse();
  const resTxt = (m) => (m.res === "A" ? `<b>${esc(m.a)}</b> won` : m.res === "B" ? `<b>${esc(m.b)}</b> won` : "Draw");
  app.innerHTML = `<div class="view">
    <div>${tourSeg("tour-seg")}</div>
    <section class="panel"><div class="panel-h"><h2>Upcoming</h2><span class="sub">Ours vs Kalshi Yes price · A / Draw / B</span></div><div class="panel-b"><div class="tbl-wrap"><table class="tbl" style="min-width:900px">
      <thead><tr><th class="l">Start</th><th class="l">Tournament</th><th class="l">Match</th><th>A ours</th><th>A Kalshi</th><th>Draw ours</th><th>Draw Kalshi</th><th>B ours</th><th>B Kalshi</th><th class="l">H2H (A-D-B)</th><th class="l"></th></tr></thead>
      <tbody>${ups.map((m) => `<tr style="cursor:default${started(m) ? ";opacity:.55" : ""}"><td class="l">${tShort(m.start)}${started(m) ? ' <span class="kal-live">● live</span>' : ""}</td><td class="l">${tourShort(m.tour)}</td>
        <td class="l"><span data-pl="${esc(m.a)}" style="cursor:pointer;font-weight:600">${esc(m.a)}</span> <span class="dim">(${esc(m.ta)})</span> vs <span data-pl="${esc(m.b)}" style="cursor:pointer;font-weight:600">${esc(m.b)}</span> <span class="dim">(${esc(m.tb)})</span></td>
        <td class="pct">${pct(m.ma)}</td><td>${cents(m.pa.ask)} ${started(m) ? "" : edgeCell(m.ma, m.pa.ask)}</td><td class="pct">${pct(m.md)}</td><td>${cents(m.pt.ask)} ${started(m) ? "" : edgeCell(m.md, m.pt.ask)}</td><td class="pct">${pct(m.mb)}</td><td>${cents(m.pb.ask)} ${started(m) ? "" : edgeCell(m.mb, m.pb.ask)}</td>
        <td class="l">${m.h2h.join("-")}</td><td class="l">${kLink(m.id)}</td></tr>`).join("") || `<tr><td colspan="11"><div class="empty">No upcoming matches listed.</div></td></tr>`}</tbody></table></div>
      <p class="chart-note">Matches that already started at the last update are dimmed; their prices were in-game.</p></div></section>
    <section class="panel"><div class="panel-h"><h2>Latest results</h2></div><div class="panel-b"><div class="tbl-wrap"><table class="tbl" style="min-width:640px">
      <thead><tr><th class="l">Time</th><th class="l">Tournament</th><th class="l">Match</th><th class="l">Result</th></tr></thead>
      <tbody>${rec.map((m) => `<tr style="cursor:default"><td class="l">${dtShort(m.start)}</td><td class="l">${tourShort(m.tour)}</td><td class="l"><span data-pl="${esc(m.a)}" style="cursor:pointer">${esc(m.a)}</span> <span class="dim">(${esc(m.ta)})</span> vs <span data-pl="${esc(m.b)}" style="cursor:pointer">${esc(m.b)}</span> <span class="dim">(${esc(m.tb)})</span></td><td class="l">${resTxt(m)}</td></tr>`).join("")}</tbody></table></div></div></section>
  </div>`;
  bindTour("tour-seg");
}

const COLS = [["rank", "#"], ["name", "Player", "l"], ["tours", "Tournament", "l"], ["gp", "GP"], ["w", "W"], ["d", "D"], ["l", "L"], ["winPct", "Win%"], ["ppg", "Pts/GP"],
  ["elo", "Elo"], ["elo24", "Elo 24h"], ["elo7", "Elo 7d"], ["l10", "Last 10", "l"], ["streak", "Streak"], ["form", "Form", "l"]];
const FORD = { hot: 4, up: 3, flat: 2, down: 1, cold: 0 };
function viewPlayers(app) {
  app.innerHTML = `<div class="view"><section class="panel"><div class="panel-h"><h2>Players</h2><span class="sub" id="pc"></span></div><div class="panel-b" style="display:grid;gap:14px">
    <div class="filters"><label class="fld">Search<input type="search" id="q" value="${esc(st.q)}" placeholder="Name…"></label><div class="fld">Tournament${tourSeg("tour-seg")}</div>
      <label class="fld">Min. GP <input type="number" id="mg" min="0" value="${st.minGames}" style="width:72px"></label></div>
    <div class="tbl-wrap"><table class="tbl" id="pt"><thead><tr>${COLS.map(([k, l, a]) => `<th class="${a || ""}" data-k="${k}" ${st.sort === k ? `aria-sort="${st.dir < 0 ? "descending" : "ascending"}"` : ""}>${l}</th>`).join("")}</tr></thead><tbody></tbody></table></div>
  </div></section></div>`;
  const draw = () => {
    const q = st.q.toLowerCase();
    const rows = D.players.filter((p) => inTour(p) && p.gp >= st.minGames && (!q || p.name.toLowerCase().includes(q)));
    const k = st.sort;
    rows.sort((a, b) => { const x = k === "form" ? FORD[a.form] : k === "tours" ? a.tours.join() : a[k], y = k === "form" ? FORD[b.form] : k === "tours" ? b.tours.join() : b[k]; return (typeof x === "string" ? x.localeCompare(y) : x - y) * st.dir; });
    $("#pc").textContent = `${rows.length} players`;
    $("#pt tbody").innerHTML = rows.map((p) => `<tr data-pl="${esc(p.name)}"><td>${p.rank}</td><td class="l"><span class="pl">${av(p.name)}<b>${esc(p.name)}</b></span></td><td class="l">${p.tours.map(tourShort).join(", ")}</td>
      <td>${p.gp}</td><td>${p.w}</td><td>${p.d}</td><td>${p.l}</td><td><b>${pct(p.winPct)}</b></td><td>${p.ppg.toFixed(2)}</td><td><b>${Math.round(p.elo)}</b></td>
      <td class="${p.elo24 >= 0 ? "pos" : "neg"}">${sgn(p.elo24)}</td><td class="${p.elo7 >= 0 ? "pos" : "neg"}">${sgn(p.elo7)}</td><td class="l">${resStrip(p.l10)}</td><td>${esc(p.streak)}</td><td class="l">${chip(p.form)}</td></tr>`).join("") || `<tr><td colspan="15"><div class="empty">No players match.</div></td></tr>`;
    $("#pt tbody").querySelectorAll("[data-pl]").forEach((el) => el.addEventListener("click", () => openPlayer(el.dataset.pl)));
  };
  $("#q").addEventListener("input", (e) => { st.q = e.target.value; draw(); });
  $("#mg").addEventListener("input", (e) => { st.minGames = +e.target.value || 0; draw(); });
  $("#pt thead").addEventListener("click", (e) => { const th = e.target.closest("th"); if (!th) return; const k = th.dataset.k; if (st.sort === k) st.dir *= -1; else { st.sort = k; st.dir = ["name", "tours", "rank", "l"].includes(k) ? 1 : -1; } $("#pt thead").querySelectorAll("th").forEach((x) => x.removeAttribute("aria-sort")); th.setAttribute("aria-sort", st.dir < 0 ? "descending" : "ascending"); draw(); });
  bindTour("tour-seg");
  draw();
}

function viewH2H(app) {
  const names = D.players.filter(inTour).map((p) => p.name).sort();
  if (!st.h2hA || !names.includes(st.h2hA)) st.h2hA = names[0] || "";
  const rows = D.h2h.filter((r) => r[0] === st.h2hA || r[1] === st.h2hA).map((r) => (r[0] === st.h2hA ? { opp: r[1], w: r[2], d: r[3], l: r[4] } : { opp: r[0], w: r[4], d: r[3], l: r[2] }))
    .map((r) => ({ ...r, n: r.w + r.d + r.l })).sort((a, b) => b.n - a.n);
  app.innerHTML = `<div class="view"><section class="panel"><div class="panel-h"><h2>Head-to-head</h2></div><div class="panel-b" style="display:grid;gap:14px">
    <div class="filters"><div class="fld">Tournament${tourSeg("tour-seg")}</div><label class="fld">Player<select id="ha">${names.map((n) => `<option ${n === st.h2hA ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label></div>
    <div class="tbl-wrap"><table class="tbl" style="min-width:560px"><thead><tr><th class="l">Opponent</th><th>Meetings</th><th>W</th><th>D</th><th>L</th><th>Win%</th><th class="l">Share</th></tr></thead><tbody>
      ${rows.map((r) => `<tr data-pl="${esc(r.opp)}"><td class="l"><span class="pl">${av(r.opp)}<b>${esc(r.opp)}</b></span></td><td>${r.n}</td><td>${r.w}</td><td>${r.d}</td><td>${r.l}</td><td><b>${pct(r.w / r.n)}</b></td>
        <td class="l"><span style="display:inline-flex;width:160px;height:10px;border-radius:5px;overflow:hidden;gap:1px"><i style="flex:${r.w};background:var(--up)"></i><i style="flex:${r.d};background:var(--gold)"></i><i style="flex:${r.l};background:var(--down)"></i></span></td></tr>`).join("") || `<tr><td colspan="7"><div class="empty">No opponents with 3+ meetings.</div></td></tr>`}</tbody></table></div>
    <div class="legend"><span class="st-res"><i class="W"></i></span> Win <span class="st-res"><i class="OTL"></i></span> Draw <span class="st-res"><i class="L"></i></span> Loss</div>
  </div></section></div>`;
  bindTour("tour-seg");
  $("#ha").addEventListener("change", (e) => { st.h2hA = e.target.value; route(); });
}

function viewMethod(app) {
  const M = D.model, c = M.calibration;
  const tb = (rows, title) => `<div class="tbl-wrap" style="margin:8px 0 14px"><table class="tbl" style="min-width:420px"><thead><tr><th class="l">${title}: predicted</th><th>Matches</th><th>Avg. predicted</th><th>Actually happened</th><th>Difference</th></tr></thead>
    <tbody>${rows.map((r) => `<tr style="cursor:default"><td class="l">${Math.round(r[0] * 100)}–${Math.min(100, Math.round(r[1] * 100))}%</td><td>${r[2].toLocaleString("en-US")}</td><td>${pct(r[3])}</td><td><b>${pct(r[4])}</b></td><td class="${Math.abs(r[4] - r[3]) <= 0.03 ? "pos" : "neg"}">${sgn((r[4] - r[3]) * 100, 1)} pts</td></tr>`).join("")}</tbody></table></div>`;
  app.innerHTML = `<div class="view"><section class="panel"><div class="panel-b method">
    <h3>Source</h3>
    <p>Kalshi's public API, series <code>KXESOCCERGAME</code> (eSoccer Game), settled by Drafted.gg. Every match is one Kalshi event with three markets (player A wins, player B wins, draw). Settled markets give the result; open markets give the current Yes price. We keep the last ${D.days} days: ${D.matches.toLocaleString("en-US")} matches from ${dtShort(D.firstMatch)} to ${dtShort(D.lastMatch)}. Tournaments are EA Sports FC matches of 2×4 minutes played around the clock.</p>
    <p>Kalshi only publishes who won or drew, not the score, so these stats are about results, not goals.</p>
    <h3>Elo rating</h3>
    <p>Every player starts at 1500. After each match the winner takes points from the loser in proportion to how surprising the result was (K = ${M.K}, larger for a player's first 20 matches). A draw moves ratings toward each other. The <b>Elo 24h / 7d</b> columns are the change over the last day and week.</p>
    <h3>Win / draw / loss probability</h3>
    <p>The Elo gap gives the expected score. The draw chance is ${pct(M.d0)} for evenly matched players and shrinks as the gap grows (width ${M.w} Elo). Because the same pairs meet hundreds of times, the result is then blended with that pair's own head-to-head record, with a weight of ${M.kPair} matches for the Elo prior. All parameters were chosen by minimizing log-loss on the history.</p>
    <h3>Form</h3>
    <p>Combines the Elo change over 7 days with results above or below expectation in the last 10 matches. ${chip("hot")} strong rise, ${chip("up")} rising, ${chip("flat")} steady, ${chip("down")} falling, ${chip("cold")} sharp drop.</p>
    <h3>Analyst and edge</h3>
    <p><b>Edge</b> = our probability − the Kalshi Yes price. The analyst picks the outcome with the largest edge if it is at least +2 points: Strong +6 or more, Good +3.5 to +6, Moderate +2 to +3.5. It excludes fees and anything the price already knows.</p>
    <h3>How accurate is it? (backtest)</h3>
    <p>Each match was predicted using only the matches before it (${c.n.toLocaleString("en-US")} predictions, players with 10+ prior matches). Multiclass Brier score: ${c.brier} (lower is better; always guessing the average rates scores ${c.brierBase ?? "–"}). Log-loss: ${M.logloss}.</p>
    ${tb(c.win, "Player A wins")}${tb(c.draw, "Draw")}
    <h3>Updates and limits</h3>
    <p>New matches start every few minutes, so the prices here are a snapshot of the last update. Use the <b>Kalshi</b> link for the live price. These are statistical estimates, not guarantees.</p>
  </div></section></div>`;
}

/* ---------------- player sheet */
function openPlayer(name) {
  const p = P[name];
  if (!p) return;
  destroy(modalCharts);
  const next = D.upcoming.filter((m) => (m.a === name || m.b === name) && !started(m)).slice(0, 6);
  const opp = D.h2h.filter((r) => r[0] === name || r[1] === name).map((r) => (r[0] === name ? [r[1], r[2], r[3], r[4]] : [r[0], r[4], r[3], r[2]])).sort((a, b) => b[1] + b[2] + b[3] - (a[1] + a[2] + a[3])).slice(0, 8);
  const sh = $("#sheet");
  sh.innerHTML = `
    <div class="sheet-h">${av(name, "lg")}<div><h2 id="sheet-title">${esc(name)}</h2><div class="facts"><span>${p.tours.join(", ")}</span><span>#${p.rank} by Elo</span>${chip(p.form)}<span>Streak ${esc(p.streak)}</span></div></div>
      <button class="close" type="button" aria-label="Close">×</button></div>
    <div class="statline">${[["GP", p.gp], ["W-D-L", `${p.w}-${p.d}-${p.l}`], ["Win%", pct(p.winPct)], ["Pts/GP", p.ppg.toFixed(2)], ["Elo", Math.round(p.elo)], ["Elo 24h", sgn(p.elo24)], ["Elo 7d", sgn(p.elo7)], ["Last 20", `${p.l20w}-${p.l20d}-${p.l20l}`]].map(([l, v]) => `<div><small>${l}</small><b>${v}</b></div>`).join("")}</div>
    <section class="panel"><div class="panel-h"><h3>Next matches</h3></div><div class="panel-b"><div class="ana-top">${next.map((m) => matchCard(m)).join("") || `<div class="empty">No upcoming match listed on Kalshi.</div>`}</div></div></section>
    <section class="panel"><div class="panel-h"><h3>Daily Elo candles</h3><span class="sub">Green = rating rose that day</span></div><div class="panel-b"><div class="chart-box"><canvas id="m-c"></canvas></div></div></section>
    <div class="grid g2">
      <section class="panel"><div class="panel-h"><h3>Win% by hour (your time)</h3></div><div class="panel-b"><div class="chart-box short"><canvas id="m-h"></canvas></div></div></section>
      <section class="panel"><div class="panel-h"><h3>Teams used</h3></div><div class="panel-b"><div class="tbl-wrap"><table class="tbl" style="min-width:0"><thead><tr><th class="l">Team</th><th>W</th><th>D</th><th>L</th><th>Win%</th></tr></thead><tbody>
        ${p.teams.map((t) => `<tr style="cursor:default"><td class="l">${esc(t[0])}</td><td>${t[1]}</td><td>${t[2]}</td><td>${t[3]}</td><td><b>${pct(t[1] / (t[1] + t[2] + t[3]))}</b></td></tr>`).join("")}</tbody></table></div></div></section>
    </div>
    <section class="panel"><div class="panel-h"><h3>Most frequent opponents</h3></div><div class="panel-b"><div class="tbl-wrap"><table class="tbl" style="min-width:0"><thead><tr><th class="l">Opponent</th><th>W</th><th>D</th><th>L</th><th>Win%</th></tr></thead><tbody>
      ${opp.map((o) => `<tr style="cursor:default"><td class="l">${esc(o[0])}</td><td>${o[1]}</td><td>${o[2]}</td><td>${o[3]}</td><td><b>${pct(o[1] / (o[1] + o[2] + o[3]))}</b></td></tr>`).join("")}</tbody></table></div></div></section>
    <section class="panel"><div class="panel-h"><h3>Last matches</h3></div><div class="panel-b"><div class="tbl-wrap"><table class="tbl" style="min-width:0"><thead><tr><th class="l">Time</th><th class="l">Opponent</th><th class="l">Team</th><th class="l">Result</th></tr></thead><tbody>
      ${p.log.slice(-15).reverse().map((r) => `<tr style="cursor:default"><td class="l">${dtShort(r[0])}</td><td class="l">${esc(r[1])}</td><td class="l">${esc(r[2])}</td><td class="l">${resStrip(r[3])} ${r[3]}</td></tr>`).join("")}</tbody></table></div></div></section>`;
  $("#modal").hidden = false; document.body.style.overflow = "hidden"; sh.scrollTop = 0;
  $(".close", sh).addEventListener("click", closeModal);
  sh.querySelectorAll("[data-pl]").forEach((el) => el.addEventListener("click", (e) => { if (!e.target.closest("a")) openPlayer(el.dataset.pl); }));
  candleChart($("#m-c"), p.candles, modalCharts);
  // hours are stored in UTC; convert to the viewer's local hour
  const off = -new Date().getTimezoneOffset() / 60;
  const byH = Array.from({ length: 24 }, () => [0, 0, 0]);
  p.hours.forEach(([h, w, d, l]) => { const lh = (((h + off) % 24) + 24) % 24; byH[lh][0] += w; byH[lh][1] += d; byH[lh][2] += l; });
  const o = baseOpts(); o.plugins.legend.display = false; o.scales.y.ticks.callback = (v) => v + "%"; o.scales.y.max = 100;
  o.plugins.tooltip.callbacks = { label: (it) => { const r = byH[it.dataIndex]; const n = r[0] + r[1] + r[2]; return n ? `${Math.round((100 * r[0]) / n)}% wins · ${r[0]}-${r[1]}-${r[2]}` : "no matches"; } };
  mk($("#m-h"), { type: "bar", data: { labels: byH.map((_, i) => String(i).padStart(2, "0")), datasets: [{ data: byH.map((r) => { const n = r[0] + r[1] + r[2]; return n ? Math.round((100 * r[0]) / n) : null; }), backgroundColor: byH.map((r) => { const n = r[0] + r[1] + r[2]; return n && r[0] / n >= p.winPct ? css("--candle-up") : css("--candle-down"); }), borderRadius: 3 }] }, options: o }, modalCharts);
}
function closeModal() { destroy(modalCharts); $("#modal").hidden = true; document.body.style.overflow = ""; }
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal").hidden) closeModal(); });
document.addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

boot();
