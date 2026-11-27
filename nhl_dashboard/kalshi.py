"""
Mercados de Kalshi para los partidos NHL (API pública, sin clave).

Series usadas:
  KXNHLGAME  ganador del partido        KXNHLGOAL  jugador marca 1+/2+/3+ goles
  KXNHLPTS   jugador 1+/2+/3+ puntos     KXNHLAST   jugador 1+/2+ asistencias
  KXNHLSAVE  portero N+ paradas

Tickers: evento = <SERIE>-<AAMMMDD><VISITANTE><LOCAL>   p. ej. KXNHLGOAL-26NOV25CARTB
         mercado jugador = <evento>-<EQUIPO><INICIAL><APELLIDO><DORSAL>-<línea>
Los precios son una foto del momento de la actualización; el enlace lleva al mercado en vivo.
"""
from __future__ import annotations

import re
import unicodedata
import urllib.parse
from datetime import date, datetime, timezone

API = "https://api.elections.kalshi.com/trade-api/v2"
SERIES = {"KXNHLGAME": "game", "KXNHLGOAL": "goal", "KXNHLPTS": "pts", "KXNHLAST": "ast", "KXNHLSAVE": "save"}
NHL2K = {"TBL": "TB", "LAK": "LA", "SJS": "SJ", "NJD": "NJ"}
K2NHL = {v: k for k, v in NHL2K.items()}
MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]


def kcode(abbr: str) -> str:
    return NHL2K.get(abbr, abbr)


def date_code(iso: str) -> str:
    d = date.fromisoformat(iso)
    return f"{d.year % 100:02d}{MONTHS[d.month - 1]}{d.day:02d}"


def slugify(t: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", t.lower()).strip("-") or "market"


def _key(name: str) -> str:
    """'Stützle' -> 'STUTZLE'; quita acentos, espacios, guiones y apóstrofos."""
    n = unicodedata.normalize("NFKD", name or "")
    return re.sub(r"[^A-Z]", "", n.encode("ascii", "ignore").decode().upper())


def _money(x):
    try:
        return round(float(x), 4)
    except (TypeError, ValueError):
        return None


def fetch(schedule: list[dict], bio: dict, get_json, log=print) -> dict:
    """schedule: items con id, date, away, home. bio: playerId -> {team, num, last}."""
    slugs = {}
    for s in SERIES:
        try:
            slugs[s] = slugify(get_json(f"{API}/series/{s}")["series"]["title"])
        except Exception:
            slugs[s] = "market"

    def url(series, event):
        return f"https://kalshi.com/markets/{series.lower()}/{slugs[series]}/{event.lower()}"

    # partido NHL <- sufijo de evento Kalshi
    by_suffix, games = {}, {}
    for g in schedule:
        suf = f'{date_code(g["date"])}{kcode(g["away"])}{kcode(g["home"])}'
        by_suffix[suf] = g
        games[g["id"]] = {"suffix": suf, "links": {k: url(s, f"{s}-{suf}") for s, k in SERIES.items()},
                          "win": {}}

    # jugador (equipo kalshi + inicial + apellido) -> id NHL. El dorsal de Kalshi no siempre coincide.
    by_name, by_last = {}, {}
    for pid, b in bio.items():
        t = kcode(b["team"])
        last, first = _key(b.get("last", "")), _key(b.get("first", ""))
        by_name.setdefault((t, first[:1] + last), []).append(pid)
        by_last.setdefault((t, last), []).append(pid)

    players = {}
    n_markets = 0
    for series, kind in SERIES.items():
        cursor, rows = None, []
        for _ in range(20):
            q = {"series_ticker": series, "status": "open", "limit": "1000"}
            if cursor:
                q["cursor"] = cursor
            try:
                d = get_json(f"{API}/markets?" + urllib.parse.urlencode(q))
            except Exception as e:
                log(f"kalshi {series}: {e}")
                break
            rows.extend(d.get("markets", []))
            cursor = d.get("cursor")
            if not cursor:
                break
        for m in rows:
            parts = m["ticker"].split("-")
            if len(parts) < 3:
                continue
            suf = parts[1]
            g = by_suffix.get(suf)
            if not g:
                continue
            n_markets += 1
            ask, bid = _money(m.get("yes_ask_dollars")), _money(m.get("yes_bid_dollars"))
            last = _money(m.get("last_price_dollars"))
            if kind == "game":
                team = K2NHL.get(parts[2], parts[2])
                games[g["id"]]["win"][team] = {"ask": ask, "bid": bid, "last": last, "ticker": m["ticker"]}
                continue
            if len(parts) < 4:
                continue
            code, line = parts[2], parts[3]
            pid = None
            for team in (g["away"], g["home"]):
                k = kcode(team)
                if not code.startswith(k):
                    continue
                rest = re.sub(r"\d+$", "", code[len(k):])
                cand = by_name.get((k, rest)) or by_last.get((k, rest[1:])) or []
                if len(cand) == 1:
                    pid = cand[0]
                    break
            if not pid:
                continue
            try:
                ln = int(line)
            except ValueError:
                continue
            p = players.setdefault(pid, {"game": g["id"], "event": suf})
            p.setdefault(kind, []).append({"line": ln, "ask": ask, "bid": bid, "last": last, "ticker": m["ticker"]})
    for p in players.values():
        for k in ("goal", "pts", "ast", "save"):
            if k in p:
                p[k].sort(key=lambda x: x["line"])
    log(f"kalshi: {n_markets} mercados NHL, {len(players)} jugadores enlazados")
    return {"fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "slugs": slugs, "games": games, "players": players}
