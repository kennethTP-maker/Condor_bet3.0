/* NHL Radar — UI. Reads data/nhl.json (built by fetch_nhl.py). */
"use strict";

const DATA_URL = "data/nhl.json";
const FORM = {
  hot:  { label: "Hot",        icon: "🔥", cls: "f-hot",  v: "--hot" },
  up:   { label: "Improving",  icon: "▲",  cls: "f-up",   v: "--up" },
  flat: { label: "Steady",     icon: "●",  cls: "f-flat", v: "--flat" },
  down: { label: "Declining",  icon: "▼",  cls: "f-down", v: "--down" },
  cold: { label: "Cold",       icon: "❄",  cls: "f-cold", v: "--cold" },
};
const POS = { C: "C", L: "LW", R: "RW", D: "D", G: "G" };
const VIEWS = ["summary", "analyst", "players", "goalies", "teams", "games", "vsgoalie", "method"];

let D = null;               // dataset
let TEAM = {};              // abbr -> team
let charts = [];            // charts activos en la vista
let modalCharts = [];
const state = {
  q: "", team: "", pos: "all", form: "all", minGp: 5, sort: "power", dir: -1, page: 0, inactive: false,
  gq: "", gsort: "power", gdir: -1, gmin: 3,
};
try { Object.assign(state, JSON.parse(localStorage.getItem("nhl-radar-state") || "{}"), { page: 0 }); } catch (e) { /* sin almacenamiento */ }
function saveState() { try { localStorage.setItem("nhl-radar-state", JSON.stringify(state)); } catch (e) { /* ignorar */ } }

/* ------------------------------------------------------------------ utilidades */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const f1 = (x) => (x == null ? "–" : Number(x).toFixed(1));
const f2 = (x) => (x == null ? "–" : Number(x).toFixed(2));
const f3 = (x) => (x == null ? "–" : Number(x).toFixed(3).replace(/^0\./, "."));
const pct = (x) => (x == null ? "–" : Math.round(x * 100) + "%");
const sgn = (x, d = 2) => (x > 0 ? "+" : "") + Number(x).toFixed(d);
const mmss = (min) => { if (min == null) return "–"; const m = Math.floor(min), s = Math.round((min - m) * 60); return `${m}:${String(s).padStart(2, "0")}`; };
const dShort = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { day: "2-digit", month: "short" });
const dLong = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" });
const tLocal = (utc) => (utc ? new Date(utc).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "");
const initials = (n) => n.split(" ").map((w) => w[0]).slice(0, 2).join("");
const lastName = (n) => n.split(" ").slice(1).join(" ") || n;

function chip(form, extra = "") {
  const f = FORM[form] || FORM.flat;
  return `<span class="chip ${f.cls}" title="${extra || f.label}"><span class="ic" aria-hidden="true">${f.icon}</span>${f.label}</span>`;
}
function teamBadge(ab, withName = false) {
  const t = TEAM[ab];
  const logo = t && t.logo ? `<img src="${esc(t.logo)}" alt="" loading="lazy" onerror="this.remove()">` : "";
  return `<span class="tm">${logo}<span class="ab">${esc(ab)}</span>${withName && t ? `<span class="muted" style="font-weight:500">${esc(t.name)}</span>` : ""}</span>`;
}
function avatar(p, size = "") {
  const img = p.headshot ? `<img src="${esc(p.headshot)}" alt="" loading="lazy" onerror="this.remove()">` : "";
  return `<span class="av ${size}" aria-hidden="true">${esc(initials(p.name))}${img}</span>`;
}
function powerMeter(v) {
  if (v == null) return `<span class="dim">–</span>`;
  return `<span class="meter"><span class="bar"><i style="width:${v}%"></i></span><b class="num">${Math.round(v)}</b></span>`;
}
function divBar(v) {
  const w = Math.min(50, Math.abs(v) / 2);
  const col = v >= 0 ? "var(--up)" : "var(--down)";
  const left = v >= 0 ? 50 : 50 - w;
  return `<span class="div-bar" title="Trend ${v}"><i style="left:${left}%;width:${w}%;background:${col}"></i></span> <span class="num ${v >= 0 ? "pos" : "neg"}" style="display:inline-block;width:34px;text-align:right">${v > 0 ? "+" : ""}${v}</span>`;
}
function spark(log) {
  const last = log.slice(-10);
  return `<span class="spark" title="Points, last ${last.length} games (gold = goal, blue = assist only)">` +
    last.map((r) => {
      const p = r[5];
      if (!p) return `<i class="z" style="height:2px"></i>`;
      return `<i class="${r[3] > 0 ? "g" : "a"}" style="height:${Math.min(20, 6 + p * 5)}px"></i>`;
    }).join("") + `</span>`;
}

/* ------------------------------------------------------------------ gráficos */
function baseOpts(extra = {}) {
  const grid = css("--chart-grid"), tick = css("--fg-3");
  return Object.assign({
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { labels: { color: css("--fg-2"), boxWidth: 10, boxHeight: 10, usePointStyle: true, font: { size: 11 } } },
      tooltip: { backgroundColor: css("--panel-2"), titleColor: css("--fg"), bodyColor: css("--fg-2"), borderColor: css("--line"), borderWidth: 1, padding: 10 },
    },
    scales: {
      x: { grid: { color: grid, drawTicks: false }, ticks: { color: tick, font: { size: 10.5 }, maxRotation: 0, autoSkipPadding: 10 }, border: { color: grid } },
      y: { grid: { color: grid, drawTicks: false }, ticks: { color: tick, font: { size: 10.5 }, padding: 6 }, border: { display: false } },
    },
  }, extra);
}
function mkChart(canvas, cfg, bucket = charts) { const c = new Chart(canvas, cfg); bucket.push(c); return c; }

/** Velas: candles = [[semana, open, high, low, close], ...] */
function candleChart(canvas, candles, { yLabel = "", bucket = charts, fmt = (v) => f2(v) } = {}) {
  const up = css("--candle-up"), dn = css("--candle-down");
  const labels = candles.map((c) => dShort(c[0]));
  const isUp = candles.map((c) => c[4] >= c[1]);
  const span = Math.max(0.01, ...candles.map((c) => c[2] - c[3]));
  const body = candles.map((c) => (Math.abs(c[4] - c[1]) < span * 0.02 ? [c[1] - span * 0.01, c[1] + span * 0.01] : [c[1], c[4]]));
  return mkChart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Range (high/low)", data: candles.map((c) => [c[3], c[2]]), backgroundColor: isUp.map((u) => (u ? up : dn)), barThickness: 2, grouped: false, order: 2 },
        { label: "Open→Close", data: body, backgroundColor: isUp.map((u) => (u ? up : dn)), borderRadius: 3, barPercentage: 0.55, categoryPercentage: 0.9, grouped: false, order: 1 },
      ],
    },
    options: baseOpts({
      interaction: { mode: "index", intersect: false },
      plugins: {
        ...baseOpts().plugins,
        legend: { display: false },
        tooltip: {
          ...baseOpts().plugins.tooltip,
          filter: (it) => it.datasetIndex === 1,
          callbacks: {
            title: (it) => "Week of " + dLong(candles[it[0].dataIndex][0]),
            label: (it) => {
              const c = candles[it.dataIndex];
              return [`Open ${fmt(c[1])}  ·  Close ${fmt(c[4])}`, `High ${fmt(c[2])}  ·  Low ${fmt(c[3])}`, `Change ${sgn(c[4] - c[1])}`];
            },
          },
        },
      },
      scales: { ...baseOpts().scales, y: { ...baseOpts().scales.y, beginAtZero: false, grace: "8%", title: { display: !!yLabel, text: yLabel, color: css("--fg-3"), font: { size: 11 } } } },
    }),
  });
}

function destroy(bucket) { bucket.forEach((c) => c.destroy()); bucket.length = 0; }

/* ------------------------------------------------------------------ carga */
async function boot() {
  let res;
  try {
    res = await fetch(DATA_URL, { cache: "no-cache" });
    if (!res.ok) throw new Error(res.status);
    D = await res.json();
  } catch (e) {
    $("#app").innerHTML = `<div class="panel"><div class="empty">Could not load <code>${DATA_URL}</code>. Run <code>python nhl_dashboard/fetch_nhl.py</code> to build the data.</div></div>`;
    return;
  }
  D.teams.forEach((t) => (TEAM[t.abbr] = t));
  D.skaters.forEach((s) => (s.kind = "S"));
  D.goalies.forEach((g) => (g.kind = "G"));
  loadH2H();
  const gen = new Date(D.generatedAt);
  const next = new Date(gen.getTime() + 24 * 3600 * 1000);
  $("#season-lbl").textContent = `Regular season ${D.seasonLabel}`;
  $("#meta").innerHTML = `
    <span><span class="live-dot" aria-hidden="true"></span>Updated <b>${gen.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</b></span>
    <span>Last game <b>${D.lastGameDate ? dShort(D.lastGameDate) : "–"}</b></span>
    <span>Next update <b>${next.toLocaleString("en-US", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</b></span>
    <span><a class="nhl-link" href="esoccer/">eSoccer Radar ↗</a></span>
    <span><a class="nhl-link" href="ebasketball/">eBasketball Radar ↗</a></span>
    <button class="theme-btn" id="theme-btn" type="button">Theme</button>`;
  $("#theme-btn").addEventListener("click", toggleTheme);
  window.addEventListener("hashchange", route);
  route();
  startLive();
}

function toggleTheme() {
  const root = document.documentElement;
  const cur = root.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  root.dataset.theme = cur === "dark" ? "light" : "dark";
  try { localStorage.setItem("nhl-radar-theme", root.dataset.theme); } catch (e) { /* */ }
  route();
  if (!$("#modal").hidden && openModal.last) openModal.last();
}
try { const t = localStorage.getItem("nhl-radar-theme"); if (t) document.documentElement.dataset.theme = t; } catch (e) { /* */ }

function route() {
  let v = (location.hash || "#summary").slice(1);
  if (!VIEWS.includes(v)) v = "summary";
  document.querySelectorAll(".tab").forEach((a) => a.setAttribute("aria-current", a.getAttribute("href") === "#" + v ? "page" : "false"));
  destroy(charts);
  const app = $("#app");
  ({ summary: viewSummary, analyst: viewAnalyst, players: viewPlayers, goalies: viewGoalies, teams: viewTeams, games: viewGames, vsgoalie: viewVs, method: viewMethod })[v](app);
  const view = app.querySelector(".view");
  if (view && TAB_INTRO[v]) view.insertAdjacentHTML("afterbegin", `<p class="tab-intro">${TAB_INTRO[v]}</p>`);
}
/* one line per tab: what you'll find here */
const TAB_INTRO = {
  summary: "League overview: the form meter, strongest players, hot and cold players, today's games and top goalies.",
  analyst: "The 1–2 best picks per team for each game (goal, point or assist), with a rating and the reasons.",
  players: "Every active skater in one table, with filters, sorting, trends and probabilities.",
  goalies: "Every goalie with save stats, GSAA, form and a quality vs workload chart.",
  teams: "Standings by division, last 10 results, streaks, next game and goal differential.",
  games: "This week's games with the top candidates against the opposing goalie, probable goalies and Kalshi prices.",
  vsgoalie: "Each player's record against each goalie over 3 seasons, the best duels of the week and a free explorer.",
  method: "Where the data comes from, how each number is calculated, and a backtest showing how accurate the model is.",
};

const activeSk = () => D.skaters.filter((s) => s.active);
const activeGo = () => D.goalies.filter((g) => g.active);

