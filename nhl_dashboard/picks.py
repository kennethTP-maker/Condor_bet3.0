"""
Analyst track record: store every Analyst pick that has a Kalshi price, then settle it.

A pick is saved the first time it appears (price and probability at that moment) and never overwritten.
Settlement:
  NHL       - from the player's game log once the game is final (goal / point / assist in that game);
              a player who did not dress is "void" (excluded).
  eSports   - from the Kalshi result of the match.
Profit is per $1 staked buying "Yes" at the ask, after Kalshi's trading fee
(fee per contract = ceil(0.07 * price * (1 - price) * 100) / 100).

Stored in nhl_dashboard/cache/picks_<sport>.json; a summary goes into each page's data file.
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

CACHE = Path(__file__).parent / "cache"


MIN_NET = 0.03        # minimum edge after Kalshi's fee for any pick
MIN_NET_DRAW = 0.06   # eSoccer draws: only with a big edge (0 of 9 in the first day at +2-4 pts)


def net_edge(p, ask):
    return p - ask - fee(ask)


def rating(edge):
    return "Strong" if edge >= 0.06 else "Good" if edge >= 0.035 else "Moderate"


def fee(price):
    return math.ceil(0.07 * price * (1 - price) * 100 - 1e-9) / 100


def profit_per_dollar(price, won):
    cost = price + fee(price)
    return ((1.0 if won else 0.0) - cost) / cost


def load(sport):
    p = CACHE / f"picks_{sport}.json"
    return json.loads(p.read_text()) if p.exists() else {}


def save(sport, store):
    CACHE.mkdir(parents=True, exist_ok=True)
    (CACHE / f"picks_{sport}.json").write_text(json.dumps(store, separators=(",", ":")))


def add(store, key, **pick):
    if key not in store:
        pick.update(rating=rating(pick["edge"]), status="open", won=None, pnl=None)
        store[key] = pick


def settle(store, key, won):
    p = store[key]
    if p["status"] != "open":
        return
    if won is None:
        p.update(status="void")
        return
    p.update(status="settled", won=bool(won), pnl=round(profit_per_dollar(p["ask"], won), 4))


def summary(store, recent=60):
    rows = list(store.values())

    def agg(rs):
        s = [r for r in rs if r["status"] == "settled"]
        n = len(s)
        return dict(picks=len(rs), settled=n, open=sum(1 for r in rs if r["status"] == "open"),
                    wins=sum(1 for r in s if r["won"]), hit=round(sum(1 for r in s if r["won"]) / n, 4) if n else None,
                    avgProb=round(sum(r["p"] for r in s) / n, 4) if n else None,
                    avgPrice=round(sum(r["ask"] for r in s) / n, 4) if n else None,
                    pnl=round(sum(r["pnl"] for r in s), 3), roi=round(sum(r["pnl"] for r in s) / n, 4) if n else None)

    by = {k: agg([r for r in rows if r["rating"] == k]) for k in ("Strong", "Good", "Moderate")}
    markets = sorted({r["market"] for r in rows})
    first = min((r["at"] for r in rows), default=None)
    last_rows = sorted(rows, key=lambda r: r["start"], reverse=True)[:recent]
    return dict(since=first, all=agg(rows), byRating=by, byMarket={m: agg([r for r in rows if r["market"] == m]) for m in markets},
                recent=[{k: r.get(k) for k in ("start", "label", "market", "p", "ask", "edge", "rating", "status", "won", "pnl", "game")} for r in last_rows])


# ------------------------------------------------------------------ eSports
def esports(sport, upcoming, done, now):
    store = load(sport)
    for m in upcoming:
        if m["start"] <= now.isoformat()[:16]:
            continue  # already started: in-game price
        opts = [("A", m["a"] + " wins", m["ma"], m["pa"]["ask"]), ("B", m["b"] + " wins", m["mb"], m["pb"]["ask"])]
        if m.get("pt") and m["pt"].get("ask") is not None and m["md"]:
            opts.append(("T", "Draw", m["md"], m["pt"]["ask"]))
        opts = [(k, lbl, p, a, net_edge(p, a)) for k, lbl, p, a in opts if a and 0 < a < 1]
        opts = [o for o in opts if o[4] >= (MIN_NET_DRAW if o[0] == "T" else MIN_NET)]
        if not opts:
            continue
        fire = set(m.get("fire") or [])
        # a pick with a 70%+ historical signal (🔥) goes first, then the larger edge
        k, lbl, p, a, e = max(opts, key=lambda o: (o[0] in fire, o[4]))
        add(store, m["id"], at=now.isoformat(timespec="minutes"), start=m["start"], game=f'{m["a"]} vs {m["b"]}',
            label=lbl, market=k if k == "T" else "Win", side=k, p=round(p, 4), ask=a, edge=round(e, 4), fire=k in fire)
    res = {m["id"]: m["res"] for m in done}
    for key, pk in store.items():
        if pk["status"] == "open" and key in res:
            settle(store, key, res[key] == pk["side"])
        elif pk["status"] == "open" and pk["start"] < (now - timedelta(days=2)).isoformat()[:16]:
            pk["status"] = "void"
    save(sport, store)
    return summary(store)


# ------------------------------------------------------------------ NHL
MARKETS = {"goal": ("pGoal", "goal", 0.18, 0.20, "1+ goal"), "point": ("pPoint", "pts", 0.40, 0.45, "1+ point"),
           "assist": ("pAssist", "ast", 0.28, 0.32, "1+ assist")}


def _scale(p, r):
    return 1 - (1 - min(p, 0.99)) ** r


def nhl(out, hh, now):
    store = load("nhl")
    kal = out.get("kalshi") or {}
    kp_all = kal.get("players") or {}
    teams = {t["abbr"]: t for t in out["teams"]}
    gen = datetime.fromisoformat(out["generatedAt"])
    lg_sv = out["league"]["svPct"] or 0.9
    lg_sh = out["league"]["shPct"] or 0.1
    pairs = {}
    if hh:
        for sid, rows in hh["pairs"].items():
            for r in rows:
                pairs[(int(sid), r[0])] = r
    gstats = {int(k): v for k, v in (hh or {}).get("goalies", {}).items()}
    shooters = {int(k): v for k, v in (hh or {}).get("shooters", {}).items()}

    def missed(s):
        t = teams.get(s["team"])
        if not t or not s["log"]:
            return 0
        last = s["log"][-1][0]
        return sum(1 for g in t["games"] if g[0] > last)

    def matchup(s, gid):
        r = pairs.get((s["id"], gid), [gid, 0, 0, 0, 0])
        gp, sog, g, a = r[1], r[2], r[3], r[4]
        gs = gstats.get(gid)
        lga = 1 - lg_sv
        gf = ((gs[1] + 300 * lga) / (gs[0] + 300)) / lga if gs else 1.0
        sh = shooters.get(s["id"])
        shp = (sh[1] + 80 * lg_sh) / (sh[0] + 80) if sh else lg_sh
        xg = sog * shp * gf
        clamp = lambda x, lo, hi: max(lo, min(hi, x))
        pair_g = clamp((g + 2) / (xg + 2), 0.75, 1.35)
        pair_p = clamp((g + a + 2) / (gp * (s["ptsPg"] or 0) + 2), 0.75, 1.35)
        mg = clamp(gf * pair_g, 0.7, 1.45)
        mp = clamp(math.sqrt(gf) * pair_p, 0.7, 1.45)
        o = s["proj"].get("oppF") or 1
        return dict(pGoal=_scale(_scale(s["proj"]["pGoal"], 1 / o), mg), pPoint=_scale(_scale(s["proj"]["pPoint"], 1 / o), mp),
                    pAssist=_scale(_scale(s["proj"].get("pAssist") or 0, 1 / o), mp), gf=gf, pairG=pair_g,
                    conf="high" if sog >= 25 else "medium" if sog >= 8 else "low")

    for g in out["schedule"]:
        if g.get("state") not in ("FUT", "PRE"):
            continue
        for team, opp, side in ((g["away"], g["home"], "home"), (g["home"], g["away"], "away")):
            gk = (g.get("goalies") or {}).get(side)
            cands = []
            for s in out["skaters"]:
                if not s["active"] or s["team"] != team or s["gp"] < 8 or not s["log"] or missed(s):
                    continue
                if (gen - datetime.fromisoformat(s["log"][-1][0] + "T12:00:00+00:00")).days > 12:
                    continue
                kp = kp_all.get(str(s["id"])) or kp_all.get(s["id"])
                if not kp or kp.get("game") != g["id"]:
                    continue
                m = matchup(s, gk["id"]) if gk else dict(pGoal=s["proj"]["pGoal"], pPoint=s["proj"]["pPoint"], pAssist=s["proj"].get("pAssist") or 0, gf=1, pairG=1, conf="low")
                form = {"hot": 3, "up": 1.5, "flat": 0, "down": -2, "cold": -4}.get(s["form"], 0)
                best = None
                for mid, (key, kk, floor, base, label) in MARKETS.items():
                    p = m[key]
                    if p < floor:
                        continue
                    km = next((x for x in kp.get(kk, []) if x["line"] == 1), None)
                    ask = km and km.get("ask")
                    if not ask or not 0 < ask < 1 or net_edge(p, ask) < MIN_NET:
                        continue
                    score = net_edge(p, ask) * 100 + p * 8 + form
                    if m["conf"] == "high" and m["pairG"] > 1.1 and mid == "goal":
                        score += 2
                    score += 1.5 if m["gf"] > 1.06 else -1.5 if m["gf"] < 0.94 else 0
                    if not best or score > best[0]:
                        best = (score, mid, label, p, ask)
                if best:
                    cands.append((s, *best))
            cands.sort(key=lambda c: -c[1])
            chosen = cands[:1] + [c for c in cands[1:2] if net_edge(c[4], c[5]) >= MIN_NET]
            for s, score, mid, label, p, ask in chosen:
                add(store, f'{g["id"]}:{s["id"]}:{mid}', at=now.isoformat(timespec="minutes"), start=g.get("start") or g["date"],
                    game=f'{g["away"]} @ {g["home"]}', gid=g["id"], pid=s["id"], label=f'{s["name"]} {label}', market=mid,
                    p=round(p, 4), ask=ask, edge=round(net_edge(p, ask), 4))
    # settle from game logs
    sk = {s["id"]: s for s in out["skaters"]}
    finished = {gg[8] for t in out["teams"] for gg in t["games"] if len(gg) > 8}
    for key, pk in store.items():
        if pk["status"] != "open" or pk["gid"] not in finished:
            continue
        s = sk.get(pk["pid"])
        row = next((r for r in (s["log"] if s else []) if len(r) > 13 and r[13] == pk["gid"]), None)
        if not row:
            settle(store, key, None)
            continue
        settle(store, key, {"goal": row[3] > 0, "point": row[5] > 0, "assist": row[4] > 0}[pk["market"]])
    save("nhl", store)
    return summary(store)
