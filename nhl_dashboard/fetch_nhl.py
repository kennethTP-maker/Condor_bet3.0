#!/usr/bin/env python3
"""
NHL Radar — descarga diaria de datos oficiales de la NHL y cálculo de tendencias.

Fuentes (APIs públicas oficiales de la NHL, sin clave):
  * https://api-web.nhle.com/v1/standings/now          -> clasificación por equipo
  * https://api-web.nhle.com/v1/roster/{TEAM}/current  -> plantillas activas (foto, dorsal, edad)
  * https://api-web.nhle.com/v1/schedule/now           -> próximos partidos
  * https://api.nhle.com/stats/rest/en/skater/summary  -> stats de jugadores por partido
  * https://api.nhle.com/stats/rest/en/skater/realtime -> golpes, bloqueos, robos, pérdidas por partido
  * https://api.nhle.com/stats/rest/en/goalie/summary  -> porteros por partido

Solo usa la biblioteca estándar de Python 3.9+.
Uso:  python nhl_dashboard/fetch_nhl.py [--season 20262027] [--out nhl_dashboard/site/data/nhl.json]
"""
from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

WEB = "https://api-web.nhle.com/v1"
STATS = "https://api.nhle.com/stats/rest/en"
PAGE = 100  # el endpoint de stats devuelve como máximo 100 filas por página
UA = {"User-Agent": "nhl-radar/1.0", "Accept": "application/json"}

# --------------------------------------------------------------------------- HTTP


def get_json(url: str, tries: int = 5):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # red inestable / 429 / 5xx
            last = e
            time.sleep(1.5 * (2 ** i))
    raise RuntimeError(f"Fallo al descargar {url}: {last}")


def id_key(report: str) -> str:
    return "teamId" if report.startswith("team/") else "playerId"


def stats_url(report: str, cayenne: str, start: int, game: bool) -> str:
    k = id_key(report)
    sort = json.dumps([{"property": "gameId", "direction": "ASC"},
                       {"property": k, "direction": "ASC"}] if game else
                      [{"property": k, "direction": "ASC"}])
    q = {
        "isAggregate": "false",
        "isGame": "true" if game else "false",
        "start": str(start),
        "limit": str(PAGE),
        "sort": sort,
        "cayenneExp": cayenne,
    }
    return f"{STATS}/{report}?" + urllib.parse.urlencode(q, quote_via=urllib.parse.quote)


def fetch_all(report: str, cayenne: str, game: bool, pool: ThreadPoolExecutor) -> list[dict]:
    first = get_json(stats_url(report, cayenne, 0, game))
    total = first.get("total", 0)
    rows = list(first.get("data", []))
    starts = list(range(PAGE, total, PAGE))
    for page in pool.map(lambda s: get_json(stats_url(report, cayenne, s, game)), starts):
        rows.extend(page.get("data", []))
    # quitar duplicados (por paginación con datos cambiando)
    seen, out = set(), []
    for r in rows:
        k = (r.get("gameId"), r.get(id_key(report)))
        if k not in seen:
            seen.add(k)
            out.append(r)
    return out


def fetch_games(report: str, season: str, start_d: date, end_d: date, pool) -> list[dict]:
    """Stats por partido en tramos de 14 días (cada tramo se pagina)."""
    rows, d = [], start_d
    while d <= end_d:
        e = d + timedelta(days=14)
        cay = (f'seasonId={season} and gameTypeId=2 and gameDate>="{d.isoformat()}" '
               f'and gameDate<"{e.isoformat()}"')
        rows.extend(fetch_all(report, cay, True, pool))
        d = e
    return rows


# --------------------------------------------------------------------------- utilidades


def r2(x, n=2):
    return None if x is None else round(float(x), n)


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else 0.0


def slope(ys):
    """Pendiente de regresión lineal simple (por partido)."""
    n = len(ys)
    if n < 3:
        return 0.0
    mx = (n - 1) / 2
    my = sum(ys) / n
    num = sum((i - mx) * (y - my) for i, y in enumerate(ys))
    den = sum((i - mx) ** 2 for i in range(n))
    return num / den if den else 0.0


