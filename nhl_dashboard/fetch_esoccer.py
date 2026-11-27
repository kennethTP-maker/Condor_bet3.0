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
SPORTS = {
    "esoccer": dict(name="eSoccer Radar", series="KXESOCCERGAME", kslug="esoccer-game", draws=True, unit="goal",
                    drafted=["valkyrie-cup", "valhalla-cup"], lines=[4.5, 5.5, 6.5], out="esoccer"),
    "ebasketball": dict(name="eBasketball Radar", series="KXEBASKETBALLGAME", kslug="ebasketball-game", draws=False, unit="point",
                        drafted=["valhalla-league"], lines=None, out="ebasketball"),
}
SPORT = SPORTS["esoccer"]
SERIES = SPORT["series"]
HERE = Path(__file__).parent
CACHE = HERE / "cache" / "esoccer_matches.json"
OUT = HERE / "site" / "esoccer" / "data" / "esoccer.json"


def set_sport(key):
    global SPORT, SERIES, CACHE, OUT
    SPORT = SPORTS[key]
    SERIES = SPORT["series"]
    CACHE = HERE / "cache" / f"{key}_matches.json"
    OUT = HERE / "site" / SPORT["out"] / "data" / f"{key}.json"
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
        if len(sides) != 2 or (SPORT["draws"] and not tie):
            continue
        tie = tie or {}
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
        for dm in ((0.9, 1.0, 1.1, 1.2) if draws > 0 else (0.0,)):
            for w in (250, 400, 600, 900):
                _, ll, rows, _, _ = run_elo(matches, K, min(0.6, draws * dm), w, pair=False)
                if rows and (best is None or ll / len(rows) < best[0]):
                    best = (ll / len(rows), K, min(0.6, draws * dm), w)
    if draws == 0:
        best = (best[0], best[1], 0.0, 400)
    return dict(K=best[1], d0=round(best[2], 4), w=best[3], logloss=round(best[0], 4), drawRate=round(draws, 4))


def fit_kpair(matches, params):
    """Weight of the Elo prior vs the pair's own record: chosen on the later half (out of sample)."""
    global KPAIR
    half = len(matches) // 2
    best = None
    for kp in (5, 8, 12, 20, 30, 40, 60):
        KPAIR = kp
        _, ll_all, rows_all, _, _ = run_elo(matches, params["K"], params["d0"], params["w"])
        _, ll_1, rows_1, _, _ = run_elo(matches[:half], params["K"], params["d0"], params["w"])
        n2 = len(rows_all) - len(rows_1)
        if n2 > 0 and (best is None or (ll_all - ll_1) / n2 < best[0]):
            best = ((ll_all - ll_1) / n2, kp)
    KPAIR = best[1] if best else 40
    return KPAIR


def signal_hits(pick_p, gap, elo_is_pick, hn, h2r, all3, fp, fo):
    """Which high-confidence signals a pick meets (same rules in the page)."""
    out = []
    if pick_p >= 0.70: out.append("m70")
    if pick_p >= 0.65: out.append("m65")
    if pick_p >= 0.65 and all3: out.append("m65all3")
    if pick_p >= 0.60 and all3: out.append("m60all3")
    if elo_is_pick and gap >= 200: out.append("elo200")
    if elo_is_pick and gap >= 150: out.append("elo150")
    if hn >= 10 and h2r >= 0.70: out.append("h2h70")
    if pick_p >= 0.60 and fp == "hot" and fo == "cold": out.append("hotcold")
    return out


