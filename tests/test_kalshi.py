import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import kalshi
from winmodel import WinModel

RULE = ('If {w} wins the Indiana Pacers (Bryce) vs New Orleans Pelicans (Jalen) professional Valhalla League '
        '2026 Week #48 eBasketball game originally scheduled for Nov 24, 2026 at 12:12 PM EST, then the market resolves to Yes.')


def mk(side, result):
    team = 'Indiana Pacers' if side == 'BRYC' else 'New Orleans Pelicans'
    player = 'Bryce' if side == 'BRYC' else 'Jalen'
    return {'ticker': f'KXEBASKETBALLGAME-26NOV241212BRYCJALE-{side}', 'event_ticker': 'KXEBASKETBALLGAME-26NOV241212BRYCJALE',
            'yes_sub_title': f'{team} ({player})', 'rules_primary': RULE.format(w=f'{team} ({player})'), 'result': result,
            'volume_fp': '10', 'yes_ask_dollars': '0.55', 'yes_bid_dollars': '0.50'}


class KalshiTests(unittest.TestCase):
    def test_parse_game(self):
        (g,) = kalshi.games_from_markets([mk('BRYC', 'no'), mk('JALE', 'yes')])
        self.assertEqual((g.player_a, g.team_a, g.player_b), ('Bryce', 'Indiana Pacers', 'Jalen'))
        self.assertEqual(g.winner, 'B')
        self.assertEqual(g.start.isoformat(), '2026-11-24T17:12:00+00:00')  # 12:12 EST
        self.assertAlmostEqual(kalshi.mid_prob(g), 0.5)

    def test_fee(self):
        self.assertAlmostEqual(kalshi.taker_fee(0.5), 0.0175)

    def test_winmodel_learns(self):
        m = WinModel()
        for _ in range(200):
            m.update('Strong', 'T1', 'Weak', 'T2', True)
        self.assertGreater(m.prob('Strong', 'T1', 'Weak', 'T2'), 0.85)


if __name__ == '__main__':
    unittest.main()
