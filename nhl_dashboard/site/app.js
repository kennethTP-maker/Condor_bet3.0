/* Condor NHL Radar — interfaz. Lee data/nhl.json (generado a diario por fetch_nhl.py). */
"use strict";

const DATA_URL = "data/nhl.json";
const FORM = {
  hot:  { label: "En racha",   icon: "🔥", cls: "f-hot",  v: "--hot" },
  up:   { label: "Mejorando",  icon: "▲",  cls: "f-up",   v: "--up" },
  flat: { label: "Estable",    icon: "●",  cls: "f-flat", v: "--flat" },
  down: { label: "Empeorando", icon: "▼",  cls: "f-down", v: "--down" },
  cold: { label: "Frío",       icon: "❄",  cls: "f-cold", v: "--cold" },
};
const POS = { C: "C", L: "LW", R: "RW", D: "D", G: "G" };
const VIEWS = ["resumen", "jugadores", "porteros", "equipos", "partidos", "metodo"];

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
const dShort = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("es", { day: "2-digit", month: "short" });
const dLong = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" });
const tLocal = (utc) => (utc ? new Date(utc).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" }) : "");
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
  return `<span class="div-bar" title="Tendencia ${v}"><i style="left:${left}%;width:${w}%;background:${col}"></i></span> <span class="num ${v >= 0 ? "pos" : "neg"}" style="display:inline-block;width:34px;text-align:right">${v > 0 ? "+" : ""}${v}</span>`;
}
function spark(log) {
  const last = log.slice(-10);
  return `<span class="spark" title="Puntos últimos ${last.length} partidos (dorado = gol, azul = asistencia)">` +
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
        { label: "Rango (máx/mín)", data: candles.map((c) => [c[3], c[2]]), backgroundColor: isUp.map((u) => (u ? up : dn)), barThickness: 2, grouped: false, order: 2 },
        { label: "Apertura→Cierre", data: body, backgroundColor: isUp.map((u) => (u ? up : dn)), borderRadius: 3, barPercentage: 0.55, categoryPercentage: 0.9, grouped: false, order: 1 },
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
            title: (it) => "Semana del " + dLong(candles[it[0].dataIndex][0]),
            label: (it) => {
              const c = candles[it.dataIndex];
              return [`Apertura ${fmt(c[1])}  ·  Cierre ${fmt(c[4])}`, `Máximo ${fmt(c[2])}  ·  Mínimo ${fmt(c[3])}`, `Cambio ${sgn(c[4] - c[1])}`];
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
    $("#app").innerHTML = `<div class="panel"><div class="empty">No se pudo cargar <code>${DATA_URL}</code>. Ejecuta <code>python nhl_dashboard/fetch_nhl.py</code> para generar los datos.</div></div>`;
    return;
  }
  D.teams.forEach((t) => (TEAM[t.abbr] = t));
  D.skaters.forEach((s) => (s.kind = "S"));
  D.goalies.forEach((g) => (g.kind = "G"));
  const gen = new Date(D.generatedAt);
  const next = new Date(gen.getTime() + 24 * 3600 * 1000);
  $("#season-lbl").textContent = `Temporada regular ${D.seasonLabel}`;
  $("#meta").innerHTML = `
    <span><span class="live-dot" aria-hidden="true"></span>Actualizado <b>${gen.toLocaleString("es", { dateStyle: "medium", timeStyle: "short" })}</b></span>
    <span>Último partido <b>${D.lastGameDate ? dShort(D.lastGameDate) : "–"}</b></span>
    <span>Próxima actualización <b>${next.toLocaleString("es", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</b></span>
    <button class="theme-btn" id="theme-btn" type="button">Tema</button>`;
  $("#theme-btn").addEventListener("click", toggleTheme);
  window.addEventListener("hashchange", route);
  route();
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
  let v = (location.hash || "#resumen").slice(1);
  if (!VIEWS.includes(v)) v = "resumen";
  document.querySelectorAll(".tab").forEach((a) => a.setAttribute("aria-current", a.getAttribute("href") === "#" + v ? "page" : "false"));
  destroy(charts);
  const app = $("#app");
  ({ resumen: viewSummary, jugadores: viewPlayers, porteros: viewGoalies, equipos: viewTeams, partidos: viewGames, metodo: viewMethod })[v](app);
}

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
    ["hot", "En racha", "Rinden muy por encima de su propio nivel (últimos 5–10 partidos) o con 4+ partidos seguidos sumando puntos.", pick("hot", (a, b) => b.trend - a.trend)],
    ["up", "Mejorando", "Su media reciente sube respecto a la temporada.", pick("up", (a, b) => b.trend - a.trend)],
    ["down", "Empeorando", "Su media reciente cae respecto a la temporada.", pick("down", (a, b) => a.trend - b.trend)],
    ["cold", "Fríos", "Caída fuerte o 5+ partidos sin puntos siendo un jugador productivo.", pick("cold", (a, b) => a.trend - b.trend)],
  ];
  const today = D.schedule.filter((g) => g.date === D.schedule[0]?.date);
  const goalieTop = activeGo().filter((g) => g.gp >= 5).slice(0, 5);

  app.innerHTML = `<div class="view">
    <section class="kpis" aria-label="Resumen de la liga">
      <div class="kpi"><div class="lbl">Jugadores activos</div><div class="val">${sk.length + activeGo().length}</div><div class="hint">${sk.length} de campo · ${activeGo().length} porteros</div></div>
      <div class="kpi"><div class="lbl">Partidos analizados</div><div class="val">${D.gamesCounted}</div><div class="hint">Temporada ${D.seasonLabel}</div></div>
      <div class="kpi"><div class="lbl">Goles por equipo/partido</div><div class="val">${f2(D.league.goalsPerTeamGame)}</div><div class="hint">Promedio de la liga</div></div>
      <div class="kpi"><div class="lbl">% paradas liga</div><div class="val">${f3(D.league.svPct)}</div><div class="hint">% tiro ${pct(D.league.shPct)}</div></div>
      <div class="kpi"><div class="lbl">Partidos hoy</div><div class="val">${today.length}</div><div class="hint">${today[0] ? dLong(today[0].date) : "Sin partidos"}</div></div>
    </section>

    <section class="panel">
      <div class="panel-h"><h2>Termómetro de forma</h2><span class="sub">${nReg} jugadores con 8+ partidos</span></div>
      <div class="panel-b">
        <div style="display:flex;height:16px;border-radius:8px;overflow:hidden;gap:2px" role="img" aria-label="Distribución de forma">
          ${["hot", "up", "flat", "down", "cold"].map((f) => `<div title="${FORM[f].label}: ${counts[f]}" style="flex:${counts[f]};background:var(${FORM[f].v})"></div>`).join("")}
        </div>
        <div class="legend" style="margin-top:10px">${["hot", "up", "flat", "down", "cold"].map((f) => `${chip(f)} <span class="num" style="margin-right:8px">${counts[f]} · ${Math.round((100 * counts[f]) / nReg)}%</span>`).join("")}</div>
      </div>
    </section>

    <div class="grid g-main">
      <section class="panel">
        <div class="panel-h"><h2>Candidatos más fuertes</h2><span class="sub">Índice de Fuerza 0–100 · temporada + últimos 10 + minutos</span><a class="right" href="#jugadores" style="font-size:12px">Ver todos →</a></div>
        <div class="panel-b"><div class="cands">${top.map((s, i) => candCard(s, i + 1)).join("")}</div></div>
      </section>
      <section class="panel">
        <div class="panel-h"><h2>Mapa de forma</h2><span class="sub">Temporada vs últimos 5 (IMP/partido)</span></div>
        <div class="panel-b"><div class="chart-box tall"><canvas id="scatter" aria-label="Dispersión de forma"></canvas></div>
        <p class="chart-note">Sobre la diagonal = rinde por encima de su media. Toca un punto para abrir la ficha.</p></div>
      </section>
    </div>

    <div class="grid g4">
      ${lists.map(([f, title, desc, arr]) => `
      <section class="panel top-${f}">
        <div class="panel-h trend-head"><h3>${chip(f)}</h3><span class="count">${arr.length ? "Top " + arr.length : ""}</span></div>
        <div class="panel-b"><p class="dim" style="margin:0 0 8px;font-size:12px">${desc}</p>
          <div class="tlist">${arr.length ? arr.map((s) => trendRow(s)).join("") : `<div class="empty">Nadie en este grupo ahora.</div>`}</div>
        </div>
      </section>`).join("")}
    </div>

    <div class="grid g2">
      <section class="panel">
        <div class="panel-h"><h2>Partidos de hoy</h2><span class="sub">Mejor candidato a gol por equipo</span><a class="right" href="#partidos" style="font-size:12px">Semana completa →</a></div>
        <div class="panel-b">${today.length ? `<div class="tlist">${today.map(todayRow).join("")}</div>` : `<div class="empty">No hay partidos programados hoy.</div>`}</div>
      </section>
      <section class="panel">
        <div class="panel-h"><h2>Porteros más fuertes</h2><span class="sub">Goles salvados sobre la media (GSAA)</span><a class="right" href="#porteros" style="font-size:12px">Ver todos →</a></div>
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
  ds.push({ type: "line", label: "Igual a su media", data: [{ x: 0, y: 0 }, { x: max, y: max }], borderColor: css("--fg-3"), borderDash: [4, 4], borderWidth: 1, pointRadius: 0 });
  mkChart($("#scatter"), {
    type: "scatter", data: { datasets: ds },
    options: baseOpts({
      interaction: { mode: "nearest", intersect: true },
      onClick: (e, els) => { const el = els[0]; if (el) { const p = ds[el.datasetIndex].data[el.index].s; if (p) openPlayer(p.id); } },
      plugins: { ...baseOpts().plugins, legend: { ...baseOpts().plugins.legend, position: "bottom" },
        tooltip: { ...baseOpts().plugins.tooltip, callbacks: { label: (it) => { const s = it.raw.s; return s ? `${s.name} (${s.team}) · temp ${f2(s.imp)} → L5 ${f2(s.imp5)}` : ""; } } } },
      scales: { x: { ...baseOpts().scales.x, min: 0, title: { display: true, text: "IMP/partido temporada", color: css("--fg-3") } },
        y: { ...baseOpts().scales.y, min: 0, title: { display: true, text: "IMP/partido últimos 5", color: css("--fg-3") } } },
    }),
  });
}

function candCard(s, rank) {
  return `<button class="cand" data-p="${s.id}" type="button">
    ${avatar(s)}
    <span style="min-width:0"><div class="nm"><span class="rank">${rank}</span>${esc(s.name)}</div>
      <div class="sub">${teamBadge(s.team)} ${POS[s.pos] || s.pos} · ${s.p} P en ${s.gp}</div>
      <div class="sub" style="margin-top:3px">${chip(s.form)}</div></span>
    <span class="score"><b class="num">${Math.round(s.power)}</b><small>Fuerza</small></span></button>`;
}
function trendRow(s) {
  const d = s.imp5 - s.imp;
  return `<button class="trow" data-p="${s.id}" type="button">${avatar(s, "sm")}
    <span><div class="nm">${esc(s.name)}</div><div class="sub">${esc(s.team)} · L5: ${s.l5.g}G ${s.l5.a}A · ${s.pStreak >= 2 ? s.pStreak + " seguidos con punto" : s.dryStreak >= 2 ? s.dryStreak + " sin punto" : "temp " + s.p + " P"}</div></span>
    ${spark(s.log)}<span class="delta ${d >= 0 ? "pos" : "neg"}" title="Cambio IMP L5 vs temporada">${sgn(d)}</span></button>`;
}
function todayRow(g) {
  const best = (ab, opp) => bestFor(ab, opp, "pGoal", 1)[0];
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
  return { pGoal: scaleP(s.proj.pGoal), pPoint: scaleP(s.proj.pPoint), g: s.proj.g * r, p: s.proj.p * r, sog: s.proj.sog, oppF: f };
}
function bestFor(team, opp, key, n) {
  return activeSk().filter((s) => s.team === team && s.gp >= 5 && s.log.length && daysSince(s.log[s.log.length - 1][0]) <= 12)
    .map((s) => ({ s, ...projFor(s, opp) })).sort((a, b) => b[key] - a[key]).slice(0, n);
}
function daysSince(iso) { return (new Date(D.generatedAt) - new Date(iso + "T12:00:00Z")) / 864e5; }

/* ------------------------------------------------------------------ JUGADORES */
const COLS = [
  ["name", "Jugador", "l"], ["team", "Eq", "l"], ["pos", "Pos", "l"], ["gp", "PJ"], ["g", "G"], ["a", "A"], ["p", "P"],
  ["ptsPg", "P/PJ"], ["sog", "Tiros"], ["shPct", "%Tiro"], ["toi", "TOI"], ["pm", "+/-"], ["ppp", "PPP"], ["hit", "Golpes"], ["blk", "Bloq"],
  ["l5p", "P L5"], ["spark", "Últ. 10", "l"], ["trend", "Tendencia", "l"], ["form", "Forma", "l"], ["power", "Fuerza", "l"], ["pGoal", "P(gol)"], ["pPoint", "P(punto)"],
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
    <div class="panel-h"><h2>Jugadores de campo</h2><span class="sub" id="pl-count"></span></div>
    <div class="panel-b" style="display:grid;gap:14px">
      <div class="filters">
        <label class="fld">Buscar<input type="search" id="f-q" placeholder="Nombre…" value="${esc(state.q)}"></label>
        <label class="fld">Equipo<select id="f-team"><option value="">Todos</option>${teams.map((t) => `<option ${t === state.team ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        <div class="fld">Posición<div class="seg" id="f-pos">${[["all", "Todas"], ["F", "Delanteros"], ["C", "C"], ["L", "LW"], ["R", "RW"], ["D", "Defensas"]].map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${state.pos === v}">${l}</button>`).join("")}</div></div>
        <label class="fld">Forma<select id="f-form"><option value="all">Todas</option>${Object.entries(FORM).map(([k, f]) => `<option value="${k}" ${state.form === k ? "selected" : ""}>${f.icon} ${f.label}</option>`).join("")}</select></label>
        <label class="fld">Mín. PJ <input type="number" id="f-gp" min="0" max="82" value="${state.minGp}" style="width:72px"></label>
        <label class="fld" style="flex-direction:row;display:flex;gap:6px;align-items:center;text-transform:none;letter-spacing:0;font-size:12.5px;color:var(--fg-2)"><input type="checkbox" id="f-inact" ${state.inactive ? "checked" : ""}> Incluir no activos</label>
      </div>
      <div class="legend">${Object.keys(FORM).map((f) => chip(f)).join("")} <span class="dim">· Últ. 10: barra dorada = marcó gol, azul = solo asistencia, gris = sin punto</span></div>
      <div class="tbl-wrap"><table class="tbl" id="pl-tbl"><thead><tr>${COLS.map(([k, l, a]) => `<th class="${a || ""}" data-k="${k}" ${state.sort === k ? `aria-sort="${state.dir < 0 ? "descending" : "ascending"}"` : ""}>${l}</th>`).join("")}</tr></thead><tbody></tbody></table></div>
      <div class="pager"><span id="pg-lbl"></span><button type="button" id="pg-prev">Anterior</button><button type="button" id="pg-next">Siguiente</button></div>
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
  $("#pl-tbl tbody").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-p]"); if (tr) openPlayer(+tr.dataset.p); });
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
  $("#pl-count").textContent = `${rows.length} jugadores`;
  $("#pg-lbl").textContent = `Página ${state.page + 1} de ${pages}`;
  $("#pg-prev").disabled = state.page === 0;
  $("#pg-next").disabled = state.page >= pages - 1;
  $("#pl-tbl tbody").innerHTML = slice.length ? slice.map((s) => `<tr data-p="${s.id}">
    <td class="l"><span class="pl">${avatar(s, "sm")}<b>${esc(s.name)}</b>${s.active ? "" : ' <span class="dim">(no activo)</span>'}</span></td>
    <td class="l">${teamBadge(s.team)}</td><td class="l">${POS[s.pos] || s.pos}</td>
    <td>${s.gp}</td><td>${s.g}</td><td>${s.a}</td><td><b>${s.p}</b></td><td>${f2(s.ptsPg)}</td><td>${s.sog}</td><td>${pct(s.shPct)}</td>
    <td>${mmss(s.toi)}</td><td class="${s.pm > 0 ? "pos" : s.pm < 0 ? "neg" : ""}">${s.pm > 0 ? "+" : ""}${s.pm}</td><td>${s.ppp}</td><td>${s.hit}</td><td>${s.blk}</td>
    <td>${s.l5.p}</td><td class="l">${spark(s.log)}</td><td class="l">${divBar(s.trend)}</td><td class="l">${chip(s.form)}</td><td class="l">${powerMeter(s.power)}</td>
    <td class="pct">${pct(s.proj.pGoal)}</td><td class="pct">${pct(s.proj.pPoint)}</td></tr>`).join("")
    : `<tr><td colspan="${COLS.length}" class="l"><div class="empty">Ningún jugador cumple esos filtros.</div></td></tr>`;
}

