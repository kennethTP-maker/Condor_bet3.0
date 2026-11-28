"""
Modelo de probabilidad de gol / punto para el próximo partido, con calibración por backtest.

  goles esperados  λg = tiros/partido (mezcla temporada-L10-L5, contraída a su posición)
                        × % de tiro (temporadas anteriores + actual, contraído a su posición)
                        × factor rival × factor minutos
  puntos esperados λp = puntos/partido (contraído a su posición, mezcla temporada-L10-L5) × factores
  P(1+) = 1 − exp(−c · λ)      c se ajusta con un backtest sobre la temporada actual:
                               cada partido se predice solo con los partidos anteriores.
"""
from __future__ import annotations

import math

K_SH = 150   # tiros de peso hacia el % de tiro de su posición
K_SOG = 3    # partidos de peso hacia los tiros/partido de su posición
K_PTS = 8    # partidos de peso hacia los puntos/partido de su posición
# Rol del jugador (backtest 2025-26 → probado en 2026-27, mejora el log-loss de goles, puntos y asistencias):
# minutos de hielo frente a su posición ^ exponente, y puntos en power play por partido.
# El factor se limita a 0.4–1.3 para no inflar a las estrellas (calibración del tramo 70 %+).
ROLE = dict(goal=(1.2, 0.5), point=(1.6, 0.0), assist=(2.5, 0.0))


def grp(pos):
    return "D" if pos == "D" else "F"


def pos_params(per: dict) -> dict:
    out = {}
    for gk in ("F", "D"):
        games = [g for p in per.values() if grp(p["pos"]) == gk for g in p["games"]]
        n = len(games) or 1
        sog = sum(g["sog"] for g in games)
        out[gk] = dict(sh=(sum(g["g"] for g in games) / sog) if sog else 0.1,
                       sog=sog / n, pts=sum(g["p"] for g in games) / n, ast=sum(g["a"] for g in games) / n,
                       toi=sum(g.get("toi", 0) for g in games) / n or 15.0, pppg=sum(g.get("ppp", 0) for g in games) / n)
    return out


def priors_from_caches(caches: list[dict], current: str) -> dict:
    """Tiros y goles de temporadas anteriores (play-by-play) por jugador."""
    pri = {}
    for c in caches:
        if c["season"] == current:
            continue
        for k, v in c["pairs"].items():
            s = int(k.split(":")[0])
            a = pri.setdefault(s, [0, 0])
            a[0] += v[1]
            a[1] += v[2]
    return pri


def _mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def role_f(gs: list[dict], pp: dict, kind: str) -> float:
    """Más minutos y más power play que su posición → más probabilidad (ver ROLE)."""
    bt, bp = ROLE[kind]
    if not gs:
        return 1.0
    toi = max(_mean([g.get("toi", 0) for g in gs]), 5.0)
    pppg = _mean([g.get("ppp", 0) for g in gs])
    f = (toi / pp.get("toi", 15.0)) ** bt * max(0.3, 1 + bp * (pppg - pp.get("pppg", 0.1)))
    return max(0.4, min(1.3, f))


def lambdas(gs: list[dict], pp: dict, prior: list | None, opp_f=1.0, toi_f=1.0):
    n = len(gs)
    sog_tot = sum(g["sog"] for g in gs)
    g_tot = sum(g["g"] for g in gs)
    p_tot = sum(g["p"] for g in gs)
    sog_season = (sog_tot + K_SOG * pp["sog"]) / (n + K_SOG)
    sog_rate = 0.5 * sog_season + 0.3 * _mean([g["sog"] for g in gs[-10:]] or [sog_season]) + 0.2 * _mean([g["sog"] for g in gs[-5:]] or [sog_season])
    ps, pg = (prior or [0, 0])
    sh = (g_tot + pg + K_SH * pp["sh"]) / (sog_tot + ps + K_SH)
    pts_season = (p_tot + K_PTS * pp["pts"]) / (n + K_PTS)
    pts_rate = 0.6 * pts_season + 0.25 * _mean([g["p"] for g in gs[-10:]] or [pts_season]) + 0.15 * _mean([g["p"] for g in gs[-5:]] or [pts_season])
    return (sog_rate * sh * opp_f * toi_f * role_f(gs, pp, "goal"), pts_rate * opp_f * toi_f * role_f(gs, pp, "point"),
            sog_rate * toi_f, sh)


def assist_lambda(gs: list[dict], pp: dict, opp_f=1.0, toi_f=1.0):
    n = len(gs)
    a_season = (sum(g["a"] for g in gs) + K_PTS * pp["ast"]) / (n + K_PTS)
    rate = 0.6 * a_season + 0.25 * _mean([g["a"] for g in gs[-10:]] or [a_season]) + 0.15 * _mean([g["a"] for g in gs[-5:]] or [a_season])
    return rate * opp_f * toi_f * role_f(gs, pp, "assist")


def prob(lam, c, a=0.0):
    """P(1+) = 1 − exp(−(a + c·λ)); a y c salen del backtest."""
    return 1.0 - math.exp(-max(a + c * max(lam, 0.0), 1e-4))