def percentile_map(values: dict, reverse=False) -> dict:
    """id -> percentil 0..100"""
    items = sorted(values.items(), key=lambda kv: kv[1], reverse=reverse)
    n = len(items)
    if n <= 1:
        return {k: 50.0 for k, _ in items}
    return {k: 100.0 * i / (n - 1) for i, (k, _) in enumerate(items)}


def age_from(birth: str | None, today: date) -> int | None:
    if not birth:
        return None
    b = date.fromisoformat(birth)
    return today.year - b.year - ((today.month, today.day) < (b.month, b.day))


def poisson_at_least_one(lam: float) -> float:
    return 1.0 - math.exp(-max(lam, 0.0))


# Índice de Impacto por partido (IMP), estilo "game score" con datos públicos.
W = dict(g=0.75, a=0.65, sog=0.075, blk=0.05, hit=0.025, tk=0.05, gv=-0.03, pm=0.10, ppp=0.10)


def skater_imp(g):
    return (W["g"] * g["g"] + W["a"] * g["a"] + W["sog"] * g["sog"] + W["blk"] * g["blk"]
            + W["hit"] * g["hit"] + W["tk"] * g["tk"] + W["gv"] * g["gv"] + W["pm"] * g["pm"]
            + W["ppp"] * g["ppp"])


# --------------------------------------------------------------------------- tendencia

FORMS = ["hot", "up", "flat", "down", "cold"]


def classify(season_avg, l5, l10, sd, slope10, point_streak, dry_streak, ppg, gp, kind="skater"):
    """Devuelve (form, trendScore -100..100)."""
    if gp < 5:
        return "flat", 0
    se = (sd / math.sqrt(5)) if sd > 0 else 0.25
    z = (0.6 * (l5 - season_avg) + 0.4 * (l10 - season_avg)) / max(se, 0.08)
    z += 0.6 * slope10 / max(sd, 0.1) * 3
    score = round(100 * math.tanh(z / 2.2))
    if kind == "skater":
        if point_streak >= 4 or (score >= 55 and l5 > season_avg):
            return "hot", score
        if ppg >= 0.45 and dry_streak >= 5:
            return "cold", min(score, -50)
        if point_streak >= 3 and score <= -20:
            return "down", score
    if score >= 55:
        return "hot", score
    if score >= 20:
        return "up", score
    if score <= -55:
        return "cold", score
    if score <= -20:
        return "down", score
    return "flat", score


def streaks(vals):
    """(racha de partidos con valor>0 al final, racha de partidos con 0 al final)"""
    pos = dry = 0
    for v in reversed(vals):
        if v > 0:
            if dry:
                break
            pos += 1
        else:
            if pos:
                break
            dry += 1
    return pos, dry


def weekly_candles(dates, deltas, start=100.0):
    """Velas semanales (lunes-domingo) de un 'precio' acumulado: precio += delta por partido."""
    candles, price = [], start
    cur_key, o, h, l = None, price, price, price
    for d, dv in zip(dates, deltas):
        dt = date.fromisoformat(d)
        wk = (dt - timedelta(days=dt.weekday())).isoformat()
        if wk != cur_key:
            if cur_key is not None:
                candles.append([cur_key, r2(o), r2(h), r2(l), r2(price)])
            cur_key, o, h, l = wk, price, price, price
        price += dv
        h, l = max(h, price), min(l, price)
    if cur_key is not None:
        candles.append([cur_key, r2(o), r2(h), r2(l), r2(price)])
    return candles


# --------------------------------------------------------------------------- principal


