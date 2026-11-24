"""eBasketball analytics engine (pure Python, no network).

The model learns only from match results stored by the bot (manual entry or CSV import):

* Player Elo with margin-of-victory multiplier.
* Offensive / defensive point ratings learnt online (shrunk toward the league mean
  through a sample-size dependent learning rate, then exponentially weighted so that
  recent form matters more).
* League scoring level, home edge and residual variance (EWMA) to turn projections
  into probabilities with a normal approximation.
* Pre-game and live (in-play) projections for totals, spreads and moneyline, EV and
  fractional Kelly against the odds the user supplies.
* Walk-forward backtest (each match is predicted only with information available
  before it) so calibration can be checked before trusting any edge.

Nothing here is a guarantee of profit. A VALUE verdict means "the model, as validated by
its own backtest, prices this above the market"; nothing more.
"""
from __future__ import annotations

import csv
import io
import math
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone


# --------------------------------------------------------------------------- utils

def norm_name(name: str) -> str:
    return ' '.join(str(name).strip().split()).lower()


def phi(x: float) -> float:
    """Standard normal CDF."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def prob_above(line: float, mean: float, sd: float):
    """P(X > line), P(push) for an integer-valued score X ~ N(mean, sd)."""
    sd = max(sd, 1e-6)
    if abs(line - round(line)) < 1e-9:  # integer line -> push possible
        upper = 1 - phi((line + 0.5 - mean) / sd)
        push = phi((line + 0.5 - mean) / sd) - phi((line - 0.5 - mean) / sd)
        return upper, push
    return 1 - phi((line - mean) / sd), 0.0


def expected_value(p_win: float, decimal_odds: float, p_push: float = 0.0) -> float:
    p_lose = max(0.0, 1 - p_win - p_push)
    return p_win * (decimal_odds - 1) - p_lose


def kelly(p_win: float, decimal_odds: float, p_push: float = 0.0) -> float:
    b = decimal_odds - 1
    if b <= 0:
        return 0.0
    p_lose = max(0.0, 1 - p_win - p_push)
    f = (b * p_win - p_lose) / b
    return max(0.0, f)


def fair_odds(p: float) -> float:
    return float('inf') if p <= 0 else 1 / p


def no_vig(odds_a: float | None, odds_b: float | None):
    if not odds_a or not odds_b or odds_a <= 1 or odds_b <= 1:
        return None, None, None
    ia, ib = 1 / odds_a, 1 / odds_b
    overround = ia + ib
    return ia / overround, ib / overround, overround - 1


# --------------------------------------------------------------------------- data

@dataclass(frozen=True)
class Match:
    played_at: datetime
    league: str
    home: str
    away: str
    home_score: int
    away_score: int

    @property
    def home_key(self):
        return norm_name(self.home)

    @property
    def away_key(self):
        return norm_name(self.away)

    @property
    def total(self):
        return self.home_score + self.away_score

    @property
    def margin(self):
        return self.home_score - self.away_score


_COLS = {
    'fecha': 'date', 'date': 'date', 'played_at': 'date', 'hora': 'date',
    'liga': 'league', 'league': 'league', 'torneo': 'league',
    'local': 'home', 'home': 'home', 'jugador_local': 'home', 'player1': 'home', 'p1': 'home',
    'visitante': 'away', 'away': 'away', 'jugador_visitante': 'away', 'player2': 'away', 'p2': 'away',
    'pts_local': 'hs', 'home_score': 'hs', 'score1': 'hs', 'puntos_local': 'hs',
    'pts_visitante': 'as', 'away_score': 'as', 'score2': 'as', 'puntos_visitante': 'as',
}


def parse_date(value: str | None) -> datetime:
    if not value:
        return datetime.now(timezone.utc)
    value = value.strip().replace('Z', '+00:00')
    for parser in (datetime.fromisoformat,):
        try:
            d = parser(value)
            return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    for fmt in ('%d/%m/%Y %H:%M', '%d/%m/%Y', '%Y-%m-%d %H:%M', '%d-%m-%Y %H:%M'):
        try:
            return datetime.strptime(value, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    raise ValueError(f'Fecha no reconocida: {value!r}')


def parse_csv(text: str, default_league: str):
    """Returns (matches, errors). Accepts ',' or ';' separated files with a header row."""
    sample = text[:2000]
    delimiter = ';' if sample.count(';') > sample.count(',') else ','
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
    matches, errors = [], []
    for i, row in enumerate(reader, start=2):
        mapped = {}
        for k, v in row.items():
            if k is None:
                continue
            target = _COLS.get(k.strip().lower())
            if target:
                mapped[target] = (v or '').strip()
        try:
            hs, as_ = int(float(mapped['hs'])), int(float(mapped['as']))
            if not mapped.get('home') or not mapped.get('away'):
                raise KeyError('jugador')
            if hs < 0 or as_ < 0:
                raise ValueError('puntos negativos')
            matches.append(Match(parse_date(mapped.get('date')), mapped.get('league') or default_league,
                                 mapped['home'], mapped['away'], hs, as_))
        except (KeyError, ValueError) as ex:
            errors.append(f'Fila {i}: {ex}')
    return matches, errors


# --------------------------------------------------------------------------- model

@dataclass
class PlayerState:
    name: str
    elo: float = 1500.0
    off: float = 0.0   # points scored above league average
    dfn: float = 0.0   # points allowed above league average (positive = weak defence)
    games: int = 0
    wins: int = 0
    last_played: datetime | None = None
    history: list = field(default_factory=list)  # (dt, opp, pf, pa)


@dataclass(frozen=True)
class Projection:
    home: str
    away: str
    home_pts: float
    away_pts: float
    total: float
    margin: float
    sd_total: float
    sd_margin: float
    p_home_points: float
    p_home_elo: float
    p_home: float
    home_games: int
    away_games: int
    confidence: str


class EBasketModel:
    def __init__(self, min_games: int = 12, prior_games: float = 8.0, min_lr: float = 0.06,
                 elo_k: float = 22.0, elo_weight: float = 0.35):
        self.min_games = min_games
        self.prior_games = prior_games
        self.min_lr = min_lr
        self.elo_k = elo_k
        self.elo_weight = elo_weight
        self.players: dict[str, PlayerState] = {}
        self.mu: float | None = None          # mean points per side
        self.home_edge = 0.0
        self.var_total: float | None = None
        self.var_margin: float | None = None
        self.n = 0
        self.h2h: dict[tuple, list] = defaultdict(list)

    # ---------------------------------------------------------------- helpers
    def player(self, name: str) -> PlayerState:
        key = norm_name(name)
        if key not in self.players:
            self.players[key] = PlayerState(name=name.strip())
        return self.players[key]

    def known(self, name: str) -> PlayerState | None:
        return self.players.get(norm_name(name))

    def _lr(self, games: int) -> float:
        return max(1.0 / (games + self.prior_games), self.min_lr)

    def confidence(self, gh: int, ga: int) -> str:
        g = min(gh, ga)
        if self.n < 40 or g < self.min_games:
            return 'BAJA'
        if g < 2.5 * self.min_games:
            return 'MEDIA'
        return 'ALTA'

    # ---------------------------------------------------------------- predict
    def project(self, home: str, away: str) -> Projection:
        if self.mu is None:
            raise ValueError('No hay partidos registrados para esta liga')
        h = self.known(home) or PlayerState(name=home)
        a = self.known(away) or PlayerState(name=away)
        hp = self.mu + self.home_edge / 2 + h.off + a.dfn
        ap = self.mu - self.home_edge / 2 + a.off + h.dfn
        sd_t = math.sqrt(self.var_total)
        sd_m = math.sqrt(self.var_margin)
        p_pts = phi((hp - ap) / sd_m)
        p_elo = 1 / (1 + 10 ** (-(h.elo - a.elo) / 400))
        p = (1 - self.elo_weight) * p_pts + self.elo_weight * p_elo
        return Projection(h.name, a.name, hp, ap, hp + ap, hp - ap, sd_t, sd_m, p_pts, p_elo, p,
                          h.games, a.games, self.confidence(h.games, a.games))

    # ---------------------------------------------------------------- learn
    def update(self, m: Match):
        if self.mu is None:
            self.mu = m.total / 2
            self.var_total = (0.09 * m.total) ** 2 + 25
            self.var_margin = (0.07 * m.total) ** 2 + 25
        proj = self.project(m.home, m.away)
        h, a = self.player(m.home), self.player(m.away)

        eh = m.home_score - proj.home_pts
        ea = m.away_score - proj.away_pts
        lh, la = self._lr(h.games), self._lr(a.games)
        # Each side's error is shared between the scorer's offence and the opponent's defence.
        h.off += lh * eh * 0.5
        a.dfn += la * eh * 0.5
        a.off += la * ea * 0.5
        h.dfn += lh * ea * 0.5

        league_lr = max(1.0 / (self.n + 2), 0.01)
        self.mu += league_lr * (eh + ea) / 2
        self.home_edge += max(1.0 / (self.n + 20), 0.005) * ((m.margin) - (proj.margin))
        var_lr = max(1.0 / (self.n + 2), 0.02)
        self.var_total += var_lr * ((m.total - proj.total) ** 2 - self.var_total)
        self.var_margin += var_lr * ((m.margin - proj.margin) ** 2 - self.var_margin)
        self.var_total = max(self.var_total, 16.0)
        self.var_margin = max(self.var_margin, 16.0)

        # Elo with margin-of-victory multiplier.
        if m.margin != 0:
            winner_diff = (h.elo - a.elo) if m.margin > 0 else (a.elo - h.elo)
            mult = math.log(abs(m.margin) + 1) * 2.2 / (winner_diff * 0.001 + 2.2)
            score = 1.0 if m.margin > 0 else 0.0
            exp = 1 / (1 + 10 ** (-(h.elo - a.elo) / 400))
            delta = self.elo_k * mult * (score - exp)
            h.elo += delta
            a.elo -= delta

        for p, opp, pf, pa in ((h, a.name, m.home_score, m.away_score), (a, h.name, m.away_score, m.home_score)):
            p.games += 1
            p.wins += 1 if pf > pa else 0
            p.last_played = m.played_at
            p.history.append((m.played_at, opp, pf, pa))
            if len(p.history) > 50:
                p.history.pop(0)
        self.h2h[tuple(sorted((m.home_key, m.away_key)))].append(m)
        self.n += 1
        return proj

    @classmethod
    def fit(cls, matches, **kw):
        model = cls(**kw)
        for m in sorted(matches, key=lambda x: x.played_at):
            model.update(m)
        return model

    # ---------------------------------------------------------------- reporting
    def form(self, name: str, last: int = 10):
        p = self.known(name)
        if not p or not p.history:
            return None
        recent = p.history[-last:]
        res = ''.join('W' if pf > pa else 'L' for _, _, pf, pa in recent)
        n = len(recent)
        return {
            'string': res, 'n': n,
            'wins': res.count('W'),
            'pf': sum(x[2] for x in recent) / n,
            'pa': sum(x[3] for x in recent) / n,
            'total': sum(x[2] + x[3] for x in recent) / n,
            'streak': _streak(res),
        }

    def head_to_head(self, home: str, away: str, last: int = 10):
        games = self.h2h.get(tuple(sorted((norm_name(home), norm_name(away)))), [])[-last:]
        if not games:
            return None
        hk = norm_name(home)
        wins = sum(1 for g in games if (g.home_key == hk) == (g.margin > 0))
        margin = sum(g.margin if g.home_key == hk else -g.margin for g in games) / len(games)
        return {'n': len(games), 'home_wins': wins, 'avg_total': sum(g.total for g in games) / len(games),
                'avg_margin': margin}

    def ranking(self, min_games: int = 1):
        rows = [p for p in self.players.values() if p.games >= min_games]
        return sorted(rows, key=lambda p: p.elo, reverse=True)


def _streak(res: str) -> str:
    if not res:
        return '-'
    last, count = res[-1], 0
    for c in reversed(res):
        if c != last:
            break
        count += 1
    return f'{last}{count}'


# --------------------------------------------------------------------------- markets

@dataclass(frozen=True)
class MarketEval:
    market: str
    selection: str
    line: float | None
    odds: float
    p_model: float
    p_push: float
    p_market: float | None
    ev: float
    kelly: float
    verdict: str
    reason: str
    side: str = ''  # O/U for totals, H/A for home/away


def _verdict(p, push, odds, p_market, conf, min_ev, max_gap):
    ev = expected_value(p, odds, push)
    if conf == 'BAJA':
        return ev, 'SIN DATOS', 'Muestra insuficiente para fiarse del modelo'
    if p_market is not None and abs(p - p_market) > max_gap:
        return ev, 'REVISAR', f'Discrepancia >{max_gap:.0%} con el mercado: posible info no capturada (línea movida, jugador distinto)'
    if ev >= min_ev:
        return ev, 'VALOR', f'EV {ev:+.1%} ≥ umbral {min_ev:.0%}'
    if ev > 0:
        return ev, 'MARGINAL', 'EV positivo pero bajo el umbral'
    return ev, 'PASS', 'Sin ventaja frente a la cuota'


def evaluate_markets(proj: Projection, *, total_line=None, over_odds=None, under_odds=None,
                     spread_line=None, home_spread_odds=None, away_spread_odds=None,
                     home_ml=None, away_ml=None, min_ev=0.04, kelly_fraction=0.25,
                     max_gap=0.20, total_mean=None, total_sd=None, margin_mean=None,
                     margin_sd=None, p_home=None):
    """spread_line is the HOME handicap (e.g. -4.5 = home gives 4.5 points)."""
    tm = proj.total if total_mean is None else total_mean
    ts = proj.sd_total if total_sd is None else total_sd
    mm = proj.margin if margin_mean is None else margin_mean
    ms = proj.sd_margin if margin_sd is None else margin_sd
    ph = proj.p_home if p_home is None else p_home
    out = []

    def add(side, market, selection, line, odds, p, push, p_mkt):
        if not odds:
            return
        ev, verdict, reason = _verdict(p, push, odds, p_mkt, proj.confidence, min_ev, max_gap)
        k = kelly(p, odds, push) * kelly_fraction if verdict == 'VALOR' else 0.0
        out.append(MarketEval(market, selection, line, odds, p, push, p_mkt, ev, min(k, 0.05), verdict, reason, side))

    if total_line is not None:
        p_over, push = prob_above(total_line, tm, ts)
        p_under = max(0.0, 1 - p_over - push)
        nv_o, nv_u, _ = no_vig(over_odds, under_odds)
        add('O', 'Total', f'Over {total_line:g}', total_line, over_odds, p_over, push, nv_o)
        add('U', 'Total', f'Under {total_line:g}', total_line, under_odds, p_under, push, nv_u)
    if spread_line is not None:
        p_cover, push = prob_above(-spread_line, mm, ms)
        p_away = max(0.0, 1 - p_cover - push)
        nv_h, nv_a, _ = no_vig(home_spread_odds, away_spread_odds)
        add('H', 'Hándicap', f'{proj.home} {spread_line:+g}', spread_line, home_spread_odds, p_cover, push, nv_h)
        add('A', 'Hándicap', f'{proj.away} {-spread_line:+g}', -spread_line, away_spread_odds, p_away, push, nv_a)
    if home_ml or away_ml:
        nv_h, nv_a, _ = no_vig(home_ml, away_ml)
        add('H', 'Moneyline', proj.home, None, home_ml, ph, 0.0, nv_h)
        add('A', 'Moneyline', proj.away, None, away_ml, 1 - ph, 0.0, nv_a)
    return out


# --------------------------------------------------------------------------- live

@dataclass(frozen=True)
class LiveProjection:
    total: float
    margin: float
    sd_total: float
    sd_margin: float
    p_home: float
    elapsed_frac: float
    pace_total: float


def live_projection(proj: Projection, home_now: int, away_now: int, minutes_left: float,
                    game_minutes: float, prior_weight_minutes: float | None = None) -> LiveProjection:
    """Bayesian blend of pre-game rates with the observed in-game pace."""
    minutes_left = min(max(minutes_left, 0.0), game_minutes)
    elapsed = game_minutes - minutes_left
    frac_left = minutes_left / game_minutes
    k = game_minutes / 2 if prior_weight_minutes is None else prior_weight_minutes
    w_obs = elapsed / (elapsed + k) if elapsed > 0 else 0.0
    pre_rate_total = proj.total / game_minutes
    pre_rate_margin = proj.margin / game_minutes
    obs_rate_total = (home_now + away_now) / elapsed if elapsed > 0 else pre_rate_total
    obs_rate_margin = (home_now - away_now) / elapsed if elapsed > 0 else pre_rate_margin
    rate_t = (1 - w_obs) * pre_rate_total + w_obs * obs_rate_total
    # Margins regress harder: observed lead is mostly noise in short e-games.
    w_m = w_obs * 0.5
    rate_m = (1 - w_m) * pre_rate_margin + w_m * obs_rate_margin
    total = home_now + away_now + rate_t * minutes_left
    margin = home_now - away_now + rate_m * minutes_left
    sd_t = max(proj.sd_total * math.sqrt(frac_left), 1.0)
    sd_m = max(proj.sd_margin * math.sqrt(frac_left), 1.0)
    if minutes_left == 0:
        p = 1.0 if margin > 0 else 0.0
    else:
        p = phi(margin / sd_m)
    return LiveProjection(total, margin, sd_t, sd_m, p, elapsed / game_minutes, rate_t * game_minutes)


# --------------------------------------------------------------------------- backtest

@dataclass(frozen=True)
class Backtest:
    n: int
    brier: float
    brier_baseline: float
    logloss: float
    accuracy: float
    mae_total: float
    mae_total_baseline: float
    mae_margin: float
    within_1sd_total: float
    calibration: list  # (bucket_label, n, mean_pred, observed)


def backtest(matches, min_games=12, **kw) -> Backtest | None:
    model = EBasketModel(min_games=min_games, **kw)
    preds = []
    for m in sorted(matches, key=lambda x: x.played_at):
        if model.mu is not None:
            h, a = model.known(m.home), model.known(m.away)
            if h and a and min(h.games, a.games) >= min_games and m.margin != 0:
                mu_before = model.mu
                p = model.project(m.home, m.away)
                preds.append((p, m, mu_before))
        model.update(m)
    if not preds:
        return None
    n = len(preds)
    eps = 1e-6
    brier = sum((p.p_home - (m.margin > 0)) ** 2 for p, m, _ in preds) / n
    base_rate = sum(m.margin > 0 for _, m, _ in preds) / n
    brier_base = sum((base_rate - (m.margin > 0)) ** 2 for _, m, _ in preds) / n
    ll = -sum(math.log(max(eps, p.p_home if m.margin > 0 else 1 - p.p_home)) for p, m, _ in preds) / n
    acc = sum((p.p_home > 0.5) == (m.margin > 0) for p, m, _ in preds) / n
    mae_t = sum(abs(p.total - m.total) for p, m, _ in preds) / n
    mae_tb = sum(abs(2 * mu - m.total) for _, m, mu in preds) / n
    mae_m = sum(abs(p.margin - m.margin) for p, m, _ in preds) / n
    within = sum(abs(p.total - m.total) <= p.sd_total for p, m, _ in preds) / n
    buckets = defaultdict(list)
    for p, m, _ in preds:
        b = min(int(p.p_home * 10), 9)
        buckets[b].append((p.p_home, m.margin > 0))
    cal = []
    for b in sorted(buckets):
        rows = buckets[b]
        cal.append((f'{b * 10}-{b * 10 + 10}%', len(rows), sum(r[0] for r in rows) / len(rows),
                    sum(r[1] for r in rows) / len(rows)))
    return Backtest(n, brier, brier_base, ll, acc, mae_t, mae_tb, mae_m, within, cal)
