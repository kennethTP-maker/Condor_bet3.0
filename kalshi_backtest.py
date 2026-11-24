"""Walk-forward backtest of the eBasketball win model against real Kalshi prices.

    python kalshi_backtest.py            # uses cache data/kalshi_ebasket.json (downloads if missing)
    python kalshi_backtest.py --refresh  # re-download settled markets and pre-game quotes

Protocol (no look-ahead):
1. Games sorted by scheduled start. The model predicts each game using only earlier results,
   then learns from it.
2. Market price = last 1-minute candle ending 2 minutes before the scheduled start.
3. Hyper-parameters are chosen on the first half (TRAIN) only; everything reported as
   out-of-sample comes from the second half (TEST).
4. Bets pay $1 per contract, bought at the YES ask plus Kalshi's taker fee 0.07·P·(1−P).
"""
from __future__ import annotations

import argparse
import dataclasses
import itertools
import json
import math
import os
from datetime import datetime

import kalshi
from winmodel import WinModel, WinParams, sigmoid

CACHE = os.path.join('data', 'kalshi_ebasket.json')


# ----------------------------------------------------------------------------- data

def load_games(refresh=False):
    if not refresh and os.path.exists(CACHE):
        rows = json.load(open(CACHE))
        out = []
        for r in rows:
            r['start'] = datetime.fromisoformat(r['start'])
            out.append(kalshi.KalshiGame(**r))
        return out
    markets = kalshi.fetch_markets('settled')
    games = [g for g in kalshi.games_from_markets(markets) if g.winner]
    for g in games:
        g.ask_a = g.bid_a = g.ask_b = g.bid_b = None
    os.makedirs('data', exist_ok=True)
    # Resume quotes from a previous partial run.
    partial = CACHE + '.partial'
    done = set()
    if os.path.exists(partial):
        old = {r['event_ticker']: r for r in json.load(open(partial))}
        for g in games:
            r = old.get(g.event_ticker)
            if r:
                g.ask_a, g.bid_a, g.ask_b, g.bid_b = r['ask_a'], r['bid_a'], r['ask_b'], r['bid_b']
                done.add(g.event_ticker)

    def save(path):
        json.dump([dataclasses.asdict(g) | {'start': g.start.isoformat()} for g in games], open(path, 'w'))

    def progress(i, total):
        if i % 100 == 0 or i == total:
            print(f'  precios pre-partido: {i}/{total} franjas horarias', flush=True)
            save(partial)

    failed = kalshi.pregame_quotes(games, done=done, on_progress=progress)
    if failed:
        print(f'  aviso: {failed} partidos sin precio por errores de la API (vuelve a ejecutar --refresh para reintentar)')
        save(partial)
    else:
        if os.path.exists(partial):
            os.remove(partial)
    save(CACHE)
    return games


# ----------------------------------------------------------------------------- core

def walk_forward(games, params: WinParams):
    """Returns list of (game, p_model, ready) predicted before learning each game."""
    model = WinModel(params)
    preds = []
    for g in games:
        p = model.prob(g.player_a, g.team_a, g.player_b, g.team_b)
        preds.append((g, p, model.ready(g.player_a, g.player_b)))
        model.update(g.player_a, g.team_a, g.player_b, g.team_b, g.winner == 'A')
    return preds, model


def logloss(rows):
    return -sum(math.log(max(1e-6, p if y else 1 - p)) for p, y in rows) / len(rows)


def brier(rows):
    return sum((p - y) ** 2 for p, y in rows) / len(rows)


def fit_blend(rows):
    """Logistic regression y ~ a·logit(model) + b·logit(market) by Newton's method (2 params)."""
    a, b = 0.0, 1.0
    for _ in range(50):
        ga = gb = haa = hab = hbb = 0.0
        for lm, lk, y in rows:
            p = sigmoid(a * lm + b * lk)
            e = y - p
            w = p * (1 - p)
            ga += e * lm; gb += e * lk
            haa += w * lm * lm; hab += w * lm * lk; hbb += w * lk * lk
        det = haa * hbb - hab * hab
        if abs(det) < 1e-12:
            break
        da = (hbb * ga - hab * gb) / det
        db = (haa * gb - hab * ga) / det
        a += da; b += db
        if abs(da) + abs(db) < 1e-8:
            break
    return a, b


