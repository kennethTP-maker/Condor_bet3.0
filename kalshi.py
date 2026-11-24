"""Kalshi public market data for eBasketball (series KXEBASKETBALLGAME, Valhalla League).

Only public, unauthenticated endpoints are used: markets, candlesticks. No orders are
placed. Kalshi publishes the winner of each game, not the score, so these games feed the
win-probability model in ``winmodel.py`` rather than the points model in ``ebasket.py``.
"""
from __future__ import annotations

import json
import math
import re
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

BASE = 'https://api.elections.kalshi.com/trade-api/v2'
SERIES = 'KXEBASKETBALLGAME'
ET = ZoneInfo('America/New_York')
_TICKER_TIME = re.compile(r'-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})')
_MONTHS = {m: i for i, m in enumerate(
    ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'], 1)}
_SIDE = re.compile(r'^(?P<team>.*?)\s*\((?P<player>[^)]+)\)\s*$')
_MATCHUP = re.compile(r'wins the (?P<a>.+?) vs (?P<b>.+?) professional (?P<league>.+?) \d{4}')


def taker_fee(price: float) -> float:
    """Kalshi quadratic taker fee per contract (0.07·P·(1−P)); the exchange rounds up per order."""
    return 0.07 * price * (1 - price)


def scheduled_start(ticker: str) -> datetime | None:
    m = _TICKER_TIME.search(ticker)
    if not m:
        return None
    yy, mon, dd, hh, mi = m.groups()
    local = datetime(2000 + int(yy), _MONTHS[mon], int(dd), int(hh), int(mi), tzinfo=ET)
    return local.astimezone(timezone.utc)


def split_side(label: str):
    m = _SIDE.match(label.strip())
    return (m['team'].strip(), m['player'].strip()) if m else ('', label.strip())


@dataclass
class KalshiGame:
    event_ticker: str
    start: datetime
    league: str
    team_a: str
    player_a: str
    team_b: str
    player_b: str
    ticker_a: str
    ticker_b: str
    winner: str | None = None          # 'A', 'B' or None (open / void)
    volume: float = 0.0
    # Market snapshot (filled by candles / live quotes); prices in dollars per $1 contract.
    ask_a: float | None = None
    bid_a: float | None = None
    ask_b: float | None = None
    bid_b: float | None = None

    @property
    def label(self):
        return f'{self.team_a} ({self.player_a}) vs {self.team_b} ({self.player_b})'


def games_from_markets(markets) -> list[KalshiGame]:
    """Pair the two binary markets of each event into one game (side A = first listed)."""
    by_event: dict[str, list] = {}
    for m in markets:
        by_event.setdefault(m['event_ticker'], []).append(m)
    games = []
    for ev, ms in by_event.items():
        if len(ms) != 2:
            continue
        mm = _MATCHUP.search(ms[0].get('rules_primary', ''))
        if not mm:
            continue
        (team_a, player_a), (team_b, player_b) = split_side(mm['a']), split_side(mm['b'])
        side = {}
        for m in ms:
            _, p = split_side(m.get('yes_sub_title', ''))
            side['A' if p == player_a else 'B' if p == player_b else '?'] = m
        if set(side) != {'A', 'B'}:
            continue
        start = scheduled_start(ev)
        if start is None:
            continue
        g = KalshiGame(ev, start, mm['league'].strip(), team_a, player_a, team_b, player_b,
                       side['A']['ticker'], side['B']['ticker'])
        res = (side['A'].get('result'), side['B'].get('result'))
        g.winner = 'A' if res == ('yes', 'no') else 'B' if res == ('no', 'yes') else None
        g.volume = sum(float(m.get('volume_fp') or 0) for m in ms)
        for key, m in (('a', side['A']), ('b', side['B'])):
            ask, bid = _f(m.get('yes_ask_dollars')), _f(m.get('yes_bid_dollars'))
            setattr(g, f'ask_{key}', ask if ask and 0 < ask < 1 else None)
            setattr(g, f'bid_{key}', bid if bid and 0 < bid < 1 else None)
        games.append(g)
    return sorted(games, key=lambda g: g.start)


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


# ----------------------------------------------------------------------------- HTTP (sync)

def _get(path: str, **params):
    url = BASE + path + ('?' + urllib.parse.urlencode(params) if params else '')
    for attempt in range(6):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as ex:
            if ex.code == 429 or ex.code >= 500:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f'Kalshi no responde: {path}')


def fetch_markets(status: str, series: str = SERIES, min_close_ts: int | None = None):
    out, cursor = [], None
    while True:
        q = {'series_ticker': series, 'status': status, 'limit': 1000}
        if cursor:
            q['cursor'] = cursor
        if min_close_ts:
            q['min_close_ts'] = min_close_ts
        d = _get('/markets', **q)
        out += d.get('markets', [])
        cursor = d.get('cursor')
        if not cursor or not d.get('markets'):
            return out


def pregame_quotes(games, minutes_before: int = 2, batch: int = 40, sleep: float = 0.12):
    """Fill ask/bid with the last 1-minute candle ending ``minutes_before`` the scheduled start.

    Uses the batch candlesticks endpoint, grouping games that share a start time.
    """
    groups: dict[int, list] = {}
    for g in games:
        groups.setdefault(int(g.start.timestamp()), []).append(g)
    for start_ts, gs in groups.items():
        cutoff = start_ts - 60 * minutes_before
        for i in range(0, len(gs), batch):
            chunk = gs[i:i + batch]
            tickers = [t for g in chunk for t in (g.ticker_a, g.ticker_b)]
            d = _get('/markets/candlesticks', market_tickers=','.join(tickers),
                     start_ts=cutoff - 3600, end_ts=cutoff, period_interval=1)
            quotes = {}
            for m in d.get('markets', []):
                cs = [c for c in m.get('candlesticks', []) if c['end_period_ts'] <= cutoff]
                if cs:
                    last = cs[-1]
                    quotes[m.get('market_ticker') or m.get('ticker')] = (
                        _f(last.get('yes_ask', {}).get('close_dollars')),
                        _f(last.get('yes_bid', {}).get('close_dollars')))
            for g in chunk:
                qa, qb = quotes.get(g.ticker_a), quotes.get(g.ticker_b)
                g.ask_a, g.bid_a = _valid(qa)
                g.ask_b, g.bid_b = _valid(qb)
            time.sleep(sleep)
    return games


def _valid(q):
    if not q:
        return None, None
    ask, bid = q
    ask = ask if ask and 0 < ask < 1 else None
    bid = bid if bid and 0 < bid < 1 else None
    return ask, bid


def mid_prob(g: KalshiGame) -> float | None:
    """Market probability for side A from the two books (no-vig average of both views)."""
    views = []
    if g.ask_a and g.bid_a:
        views.append((g.ask_a + g.bid_a) / 2)
    if g.ask_b and g.bid_b:
        views.append(1 - (g.ask_b + g.bid_b) / 2)
    if not views:
        return None
    p = sum(views) / len(views)
    return min(max(p, 0.01), 0.99)


def logit(p):
    p = min(max(p, 1e-4), 1 - 1e-4)
    return math.log(p / (1 - p))
