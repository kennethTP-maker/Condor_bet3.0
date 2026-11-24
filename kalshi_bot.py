"""/ebasket kalshi: upcoming Kalshi eBasketball games priced by the win model.

Read-only: public Kalshi market data, no orders and no API key required.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone

import aiohttp
import discord
from discord import app_commands

import kalshi
from winmodel import WinModel, WinParams

COLOR = 0x00B37E


class KalshiStore:
    def __init__(self, db):
        self.db = db
        self.db.execute('CREATE TABLE IF NOT EXISTS kalshi_markets (ticker TEXT PRIMARY KEY, event_ticker TEXT, '
                        'close_time TEXT, payload TEXT NOT NULL)')
        self.db.commit()

    def upsert(self, markets):
        for m in markets:
            self.db.execute('INSERT OR REPLACE INTO kalshi_markets VALUES (?,?,?,?)',
                            (m['ticker'], m['event_ticker'], m.get('close_time', ''), json.dumps(m)))
        self.db.commit()

    def last_close_ts(self):
        row = self.db.execute('SELECT MAX(close_time) FROM kalshi_markets').fetchone()
        if not row or not row[0]:
            return None
        return int(datetime.fromisoformat(row[0].replace('Z', '+00:00')).timestamp())

    def markets(self):
        return [json.loads(r[0]) for r in self.db.execute('SELECT payload FROM kalshi_markets')]


async def _get(session, path, **params):
    async with session.get(kalshi.BASE + path, params=params) as r:
        if r.status != 200:
            raise RuntimeError(f'Kalshi HTTP {r.status}')
        return await r.json()


async def fetch_markets_async(session, status, min_close_ts=None):
    out, cursor = [], None
    while True:
        q = {'series_ticker': kalshi.SERIES, 'status': status, 'limit': 1000}
        if cursor:
            q['cursor'] = cursor
        if min_close_ts:
            q['min_close_ts'] = min_close_ts
        d = await _get(session, '/markets', **q)
        out += d.get('markets', [])
        cursor = d.get('cursor')
        if not cursor or not d.get('markets'):
            return out


def _params():
    return WinParams(k_player=float(os.getenv('KALSHI_K_PLAYER', '0.10')),
                     k_team=float(os.getenv('KALSHI_K_TEAM', '0.0')),
                     floor=float(os.getenv('KALSHI_FLOOR', '0.2')),
                     min_games=int(os.getenv('KALSHI_MIN_GAMES', '15')))


def setup(group: app_commands.Group, db):
    store = KalshiStore(db)
    min_edge = float(os.getenv('KALSHI_MIN_EDGE', '0.05'))
    timeout = aiohttp.ClientTimeout(total=60)

    async def sync():
        async with aiohttp.ClientSession(timeout=timeout) as s:
            since = store.last_close_ts()
            settled = await fetch_markets_async(s, 'settled', since - 86400 if since else None)
            store.upsert(settled)
            open_ = await fetch_markets_async(s, 'open')
        model = WinModel(_params())
        for g in kalshi.games_from_markets(store.markets()):
            if g.winner:
                model.update(g.player_a, g.team_a, g.player_b, g.team_b, g.winner == 'A')
        return model, kalshi.games_from_markets(open_), len(settled)

    @group.command(name='kalshi', description='Próximos partidos eBasketball en Kalshi con prob. del modelo y edge tras comisión')
    @app_commands.describe(horas='Ventana de partidos a mostrar (horas)')
    async def kalshi_cmd(interaction: discord.Interaction, horas: app_commands.Range[int, 1, 48] = 6):
        await interaction.response.defer(ephemeral=True)
        try:
            model, upcoming, _ = await sync()
        except Exception as ex:  # network / API errors are reported, never hidden
            return await interaction.followup.send(f'⚠️ Kalshi no disponible: {ex}', ephemeral=True)
        now = datetime.now(timezone.utc)
        upcoming = [g for g in upcoming if now - timedelta(minutes=5) <= g.start <= now + timedelta(hours=horas)]
        if not upcoming:
            return await interaction.followup.send(f'ℹ️ Sin partidos abiertos en Kalshi en las próximas {horas} h.', ephemeral=True)
        lines = []
        for g in upcoming[:15]:
            p = model.prob(g.player_a, g.team_a, g.player_b, g.team_b)
            ready = model.ready(g.player_a, g.player_b)
            best = None
            for name, prob, ask in ((g.player_a, p, g.ask_a), (g.player_b, 1 - p, g.ask_b)):
                if ask:
                    edge = prob - ask - kalshi.taker_fee(ask)
                    if best is None or edge > best[2]:
                        best = (name, ask, edge)
            if not ready:
                tag = '⚫ SIN DATOS'
            elif best and best[2] >= min_edge:
                tag = f'🟢 {best[0]} @ {best[1]:.2f} · edge {best[2]:+.1%}'
            elif best:
                tag = f'⚪ PASS (mejor edge {best[2]:+.1%})'
            else:
                tag = '⚪ sin precio'
            mkt = kalshi.mid_prob(g)
            mkt_s = f' · mercado {mkt:.0%}' if mkt is not None else ''
            lines.append(f"**{g.start.astimezone(kalshi.ET):%H:%M} ET** {g.label}\n"
                         f"  modelo {g.player_a} {p:.0%}{mkt_s} → {tag}")
        warning = ('⚠️ **Backtest (oct–nov 2026, 2.103 partidos fuera de muestra): el modelo NO supera al precio de '
                   'Kalshi** (log-loss 0.665 vs 0.654; ROI simulado −4 % a −8 %). Usa esto como contexto, no como señal.\n\n')
        em = discord.Embed(title='🏀🎮 Kalshi · eBasketball (Valhalla League)', description=(warning + '\n'.join(lines))[:4000], color=COLOR)
        em.set_footer(text=f'Modelo: {model.n} partidos liquidados · edge = prob − ask − comisión · '
                           'Backtest: python kalshi_backtest.py. Solo informativo, no envía órdenes.')
        await interaction.followup.send(embed=em, ephemeral=True)

    @group.command(name='kalshi_ranking', description='Ranking de jugadores Valhalla League según resultados de Kalshi')
    async def kalshi_ranking(interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            model, _, _ = await sync()
        except Exception as ex:
            return await interaction.followup.send(f'⚠️ Kalshi no disponible: {ex}', ephemeral=True)
        rows = model.ranking(20)[:25]
        lines = [f'`{i:>2}.` **{p.name}** · rating {p.rating:+.2f} · {p.wins}-{p.games - p.wins} · '
                 f'L20 {sum(p.recent)}/{len(p.recent)}' for i, p in enumerate(rows, 1)]
        await interaction.followup.send(embed=discord.Embed(title='🏅 Valhalla League · ranking', description='\n'.join(lines),
                                                            color=COLOR), ephemeral=True)

    return store