def simulate(rows, edge, max_price=0.97, min_price=0.03):
    """rows: (game, p_A). Buy the side whose (p − ask − fee) ≥ edge. 1 contract per bet."""
    bets = []
    for g, p in rows:
        best = None
        for side, prob, ask in (('A', p, g.ask_a), ('B', 1 - p, g.ask_b)):
            if not ask or not (min_price <= ask <= max_price):
                continue
            cost = ask + kalshi.taker_fee(ask)
            ev = prob - cost
            if ev >= edge and (best is None or ev > best[3]):
                best = (side, prob, cost, ev, ask)
        if best:
            side, prob, cost, ev, ask = best
            won = g.winner == side
            bets.append({'game': g, 'side': side, 'p': prob, 'ask': ask, 'cost': cost, 'ev': ev,
                         'won': won, 'pnl': (1 - cost) if won else -cost})
    return bets


def summarize_bets(bets):
    if not bets:
        return {'n': 0}
    staked = sum(b['cost'] for b in bets)
    pnl = sum(b['pnl'] for b in bets)
    # max drawdown on cumulative P&L
    peak = cum = dd = 0.0
    for b in bets:
        cum += b['pnl']; peak = max(peak, cum); dd = max(dd, peak - cum)
    n = len(bets)
    mean = pnl / n
    sd = math.sqrt(sum((b['pnl'] - mean) ** 2 for b in bets) / max(n - 1, 1))
    return {'n': n, 'win_rate': sum(b['won'] for b in bets) / n, 'avg_price': sum(b['ask'] for b in bets) / n,
            'exp_ev': sum(b['ev'] for b in bets) / staked, 'pnl': pnl, 'roi': pnl / staked,
            'max_dd': dd, 't_stat': mean / (sd / math.sqrt(n)) if sd else 0.0}


def calibration(rows, buckets=10):
    out = []
    for i in range(buckets):
        sel = [(p, y) for p, y in rows if i / buckets <= p < (i + 1) / buckets or (i == buckets - 1 and p == 1)]
        if sel:
            out.append((f'{i * 10:>2}-{i * 10 + 10}%', len(sel), sum(p for p, _ in sel) / len(sel),
                        sum(y for _, y in sel) / len(sel)))
    return out


# ----------------------------------------------------------------------------- run

GRID = {
    'k_player': [0.02, 0.03, 0.045, 0.06, 0.10],
    'k_team': [0.0, 0.02, 0.05],
    'floor': [0.2, 0.35, 0.6],
}


def run(games, edges=(0.0, 0.02, 0.04, 0.06, 0.08, 0.10), verbose=True):
    games = sorted(games, key=lambda g: g.start)
    split = len(games) // 2
    split_time = games[split].start

    # 1) tune on TRAIN by log-loss of ready predictions
    best = None
    for kp, kt, fl in itertools.product(GRID['k_player'], GRID['k_team'], GRID['floor']):
        params = WinParams(k_player=kp, k_team=kt, floor=fl)
        preds, _ = walk_forward(games[:split], params)
        rows = [(p, g.winner == 'A') for g, p, r in preds if r]
        if len(rows) < 200:
            continue
        ll = logloss(rows)
        if best is None or ll < best[0]:
            best = (ll, params)
    params = best[1]

    # 2) one walk-forward over all games with the chosen params
    preds, model = walk_forward(games, params)
    train = [(g, p) for g, p, r in preds[:split] if r and kalshi.mid_prob(g) is not None]
    test = [(g, p) for g, p, r in preds[split:] if r and kalshi.mid_prob(g) is not None]

    def metrics(rows):
        y = [g.winner == 'A' for g, _ in rows]
        pm = [p for _, p in rows]
        pk = [kalshi.mid_prob(g) for g, _ in rows]
        return {
            'n': len(rows),
            'model_ll': logloss(list(zip(pm, y))), 'market_ll': logloss(list(zip(pk, y))),
            'model_brier': brier(list(zip(pm, y))), 'market_brier': brier(list(zip(pk, y))),
            'model_acc': sum((p > .5) == t for p, t in zip(pm, y)) / len(y),
            'market_acc': sum((p > .5) == t for p, t in zip(pk, y)) / len(y),
        }

    # 3) blend fitted on TRAIN: does the model add information beyond the market price?
    a, b = fit_blend([(kalshi.logit(p), kalshi.logit(kalshi.mid_prob(g)), g.winner == 'A') for g, p in train])
    blend = lambda g, p: sigmoid(a * kalshi.logit(p) + b * kalshi.logit(kalshi.mid_prob(g)))
    test_blend = [(g, blend(g, p)) for g, p in test]
    blend_ll = logloss([(p, g.winner == 'A') for g, p in test_blend])

    report = {
        'games': len(games), 'with_quotes': sum(1 for g in games if kalshi.mid_prob(g) is not None),
        'period': (games[0].start.date().isoformat(), games[-1].start.date().isoformat()),
        'split': split_time.isoformat(), 'params': dataclasses.asdict(params),
        'train': metrics(train), 'test': metrics(test),
        'blend': {'w_model': a, 'w_market': b, 'test_ll': blend_ll},
        'calibration_model': calibration([(p, g.winner == 'A') for g, p in test]),
        'calibration_market': calibration([(kalshi.mid_prob(g), g.winner == 'A') for g, _ in test]),
        'bets_model': {e: summarize_bets(simulate(test, e)) for e in edges},
        'bets_blend': {e: summarize_bets(simulate(test_blend, e)) for e in edges},
        'market_baselines': {
            'fav_always': summarize_bets(_baseline(test, 'fav')),
            'dog_always': summarize_bets(_baseline(test, 'dog')),
        },
    }
    if verbose:
        print_report(report)
    return report, model


