import json, os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import drafted

ROW = ['$', 'div', None, {'children': [
    ['$', 'div', None, {'className': 'font-nunito', 'children': 'New York Knicks'}],
    ['$', 'div', None, {'children': 'Match 3467206'}],
    ['$', '$L33', None, {'date': '$D2026-11-24T19:04:00.000Z'}],
    ['$', '$L34', None, {'periods': {'type': 'QUARTER', 'values': [
        {'home': '17', 'away': '17', 'number': 1}, {'home': '40', 'away': '43', 'number': 2}]},
        'score': {'home': '57', 'away': '60'}, 'home': {'name': 'Jalen'}, 'away': {'name': 'Dirk'}}],
    ['$', 'div', None, {'className': 'font-nunito', 'children': 'Los Angeles Lakers'}]]}]


def page(rows, cursor='abc', has_next=True):
    payload = '\n'.join(f'{i:x}:' + json.dumps(r, separators=(',', ':')) for i, r in enumerate(rows, 0x30))
    payload += '\n99:{"pageInfo":{"hasNextPage":%s,"endCursor":"%s"}}' % ('true' if has_next else 'false', cursor)
    return '<script>self.__next_f.push([1,%s])</script>' % json.dumps(payload)


class DraftedTests(unittest.TestCase):
    def test_parse(self):
        (m,), cur, nxt = drafted.parse_results_page(page([ROW]))
        self.assertEqual((m.id, m.home, m.home_team, m.away, m.away_team), (3467206, 'Jalen', 'New York Knicks', 'Dirk', 'Los Angeles Lakers'))
        self.assertEqual((m.home_score, m.away_score, m.quarters), (57, 60, [(17, 17), (40, 43)]))
        self.assertEqual((cur, nxt), ('abc', True))
        self.assertEqual(m.to_match().total, 117)

    def test_cursor(self):
        self.assertEqual(drafted.cursor_for(3467197), 'bWF0Y2gvb2Q6bWF0Y2g6MzQ2NzE5Nw==')


if __name__ == '__main__':
    unittest.main()
