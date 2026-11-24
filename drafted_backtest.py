"""Backtest: points model trained on drafted.gg scores vs real Kalshi pre-game prices.

    python drafted_backtest.py            # uses data/drafted_valhalla.json + data/kalshi_ebasket.json
    python drafted_backtest.py --crawl    # refresh drafted.gg results first (incremental)

Same protocol as kalshi_backtest.py: walk-forward, parameters chosen on the first half of
Kalshi games only, out-of-sample results on the second half, buy at ask + taker fee.
"""
from __future__ import annotations

import argparse
import itertools
import os
from datetime import timedelta

import drafted
import kalshi
from ebasket import EBasketModel
from kalshi_backtest import (_baseline, _fmt_bets, brier, calibration, fit_blend, load_games, logloss,
                             simulate, summarize_bets)
from winmodel import sigmoid

DRAFTED_CACHE = os.path.join('data', 'drafted_valhalla.json')


def refresh_drafted():
    old = drafted.load(DRAFTED_CACHE) if os.path.exists(DRAFTED_CACHE) else []
    newest = max((m.id for m in old), default=0)
    new = drafted.crawl(stop_before_id=newest)
    allm = {m.id: m for m in old + new}
    drafted.save(sorted(allm.values(), key=lambda m: m.start), DRAFTED_CACHE)
    return list(allm.values())


def join(dmatches, kgames, tolerance_min=20):
    """Map each Kalshi game to its drafted match: same pair of players, start within tolerance."""
    by_pair = {}
    for m in dmatches:
        by_pair.setdefault(frozenset((m.home.lower(), m.away.lower())), []).append(m)
    pairs = []
    for g in kgames:
        cands = by_pair.get(frozenset((g.player_a.lower(), g.player_b.lower())), [])
        best = None
        for m in cands:
            dt = abs((drafted_start(m) - g.start).total_seconds()) / 60
            if dt <= tolerance_min and (best is None or dt < best[0]):
                best = (dt, m)
        if best:
            pairs.append((g, best[1]))
    return pairs


def drafted_start(m):
    return m.to_match().played_at


def walk(dmatches, kpairs, **params):
    """Predict P(Kalshi side A wins) for each joined game before the model sees that match."""
    model = EBasketModel(**params)
    target = {m.id: g for g, m in kpairs}
    preds = []
    for m in sorted(dmatches, key=lambda x: (x.start, x.id)):
        g = target.get(m.id)
        if g is not None and model.mu is not None:
            proj = model.project(m.home, m.away)
            p_home = proj.p_home
            a_is_home = g.player_a.lower() == m.home.lower()
            ready = min(proj.home_games, proj.away_games) >= params.get('min_games', 12)
            preds.append((g, p_home if a_is_home else 1 - p_home, ready, m))
        model.update(m.to_match())
    return preds, model


GRID = {'prior_games': [4.0, 8.0, 16.0], 'min_lr': [0.02, 0.04, 0.08], 'elo_weight': [0.0, 0.35, 0.7]}


def run(dmatches, kgames, edges=(0.0, 0.02, 0.04, 0.06, 0.08, 0.10)):
    kgames = sorted([g for g in kgames if kalshi.mid_prob(g) is not None], key=lambda g: g.start)
    pairs = join(dmatches, kgames)
    pairs.sort(key=lambda x: x[0].start)
    split_time = pairs[len(pairs) // 2][0].start
    agree = sum((g.winner == 'A') == ((m.home.lower() == g.player_a.lower()) == (m.home_score > m.away_score))
                for g, m in pairs) / len(pairs)
    print(f'drafted: {len(dmatches)} partidos ({min(m.start for m in dmatches)[:10]} → {max(m.start for m in dmatches)[:10]})')
    print(f'Kalshi con precio: {len(kgames)} · emparejados con drafted: {len(pairs)} · '
          f'ganador coincide en {agree:.1%}')

    best = None
    for pg, lr, ew in itertools.product(GRID['prior_games'], GRID['min_lr'], GRID['elo_weight']):
        params = dict(prior_games=pg, min_lr=lr, elo_weight=ew, min_games=12)
        preds, _ = walk(dmatches, pairs, **params)
        rows = [(p, g.winner == 'A') for g, p, r, _ in preds if r and g.start < split_time]
        if len(rows) < 200:
            continue
        ll = logloss(rows)
        if best is None or ll < best[0]:
            best = (ll, params)
    params = best[1]
    print(f'TRAIN hasta {split_time.isoformat()[:16]} · parámetros elegidos: {params}')

    preds, model = walk(dmatches, pairs, **params)
    train = [(g, p) for g, p, r, _ in preds if r and g.start < split_time]
    test = [(g, p) for g, p, r, _ in preds if r and g.start >= split_time]
    for name, rows in (('TRAIN', train), ('TEST', test)):
        y = [g.winner == 'A' for g, _ in rows]
        pm = [p for _, p in rows]
        pk = [kalshi.mid_prob(g) for g, _ in rows]
        print(f'\n[{name}] n={len(rows)}')
        print(f'  log-loss   modelo {logloss(list(zip(pm, y))):.4f} | mercado {logloss(list(zip(pk, y))):.4f}')
        print(f'  Brier      modelo {brier(list(zip(pm, y))):.4f} | mercado {brier(list(zip(pk, y))):.4f}')
        print(f'  acierto    modelo {sum((p > .5) == t for p, t in zip(pm, y)) / len(y):.1%} | '
              f'mercado {sum((p > .5) == t for p, t in zip(pk, y)) / len(y):.1%}')

    a, b = fit_blend([(kalshi.logit(p), kalshi.logit(kalshi.mid_prob(g)), g.winner == 'A') for g, p in train])
    test_blend = [(g, sigmoid(a * kalshi.logit(p) + b * kalshi.logit(kalshi.mid_prob(g)))) for g, p in test]
    print(f'\nMezcla (TRAIN): peso modelo {a:+.3f}, peso mercado {b:+.3f} → log-loss TEST '
          f'{logloss([(p, g.winner == "A") for g, p in test_blend]):.4f}')

    print('\nCalibración TEST modelo (pred → real):')
    for k, n, p, o in calibration([(p, g.winner == 'A') for g, p in test]):
        print(f'  {k}  n={n:<4} {p:.1%} → {o:.1%}')

    print('\nApuestas simuladas en TEST (ask + comisión):')
    for label, rows in (('Modelo puntos', test), ('Puntos+mercado', test_blend)):
        print(f'  {label}:')
        for e in edges:
            print(f'    edge ≥ {e:.0%}: {_fmt_bets(summarize_bets(simulate(rows, e)))}')
    print(f"  siempre favorito: {_fmt_bets(summarize_bets(_baseline(test, 'fav')))}")
    return params, model


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--crawl', action='store_true')
    args = ap.parse_args()
    dm = refresh_drafted() if args.crawl or not os.path.exists(DRAFTED_CACHE) else drafted.load(DRAFTED_CACHE)
    run(dm, load_games())