/* ------------------------------------------------------------------ PORTEROS */
const GCOLS = [["name", "Portero", "l"], ["team", "Eq", "l"], ["gp", "PJ"], ["gs", "Tit."], ["w", "V"], ["l", "D"], ["otl", "DP"], ["svPct", "SV%"], ["gaa", "GAA"],
  ["so", "SO"], ["sa", "Tiros rec."], ["gsaa", "GSAA"], ["svPct5", "SV% L5"], ["gsaa5", "GSAA L5"], ["trend", "Tendencia", "l"], ["form", "Forma", "l"], ["power", "Fuerza", "l"]];
function viewGoalies(app) {
  app.innerHTML = `<div class="view"><section class="panel">
    <div class="panel-h"><h2>Porteros</h2><span class="sub">GSAA = goles salvados sobre un portero medio con los mismos tiros (liga ${f3(D.league.svPct)})</span></div>
    <div class="panel-b" style="display:grid;gap:14px">
      <div class="filters"><label class="fld">Buscar<input type="search" id="g-q" value="${esc(state.gq)}" placeholder="Nombre…"></label>
      <label class="fld">Mín. PJ <input type="number" id="g-min" value="${state.gmin}" min="0" style="width:72px"></label></div>
      <div class="tbl-wrap"><table class="tbl" id="g-tbl" style="min-width:1050px"><thead><tr>${GCOLS.map(([k, l, a]) => `<th class="${a || ""}" data-k="${k}" ${state.gsort === k ? `aria-sort="${state.gdir < 0 ? "descending" : "ascending"}"` : ""}>${l}</th>`).join("")}</tr></thead><tbody></tbody></table></div>
    </div></section>
    <section class="panel"><div class="panel-h"><h2>Calidad vs volumen</h2><span class="sub">SV% de temporada frente a tiros recibidos</span></div>
      <div class="panel-b"><div class="chart-box"><canvas id="g-scatter"></canvas></div></div></section></div>`;
  const draw = () => {
    const q = state.gq.toLowerCase();
    const rows = activeGo().filter((g) => g.gp >= state.gmin && (!q || g.name.toLowerCase().includes(q)));
    const k = state.gsort, dir = state.gdir;
    rows.sort((a, b) => { let x = k === "form" ? FORM_ORDER[a.form] : a[k], y = k === "form" ? FORM_ORDER[b.form] : b[k]; if (x == null) return 1; if (y == null) return -1; return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir; });
    $("#g-tbl tbody").innerHTML = rows.map((g) => `<tr data-g="${g.id}">
      <td class="l"><span class="pl">${avatar(g, "sm")}<b>${esc(g.name)}</b></span></td><td class="l">${teamBadge(g.team)}</td>
      <td>${g.gp}</td><td>${g.gs}</td><td>${g.w}</td><td>${g.l}</td><td>${g.otl}</td><td><b>${f3(g.svPct)}</b></td><td>${f2(g.gaa)}</td><td>${g.so}</td><td>${g.sa}</td>
      <td class="${g.gsaa >= 0 ? "pos" : "neg"}">${sgn(g.gsaa, 1)}</td><td>${f3(g.svPct5)}</td><td class="${g.gsaa5 >= 0 ? "pos" : "neg"}">${sgn(g.gsaa5, 1)}</td>
      <td class="l">${divBar(g.trend)}</td><td class="l">${chip(g.form)}</td><td class="l">${powerMeter(g.power)}</td></tr>`).join("") || `<tr><td colspan="17"><div class="empty">Sin resultados.</div></td></tr>`;
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
  $("#g-tbl tbody").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-g]"); if (tr) openGoalie(+tr.dataset.g); });
  draw();
  const gs = activeGo().filter((g) => g.gp >= 5);
  const ds = ["hot", "up", "flat", "down", "cold"].map((f) => ({ label: FORM[f].label, data: gs.filter((g) => g.form === f).map((g) => ({ x: g.sa, y: g.svPct, g })),
    backgroundColor: css(FORM[f].v), borderColor: css("--panel"), borderWidth: 1, pointRadius: 5, pointHoverRadius: 8 }));
  ds.push({ type: "line", label: "Media liga", data: [{ x: 0, y: D.league.svPct }, { x: Math.max(...gs.map((g) => g.sa)), y: D.league.svPct }], borderColor: css("--fg-3"), borderDash: [4, 4], borderWidth: 1, pointRadius: 0 });
  mkChart($("#g-scatter"), { type: "scatter", data: { datasets: ds }, options: baseOpts({
    interaction: { mode: "nearest", intersect: true },
    onClick: (e, els) => { const el = els[0]; if (el) { const g = ds[el.datasetIndex].data[el.index].g; if (g) openGoalie(g.id); } },
    plugins: { ...baseOpts().plugins, legend: { ...baseOpts().plugins.legend, position: "bottom" }, tooltip: { ...baseOpts().plugins.tooltip, callbacks: { label: (it) => it.raw.g ? `${it.raw.g.name} (${it.raw.g.team}) · ${f3(it.raw.g.svPct)} en ${it.raw.g.sa} tiros` : "" } } },
    scales: { x: { ...baseOpts().scales.x, title: { display: true, text: "Tiros recibidos", color: css("--fg-3") } }, y: { ...baseOpts().scales.y, title: { display: true, text: "SV%", color: css("--fg-3") }, ticks: { ...baseOpts().scales.y.ticks, callback: (v) => f3(v) } } },
  }) });
}

