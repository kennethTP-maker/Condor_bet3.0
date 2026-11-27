/* eSoccer Radar — UI. Reads data/esoccer.json (built by fetch_esoccer.py). */
"use strict";

const DATA_URL = window.ES_DATA || "data/esoccer.json";
/* sport settings come from the data file (eSoccer or eBasketball) */
let SP = { key: "esoccer", name: "eSoccer Radar", series: "KXESOCCERGAME", kslug: "esoccer-game", draws: true, unit: "goal", drafted: ["valkyrie-cup", "valhalla-cup"], lines: [4.5, 5.5, 6.5] };
const U = () => (SP.unit === "point" ? { one: "point", many: "points", Many: "Points", gf: "PF/G", ga: "PA/G", tot: "Pts/G" } : { one: "goal", many: "goals", Many: "Goals", gf: "GF/G", ga: "GA/G", tot: "Goals/G" });
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
  h2h: "Head-to-head records between players who meet often — in these leagues the same pairs play hundreds of times.",
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
const kUrl = (id) => `https://kalshi.com/markets/${SP.series.toLowerCase()}/${SP.kslug}/${id.toLowerCase()}`;
const kLink = (id) => `<a class="kal-link" href="${esc(kUrl(id))}" target="_blank" rel="noopener" title="Open the match on Kalshi">Kalshi</a>`;
const tourShort = (t) => t.replace("Valhalla Cup 4", "VC4").replace("Valhalla Cup", "VC").replace("Valkyrie Cup", "VK").replace("Valhalla League", "VL");

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
const f2 = (x) => (x == null ? "–" : Number(x).toFixed(2));
const G = (p, k = "all") => (p && p.goals && p.goals[k]) || null;
const scoreTxt = (sc, h1) => (sc ? `${sc[0]}–${sc[1]}${h1 ? ` <span class="dim">(HT ${h1[0]}–${h1[1]})</span>` : ""}` : `<span class="dim">–</span>`);
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
  if (D.sport) { SP = D.sport; document.title = SP.name; const h = $(".brand h1"); if (h) h.textContent = SP.name; }
  const gen = new Date(D.generatedAt);
  $("#meta").innerHTML = `<span><span class="live-dot" aria-hidden="true"></span>Updated <b>${gen.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</b></span>
    <span>Last result <b>${D.lastMatch ? dtShort(D.lastMatch) : "–"}</b></span>
    <span><a class="nhl-link" href="../">NHL Radar ↗</a></span>
    <span>${SP.key === "ebasketball" ? '<a class="nhl-link" href="../esoccer/">eSoccer Radar ↗</a>' : '<a class="nhl-link" href="../ebasketball/">eBasketball Radar ↗</a>'}</span>
    <button class="theme-btn" id="theme-btn" type="button">Theme</button>`;
  $("#theme-btn").addEventListener("click", () => { const r = document.documentElement; const cur = r.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"); r.dataset.theme = cur === "dark" ? "light" : "dark"; try { localStorage.setItem("es-theme", r.dataset.theme); } catch (e) {} route(); });
  window.addEventListener("hashchange", route);
  route();
  startLive();
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
  if (view && TAB_INTRO[v]) view.insertAdjacentHTML("afterbegin", `<p class="tab-intro">${SP.draws ? TAB_INTRO[v] : TAB_INTRO[v].replace("win/draw/loss", "win/loss")}</p>`);
  app.querySelectorAll("[data-pl]").forEach((el) => el.addEventListener("click", (e) => { if (e.target.closest("a")) return; openPlayer(el.dataset.pl); }));
}

/* ---------------- analyst core */
function analyze(m) {
  const opts = [
    ["A", `${m.a} wins`, m.ma, m.pa.ask],
    ...(SP.draws ? [["T", "Draw", m.md, m.pt.ask]] : []),
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
  if (hn) r.push(`Head-to-head: ${m.a} ${hw}W ${SP.draws ? hd + "D " : ""}${hl}L in ${hn} meetings.`);
  const ga = G(A, "d24"), gb = G(B, "d24");
  if (ga && gb && ga.n >= 3 && gb.n >= 3) r.push(`Last 24h: ${m.a} scores ${f2(ga.gf)} / concedes ${f2(ga.ga)} per game; ${m.b} ${f2(gb.gf)} / ${f2(gb.ga)}.`);
  const sub = pick.k === "B" ? B : pick.k === "A" ? A : null;
  if (sub) {
    if (sub.form === "hot" || sub.form === "up") r.push(`${FORM[sub.form].icon} ${sub.name} is ${FORM[sub.form].label.toLowerCase()}: last 10 ${sub.l10} (Elo ${sgn(sub.elo7, 0)} in 7 days).`);
    else r.push(`${sub.name} last 10: ${sub.l10}${sub.streak ? ` · streak ${sub.streak}` : ""}.`);
  } else if (SP.draws) r.push(`Draws happen in ${pct(D.tournaments.find((t) => t.name === m.tour)?.drawRate)} of ${esc(m.tour)} matches.`);
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
      <div class="dim" style="font-size:12px">${esc(m.tour)} · ${esc(m.ta)} vs ${esc(m.tb)} · ${when}${m.xg ? ` · exp. score ${m.xg[0].toFixed(1)}–${m.xg[1].toFixed(1)}` : ""}</div></div>${show ? `<span class="rt ${rc}">${rl}</span>` : ""}</div>
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
      ${SP.draws ? `<div class="kpi"><div class="lbl">Draw rate</div><div class="val">${pct(D.model.drawRate)}</div><div class="hint">all tournaments</div></div>` : `<div class="kpi"><div class="lbl">Typical total</div><div class="val">${SP.lines ? Math.round(SP.lines[1] + 0.5) : "–"}</div><div class="hint">median points per game</div></div>`}
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
    ${(() => { const rows = pl.filter((p) => G(p, "d24") && G(p, "d24").n >= 5).sort((a, b) => G(b, "d24").gf - G(a, "d24").gf).slice(0, 10);
      return rows.length ? `<section class="panel"><div class="panel-h"><h2>Last 24 hours</h2><span class="sub">Drafted.gg scores · most ${U().many} scored per game (5+ matches)</span></div><div class="panel-b"><div class="tbl-wrap"><table class="tbl" style="min-width:560px">
      <thead><tr><th class="l">Player</th><th>Matches</th><th>${U().gf}</th><th>${U().ga}</th><th>${U().tot}</th>${SP.draws ? "<th>BTTS</th>" : ""}<th>O${SP.lines[1]}</th></tr></thead><tbody>
      ${rows.map((p) => { const g = G(p, "d24"); return `<tr data-pl="${esc(p.name)}"><td class="l"><span class="pl">${av(p.name)}<b>${esc(p.name)}</b> <span class="dim">${p.tours.map(tourShort).join(", ")}</span></span></td><td>${g.n}</td><td><b>${f2(g.gf)}</b></td><td>${f2(g.ga)}</td><td>${f2(g.tot)}</td>${SP.draws ? `<td>${pct(g.btts)}</td>` : ""}<td>${pct(g.ov ? g.ov[1] : g.o55)}</td></tr>`; }).join("")}</tbody></table></div></div></section>` : ""; })()}
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
      <div style="font-size:13px;color:var(--fg-2)">For each upcoming match the analyst compares our ${SP.draws ? "win / draw / loss" : "win / loss"} probabilities with the Kalshi Yes prices and picks the outcome with the biggest edge (only if it beats the price by 2+ points). Prices are a snapshot from the last update; matches start every few minutes, so always open <b>Kalshi</b> for the live price.</div>
      ${tourSeg("tour-seg")}
      <div class="legend"><span class="rt rt-strong">Strong</span> +6 pts or more <span class="rt rt-good">Good</span> +3.5 to +6 <span class="rt rt-mod">Moderate</span> +2 to +3.5</div>
    </div></section>
    <section class="panel"><div class="panel-h"><h2>Value picks</h2><span class="sub">${withVal.length} of ${ups.length} upcoming matches</span></div>
      <div class="panel-b"><div class="ana-top">${withVal.map((x) => matchCard(x.m)).join("") || `<div class="empty">No value picks among the upcoming matches. Ask for an update closer to the next matches.</div>`}</div></div></section>
    <section class="panel"><div class="panel-h"><h2>Other upcoming matches</h2></div>
      <div class="panel-b"><div class="ana-top">${analyzed.filter((x) => !withVal.includes(x)).map((x) => matchCard(x.m, false)).join("") || `<div class="empty">None.</div>`}</div></div></section>
    ${trackPanel()}
  </div>`;
  bindTour("tour-seg");
}

function viewMatches(app) {
  const ups = D.upcoming.filter(mInTour);
  const rec = D.recent.filter(mInTour).slice(-80).reverse();
  const resTxt = (m) => (m.res === "A" ? `<b>${esc(m.a)}</b> won` : m.res === "B" ? `<b>${esc(m.b)}</b> won` : "Draw");
  app.innerHTML = `<div class="view">
    <div>${tourSeg("tour-seg")}</div>
    <section class="panel"><div class="panel-h"><h2>Upcoming</h2><span class="sub">Ours vs Kalshi Yes price · ${SP.draws ? "A / Draw / B" : "A / B"}</span></div><div class="panel-b"><div class="tbl-wrap"><table class="tbl" style="min-width:900px">
      <thead><tr><th class="l">Start</th><th class="l">Tournament</th><th class="l">Match</th><th>A ours</th><th>A Kalshi</th>${SP.draws ? "<th>Draw ours</th><th>Draw Kalshi</th>" : ""}<th>B ours</th><th>B Kalshi</th><th class="l">H2H (${SP.draws ? "A-D-B" : "A-B"})</th><th title="Expected score from each player's scoring and conceding averages">Exp. score</th><th class="l"></th></tr></thead>
      <tbody>${ups.map((m) => `<tr style="cursor:default${started(m) ? ";opacity:.55" : ""}"><td class="l">${tShort(m.start)}${started(m) ? ' <span class="kal-live">● live</span>' : ""}</td><td class="l">${tourShort(m.tour)}</td>
        <td class="l"><span data-pl="${esc(m.a)}" style="cursor:pointer;font-weight:600">${esc(m.a)}</span> <span class="dim">(${esc(m.ta)})</span> vs <span data-pl="${esc(m.b)}" style="cursor:pointer;font-weight:600">${esc(m.b)}</span> <span class="dim">(${esc(m.tb)})</span></td>
        <td class="pct">${pct(m.ma)}</td><td>${cents(m.pa.ask)} ${started(m) ? "" : edgeCell(m.ma, m.pa.ask)}</td>${SP.draws ? `<td class="pct">${pct(m.md)}</td><td>${cents(m.pt.ask)} ${started(m) ? "" : edgeCell(m.md, m.pt.ask)}</td>` : ""}<td class="pct">${pct(m.mb)}</td><td>${cents(m.pb.ask)} ${started(m) ? "" : edgeCell(m.mb, m.pb.ask)}</td>
        <td class="l">${SP.draws ? m.h2h.join("-") : m.h2h[0] + "-" + m.h2h[2]}</td><td>${m.xg ? `${m.xg[0].toFixed(1)}–${m.xg[1].toFixed(1)}` : "–"}</td><td class="l">${kLink(m.id)}</td></tr>`).join("") || `<tr><td colspan="12"><div class="empty">No upcoming matches listed.</div></td></tr>`}</tbody></table></div>
      <p class="chart-note">Matches that already started at the last update are dimmed; their prices were in-game.</p></div></section>
    <section class="panel"><div class="panel-h"><h2>Latest results</h2></div><div class="panel-b"><div class="tbl-wrap"><table class="tbl" style="min-width:640px">
      <thead><tr><th class="l">Time</th><th class="l">Tournament</th><th class="l">Match</th><th class="l">Score</th><th class="l">Result</th></tr></thead>
      <tbody>${rec.map((m) => `<tr style="cursor:default"><td class="l">${dtShort(m.start)}</td><td class="l">${tourShort(m.tour)}</td><td class="l"><span data-pl="${esc(m.a)}" style="cursor:pointer">${esc(m.a)}</span> <span class="dim">(${esc(m.ta)})</span> vs <span data-pl="${esc(m.b)}" style="cursor:pointer">${esc(m.b)}</span> <span class="dim">(${esc(m.tb)})</span></td><td class="l">${scoreTxt(m.score, m.h1)}</td><td class="l">${resTxt(m)}</td></tr>`).join("")}</tbody></table></div></div></section>
  </div>`;
  bindTour("tour-seg");
}

function COLS_() {
  const u = U();
  return [["rank", "#"], ["name", "Player", "l"], ["tours", "Tournament", "l"], ["gp", "GP"], ["w", "W"], ...(SP.draws ? [["d", "D"]] : []), ["l", "L"], ["winPct", "Win%"], ...(SP.draws ? [["ppg", "Pts/GP"]] : []),
    ["elo", "Elo"], ["elo24", "Elo 24h"], ["elo7", "Elo 7d"], ["gf", u.gf], ["ga", u.ga], ["tot", u.tot], ...(SP.draws ? [["btts", "BTTS"]] : []), ["ovm", "O" + SP.lines[1]],
    ["l10", "Last 10", "l"], ["streak", "Streak"], ["form", "Form", "l"]];
}
const FORD = { hot: 4, up: 3, flat: 2, down: 1, cold: 0 };
function viewPlayers(app) {
  app.innerHTML = `<div class="view"><section class="panel"><div class="panel-h"><h2>Players</h2><span class="sub" id="pc"></span></div><div class="panel-b" style="display:grid;gap:14px">
    <div class="filters"><label class="fld">Search<input type="search" id="q" value="${esc(st.q)}" placeholder="Name…"></label><div class="fld">Tournament${tourSeg("tour-seg")}</div>
      <label class="fld">Min. GP <input type="number" id="mg" min="0" value="${st.minGames}" style="width:72px"></label></div>
    <div class="tbl-wrap"><table class="tbl" id="pt"><thead><tr>${COLS_().map(([k, l, a]) => `<th class="${a || ""}" data-k="${k}" ${st.sort === k ? `aria-sort="${st.dir < 0 ? "descending" : "ascending"}"` : ""}>${l}</th>`).join("")}</tr></thead><tbody></tbody></table></div>
  </div></section></div>`;
  const draw = () => {
    const q = st.q.toLowerCase();
    const rows = D.players.filter((p) => inTour(p) && p.gp >= st.minGames && (!q || p.name.toLowerCase().includes(q)));
    const k = st.sort;
    const val = (p) => (k === "form" ? FORD[p.form] : k === "tours" ? p.tours.join() : k === "ovm" ? (G(p) && G(p).ov ? G(p).ov[1] : -1) : ["gf", "ga", "tot", "btts"].includes(k) ? (G(p) ? G(p)[k] : -1) : p[k]);
    rows.sort((a, b) => { const x = val(a), y = val(b); return (typeof x === "string" ? x.localeCompare(y) : x - y) * st.dir; });
    $("#pc").textContent = `${rows.length} players`;
    $("#pt tbody").innerHTML = rows.map((p) => `<tr data-pl="${esc(p.name)}"><td>${p.rank}</td><td class="l"><span class="pl">${av(p.name)}<b>${esc(p.name)}</b></span></td><td class="l">${p.tours.map(tourShort).join(", ")}</td>
      <td>${p.gp}</td><td>${p.w}</td>${SP.draws ? `<td>${p.d}</td>` : ""}<td>${p.l}</td><td><b>${pct(p.winPct)}</b></td>${SP.draws ? `<td>${p.ppg.toFixed(2)}</td>` : ""}<td><b>${Math.round(p.elo)}</b></td>
      <td class="${p.elo24 >= 0 ? "pos" : "neg"}">${sgn(p.elo24)}</td><td class="${p.elo7 >= 0 ? "pos" : "neg"}">${sgn(p.elo7)}</td>
      <td>${f2(G(p)?.gf)}</td><td>${f2(G(p)?.ga)}</td><td><b>${f2(G(p)?.tot)}</b></td>${SP.draws ? `<td>${pct(G(p)?.btts)}</td>` : ""}<td>${pct(G(p)?.ov ? G(p).ov[1] : G(p)?.o55)}</td><td class="l">${resStrip(p.l10)}</td><td>${esc(p.streak)}</td><td class="l">${chip(p.form)}</td></tr>`).join("") || `<tr><td colspan="20"><div class="empty">No players match.</div></td></tr>`;
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
    <div class="tbl-wrap"><table class="tbl" style="min-width:560px"><thead><tr><th class="l">Opponent</th><th>Meetings</th><th>W</th>${SP.draws ? "<th>D</th>" : ""}<th>L</th><th>Win%</th><th class="l">Share</th></tr></thead><tbody>
      ${rows.map((r) => `<tr data-pl="${esc(r.opp)}"><td class="l"><span class="pl">${av(r.opp)}<b>${esc(r.opp)}</b></span></td><td>${r.n}</td><td>${r.w}</td>${SP.draws ? `<td>${r.d}</td>` : ""}<td>${r.l}</td><td><b>${pct(r.w / r.n)}</b></td>
        <td class="l"><span style="display:inline-flex;width:160px;height:10px;border-radius:5px;overflow:hidden;gap:1px"><i style="flex:${r.w};background:var(--up)"></i><i style="flex:${r.d};background:var(--gold)"></i><i style="flex:${r.l};background:var(--down)"></i></span></td></tr>`).join("") || `<tr><td colspan="7"><div class="empty">No opponents with 3+ meetings.</div></td></tr>`}</tbody></table></div>
    <div class="legend"><span class="st-res"><i class="W"></i></span> Win ${SP.draws ? '<span class="st-res"><i class="OTL"></i></span> Draw ' : ""}<span class="st-res"><i class="L"></i></span> Loss</div>
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
    <p>Kalshi's public API, series <code>${SP.series}</code> (${SP.unit === "point" ? "eBasketball" : "eSoccer"} Game), settled by Drafted.gg. Every match is one Kalshi event with ${SP.draws ? "three markets (player A wins, player B wins, draw)" : "two markets (player A wins, player B wins)"}. Settled markets give the result; open markets give the current Yes price. We keep the last ${D.days} days: ${D.matches.toLocaleString("en-US")} matches from ${dtShort(D.firstMatch)} to ${dtShort(D.lastMatch)}. ${SP.unit === "point" ? "The Valhalla League plays NBA 2K games around the clock." : "Tournaments are EA Sports FC matches of 2×4 minutes played around the clock."}</p>
    <p>Scores come from Drafted.gg's own results pages (the organizer that settles the Kalshi markets), read hour by hour: final score, ${SP.unit === "point" ? "points per quarter" : "goals per half"} and kick-off time. They are matched to the Kalshi results by players and kick-off time. Last run: ${D.drafted ? `${D.drafted.drafted.toLocaleString("en-US")} Drafted matches, ${D.drafted.matched.toLocaleString("en-US")} matched to Kalshi, result agreement ${D.drafted.matched ? pct(D.drafted.agree / D.drafted.matched) : "–"}` : "not available"}. ${U().Many} stats (${U().gf}, ${U().ga}, totals${SP.draws ? ", both teams to score" : ""}, overs) use only matches with a stored score; ratings and probabilities use every Kalshi result.</p>
    <h3>Elo rating</h3>
    <p>Every player starts at 1500. After each match the winner takes points from the loser in proportion to how surprising the result was (K = ${M.K}, larger for a player's first 20 matches). ${SP.draws ? "A draw moves ratings toward each other." : ""} The <b>Elo 24h / 7d</b> columns are the change over the last day and week.</p>
    <h3>${SP.draws ? "Win / draw / loss" : "Win / loss"} probability</h3>
    <p>The Elo gap gives the expected score.${SP.draws ? ` The draw chance is ${pct(M.d0)} for evenly matched players and shrinks as the gap grows (width ${M.w} Elo).` : ""} Because the same pairs meet hundreds of times, the result is then blended with that pair's own head-to-head record, with a weight of ${M.kPair} matches for the Elo prior. All parameters were chosen by minimizing log-loss on the history.</p>
    <h3>Form</h3>
    <p>Combines the Elo change over 7 days with results above or below expectation in the last 10 matches. ${chip("hot")} strong rise, ${chip("up")} rising, ${chip("flat")} steady, ${chip("down")} falling, ${chip("cold")} sharp drop.</p>
    <h3>Analyst and edge</h3>
    <p><b>Edge</b> = our probability − the Kalshi Yes price. The analyst picks the outcome with the largest edge if it is at least +2 points: Strong +6 or more, Good +3.5 to +6, Moderate +2 to +3.5. It excludes fees and anything the price already knows.</p>
    <h3>How accurate is it? (backtest)</h3>
    <p>Each match was predicted using only the matches before it (${c.n.toLocaleString("en-US")} predictions, players with 10+ prior matches). Multiclass Brier score: ${c.brier} (lower is better; always guessing the average rates scores ${c.brierBase ?? "–"}). Log-loss: ${M.logloss}.</p>
    ${tb(c.win, "Player A wins")}${SP.draws && c.draw.length ? tb(c.draw, "Draw") : ""}
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
    <div class="statline">${[["GP", p.gp], ...(SP.draws ? [["W-D-L", `${p.w}-${p.d}-${p.l}`], ["Win%", pct(p.winPct)], ["Pts/GP", p.ppg.toFixed(2)]] : [["W-L", `${p.w}-${p.l}`], ["Win%", pct(p.winPct)], [U().gf, p.goals && p.goals.all ? p.goals.all.gf.toFixed(1) : "–"]]), ["Elo", Math.round(p.elo)], ["Elo 24h", sgn(p.elo24)], ["Elo 7d", sgn(p.elo7)], ["Last 20", SP.draws ? `${p.l20w}-${p.l20d}-${p.l20l}` : `${p.l20w}-${p.l20l}`]].map(([l, v]) => `<div><small>${l}</small><b>${v}</b></div>`).join("")}</div>
    ${goalsPanel(p)}
    <section class="panel"><div class="panel-h"><h3>Next matches</h3></div><div class="panel-b"><div class="ana-top">${next.map((m) => matchCard(m)).join("") || `<div class="empty">No upcoming match listed on Kalshi.</div>`}</div></div></section>
    <section class="panel"><div class="panel-h"><h3>Daily Elo candles</h3><span class="sub">Green = rating rose that day</span></div><div class="panel-b"><div class="chart-box"><canvas id="m-c"></canvas></div></div></section>
    <div class="grid g2">
      <section class="panel"><div class="panel-h"><h3>Win% by hour (your time)</h3></div><div class="panel-b"><div class="chart-box short"><canvas id="m-h"></canvas></div></div></section>
      <section class="panel"><div class="panel-h"><h3>Teams used</h3></div><div class="panel-b"><div class="tbl-wrap"><table class="tbl" style="min-width:0"><thead><tr><th class="l">Team</th><th>W</th>${SP.draws ? "<th>D</th>" : ""}<th>L</th><th>Win%</th></tr></thead><tbody>
        ${p.teams.map((t) => `<tr style="cursor:default"><td class="l">${esc(t[0])}</td><td>${t[1]}</td>${SP.draws ? `<td>${t[2]}</td>` : ""}<td>${t[3]}</td><td><b>${pct(t[1] / (t[1] + t[2] + t[3]))}</b></td></tr>`).join("")}</tbody></table></div></div></section>
    </div>
    <section class="panel"><div class="panel-h"><h3>Most frequent opponents</h3></div><div class="panel-b"><div class="tbl-wrap"><table class="tbl" style="min-width:0"><thead><tr><th class="l">Opponent</th><th>W</th>${SP.draws ? "<th>D</th>" : ""}<th>L</th><th>Win%</th></tr></thead><tbody>
      ${opp.map((o) => `<tr style="cursor:default"><td class="l">${esc(o[0])}</td><td>${o[1]}</td>${SP.draws ? `<td>${o[2]}</td>` : ""}<td>${o[3]}</td><td><b>${pct(o[1] / (o[1] + o[2] + o[3]))}</b></td></tr>`).join("")}</tbody></table></div></div></section>
    <section class="panel"><div class="panel-h"><h3>Last matches</h3></div><div class="panel-b"><div class="tbl-wrap"><table class="tbl" style="min-width:0"><thead><tr><th class="l">Time</th><th class="l">Opponent</th><th class="l">Team</th><th class="l">Score</th><th class="l">Result</th></tr></thead><tbody>
      ${p.log.slice(-15).reverse().map((r) => `<tr style="cursor:default"><td class="l">${dtShort(r[0])}</td><td class="l">${esc(r[1])}</td><td class="l">${esc(r[2])}</td><td class="l">${r[5] ? `${r[5][0]}–${r[5][1]}` : "–"}</td><td class="l">${resStrip(r[3])} ${r[3]}</td></tr>`).join("")}</tbody></table></div></div></section>`;
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
function goalsPanel(p) {
  if (!p.goals) return `<section class="panel"><div class="panel-b dim">No Drafted.gg scores for this player in the stored window yet.</div></section>`;
  const cols = [["d24", "Last 24 h"], ["l10", "Last 10 scored"], ["all", `All scored (${p.goals.all.n})`]];
  const row = (lbl, f) => `<tr style="cursor:default"><td class="l">${lbl}</td>${cols.map(([k]) => `<td>${p.goals[k] ? f(p.goals[k]) : "–"}</td>`).join("")}</tr>`;
  return `<section class="panel"><div class="panel-h"><h3>${U().Many}</h3><span class="sub">From Drafted.gg match scores</span></div><div class="panel-b"><div class="tbl-wrap"><table class="tbl" style="min-width:0">
    <thead><tr><th class="l"></th>${cols.map(([, l]) => `<th>${l}</th>`).join("")}</tr></thead><tbody>
    ${row("Matches", (g) => g.n)}${row(`${U().Many} for / game`, (g) => `<b>${f2(g.gf)}</b>`)}${row(`${U().Many} against / game`, (g) => f2(g.ga))}${row(`Total ${U().many} / game`, (g) => `<b>${f2(g.tot)}</b>`)}
    ${row(`1st-half ${U().many} for`, (g) => f2(g.h1gf))}${SP.draws ? row("Both score", (g) => pct(g.btts)) : ""}${SP.lines.map((ln, i) => row("Over " + ln, (g) => pct(g.ov ? g.ov[i] : g[["o45", "o55", "o65"][i]]))).join("")}${SP.draws ? row("Clean sheet", (g) => pct(g.cs)) : ""}
    </tbody></table></div></div></section>`;
}
function closeModal() { destroy(modalCharts); $("#modal").hidden = true; document.body.style.overflow = ""; }
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal").hidden) closeModal(); });
document.addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

/* ---------------- LIVE MODE: Kalshi + Drafted.gg through the radar-live Cloudflare Worker ---------------- */
const PROXY = "https://radar-live.kenneth-tp.workers.dev";
const LIVE = { on: false, last: null, err: null, busy: false, timer: null, ticks: 0 };
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
let H2H = null;   // "A|B" (sorted) -> [wins first, draws, wins second]

function h2hKey(a, b) { return a < b ? a + "|" + b : b + "|" + a; }
function buildH2H() { H2H = new Map(); D.h2h.forEach((r) => H2H.set(h2hKey(r[0], r[1]), [r[2], r[3], r[4]])); }
function pairRec(a, b) { const r = H2H.get(h2hKey(a, b)) || [0, 0, 0]; return a < b ? r : [r[2], r[1], r[0]]; }
function expected(ra, rb) { return 1 / (1 + Math.pow(10, (rb - ra) / 400)); }
function modelProbs(a, b) {
  const M = D.model, ra = P[a] ? P[a].elo : 1500, rb = P[b] ? P[b].elo : 1500;
  const e = expected(ra, rb), pd0 = M.d0 * Math.exp(-Math.pow((ra - rb) / M.w, 2));
  let pa = Math.max(1e-4, e - pd0 / 2), pb = Math.max(1e-4, 1 - e - pd0 / 2), pd = pd0;
  const s = pa + pb + pd; pa /= s; pb /= s; pd /= s;
  const rec = pairRec(a, b), n = rec[0] + rec[1] + rec[2], k = M.kPair || 40;
  if (n) { pa = (rec[0] + k * pa) / (n + k); pd = (rec[1] + k * pd) / (n + k); pb = (rec[2] + k * pb) / (n + k); }
  return { pa, pd, pb, rec, ra, rb };
}
const money = (x) => (x == null || x === "" ? null : Math.round(parseFloat(x) * 10000) / 10000);

function parseKalshi(markets) {
  const ev = new Map();
  markets.forEach((m) => { const a = ev.get(m.event_ticker) || []; a.push(m); ev.set(m.event_ticker, a); });
  const out = [];
  ev.forEach((ms, et) => {
    const suf = et.split("-")[1] || "";
    if (!/^\d{2}[A-Z]{3}\d{6}[A-Z0-9]+$/.test(suf)) return;
    const rules = ms[0].rules_primary || "";
    const tour = (rules.match(/professional (.+?) \d{4} Week/) || [0, "?"])[1];
    const tm = rules.match(/scheduled for (\w{3} \d{1,2}, \d{4}) at (\d{1,2}:\d{2} [AP]M) (E[SD]T)/);
    let start;
    if (tm) start = new Date(tm[1] + " " + tm[2] + (tm[3] === "EST" ? " GMT-0500" : " GMT-0400"));
    else start = new Date(Date.UTC(2000 + +suf.slice(0, 2), MONTHS[suf.slice(2, 5)], +suf.slice(5, 7), +suf.slice(7, 9) + 5, +suf.slice(9, 11)));
    let tie = null; const sides = {};
    ms.forEach((m) => {
      const code = m.ticker.split("-").pop();
      if (code === "TIE") { tie = m; return; }
      const t = (m.title || "").match(/^(.*) \((.+)\) wins$/);
      if (t) sides[code] = { team: t[1], player: t[2], m };
    });
    const codes = Object.keys(sides);
    if (codes.length !== 2 || (SP.draws && !tie)) return;
    tie = tie || {};
    const rv = rules.match(/in the (.+?) \((.+?)\) vs (.+?) \((.+?)\) professional/);
    if (rv) codes.sort((x) => (sides[x].player === rv[2] ? -1 : 1));
    const A = sides[codes[0]], B = sides[codes[1]];
    const res = A.m.result === "yes" ? "A" : B.m.result === "yes" ? "B" : tie.result === "yes" ? "T" : null;
    const open = [A.m, B.m, tie].some((m) => m && m.status === "active");
    out.push({ id: et, tour, start: start.toISOString().slice(0, 16) + "Z", a: A.player, b: B.player, ta: A.team, tb: B.team, res, open,
      pa: { ask: money(A.m.yes_ask_dollars), bid: money(A.m.yes_bid_dollars) }, pb: { ask: money(B.m.yes_ask_dollars), bid: money(B.m.yes_bid_dollars) },
      pt: { ask: money(tie.yes_ask_dollars), bid: money(tie.yes_bid_dollars) } });
  });
  return out;
}

async function getJSON(path) { const r = await fetch(PROXY + path, { cache: "no-store" }); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }
async function kalshiMarkets(q) {
  let all = [], cursor = "";
  for (let i = 0; i < 5; i++) {
    const d = await getJSON("/kalshi/markets?series_ticker=" + SP.series + "&limit=1000&" + q + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
    all = all.concat(d.markets || []); cursor = d.cursor;
    if (!cursor || !(d.markets || []).length) break;
  }
  return all;
}

/* apply a newly settled match to ratings, records and lists */
function applyResult(m) {
  const K = D.model.K;
  [m.a, m.b].forEach((n) => { if (!P[n]) { const p = { name: n, tours: [m.tour], gp: 0, w: 0, d: 0, l: 0, winPct: 0, ppg: 0, elo: 1500, elo24: 0, elo7: 0, form: "flat", trend: 0, streak: "", l10: "", l20w: 0, l20d: 0, l20l: 0, teams: [], hours: [], candles: [], log: [], goals: null, rank: 0 }; P[n] = p; D.players.push(p); } });
  const A = P[m.a], B = P[m.b];
  const s = m.res === "A" ? 1 : m.res === "T" ? 0.5 : 0, e = expected(A.elo, B.elo);
  A.elo += K * (s - e); B.elo -= K * (s - e); A.elo24 += K * (s - e); B.elo24 -= K * (s - e); A.elo7 += K * (s - e); B.elo7 -= K * (s - e);
  [[A, m.b, m.ta, s], [B, m.a, m.tb, 1 - s]].forEach(([p, opp, team, sc]) => {
    const r = sc === 1 ? "W" : sc === 0.5 ? "D" : "L";
    p.gp++; p[r === "W" ? "w" : r === "D" ? "d" : "l"]++; p.winPct = p.w / p.gp; p.ppg = (3 * p.w + p.d) / p.gp;
    p.l10 = (p.l10 + r).slice(-10);
    const m2 = p.streak.match(/^([WDL])(\d+)$/); p.streak = m2 && m2[1] === r ? r + (+m2[2] + 1) : r + "1";
    p.log.push([m.start, opp, team, r, m.id, null]); if (p.log.length > 40) p.log.shift();
    p.lastPlayed = m.start;
  });
  const key = h2hKey(m.a, m.b), rec = H2H.get(key) || [0, 0, 0];
  const firstIsA = m.a < m.b; rec[m.res === "T" ? 1 : (m.res === "A") === firstIsA ? 0 : 2]++; H2H.set(key, rec);
  D.recent.push({ id: m.id, tour: m.tour, start: m.start, a: m.a, b: m.b, ta: m.ta, tb: m.tb, res: m.res, score: null, h1: null });
  if (D.recent.length > 400) D.recent.shift();
  D.matches++; D.lastMatch = m.start;
}

/* scores for the current and previous hour from Drafted.gg */
async function liveScores() {
  const now = new Date(), from = new Date(now.getTime() - 2 * 3600e3);
  const df = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), from.getUTCHours())).toISOString();
  const dt = now.toISOString();
  for (const slug of SP.drafted) {
    // the page lists at most 10 matches: read the last 2 hours in 20-minute slices
    for (let t = new Date(df).getTime(); t < now.getTime(); t += 20 * 60e3) {
      const a = new Date(t).toISOString(), b = new Date(Math.min(t + 20 * 60e3 - 1000, now.getTime())).toISOString();
      try {
        const r = await fetch(PROXY + "/drafted/" + slug + "?df=" + a + "&dt=" + b, { cache: "no-store" });
        if (!r.ok) continue;
        const html = (await r.text()).replace(/\\"/g, '"');
        const re = /"children":"Match (\d+)"\}\],\["\$","\$L[0-9a-z]+",null,\{"date":"\$D([0-9T:.\-]+Z)"\}\],\["\$","div",null,\{"className":"[^"]*","children":"(\d+) - (\d+)"\}\]/g;
        let m;
        while ((m = re.exec(html))) {
          const when = m[2].slice(0, 16) + "Z", sa = +m[3], sb = +m[4];
          // players: the two names right before this match in the payload
          const before = html.slice(Math.max(0, m.index - 4000), m.index);
          const names = [...before.matchAll(/"uppercase text-3\.5xl[^"]*","children":"([^"]+)"/g)].map((x) => x[1]);
          const after = html.slice(m.index, m.index + 4000);
          const bName = (after.match(/"uppercase text-3\.5xl[^"]*","children":"([^"]+)"/) || [])[1];
          const aName = names[names.length - 1];
          if (!aName || !bName) continue;
          const rec = D.recent.find((x) => !x.score && ((x.a === aName && x.b === bName) || (x.a === bName && x.b === aName)) && Math.abs(new Date(x.start) - new Date(when)) < 7 * 60e3);
          if (rec) rec.score = rec.a === aName ? [sa, sb] : [sb, sa];
        }
      } catch (e) { /* skip slice */ }
    }
  }
}

async function liveTick(manual) {
  if (LIVE.busy) return;
  LIVE.busy = true; paintLive("updating…");
  try {
    if (!H2H) buildH2H();
    const since = Math.floor((new Date(D.lastMatch || Date.now() - 3600e3).getTime() - 10 * 60e3) / 1000);
    const [openM, closedM] = await Promise.all([kalshiMarkets("status=open"), kalshiMarkets("min_close_ts=" + since)]);
    const seen = new Set(D.recent.map((m) => m.id));
    parseKalshi(closedM).filter((m) => m.res && !seen.has(m.id)).sort((x, y) => x.start.localeCompare(y.start)).forEach(applyResult);
    D.upcoming = parseKalshi(openM).filter((m) => m.open && !m.res).sort((x, y) => x.start.localeCompare(y.start)).map((m) => {
      const pr = modelProbs(m.a, m.b);
      const ga = P[m.a] && P[m.a].goals && P[m.a].goals.all, gb = P[m.b] && P[m.b].goals && P[m.b].goals.all;
      return Object.assign(m, { ma: pr.pa, md: pr.pd, mb: pr.pb, h2h: pr.rec, ea: pr.ra, eb: pr.rb, xg: ga && gb ? [(ga.gf + gb.ga) / 2, (gb.gf + ga.ga) / 2] : null });
    });
    D.h2h = [...H2H.entries()].filter(([, v]) => v[0] + v[1] + v[2] >= 3).map(([k, v]) => [...k.split("|"), ...v]);
    D.players.sort((a, b) => b.elo - a.elo).forEach((p, i) => (p.rank = i + 1));
    if (manual || LIVE.ticks % 3 === 0) await liveScores();
    LIVE.on = true; LIVE.err = null; LIVE.last = Date.now(); LIVE.ticks++;
    if ($("#modal").hidden && !document.activeElement?.matches?.("input, select")) route();
  } catch (e) {
    LIVE.err = String(e.message || e);
  } finally { LIVE.busy = false; paintLive(); }
}
function paintLive(msg) {
  const el = $("#live-st"); if (!el) return;
  if (msg) { el.textContent = msg; return; }
  if (LIVE.err && !LIVE.on) { el.textContent = "snapshot only"; el.title = "Live data unavailable here: " + LIVE.err; return; }
  const s = LIVE.last ? Math.round((Date.now() - LIVE.last) / 1000) : null;
  el.innerHTML = `<span class="kal-live">●</span> Live · ${s == null ? "–" : s < 60 ? s + " s ago" : Math.round(s / 60) + " min ago"}`;
}
function startLive() {
  const meta = $("#meta");
  meta.insertAdjacentHTML("afterbegin", `<span id="live-st">connecting…</span><button class="theme-btn" id="refresh-btn" type="button">Refresh</button>`);
  $("#refresh-btn").addEventListener("click", () => liveTick(true));
  liveTick(true);
  LIVE.timer = setInterval(() => { if (!document.hidden) liveTick(false); }, 20000);
  setInterval(paintLive, 1000);
}

/* ---------------- Analyst track record (built by picks.py) ---------------- */
function trackPanel() {
  const T = D.picks;
  if (!T) return "";
  const pctv = (x) => (x == null ? "–" : Math.round(x * 100) + "%");
  const money = (x) => (x == null ? "–" : (x >= 0 ? "+" : "−") + "$" + Math.abs(x).toFixed(2));
  const cls = (x) => (x == null ? "" : x >= 0 ? "pos" : "neg");
  const a = T.all;
  const row = (name, r) => `<tr style="cursor:default"><td class="l">${name}</td><td>${r.picks}</td><td>${r.settled}</td><td><b>${pctv(r.hit)}</b></td><td>${pctv(r.avgProb)}</td><td>${r.avgPrice == null ? "–" : Math.round(r.avgPrice * 100) + "¢"}</td><td class="${cls(r.settled ? r.pnl : null)}"><b>${money(r.settled ? r.pnl : null)}</b></td><td class="${cls(r.roi)}">${r.roi == null ? "–" : (r.roi >= 0 ? "+" : "") + Math.round(r.roi * 100) + "%"}</td></tr>`;
  const st = (r) => (r.status === "open" ? `<span class="dim">pending</span>` : r.status === "void" ? `<span class="dim">void</span>` : r.won ? `<span class="pos"><b>✓ won</b></span>` : `<span class="neg"><b>✗ lost</b></span>`);
  return `<section class="panel"><div class="panel-h"><h2>Track record</h2><span class="sub">Every Analyst pick with a Kalshi price, saved before the game${T.since ? " · since " + new Date(T.since).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""}</span></div>
  <div class="panel-b" style="display:grid;gap:14px">
    <section class="kpis">
      <div class="kpi"><div class="lbl">Picks</div><div class="val">${a.picks}</div><div class="hint">${a.open} pending</div></div>
      <div class="kpi"><div class="lbl">Hit rate</div><div class="val">${pctv(a.hit)}</div><div class="hint">expected ${pctv(a.avgProb)} · price ${a.avgPrice == null ? "–" : Math.round(a.avgPrice * 100) + "¢"}</div></div>
      <div class="kpi"><div class="lbl">Profit</div><div class="val ${cls(a.settled ? a.pnl : null)}">${money(a.settled ? a.pnl : null)}</div><div class="hint">$1 per pick, after Kalshi fees</div></div>
      <div class="kpi"><div class="lbl">Return</div><div class="val ${cls(a.roi)}">${a.roi == null ? "–" : (a.roi >= 0 ? "+" : "") + Math.round(a.roi * 100) + "%"}</div><div class="hint">${a.settled} settled</div></div>
    </section>
    <div class="tbl-wrap"><table class="tbl" style="min-width:620px"><thead><tr><th class="l">Rating</th><th>Picks</th><th>Settled</th><th>Hit</th><th>Expected</th><th>Avg price</th><th>Profit</th><th>Return</th></tr></thead>
      <tbody>${["Strong", "Good", "Moderate"].map((k) => row(`<span class="rt ${k === "Strong" ? "rt-strong" : k === "Good" ? "rt-good" : "rt-mod"}">${k}</span>`, T.byRating[k])).join("")}${row("<b>All</b>", a)}</tbody></table></div>
    ${T.recent.length ? `<details><summary style="cursor:pointer;font-weight:600">Latest picks (${T.recent.length})</summary><div class="tbl-wrap" style="margin-top:8px"><table class="tbl" style="min-width:680px"><thead><tr><th class="l">Start</th><th class="l">Game</th><th class="l">Pick</th><th>Ours</th><th>Price</th><th class="l">Rating</th><th class="l">Result</th><th>Profit</th></tr></thead>
      <tbody>${T.recent.map((r) => `<tr style="cursor:default"><td class="l">${new Date(r.start).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td><td class="l">${esc(r.game || "")}</td><td class="l">${esc(r.label)}</td><td>${pctv(r.p)}</td><td>${Math.round(r.ask * 100)}¢</td><td class="l">${r.rating}</td><td class="l">${st(r)}</td><td class="${cls(r.pnl)}">${r.pnl == null ? "–" : money(r.pnl)}</td></tr>`).join("")}</tbody></table></div></details>` : ""}
    <p class="chart-note" style="margin:0">Picks are recorded at each data update with the price at that moment, so your own entry price can differ. Results fill in as games finish. A few days of picks are needed before the numbers mean much.</p>
  </div></section>`;
}

boot();
