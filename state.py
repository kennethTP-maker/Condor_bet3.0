"""Local persistence of alert fingerprints and provider usage, no production DB access."""
import sqlite3
from datetime import datetime, timezone

class State:
    def __init__(self, path='data/condor3.sqlite3'):
        self.db=sqlite3.connect(path)
        self.db.execute('CREATE TABLE IF NOT EXISTS alerts (fingerprint TEXT PRIMARY KEY, sent_at TEXT NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS calls (day TEXT PRIMARY KEY, count INTEGER NOT NULL)')
        self.db.commit()

    def already_sent(self,key):
        return bool(self.db.execute('SELECT 1 FROM alerts WHERE fingerprint=?',(key,)).fetchone())

    def mark_sent(self,key):
        self.db.execute('INSERT OR IGNORE INTO alerts VALUES (?,?)',(key,datetime.now(timezone.utc).isoformat()))
        self.db.commit()

    def allow_call(self, daily_limit):
        day=datetime.now(timezone.utc).date().isoformat()
        count=self.db.execute('SELECT count FROM calls WHERE day=?',(day,)).fetchone()
        if (count[0] if count else 0)>=daily_limit: return False
        self.db.execute('INSERT INTO calls (day,count) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET count=count+1',(day,))
        self.db.commit()
        return True