/* ------------------------------------------------------------------ EQUIPOS */
function viewTeams(app) {
  const divs = {};
  D.teams.forEach((t) => (divs[t.div] = divs[t.div] || []).push(t));
  Object.values(divs).forEach((a) => a.sort((x, y) => x.divRank - y.divRank));
  const order = ["Atlantic", "Metropolitan", "Central", "Pacific"].filter((d) => divs[d]).concat(Object.keys(divs).filter((d) => !["Atlantic", "Metropolitan", "Central", "Pacific"].includes(d)));
  app.innerHTML = `<div class="view">
    <section class="panel"><div class="panel-h"><h2>Diferencial de goles por equipo</h2><span class="sub">Temporada · ordenado por clasificación de liga</span></div>
      <div class="panel-b"><div class="chart-box"><canvas id="t-diff"></canvas></div></div></section>
    <div class="div-grid">${order.map((d) => `<section class="panel"><div class="panel-h"><h2>División ${esc(d)}</h2><span class="sub">${esc(divs[d][0].conf)}</span></div>
      <div class="panel-b"><div class="tbl-wrap"><table class="tbl" style="min-width:640px"><thead><tr>
        <th class="l">#</th><th class="l">Equipo</th><th>PJ</th><th>V-D-DP</th><th>PTS</th><th>P%</th><th>GF</th><th>GC</th><th>DIF</th><th class="l">Últimos 10</th><th>Racha</th><th class="l">Próximo</th></tr></thead>
        <tbody>${divs[d].map((t) => `<tr data-t="${t.abbr}">
          <td class="l">${t.divRank}</td><td class="l">${teamBadge(t.abbr)}</td><td>${t.gp}</td><td>${t.w}-${t.l}-${t.otl}</td><td><b>${t.pts}</b></td><td>${f3(t.ptsPct)}</td>
          <td>${t.gf}</td><td>${t.ga}</td><td class="${t.gf - t.ga >= 0 ? "pos" : "neg"}">${sgn(t.gf - t.ga, 0)}</td>
          <td class="l"><span class="st-res" title="${t.l10.w}-${t.l10.l}-${t.l10.otl}">${t.games.slice(-10).map((g) => `<i class="${g[4]}" title="${dShort(g[0])} ${g[5] ? "vs" : "@"} ${g[1]} ${g[2]}-${g[3]} ${g[4]}"></i>`).join("")}</span> <span class="dim">${t.l10.w}-${t.l10.l}-${t.l10.otl}</span></td>
          <td>${esc(t.streak)}</td><td class="l">${t.next ? `${t.next.home ? "vs" : "@"} ${esc(t.next.opp)} · ${dShort(t.next.date)}` : "–"}</td></tr>`).join("")}</tbody></table></div></div></section>`).join("")}
    </div>
    <div class="legend"><span class="st-res"><i class="W"></i></span> Victoria <span class="st-res"><i class="OTL"></i></span> Derrota en prórroga/penales <span class="st-res"><i class="L"></i></span> Derrota</div>
  </div>`;
  app.querySelectorAll("tr[data-t]").forEach((tr) => tr.addEventListener("click", () => openTeam(tr.dataset.t)));
  const ts = D.teams;
  mkChart($("#t-diff"), { type: "bar", data: { labels: ts.map((t) => t.abbr), datasets: [{ label: "DIF", data: ts.map((t) => t.gf - t.ga),
    backgroundColor: ts.map((t) => (t.gf - t.ga >= 0 ? css("--candle-up") : css("--candle-down"))), borderRadius: 4, barPercentage: 0.7 }] },
    options: baseOpts({ onClick: (e, els) => { if (els[0]) openTeam(ts[els[0].index].abbr); }, plugins: { ...baseOpts().plugins, legend: { display: false },
      tooltip: { ...baseOpts().plugins.tooltip, callbacks: { label: (it) => { const t = ts[it.dataIndex]; return `${t.name}: ${t.gf} GF / ${t.ga} GC (${sgn(t.gf - t.ga, 0)}) · ${t.pts} pts`; } } } } }) });
}