def _baseline(rows, kind):
    bets = []
    for g, _ in rows:
        if not (g.ask_a and g.ask_b):
            continue
        side = ('A' if g.ask_a >= g.ask_b else 'B') if kind == 'fav' else ('A' if g.ask_a < g.ask_b else 'B')
        ask = g.ask_a if side == 'A' else g.ask_b
        if not 0.03 <= ask <= 0.97:
            continue
        cost = ask + kalshi.taker_fee(ask)
        won = g.winner == side
        bets.append({'game': g, 'side': side, 'p': ask, 'ask': ask, 'cost': cost, 'ev': 0.0, 'won': won,
                     'pnl': (1 - cost) if won else -cost})
    return bets


def _fmt_bets(s):
    if not s['n']:
        return 'sin apuestas'
    return (f"n={s['n']:<5} acierto {s['win_rate']:.1%}  precio medio {s['avg_price']:.2f}  "
            f"EV esperado {s['exp_ev']:+.1%}  P&L {s['pnl']:+.2f}$  ROI {s['roi']:+.1%}  "
            f"maxDD {s['max_dd']:.2f}$  t={s['t_stat']:+.2f}")


def print_report(r):
    print(f"Partidos liquidados: {r['games']} ({r['period'][0]} → {r['period'][1]}), con precio pre-partido: {r['with_quotes']}")
    print(f"TRAIN hasta {r['split'][:16]} · parámetros elegidos: {r['params']}")
    for name in ('train', 'test'):
        m = r[name]
        print(f"\n[{name.upper()}] n={m['n']}")
        print(f"  log-loss   modelo {m['model_ll']:.4f} | mercado {m['market_ll']:.4f}")
        print(f"  Brier      modelo {m['model_brier']:.4f} | mercado {m['market_brier']:.4f}")
        print(f"  acierto    modelo {m['model_acc']:.1%} | mercado {m['market_acc']:.1%}")
    b = r['blend']
    print(f"\nMezcla (ajustada en TRAIN): peso modelo {b['w_model']:+.3f}, peso mercado {b['w_market']:+.3f} "
          f"→ log-loss TEST {b['test_ll']:.4f}")
    print('\nCalibración TEST (pred → real):   modelo                 | mercado')
    cm = {x[0]: x for x in r['calibration_model']}
    ck = {x[0]: x for x in r['calibration_market']}
    for k in sorted(set(cm) | set(ck)):
        a = cm.get(k); c = ck.get(k)
        sa = f'n={a[1]:<4} {a[2]:.1%}→{a[3]:.1%}' if a else ' ' * 20
        sc = f'n={c[1]:<4} {c[2]:.1%}→{c[3]:.1%}' if c else ''
        print(f'  {k}  {sa:<24}| {sc}')
    print('\nApuestas simuladas en TEST (compra al ask + comisión Kalshi):')
    for label, key in (('Modelo puro', 'bets_model'), ('Modelo+mercado', 'bets_blend')):
        print(f'  {label}:')
        for e, s in r[key].items():
            print(f'    edge ≥ {e:.0%}: {_fmt_bets(s)}')
    print('  Referencias:')
    print(f"    siempre favorito: {_fmt_bets(r['market_baselines']['fav_always'])}")
    print(f"    siempre underdog: {_fmt_bets(r['market_baselines']['dog_always'])}")


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--refresh', action='store_true')
    args = ap.parse_args()
    run(load_games(args.refresh))