def season_for(today: date) -> str:
    y = today.year if today.month >= 9 else today.year - 1
    return f"{y}{y + 1}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", default=None)
    ap.add_argument("--out", default=str(Path(__file__).parent / "site" / "data" / "nhl.json"))
    ap.add_argument("--no-kalshi", action="store_true", help="no consultar Kalshi")
    ap.add_argument("--h2h-seasons", type=int, default=3, help="temporadas para jugador vs portero (0 = desactivar)")
    args = ap.parse_args()

    today = datetime.now(timezone.utc).date()
    season = args.season or season_for(today)
    t0 = time.time()
    pool = ThreadPoolExecutor(max_workers=6)

    # ---- clasificación
    st = get_json(f"{WEB}/standings/now")
    teams = {}
    for t in st["standings"]:
        ab = t["teamAbbrev"]["default"]
        teams[ab] = dict(
            abbr=ab, name=t["teamName"]["default"], common=t.get("teamCommonName", {}).get("default"),
            logo=t.get("teamLogo"), conf=t.get("conferenceName"), div=t.get("divisionName"),
            gp=t["gamesPlayed"], w=t["wins"], l=t["losses"], otl=t["otLosses"], pts=t["points"],
            ptsPct=r2(t["pointPctg"], 3), gf=t["goalFor"], ga=t["goalAgainst"],
            gfpg=r2(t["goalFor"] / max(t["gamesPlayed"], 1)), gapg=r2(t["goalAgainst"] / max(t["gamesPlayed"], 1)),
            l10=dict(w=t["l10Wins"], l=t["l10Losses"], otl=t["l10OtLosses"], gf=t["l10GoalsFor"], ga=t["l10GoalsAgainst"]),
            streak=f'{t.get("streakCode", "")}{t.get("streakCount", "")}',
            leagueRank=t["leagueSequence"], divRank=t["divisionSequence"], confRank=t["conferenceSequence"],
            home=f'{t["homeWins"]}-{t["homeLosses"]}-{t["homeOtLosses"]}',
            road=f'{t["roadWins"]}-{t["roadLosses"]}-{t["roadOtLosses"]}',
            next=None, games=[],
        )
    lg_gpg = mean([t["gf"] / max(t["gp"], 1) for t in teams.values()])

    # ---- plantillas activas
    def roster(ab):
        try:
            return ab, get_json(f"{WEB}/roster/{ab}/current")
        except Exception as e:
            print("roster error", ab, e, file=sys.stderr)
            return ab, {}

    bio = {}
    for ab, ro in pool.map(roster, list(teams)):
        for grp in ("forwards", "defensemen", "goalies"):
            for p in ro.get(grp, []):
                bio[p["id"]] = dict(
                    team=ab, num=p.get("sweaterNumber"), pos=p.get("positionCode"),
                    first=p["firstName"]["default"], last=p["lastName"]["default"],
                    headshot=p.get("headshot"), age=age_from(p.get("birthDate"), today),
                    shoots=p.get("shootsCatches"), country=p.get("birthCountry"),
                    h=p.get("heightInCentimeters"), wt=p.get("weightInKilograms"),
                )

    # ---- calendario (próximos partidos)
    sched = get_json(f"{WEB}/schedule/now")
    upcoming = []
    for day in sched.get("gameWeek", []):
        for g in day.get("games", []):
            if g.get("gameType") != 2:
                continue
            a, h = g["awayTeam"]["abbrev"], g["homeTeam"]["abbrev"]
            item = dict(id=g["id"], date=day["date"], start=g.get("startTimeUTC"), state=g.get("gameState"),
                        away=a, home=h, venue=g.get("venue", {}).get("default"),
                        awayScore=g["awayTeam"].get("score"), homeScore=g["homeTeam"].get("score"),
                        link=("https://www.nhl.com" + g["gameCenterLink"]) if g.get("gameCenterLink") else None)
            upcoming.append(item)
            for me, opp, home in ((a, h, False), (h, a, True)):
                if me in teams and teams[me]["next"] is None and g.get("gameState") in ("FUT", "PRE", "LIVE", "CRIT"):
                    teams[me]["next"] = dict(date=day["date"], start=g.get("startTimeUTC"), opp=opp, home=home, id=g["id"])

    # ---- stats por partido
    season_start = date(int(season[:4]), 9, 25)
    end_d = today + timedelta(days=1)
    sk_rows = fetch_games("skater/summary", season, season_start, end_d, pool)
    rt_rows = fetch_games("skater/realtime", season, season_start, end_d, pool)
    go_rows = fetch_games("goalie/summary", season, season_start, end_d, pool)
    tm_rows = fetch_games("team/summary", season, season_start, end_d, pool)
    print(f"filas: skaters={len(sk_rows)} realtime={len(rt_rows)} goalies={len(go_rows)}", file=sys.stderr)

    rt = {(r["gameId"], r["playerId"]): r for r in rt_rows}
    games_seen = set(r["gameId"] for r in sk_rows)
    last_game_date = max((r["gameDate"] for r in sk_rows), default=None)

    # ---- resultados de equipo por partido (reporte oficial team/summary)
    name2abbr = {t["name"]: ab for ab, t in teams.items()}
    for r in sorted(tm_rows, key=lambda r: (r["gameDate"], r["gameId"])):
        ab = name2abbr.get(r.get("teamFullName"))
        if not ab:
            continue
        res = "W" if r.get("wins") else "OTL" if r.get("otLosses") else "L"
        teams[ab]["games"].append([r["gameDate"], r["opponentTeamAbbrev"], r["goalsFor"], r["goalsAgainst"], res,
                                   1 if r.get("homeRoad") == "H" else 0, r.get("shotsForPerGame"), r.get("shotsAgainstPerGame"), r["gameId"]])
    for t in teams.values():
        pts_delta = [(2 if g[4] == "W" else 1 if g[4] == "OTL" else 0) - 1 for g in t["games"]]
        t["candles"] = weekly_candles([g[0] for g in t["games"]], pts_delta, 0.0)

    # ---- agrupar skaters
    per = {}
    for r in sk_rows:
        x = rt.get((r["gameId"], r["playerId"]), {})
        per.setdefault(r["playerId"], dict(name=r["skaterFullName"], pos=r["positionCode"], games=[]))["games"].append(dict(
            date=r["gameDate"], gid=r["gameId"], team=r["teamAbbrev"], opp=r["opponentTeamAbbrev"], home=r.get("homeRoad") == "H",
            g=r["goals"] or 0, a=r["assists"] or 0, p=r["points"] or 0, sog=r["shots"] or 0, pm=r["plusMinus"] or 0,
            pim=r["penaltyMinutes"] or 0, ppp=r["ppPoints"] or 0, ppg=r["ppGoals"] or 0, shp=r["shPoints"] or 0,
            gwg=r["gameWinningGoals"] or 0, toi=(r["timeOnIcePerGame"] or 0) / 60.0,
            hit=x.get("hits") or 0, blk=x.get("blockedShots") or 0, tk=x.get("takeaways") or 0, gv=x.get("giveaways") or 0,
            att=x.get("totalShotAttempts") or 0, fo=r.get("faceoffWinPct"),
        ))

    # baseline por posición (promedio IMP de jugadores regulares)
    for pid, p in per.items():
        p["games"].sort(key=lambda g: (g["date"], g["gid"]))
        for g in p["games"]:
            g["imp"] = skater_imp(g)
    def pos_group(pos):
        return "D" if pos == "D" else "F"
    base = {}
    for grp in ("F", "D"):
        vals = [mean([g["imp"] for g in p["games"]]) for p in per.values() if pos_group(p["pos"]) == grp and len(p["games"]) >= 10]
        base[grp] = mean(vals) if vals else 0.6
    # tasas de liga para contracción bayesiana
    tot_g = sum(g["g"] for p in per.values() for g in p["games"])
    tot_sog = sum(g["sog"] for p in per.values() for g in p["games"])
    lg_shpct = tot_g / tot_sog if tot_sog else 0.1

    # ---- jugador vs portero: caché de play-by-play (también da el historial de tiro de cada jugador)
    sys.path.insert(0, str(Path(__file__).parent))
    import model
    caches = []
    if args.h2h_seasons > 0:
        import h2h
        y = int(season[:4])
        seasons = [f"{y - i}{y - i + 1}" for i in range(args.h2h_seasons - 1, -1, -1)]
        caches = h2h.update(seasons, season, list(teams), get_json, pool, lambda m: print(m, file=sys.stderr))
    pp = model.pos_params(per)
    priors = model.priors_from_caches(caches, season)
    calib = model.calibrate(per, pp, priors)
    print(f"calibración: cg={calib['cg']} cp={calib['cp']} n={calib['n']} brier gol={calib['brierGoal']} punto={calib['brierPoint']}", file=sys.stderr)

    skaters = []
    for pid, p in per.items():
        b = bio.get(pid)
        active = b is not None
        gs = p["games"]
        n = len(gs)
        if n == 0:
            continue
        team = b["team"] if b else gs[-1]["team"]
        imps = [g["imp"] for g in gs]
        S = mean(imps)
        L5, L10 = mean(imps[-5:]), mean(imps[-10:])
        sd = statistics.pstdev(imps) if n > 1 else 0.5
        pts = [g["p"] for g in gs]
        ps, dry = streaks(pts)
        gstreak, _ = streaks([g["g"] for g in gs])
        tot = {k: sum(g[k] for g in gs) for k in ("g", "a", "p", "sog", "pm", "pim", "ppp", "ppg", "shp", "gwg", "hit", "blk", "tk", "gv", "att")}
        toi = mean([g["toi"] for g in gs])
        toi5 = mean([g["toi"] for g in gs[-5:]])
        ppg_rate = tot["p"] / n
        form, tscore = classify(S, L5, L10, sd, slope(imps[-10:]), ps, dry, ppg_rate, n)

        # proyección próximo partido (ver model.py)
        nxt = teams.get(team, {}).get("next")
        opp_f = 1.0
        if nxt and nxt["opp"] in teams and lg_gpg:
            opp_f = (teams[nxt["opp"]]["gapg"] or lg_gpg) / lg_gpg
            opp_f = max(0.8, min(1.2, opp_f ** 0.6))
        toi_f = max(0.85, min(1.15, (toi5 / toi) if toi else 1.0))
        lam_g, lam_p, sog_rate, sh_pct = model.lambdas(gs, pp[model.grp(p["pos"])], priors.get(pid), opp_f, toi_f)
        pGoal, pPoint = model.prob(lam_g, calib["cg"], calib["ag"]), model.prob(lam_p, calib["cp"], calib["ap"])
        pAssist = model.prob(model.assist_lambda(gs, pp[model.grp(p["pos"])], opp_f, toi_f), calib["ca"], calib["aa"])
        proj = dict(g=r2(lam_g, 3), p=r2(lam_p, 3), sog=r2(sog_rate, 2), sh=r2(sh_pct, 4),
                    pGoal=r2(pGoal, 3), pPoint=r2(pPoint, 3), pAssist=r2(pAssist, 3),
                    oppF=r2(opp_f, 3))

        candle_deltas = [g["imp"] - base[pos_group(p["pos"])] for g in gs]
        skaters.append(dict(
            id=pid, name=p["name"], team=team, pos=(b or {}).get("pos") or p["pos"], num=(b or {}).get("num"),
            age=(b or {}).get("age"), shoots=(b or {}).get("shoots"), country=(b or {}).get("country"),
            headshot=(b or {}).get("headshot"), active=active,
            gp=n, **tot, ptsPg=r2(ppg_rate, 3), shPct=r2(tot["g"] / tot["sog"] if tot["sog"] else 0, 3),
            toi=r2(toi), toi5=r2(toi5), imp=r2(S, 3), imp5=r2(L5, 3), imp10=r2(L10, 3), impSd=r2(sd, 3),
            l5=dict(g=sum(g["g"] for g in gs[-5:]), a=sum(g["a"] for g in gs[-5:]), p=sum(g["p"] for g in gs[-5:]), sog=sum(g["sog"] for g in gs[-5:])),
            l10=dict(g=sum(g["g"] for g in gs[-10:]), a=sum(g["a"] for g in gs[-10:]), p=sum(g["p"] for g in gs[-10:]), sog=sum(g["sog"] for g in gs[-10:])),
            pStreak=ps, dryStreak=dry, gStreak=gstreak, form=form, trend=tscore, proj=proj,
            candles=weekly_candles([g["date"] for g in gs], candle_deltas),
            # log compacto: fecha, rival, local, G, A, P, SOG, TOI, +/-, HIT, BLK, PPP, IMP
            log=[[g["date"], g["opp"], 1 if g["home"] else 0, g["g"], g["a"], g["p"], g["sog"], r2(g["toi"], 1), g["pm"], g["hit"], g["blk"], g["ppp"], r2(g["imp"], 2), g["gid"]] for g in gs],
        ))

    # Fuerza (0-100): percentiles de IMP temporada contraído, IMP L10 y TOI
    elig = [s for s in skaters if s["gp"] >= 3]
    shr = {s["id"]: (s["imp"] * s["gp"] + 5 * base["D" if s["pos"] == "D" else "F"] * 0.8) / (s["gp"] + 5) for s in elig}
    p_season = percentile_map(shr)
    p_l10 = percentile_map({s["id"]: s["imp10"] for s in elig})
    p_toi = percentile_map({s["id"]: s["toi"] for s in elig})
    for s in skaters:
        if s["id"] in p_season:
            s["power"] = round(0.55 * p_season[s["id"]] + 0.30 * p_l10[s["id"]] + 0.15 * p_toi[s["id"]], 1)
        else:
            s["power"] = None

    # ---- porteros
    tot_sa = sum(r.get("shotsAgainst") or 0 for r in go_rows)
    tot_sv = sum(r.get("saves") or 0 for r in go_rows)
    lg_sv = tot_sv / tot_sa if tot_sa else 0.9
    gper = {}
    for r in go_rows:
        gper.setdefault(r["playerId"], dict(name=r["goalieFullName"], games=[]))["games"].append(r)
    goalies = []
    for pid, p in gper.items():
        gs = sorted(p["games"], key=lambda r: (r["gameDate"], r["gameId"]))
        b = bio.get(pid)
        n = len(gs)
        sa = sum(r.get("shotsAgainst") or 0 for r in gs)
        sv = sum(r.get("saves") or 0 for r in gs)
        ga = sum(r.get("goalsAgainst") or 0 for r in gs)
        toi = sum(r.get("timeOnIce") or 0 for r in gs) / 60.0
        gsaa_g = [((r.get("shotsAgainst") or 0) * (1 - lg_sv)) - (r.get("goalsAgainst") or 0) for r in gs]
        S, L5, L10 = mean(gsaa_g), mean(gsaa_g[-5:]), mean(gsaa_g[-10:])
        sd = statistics.pstdev(gsaa_g) if n > 1 else 1.0
        form, tscore = classify(S, L5, L10, sd, slope(gsaa_g[-10:]), 0, 0, 0, n, kind="goalie")
        sa5 = sum(r.get("shotsAgainst") or 0 for r in gs[-5:])
        sv5 = sum(r.get("saves") or 0 for r in gs[-5:])
        team = b["team"] if b else gs[-1]["teamAbbrev"]
        goalies.append(dict(
            id=pid, name=p["name"], team=team, num=(b or {}).get("num"), age=(b or {}).get("age"),
            headshot=(b or {}).get("headshot"), active=b is not None, catches=(b or {}).get("shoots"),
            gp=n, gs=sum(r.get("gamesStarted") or 0 for r in gs), w=sum(r.get("wins") or 0 for r in gs),
            l=sum(r.get("losses") or 0 for r in gs), otl=sum(r.get("otLosses") or 0 for r in gs),
            so=sum(r.get("shutouts") or 0 for r in gs), sa=sa, sv=sv, ga=ga,
            svPct=r2(sv / sa if sa else 0, 4), gaa=r2(ga * 60 / toi if toi else 0, 2), toi=r2(toi, 1),
            svPct5=r2(sv5 / sa5 if sa5 else 0, 4), gsaa=r2(sum(gsaa_g), 2), gsaa5=r2(sum(gsaa_g[-5:]), 2),
            gsaaPg=r2(S, 3), form=form, trend=tscore,
            candles=weekly_candles([r["gameDate"] for r in gs], gsaa_g, 0.0),
            # fecha, rival, local, SA, SV, GA, SV%, TOI(min), decisión, GSAA
            log=[[r["gameDate"], r["opponentTeamAbbrev"], 1 if r.get("homeRoad") == "H" else 0, r.get("shotsAgainst") or 0,
                  r.get("saves") or 0, r.get("goalsAgainst") or 0, r2(r.get("savePct") or 0, 3), r2((r.get("timeOnIce") or 0) / 60, 1),
                  "W" if r.get("wins") else "OTL" if r.get("otLosses") else "L" if r.get("losses") else "-", r2(g, 2), r["gameId"]]
                 for r, g in zip(gs, gsaa_g)],
        ))
    gel = [g for g in goalies if g["gp"] >= 3]
    gp1 = percentile_map({g["id"]: (g["gsaa"] / max(g["gp"], 1)) * g["gp"] / (g["gp"] + 4) for g in gel})
    gp2 = percentile_map({g["id"]: g["gsaa5"] for g in gel})
    gp3 = percentile_map({g["id"]: g["gs"] for g in gel})
    for g in goalies:
        g["power"] = round(0.55 * gp1[g["id"]] + 0.30 * gp2[g["id"]] + 0.15 * gp3[g["id"]], 1) if g["id"] in gp1 else None

    # jugadores en plantilla sin partidos todavía
    have = {s["id"] for s in skaters} | {g["id"] for g in goalies}
    reserves = [dict(id=pid, name=f'{b["first"]} {b["last"]}', team=b["team"], pos=b["pos"], num=b["num"], age=b["age"])
                for pid, b in bio.items() if pid not in have]

    # ---- Kalshi (mercados de partido y de jugador)
    kal = None
    if not args.no_kalshi:
        sys.path.insert(0, str(Path(__file__).parent))
        import kalshi
        try:
            kal = kalshi.fetch(upcoming, bio, get_json, lambda m: print(m, file=sys.stderr))
        except Exception as e:
            print("kalshi error:", e, file=sys.stderr)

    # ---- portero probable de cada equipo en cada partido de la semana
    starts = {}
    for r in go_rows:
        if r.get("gamesStarted"):
            starts.setdefault(r["teamAbbrev"], []).append((r["gameDate"], r["playerId"]))
    played = {ab: {g[0] for g in t["games"]} for ab, t in teams.items()}
    gname = {g["id"]: g["name"] for g in goalies}
    kal_save = {}
    for pid, kp in ((kal or {}).get("players") or {}).items():
        if kp.get("save"):
            kal_save[(kp["game"], int(pid))] = True

    def probable(game, team):
        on_team = [pid for pid, b in bio.items() if b["pos"] == "G" and b["team"] == team]
        k = [pid for pid in on_team if (game["id"], pid) in kal_save]
        if len(k) == 1:
            return dict(id=k[0], name=gname.get(k[0], f'{bio[k[0]]["first"]} {bio[k[0]]["last"]}'), src="Kalshi", conf="alta")
        hist = sorted(starts.get(team, []))[-10:]
        cnt = {}
        for _, gid in hist:
            if gid in on_team or not on_team:
                cnt[gid] = cnt.get(gid, 0) + 1
        if not cnt:
            return None
        order = sorted(cnt, key=lambda g: -cnt[g])
        starter = order[0]
        share = cnt[starter] / max(1, sum(cnt.values()))
        prev = (date.fromisoformat(game["date"]) - timedelta(days=1)).isoformat()
        if prev in played.get(team, set()) and len(order) > 1:
            prev_starter = [gid for d, gid in hist if d == prev]
            if prev_starter and prev_starter[-1] == starter:
                b = order[1]
                return dict(id=b, name=gname.get(b, ""), src="Partido ayer: juega el suplente", conf="media")
        return dict(id=starter, name=gname.get(starter, ""), src=f"Titular en {cnt[starter]} de los últimos {len(hist)}",
                    conf="alta" if share >= 0.7 else "media" if share >= 0.5 else "baja")

    def confirmed(game):
        """Partido empezado: el portero que de verdad está/estuvo en la red (boxscore oficial)."""
        try:
            b = get_json(f"{WEB}/gamecenter/{game['id']}/boxscore")
        except Exception:
            return {}
        out = {}
        for side, key in (("away", "awayTeam"), ("home", "homeTeam")):
            gl = [x for x in (b.get("playerByGameStats", {}).get(key, {}).get("goalies") or [])
                  if x.get("starter") or (x.get("toi") or "00:00") != "00:00"]
            gl.sort(key=lambda x: (not x.get("starter"), -(int((x.get("toi") or "0:0").split(":")[0]))))
            if gl:
                gid = gl[0]["playerId"]
                out[side] = dict(id=gid, name=gname.get(gid, gl[0]["name"]["default"]), src="Confirmado: en la red", conf="confirmado")
        return out

    for g in upcoming:
        g["goalies"] = {"away": probable(g, g["away"]), "home": probable(g, g["home"])}
        if g.get("state") in ("LIVE", "CRIT", "OFF", "FINAL"):
            g["goalies"].update(confirmed(g))

    out = dict(
        generatedAt=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        season=season, seasonLabel=f"{season[:4]}-{season[6:]}",
        lastGameDate=last_game_date, gamesCounted=len(games_seen),
        league=dict(svPct=r2(lg_sv, 4), shPct=r2(lg_shpct, 4), goalsPerTeamGame=r2(lg_gpg, 3),
                    impBaseF=r2(base["F"], 3), impBaseD=r2(base["D"], 3)),
        weights=W,
        teams=sorted(teams.values(), key=lambda t: t["leagueRank"]),
        schedule=upcoming,
        skaters=sorted(skaters, key=lambda s: -(s["power"] or -1)),
        goalies=sorted(goalies, key=lambda g: -(g["power"] or -1)),
        reserves=reserves,
        kalshi=kal,
        model=dict(calibration=calib, pos={k: {kk: r2(vv, 4) for kk, vv in v.items()} for k, v in pp.items()}),
        sources=[f"{WEB}/standings/now", f"{WEB}/roster/{{TEAM}}/current", f"{WEB}/schedule/now",
                 f"{STATS}/skater/summary", f"{STATS}/skater/realtime", f"{STATS}/goalie/summary"],
    )
    # ---- jugador vs portero (salida)
    if caches:
        act_s = {s["id"] for s in skaters if s["active"]} | {pid for pid, b in bio.items() if b["pos"] != "G"}
        act_g = {g["id"] for g in goalies if g["active"]} | {pid for pid, b in bio.items() if b["pos"] == "G"}
        import h2h
        hh = h2h.build_output(caches, act_s, act_g, season)
        hp = Path(args.out).parent / "h2h.json"
        hp.write_text(json.dumps(hh, separators=(",", ":")), encoding="utf-8")
        print(f"OK {hp} ({hp.stat().st_size/1e6:.2f} MB) partidos pbp={hh['games']}", file=sys.stderr)

    outp = Path(args.out)
    outp.parent.mkdir(parents=True, exist_ok=True)
    outp.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"OK {outp} ({outp.stat().st_size/1e6:.2f} MB) skaters={len(skaters)} goalies={len(goalies)} "
          f"games={len(games_seen)} en {time.time()-t0:.0f}s", file=sys.stderr)


if __name__ == "__main__":
    main()