/* ------------------------------------------------------------------ PARTIDOS */
function viewGames(app) {
  const byDate = {};
  D.schedule.forEach((g) => (byDate[g.date] = byDate[g.date] || []).push(g));
  const dates = Object.keys(byDate).sort();
  app.innerHTML = `<div class="view">
    <section class="panel"><div class="panel-b" style="font-size:13px;color:var(--fg-2)">
      Para cada partido: los 4 jugadores con mayor probabilidad estimada de marcar (P gol) y de sumar al menos un punto (P punto), ajustada a la defensa del rival.
      Son estimaciones estadísticas, no certezas. Compáralas con la cuota implícita de tu casa de apuestas antes de decidir.</div></section>
    ${dates.length ? dates.map((d) => `<section class="panel"><div class="panel-h"><h2 style="text-transform:capitalize">${dLong(d)}</h2><span class="sub">${byDate[d].length} partidos</span></div>
      <div class="panel-b"><div class="games">${byDate[d].map(gameCard).join("")}</div></div></section>`).join("") : `<section class="panel"><div class="empty">No hay partidos en el calendario de esta semana.</div></section>`}
  </div>`;
  bindOpeners(app);
}
function gameCard(g) {
  const col = (ab, opp) => {
    const goal = bestFor(ab, opp, "pGoal", 4), point = bestFor(ab, opp, "pPoint", 4);
    const goalie = activeGo().filter((x) => x.team === ab && x.log.length).sort((a, b) => b.log[b.log.length - 1][0].localeCompare(a.log[a.log.length - 1][0]) || b.gs - a.gs)[0];
    const pk = (x, k) => `<button class="pick" data-p="${x.s.id}" type="button"><span>${esc(x.s.name)} ${x.s.form === "hot" ? "🔥" : x.s.form === "cold" ? "❄" : ""}</span><b class="num">${pct(x[k])}</b></button>`;
    const t = TEAM[ab];
    return `<div style="min-width:0"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">${teamBadge(ab)}<span class="dim num" style="font-size:12px">${t ? `${t.w}-${t.l}-${t.otl} · L10 ${t.l10.w}-${t.l10.l}-${t.l10.otl}` : ""}</span></div>
      <h4>P(gol)</h4>${goal.map((x) => pk(x, "pGoal")).join("")}
      <h4 style="margin-top:8px">P(punto)</h4>${point.map((x) => pk(x, "pPoint")).join("")}
      ${goalie ? `<h4 style="margin-top:8px">Último portero titular</h4><button class="pick" data-g="${goalie.id}" type="button"><span>${esc(goalie.name)} ${chipMini(goalie.form)}</span><b class="num">${f3(goalie.svPct)}</b></button>` : ""}</div>`;
  };
  const live = g.state !== "FUT" && g.state !== "PRE";
  return `<article class="game"><div class="game-h">${teamBadge(g.away, true)}<span class="vs">@</span>${teamBadge(g.home, true)}
    <span class="time">${live ? `<b class="num">${g.awayScore ?? 0} – ${g.homeScore ?? 0}</b><br>${g.state === "OFF" || g.state === "FINAL" ? "Final" : "En juego"}` : `<b>${tLocal(g.start)}</b><br>${esc(g.venue || "")}`}</span></div>
    <div class="game-cols">${col(g.away, g.home)}${col(g.home, g.away)}</div></article>`;
}
function chipMini(f) { const x = FORM[f] || FORM.flat; return `<span style="color:var(${x.v})" title="${x.label}">${x.icon}</span>`; }

