"""
Match scores from Drafted.gg results pages (the organizer that settles Kalshi's eSoccer markets).

The results page accepts `df` / `dt` (ISO date-time range) and shows at most the 10 newest matches of
that range, so we read it in one-hour windows and split a window in half whenever it comes back full.
Each match gives: id, kickoff time, players, teams, final score and goals per half.

Pages: valkyrie-cup (Valkyrie Cup) and valhalla-cup (Valhalla Cup and Valhalla Cup 4).
Finished hours are cached in nhl_dashboard/cache/drafted_<slug>.json and never fetched again.
"""
from __future__ import annotations

import html
import json
import re
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = "https://drafted.gg"
SLUGS = ["valkyrie-cup", "valhalla-cup"]
CACHE_DIR = Path(__file__).parent / "cache"
UA = {"User-Agent": "esoccer-radar/1.0"}
PAGE_MAX = 10

TXT_RE = re.compile(r"([^|]+?) \| ([^|]+?) \| Match (\d+) \| (?:Loading\.\.\. \| )?(\d+) - (\d+) \| ([^|]+?) \| ([^|]+?)(?= \|)")
DATE_RE = re.compile(r'"children":"Match (\d+)"\}\],\["\$","\$L[0-9a-z]+",null,\{"date":"\$D([0-9T:.\-]+Z)"\}\]')
PER_RE = re.compile(r'"children":"Match (\d+)".{0,600}?"periods":\{"type":"(HALF|QUARTER|PERIOD)","values":\[(.*?)\]\}')
VAL_RE = re.compile(r'\{"home":"(\d+)","away":"(\d+)"')
HALF_RE = re.compile(r'"children":"Match (\d+)".{0,600}?"periods":\{"type":"HALF","values":\[\{"home":"(\d+)","away":"(\d+)"[^}]*\},\{"home":"(\d+)","away":"(\d+)"[^}]*\}')


def _get(url, tries=5):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                return r.read().decode("utf-8", "replace")
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(2 * (i + 1))


def parse(page: str) -> dict:
    out = {}
    body = re.sub(r"<script.*?</script>|<style.*?</style>", "", page, flags=re.S)
    text = html.unescape(re.sub(r"<[^>]+>", "\n", body))
    joined = " | ".join(l.strip() for l in text.split("\n") if l.strip())
    for m in TXT_RE.finditer(joined):
        mid = int(m.group(3))
        if mid not in out:
            out[mid] = dict(id=mid, a=m.group(1).strip(), ta=m.group(2).strip(), sa=int(m.group(4)), sb=int(m.group(5)),
                            b=m.group(6).strip(), tb=m.group(7).strip(), t=None, h1=None)
    payload = page.replace('\\"', '"')
    for m in DATE_RE.finditer(payload):
        mid = int(m.group(1))
        if mid in out and not out[mid]["t"]:
            out[mid]["t"] = m.group(2)[:16] + "Z"
    for m in PER_RE.finditer(payload):
        mid = int(m.group(1))
        if mid in out and out[mid]["h1"] is None and m.group(2) != "HALF":
            vals = [[int(a), int(b)] for a, b in VAL_RE.findall(m.group(3))]
            if len(vals) >= 2:
                half = len(vals) // 2
                out[mid]["h1"] = [sum(v[0] for v in vals[:half]), sum(v[1] for v in vals[:half])]
                out[mid]["h2"] = [sum(v[0] for v in vals[half:]), sum(v[1] for v in vals[half:])]
                out[mid]["per"] = vals
    for m in HALF_RE.finditer(payload):
        mid = int(m.group(1))
        if mid in out and out[mid]["h1"] is None:
            out[mid]["h1"] = [int(m.group(2)), int(m.group(3))]
            out[mid]["h2"] = [int(m.group(4)), int(m.group(5))]
    return out


def fetch_window(slug, start: datetime, end: datetime, depth=0):
    q = f"df={start.strftime('%Y-%m-%dT%H:%M:%S.000Z')}&dt={end.strftime('%Y-%m-%dT%H:%M:%S.999Z')}"
    got = parse(_get(f"{BASE}/{slug}/results?{q}"))
    time.sleep(0.35)
    if len(got) >= PAGE_MAX and depth < 6 and (end - start) > timedelta(minutes=4):
        mid = start + (end - start) / 2
        got = {**fetch_window(slug, start, mid - timedelta(seconds=1), depth + 1), **fetch_window(slug, mid, end, depth + 1)}
    return got


def update(hours_back=72, log=print, slugs=None) -> list[dict]:
    """Return all cached Drafted matches (both pages) after fetching hours not yet complete in cache."""
    now = datetime.now(timezone.utc)
    all_matches = []
    for slug in (slugs or SLUGS):
        path = CACHE_DIR / f"drafted_{slug}.json"
        c = json.loads(path.read_text()) if path.exists() else {"done": [], "matches": {}}
        done = set(c["done"])
        start = (now - timedelta(hours=hours_back)).replace(minute=0, second=0, microsecond=0)
        h, n_req = start, 0
        while h < now:
            key = h.strftime("%Y-%m-%dT%H")
            if key not in done:
                end = h + timedelta(minutes=59, seconds=59)
                try:
                    got = fetch_window(slug, h, end)
                    n_req += 1
                except Exception as e:
                    log(f"drafted {slug} {key}: {e}")
                    got = {}
                for mid, m in got.items():
                    m["slug"] = slug
                    c["matches"][str(mid)] = m
                if end < now - timedelta(minutes=30):  # hour finished: never fetch again
                    done.add(key)
            h += timedelta(hours=1)
        cutoff = (now - timedelta(days=35)).strftime("%Y-%m-%dT%H")
        c["done"] = sorted(k for k in done if k >= cutoff)
        c["matches"] = {k: v for k, v in c["matches"].items() if (v.get("t") or "9") >= cutoff}
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(c, separators=(",", ":")))
        log(f"drafted {slug}: {n_req} hour windows fetched, {len(c['matches'])} matches cached")
        all_matches.extend(c["matches"].values())
    return all_matches
