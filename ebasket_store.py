"""SQLite storage for eBasketball results and tracked picks (local test DB only)."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

from ebasket import Match, norm_name, parse_date


class EBasketStore:
    def __init__(self, db: sqlite3.Connection):
        self.db = db
        self.db.executescript('''
        CREATE TABLE IF NOT EXISTS eb_matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            played_at TEXT NOT NULL, league TEXT NOT NULL,
            home TEXT NOT NULL, away TEXT NOT NULL,
            home_key TEXT NOT NULL, away_key TEXT NOT NULL,
            home_score INTEGER NOT NULL, away_score INTEGER NOT NULL,
            source TEXT NOT NULL DEFAULT 'manual',
            UNIQUE (played_at, league, home_key, away_key, home_score, away_score)
        );
        CREATE INDEX IF NOT EXISTS eb_matches_league ON eb_matches (league, played_at);
        CREATE TABLE IF NOT EXISTS eb_picks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL, user_id TEXT NOT NULL, league TEXT NOT NULL,
            home TEXT NOT NULL, away TEXT NOT NULL,
            home_key TEXT NOT NULL, away_key TEXT NOT NULL,
            market TEXT NOT NULL, selection TEXT NOT NULL, line REAL,
            odds REAL NOT NULL, p_model REAL NOT NULL, ev REAL NOT NULL, stake REAL NOT NULL,
            status TEXT NOT NULL DEFAULT 'OPEN', profit REAL, settled_at TEXT, match_id INTEGER
        );
        ''')
        self.db.commit()

    # ------------------------------------------------------------------ matches
    def add_matches(self, matches, source='manual'):
        added = 0
        for m in matches:
            cur = self.db.execute(
                'INSERT OR IGNORE INTO eb_matches (played_at, league, home, away, home_key, away_key, '
                'home_score, away_score, source) VALUES (?,?,?,?,?,?,?,?,?)',
                (m.played_at.astimezone(timezone.utc).isoformat(), m.league.strip(), m.home.strip(),
                 m.away.strip(), m.home_key, m.away_key, m.home_score, m.away_score, source))
            if cur.rowcount:
                added += 1
                self._settle(cur.lastrowid, m)
        self.db.commit()
        return added

    def delete_last(self):
        row = self.db.execute('SELECT id, home, away, home_score, away_score FROM eb_matches '
                              'ORDER BY id DESC LIMIT 1').fetchone()
        if row:
            self.db.execute('DELETE FROM eb_matches WHERE id=?', (row[0],))
            self.db.execute("UPDATE eb_picks SET status='OPEN', profit=NULL, settled_at=NULL, match_id=NULL "
                            'WHERE match_id=?', (row[0],))
            self.db.commit()
        return row

    def matches(self, league: str | None = None):
        q = 'SELECT played_at, league, home, away, home_score, away_score FROM eb_matches'
        args = ()
        if league:
            q += ' WHERE lower(league)=lower(?)'
            args = (league.strip(),)
        q += ' ORDER BY played_at, id'
        return [Match(parse_date(r[0]), r[1], r[2], r[3], r[4], r[5]) for r in self.db.execute(q, args)]

    def leagues(self):
        return [r[0] for r in self.db.execute(
            'SELECT league FROM eb_matches GROUP BY league ORDER BY COUNT(*) DESC')]

    def players(self, league: str | None = None, prefix: str = '', limit: int = 25):
        q = ('SELECT name FROM (SELECT home AS name, home_key AS k, league FROM eb_matches '
             'UNION ALL SELECT away, away_key, league FROM eb_matches) WHERE k LIKE ?')
        args = [f'%{norm_name(prefix)}%']
        if league:
            q += ' AND lower(league)=lower(?)'
            args.append(league)
        q += ' GROUP BY k ORDER BY COUNT(*) DESC LIMIT ?'
        args.append(limit)
        return [r[0] for r in self.db.execute(q, args)]

    def count(self):
        return self.db.execute('SELECT COUNT(*) FROM eb_matches').fetchone()[0]

    # ------------------------------------------------------------------ picks
    def add_pick(self, user_id, league, home, away, market, selection, line, odds, p_model, ev, stake):
        cur = self.db.execute(
            'INSERT INTO eb_picks (created_at, user_id, league, home, away, home_key, away_key, market, '
            'selection, line, odds, p_model, ev, stake) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            (datetime.now(timezone.utc).isoformat(), str(user_id), league, home, away, norm_name(home),
             norm_name(away), market, selection, line, odds, p_model, ev, stake))
        self.db.commit()
        return cur.lastrowid

    def picks(self, status: str | None = None, limit: int = 500):
        q = ('SELECT id, created_at, league, home, away, market, selection, line, odds, p_model, ev, stake, '
             'status, profit FROM eb_picks')
        args = ()
        if status:
            q += ' WHERE status=?'
            args = (status,)
        q += ' ORDER BY id DESC LIMIT ?'
        return list(self.db.execute(q, args + (limit,)))

    def _settle(self, match_id, m: Match):
        """Settle the oldest OPEN picks on this pairing created before the match was registered."""
        rows = self.db.execute(
            "SELECT id, home_key, market, selection, line, odds, stake FROM eb_picks WHERE status='OPEN' "
            'AND ((home_key=? AND away_key=?) OR (home_key=? AND away_key=?)) AND lower(league)=lower(?)',
            (m.home_key, m.away_key, m.away_key, m.home_key, m.league)).fetchall()
        for pid, pick_home_key, market, selection, line, odds, stake in rows:
            # Orient the result to the pick's home/away perspective.
            if pick_home_key == m.home_key:
                hs, as_ = m.home_score, m.away_score
            else:
                hs, as_ = m.away_score, m.home_score
            outcome = grade(market, selection, line, hs, as_)
            profit = {'WIN': stake * (odds - 1), 'LOSS': -stake, 'PUSH': 0.0}[outcome]
            self.db.execute('UPDATE eb_picks SET status=?, profit=?, settled_at=?, match_id=? WHERE id=?',
                            (outcome, profit, datetime.now(timezone.utc).isoformat(), match_id, pid))


def grade(market: str, selection: str, line, hs: int, as_: int) -> str:
    """Grade a pick. For Moneyline/Hándicap the stored selection starts with 'H:' or 'A:'."""
    side = selection.split(':', 1)[0]
    if market == 'Total':
        total = hs + as_
        if total == line:
            return 'PUSH'
        over = total > line
        return 'WIN' if over == side.startswith('O') else 'LOSS'
    margin = hs - as_ if side == 'H' else as_ - hs
    if market == 'Moneyline':
        return 'WIN' if margin > 0 else 'LOSS'
    adj = margin + line
    if adj == 0:
        return 'PUSH'
    return 'WIN' if adj > 0 else 'LOSS'