/* ------------------------------------------------------------------ MÉTODO */
function viewMethod(app) {
  const W = D.weights;
  app.innerHTML = `<div class="view"><section class="panel"><div class="panel-b method">
    <h3>Fuentes</h3>
    <p>Todos los números provienen de las APIs públicas oficiales de la NHL (las mismas que alimentan NHL.com). No hay datos inventados ni estimados a mano:</p>
    <ul>${D.sources.map((s) => `<li><code>${esc(s)}</code></li>`).join("")}</ul>
    <p>Se descargan las estadísticas <b>partido por partido</b> de cada jugador (${D.gamesCounted} partidos de la temporada ${D.seasonLabel}) y todo lo demás se calcula a partir de ellas. "Activo" significa que el jugador figura hoy en la plantilla oficial de su equipo; un jugador traspasado aparece en su equipo actual.</p>
    <h3>Actualización cada 24 horas</h3>
    <p>Una tarea programada de GitHub Actions ejecuta <code>nhl_dashboard/fetch_nhl.py</code> cada día a las 10:17 UTC (cuando ya terminaron todos los partidos de la noche en Norteamérica), guarda el nuevo <code>data/nhl.json</code> y publica la página. Última generación: <b>${new Date(D.generatedAt).toLocaleString("es")}</b>.</p>
    <h3>Índice de Impacto (IMP) por partido</h3>
    <p>Una nota por partido estilo "game score", construida solo con estadísticas oficiales:</p>
    <p><code>IMP = ${W.g}·G + ${W.a}·A + ${W.sog}·Tiros + ${W.blk}·Bloqueos + ${W.hit}·Golpes + ${W.tk}·Robos ${W.gv}·Pérdidas + ${W.pm}·(+/-) + ${W.ppp}·Puntos en PP</code></p>
    <p>Media de liga: delanteros ${f2(D.league.impBaseF)}, defensas ${f2(D.league.impBaseD)} por partido.</p>
    <h3>Tendencia y forma</h3>
    <p>La <b>tendencia</b> (−100 a +100) compara la media de IMP de los últimos 5 partidos (60%) y últimos 10 (40%) contra la media del propio jugador en la temporada, dividido por su variabilidad normal, y suma la pendiente de los últimos 10 partidos. Así se mide si el jugador está mejor o peor que <i>su propio</i> nivel.</p>
    <ul>
      <li>${chip("hot")} tendencia ≥ +55, o 4+ partidos seguidos sumando punto.</li>
      <li>${chip("up")} tendencia entre +20 y +55.</li>
      <li>${chip("flat")} entre −20 y +20.</li>
      <li>${chip("down")} entre −55 y −20 (o un jugador con racha de puntos activa pero por debajo de su media).</li>
      <li>${chip("cold")} tendencia ≤ −55, o 5+ partidos sin punto siendo un jugador de 0,45+ puntos por partido.</li>
    </ul>
    <p>Con menos de 5 partidos jugados todos se marcan como Estable.</p>
    <h3>Índice de Fuerza (0–100)</h3>
    <p>Percentil dentro de la liga que combina: 55% IMP por partido en la temporada (contraído hacia la media si jugó pocos partidos), 30% IMP de los últimos 10 y 15% tiempo en hielo. Para porteros: 55% GSAA por partido, 30% GSAA de los últimos 5 y 15% titularidades.</p>
    <h3>Velas</h3>
    <p>Cada vela es una semana (lunes a domingo). El "precio" del jugador empieza en 100 y en cada partido sube o baja según cuánto superó la media de su posición (IMP − media liga). Verde = semana en la que su precio subió; rojo = bajó. La mecha marca el máximo y el mínimo alcanzado durante esa semana. En porteros el precio es su GSAA acumulado, y en equipos los puntos acumulados por encima de un ritmo de 1 punto por partido.</p>
    <h3>Probabilidades P(gol) y P(punto)</h3>
    <p>Para el siguiente partido: tasa de tiros (50% temporada, 30% últimos 10, 20% últimos 5) × % de tiro contraído hacia la media de liga (${pct(D.league.shPct)}) con 80 tiros de peso, ajustado por los goles que recibe el rival (±20% máx.) y por el cambio reciente de minutos. La probabilidad final mezcla 50% modelo de Poisson y 50% frecuencia real de partidos en los que el jugador marcó o sumó punto.</p>
    <p><b>Importante:</b> son estimaciones estadísticas para ordenar candidatos, no garantías. No tienen en cuenta lesiones del día, alineaciones confirmadas ni cuotas. Valídalas siempre antes de apostar.</p>
  </div></section></div>`;
}