/* ------------------------------------------------------------------ RESUMEN */
function viewSummary(app) {
  const sk = activeSk();
  const regulars = sk.filter((s) => s.gp >= 8);
  const counts = { hot: 0, up: 0, flat: 0, down: 0, cold: 0 };
  regulars.forEach((s) => counts[s.form]++);
  const nReg = regulars.length || 1;
  const top = sk.filter((s) => s.power != null && s.gp >= 8).slice(0, 12);
  const relevant = regulars.filter((s) => (s.power ?? 0) >= 45);
  const pick = (f, sorter) => relevant.filter((s) => s.form === f).sort(sorter).slice(0, 8);
  const lists = [
    ["hot", "Hot", "Playing well above their own level (last 5–10 games) or a 4+ game point streak.", pick("hot", (a, b) => b.trend - a.trend)],
    ["up", "Improving", "Recent average rising versus their season.", pick("up", (a, b) => b.trend - a.trend)],
    ["down", "Declining", "Recent average falling versus their season.", pick("down", (a, b) => a.trend - b.trend)],
    ["cold", "Cold", "Sharp drop, or a productive player with 5+ games without a point.", pick("cold", (a, b) => a.trend - b.trend)],
  ];
  const nextDate = slateDates()[0] || D.schedule[0]?.date;
  const today = D.schedule.filter((g) => g.date === nextDate);
  const goalieTop = activeGo().filter((g) => g.gp >= 5).slice(0, 5);

  app.innerHTML = `<div class="view">
    <section class="kpis" aria-label="League summary">
      <div class="kpi"><div class="lbl">Active players</div><div class="val">${sk.length + activeGo().length}</div><div class="hint">${sk.length} skaters · ${activeGo().length} goalies</div></div>
      <div class="kpi"><div class="lbl">Games analyzed</div><div class="val">${D.gamesCounted}</div><div class="hint">Season ${D.seasonLabel}</div></div>
      <div class="kpi"><div class="lbl">Goals per team-game</div><div class="val">${f2(D.league.goalsPerTeamGame)}</div><div class="hint">League average</div></div>
      <div class="kpi"><div class="lbl">League save %</div><div class="val">${f3(D.league.svPct)}</div><div class="hint">Shooting ${pct(D.league.shPct)}</div></div>
      <div class="kpi"><div class="lbl">Next games</div><div class="val">${today.length}</div><div class="hint">${today[0] ? dLong(today[0].date) : "No games"}</div></div>
    </section>

    <section class="panel">
      <div class="panel-h"><h2>Form meter</h2><span class="sub">${nReg} players with 8+ games</span></div>
      <div class="panel-b">
        <div style="display:flex;height:16px;border-radius:8px;overflow:hidden;gap:2px" role="img" aria-label="Form distribution">
          ${["hot", "up", "flat", "down", "cold"].map((f) => `<div title="${FORM[f].label}: ${counts[f]}" style="flex:${counts[f]};background:var(${FORM[f].v})"></div>`).join("")}
        </div>
        <div class="legend" style="margin-top:10px">${["hot", "up", "flat", "down", "cold"].map((f) => `${chip(f)} <span class="num" style="margin-right:8px">${counts[f]} · ${Math.round((100 * counts[f]) / nReg)}%</span>`).join("")}</div>
      </div>
    </section>

    <div class="grid g-main">
      <section class="panel">
        <div class="panel-h"><h2>Strongest candidates</h2><span class="sub">Strength index 0–100 · season + last 10 + ice time</span><a class="right" href="#players" style="font-size:12px">See all →</a></div>
        <div class="panel-b"><div class="cands">${top.map((s, i) => candCard(s, i + 1)).join("")}</div></div>
      </section>
      <section class="panel">
        <div class="panel-h"><h2>Form map</h2><span class="sub">Season vs last 5 (IMP per game)</span></div>
        <div class="panel-b"><div class="chart-box tall"><canvas id="scatter" aria-label="Form scatter"></canvas></div>
        <p class="chart-note">Above the diagonal = playing above their average. Tap a dot to open the player.</p></div>
      </section>
    </div>

    <div class="grid g4">
      ${lists.map(([f, title, desc, arr]) => `
      <section class="panel top-${f}">
        <div class="panel-h trend-head"><h3>${chip(f)}</h3><span class="count">${arr.length ? "Top " + arr.length : ""}</span></div>
        <div class="panel-b"><p class="dim" style="margin:0 0 8px;font-size:12px">${desc}</p>
          <div class="tlist">${arr.length ? arr.map((s) => trendRow(s)).join("") : `<div class="empty">Nobody in this group right now.</div>`}</div>
        </div>
      </section>`).join("")}
    </div>

    <div class="grid g2">
      <section class="panel">
        <div class="panel-h"><h2>Next games</h2><span class="sub">Best goal candidate per team</span><a class="right" href="#games" style="font-size:12px">Full week →</a></div>
        <div class="panel-b">${today.length ? `<div class="tlist">${today.map(todayRow).join("")}</div>` : `<div class="empty">No games scheduled today.</div>`}</div>
      </section>
      <section class="panel">
        <div class="panel-h"><h2>Strongest goalies</h2><span class="sub">Goals saved above average (GSAA)</span><a class="right" href="#goalies" style="font-size:12px">See all →</a></div>
        <div class="panel-b"><div class="tlist">${goalieTop.map((g) => `
          <button class="trow" data-g="${g.id}" type="button">${avatar(g, "sm")}
            <span><div class="nm">${esc(g.name)}</div><div class="sub">${esc(g.team)} · SV% ${f3(g.svPct)} · ${g.w}-${g.l}-${g.otl}</div></span>
            ${chip(g.form)}<span class="delta ${g.gsaa >= 0 ? "pos" : "neg"}">${sgn(g.gsaa, 1)}</span></button>`).join("")}</div></div>
      </section>
    </div>
  </div>`;

  bindOpeners(app);
  // dispersión
  const pts = regulars.filter((s) => s.power != null);
  const ds = ["hot", "up", "flat", "down", "cold"].map((f) => ({
    label: FORM[f].label, data: pts.filter((s) => s.form === f).map((s) => ({ x: s.imp, y: s.imp5, s })),
    backgroundColor: css(FORM[f].v), borderColor: css("--panel"), borderWidth: 1, pointRadius: 4, pointHoverRadius: 7,
  }));
  const max = Math.max(...pts.map((s) => Math.max(s.imp, s.imp5)), 1);
  ds.push({ type: "line", label: "Equal to their average", data: [{ x: 0, y: 0 }, { x: max, y: max }], borderColor: css("--fg-3"), borderDash: [4, 4], borderWidth: 1, pointRadius: 0 });
  mkChart($("#scatter"), {
    type: "scatter", data: { datasets: ds },
    options: baseOpts({
      interaction: { mode: "nearest", intersect: true },
      onClick: (e, els) => { const el = els[0]; if (el) { const p = ds[el.datasetIndex].data[el.index].s; if (p) openPlayer(p.id); } },
      plugins: { ...baseOpts().plugins, legend: { ...baseOpts().plugins.legend, position: "bottom" },
        tooltip: { ...baseOpts().plugins.tooltip, callbacks: { label: (it) => { const s = it.raw.s; return s ? `${s.name} (${s.team}) · season ${f2(s.imp)} → L5 ${f2(s.imp5)}` : ""; } } } },
      scales: { x: { ...baseOpts().scales.x, min: 0, title: { display: true, text: "IMP per game, season", color: css("--fg-3") } },
        y: { ...baseOpts().scales.y, min: 0, title: { display: true, text: "IMP per game, last 5", color: css("--fg-3") } } },
    }),
  });
}

function candCard(s, rank) {
  return `<button class="cand" data-p="${s.id}" type="button">
    ${avatar(s)}
    <span style="min-width:0"><div class="nm"><span class="rank">${rank}</span>${esc(s.name)}</div>
      <div class="sub">${teamBadge(s.team)} ${POS[s.pos] || s.pos} · ${s.p} P in ${s.gp}</div>
      <div class="sub" style="margin-top:3px">${chip(s.form)}${missedGames(s) ? ` <span class="miss-dot" title="His team played ${missedGames(s)} game(s) without him">⚠ ${missedGames(s)} GP out</span>` : ""}</div></span>
    <span class="score"><b class="num">${Math.round(s.power)}</b><small>Strength</small></span></button>`;
}
function trendRow(s) {
  const d = s.imp5 - s.imp;
  return `<button class="trow" data-p="${s.id}" type="button">${avatar(s, "sm")}
    <span><div class="nm">${esc(s.name)}</div><div class="sub">${esc(s.team)} · L5: ${s.l5.g}G ${s.l5.a}A · ${s.pStreak >= 2 ? s.pStreak + "-game point streak" : s.dryStreak >= 2 ? s.dryStreak + " without a point" : "season " + s.p + " P"}</div></span>
    ${spark(s.log)}<span class="delta ${d >= 0 ? "pos" : "neg"}" title="IMP change, L5 vs season">${sgn(d)}</span></button>`;
}
function todayRow(g) {
  const best = (ab, opp) => bestFor(ab, opp, "pGoal", 1, g)[0];
  const a = best(g.away, g.home), h = best(g.home, g.away);
  const pk = (x) => (x ? `<button class="pick" data-p="${x.s.id}" type="button"><span>${esc(lastName(x.s.name))}</span><b class="num">${pct(x.pGoal)}</b></button>` : "");
  return `<div class="trow" style="grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);cursor:default">
    <span>${teamBadge(g.away)}${pk(a)}</span><span class="dim" style="text-align:center;font-size:12px">${g.state === "FUT" || g.state === "PRE" ? tLocal(g.start) : (g.awayScore ?? "") + "–" + (g.homeScore ?? "")}<br>@</span>
    <span style="text-align:right">${teamBadge(g.home)}${pk(h)}</span></div>`;
}

/* proyección ajustada al rival concreto */
function projFor(s, opp) {
  const lg = D.league.goalsPerTeamGame;
  let f = 1;
  if (opp && TEAM[opp]) f = Math.max(0.8, Math.min(1.2, Math.pow((TEAM[opp].gapg || lg) / lg, 0.6)));
  const r = f / (s.proj.oppF || 1);
  const scaleP = (p) => 1 - Math.pow(1 - Math.min(p, 0.99), r);
  return { pGoal: scaleP(s.proj.pGoal), pPoint: scaleP(s.proj.pPoint), pAssist: scaleP(s.proj.pAssist ?? 0), g: s.proj.g * r, p: s.proj.p * r, sog: s.proj.sog, oppF: f };
}
function bestFor(team, opp, key, n, game) {
  const gk = H && !H.error ? probableGoalie(opp, game) : null;
  return activeSk().filter((s) => s.team === team && s.gp >= 5 && s.log.length && daysSince(s.log[s.log.length - 1][0]) <= 12 && missedGames(s) < 2)
    .map((s) => (gk ? matchup(s, gk.id) : { s, ...projFor(s, opp) })).sort((a, b) => b[key] - a[key]).slice(0, n);
}
/* enlaces a NHL.com */
function gameUrl(team, opp, home, iso, gid) {
  if (!gid) return null;
  const sched = D.schedule.find((g) => g.id === gid);
  if (sched && sched.link) return sched.link;
  const [aw, hm] = home ? [opp, team] : [team, opp];
  return `https://www.nhl.com/gamecenter/${aw.toLowerCase()}-vs-${hm.toLowerCase()}/${iso.replace(/-/g, "/")}/${gid}`;
}
function nextUrl(team) {
  const t = TEAM[team];
  if (!t || !t.next) return null;
  return gameUrl(team, t.next.opp, t.next.home, t.next.date, t.next.id);
}
function nhlLink(url, label = "View on NHL.com") {
  return url ? `<a class="nhl-link" href="${esc(url)}" target="_blank" rel="noopener">${label} <span aria-hidden="true">↗</span></a>` : "";
}
/* partidos que su equipo jugó después de su último partido (posible lesión/baja) */
function missedGames(p) {
  const t = TEAM[p.team];
  if (!t || !p.log.length) return 0;
  const last = p.log[p.log.length - 1][0];
  return t.games.filter((g) => g[0] > last).length;
}
function missedBadge(p) {
  const n = missedGames(p);
  if (!n) return "";
  const last = p.log[p.log.length - 1][0];
  return `<span class="chip f-miss" title="His team has played ${n} game${n > 1 ? "s" : ""} without him since ${dShort(last)}. Check injuries or the lineup before betting."><span class="ic" aria-hidden="true">⚠</span>Out since ${dShort(last)} (${n} GP)</span>`;
}
function daysSince(iso) { return (new Date(D.generatedAt) - new Date(iso + "T12:00:00Z")) / 864e5; }

