#!/usr/bin/env python3
"""
eSoccer Radar — data for the Kalshi eSoccer markets (Valkyrie Cup, Valhalla Cup, Valhalla Cup 4).

Source: Kalshi public API, series KXESOCCERGAME (settled by Drafted.gg). Every match is one event with
three markets: player A wins, player B wins, tie. Settled markets give the result; open markets give
the current Yes prices.

Builds: sequential Elo ratings with a fitted draw model, per-player form, streaks, daily Elo candles,
head-to-head records, team usage, and model probabilities vs Kalshi prices for upcoming matches.
A leak-free backtest calibrates the model.

Usage: python nhl_dashboard/fetch_esoccer.py [--days 30]
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

API = "https://api.elections.kalshi.com/trade-api/v2"
SERIES = "KXESOCCERGAME"
HERE = Path(__file__).parent
CACHE = HERE / "cache" / "esoccer_matches.json"
OUT = HERE / "site" / "esoccer" / "data" / "esoccer.json"
MONTHS = {m: i for i, m in enumerate(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], 1)}
UA = {"User-Agent": "esoccer-radar/1.0", "Accept": "application/json"}


def get_json(url, tries=7):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and i < tries - 1:
                time.sleep(2.5 * (i + 1))
                continue
            raise
        except Exception:
            if i < tries - 1:
                time.sleep(2 * (i + 1))
                continue
            raise


def fetch_markets(min_close_ts: int | None, status: str | None = None):
    rows, cur = [], None
    while True:
        q = {"series_ticker": SERIES, "limit": "1000"}
        if min_close_ts:
            q["min_close_ts"] = str(min_close_ts)
        if status:
            q["status"] = status
        if cur:
            q["cursor"] = cur
        d = get_json(f"{API}/markets?" + urllib.parse.urlencode(q))
        rows.extend(d.get("markets", []))
        cur = d.get("cursor")
        time.sleep(0.6)
        if not cur or not d.get("markets"):
            break
    return rows


def money(x):
    try:
        return round(float(x), 4)
    except (TypeError, ValueError):
        return None


# event suffix: 26NOV270750TRINGIGI  -> date 2026-11-27, 07:50 ET, codes TRIN / GIGI
EV_RE = re.compile(r"^(\d{2})([A-Z]{3})(\d{2})(\d{4})([A-Z0-9]+)$")
TITLE_RE = re.compile(r"^(.*) \((.+)\) wins$")
TOUR_RE = re.compile(r"professional (.+?) \d{4} Week")
TIME_RE = re.compile(r"scheduled for (\w{3} \d{1,2}, \d{4}) at (\d{1,2}:\d{2} [AP]M) (E[SD]T)")


def parse_events(rows):
    ev = defaultdict(list)
    for m in rows:
        ev[m["event_ticker"]].append(m)
    out = {}
    for et, ms in ev.items():
        suf = et.split("-", 1)[1]
        mm = EV_RE.match(suf)
        if not mm:
            continue
        rules = ms[0].get("rules_primary", "")
        tour = (TOUR_RE.search(rules) or [None, "?"])[1]
        tm = TIME_RE.search(rules)
        if tm:
            local = datetime.strptime(f"{tm.group(1)} {tm.group(2)}", "%b %d, %Y %I:%M %p")
            off = 5 if tm.group(3) == "EST" else 4
            start = (local + timedelta(hours=off)).replace(tzinfo=timezone.utc)
        else:
            y, mon, d, hm = 2000 + int(mm.group(1)), MONTHS[mm.group(2)], int(mm.group(3)), mm.group(4)
            start = datetime(y, mon, d, int(hm[:2]), int(hm[2:]), tzinfo=timezone.utc) + timedelta(hours=5)
        sides, tie = {}, None
        for m in ms:
            code = m["ticker"].rsplit("-", 1)[1]
            if code == "TIE":
                tie = m
                continue
            t = TITLE_RE.match(m.get("title") or "")
            if t:
                sides[code] = dict(team=t.group(1), player=t.group(2), m=m)
        if len(sides) != 2 or not tie:
            continue
        # player order as written in the rules: "<A> vs <B>"
        codes = list(sides)
        rv = re.search(r"in the (.+?) \((.+?)\) vs (.+?) \((.+?)\) professional", rules)
        if rv:
            first = rv.group(2)
            codes.sort(key=lambda c: 0 if sides[c]["player"] == first else 1)
        a, b = sides[codes[0]], sides[codes[1]]
        status = "open" if any(x["m"].get("status") == "active" for x in (a, b)) or tie.get("status") == "active" else "closed"
        res = None
        if a["m"].get("result") == "yes":
            res = "A"
        elif b["m"].get("result") == "yes":
            res = "B"
        elif tie.get("result") == "yes":
            res = "T"
        out[et] = dict(
            id=et, tour=tour, start=start.isoformat(timespec="minutes").replace("+00:00", "Z"),
            a=a["player"], b=b["player"], ta=a["team"], tb=b["team"], res=res, status=status,
            pa=dict(ask=money(a["m"].get("yes_ask_dollars")), bid=money(a["m"].get("yes_bid_dollars"))),
            pb=dict(ask=money(b["m"].get("yes_ask_dollars")), bid=money(b["m"].get("yes_bid_dollars"))),
            pt=dict(ask=money(tie.get("yes_ask_dollars")), bid=money(tie.get("yes_bid_dollars"))),
        )
    return out


# ------------------------------------------------------------------ model
def expected(ra, rb):
    return 1.0 / (1.0 + 10 ** ((rb - ra) / 400.0))


def probs(ra, rb, d0, w):
    """Win/draw/loss from Elo: draw probability falls as the gap grows."""
    e = expected(ra, rb)
    pd = d0 * math.exp(-((ra - rb) / w) ** 2)
    pa = max(1e-4, e - pd / 2)
    pb = max(1e-4, 1 - e - pd / 2)
    s = pa + pb + pd
    return pa / s, pd / s, pb / s


KPAIR = 40  # weight of the Elo prior when blending with the pair's own head-to-head record (backtested)


def blend_pair(pa, pd, pb, rec):
    """rec = [wins A, draws, wins B] for this exact pairing."""
    n = sum(rec)
    if not n:
        return pa, pd, pb
    return tuple((x + KPAIR * y) / (n + KPAIR) for x, y in zip(rec, (pa, pd, pb)))


def run_elo(matches, K, d0, w, record=False, pair=True):
    R = defaultdict(lambda: 1500.0)
    n_seen = defaultdict(int)
    H = defaultdict(lambda: [0, 0, 0])
    ll, rows = 0.0, []
    hist = defaultdict(list)  # player -> [(iso, rating)]
    for m in matches:
        a, b = m["a"], m["b"]
        pa, pd, pb = probs(R[a], R[b], d0, w)
        key = (a, b) if a < b else (b, a)
        h = H[key]
        rec = h if key[0] == a else [h[2], h[1], h[0]]
        if pair:
            pa, pd, pb = blend_pair(pa, pd, pb, rec)
        if n_seen[a] >= 10 and n_seen[b] >= 10:
            p = {"A": pa, "T": pd, "B": pb}[m["res"]]
            ll -= math.log(max(p, 1e-9))
            rows.append((pa, pd, pb, m["res"]))
        s = {"A": 1.0, "T": 0.5, "B": 0.0}[m["res"]]
        e = expected(R[a], R[b])
        ka = K * (1.6 if n_seen[a] < 20 else 1.0)
        kb = K * (1.6 if n_seen[b] < 20 else 1.0)
        R[a] += ka * (s - e)
        R[b] -= kb * (s - e)
        n_seen[a] += 1
        n_seen[b] += 1
        h[{"A": 0, "T": 1, "B": 2}[m["res"]] if key[0] == a else {"A": 2, "T": 1, "B": 0}[m["res"]]] += 1
        if record:
            hist[a].append((m["start"], R[a]))
            hist[b].append((m["start"], R[b]))
    return R, ll, rows, hist, n_seen


def fit(matches):
    draws = sum(1 for m in matches if m["res"] == "T") / max(1, len(matches))
    best = None
    for K in (12, 16, 20, 24, 32):
        for dm in (0.9, 1.0, 1.1, 1.2):
            for w in (250, 400, 600, 900):
                _, ll, rows, _, _ = run_elo(matches, K, min(0.6, draws * dm), w, pair=False)
                if rows and (best is None or ll / len(rows) < best[0]):
                    best = (ll / len(rows), K, min(0.6, draws * dm), w)
    return dict(K=best[1], d0=round(best[2], 4), w=best[3], logloss=round(best[0], 4), drawRate=round(draws, 4))


def calibration(rows):
    def table(idx, outcome, edges):
        out = []
        for lo, hi in zip(edges, edges[1:]):
            sel = [r for r in rows if lo <= r[idx] < hi]
            if len(sel) >= 40:
                out.append([lo, hi, len(sel), round(sum(r[idx] for r in sel) / len(sel), 3),
                            round(sum(1 for r in sel if r[3] == outcome) / len(sel), 3)])
        return out
    win = table(0, "A", [0, .1, .2, .3, .4, .5, .6, .7, .8, .9, 1.01])
    draw = table(1, "T", [0, .1, .15, .2, .25, .3, .35, 1.01])
    brier = sum(((r[0] - (r[3] == "A")) ** 2 + (r[1] - (r[3] == "T")) ** 2 + (r[2] - (r[3] == "B")) ** 2) for r in rows) / max(1, len(rows))
    n = max(1, len(rows))
    fa, ft, fb = (sum(1 for r in rows if r[3] == k) / n for k in ("A", "T", "B"))
    base = sum(((fa - (r[3] == "A")) ** 2 + (ft - (r[3] == "T")) ** 2 + (fb - (r[3] == "B")) ** 2) for r in rows) / n
    return dict(n=len(rows), win=win, draw=draw, brier=round(brier, 4), brierBase=round(base, 4))


def form_label(delta7, exp_diff10):
    """delta7 = Elo change over the last 7 days; exp_diff10 = points above expectation over last 10."""
    score = delta7 / 4 + exp_diff10 * 6
    if score >= 12:
        return "hot", round(score)
    if score >= 4:
        return "up", round(score)
    if score <= -12:
        return "cold", round(score)
    if score <= -4:
        return "down", round(score)
    return "flat", round(score)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30)
    args = ap.parse_args()
    now = datetime.now(timezone.utc)
    t0 = time.time()

    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    known_closed = {k for k, v in cache.items() if v.get("res")}
    # incremental: only markets closing after the newest settled match we hold (minus a day of slack)
    newest = max((v["start"] for v in cache.values() if v.get("res")), default=None)
    since = (datetime.fromisoformat(newest.replace("Z", "+00:00")) - timedelta(days=1)) if newest else now - timedelta(days=args.days)
    rows = fetch_markets(int(since.timestamp()))
    fresh = parse_events(rows)
    cache.update({k: v for k, v in fresh.items() if k not in known_closed or v.get("res")})
    cutoff = (now - timedelta(days=args.days)).isoformat()
    cache = {k: v for k, v in cache.items() if v["start"] >= cutoff[:16] or v["status"] == "open"}
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(cache, separators=(",", ":")))
    print(f"markets fetched {len(rows)}, matches cached {len(cache)}", file=sys.stderr)

    done = sorted([m for m in cache.values() if m.get("res")], key=lambda m: m["start"])
    upcoming = sorted([m for m in cache.values() if not m.get("res") and m["status"] == "open"], key=lambda m: m["start"])

    params = fit(done)
    R, ll, rows_bt, hist, n_seen = run_elo(done, params["K"], params["d0"], params["w"], record=True)
    params["logloss"] = round(ll / max(1, len(rows_bt)), 4)
    params["kPair"] = KPAIR
    calib = calibration(rows_bt)
    print(f"model {params} calib n={calib['n']} brier={calib['brier']}", file=sys.stderr)

    # ---- per-player aggregates
    P = defaultdict(lambda: dict(w=0, d=0, l=0, gp=0, res=[], teams=defaultdict(lambda: [0, 0, 0]), tours=set(),
                                 hours=defaultdict(lambda: [0, 0, 0]), exp=[]))
    h2h = defaultdict(lambda: [0, 0, 0])  # (a,b) -> wins a, draws, wins b
    Rrun = defaultdict(lambda: 1500.0)
    seen = defaultdict(int)
    for m in done:
        a, b, r = m["a"], m["b"], m["res"]
        ea = expected(Rrun[a], Rrun[b])
        sa = {"A": 1.0, "T": 0.5, "B": 0.0}[r]
        hour = int(m["start"][11:13])
        for me, opp, team, s, e in ((a, b, m["ta"], sa, ea), (b, a, m["tb"], 1 - sa, 1 - ea)):
            p = P[me]
            p["gp"] += 1
            k = "w" if s == 1 else "d" if s == 0.5 else "l"
            p[k] += 1
            p["res"].append([m["start"], opp, team, {"w": "W", "d": "D", "l": "L"}[k], m["id"]])
            p["teams"][team][{"w": 0, "d": 1, "l": 2}[k]] += 1
            p["hours"][hour][{"w": 0, "d": 1, "l": 2}[k]] += 1
            p["tours"].add(m["tour"])
            p["exp"].append(s - e)
        key = tuple(sorted((a, b)))
        if key[0] == a:
            h2h[key][0 if r == "A" else 1 if r == "T" else 2] += 1
        else:
            h2h[key][2 if r == "A" else 1 if r == "T" else 0] += 1
        K = params["K"]
        Rrun[a] += K * (1.6 if seen[a] < 20 else 1) * (sa - ea)
        Rrun[b] -= K * (1.6 if seen[b] < 20 else 1) * (sa - ea)
        seen[a] += 1
        seen[b] += 1

    players = []
    for name, p in P.items():
        hs = hist[name]
        rating = R[name]
        def rating_at(iso):
            v = 1500.0
            for t, r in hs:
                if t <= iso:
                    v = r
                else:
                    break
            return v
        r24 = rating_at((now - timedelta(hours=24)).isoformat()[:16])
        r7 = rating_at((now - timedelta(days=7)).isoformat()[:16])
        last10 = p["res"][-10:]
        exp10 = sum(p["exp"][-10:])
        form, fscore = form_label(rating - r7, exp10 / max(1, len(p["exp"][-10:])))
        streak_kind, streak = None, 0
        for r in reversed(p["res"]):
            if streak_kind is None:
                streak_kind, streak = r[3], 1
            elif r[3] == streak_kind:
                streak += 1
            else:
                break
        # daily candles of Elo
        candles, cur, o, h, l = [], None, None, None, None
        prev = 1500.0
        for t, r in hs:
            day = t[:10]
            if day != cur:
                if cur:
                    candles.append([cur, round(o, 1), round(h, 1), round(l, 1), round(prev, 1)])
                cur, o, h, l = day, prev, prev, prev
            h, l, prev = max(h, r), min(l, r), r
        if cur:
            candles.append([cur, round(o, 1), round(h, 1), round(l, 1), round(prev, 1)])
        teams = sorted(([t, *v] for t, v in p["teams"].items()), key=lambda x: -(x[1] + x[2] + x[3]))
        players.append(dict(
            name=name, tours=sorted(p["tours"]), gp=p["gp"], w=p["w"], d=p["d"], l=p["l"],
            winPct=round(p["w"] / p["gp"], 4), ppg=round((3 * p["w"] + p["d"]) / p["gp"], 3),
            elo=round(rating, 1), elo24=round(rating - r24, 1), elo7=round(rating - r7, 1),
            form=form, trend=fscore, streak=f"{streak_kind}{streak}" if streak_kind else "",
            l10="".join(r[3] for r in last10), l20w=sum(1 for r in p["res"][-20:] if r[3] == "W"),
            l20d=sum(1 for r in p["res"][-20:] if r[3] == "D"), l20l=sum(1 for r in p["res"][-20:] if r[3] == "L"),
            lastPlayed=p["res"][-1][0] if p["res"] else None,
            teams=teams[:8], hours=[[hh, *v] for hh, v in sorted(p["hours"].items())],
            candles=candles[-31:], log=p["res"][-40:],
        ))
    players.sort(key=lambda x: -x["elo"])
    rank = {p["name"]: i + 1 for i, p in enumerate(players)}
    for p in players:
        p["rank"] = rank[p["name"]]

    # ---- upcoming with model probabilities
    up = []
    for m in upcoming:
        key = tuple(sorted((m["a"], m["b"])))
        rec = h2h.get(key, [0, 0, 0])
        if key[0] != m["a"]:
            rec = [rec[2], rec[1], rec[0]]
        pa, pd, pb = blend_pair(*probs(R[m["a"]], R[m["b"]], params["d0"], params["w"]), rec)
        up.append(dict(**{k: m[k] for k in ("id", "tour", "start", "a", "b", "ta", "tb", "pa", "pb", "pt")},
                       ma=round(pa, 4), md=round(pd, 4), mb=round(pb, 4), h2h=rec,
                       ea=round(R[m["a"]], 1), eb=round(R[m["b"]], 1)))

    recent = [dict(**{k: m[k] for k in ("id", "tour", "start", "a", "b", "ta", "tb", "res")}) for m in done[-300:]]
    h2h_out = [[k[0], k[1], *v] for k, v in h2h.items() if sum(v) >= 3]
    tours = defaultdict(lambda: dict(matches=0, draws=0, players=set()))
    for m in done:
        t = tours[m["tour"]]
        t["matches"] += 1
        t["draws"] += m["res"] == "T"
        t["players"].update((m["a"], m["b"]))

    out = dict(
        generatedAt=now.isoformat(timespec="seconds"), source="Kalshi KXESOCCERGAME (settled by Drafted.gg)",
        days=args.days, matches=len(done), firstMatch=done[0]["start"] if done else None, lastMatch=done[-1]["start"] if done else None,
        model=dict(**params, calibration=calib),
        tournaments=[dict(name=k, matches=v["matches"], drawRate=round(v["draws"] / max(1, v["matches"]), 3), players=len(v["players"])) for k, v in sorted(tours.items())],
        players=players, upcoming=up, recent=recent, h2h=h2h_out,
        links=dict(series="https://kalshi.com/markets/kxesoccergame/esoccer-game"),
    )
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"OK {OUT} ({OUT.stat().st_size / 1e6:.2f} MB) players={len(players)} upcoming={len(up)} in {time.time() - t0:.0f}s", file=sys.stderr)


if __name__ == "__main__":
    main()
