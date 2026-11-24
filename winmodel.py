"""Win-probability model for games where only the winner is known (Kalshi eBasketball).

Logistic rating model learnt online (Elo-style SGD on log-loss):

    logit P(A wins) = (R_player[A] - R_player[B]) + (R_team[A] - R_team[B]) + bias

* player ratings: who is holding the controller,
* team ratings: the NBA 2K roster each player is assigned that game,
* bias: advantage of the first-listed side.

Learning rates decay with each player's sample size (fast start, stable later).
"""
from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field


def sigmoid(x: float) -> float:
    if x >= 0:
        return 1 / (1 + math.exp(-x))
    e = math.exp(x)
    return e / (1 + e)


@dataclass
class WinParams:
    k_player: float = 0.12
    k_team: float = 0.04
    k_bias: float = 0.005
    prior_games: float = 10.0   # player LR = k * max(prior/(n+prior), floor)
    floor: float = 0.35
    min_games: int = 15


@dataclass
class PlayerRecord:
    name: str
    rating: float = 0.0
    games: int = 0
    wins: int = 0
    recent: list = field(default_factory=list)  # 1/0 last 20


class WinModel:
    def __init__(self, params: WinParams | None = None):
        self.p = params or WinParams()
        self.players: dict[str, PlayerRecord] = {}
        self.teams: dict[str, float] = defaultdict(float)
        self.team_games: dict[str, int] = defaultdict(int)
        self.bias = 0.0
        self.n = 0

    def _player(self, name):
        key = name.strip().lower()
        if key not in self.players:
            self.players[key] = PlayerRecord(name.strip())
        return self.players[key]

    def known(self, name):
        return self.players.get(name.strip().lower())

    def logit(self, player_a, team_a, player_b, team_b) -> float:
        pa, pb = self.known(player_a), self.known(player_b)
        ra = pa.rating if pa else 0.0
        rb = pb.rating if pb else 0.0
        return ra - rb + self.teams.get(team_a, 0.0) - self.teams.get(team_b, 0.0) + self.bias

    def prob(self, player_a, team_a, player_b, team_b) -> float:
        return sigmoid(self.logit(player_a, team_a, player_b, team_b))

    def games_of(self, name) -> int:
        p = self.known(name)
        return p.games if p else 0

    def ready(self, player_a, player_b) -> bool:
        return min(self.games_of(player_a), self.games_of(player_b)) >= self.p.min_games

    def _lr(self, n):
        return self.p.k_player * max(self.p.prior_games / (n + self.p.prior_games), self.p.floor) * 4

    def update(self, player_a, team_a, player_b, team_b, a_won: bool) -> float:
        prob = self.prob(player_a, team_a, player_b, team_b)
        err = (1.0 if a_won else 0.0) - prob
        pa, pb = self._player(player_a), self._player(player_b)
        pa.rating += self._lr(pa.games) * err
        pb.rating -= self._lr(pb.games) * err
        ka = self.p.k_team * max(5 / (self.team_games[team_a] + 5), 0.25) * 4
        kb = self.p.k_team * max(5 / (self.team_games[team_b] + 5), 0.25) * 4
        self.teams[team_a] += ka * err
        self.teams[team_b] -= kb * err
        self.team_games[team_a] += 1
        self.team_games[team_b] += 1
        self.bias += self.p.k_bias * err
        for rec, won in ((pa, a_won), (pb, not a_won)):
            rec.games += 1
            rec.wins += int(won)
            rec.recent.append(int(won))
            if len(rec.recent) > 20:
                rec.recent.pop(0)
        self.n += 1
        return prob

    def ranking(self, min_games=1):
        return sorted((p for p in self.players.values() if p.games >= min_games),
                      key=lambda p: p.rating, reverse=True)