/* ------------------------------------------------------------------ JUGADORES */
const COLS = [
  ["name", "Player", "l"], ["team", "Team", "l"], ["pos", "Pos", "l"], ["gp", "GP"], ["g", "G"], ["a", "A"], ["p", "P"],
  ["ptsPg", "P/GP"], ["sog", "Shots"], ["shPct", "Sh%"], ["toi", "TOI"], ["pm", "+/-"], ["ppp", "PPP"], ["hit", "Hits"], ["blk", "Blk"],
  ["l5p", "P L5"], ["spark", "Last 10", "l"], ["trend", "Trend", "l"], ["form", "Form", "l"], ["power", "Strength", "l"], ["pGoal", "P(goal)"], ["pPoint", "P(point)"],
];
const FORM_ORDER = { hot: 4, up: 3, flat: 2, down: 1, cold: 0 };
function sortVal(s, k) {
  if (k === "l5p") return s.l5.p;
  if (k === "pGoal" || k === "pPoint") return s.proj[k];
  if (k === "form") return FORM_ORDER[s.form];
  if (k === "spark") return s.l10.p;
  return s[k];
}
function viewPlayers(app) {
  const teams = D.teams.map((t) => t.abbr).sort();
  app.innerHTML = `<div class="view"><section class="panel">
    <div class="panel-h"><h2>Skaters</h2><span class="sub" id="pl-count"></span></div>
    <div class="panel-b" style="display:grid;gap:14px">
      <div class="filters">
        <label class="fld">Search<input type="search" id="f-q" placeholder="Name…" value="${esc(state.q)}"></label>
        <label class="fld">Team<select id="f-team"><option value="">All</option>${teams.map((t) => `<option ${t === state.team ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        <div class="fld">Position<div class="seg" id="f-pos">${[["all", "All"], ["F", "Forwards"], ["C", "C"], ["L", "LW"], ["R", "RW"], ["D", "Defense"]].map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${state.pos === v}">${l}</button>`).join("")}</div></div>
        <label class="fld">Form<select id="f-form"><option value="all">All</option>${Object.entries(FORM).map(([k, f]) => `<option value="${k}" ${state.form === k ? "selected" : ""}>${f.icon} ${f.label}</option>`).join("")}</select></label>
        <label class="fld">Min. GP <input type="number" id="f-gp" min="0" max="82" value="${state.minGp}" style="width:72px"></label>
        <label class="fld" style="flex-direction:row;display:flex;gap:6px;align-items:center;text-transform:none;letter-spacing:0;font-size:12.5px;color:var(--fg-2)"><input type="checkbox" id="f-inact" ${state.inactive ? "checked" : ""}> Include inactive</label>
      </div>
      <div class="legend">${Object.keys(FORM).map((f) => chip(f)).join("")} <span class="dim">· Last 10: gold bar = scored, blue = assist only, gray = no point</span></div>
      <div class="tbl-wrap"><table class="tbl" id="pl-tbl"><thead><tr>${COLS.map(([k, l, a]) => `<th class="${a || ""}" data-k="${k}" ${state.sort === k ? `aria-sort="${state.dir < 0 ? "descending" : "ascending"}"` : ""}>${l}</th>`).join("")}</tr></thead><tbody></tbody></table></div>
      <div class="pager"><span id="pg-lbl"></span><button type="button" id="pg-prev">Previous</button><button type="button" id="pg-next">Next</button></div>
    </div></section></div>`;

  const upd = () => { state.page = 0; saveState(); drawPlayers(); };
  $("#f-q").addEventListener("input", (e) => { state.q = e.target.value; upd(); });
  $("#f-team").addEventListener("change", (e) => { state.team = e.target.value; upd(); });
  $("#f-form").addEventListener("change", (e) => { state.form = e.target.value; upd(); });
  $("#f-gp").addEventListener("input", (e) => { state.minGp = +e.target.value || 0; upd(); });
  $("#f-inact").addEventListener("change", (e) => { state.inactive = e.target.checked; upd(); });
  $("#f-pos").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; state.pos = b.dataset.v; $("#f-pos").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b)); upd(); });
  $("#pl-tbl thead").addEventListener("click", (e) => {
    const th = e.target.closest("th"); if (!th) return;
    const k = th.dataset.k;
    if (state.sort === k) state.dir *= -1; else { state.sort = k; state.dir = ["name", "team", "pos"].includes(k) ? 1 : -1; }
    $("#pl-tbl thead").querySelectorAll("th").forEach((x) => x.removeAttribute("aria-sort"));
    th.setAttribute("aria-sort", state.dir < 0 ? "descending" : "ascending");
    upd();
  });
  $("#pg-prev").addEventListener("click", () => { state.page--; drawPlayers(); });
  $("#pg-next").addEventListener("click", () => { state.page++; drawPlayers(); });
  $("#pl-tbl tbody").addEventListener("click", (e) => { if (e.target.closest("a")) return; const tr = e.target.closest("tr[data-p]"); if (tr) openPlayer(+tr.dataset.p); });
  drawPlayers();
}
function drawPlayers() {
  const q = state.q.trim().toLowerCase();
  let rows = D.skaters.filter((s) => (state.inactive || s.active) && s.gp >= state.minGp &&
    (!q || s.name.toLowerCase().includes(q)) && (!state.team || s.team === state.team) &&
    (state.form === "all" || s.form === state.form) &&
    (state.pos === "all" || (state.pos === "F" ? s.pos !== "D" : s.pos === state.pos)));
  const k = state.sort, dir = state.dir;
  rows.sort((a, b) => { const x = sortVal(a, k), y = sortVal(b, k); if (x == null) return 1; if (y == null) return -1; return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir; });
  const per = 50, pages = Math.max(1, Math.ceil(rows.length / per));
  state.page = Math.max(0, Math.min(state.page, pages - 1));
  const slice = rows.slice(state.page * per, state.page * per + per);
  $("#pl-count").textContent = `${rows.length} players`;
  $("#pg-lbl").textContent = `Page ${state.page + 1} of ${pages}`;
  $("#pg-prev").disabled = state.page === 0;
  $("#pg-next").disabled = state.page >= pages - 1;
  $("#pl-tbl tbody").innerHTML = slice.length ? slice.map((s) => `<tr data-p="${s.id}">
    <td class="l"><span class="pl">${avatar(s, "sm")}<b>${esc(s.name)}</b>${kLink(s.team)}${s.active ? "" : ' <span class="dim">(inactive)</span>'}${missedGames(s) ? ` <span class="miss-dot" title="His team played ${missedGames(s)} game(s) without him">⚠ ${missedGames(s)}</span>` : ""}</span></td>
    <td class="l">${teamBadge(s.team)}</td><td class="l">${POS[s.pos] || s.pos}</td>
    <td>${s.gp}</td><td>${s.g}</td><td>${s.a}</td><td><b>${s.p}</b></td><td>${f2(s.ptsPg)}</td><td>${s.sog}</td><td>${pct(s.shPct)}</td>
    <td>${mmss(s.toi)}</td><td class="${s.pm > 0 ? "pos" : s.pm < 0 ? "neg" : ""}">${s.pm > 0 ? "+" : ""}${s.pm}</td><td>${s.ppp}</td><td>${s.hit}</td><td>${s.blk}</td>
    <td>${s.l5.p}</td><td class="l">${spark(s.log)}</td><td class="l">${divBar(s.trend)}</td><td class="l">${chip(s.form)}</td><td class="l">${powerMeter(s.power)}</td>
    <td class="pct">${pct(s.proj.pGoal)}</td><td class="pct">${pct(s.proj.pPoint)}</td></tr>`).join("")
    : `<tr><td colspan="${COLS.length}" class="l"><div class="empty">No players match these filters.</div></td></tr>`;
}

/* ------------------------------------------------------------------ PORTEROS */
const GCOLS = [["name", "Goalie", "l"], ["team", "Team", "l"], ["gp", "GP"], ["gs", "GS"], ["w", "W"], ["l", "L"], ["otl", "OTL"], ["svPct", "SV%"], ["gaa", "GAA"],
  ["so", "SO"], ["sa", "Shots ag."], ["gsaa", "GSAA"], ["svPct5", "SV% L5"], ["gsaa5", "GSAA L5"], ["trend", "Trend", "l"], ["form", "Form", "l"], ["power", "Strength", "l"]];
function viewGoalies(app) {
  app.innerHTML = `<div class="view"><section class="panel">
    <div class="panel-h"><h2>Goalies</h2><span class="sub">GSAA = goals saved above an average goalie facing the same shots (league ${f3(D.league.svPct)})</span></div>
    <div class="panel-b" style="display:grid;gap:14px">
      <div class="filters"><label class="fld">Search<input type="search" id="g-q" value="${esc(state.gq)}" placeholder="Name…"></label>
      <label class="fld">Min. GP <input type="number" id="g-min" value="${state.gmin}" min="0" style="width:72px"></label></div>
      <div class="tbl-wrap"><table class="tbl" id="g-tbl" style="min-width:1050px"><thead><tr>${GCOLS.map(([k, l, a]) => `<th class="${a || ""}" data-k="${k}" ${state.gsort === k ? `aria-sort="${state.gdir < 0 ? "descending" : "ascending"}"` : ""}>${l}</th>`).join("")}</tr></thead><tbody></tbody></table></div>
    </div></section>
    <section class="panel"><div class="panel-h"><h2>Quality vs workload</h2><span class="sub">Season SV% against shots faced</span></div>
      <div class="panel-b"><div class="chart-box"><canvas id="g-scatter"></canvas></div></div></section></div>`;
  const draw = () => {
    const q = state.gq.toLowerCase();
    const rows = activeGo().filter((g) => g.gp >= state.gmin && (!q || g.name.toLowerCase().includes(q)));
    const k = state.gsort, dir = state.gdir;
    rows.sort((a, b) => { let x = k === "form" ? FORM_ORDER[a.form] : a[k], y = k === "form" ? FORM_ORDER[b.form] : b[k]; if (x == null) return 1; if (y == null) return -1; return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir; });
    $("#g-tbl tbody").innerHTML = rows.map((g) => `<tr data-g="${g.id}">
      <td class="l"><span class="pl">${avatar(g, "sm")}<b>${esc(g.name)}</b>${kLink(g.team)}</span></td><td class="l">${teamBadge(g.team)}</td>
      <td>${g.gp}</td><td>${g.gs}</td><td>${g.w}</td><td>${g.l}</td><td>${g.otl}</td><td><b>${f3(g.svPct)}</b></td><td>${f2(g.gaa)}</td><td>${g.so}</td><td>${g.sa}</td>
      <td class="${g.gsaa >= 0 ? "pos" : "neg"}">${sgn(g.gsaa, 1)}</td><td>${f3(g.svPct5)}</td><td class="${g.gsaa5 >= 0 ? "pos" : "neg"}">${sgn(g.gsaa5, 1)}</td>
      <td class="l">${divBar(g.trend)}</td><td class="l">${chip(g.form)}</td><td class="l">${powerMeter(g.power)}</td></tr>`).join("") || `<tr><td colspan="17"><div class="empty">No results.</div></td></tr>`;
  };
  $("#g-q").addEventListener("input", (e) => { state.gq = e.target.value; saveState(); draw(); });
  $("#g-min").addEventListener("input", (e) => { state.gmin = +e.target.value || 0; saveState(); draw(); });
  $("#g-tbl thead").addEventListener("click", (e) => {
    const th = e.target.closest("th"); if (!th) return;
    const k = th.dataset.k;
    if (state.gsort === k) state.gdir *= -1; else { state.gsort = k; state.gdir = ["name", "team", "gaa", "l", "otl"].includes(k) ? 1 : -1; }
    $("#g-tbl thead").querySelectorAll("th").forEach((x) => x.removeAttribute("aria-sort"));
    th.setAttribute("aria-sort", state.gdir < 0 ? "descending" : "ascending"); saveState(); draw();
  });
  $("#g-tbl tbody").addEventListener("click", (e) => { if (e.target.closest("a")) return; const tr = e.target.closest("tr[data-g]"); if (tr) openGoalie(+tr.dataset.g); });
  draw();
  const gs = activeGo().filter((g) => g.gp >= 5);
  const ds = ["hot", "up", "flat", "down", "cold"].map((f) => ({ label: FORM[f].label, data: gs.filter((g) => g.form === f).map((g) => ({ x: g.sa, y: g.svPct, g })),
    backgroundColor: css(FORM[f].v), borderColor: css("--panel"), borderWidth: 1, pointRadius: 5, pointHoverRadius: 8 }));
  ds.push({ type: "line", label: "League average", data: [{ x: 0, y: D.league.svPct }, { x: Math.max(...gs.map((g) => g.sa)), y: D.league.svPct }], borderColor: css("--fg-3"), borderDash: [4, 4], borderWidth: 1, pointRadius: 0 });
  mkChart($("#g-scatter"), { type: "scatter", data: { datasets: ds }, options: baseOpts({
    interaction: { mode: "nearest", intersect: true },
    onClick: (e, els) => { const el = els[0]; if (el) { const g = ds[el.datasetIndex].data[el.index].g; if (g) openGoalie(g.id); } },
    plugins: { ...baseOpts().plugins, legend: { ...baseOpts().plugins.legend, position: "bottom" }, tooltip: { ...baseOpts().plugins.tooltip, callbacks: { label: (it) => it.raw.g ? `${it.raw.g.name} (${it.raw.g.team}) · ${f3(it.raw.g.svPct)} on ${it.raw.g.sa} shots` : "" } } },
    scales: { x: { ...baseOpts().scales.x, title: { display: true, text: "Shots faced", color: css("--fg-3") } }, y: { ...baseOpts().scales.y, title: { display: true, text: "SV%", color: css("--fg-3") }, ticks: { ...baseOpts().scales.y.ticks, callback: (v) => f3(v) } } },
  }) });
}

/* ------------------------------------------------------------------ EQUIPOS */
function viewTeams(app) {
  const divs = {};
  D.teams.forEach((t) => (divs[t.div] = divs[t.div] || []).push(t));
  Object.values(divs).forEach((a) => a.sort((x, y) => x.divRank - y.divRank));
  const order = ["Atlantic", "Metropolitan", "Central", "Pacific"].filter((d) => divs[d]).concat(Object.keys(divs).filter((d) => !["Atlantic", "Metropolitan", "Central", "Pacific"].includes(d)));
  app.innerHTML = `<div class="view">
    <section class="panel"><div class="panel-h"><h2>Goal differential by team</h2><span class="sub">Season · sorted by league standing</span></div>
      <div class="panel-b"><div class="chart-box"><canvas id="t-diff"></canvas></div></div></section>
    <div class="div-grid">${order.map((d) => `<section class="panel"><div class="panel-h"><h2>${esc(d)} Division</h2><span class="sub">${esc(divs[d][0].conf)}</span></div>
      <div class="panel-b"><div class="tbl-wrap"><table class="tbl" style="min-width:640px"><thead><tr>
        <th class="l">#</th><th class="l">Team</th><th>GP</th><th>W-L-OTL</th><th>PTS</th><th>P%</th><th>GF</th><th>GA</th><th>DIFF</th><th class="l">Last 10</th><th>Streak</th><th class="l">Next</th></tr></thead>
        <tbody>${divs[d].map((t) => `<tr data-t="${t.abbr}">
          <td class="l">${t.divRank}</td><td class="l">${teamBadge(t.abbr)}</td><td>${t.gp}</td><td>${t.w}-${t.l}-${t.otl}</td><td><b>${t.pts}</b></td><td>${f3(t.ptsPct)}</td>
          <td>${t.gf}</td><td>${t.ga}</td><td class="${t.gf - t.ga >= 0 ? "pos" : "neg"}">${sgn(t.gf - t.ga, 0)}</td>
          <td class="l"><span class="st-res" title="${t.l10.w}-${t.l10.l}-${t.l10.otl}">${t.games.slice(-10).map((g) => `<i class="${g[4]}" title="${dShort(g[0])} ${g[5] ? "vs" : "@"} ${g[1]} ${g[2]}-${g[3]} ${g[4]}"></i>`).join("")}</span> <span class="dim">${t.l10.w}-${t.l10.l}-${t.l10.otl}</span></td>
          <td>${esc(t.streak)}</td><td class="l">${t.next ? `${t.next.home ? "vs" : "@"} ${esc(t.next.opp)} · ${dShort(t.next.date)} ${kLink(t.abbr)}` : "–"}</td></tr>`).join("")}</tbody></table></div></div></section>`).join("")}
    </div>
    <div class="legend"><span class="st-res"><i class="W"></i></span> Win <span class="st-res"><i class="OTL"></i></span> OT/shootout loss <span class="st-res"><i class="L"></i></span> Loss</div>
  </div>`;
  app.querySelectorAll("tr[data-t]").forEach((tr) => tr.addEventListener("click", (e) => { if (!e.target.closest("a")) openTeam(tr.dataset.t); }));
  const ts = D.teams;
  mkChart($("#t-diff"), { type: "bar", data: { labels: ts.map((t) => t.abbr), datasets: [{ label: "DIF", data: ts.map((t) => t.gf - t.ga),
    backgroundColor: ts.map((t) => (t.gf - t.ga >= 0 ? css("--candle-up") : css("--candle-down"))), borderRadius: 4, barPercentage: 0.7 }] },
    options: baseOpts({ onClick: (e, els) => { if (els[0]) openTeam(ts[els[0].index].abbr); }, plugins: { ...baseOpts().plugins, legend: { display: false },
      tooltip: { ...baseOpts().plugins.tooltip, callbacks: { label: (it) => { const t = ts[it.dataIndex]; return `${t.name}: ${t.gf} GF / ${t.ga} GA (${sgn(t.gf - t.ga, 0)}) · ${t.pts} pts`; } } } } }) });
}

/* ------------------------------------------------------------------ PARTIDOS */
function viewGames(app) {
  const byDate = {};
  D.schedule.forEach((g) => (byDate[g.date] = byDate[g.date] || []).push(g));
  const dates = Object.keys(byDate).sort();
  app.innerHTML = `<div class="view">
    <section class="panel"><div class="panel-b" style="font-size:13px;color:var(--fg-2)">
      For each game: the 4 players with the highest estimated chance to score (P goal) and to get at least one point (P point), calculated <b>against the opponent's probable goalie</b> (goalie quality + the player's history against him).
      The probable goalie comes from Kalshi once it lists its saves markets; otherwise from the starter rotation over the last 10 games (if the team played the day before, the backup is used).
      Next to each probability is the Kalshi Yes price when the market is open (Kalshi opens player markets on game day). An orange ● price means the game was already in progress.
      These are statistical estimates, not certainties.</div></section>
    ${kalshiValuePanel()}
    ${dates.length ? dates.map((d) => `<section class="panel"><div class="panel-h"><h2 style="text-transform:capitalize">${dLong(d)}</h2><span class="sub">${byDate[d].length} games</span></div>
      <div class="panel-b"><div class="games">${byDate[d].map(gameCard).join("")}</div></div></section>`).join("") : `<section class="panel"><div class="empty">No games on this week's schedule.</div></section>`}
  </div>`;
  bindOpeners(app);
  app.querySelectorAll("[data-vsgame]").forEach((el) => el.addEventListener("click", () => { vs.game = +el.dataset.vsgame; vs.gA = vs.gH = null; }));
}
function gameCard(g) {
  const col = (ab, opp) => {
    const goal = bestFor(ab, opp, "pGoal", 4, g), point = bestFor(ab, opp, "pPoint", 4, g);
    const goalie = probableGoalie(ab, g);
    const oppGk = probableGoalie(opp, g);
    const pk = (x, k) => `<button class="pick" data-p="${x.s.id}" type="button"><span>${esc(x.s.name)} ${x.s.form === "hot" ? "🔥" : x.s.form === "cold" ? "❄" : ""}</span><span style="display:flex;gap:8px;align-items:baseline">${kPriceTag(x.s.id, k === "pGoal" ? "goal" : "pts", g.id)}<b class="num">${pct(x[k])}</b></span></button>`;
    const win = kGame(g.id)?.win?.[ab];
    const t = TEAM[ab];
    return `<div style="min-width:0"><div style="display:grid;gap:2px;margin-bottom:6px">${teamBadge(ab)}<span class="dim num" style="font-size:12px">${t ? `${t.w}-${t.l}-${t.otl} · L10 ${t.l10.w}-${t.l10.l}-${t.l10.otl}` : ""}${win && win.ask ? ` · <span class="kal-price" title="Kalshi price for this team to win">Win ${cents(win.ask)}</span>` : ""}</span></div>
      ${oppGk ? `<div class="vs-gk">vs <b>${esc(oppGk.name)}</b> <span class="dim">(${esc(probLabel(opp, g))}${H && !H.error ? "" : " · loading history"})</span></div>` : ""}
      <h4>P(goal)</h4>${goal.map((x) => pk(x, "pGoal")).join("")}
      <h4 style="margin-top:8px">P(point)</h4>${point.map((x) => pk(x, "pPoint")).join("")}
      ${goalie ? `<h4 style="margin-top:8px">${probableInfo(ab, g)?.conf === "confirmed" ? "Their goalie · confirmed in net" : `Their probable goalie · ${esc(probLabel(ab, g))}`}</h4><button class="pick" data-g="${goalie.id}" type="button"><span>${esc(goalie.name)} ${chipMini(goalie.form)}</span><b class="num">${f3(goalie.svPct)}</b></button>` : ""}</div>`;
  };
  const live = g.state !== "FUT" && g.state !== "PRE";
  return `<article class="game"><div class="game-h">${teamBadge(g.away, true)}<span class="vs">@</span>${teamBadge(g.home, true)}
    <span class="time">${live ? `<b class="num">${g.awayScore ?? 0} – ${g.homeScore ?? 0}</b><br>${g.state === "OFF" || g.state === "FINAL" ? "Final" : "In progress"}` : `<b>${tLocal(g.start)}</b><br>${esc(g.venue || "")}`}</span></div>
    <div class="game-cols">${col(g.away, g.home)}${col(g.home, g.away)}</div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center"><a class="vs-link" href="#vsgoalie" data-vsgame="${g.id}">Player vs goalie duels →</a>${nhlLink(g.link || gameUrl(g.away, g.home, false, g.date, g.id), "Game on NHL.com")}${kalshiLink(kUrl(g.id, "game"))}</div></article>`;
}
function chipMini(f) { const x = FORM[f] || FORM.flat; return `<span style="color:var(${x.v})" title="${x.label}">${x.icon}</span>`; }

/* ------------------------------------------------------------------ MÉTODO */
function viewMethod(app) {
  const W = D.weights;
  app.innerHTML = `<div class="view"><section class="panel"><div class="panel-b method">
    <h3>Sources</h3>
    <p>Every number comes from the NHL's official public APIs (the same ones behind NHL.com). Nothing is made up or estimated by hand:</p>
    <ul>${D.sources.map((s) => `<li><code>${esc(s)}</code></li>`).join("")}</ul>
    <p>We download <b>game-by-game</b> stats for every player (${D.gamesCounted} games of the ${D.seasonLabel} season) and calculate everything else from them. "Active" means the player is on his team's official roster today; a traded player shows with his current team.</p>
    <h3>Updates</h3>
    <p>A scheduled GitHub Actions job runs <code>nhl_dashboard/fetch_nhl.py</code> daily at 10:17 UTC (after every North American night game is over) and hourly from 15:47 to 06:47 UTC during the game window, saves the new <code>data/nhl.json</code> and publishes the page. Last build: <b>${new Date(D.generatedAt).toLocaleString("en-US")}</b>.</p>
    <h3>Impact index (IMP) per game</h3>
    <p>A per-game "game score" style rating, built only from official stats:</p>
    <p><code>IMP = ${W.g}·G + ${W.a}·A + ${W.sog}·Shots + ${W.blk}·Blocks + ${W.hit}·Hits + ${W.tk}·Takeaways ${W.gv}·Giveaways + ${W.pm}·(+/-) + ${W.ppp}·PP points</code></p>
    <p>League average: forwards ${f2(D.league.impBaseF)}, defensemen ${f2(D.league.impBaseD)} per game.</p>
    <h3>Trend and form</h3>
    <p><b>Trend</b> (−100 to +100) compares the player's average IMP over the last 5 games (60%) and last 10 (40%) with his own season average, divided by his normal variability, plus the slope of the last 10 games. It measures whether the player is above or below <i>his own</i> level.</p>
    <ul>
      <li>${chip("hot")} trend ≥ +55, or a 4+ game point streak.</li>
      <li>${chip("up")} trend between +20 and +55.</li>
      <li>${chip("flat")} between −20 and +20.</li>
      <li>${chip("down")} between −55 and −20 (or a player on a point streak but below his average).</li>
      <li>${chip("cold")} trend ≤ −55, or 5+ games without a point for a 0.45+ points-per-game player.</li>
    </ul>
    <p>Players with fewer than 5 games are all marked Steady.</p>
    <h3>Strength index (0–100)</h3>
    <p>League percentile combining 55% season IMP per game (shrunk toward average for players with few games), 30% IMP over the last 10 and 15% ice time. For goalies: 55% GSAA per game, 30% GSAA over the last 5 and 15% starts.</p>
    <h3>Candles</h3>
    <p>Each candle is one week (Monday to Sunday). A player's "price" starts at 100 and moves each game by how much he beat his position's league average (IMP − league average). Green = his price rose that week; red = it fell. The wick shows the week's high and low. For goalies the price is cumulative GSAA; for teams, points above a 1-point-per-game pace.</p>
    <h3>Player vs goalie</h3>
    <p>From the official play-by-play of ${H ? H.games : "all"} games (seasons ${H ? H.seasons.map((x) => x.slice(0, 4) + "-" + x.slice(6)).join(", ") : "recent"}, regular season and playoffs, no shootouts) we record every shot on goal and goal with the goalie in net, the assists on those goals, and the games where the player dressed against that goalie. Empty-net goals don't count.</p>
    <p>Head-to-head samples are usually small, so the adjustment is shrunk toward what's expected:</p>
    <ul>
      <li><b>Goalie factor</b>: goals allowed per shot over 3 seasons versus league average, with 300 shots of weight toward the average.</li>
      <li><b>Duel factor (goal)</b>: <code>(goals vs goalie + 2) / (expected goals vs goalie + 2)</code>, where expected = shots vs goalie × player shooting % × goalie factor. Capped between 0.75 and 1.35.</li>
      <li><b>Duel factor (point)</b>: <code>(points vs goalie + 2) / (GP vs goalie × points per game + 2)</code>, also capped.</li>
      <li>The final goal probability uses the player's base model without opponent adjustment × goalie factor × duel factor (between 0.7 and 1.45). For points and assists the goalie weighs half (square root of the factor).</li>
      <li><b>Confidence</b>: low under 8 shots against that goalie, medium 8 to 24, high 25 or more.</li>
    </ul>
    <h3>Kalshi</h3>
    <p>We read Kalshi's open markets (public API) for this week's games: game winner, goalscorer (1+, 2+ goals), points, assists and goalie saves. Each player market is matched to the NHL player by team, initial and last name. The price shown is the cost to buy "Yes" (in cents = implied probability) at update time${D.kalshi ? ` (${kalshiFetchedLbl()})` : ""}; the link opens the market with the live price.</p>
    <p><b>Edge</b> = our probability − the Yes price. Positive means our model sees a higher chance than the market. It doesn't include fees or late news.</p>
    <h3>Probable goalie</h3>
    <p>The NHL doesn't announce starters in advance. For each game we use: (1) the goalie Kalshi lists in that game's saves market, usually the expected starter; if it isn't listed yet, (2) the goalie with the most starts in the team's last 10 games, unless the team played the day before with that goalie, in which case the backup. Once a game starts, the official boxscore confirms the goalie in net. Game and Vs goalie probabilities are calculated against that goalie.</p>
    <h3>Absence warning ⚠</h3>
    <p>If a player's team has played since his last game, he is marked ⚠ with the number of games missed. It usually means injury, illness or a healthy scratch. Players who missed 2+ games are left out of the weekly candidate lists.</p>
    <h3>P(goal), P(point) and P(assist)</h3>
    <p><b>Expected goals</b> = shots per game (50% season, 30% last 10, 20% last 5; shrunk toward his position average) × the player's shooting % (his shots and goals from previous seasons plus this one, shrunk with 150 shots toward his position: forwards ${D.model ? pct(D.model.pos.F.sh) : "–"}, defensemen ${D.model ? pct(D.model.pos.D.sh) : "–"}) × opponent factor (goals allowed, ±20% max) × recent change in ice time.</p>
    <p><b>Expected points</b> = points per game (shrunk with 8 games toward his position) blended with the last 10 and 5 games, × the same factors. <b>Expected assists</b> work the same way with assists per game. The probability is <code>1 − e^(−(a + c·expected))</code>, with <code>a</code> and <code>c</code> fitted by backtest for each market.</p>
    ${calibTable()}
    <p><b>Important:</b> these are statistical estimates for ranking candidates, not guarantees. They don't account for same-day injuries, confirmed lineups or odds. Always double-check before betting.</p>
  </div></section></div>`;
}

function calibTable() {
  const c = D.model && D.model.calibration;
  if (!c || !c.goal.length) return "";
  const tb = (rows, title) => `<div class="tbl-wrap" style="margin:8px 0 14px"><table class="tbl" style="min-width:420px"><thead><tr><th class="l">${title}: predicted</th><th>Games</th><th>Avg. predicted</th><th>Actually happened</th><th>Difference</th></tr></thead>
    <tbody>${rows.map((r) => `<tr style="cursor:default"><td class="l">${Math.round(r[0] * 100)}–${Math.min(100, Math.round(r[1] * 100))}%</td><td>${r[2].toLocaleString("en-US")}</td><td>${pct(r[3])}</td><td><b>${pct(r[4])}</b></td><td class="${Math.abs(r[4] - r[3]) <= 0.03 ? "pos" : "neg"}">${sgn((r[4] - r[3]) * 100, 1)} pts</td></tr>`).join("")}</tbody></table></div>`;
  return `<h3>How accurate is it? (backtest)</h3>
    <p>We re-ran the calculation for every game this season using <b>only the games before</b> that day (${c.n.toLocaleString("en-US")} predictions) and compared it with what happened. If the model is well calibrated, "Actually happened" matches "Avg. predicted".</p>
    ${tb(c.goal, "P(goal)")}${tb(c.point, "P(point)")}${c.assist && c.assist.length ? tb(c.assist, "P(assist)") : ""}
    <p class="dim">Brier score (lower = better): goal ${c.brierGoal}, point ${c.brierPoint}${c.brierAssist != null ? `, assist ${c.brierAssist}` : ""}.</p>`;
}

/* ------------------------------------------------------------------ MODALES */
function bindOpeners(root) {
  root.querySelectorAll("[data-p]").forEach((el) => el.addEventListener("click", (e) => { if (e.target.closest("a")) return; e.stopPropagation(); openPlayer(+el.dataset.p); }));
  root.querySelectorAll("[data-g]").forEach((el) => el.addEventListener("click", (e) => { if (e.target.closest("a")) return; e.stopPropagation(); openGoalie(+el.dataset.g); }));
}
function openModal(html, after, again) {
  destroy(modalCharts);
  const m = $("#modal"), sh = $("#sheet");
  sh.innerHTML = html;
  m.hidden = false;
  document.body.style.overflow = "hidden";
  sh.scrollTop = 0;
  $(".close", sh).addEventListener("click", closeModal);
  $(".close", sh).focus({ preventScroll: true });
  openModal.last = again;
  after && after(sh);
  bindOpeners(sh);
}
function closeModal() { destroy(modalCharts); $("#modal").hidden = true; document.body.style.overflow = ""; openModal.last = null; }
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal").hidden) closeModal(); });
document.addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

function statCell(lbl, val, delta) {
  return `<div><small>${lbl}</small><b>${val}</b>${delta != null ? `<em class="${delta >= 0 ? "pos" : "neg"}">${delta >= 0 ? "▲" : "▼"}${Math.abs(delta).toFixed(2)}</em>` : ""}</div>`;
}
function rolling(arr, n) { return arr.map((_, i) => { const s = arr.slice(Math.max(0, i - n + 1), i + 1); return s.reduce((a, b) => a + b, 0) / s.length; }); }

function openPlayer(id) {
  const s = D.skaters.find((x) => x.id === id);
  if (!s) return;
  const t = TEAM[s.team];
  const nx = t && t.next;
  const pj = nx ? projFor(s, nx.opp) : s.proj;
  const L = s.log;
  const recent = L.slice(-10).reverse();
  const toi10 = L.slice(-10).reduce((a, r) => a + r[7], 0) / Math.max(1, Math.min(10, L.length));
  openModal(`
    <div class="sheet-h">${avatar(s, "lg")}
      <div><h2 id="sheet-title">${esc(s.name)}</h2>
        <div class="facts">${teamBadge(s.team, true)} <span>#${s.num ?? "–"}</span>${nhlLink(`https://www.nhl.com/player/${s.id}`, "NHL.com profile")}${kLink(s.team)}<span>${POS[s.pos] || s.pos}</span><span>${s.age ? s.age + " yrs" : ""}</span><span>${s.shoots ? "Shoots " + (s.shoots === "L" ? "L" : "R") : ""}</span>${chip(s.form)}${missedBadge(s)}</div></div>
      <button class="close" type="button" aria-label="Close">×</button></div>

    <div class="statline">
      ${statCell("GP", s.gp)}${statCell("Goals", s.g)}${statCell("Assists", s.a)}${statCell("Points", s.p)}${statCell("P/GP", f2(s.ptsPg))}
      ${statCell("Shots", s.sog)}${statCell("Sh%", pct(s.shPct))}${statCell("TOI", mmss(s.toi))}${statCell("+/-", (s.pm > 0 ? "+" : "") + s.pm)}${statCell("PPP", s.ppp)}
      ${statCell("Hits", s.hit)}${statCell("Blocks", s.blk)}
    </div>
    <div class="statline">
      ${statCell("Strength", s.power != null ? Math.round(s.power) : "–")}${statCell("Trend", (s.trend > 0 ? "+" : "") + s.trend)}
      ${statCell("IMP season", f2(s.imp))}${statCell("IMP L10", f2(s.imp10), s.imp10 - s.imp)}${statCell("IMP L5", f2(s.imp5), s.imp5 - s.imp)}
      ${statCell("L5 G-A-P", `${s.l5.g}-${s.l5.a}-${s.l5.p}`)}${statCell("L10 G-A-P", `${s.l10.g}-${s.l10.a}-${s.l10.p}`)}
      ${statCell("TOI L5", mmss(s.toi5), s.toi5 - s.toi)}${statCell("Point streak", s.pStreak)}${statCell("No point", s.dryStreak)}
    </div>

    <section class="panel"><div class="panel-h"><h3>Next game</h3><span class="sub">${nx ? `${nx.home ? "vs" : "@"} ${esc(TEAM[nx.opp]?.name || nx.opp)} · ${nx.start ? new Date(nx.start).toLocaleString("en-US", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) : dLong(nx.date)}` : "No game scheduled this week"}</span><span class="right" style="display:flex;gap:14px">${nhlLink(nextUrl(s.team), "Game on NHL.com")}${kLink(s.team)}</span></div>
      <div class="panel-b"><div class="proj">
        <div><span class="ring" style="--p:${Math.round(pj.pGoal * 100)}"><span>${pct(pj.pGoal)}</span></span><small>P(score a goal)</small><b class="num">${pct(pj.pGoal)}</b></div>
        <div><span class="ring" style="--p:${Math.round(pj.pPoint * 100)}"><span>${pct(pj.pPoint)}</span></span><small>P(1+ point)</small><b class="num">${pct(pj.pPoint)}</b></div>
        <div><small>Expected goals</small><b class="num">${f2(pj.g)}</b></div>
        <div><small>Expected points</small><b class="num">${f2(pj.p)}</b></div>
        <div><small>Expected shots</small><b class="num">${f1(pj.sog)}</b></div>
        <div><small>Opponent factor</small><b class="num">${f2(pj.oppF)}</b><div class="dim" style="font-size:11.5px">&gt;1 = opponent allows more than average</div></div>
      </div><div id="m-kal" style="margin-top:12px">${playerKalshiBlock(s)}</div></div></section>

    <section class="panel" id="m-vs"><div class="panel-h"><h3>Against goalies</h3><span class="sub">Loading history…</span></div></section>

    <section class="panel"><div class="panel-h"><h3>Weekly performance candles</h3><span class="sub">Price starts at 100 · rises when he beats his position average</span></div>
      <div class="panel-b"><div class="chart-box"><canvas id="m-candle"></canvas></div>
      <div class="legend" style="margin-top:8px"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--candle-up)"></span> Up week <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--candle-down);margin-left:10px"></span> Down week</div></div></section>

    <div class="grid g2">
      <section class="panel"><div class="panel-h"><h3>Goals and assists per game</h3></div><div class="panel-b"><div class="chart-box short"><canvas id="m-pts"></canvas></div></div></section>
      <section class="panel"><div class="panel-h"><h3>Impact per game</h3><span class="sub">Bars = IMP · line = 5-game moving average</span></div><div class="panel-b"><div class="chart-box short"><canvas id="m-imp"></canvas></div></div></section>
      <section class="panel"><div class="panel-h"><h3>Shots on goal</h3><span class="sub">Season avg. ${f2(s.sog / s.gp)}</span></div><div class="panel-b"><div class="chart-box short"><canvas id="m-sog"></canvas></div></div></section>
      <section class="panel"><div class="panel-h"><h3>Time on ice (min)</h3><span class="sub">L10 avg. ${mmss(toi10)}</span></div><div class="panel-b"><div class="chart-box short"><canvas id="m-toi"></canvas></div></div></section>
    </div>

    <section class="panel"><div class="panel-h"><h3>Last 10 games</h3></div><div class="panel-b"><div class="tbl-wrap"><table class="tbl" style="min-width:640px">
      <thead><tr><th class="l">Date</th><th class="l">Opp.</th><th>G</th><th>A</th><th>P</th><th>Shots</th><th>TOI</th><th>+/-</th><th>Hits</th><th>Blk</th><th>PPP</th><th>IMP</th><th class="l">Game</th></tr></thead>
      <tbody>${recent.map((r) => `<tr style="cursor:default"><td class="l">${dShort(r[0])}</td><td class="l">${r[2] ? "vs" : "@"} ${esc(r[1])}</td><td>${r[3]}</td><td>${r[4]}</td><td><b>${r[5]}</b></td><td>${r[6]}</td><td>${mmss(r[7])}</td>
        <td class="${r[8] > 0 ? "pos" : r[8] < 0 ? "neg" : ""}">${r[8] > 0 ? "+" : ""}${r[8]}</td><td>${r[9]}</td><td>${r[10]}</td><td>${r[11]}</td><td class="${r[12] >= s.imp ? "pos" : "neg"}">${f2(r[12])}</td><td class="l">${nhlLink(gameUrl(s.team, r[1], r[2], r[0], r[13]), "NHL.com")}</td></tr>`).join("")}</tbody></table></div></div></section>
  `, () => {
    candleChart($("#m-candle"), s.candles, { bucket: modalCharts, yLabel: "Price" });
    whenH2H(() => { const el = $("#m-vs"); if (el && el.isConnected) { el.outerHTML = playerVsBlock(s); bindOpeners($("#sheet")); } const k = $("#m-kal"); if (k && k.isConnected) k.innerHTML = playerKalshiBlock(s); });
    const labels = L.map((r) => dShort(r[0]));
    const tip = (it) => { const r = L[it[0].dataIndex]; return `${dShort(r[0])} ${r[2] ? "vs" : "@"} ${r[1]}`; };
    const o = (extra = {}) => { const b = baseOpts(); b.plugins.tooltip.callbacks = { title: tip }; return Object.assign(b, extra); };
    const optsStack = o(); optsStack.scales.x.stacked = true; optsStack.scales.y.stacked = true; optsStack.scales.y.ticks.stepSize = 1;
    mkChart($("#m-pts"), { type: "bar", data: { labels, datasets: [
      { label: "Goals", data: L.map((r) => r[3]), backgroundColor: css("--gold"), borderRadius: 3, borderColor: css("--panel"), borderWidth: { top: 2 } },
      { label: "Assists", data: L.map((r) => r[4]), backgroundColor: css("--accent"), borderRadius: 3 }] }, options: optsStack }, modalCharts);
    mkChart($("#m-imp"), { type: "bar", data: { labels, datasets: [
      { type: "line", label: "5-game avg.", data: rolling(L.map((r) => r[12]), 5), borderColor: css("--hot"), borderWidth: 2, pointRadius: 0, tension: 0.3, order: 0 },
      { type: "line", label: "Season avg.", data: L.map(() => s.imp), borderColor: css("--fg-3"), borderDash: [4, 4], borderWidth: 1, pointRadius: 0, order: 0 },
      { label: "IMP", data: L.map((r) => r[12]), backgroundColor: L.map((r) => (r[12] >= s.imp ? css("--candle-up") : css("--candle-down")) + "99"), borderRadius: 3, order: 1 }] }, options: o() }, modalCharts);
    mkChart($("#m-sog"), { type: "bar", data: { labels, datasets: [
      { type: "line", label: "5-game avg.", data: rolling(L.map((r) => r[6]), 5), borderColor: css("--hot"), borderWidth: 2, pointRadius: 0, tension: 0.3 },
      { label: "Shots", data: L.map((r) => r[6]), backgroundColor: css("--cold") + "aa", borderRadius: 3 }] }, options: o() }, modalCharts);
    mkChart($("#m-toi"), { type: "line", data: { labels, datasets: [
      { label: "TOI", data: L.map((r) => r[7]), borderColor: css("--accent"), backgroundColor: css("--accent") + "22", fill: true, borderWidth: 2, pointRadius: 2, tension: 0.25 }] },
      options: (() => { const x = o(); x.plugins.legend.display = false; x.plugins.tooltip.callbacks.label = (it) => "TOI " + mmss(it.raw); return x; })() }, modalCharts);
  }, () => openPlayer(id));
}

function openGoalie(id) {
  const g = D.goalies.find((x) => x.id === id);
  if (!g) return;
  const L = g.log;
  openModal(`
    <div class="sheet-h">${avatar(g, "lg")}
      <div><h2 id="sheet-title">${esc(g.name)}</h2><div class="facts">${teamBadge(g.team, true)} <span>#${g.num ?? "–"}</span><span>Goalie</span><span>${g.age ? g.age + " yrs" : ""}</span>${chip(g.form)}${missedBadge(g)}${nhlLink(`https://www.nhl.com/player/${g.id}`, "NHL.com profile")}${kLink(g.team)}${nextUrl(g.team) ? nhlLink(nextUrl(g.team), "Next game") : ""}</div></div>
      <button class="close" type="button" aria-label="Close">×</button></div>
    ${goalieKalshiBlock(g)}
    <div class="statline">${statCell("GP", g.gp)}${statCell("Starts", g.gs)}${statCell("W-L-OTL", `${g.w}-${g.l}-${g.otl}`)}${statCell("SV%", f3(g.svPct))}${statCell("GAA", f2(g.gaa))}
      ${statCell("SO", g.so)}${statCell("GSAA", sgn(g.gsaa, 1))}${statCell("SV% L5", f3(g.svPct5))}${statCell("GSAA L5", sgn(g.gsaa5, 1))}${statCell("Strength", g.power != null ? Math.round(g.power) : "–")}${statCell("Trend", (g.trend > 0 ? "+" : "") + g.trend)}</div>
    <section class="panel"><div class="panel-h"><h3>Weekly candles · cumulative GSAA</h3><span class="sub">Rises when he stops more than expected</span></div><div class="panel-b"><div class="chart-box"><canvas id="m-candle"></canvas></div></div></section>
    <div class="grid g2">
      <section class="panel"><div class="panel-h"><h3>SV% per game</h3><span class="sub">Dashed line = league average</span></div><div class="panel-b"><div class="chart-box short"><canvas id="m-sv"></canvas></div></div></section>
      <section class="panel"><div class="panel-h"><h3>GSAA per game</h3></div><div class="panel-b"><div class="chart-box short"><canvas id="m-gsaa"></canvas></div></div></section>
    </div>
    <section class="panel"><div class="panel-h"><h3>Last 10 games</h3></div><div class="panel-b"><div class="tbl-wrap"><table class="tbl" style="min-width:560px">
      <thead><tr><th class="l">Date</th><th class="l">Opp.</th><th>Dec.</th><th>Shots</th><th>Saves</th><th>GA</th><th>SV%</th><th>TOI</th><th>GSAA</th><th class="l">Game</th></tr></thead>
      <tbody>${L.slice(-10).reverse().map((r) => `<tr style="cursor:default"><td class="l">${dShort(r[0])}</td><td class="l">${r[2] ? "vs" : "@"} ${esc(r[1])}</td><td>${r[8]}</td><td>${r[3]}</td><td>${r[4]}</td><td>${r[5]}</td><td>${f3(r[6])}</td><td>${mmss(r[7])}</td><td class="${r[9] >= 0 ? "pos" : "neg"}">${sgn(r[9])}</td><td class="l">${nhlLink(gameUrl(g.team, r[1], r[2], r[0], r[10]), "NHL.com")}</td></tr>`).join("")}</tbody></table></div></div></section>
  `, () => {
    candleChart($("#m-candle"), g.candles, { bucket: modalCharts, yLabel: "Cumulative GSAA" });
    const labels = L.map((r) => dShort(r[0]));
    const o = () => { const b = baseOpts(); b.plugins.tooltip.callbacks = { title: (it) => { const r = L[it[0].dataIndex]; return `${dShort(r[0])} ${r[2] ? "vs" : "@"} ${r[1]} · ${r[3]} shots`; } }; return b; };
    const sv = o(); sv.scales.y.ticks.callback = (v) => f3(v);
    mkChart($("#m-sv"), { type: "line", data: { labels, datasets: [
      { label: "SV%", data: L.map((r) => r[6]), borderColor: css("--accent"), pointBackgroundColor: L.map((r) => (r[6] >= D.league.svPct ? css("--candle-up") : css("--candle-down"))), pointRadius: 4, borderWidth: 2, tension: 0.2 },
      { label: "League average", data: L.map(() => D.league.svPct), borderColor: css("--fg-3"), borderDash: [4, 4], borderWidth: 1, pointRadius: 0 }] }, options: sv }, modalCharts);
    mkChart($("#m-gsaa"), { type: "bar", data: { labels, datasets: [{ label: "GSAA", data: L.map((r) => r[9]), backgroundColor: L.map((r) => (r[9] >= 0 ? css("--candle-up") : css("--candle-down"))), borderRadius: 3 }] }, options: (() => { const x = o(); x.plugins.legend.display = false; return x; })() }, modalCharts);
  }, () => openGoalie(id));
}

function openTeam(ab) {
  const t = TEAM[ab];
  if (!t) return;
  const roster = activeSk().filter((s) => s.team === ab).sort((a, b) => (b.power ?? -1) - (a.power ?? -1));
  const gls = activeGo().filter((g) => g.team === ab);
  openModal(`
    <div class="sheet-h"><span class="av lg">${t.logo ? `<img src="${esc(t.logo)}" alt="" onerror="this.remove()" style="object-fit:contain;padding:8px">` : ""}${esc(ab)}</span>
      <div><h2 id="sheet-title">${esc(t.name)}</h2><div class="facts"><span>${esc(t.div)} · #${t.divRank} in division · #${t.leagueRank} in league</span><span>Streak ${esc(t.streak)}</span>${nhlLink(nextUrl(ab), "Next game on NHL.com")}${kLink(ab)}</div></div>
      <button class="close" type="button" aria-label="Close">×</button></div>
    <div class="statline">${statCell("GP", t.gp)}${statCell("W-L-OTL", `${t.w}-${t.l}-${t.otl}`)}${statCell("Points", t.pts)}${statCell("P%", f3(t.ptsPct))}${statCell("GF/GP", f2(t.gfpg))}${statCell("GA/GP", f2(t.gapg))}
      ${statCell("Home", t.home)}${statCell("Road", t.road)}${statCell("L10", `${t.l10.w}-${t.l10.l}-${t.l10.otl}`)}</div>
    <section class="panel"><div class="panel-h"><h3>Weekly candles · points above .500 pace</h3><span class="sub">+1 per win, 0 per OT loss, −1 per loss</span></div><div class="panel-b"><div class="chart-box"><canvas id="m-candle"></canvas></div></div></section>
    <section class="panel"><div class="panel-h"><h3>Goals for and against per game</h3></div><div class="panel-b"><div class="chart-box short"><canvas id="m-gfga"></canvas></div></div></section>
    <section class="panel"><div class="panel-h"><h3>Roster by Strength</h3><span class="sub">${roster.length} skaters · ${gls.length} goalies</span></div>
      <div class="panel-b"><div class="tlist">${roster.map((s) => `<button class="trow" data-p="${s.id}" type="button" style="grid-template-columns:28px minmax(0,1fr) auto auto">${avatar(s, "sm")}
        <span><div class="nm">${esc(s.name)} <span class="dim">${POS[s.pos] || s.pos}</span></div><div class="sub">${s.gp} GP · ${s.g}G ${s.a}A ${s.p}P · L5 ${s.l5.p}P</div></span>${chip(s.form)}<span class="num" style="width:34px;text-align:right;font-weight:700">${s.power != null ? Math.round(s.power) : "–"}</span></button>`).join("")}
      ${gls.map((g) => `<button class="trow" data-g="${g.id}" type="button" style="grid-template-columns:28px minmax(0,1fr) auto auto">${avatar(g, "sm")}<span><div class="nm">${esc(g.name)} <span class="dim">G</span></div><div class="sub">${g.gp} GP · SV% ${f3(g.svPct)} · GSAA ${sgn(g.gsaa, 1)}</div></span>${chip(g.form)}<span class="num" style="width:34px;text-align:right;font-weight:700">${g.power != null ? Math.round(g.power) : "–"}</span></button>`).join("")}</div></div></section>
  `, () => {
    candleChart($("#m-candle"), t.candles, { bucket: modalCharts, yLabel: "Points above .500", fmt: (v) => String(Math.round(v)) });
    const G = t.games;
    const b = baseOpts(); b.plugins.tooltip.callbacks = { title: (it) => { const r = G[it[0].dataIndex]; return `${dShort(r[0])} ${r[5] ? "vs" : "@"} ${r[1]} · ${r[2]}-${r[3]} ${r[4]}`; } };
    mkChart($("#m-gfga"), { type: "bar", data: { labels: G.map((r) => dShort(r[0])), datasets: [
      { label: "Goals for", data: G.map((r) => r[2]), backgroundColor: css("--candle-up"), borderRadius: 3 },
      { label: "Goals against", data: G.map((r) => r[3]), backgroundColor: css("--candle-down"), borderRadius: 3 }] }, options: b }, modalCharts);
  }, () => openTeam(ab));
}

/* ------------------------------------------------------------------ JUGADOR VS PORTERO */
const H2H_URL = "data/h2h.json";
let H = null;                 // {seasons, games, pairs:{sid:[[gid,gp,sog,g,a,gpCur,sogCur,gCur]]}, shooters, goalies}
let H_IDX = null;             // "sid:gid" -> fila
let hWaiters = [];
const vs = { game: null, gA: null, gH: null, team: "", goalie: "", minShots: 0 };

async function loadH2H() {
  try {
    const r = await fetch(H2H_URL, { cache: "no-cache" });
    if (!r.ok) throw new Error(r.status);
    H = await r.json();
    H_IDX = new Map();
    for (const [sid, rows] of Object.entries(H.pairs)) for (const row of rows) H_IDX.set(sid + ":" + row[0], row);
  } catch (e) { H = { error: true, pairs: {}, shooters: {}, goalies: {}, seasons: [], games: 0 }; H_IDX = new Map(); }
  const w = hWaiters; hWaiters = []; w.forEach((f) => f());
  if (["vsgoalie", "games", "summary", "analyst", ""].includes((location.hash || "").slice(1)) && $("#modal").hidden) route();
}
function whenH2H(f) { if (H) f(); else hWaiters.push(f); }

const lgSv = () => D.league.svPct || 0.9;
function goalieFactor(gid) {
  const g = H.goalies[gid];
  const lgGa = 1 - lgSv();
  if (!g) return { f: 1, sa: 0, ga: 0, sv: null };
  const rate = (g[1] + 300 * lgGa) / (g[0] + 300);
  return { f: rate / lgGa, sa: g[0], ga: g[1], sv: g[0] ? 1 - g[1] / g[0] : null };
}
function shooterPct(sid) {
  const sh = H.shooters[sid];
  const lg = D.league.shPct || 0.1;
  return sh ? (sh[1] + 80 * lg) / (sh[0] + 80) : lg;
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const scaleP = (p, r) => 1 - Math.pow(1 - Math.min(p, 0.99), r);

/** Duelo de un jugador contra un portero concreto. */
function matchup(s, gid) {
  const row = H_IDX.get(s.id + ":" + gid) || [gid, 0, 0, 0, 0, 0, 0, 0];
  const [, gp, sog, g, a, gpC, sogC, gC] = row;
  const gf = goalieFactor(gid);
  const shp = shooterPct(s.id);
  const xg = sog * shp * gf.f;
  const pairG = clamp((g + 2) / (xg + 2), 0.75, 1.35);
  const xp = gp * (s.ptsPg || 0);
  const pairP = clamp((g + a + 2) / (xp + 2), 0.75, 1.35);
  const mG = clamp(gf.f * pairG, 0.7, 1.45);
  const mP = clamp(Math.sqrt(gf.f) * pairP, 0.7, 1.45);
  // probabilidad base sin ajuste de rival
  const o = s.proj.oppF || 1;
  const p0g = scaleP(s.proj.pGoal, 1 / o), p0p = scaleP(s.proj.pPoint, 1 / o), p0a = scaleP(s.proj.pAssist ?? 0, 1 / o);
  return {
    s, gid, gp, sog, g, a, p: g + a, gpC, sogC, gC, xg, shVs: sog ? g / sog : null, shp,
    pairG, pairP, gf: gf.f, mG, mP,
    pGoal: scaleP(p0g, mG), pPoint: scaleP(p0p, mP), pAssist: scaleP(p0a, mP), pGoalBase: s.proj.pGoal, pPointBase: s.proj.pPoint,
    conf: sog >= 25 ? "high" : sog >= 8 ? "medium" : "low",
  };
}
/* portero probable del equipo `team` en el partido `game` (o en su próximo partido) */
function gameOf(team, game) {
  if (game) return game;
  const t = TEAM[team];
  return t && t.next ? D.schedule.find((g) => g.id === t.next.id) : null;
}
function probableInfo(team, game) {
  const g = gameOf(team, game);
  if (!g || !g.goalies) return null;
  return g.away === team ? g.goalies.away : g.home === team ? g.goalies.home : null;
}
function probableGoalie(team, game) {
  const info = probableInfo(team, game);
  const gk = info && D.goalies.find((x) => x.id === info.id);
  return gk || lastStarter(team);
}
function probLabel(team, game) {
  const info = probableInfo(team, game);
  if (!info) return "last starter";
  return info.src === "Kalshi" ? "probable per Kalshi" : info.src.toLowerCase();
}
function lastStarter(team) {
  return activeGo().filter((x) => x.team === team && x.log.length)
    .sort((a, b) => b.log[b.log.length - 1][0].localeCompare(a.log[a.log.length - 1][0]) || b.gs - a.gs)[0];
}
function confChip(c) {
  const map = { high: ["--up", "●●●"], medium: ["--gold", "●●○"], low: ["--fg-3", "●○○"] };
  const [v, dots] = map[c];
  return `<span class="conf" style="color:var(${v})" title="${c} confidence (sample size)">${dots} <span>${c}</span></span>`;
}
function factorCell(f) {
  const cls = f >= 1.08 ? "pos" : f <= 0.92 ? "neg" : "";
  return `<span class="num ${cls}" title="Multiplier on his base probability">×${f.toFixed(2)}</span>`;
}
function deltaPct(p, base) {
  const d = Math.round((p - base) * 100);
  if (!d) return `<span class="dim">±0</span>`;
  return `<span class="${d > 0 ? "pos" : "neg"}">${d > 0 ? "▲" : "▼"}${Math.abs(d)}</span>`;
}

function viewVs(app) {
  if (!H) { app.innerHTML = `<div class="loading">Loading player vs goalie history…</div>`; return; }
  if (H.error) { app.innerHTML = `<section class="panel"><div class="empty">Could not find <code>${H2H_URL}</code>. Run <code>python nhl_dashboard/fetch_nhl.py</code>.</div></section>`; return; }
  const upcoming = D.schedule.filter((g) => ["FUT", "PRE", "LIVE", "CRIT"].includes(g.state) && (!g.start || Date.now() < new Date(g.start).getTime() + 4 * 3600e3));
  const games = upcoming.length ? upcoming : D.schedule;
  if (vs.game == null || !games.find((g) => g.id === vs.game)) vs.game = games[0]?.id ?? null;
  const game = games.find((g) => g.id === vs.game);

  // mejores duelos de toda la semana (contra el portero probable del rival en cada partido)
  const best = [];
  games.forEach((g) => [[g.away, g.home], [g.home, g.away]].forEach(([team, opp]) => {
    const gk = probableGoalie(opp, g);
    if (!gk) return;
    activeSk().filter((s) => s.team === team && s.gp >= 5 && s.log.length && daysSince(s.log[s.log.length - 1][0]) <= 12 && missedGames(s) < 2)
      .forEach((s) => { const m = matchup(s, gk.id); if (m.sog >= 8) best.push({ ...m, game: g, goalie: gk }); });
  }));
  // un jugador puede jugar varias veces en la semana: se queda su mejor duelo
  const uniq = (arr) => { const seen = new Set(); return arr.filter((m) => !seen.has(m.s.id) && seen.add(m.s.id)); };
  const bestGoal = uniq([...best].sort((a, b) => b.pGoal - a.pGoal)).slice(0, 10);
  const bestPoint = uniq([...best].sort((a, b) => b.pPoint - a.pPoint)).slice(0, 10);
  const owners = uniq([...best].filter((m) => m.g >= 3).sort((a, b) => (b.g - b.xg) - (a.g - a.xg))).slice(0, 10);

  app.innerHTML = `<div class="view">
    <section class="panel"><div class="panel-b" style="font-size:13px;color:var(--fg-2);display:grid;gap:6px">
      <div>Head-to-head record of every player against every goalie, from the official play-by-play of <b>${H.games}</b> games (seasons ${H.seasons.map((x) => x.slice(0, 4) + "-" + x.slice(6)).join(", ")}, playoffs included). The adjusted probability combines current form, goalie quality and his history against that goalie.</div>
      <div class="legend">${confChip("high")} 25+ shots ${confChip("medium")} 8–24 ${confChip("low")} under 8 · <span class="pos">×1.20</span> favorable duel · <span class="neg">×0.85</span> unfavorable</div>
    </div></section>

    <div class="grid g4" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr))">
      ${bestList("Highest P(goal) vs opposing goalie", "Against each game's probable goalie · 8+ shots of history", bestGoal, "pGoal", "pGoalBase")}
      ${bestList("Highest P(point) vs opposing goalie", "Adjusted by his points history against him", bestPoint, "pPoint", "pPointBase")}
      ${bestList("Goalie owners", "More goals than expected against this week's opposing goalie (3+ goals)", owners, "pairG", null)}
    </div>

    <section class="panel"><div class="panel-h"><h2>Duels by game</h2><span class="sub">Pick the game and the goalie</span></div>
      <div class="panel-b" style="display:grid;gap:14px">
        <div class="filters">
          <label class="fld">Game<select id="vs-game">${games.map((g) => `<option value="${g.id}" ${g.id === vs.game ? "selected" : ""}>${dShort(g.date)} · ${g.away} @ ${g.home}${g.start ? " · " + tLocal(g.start) : ""}</option>`).join("")}</select></label>
          <label class="fld">Min. shots vs goalie <input type="number" id="vs-min" min="0" value="${vs.minShots}" style="width:80px"></label>
          ${game ? `<span style="padding-bottom:8px">${nhlLink(game.link || gameUrl(game.away, game.home, false, game.date, game.id), "Game on NHL.com")}</span>` : ""}
        </div>
        ${game ? `<div class="grid">${sidePanel(game.away, game.home, "gA", game)}${sidePanel(game.home, game.away, "gH", game)}</div>` : `<div class="empty">No games this week.</div>`}
      </div></section>

    <section class="panel"><div class="panel-h"><h2>Free explorer</h2><span class="sub">Any team against any goalie</span></div>
      <div class="panel-b" style="display:grid;gap:14px">
        <div class="filters">
          <label class="fld">Players from<select id="vs-team">${D.teams.map((t) => t.abbr).sort().map((t) => `<option ${t === (vs.team || D.teams[0].abbr) ? "selected" : ""}>${t}</option>`).join("")}</select></label>
          <label class="fld">Against goalie<select id="vs-goalie">${activeGo().slice().sort((a, b) => a.team.localeCompare(b.team) || b.gp - a.gp).map((g) => `<option value="${g.id}" ${String(g.id) === String(vs.goalie) ? "selected" : ""}>${g.team} · ${esc(g.name)}</option>`).join("")}</select></label>
        </div>
        <div id="vs-free"></div>
      </div></section>
  </div>`;

  bindOpeners(app);
  $("#vs-game")?.addEventListener("change", (e) => { vs.game = +e.target.value; vs.gA = vs.gH = null; route(); });
  $("#vs-min")?.addEventListener("change", (e) => { vs.minShots = +e.target.value || 0; route(); });
  app.querySelectorAll("select[data-side]").forEach((sel) => sel.addEventListener("change", () => { vs[sel.dataset.side] = +sel.value; route(); }));
  const drawFree = () => {
    vs.team = $("#vs-team").value; vs.goalie = $("#vs-goalie").value;
    const opp = activeGo().find((g) => String(g.id) === vs.goalie);
    $("#vs-free").innerHTML = opp ? vsTable(vs.team, opp) : "";
    bindOpeners($("#vs-free"));
  };
  if (!vs.goalie) { const t = D.teams.find((t) => t.abbr === (vs.team || D.teams[0].abbr)); const opp = t?.next ? probableGoalie(t.next.opp) : activeGo()[0]; if (opp) { vs.goalie = String(opp.id); $("#vs-goalie").value = vs.goalie; } }
  $("#vs-team").addEventListener("change", drawFree);
  $("#vs-goalie").addEventListener("change", drawFree);
  drawFree();
}

function bestList(title, sub, arr, key, baseKey) {
  return `<section class="panel"><div class="panel-h"><h3>${title}</h3></div><div class="panel-b"><p class="dim" style="margin:0 0 8px;font-size:12px">${sub}</p>
    <div class="tlist">${arr.length ? arr.map((m) => `<button class="trow" data-p="${m.s.id}" type="button" style="grid-template-columns:28px minmax(0,1fr) auto">${avatar(m.s, "sm")}
      <span><div class="nm">${esc(m.s.name)} <span class="dim">${m.s.team}</span></div>
      <div class="sub">${dShort(m.game.date)} vs ${esc(lastName(m.goalie.name))} (${m.goalie.team}) · ${m.gp} GP · ${m.g}G ${m.a}A on ${m.sog} shots · ${confChip(m.conf)}</div></span>
      <span class="delta" style="text-align:right">${key === "pairG" ? `<span class="pos">+${f1(m.g - m.xg)}</span><br><small class="dim">goals above expected</small>` : `<span class="pct">${pct(m[key])}</span><br><small>${deltaPct(m[key], m[baseKey])}</small>`}</span></button>`).join("")
      : `<div class="empty">No duels with enough sample.</div>`}</div></div></section>`;
}

function sidePanel(team, opp, side, game) {
  const goalies = activeGo().filter((g) => g.team === opp).sort((a, b) => b.gs - a.gs);
  const def = probableGoalie(opp, game);
  const gid = vs[side] || def?.id;
  const gk = goalies.find((g) => g.id === gid) || def;
  if (!gk) return `<div class="empty">No goalies for ${opp}.</div>`;
  return `<div style="min-width:0;display:grid;gap:10px">
    <div class="filters" style="align-items:center">${teamBadge(team, true)} <span class="dim">against</span>
      <label class="fld" style="flex:1 1 200px">${opp} goalie<select data-side="${side}">${goalies.map((g) => `<option value="${g.id}" ${g.id === gk.id ? "selected" : ""}>${esc(g.name)}${def && g.id === def.id ? ` (${esc(probLabel(opp, game))})` : ""}</option>`).join("")}</select></label></div>
    ${vsTable(team, gk)}</div>`;
}

function vsTable(team, gk) {
  const gf = goalieFactor(gk.id);
  const rows = activeSk().filter((s) => s.team === team && s.gp >= 1).map((s) => matchup(s, gk.id))
    .filter((m) => m.sog >= vs.minShots).sort((a, b) => b.pGoal - a.pGoal);
  return `<div class="goalie-card">${avatar(gk, "sm")}<div style="min-width:0"><b>${esc(gk.name)}</b> ${chip(gk.form)}
      <div class="dim" style="font-size:12px">SV% 3 seasons ${gf.sv != null ? f3(gf.sv) : "–"} on ${gf.sa} shots · this season ${f3(gk.svPct)} · GSAA ${sgn(gk.gsaa, 1)}</div></div>
      <div style="text-align:right"><small class="dim">Goalie factor</small><br>${factorCell(gf.f)}</div></div>
    <div class="tbl-wrap"><table class="tbl" style="min-width:860px"><thead><tr>
      <th class="l">Player</th><th class="l">Form</th><th title="Games against this goalie">GP vs</th><th>Shots</th><th>G</th><th>A</th><th>P</th><th title="Shooting % against him / overall shooting %">Sh% vs</th>
      <th title="Expected goals from those shots">xG</th><th title="Head-to-head factor for goals">Duel</th><th>P(goal)</th><th title="Kalshi Yes price for 1+ goal and edge">Kalshi goal</th><th>P(point)</th><th title="Kalshi Yes price for 1+ point and edge">Kalshi point</th><th class="l">Confidence</th></tr></thead>
      <tbody>${rows.length ? rows.map((m) => `<tr data-p="${m.s.id}">
        <td class="l"><span class="pl">${avatar(m.s, "sm")}<b>${esc(m.s.name)}</b>${kLink(m.s.team)} <span class="dim">${POS[m.s.pos] || m.s.pos}</span>${missedGames(m.s) ? ` <span class="miss-dot" title="His team played ${missedGames(m.s)} game(s) without him">⚠ ${missedGames(m.s)}</span>` : ""}</span></td><td class="l">${chip(m.s.form)}</td>
        <td>${m.gp}</td><td>${m.sog}</td><td><b>${m.g}</b></td><td>${m.a}</td><td>${m.p}</td>
        <td>${m.shVs != null ? pct(m.shVs) : "–"} <span class="dim">/ ${pct(m.shp)}</span></td><td>${f1(m.xg)}</td><td>${factorCell(m.pairG)}</td>
        <td class="pct">${pct(m.pGoal)} <small>${deltaPct(m.pGoal, m.pGoalBase)}</small></td><td>${kCell(m.s, "goal", m.pGoal)}</td><td class="pct">${pct(m.pPoint)} <small>${deltaPct(m.pPoint, m.pPointBase)}</small></td><td>${kCell(m.s, "pts", m.pPoint)}</td>
        <td class="l">${confChip(m.conf)}</td></tr>`).join("") : `<tr><td colspan="15"><div class="empty">No players with that minimum of shots.</div></td></tr>`}</tbody></table></div>
    <p class="chart-note">▲▼ = percentage points versus his base probability against an average opponent.</p>`;
}

function kCell(s, kind, ours) {
  if (kLive(s.id)) return kPriceTag(s.id, kind) || `<span class="dim">–</span>`;
  const m = kMarket(s.id, kind, 1);
  if (!m || !m.ask) return `<span class="dim">–</span>`;
  const gid = kPlayer(s.id).game;
  return `<span class="kal-price">${cents(m.ask)}</span> ${edgeCell(ours, m.ask)}`;
}
function playerVsBlock(s) {
  if (!H || H.error) return "";
  const rows = (H.pairs[s.id] || []).map((r) => matchup(s, r[0])).filter((m) => m.sog > 0 || m.p > 0);
  const t = TEAM[s.team];
  const nextGk = t && t.next ? probableGoalie(t.next.opp) : null;
  const nm = nextGk ? matchup(s, nextGk.id) : null;
  const goalieName = (id) => (D.goalies.find((g) => g.id === id) || {}).name || id;
  const top = rows.slice().sort((a, b) => b.g - a.g || b.p - a.p).slice(0, 8);
  return `<section class="panel" id="m-vs"><div class="panel-h"><h3>Against goalies</h3><span class="sub">${rows.length} active goalies faced · ${H.seasons.length} seasons</span></div>
    <div class="panel-b" style="display:grid;gap:12px">
      ${nm ? `<div class="goalie-card">${avatar(nextGk, "sm")}<div style="min-width:0"><small class="dim">NEXT OPPOSING GOALIE · ${esc(t && t.next ? probLabel(t.next.opp).toUpperCase() : "")}</small><br><b>${esc(nextGk.name)}</b> (${nextGk.team}) · ${nm.gp} GP · ${nm.g}G ${nm.a}A on ${nm.sog} shots ${confChip(nm.conf)}</div>
        <div style="text-align:right"><small class="dim">P(goal) · P(point)</small><br><b class="num">${pct(nm.pGoal)} · ${pct(nm.pPoint)}</b></div></div>` : ""}
      <div class="tbl-wrap"><table class="tbl" style="min-width:560px"><thead><tr><th class="l">Goalie</th><th>GP</th><th>Shots</th><th>G</th><th>A</th><th>Sh%</th><th>Duel</th><th class="l">Confidence</th></tr></thead>
      <tbody>${top.map((m) => `<tr data-g="${m.gid}"><td class="l">${esc(goalieName(m.gid))}</td><td>${m.gp}</td><td>${m.sog}</td><td><b>${m.g}</b></td><td>${m.a}</td><td>${m.shVs != null ? pct(m.shVs) : "–"}</td><td>${factorCell(m.pairG)}</td><td class="l">${confChip(m.conf)}</td></tr>`).join("") || `<tr><td colspan="8"><div class="empty">No history.</div></td></tr>`}</tbody></table></div>
      <a href="#vsgoalie" class="vs-link">Open the player vs goalie explorer →</a>
    </div></section>`;
}

/* ------------------------------------------------------------------ KALSHI */
const KAL = () => D.kalshi || { games: {}, players: {} };
function kGame(gid) { return KAL().games[gid] || null; }
/* precios de jugador solo de partidos que no habían empezado al leer Kalshi (en juego el precio ya no es comparable) */
function kPlayer(pid) {
  const p = KAL().players[pid];
  if (!p) return null;
  const g = D.schedule.find((x) => x.id === p.game);
  return g && !["FUT", "PRE"].includes(g.state) ? null : p;
}
function kMarket(pid, kind, line = 1) { const p = kPlayer(pid); return p && p[kind] ? p[kind].find((m) => m.line === line) || null : null; }
/* para MOSTRAR precios: también los de partidos ya empezados (precio en juego al momento de leer Kalshi) */
function kPlayerAny(pid) { return KAL().players[pid] || null; }
function kMarketAny(pid, kind, line = 1) { const p = kPlayerAny(pid); return p && p[kind] ? p[kind].find((m) => m.line === line) || null : null; }
function kLive(pid) { const p = kPlayerAny(pid); const g = p && D.schedule.find((x) => x.id === p.game); return !!(g && !["FUT", "PRE"].includes(g.state)); }
function kPriceTag(pid, kind, gid) {
  const p = kPlayerAny(pid), m = kMarketAny(pid, kind, 1);
  if (!m || !p || (gid && p.game !== gid) || m.ask == null) return "";
  const live = kLive(pid);
  return `<small class="kal-price${live ? " kal-live" : ""}" title="${live ? "Kalshi Yes price with the game in progress" : "Kalshi Yes price before the game"} · ${kalshiFetchedLbl()}">${live ? "● " : ""}K ${cents(m.ask)}</small>`;
}
function kUrl(gid, kind = "game") { const g = kGame(gid); return g ? g.links[kind] : null; }
function kalshiLink(url) {
  return url ? `<a class="kal-link" href="${esc(url)}" target="_blank" rel="noopener" title="Open the game on Kalshi">Kalshi</a>` : "";
}
/* enlace al próximo partido del equipo en Kalshi (mismo enlace para todos sus jugadores) */
/* partido actual del equipo: el que está en juego ahora o, si no, el siguiente.
   Se calcula con la hora real del visitante, así sigue siendo correcto aunque los datos tengan horas. */
function currentGame(team) {
  const now = Date.now();
  return D.schedule.filter((g) => (g.away === team || g.home === team) && g.start)
    .sort((a, b) => a.start.localeCompare(b.start))
    .find((g) => now < new Date(g.start).getTime() + 4 * 3600e3) || null;
}
function teamKalshiUrl(team) {
  const g = currentGame(team);
  if (g) return kUrl(g.id, "game");
  const t = TEAM[team];
  return t && t.next ? kUrl(t.next.id, "game") : null;
}
function kLink(team) { return kalshiLink(teamKalshiUrl(team)); }
const cents = (x) => (x == null ? "–" : Math.round(x * 100) + "¢");
function edgeCell(ours, ask) {
  if (ours == null || ask == null || ask <= 0) return `<span class="dim">–</span>`;
  const d = Math.round((ours - ask) * 100);
  const cls = d >= 4 ? "edge-pos" : d <= -4 ? "edge-neg" : "edge-flat";
  return `<span class="edge ${cls}" title="Our probability minus the Kalshi Yes price">${d > 0 ? "+" : ""}${d} pts</span>`;
}
/* la mejor probabilidad que tenemos: con portero rival y su historial si está cargado */
function bestProb(s, opp) {
  const gk = H && !H.error && opp ? probableGoalie(opp) : null;
  return gk ? matchup(s, gk.id) : projFor(s, opp);
}
function kalshiFetchedLbl() { const t = KAL().fetchedAt; return t ? new Date(t).toLocaleString("en-US", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "–"; }

/* panel de Kalshi en la ficha del jugador */
function playerKalshiBlock(s) {
  const t = TEAM[s.team];
  const nx = t && t.next;
  if (!nx) return "";
  const cg = currentGame(s.team);
  const gameId = cg ? cg.id : nx.id;
  const kp = kPlayerAny(s.id);
  const sameGame = kp && kp.game === gameId;
  const live = kLive(s.id);
  const gLink = kUrl(gameId, "game");
  if (!sameGame) {
    return `<div class="kal-box"><div>${kalshiLink(gLink)} <span class="dim">· player prices appear once Kalshi opens his markets (usually on game day).</span></div></div>`;
  }
  const pr = bestProb(s, nx.opp);
  const rows = [
    ["1+ goal", kMarketAny(s.id, "goal", 1), pr.pGoal, "goal"],
    ["2+ goals", kMarketAny(s.id, "goal", 2), null, "goal"],
    ["1+ point", kMarketAny(s.id, "pts", 1), pr.pPoint, "pts"],
    ["2+ points", kMarketAny(s.id, "pts", 2), null, "pts"],
    ["1+ assist", kMarketAny(s.id, "ast", 1), pr.pAssist ?? null, "ast"],
  ].filter((r) => r[1]).map((r) => (live ? [r[0], r[1], null, r[3]] : r));
  return `<div class="kal-box" style="display:grid;gap:8px">
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:baseline"><b>Markets</b> ${kalshiLink(gLink)}<span class="dim" style="font-size:12px">${live ? `<b class="kal-live">● game in progress</b> · prices as of ${kalshiFetchedLbl()}, not comparable with our pre-game probability` : `prices as of ${kalshiFetchedLbl()} · the link opens the live price`}</span></div>
    <div class="tbl-wrap"><table class="tbl" style="min-width:560px"><thead><tr><th class="l">Market</th><th>Buy Yes</th><th>Sell Yes</th><th title="Includes the probable opposing goalie and his history against him">Our prob.*</th><th>Edge</th></tr></thead>
    <tbody>${rows.map(([lbl, m, ours, kind]) => `<tr style="cursor:default"><td class="l">${lbl}</td><td><b>${cents(m.ask)}</b></td><td>${cents(m.bid)}</td><td>${ours != null ? pct(ours) : `<span class="dim">–</span>`}</td><td>${ours != null ? edgeCell(ours, m.ask) : `<span class="dim">–</span>`}</td></tr>`).join("")}</tbody></table></div>
    <div class="dim" style="font-size:11.5px">* Adjusted for the probable opposing goalie and the player's history against him, so it can differ slightly from the rings above.</div>
    
  </div>`;
}
function goalieKalshiBlock(g) {
  const t = TEAM[g.team];
  const nx = t && t.next;
  if (!nx) return "";
  const kp = kPlayer(g.id);
  const lines = kp && kp.game === nx.id && kp.save ? kp.save : [];
  const avgSa = g.gp ? g.sa / g.gp : 0;
  return `<div class="kal-box" style="display:grid;gap:8px"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:baseline"><b>Saves</b> ${kalshiLink(kUrl(nx.id, "game"))}<span class="dim" style="font-size:12px">Average shots faced: ${f1(avgSa)} per game · prices as of ${kalshiFetchedLbl()}</span></div>
    ${lines.length ? `<div class="legend">${lines.map((m) => `<span class="chip f-flat">${m.line}+ saves · ${cents(m.ask)}</span>`).join("")}</div>` : `<span class="dim">No saves market open yet for his next game.</span>`}
    </div>`;
}
/* jugadores con mayor diferencia a favor frente a Kalshi */
function kalshiValue(kind, n = 12) {
  const out = [];
  D.schedule.forEach((g) => [[g.away, g.home], [g.home, g.away]].forEach(([team, opp]) => {
    activeSk().filter((s) => s.team === team && s.gp >= 8 && missedGames(s) < 1).forEach((s) => {
      const kp = kPlayer(s.id);
      if (!kp || kp.game !== g.id) return;
      const m = kMarket(s.id, kind === "pGoal" ? "goal" : "pts", 1);
      if (!m || !m.ask) return;
      const pr = bestProb(s, opp);
      out.push({ s, g, opp, m, ours: pr[kind], conf: pr.conf, edge: pr[kind] - m.ask, kind });
    });
  }));
  return out.sort((a, b) => b.edge - a.edge).slice(0, n);
}
function kalshiValuePanel() {
  if (!Object.keys(KAL().players).length) return "";
  const list = (title, arr, kind) => `<section class="panel"><div class="panel-h"><h3>${title}</h3><span class="sub">Prices as of ${kalshiFetchedLbl()}</span></div><div class="panel-b">
    <div class="tbl-wrap"><table class="tbl" style="min-width:600px"><thead><tr><th class="l">Player</th><th class="l">Game</th><th>Ours</th><th>Kalshi Yes</th><th>Edge</th><th class="l"></th></tr></thead>
    <tbody>${arr.map((x) => `<tr data-p="${x.s.id}"><td class="l"><span class="pl">${avatar(x.s, "sm")}<b>${esc(x.s.name)}</b> ${chipMini(x.s.form)}</span></td><td class="l">${x.g.away} @ ${x.g.home}</td>
      <td class="pct">${pct(x.ours)}</td><td><b>${cents(x.m.ask)}</b></td><td>${edgeCell(x.ours, x.m.ask)}</td><td class="l">${kalshiLink(kUrl(x.g.id, "game"))}</td></tr>`).join("") || `<tr><td colspan="6"><div class="empty">No open markets.</div></td></tr>`}</tbody></table></div></div></section>`;
  return `<div class="grid g2">${list("Value vs Kalshi · 1+ goal", kalshiValue("pGoal"), "goal")}${list("Value vs Kalshi · 1+ point", kalshiValue("pPoint"), "pts")}</div>
    <p class="chart-note" style="margin:-8px 0 0">Edge = our probability − the Yes price. <span class="edge edge-pos">+4 pts or more</span> our model sees a higher chance than the market; <span class="edge edge-neg">−4 or less</span> the market sees more. Excludes Kalshi fees and confirmed lineups.</p>`;
}

/* ------------------------------------------------------------------ ANALISTA */
const MARKETS = {
  goal:   { label: "Goal",       long: "1+ goal",        key: "pGoal",   k: "goal", floor: 0.18, base: 0.20, cls: "mk-goal" },
  point:  { label: "Point",      long: "1+ point",            key: "pPoint",  k: "pts",  floor: 0.40, base: 0.45, cls: "mk-point" },
  assist: { label: "Assist",     long: "1+ assist",       key: "pAssist", k: "ast",  floor: 0.28, base: 0.32, cls: "mk-assist" },
};
const ana = { date: null };

function slateDates() {
  const now = Date.now();
  return [...new Set(D.schedule.filter((g) => !g.start || now < new Date(g.start).getTime() + 4 * 3600e3).map((g) => g.date))].sort();
}

/* evalúa un jugador en un partido: mejor mercado, puntuación y razones */
function analyzePlayer(s, g, opp) {
  const gk = probableGoalie(opp, g);
  const m = H && !H.error && gk ? matchup(s, gk.id) : { s, ...projFor(s, opp), sog: 0 };
  const kp = kPlayer(s.id);
  const sameGame = kp && kp.game === g.id;
  const formBonus = { hot: 3, up: 1.5, flat: 0, down: -2, cold: -4 }[s.form] || 0;
  let best = null;
  for (const [id, mk] of Object.entries(MARKETS)) {
    const p = m[mk.key];
    if (p == null || p < mk.floor) continue;
    const km = sameGame ? kMarket(s.id, mk.k, 1) : null;
    const ask = km && km.ask ? km.ask : null;
    const edge = ask != null ? p - ask : null;
    if (ask != null && edge < 0.02) continue;          // con precio: solo si hay valor
    let score = ask != null ? edge * 100 + p * 8 : Math.min(8, (p - mk.base) * 25);
    score += formBonus;
    if (m.conf === "high" && m.pairG > 1.1 && id === "goal") score += 2;
    if (m.gf > 1.06) score += 1.5;
    if (m.gf < 0.94) score -= 1.5;
    if (!best || score > best.score) best = { id, mk, p, ask, edge, score };
  }
  if (!best) return null;
  return { s, g, opp, gk, m, ...best, reasons: reasonsFor(s, m, gk, best) };
}

function reasonsFor(s, m, gk, b) {
  const r = [];
  if (b.ask != null) r.push(`<b>Value:</b> our ${pct(b.p)} vs ${cents(b.ask)} on Kalshi (${b.edge >= 0 ? "+" : ""}${Math.round(b.edge * 100)} pts).`);
  else r.push(`<b>Probability:</b> ${pct(b.p)} for ${b.mk.long.toLowerCase()} (no Kalshi price for this player yet).`);
  if (s.form === "hot") r.push(`🔥 Hot${s.pStreak >= 3 ? `: ${s.pStreak}-game point streak` : ""} · L5 ${s.l5.g}G ${s.l5.a}A.`);
  else if (s.form === "up") r.push(`▲ Improving: playing above his average (L5 ${s.l5.g}G ${s.l5.a}A).`);
  else r.push(`Last 10: ${s.l10.g}G ${s.l10.a}A, ${s.l10.sog} shots.`);
  if (gk && m.sog >= 5) r.push(`Vs ${esc(gk.name)}: ${m.g}G ${m.a}A on ${m.sog} shots (${m.gp} GP)${m.pairG >= 1.1 ? " · favorable history" : m.pairG <= 0.9 ? " · tough history" : ""}.`);
  if (gk && m.gf && H && !H.error) {
    const sv3 = goalieFactor(gk.id).sv;
    const svTxt = `SV% ${sv3 != null ? f3(sv3) : "–"} over 3 seasons, ${f3(gk.svPct)} this season`;
    if (m.gf >= 1.05) r.push(`Opposing goalie ${esc(gk.name)} allows more than average (${svTxt}).`);
    else if (m.gf <= 0.95) r.push(`Careful: ${esc(gk.name)} is an above-average goalie (${svTxt}).`);
  }
  if (s.toi5 - s.toi >= 1) r.push(`More ice time: ${mmss(s.toi5)} over the last 5 (+${mmss(s.toi5 - s.toi)}).`);
  if (s.gp && s.ppp / s.gp >= 0.25 && b.id !== "goal") r.push(`Power-play role: ${s.ppp} power-play points.`);
  if (b.id === "goal" && s.gp && s.sog / s.gp >= 3) r.push(`High shot volume: ${f1(s.sog / s.gp)} shots per game.`);
  return r.slice(0, 5);
}

function rating(x) {
  if (x.ask != null) return x.edge >= 0.06 ? ["Strong", "rt-strong"] : x.edge >= 0.035 ? ["Good", "rt-good"] : ["Moderate", "rt-mod"];
  return x.score >= 6 ? ["Good", "rt-good"] : ["Moderate", "rt-mod"];
}

function teamPicks(team, opp, g) {
  const cands = activeSk().filter((s) => s.team === team && s.gp >= 8 && s.log.length && missedGames(s) === 0 && daysSince(s.log[s.log.length - 1][0]) <= 12)
    .map((s) => analyzePlayer(s, g, opp)).filter(Boolean).sort((a, b) => b.score - a.score);
  if (!cands.length) return [];
  const picks = [cands[0]];
  const second = cands[1];
  if (second && (second.ask != null ? second.edge >= 0.03 : second.score >= 3)) picks.push(second);
  return picks;
}

function pickCard(x) {
  const [rl, rc] = rating(x);
  return `<article class="pickc" data-p="${x.s.id}">
    <div class="pickc-h">${avatar(x.s)}<div style="min-width:0"><div class="nm">${esc(x.s.name)} ${kLink(x.s.team)}</div>
      <div class="dim" style="font-size:12px">${POS[x.s.pos] || x.s.pos} · ${x.s.gp} GP · ${x.s.g}G ${x.s.a}A ${x.s.p}P ${chipMini(x.s.form)}</div></div>
      <span class="rt ${rc}">${rl}</span></div>
    <div class="pickc-m"><span class="mk ${x.mk.cls}">${x.mk.long}</span>
      <span class="pickc-p num">${pct(x.p)}</span>
      ${x.ask != null ? `<span class="dim num" style="font-size:12px">Kalshi ${cents(x.ask)}</span> ${edgeCell(x.p, x.ask)}` : `<span class="dim" style="font-size:12px">no price yet</span>`}</div>
    <ul class="why">${x.reasons.map((t) => `<li>${t}</li>`).join("")}</ul>
  </article>`;
}

function viewAnalyst(app) {
  const dates = slateDates();
  if (!ana.date || !dates.includes(ana.date)) ana.date = dates[0] || null;
  const now = Date.now();
  const dayGames = D.schedule.filter((g) => g.date === ana.date);
  const started = dayGames.filter((g) => g.start && now >= new Date(g.start).getTime());
  const games = dayGames.filter((g) => !started.includes(g));
  const all = [];
  const blocks = games.map((g) => {
    const a = teamPicks(g.away, g.home, g), h = teamPicks(g.home, g.away, g);
    all.push(...a, ...h);
    const side = (team, opp, picks) => `<div class="ana-side"><div class="ana-team">${teamBadge(team, true)} <span class="dim" style="font-size:12px">vs ${esc(probableGoalie(opp, g)?.name || opp)}</span></div>
      ${picks.length ? picks.map(pickCard).join("") : `<div class="empty" style="padding:14px">No value pick: no player beats the market price or our minimums.</div>`}</div>`;
    return `<section class="panel"><div class="panel-h"><h3>${g.away} @ ${g.home}</h3><span class="sub">${g.start ? tLocal(g.start) : ""} · ${esc(g.venue || "")}</span><span class="right" style="display:flex;gap:12px">${kalshiLink(kUrl(g.id, "game"))}${nhlLink(g.link || gameUrl(g.away, g.home, false, g.date, g.id), "NHL.com")}</span></div>
      <div class="panel-b"><div class="ana-grid">${side(g.away, g.home, a)}${side(g.home, g.away, h)}</div></div></section>`;
  });
  const top = all.slice().sort((x, y) => y.score - x.score).slice(0, 5);
  app.innerHTML = `<div class="view">
    <section class="panel"><div class="panel-b" style="display:grid;gap:10px">
      <div style="font-size:13px;color:var(--fg-2)">The analyst reviews every player on each team and picks <b>1 or 2 candidates</b> with their best market (goal, point or assist). It uses our calibrated probability against the probable goalie, form, history against that goalie, ice time and, when available, the Kalshi price: with a price it only recommends when our probability beats the market by 2+ points. Players who missed their team's last game are excluded.</div>
      <div class="seg" id="ana-date">${dates.map((d) => `<button type="button" data-d="${d}" aria-pressed="${d === ana.date}">${dShort(d)}</button>`).join("")}</div>
      <div class="legend"><span class="rt rt-strong">Strong</span> +6 pts or more over Kalshi <span class="rt rt-good">Good</span> +3.5 to +6 <span class="rt rt-mod">Moderate</span> +2 to +3.5 · without a Kalshi price, "Good" at most, based on probability and form</div>
    </div></section>
    ${top.length ? `<section class="panel"><div class="panel-h"><h2>Top 5 of the day</h2><span class="sub">${dLong(ana.date)} · ${games.length} games still to start</span></div>
      <div class="panel-b"><div class="ana-top">${top.map(pickCard).join("")}</div></div></section>` : ""}
    ${started.length ? `<section class="panel"><div class="panel-b" style="font-size:13px;color:var(--fg-2)">Already started (no picks): ${started.map((g) => `${g.away} @ ${g.home} ${kalshiLink(kUrl(g.id, "game"))}`).join(" · ")}</div></section>` : ""}
    ${blocks.join("") || `<section class="panel"><div class="empty">No games left to start on this date. Pick another day above.</div></section>`}
    <p class="chart-note">These are statistical picks, not guarantees. Check lineups and confirmed goalies before the game; Kalshi prices are as of ${kalshiFetchedLbl()}.</p>
  </div>`;
  if (!H) app.querySelector(".view").insertAdjacentHTML("afterbegin", `<div class="loading" style="padding:10px;font-size:14px">Loading player vs goalie history… picks will sharpen in a moment.</div>`);
  bindOpeners(app);
  $("#ana-date").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { ana.date = b.dataset.d; route(); } });
}

/* ---------------- LIVE MODE: Kalshi prices through the radar-live Cloudflare Worker ---------------- */
const PROXY = "https://radar-live.kenneth-tp.workers.dev";
const LIVE = { on: false, last: null, err: null, busy: false, ticks: 0 };
const LIVE_SERIES = ["KXNHLGOAL", "KXNHLPTS", "KXNHLAST", "KXNHLSAVE", "KXNHLGAME"];
async function liveMarkets(series) {
  let all = [], cursor = "";
  for (let i = 0; i < 4; i++) {
    const r = await fetch(PROXY + "/kalshi/markets?series_ticker=" + series + "&status=open&limit=1000" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json(); all = all.concat(d.markets || []); cursor = d.cursor;
    if (!cursor || !(d.markets || []).length) break;
  }
  return all;
}
async function liveTick(manual) {
  if (LIVE.busy || !D.kalshi) return;
  LIVE.busy = true; paintLive("updating…");
  try {
    const byTicker = new Map();
    for (const s of LIVE_SERIES) (await liveMarkets(s)).forEach((m) => byTicker.set(m.ticker, m));
    const num = (x) => (x == null || x === "" ? null : Math.round(parseFloat(x) * 10000) / 10000);
    let n = 0;
    Object.values(D.kalshi.players).forEach((p) => ["goal", "pts", "ast", "save"].forEach((k) => (p[k] || []).forEach((m) => {
      const x = byTicker.get(m.ticker); if (x) { m.ask = num(x.yes_ask_dollars); m.bid = num(x.yes_bid_dollars); n++; }
    })));
    Object.values(D.kalshi.games).forEach((g) => Object.values(g.win || {}).forEach((w) => {
      const x = byTicker.get(w.ticker); if (x) { w.ask = num(x.yes_ask_dollars); w.bid = num(x.yes_bid_dollars); }
    }));
    D.kalshi.fetchedAt = new Date().toISOString();
    LIVE.on = true; LIVE.err = null; LIVE.last = Date.now(); LIVE.ticks++; LIVE.n = n;
    if ($("#modal").hidden && !document.activeElement?.matches?.("input, select")) route();
  } catch (e) { LIVE.err = String(e.message || e); }
  finally { LIVE.busy = false; paintLive(); }
}
function paintLive(msg) {
  const el = $("#live-st"); if (!el) return;
  if (msg) { el.textContent = msg; return; }
  if (LIVE.err && !LIVE.on) { el.textContent = "snapshot only"; el.title = "Live prices unavailable here: " + LIVE.err; return; }
  const s = LIVE.last ? Math.round((Date.now() - LIVE.last) / 1000) : null;
  el.innerHTML = `<span class="kal-live">●</span> Live prices · ${s == null ? "–" : s < 60 ? s + " s ago" : Math.round(s / 60) + " min ago"}`;
}
function startLive() {
  $("#meta").insertAdjacentHTML("afterbegin", `<span id="live-st">connecting…</span><button class="theme-btn" id="refresh-btn" type="button">Refresh</button>`);
  $("#refresh-btn").addEventListener("click", () => liveTick(true));
  liveTick(true);
  setInterval(() => { if (!document.hidden) liveTick(false); }, 30000);
  setInterval(paintLive, 1000);
}

boot();
