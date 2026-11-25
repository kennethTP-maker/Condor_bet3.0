"""
Historial jugador vs portero a partir del play-by-play oficial de la NHL.

Para cada partido (temporada regular + playoffs, sin tandas de penales) se registra:
  * tiros a puerta y goles de cada jugador con el portero que estaba en la red
  * asistencias en goles contra ese portero
  * partidos en los que el jugador estuvo alineado y ese portero jugó contra su equipo

La caché (nhl_dashboard/cache/h2h_<temporada>.json) guarda los totales y los partidos ya
procesados, así la ejecución diaria solo descarga los partidos nuevos.
"""
from __future__ import annotations

import json
from pathlib import Path

WEB = "https://api-web.nhle.com/v1"
CACHE_DIR = Path(__file__).parent / "cache"


def _load(season: str) -> dict:
    p = CACHE_DIR / f"h2h_{season}.json"
    if p.exists():
        return json.loads(p.read_text())
    return {"season": season, "games": [], "pairs": {}, "complete": False}


def _save(c: dict):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    c["games"] = sorted(set(c["games"]))
    (CACHE_DIR / f"h2h_{c['season']}.json").write_text(json.dumps(c, separators=(",", ":")))


def _finished_games(season: str, teams: list[str], get_json, pool) -> set[int]:
    def one(ab):
        try:
            return get_json(f"{WEB}/club-schedule-season/{ab}/{season}").get("games", [])
        except Exception:
            return []
    ids = set()
    for games in pool.map(one, teams):
        for g in games:
            if g.get("gameType") in (2, 3) and g.get("gameState") in ("OFF", "FINAL"):
                ids.add(g["id"])
    return ids


def _parse_game(pbp: dict) -> dict:
    """Devuelve {"s:g": [gp, sog, g, a]} para un partido."""
    out = {}

    def add(sk, gk, i, v=1):
        k = f"{sk}:{gk}"
        row = out.setdefault(k, [0, 0, 0, 0])
        row[i] += v

    team_of = {}
    dressed = {}
    for r in pbp.get("rosterSpots", []):
        team_of[r["playerId"]] = r["teamId"]
        if r.get("positionCode") != "G":
            dressed.setdefault(r["teamId"], set()).add(r["playerId"])
    faced = {}  # teamId que dispara -> porteros rivales que estuvieron en la red
    for p in pbp.get("plays", []):
        if (p.get("periodDescriptor") or {}).get("periodType") == "SO":
            continue
        t = p.get("typeDescKey")
        if t not in ("shot-on-goal", "goal", "missed-shot"):
            continue
        d = p.get("details") or {}
        gk = d.get("goalieInNetId")
        if not gk:
            continue  # portería vacía
        faced.setdefault(d.get("eventOwnerTeamId"), set()).add(gk)
        if t == "shot-on-goal" and d.get("shootingPlayerId"):
            add(d["shootingPlayerId"], gk, 1)
        elif t == "goal" and d.get("scoringPlayerId"):
            add(d["scoringPlayerId"], gk, 1)
            add(d["scoringPlayerId"], gk, 2)
            for ak in ("assist1PlayerId", "assist2PlayerId"):
                if d.get(ak):
                    add(d[ak], gk, 3)
    for team, goalies in faced.items():
        for sk in dressed.get(team, ()):
            for gk in goalies:
                add(sk, gk, 0)
    return out


def update(seasons: list[str], current: str, teams: list[str], get_json, pool, log=print) -> list[dict]:
    caches = []
    for season in seasons:
        c = _load(season)
        if c.get("complete") and season != current:
            caches.append(c)
            continue
        done = set(c["games"])
        todo = sorted(_finished_games(season, teams, get_json, pool) - done)
        log(f"h2h {season}: {len(done)} en caché, {len(todo)} nuevos")

        def fetch(gid):
            try:
                return gid, get_json(f"{WEB}/gamecenter/{gid}/play-by-play")
            except Exception as e:
                log(f"  pbp error {gid}: {e}")
                return gid, None

        pairs = c["pairs"]
        for i, (gid, pbp) in enumerate(pool.map(fetch, todo)):
            if not pbp or pbp.get("gameState") not in ("OFF", "FINAL"):
                continue
            for k, v in _parse_game(pbp).items():
                row = pairs.setdefault(k, [0, 0, 0, 0])
                for j in range(4):
                    row[j] += v[j]
            c["games"].append(gid)
            if (i + 1) % 200 == 0:
                log(f"  {i + 1}/{len(todo)}")
                _save(c)
        if season != current:
            c["complete"] = True
        _save(c)
        caches.append(c)
    return caches


def build_output(caches: list[dict], active_skaters: set[int], active_goalies: set[int], cur_season: str) -> dict:
    tot = {}
    cur = {}
    for c in caches:
        for k, v in c["pairs"].items():
            row = tot.setdefault(k, [0, 0, 0, 0])
            for j in range(4):
                row[j] += v[j]
            if c["season"] == cur_season:
                cur[k] = v
    # totales por jugador / portero en toda la ventana (para % de tiro y % de paradas base)
    shooter, goalie = {}, {}
    for k, v in tot.items():
        s, g = map(int, k.split(":"))
        a = shooter.setdefault(s, [0, 0])
        a[0] += v[1]; a[1] += v[2]
        b = goalie.setdefault(g, [0, 0])
        b[0] += v[1]; b[1] += v[2]
    pairs = {}
    for k, v in tot.items():
        s, g = map(int, k.split(":"))
        if s in active_skaters and g in active_goalies and (v[1] or v[3] or v[0]):
            c = cur.get(k, [0, 0, 0, 0])
            # [portero, PJ, tiros, goles, asist, PJ temp. actual, tiros temp., goles temp.]
            pairs.setdefault(s, []).append([g, v[0], v[1], v[2], v[3], c[0], c[1], c[2]])
    return {
        "seasons": [c["season"] for c in caches],
        "games": sum(len(c["games"]) for c in caches),
        "pairs": pairs,
        "shooters": {s: v for s, v in shooter.items() if s in active_skaters},
        "goalies": {g: v for g, v in goalie.items() if g in active_goalies},
    }
