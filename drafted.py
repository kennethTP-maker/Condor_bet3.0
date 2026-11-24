"""Valhalla League eBasketball results from drafted.gg (Kalshi's settlement source).

drafted.gg renders results server-side (Next.js). Each match in the page payload carries
its id, start time, home/away player and NBA team, final score and quarter scores. Pages
hold 10 matches and are walked backwards with the ``r`` cursor
(base64 of ``match/od:match:<id>``). robots.txt allows this path; requests are spaced out.
"""
from __future__ import annotations

import base64
import json
import re
import time
import urllib.request
from dataclasses import asdict, dataclass, field
from datetime import datetime

from ebasket import Match

BASE = 'https://drafted.gg/en/{league}/results'
LEAGUE_NAME = 'Valhalla League'
UA = 'Mozilla/5.0 (compatible; condor-ebasket-research/1.0)'

_PUSH = re.compile(r'self\.__next_f\.push\(\[1,"(.*?)"\]\)', re.S)


@dataclass
class DraftedMatch:
    id: int
    start: str                 # ISO UTC
    home: str
    home_team: str
    away: str
    away_team: str
    home_score: int
    away_score: int
    quarters: list = field(default_factory=list)   # [(home, away), ...] per quarter

    def to_match(self, league: str = LEAGUE_NAME) -> Match:
        return Match(datetime.fromisoformat(self.start.replace('Z', '+00:00')), league,
                     self.home, self.away, self.home_score, self.away_score)


def _payload(html: str) -> str:
    raw = ''.join(_PUSH.findall(html))
    return json.loads('"' + raw + '"') if raw else ''


def _walk(node, acc):
    if isinstance(node, dict):
        if isinstance(node.get('score'), dict) and isinstance(node.get('home'), dict):
            acc['props'].append(node)
        d = node.get('date')
        if isinstance(d, str) and d.startswith('$D'):
            acc['dates'].append(d[2:])
        for k, v in node.items():
            if k == 'children' and isinstance(v, str):
                acc['strings'].append(v)
            else:
                _walk(v, acc)
    elif isinstance(node, list):
        for v in node:
            if isinstance(v, str) and not v.startswith('$'):
                acc['strings'].append(v)
            else:
                _walk(v, acc)


NBA_TEAMS = {
    'Atlanta Hawks', 'Boston Celtics', 'Brooklyn Nets', 'Charlotte Hornets', 'Chicago Bulls',
    'Cleveland Cavaliers', 'Dallas Mavericks', 'Denver Nuggets', 'Detroit Pistons', 'Golden State Warriors',
    'Houston Rockets', 'Indiana Pacers', 'LA Clippers', 'Los Angeles Clippers', 'Los Angeles Lakers',
    'Memphis Grizzlies', 'Miami Heat', 'Milwaukee Bucks', 'Minnesota Timberwolves', 'New Orleans Pelicans',
    'New York Knicks', 'Oklahoma City Thunder', 'Orlando Magic', 'Philadelphia 76ers', 'Phoenix Suns',
    'Portland Trail Blazers', 'Sacramento Kings', 'San Antonio Spurs', 'Toronto Raptors', 'Utah Jazz',
    'Washington Wizards'}


def parse_results_page(html: str):
    """Returns (matches, end_cursor, has_next). One RSC row per match card."""
    p = _payload(html)
    out = {}
    for row in re.split(r'\n(?=[0-9a-f]+:)', p):
        if '"children":"Match ' not in row:
            continue
        try:
            node = json.loads(row.split(':', 1)[1])
        except ValueError:
            continue
        acc = {'props': [], 'dates': [], 'strings': []}
        _walk(node, acc)
        ids = [int(x[6:]) for x in acc['strings'] if re.fullmatch(r'Match \d+', x)]
        props = [x for x in acc['props'] if isinstance(x.get('score'), dict)]
        if not ids or not props or not acc['dates']:
            continue
        pr = props[0]
        teams = [x for x in acc['strings'] if x in NBA_TEAMS]
        quarters = []
        if isinstance(pr.get('periods'), dict):
            quarters = [(int(q['home']), int(q['away'])) for q in sorted(pr['periods'].get('values', []),
                                                                         key=lambda q: q['number'])]
        try:
            hs, as_ = int(pr['score']['home']), int(pr['score']['away'])
        except (KeyError, TypeError, ValueError):
            continue
        out[ids[0]] = DraftedMatch(ids[0], acc['dates'][0], pr['home']['name'], teams[0] if teams else '',
                                   pr['away']['name'], teams[1] if len(teams) > 1 else '', hs, as_, quarters)
    cur = re.findall(r'"endCursor":"([^"]+)"', p)
    nxt = re.findall(r'"hasNextPage":(true|false)', p)
    return sorted(out.values(), key=lambda m: m.id, reverse=True), (cur[-1] if cur else None), (nxt[-1] == 'true' if nxt else False)


def cursor_for(match_id: int) -> str:
    return base64.b64encode(f'match/od:match:{match_id}'.encode()).decode()


def fetch_page(cursor: str | None = None, league='valhalla-league', timeout=30) -> str:
    url = BASE.format(league=league) + (f'?r={cursor}' if cursor else '')
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode('utf-8', 'replace')
        except Exception:
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f'drafted.gg no responde: {url}')


def crawl(stop_before_id: int = 0, max_pages: int = 10_000, delay: float = 0.6, start_cursor=None,
          on_page=None):
    """Walk results newest → oldest until a match id ≤ stop_before_id or no more pages."""
    cursor, seen = start_cursor, {}
    for page in range(max_pages):
        matches, cursor, has_next = parse_results_page(fetch_page(cursor))
        for m in matches:
            if m.id > stop_before_id:
                seen[m.id] = m
        if on_page:
            on_page(page + 1, matches, cursor)
        if not has_next or not cursor or not matches or min(m.id for m in matches) <= stop_before_id:
            break
        time.sleep(delay)
    return sorted(seen.values(), key=lambda m: m.start)


def save(matches, path):
    json.dump([asdict(m) for m in matches], open(path, 'w'))


def load(path):
    return [DraftedMatch(**{**r, 'quarters': [tuple(q) for q in r['quarters']]}) for r in json.load(open(path))]