def agreement_backtest(matches, params):
    """Leak-free hit rates of the winner pick by how Elo, head-to-head and form line up,
    and by high-confidence signal."""
    import bisect
    R = defaultdict(lambda: 1500.0)
    n = defaultdict(int)
    H = defaultdict(lambda: [0, 0, 0])
    L = defaultdict(list)
    hist = defaultdict(lambda: ([], []))
    ex = defaultdict(list)
    st = {k: [0, 0] for k in ("all", "agree", "all3", "disElo", "disH2h", "p60", "p70")}
    sig = defaultdict(lambda: [0, 0])

    def form(pl, t):
        ts, rs = hist[pl]
        t7 = (datetime.fromisoformat(t.replace("Z", "")) - timedelta(days=7)).isoformat()[:16]
        i = bisect.bisect_right(ts, t7)
        r7 = rs[i - 1] if i else 1500.0
        e = ex[pl][-10:]
        return form_label(R[pl] - r7, sum(e) / len(e) if e else 0)[0]

    for m in matches:
        a, b, res = m["a"], m["b"], m["res"]
        key = (a, b) if a < b else (b, a)
        h = H[key]
        rec = h if key[0] == a else [h[2], h[1], h[0]]
        pa, pd, pb = blend_pair(*probs(R[a], R[b], params["d0"], params["w"]), rec)
        if n[a] >= 15 and n[b] >= 15:
            model = "A" if pa >= pb else "B"
            elo = "A" if R[a] >= R[b] else "B"
            h2 = None if sum(rec) < 3 or rec[0] == rec[2] else ("A" if rec[0] > rec[2] else "B")
            fa, fb = sum(L[a][-10:]) / max(1, len(L[a][-10:])), sum(L[b][-10:]) / max(1, len(L[b][-10:]))
            fm = None if fa == fb else ("A" if fa > fb else "B")

            def add(k, pick):
                st[k][0] += 1
                st[k][1] += pick == res
            add("all", model)
            if h2 and h2 == elo:
                add("agree", elo)
                if fm == elo:
                    add("all3", elo)
            if h2 and h2 != elo:
                add("disElo", elo)
                add("disH2h", h2)
            if max(pa, pb) >= 0.6:
                add("p60", model)
            if max(pa, pb) >= 0.7:
                add("p70", model)
            hn = sum(rec)
            hw = rec[0] if model == "A" else rec[2]
            fp, fo = (form(a, m["start"]), form(b, m["start"])) if model == "A" else (form(b, m["start"]), form(a, m["start"]))
            for k in signal_hits(max(pa, pb), abs(R[a] - R[b]), elo == model, hn, hw / hn if hn else 0,
                                 h2 == elo == fm == model, fp, fo):
                sig[k][0] += 1
                sig[k][1] += model == res
        s = {"A": 1.0, "T": 0.5, "B": 0.0}[res]
        e = expected(R[a], R[b])
        for pl, d in ((a, s - e), (b, e - s)):
            R[pl] += params["K"] * (1.6 if n[pl] < 20 else 1.0) * d
            n[pl] += 1
            ex[pl].append(d)
            hist[pl][0].append(m["start"])
            hist[pl][1].append(R[pl])
        L[a].append(s)
        L[b].append(1 - s)
        h[{"A": 0, "T": 1, "B": 2}[res] if key[0] == a else {"A": 2, "T": 1, "B": 0}[res]] += 1
    out = {k: [v[0], round(v[1] / v[0], 4) if v[0] else None] for k, v in st.items()}
    out["signals"] = {k: [v[0], round(v[1] / v[0], 4)] for k, v in sig.items() if v[0] >= 100}
    return out

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


LINES = [4.5, 5.5, 6.5]


