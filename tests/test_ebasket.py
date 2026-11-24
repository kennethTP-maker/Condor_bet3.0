import os, random, sqlite3, sys, unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from ebasket import (EBasketModel, Match, backtest, evaluate_markets, live_projection, parse_csv,
                     prob_above, expected_value)
from ebasket_store import EBasketStore, grade


def synthetic(n=1500, seed=7):
    rnd = random.Random(seed)
    skill = {f'P{i}': rnd.gauss(0, 6) for i in range(12)}
    pace = {k: rnd.gauss(0, 4) for k in skill}
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    out = []
    for i in range(n):
        h, a = rnd.sample(list(skill), 2)
        base = 80 + (pace[h] + pace[a]) / 2
        hs = round(base + skill[h] / 2 - skill[a] / 2 + rnd.gauss(0, 7))
        as_ = round(base + skill[a] / 2 - skill[h] / 2 + rnd.gauss(0, 7))
        if hs == as_:
            hs += 1
        out.append(Match(t0 + timedelta(minutes=15 * i), 'L', h, a, hs, as_))
    return out, skill


class ModelTests(unittest.TestCase):
    def test_learns_skill_order(self):
        ms, skill = synthetic()
        model = EBasketModel.fit(ms)
        best = max(skill, key=skill.get)
        worst = min(skill, key=skill.get)
        p = model.project(best, worst)
        self.assertGreater(p.p_home, 0.75)
        self.assertEqual(p.confidence, 'ALTA')
        self.assertAlmostEqual(model.mu * 2, 160, delta=4)

    def test_backtest_beats_baseline_and_is_calibrated(self):
        ms, _ = synthetic()
        bt = backtest(ms)
        self.assertLess(bt.brier, bt.brier_baseline)
        self.assertLess(bt.mae_total, bt.mae_total_baseline)
        self.assertAlmostEqual(bt.within_1sd_total, 0.68, delta=0.07)
        for _, n, pred, obs in bt.calibration:
            if n >= 80:
                self.assertAlmostEqual(pred, obs, delta=0.1)

    def test_market_eval(self):
        ms, skill = synthetic()
        model = EBasketModel.fit(ms)
        best, worst = max(skill, key=skill.get), min(skill, key=skill.get)
        p = model.project(best, worst)
        ev = evaluate_markets(p, home_ml=1.9, away_ml=1.9, total_line=round(p.total) + 0.5,
                              over_odds=1.87, under_odds=1.87, max_gap=1)
        ml = [e for e in ev if e.market == 'Moneyline' and e.side == 'H'][0]
        self.assertEqual(ml.verdict, 'VALOR')
        self.assertGreater(ml.kelly, 0)
        tot = [e for e in ev if e.market == 'Total']
        self.assertTrue(all(e.verdict in ('PASS', 'MARGINAL') for e in tot))

    def test_prob_helpers(self):
        over, push = prob_above(160, 160, 10)
        self.assertAlmostEqual(over, 0.48, delta=0.01)
        self.assertGreater(push, 0.03)
        self.assertAlmostEqual(expected_value(0.5, 2.0), 0.0)

    def test_live_projection_converges_to_score(self):
        ms, _ = synthetic(300)
        model = EBasketModel.fit(ms)
        p = model.project('P1', 'P2')
        end = live_projection(p, 90, 70, 0, 20)
        self.assertEqual(end.total, 160)
        self.assertEqual(end.p_home, 1.0)
        mid = live_projection(p, 50, 40, 10, 20)
        self.assertLess(mid.sd_total, p.sd_total)

    def test_csv(self):
        text = 'fecha;liga;local;visitante;pts_local;pts_visitante\n2026-11-01 10:00;GG;A;B;80;75\nmal;GG;A;;x;1\n'
        ms, errs = parse_csv(text, 'X')
        self.assertEqual(len(ms), 1)
        self.assertEqual(len(errs), 1)


class StoreTests(unittest.TestCase):
    def test_pick_settlement(self):
        store = EBasketStore(sqlite3.connect(':memory:'))
        t = datetime(2026, 11, 1, tzinfo=timezone.utc)
        store.add_pick(1, 'GG', 'Ann', 'Bob', 'Hándicap', 'H:Ann -4.5', -4.5, 1.9, 0.6, 0.14, 2)
        store.add_pick(1, 'GG', 'Ann', 'Bob', 'Total', 'O:Over 150.5', 150.5, 1.9, 0.6, 0.14, 1)
        # Result registered with reversed home/away order.
        self.assertEqual(store.add_matches([Match(t, 'GG', 'Bob', 'Ann', 70, 80)]), 1)
        self.assertEqual(store.add_matches([Match(t, 'GG', 'Bob', 'Ann', 70, 80)]), 0)
        rows = {r[6]: (r[12], r[13]) for r in store.picks()}
        self.assertEqual(rows['H:Ann -4.5'][0], 'WIN')
        self.assertAlmostEqual(rows['H:Ann -4.5'][1], 1.8)
        self.assertEqual(rows['O:Over 150.5'][0], 'LOSS')

    def test_grade(self):
        self.assertEqual(grade('Total', 'O:Over 160', 160, 80, 80), 'PUSH')
        self.assertEqual(grade('Moneyline', 'A:B', None, 70, 71), 'WIN')
        self.assertEqual(grade('Hándicap', 'A:B +3', 3, 73, 70), 'PUSH')


if __name__ == '__main__':
    unittest.main()