/* ------------------------------------------------------------------ MODALES */
function bindOpeners(root) {
  root.querySelectorAll("[data-p]").forEach((el) => el.addEventListener("click", (e) => { e.stopPropagation(); openPlayer(+el.dataset.p); }));
  root.querySelectorAll("[data-g]").forEach((el) => el.addEventListener("click", (e) => { e.stopPropagation(); openGoalie(+el.dataset.g); }));
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
        <div class="facts">${teamBadge(s.team, true)} <span>#${s.num ?? "–"}</span><span>${POS[s.pos] || s.pos}</span><span>${s.age ? s.age + " años" : ""}</span><span>${s.shoots ? "Tira " + (s.shoots === "L" ? "izq." : "der.") : ""}</span>${chip(s.form)}</div></div>
      <button class="close" type="button" aria-label="Cerrar">×</button></div>

    <div class="statline">
      ${statCell("PJ", s.gp)}${statCell("Goles", s.g)}${statCell("Asist.", s.a)}${statCell("Puntos", s.p)}${statCell("P/PJ", f2(s.ptsPg))}
      ${statCell("Tiros", s.sog)}${statCell("% tiro", pct(s.shPct))}${statCell("TOI", mmss(s.toi))}${statCell("+/-", (s.pm > 0 ? "+" : "") + s.pm)}${statCell("PPP", s.ppp)}
      ${statCell("Golpes", s.hit)}${statCell("Bloqueos", s.blk)}
    </div>
    <div class="statline">
      ${statCell("Fuerza", s.power != null ? Math.round(s.power) : "–")}${statCell("Tendencia", (s.trend > 0 ? "+" : "") + s.trend)}
      ${statCell("IMP temp.", f2(s.imp))}${statCell("IMP L10", f2(s.imp10), s.imp10 - s.imp)}${statCell("IMP L5", f2(s.imp5), s.imp5 - s.imp)}
      ${statCell("L5 G-A-P", `${s.l5.g}-${s.l5.a}-${s.l5.p}`)}${statCell("L10 G-A-P", `${s.l10.g}-${s.l10.a}-${s.l10.p}`)}
      ${statCell("TOI L5", mmss(s.toi5), s.toi5 - s.toi)}${statCell("Racha punto", s.pStreak)}${statCell("Sin punto", s.dryStreak)}
    </div>

    <section class="panel"><div class="panel-h"><h3>Próximo partido</h3><span class="sub">${nx ? `${nx.home ? "vs" : "@"} ${esc(TEAM[nx.opp]?.name || nx.opp)} · ${nx.start ? new Date(nx.start).toLocaleString("es", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) : dLong(nx.date)}` : "Sin partido programado esta semana"}</span></div>
      <div class="panel-b"><div class="proj">
        <div><span class="ring" style="--p:${Math.round(pj.pGoal * 100)}"><span>${pct(pj.pGoal)}</span></span><small>P(marcar gol)</small><b class="num">${pct(pj.pGoal)}</b></div>
        <div><span class="ring" style="--p:${Math.round(pj.pPoint * 100)}"><span>${pct(pj.pPoint)}</span></span><small>P(1+ punto)</small><b class="num">${pct(pj.pPoint)}</b></div>
        <div><small>Goles esperados</small><b class="num">${f2(pj.g)}</b></div>
        <div><small>Puntos esperados</small><b class="num">${f2(pj.p)}</b></div>
        <div><small>Tiros esperados</small><b class="num">${f1(pj.sog)}</b></div>
        <div><small>Factor rival</small><b class="num">${f2(pj.oppF)}</b><div class="dim" style="font-size:11.5px">&gt;1 = rival concede más que la media</div></div>
      </div></div></section>

    <section class="panel"><div class="panel-h"><h3>Velas semanales de rendimiento</h3><span class="sub">Precio inicia en 100 · sube si supera la media de su posición</span></div>
      <div class="panel-b"><div class="chart-box"><canvas id="m-candle"></canvas></div>
      <div class="legend" style="margin-top:8px"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--candle-up)"></span> Semana al alza <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--candle-down);margin-left:10px"></span> Semana a la baja</div></div></section>

    <div class="grid g2">
      <section class="panel"><div class="panel-h"><h3>Goles y asistencias por partido</h3></div><div class="panel-b"><div class="chart-box short"><canvas id="m-pts"></canvas></div></div></section>
      <section class="panel"><div class="panel-h"><h3>Impacto por partido</h3><span class="sub">Barras = IMP · línea = media móvil 5</span></div><div class="panel-b"><div class="chart-box short"><canvas id="m-imp"></canvas></div></div></section>
      <section class="panel"><div class="panel-h"><h3>Tiros a puerta</h3><span class="sub">Media temp. ${f2(s.sog / s.gp)}</span></div><div class="panel-b"><div class="chart-box short"><canvas id="m-sog"></canvas></div></div></section>
      <section class="panel"><div class="panel-h"><h3>Tiempo en hielo (min)</h3><span class="sub">Media L10 ${mmss(toi10)}</span></div><div class="panel-b"><div class="chart-box short"><canvas id="m-toi"></canvas></div></div></section>
    </div>

    <section class="panel"><div class="panel-h"><h3>Últimos 10 partidos</h3></div><div class="panel-b"><div class="tbl-wrap"><table class="tbl" style="min-width:640px">
      <thead><tr><th class="l">Fecha</th><th class="l">Rival</th><th>G</th><th>A</th><th>P</th><th>Tiros</th><th>TOI</th><th>+/-</th><th>Golpes</th><th>Bloq</th><th>PPP</th><th>IMP</th></tr></thead>
      <tbody>${recent.map((r) => `<tr style="cursor:default"><td class="l">${dShort(r[0])}</td><td class="l">${r[2] ? "vs" : "@"} ${esc(r[1])}</td><td>${r[3]}</td><td>${r[4]}</td><td><b>${r[5]}</b></td><td>${r[6]}</td><td>${mmss(r[7])}</td>
        <td class="${r[8] > 0 ? "pos" : r[8] < 0 ? "neg" : ""}">${r[8] > 0 ? "+" : ""}${r[8]}</td><td>${r[9]}</td><td>${r[10]}</td><td>${r[11]}</td><td class="${r[12] >= s.imp ? "pos" : "neg"}">${f2(r[12])}</td></tr>`).join("")}</tbody></table></div></div></section>
  `, () => {
    candleChart($("#m-candle"), s.candles, { bucket: modalCharts, yLabel: "Precio" });
    const labels = L.map((r) => dShort(r[0]));
    const tip = (it) => { const r = L[it[0].dataIndex]; return `${dShort(r[0])} ${r[2] ? "vs" : "@"} ${r[1]}`; };
    const o = (extra = {}) => { const b = baseOpts(); b.plugins.tooltip.callbacks = { title: tip }; return Object.assign(b, extra); };
    const optsStack = o(); optsStack.scales.x.stacked = true; optsStack.scales.y.stacked = true; optsStack.scales.y.ticks.stepSize = 1;
    mkChart($("#m-pts"), { type: "bar", data: { labels, datasets: [
      { label: "Goles", data: L.map((r) => r[3]), backgroundColor: css("--gold"), borderRadius: 3, borderColor: css("--panel"), borderWidth: { top: 2 } },
      { label: "Asistencias", data: L.map((r) => r[4]), backgroundColor: css("--accent"), borderRadius: 3 }] }, options: optsStack }, modalCharts);
    mkChart($("#m-imp"), { type: "bar", data: { labels, datasets: [
      { type: "line", label: "Media móvil 5", data: rolling(L.map((r) => r[12]), 5), borderColor: css("--hot"), borderWidth: 2, pointRadius: 0, tension: 0.3, order: 0 },
      { type: "line", label: "Media temporada", data: L.map(() => s.imp), borderColor: css("--fg-3"), borderDash: [4, 4], borderWidth: 1, pointRadius: 0, order: 0 },
      { label: "IMP", data: L.map((r) => r[12]), backgroundColor: L.map((r) => (r[12] >= s.imp ? css("--candle-up") : css("--candle-down")) + "99"), borderRadius: 3, order: 1 }] }, options: o() }, modalCharts);
    mkChart($("#m-sog"), { type: "bar", data: { labels, datasets: [
      { type: "line", label: "Media móvil 5", data: rolling(L.map((r) => r[6]), 5), borderColor: css("--hot"), borderWidth: 2, pointRadius: 0, tension: 0.3 },
      { label: "Tiros", data: L.map((r) => r[6]), backgroundColor: css("--cold") + "aa", borderRadius: 3 }] }, options: o() }, modalCharts);
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
      <div><h2 id="sheet-title">${esc(g.name)}</h2><div class="facts">${teamBadge(g.team, true)} <span>#${g.num ?? "–"}</span><span>Portero</span><span>${g.age ? g.age + " años" : ""}</span>${chip(g.form)}</div></div>
      <button class="close" type="button" aria-label="Cerrar">×</button></div>
    <div class="statline">${statCell("PJ", g.gp)}${statCell("Titular", g.gs)}${statCell("V-D-DP", `${g.w}-${g.l}-${g.otl}`)}${statCell("SV%", f3(g.svPct))}${statCell("GAA", f2(g.gaa))}
      ${statCell("SO", g.so)}${statCell("GSAA", sgn(g.gsaa, 1))}${statCell("SV% L5", f3(g.svPct5))}${statCell("GSAA L5", sgn(g.gsaa5, 1))}${statCell("Fuerza", g.power != null ? Math.round(g.power) : "–")}${statCell("Tendencia", (g.trend > 0 ? "+" : "") + g.trend)}</div>
    <section class="panel"><div class="panel-h"><h3>Velas semanales · GSAA acumulado</h3><span class="sub">Sube cuando para más de lo esperado</span></div><div class="panel-b"><div class="chart-box"><canvas id="m-candle"></canvas></div></div></section>
    <div class="grid g2">
      <section class="panel"><div class="panel-h"><h3>SV% por partido</h3><span class="sub">Línea discontinua = media liga</span></div><div class="panel-b"><div class="chart-box short"><canvas id="m-sv"></canvas></div></div></section>
      <section class="panel"><div class="panel-h"><h3>GSAA por partido</h3></div><div class="panel-b"><div class="chart-box short"><canvas id="m-gsaa"></canvas></div></div></section>
    </div>
    <section class="panel"><div class="panel-h"><h3>Últimos 10 partidos</h3></div><div class="panel-b"><div class="tbl-wrap"><table class="tbl" style="min-width:560px">
      <thead><tr><th class="l">Fecha</th><th class="l">Rival</th><th>Dec.</th><th>Tiros</th><th>Paradas</th><th>GC</th><th>SV%</th><th>TOI</th><th>GSAA</th></tr></thead>
      <tbody>${L.slice(-10).reverse().map((r) => `<tr style="cursor:default"><td class="l">${dShort(r[0])}</td><td class="l">${r[2] ? "vs" : "@"} ${esc(r[1])}</td><td>${r[8]}</td><td>${r[3]}</td><td>${r[4]}</td><td>${r[5]}</td><td>${f3(r[6])}</td><td>${mmss(r[7])}</td><td class="${r[9] >= 0 ? "pos" : "neg"}">${sgn(r[9])}</td></tr>`).join("")}</tbody></table></div></div></section>
  `, () => {
    candleChart($("#m-candle"), g.candles, { bucket: modalCharts, yLabel: "GSAA acumulado" });
    const labels = L.map((r) => dShort(r[0]));
    const o = () => { const b = baseOpts(); b.plugins.tooltip.callbacks = { title: (it) => { const r = L[it[0].dataIndex]; return `${dShort(r[0])} ${r[2] ? "vs" : "@"} ${r[1]} · ${r[3]} tiros`; } }; return b; };
    const sv = o(); sv.scales.y.ticks.callback = (v) => f3(v);
    mkChart($("#m-sv"), { type: "line", data: { labels, datasets: [
      { label: "SV%", data: L.map((r) => r[6]), borderColor: css("--accent"), pointBackgroundColor: L.map((r) => (r[6] >= D.league.svPct ? css("--candle-up") : css("--candle-down"))), pointRadius: 4, borderWidth: 2, tension: 0.2 },
      { label: "Media liga", data: L.map(() => D.league.svPct), borderColor: css("--fg-3"), borderDash: [4, 4], borderWidth: 1, pointRadius: 0 }] }, options: sv }, modalCharts);
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
      <div><h2 id="sheet-title">${esc(t.name)}</h2><div class="facts"><span>${esc(t.div)} · ${t.divRank}º división · ${t.leagueRank}º liga</span><span>Racha ${esc(t.streak)}</span></div></div>
      <button class="close" type="button" aria-label="Cerrar">×</button></div>
    <div class="statline">${statCell("PJ", t.gp)}${statCell("V-D-DP", `${t.w}-${t.l}-${t.otl}`)}${statCell("Puntos", t.pts)}${statCell("P%", f3(t.ptsPct))}${statCell("GF/PJ", f2(t.gfpg))}${statCell("GC/PJ", f2(t.gapg))}
      ${statCell("Casa", t.home)}${statCell("Fuera", t.road)}${statCell("L10", `${t.l10.w}-${t.l10.l}-${t.l10.otl}`)}</div>
    <section class="panel"><div class="panel-h"><h3>Velas semanales · puntos sobre ritmo .500</h3><span class="sub">+1 por victoria, 0 por derrota en prórroga, −1 por derrota</span></div><div class="panel-b"><div class="chart-box"><canvas id="m-candle"></canvas></div></div></section>
    <section class="panel"><div class="panel-h"><h3>Goles a favor y en contra por partido</h3></div><div class="panel-b"><div class="chart-box short"><canvas id="m-gfga"></canvas></div></div></section>
    <section class="panel"><div class="panel-h"><h3>Plantilla por Fuerza</h3><span class="sub">${roster.length} jugadores de campo · ${gls.length} porteros</span></div>
      <div class="panel-b"><div class="tlist">${roster.map((s) => `<button class="trow" data-p="${s.id}" type="button" style="grid-template-columns:28px minmax(0,1fr) auto auto">${avatar(s, "sm")}
        <span><div class="nm">${esc(s.name)} <span class="dim">${POS[s.pos] || s.pos}</span></div><div class="sub">${s.gp} PJ · ${s.g}G ${s.a}A ${s.p}P · L5 ${s.l5.p}P</div></span>${chip(s.form)}<span class="num" style="width:34px;text-align:right;font-weight:700">${s.power != null ? Math.round(s.power) : "–"}</span></button>`).join("")}
      ${gls.map((g) => `<button class="trow" data-g="${g.id}" type="button" style="grid-template-columns:28px minmax(0,1fr) auto auto">${avatar(g, "sm")}<span><div class="nm">${esc(g.name)} <span class="dim">G</span></div><div class="sub">${g.gp} PJ · SV% ${f3(g.svPct)} · GSAA ${sgn(g.gsaa, 1)}</div></span>${chip(g.form)}<span class="num" style="width:34px;text-align:right;font-weight:700">${g.power != null ? Math.round(g.power) : "–"}</span></button>`).join("")}</div></div></section>
  `, () => {
    candleChart($("#m-candle"), t.candles, { bucket: modalCharts, yLabel: "Puntos sobre .500", fmt: (v) => String(Math.round(v)) });
    const G = t.games;
    const b = baseOpts(); b.plugins.tooltip.callbacks = { title: (it) => { const r = G[it[0].dataIndex]; return `${dShort(r[0])} ${r[5] ? "vs" : "@"} ${r[1]} · ${r[2]}-${r[3]} ${r[4]}`; } };
    mkChart($("#m-gfga"), { type: "bar", data: { labels: G.map((r) => dShort(r[0])), datasets: [
      { label: "Goles a favor", data: G.map((r) => r[2]), backgroundColor: css("--candle-up"), borderRadius: 3 },
      { label: "Goles en contra", data: G.map((r) => r[3]), backgroundColor: css("--candle-down"), borderRadius: 3 }] }, options: b }, modalCharts);
  }, () => openTeam(ab));
}

boot();