def goal_stats(rows, now):
    """rows: [iso, gf, ga, h1f, h1a] for matches with a Drafted.gg score."""
    if not rows:
        return None
    def agg(rs):
        n = len(rs)
        if not n:
            return None
        tot = [r[1] + r[2] for r in rs]
        h1 = [r for r in rs if r[3] is not None]
        return dict(n=n, gf=round(sum(r[1] for r in rs) / n, 2), ga=round(sum(r[2] for r in rs) / n, 2),
                    tot=round(sum(tot) / n, 2), btts=round(sum(1 for r in rs if r[1] and r[2]) / n, 3),
                    o45=round(sum(1 for t in tot if t > 4.5) / n, 3), o55=round(sum(1 for t in tot if t > 5.5) / n, 3),
                    o65=round(sum(1 for t in tot if t > 6.5) / n, 3), cs=round(sum(1 for r in rs if r[2] == 0) / n, 3),
                    h1gf=round(sum(r[3] for r in h1) / len(h1), 2) if h1 else None,
                    ov=[round(sum(1 for t in tot if t > ln) / n, 3) for ln in LINES])
    day = (now - timedelta(hours=24)).isoformat()[:16]
    return dict(all=agg(rows), d24=agg([r for r in rows if r[0] >= day]), l10=agg(rows[-10:]))


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
    ap.add_argument("--sport", choices=list(SPORTS), default="esoccer")
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--drafted-hours", type=int, default=48, help="hours of Drafted.gg score pages to keep current (0 = skip)")
    args = ap.parse_args()
    set_sport(args.sport)
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

    # ---- Drafted.gg scores, matched to Kalshi results by players + kick-off time (±7 min)
    dmatch = {"drafted": 0, "matched": 0, "agree": 0}
    if args.drafted_hours > 0:
        sys.path.insert(0, str(HERE))
        import drafted
        dg = drafted.update(args.drafted_hours, lambda m: print(m, file=sys.stderr), slugs=SPORT["drafted"])
        dmatch["drafted"] = len(dg)
        idx = defaultdict(list)
        for g in dg:
            if g.get("t"):
                idx[frozenset((g["a"], g["b"]))].append(g)
        for m in done:
            cands = idx.get(frozenset((m["a"], m["b"])))
            if not cands:
                continue
            ts = datetime.fromisoformat(m["start"].replace("Z", "+00:00"))
            best = min(cands, key=lambda g: abs(datetime.fromisoformat(g["t"].replace("Z", "+00:00")) - ts))
            if abs(datetime.fromisoformat(best["t"].replace("Z", "+00:00")) - ts) > timedelta(minutes=7):
                continue
            flip = best["a"] != m["a"]
            ga, gb = (best["sb"], best["sa"]) if flip else (best["sa"], best["sb"])
            h1 = h2 = None
            if best.get("h1") is not None:
                h1 = [best["h1"][1], best["h1"][0]] if flip else best["h1"]
                h2 = [best["h2"][1], best["h2"][0]] if flip else best["h2"]
            m["score"] = [ga, gb]
            m["h1"] = h1
            dmatch["matched"] += 1
            dmatch["agree"] += (m["res"] == "A") == (ga > gb) and (m["res"] == "T") == (ga == gb)
        print(f"drafted scores matched to Kalshi: {dmatch}", file=sys.stderr)
    upcoming = sorted([m for m in cache.values() if not m.get("res") and m["status"] == "open"], key=lambda m: m["start"])

    params = fit(done)
    fit_kpair(done, params)
    R, ll, rows_bt, hist, n_seen = run_elo(done, params["K"], params["d0"], params["w"], record=True)
    params["logloss"] = round(ll / max(1, len(rows_bt)), 4)
    params["kPair"] = KPAIR
    calib = calibration(rows_bt)
    params["agree"] = agreement_backtest(done, params)
    print(f"model {params} calib n={calib['n']} brier={calib['brier']}", file=sys.stderr)

    # ---- per-player aggregates
    global LINES
    if SPORT["lines"]:
        LINES = SPORT["lines"]
    else:
        tots = sorted(m["score"][0] + m["score"][1] for m in done if m.get("score"))
        med = tots[len(tots) // 2] if tots else 150
        LINES = [med - 10.5, med - 0.5, med + 9.5]
    P = defaultdict(lambda: dict(w=0, d=0, l=0, gp=0, res=[], teams=defaultdict(lambda: [0, 0, 0]), tours=set(),
                                 hours=defaultdict(lambda: [0, 0, 0]), exp=[], goals=[]))
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
            sc = m.get("score")
            gf_ga = None
            if sc:
                gf_ga = sc if me == a else [sc[1], sc[0]]
                h1 = m.get("h1")
                h1f = (h1[0] if me == a else h1[1]) if h1 else None
                h1a = (h1[1] if me == a else h1[0]) if h1 else None
                p["goals"].append([m["start"], gf_ga[0], gf_ga[1], h1f, h1a])
            p["res"].append([m["start"], opp, team, {"w": "W", "d": "D", "l": "L"}[k], m["id"], gf_ga])
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
            candles=candles[-31:], log=p["res"][-40:], goals=goal_stats(p["goals"], now),
        ))
    players.sort(key=lambda x: -x["elo"])
    rank = {p["name"]: i + 1 for i, p in enumerate(players)}
    for p in players:
        p["rank"] = rank[p["name"]]

    pl_goals = {p["name"]: p["goals"] for p in players}
    # ---- upcoming with model probabilities
    up = []
    for m in upcoming:
        key = tuple(sorted((m["a"], m["b"])))
        rec = h2h.get(key, [0, 0, 0])
        if key[0] != m["a"]:
            rec = [rec[2], rec[1], rec[0]]
        pa, pd, pb = blend_pair(*probs(R[m["a"]], R[m["b"]], params["d0"], params["w"]), rec)
        ga_, gb_ = (pl_goals.get(m["a"]) or {}).get("all"), (pl_goals.get(m["b"]) or {}).get("all")
        xg = [round((ga_["gf"] + gb_["ga"]) / 2, 2), round((gb_["gf"] + ga_["ga"]) / 2, 2)] if ga_ and gb_ else None
        up.append(dict(**{k: m[k] for k in ("id", "tour", "start", "a", "b", "ta", "tb", "pa", "pb", "pt")},
                       ma=round(pa, 4), md=round(pd, 4), mb=round(pb, 4), h2h=rec, xg=xg,
                       ea=round(R[m["a"]], 1), eb=round(R[m["b"]], 1)))

    recent = [dict(**{k: m[k] for k in ("id", "tour", "start", "a", "b", "ta", "tb", "res")}, score=m.get("score"), h1=m.get("h1")) for m in done[-300:]]
    # ---- matches that started in the last 35 min and are already settled:
    # pre-match probabilities (ratings without those results) so the page can
    # keep showing them for 30 min with the pick's outcome
    cut = (now - timedelta(minutes=35)).isoformat()[:16]
    just = [m for m in done if m["start"] >= cut]
    just_out = []
    if just:
        pre = [m for m in done if m["start"] < cut]
        R0 = run_elo(pre, params["K"], params["d0"], params["w"])[0]
        H0 = defaultdict(lambda: [0, 0, 0])
        for m in pre:
            key = tuple(sorted((m["a"], m["b"])))
            r = m["res"]
            H0[key][(0 if r == "A" else 1 if r == "T" else 2) if key[0] == m["a"] else (2 if r == "A" else 1 if r == "T" else 0)] += 1
        for m in just:
            key = tuple(sorted((m["a"], m["b"])))
            rec = list(H0[key]) if key[0] == m["a"] else [H0[key][2], H0[key][1], H0[key][0]]
            pa, pd, pb = blend_pair(*probs(R0[m["a"]], R0[m["b"]], params["d0"], params["w"]), rec)
            ga_, gb_ = (pl_goals.get(m["a"]) or {}).get("all"), (pl_goals.get(m["b"]) or {}).get("all")
            xg = [round((ga_["gf"] + gb_["ga"]) / 2, 2), round((gb_["gf"] + ga_["ga"]) / 2, 2)] if ga_ and gb_ else None
            none = {"ask": None, "bid": None}
            just_out.append(dict(**{k: m[k] for k in ("id", "tour", "start", "a", "b", "ta", "tb")}, pa=none, pb=none, pt=none,
                                 ma=round(pa, 4), md=round(pd, 4), mb=round(pb, 4), h2h=rec, xg=xg,
                                 ea=round(R0[m["a"]], 1), eb=round(R0[m["b"]], 1)))
    h2h_out = [[k[0], k[1], *v] for k, v in h2h.items() if sum(v) >= 3]
    tours = defaultdict(lambda: dict(matches=0, draws=0, players=set()))
    for m in done:
        t = tours[m["tour"]]
        t["matches"] += 1
        t["draws"] += m["res"] == "T"
        t["players"].update((m["a"], m["b"]))

    sys.path.insert(0, str(HERE))
    import picks
    track = picks.esports(args.sport, up, done, now)
    print(f"picks: {track['all']}", file=sys.stderr)

    out = dict(
        picks=track,
        generatedAt=now.isoformat(timespec="seconds"), source=f"Kalshi {SERIES} (settled by Drafted.gg)",
        sport=dict(key=args.sport, name=SPORT["name"], series=SERIES, kslug=SPORT["kslug"], draws=SPORT["draws"],
                   unit=SPORT["unit"], drafted=SPORT["drafted"], lines=LINES),
        days=args.days, matches=len(done), firstMatch=done[0]["start"] if done else None, lastMatch=done[-1]["start"] if done else None,
        model=dict(**params, calibration=calib),
        tournaments=[dict(name=k, matches=v["matches"], drawRate=round(v["draws"] / max(1, v["matches"]), 3), players=len(v["players"])) for k, v in sorted(tours.items())],
        players=players, upcoming=up, justStarted=just_out, recent=recent, h2h=h2h_out, drafted=dmatch,
        links=dict(series=f"https://kalshi.com/markets/{SERIES.lower()}/{SPORT['kslug']}"),
    )
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"OK {OUT} ({OUT.stat().st_size / 1e6:.2f} MB) players={len(players)} upcoming={len(up)} in {time.time() - t0:.0f}s", file=sys.stderr)


if __name__ == "__main__":
    main()