def calibrate(per: dict, pp: dict, priors: dict, min_prior_games=3):
    """Backtest sin mirar el futuro. Devuelve coeficientes y tabla de calibración."""
    rows = []  # (λg, λp, marcó, punto)
    for pid, p in per.items():
        gs = p["games"]
        par = pp[grp(p["pos"])]
        for i in range(min_prior_games, len(gs)):
            lg, lp, _, _ = lambdas(gs[:i], par, priors.get(pid))
            la = assist_lambda(gs[:i], par)
            rows.append((lg, lp, 1 if gs[i]["g"] > 0 else 0, 1 if gs[i]["p"] > 0 else 0, la, 1 if gs[i]["a"] > 0 else 0))
    if len(rows) < 500:
        return dict(cg=1.0, cp=1.0, ca=1.0, ag=0.0, ap=0.0, aa=0.0, n=len(rows), goal=[], point=[], assist=[], brierGoal=None, brierPoint=None, brierAssist=None)

    def fit(idx_l, idx_y):
        best = None
        for a100 in range(-8, 17, 2):
            a = a100 / 100
            for c100 in range(20, 141, 4):
                c = c100 / 100
                ll = 0.0
                for r in rows:
                    q = min(max(prob(r[idx_l], c, a), 1e-6), 1 - 1e-6)
                    ll -= math.log(q) if r[idx_y] else math.log(1 - q)
                if best is None or ll < best[0]:
                    best = (ll, c, a)
        return best[1], best[2]

    (cg, ag), (cp, ap), (ca, aa) = fit(0, 2), fit(1, 3), fit(4, 5)

    def table(idx_l, idx_y, c, edges, off=0.0):
        out = []
        for lo, hi in zip(edges, edges[1:]):
            sel = [r for r in rows if lo <= prob(r[idx_l], c, off) < hi]
            if len(sel) >= 30:
                out.append([round(lo, 2), round(hi, 2), len(sel),
                            round(_mean([prob(r[idx_l], c, off) for r in sel]), 3), round(_mean([r[idx_y] for r in sel]), 3)])
        return out

    brier = lambda il, iy, c, off: round(_mean([(prob(r[il], c, off) - r[iy]) ** 2 for r in rows]), 4)
    return dict(cg=cg, ag=ag, cp=cp, ap=ap, ca=ca, aa=aa, n=len(rows),
                goal=table(0, 2, cg, [0, .05, .1, .15, .2, .25, .3, .35, .4, .5, 1.01], ag),
                point=table(1, 3, cp, [0, .2, .3, .4, .5, .6, .7, .8, 1.01], ap),
                assist=table(4, 5, ca, [0, .1, .2, .3, .4, .5, .6, 1.01], aa),
                brierGoal=brier(0, 2, cg, ag), brierPoint=brier(1, 3, cp, ap), brierAssist=brier(4, 5, ca, aa))


def data_pick_record(per: dict, pp: dict, priors: dict, cal: dict, days: int = 7):
    """Games-tab style picks replayed without looking ahead: for each team in each game of the last
    `days` game days, the top candidates by P(point) and P(goal) using only earlier games."""
    dates = sorted({g["date"] for p in per.values() for g in p["games"]})
    keep = set(dates[-days:])
    last_day = dates[-1] if dates else None
    by = {}
    for pid, p in per.items():
        gs = p["games"]
        par = pp[grp(p["pos"])]
        for i in range(8, len(gs)):
            g = gs[i]
            if g["date"] not in keep:
                continue
            lg, lp, _, _ = lambdas(gs[:i], par, priors.get(pid))
            by.setdefault((g["gid"], g["team"]), []).append(dict(
                name=p["name"], date=g["date"], game=f'{g["team"]} vs {g["opp"]}',
                pp=prob(lp, cal["cp"], cal["ap"]), pg=prob(lg, cal["cg"], cal["ag"]), yp=g["p"] > 0, yg=g["g"] > 0))
    out = {"pt1": [], "pt2": [], "g1": [], "any2": []}
    recent = []
    for (gid, team), cands in by.items():
        if len(cands) < 6:
            continue
        sp = sorted(cands, key=lambda c: -c["pp"])
        sg = sorted(cands, key=lambda c: -c["pg"])
        out["pt1"].append((sp[0]["date"], sp[0]["yp"]))
        out["pt2"] += [(c["date"], c["yp"]) for c in sp[:2]]
        out["any2"].append((sp[0]["date"], sp[0]["yp"] or sp[1]["yp"]))
        out["g1"].append((sg[0]["date"], sg[0]["yg"]))
        recent.append(dict(date=sp[0]["date"], game=sp[0]["game"], point=sp[0]["name"], pPoint=round(sp[0]["pp"], 3), pointHit=sp[0]["yp"],
                           goal=sg[0]["name"], pGoal=round(sg[0]["pg"], 3), goalHit=sg[0]["yg"]))

    def agg(xs, day=None):
        xs = [x for d, x in xs if day is None or d == day]
        return [len(xs), round(sum(xs) / len(xs), 4) if xs else None]
    res = {k: dict(day=agg(v, last_day), week=agg(v)) for k, v in out.items()}
    return dict(lastDay=last_day, days=days, **res, recent=sorted(recent, key=lambda r: r["date"], reverse=True)[:40])
