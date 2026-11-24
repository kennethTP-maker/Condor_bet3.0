"""Background sync of drafted.gg Valhalla League results into the local eBasketball DB.

drafted.gg only exposes ~3 days of results, so the bot must run this regularly to build
the long history the models and backtests need.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os

import discord
from discord import app_commands
from discord.ext import tasks

import drafted

log = logging.getLogger('condor.drafted')


class DraftedStore:
    def __init__(self, db):
        self.db = db
        self.db.execute('CREATE TABLE IF NOT EXISTS eb_drafted (id INTEGER PRIMARY KEY, start TEXT NOT NULL, '
                        'payload TEXT NOT NULL)')
        self.db.commit()

    def max_id(self):
        return self.db.execute('SELECT COALESCE(MAX(id), 0) FROM eb_drafted').fetchone()[0]

    def add(self, matches):
        for m in matches:
            self.db.execute('INSERT OR REPLACE INTO eb_drafted VALUES (?,?,?)',
                            (m.id, m.start, json.dumps(m.__dict__)))
        self.db.commit()

    def count(self):
        return self.db.execute('SELECT COUNT(*), MIN(start), MAX(start) FROM eb_drafted').fetchone()

    def all(self):
        return [drafted.DraftedMatch(**{**json.loads(r[0]), 'quarters': [tuple(q) for q in json.loads(r[0])['quarters']]})
                for r in self.db.execute('SELECT payload FROM eb_drafted ORDER BY start, id')]


def setup(bot, group: app_commands.Group, db, ebasket_store):
    store = DraftedStore(db)
    minutes = max(15, int(os.getenv('DRAFTED_SYNC_MINUTES', '60')))
    enabled = os.getenv('DRAFTED_SYNC', 'true').lower() == 'true'

    async def sync_once():
        newest = store.max_id()
        matches = await asyncio.to_thread(drafted.crawl, newest, 400 if newest else 60)
        store.add(matches)
        added = ebasket_store.add_matches([m.to_match() for m in matches], source='drafted')
        return len(matches), added

    @tasks.loop(minutes=minutes)
    async def loop():
        try:
            n, added = await sync_once()
            log.info('drafted sync: %s leídos, %s nuevos', n, added)
        except Exception as ex:  # keep the loop alive on network/site errors
            log.warning('drafted sync falló: %s', ex)

    @loop.before_loop
    async def before():
        await bot.wait_until_ready()

    @group.command(name='drafted', description='Sincronizar resultados de drafted.gg (Valhalla League) y ver estado')
    async def drafted_cmd(interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            n, added = await sync_once()
        except Exception as ex:
            return await interaction.followup.send(f'⚠️ drafted.gg no disponible: {ex}', ephemeral=True)
        total, first, last = store.count()
        await interaction.followup.send(
            f'🔄 drafted.gg: {n} leídos, {added} nuevos.\n📚 Historial local: **{total}** partidos con marcador '
            f'({(first or "-")[:10]} → {(last or "-")[:10]}). Úsalo con `liga: Valhalla League`.\n'
            f'⏱️ Sync automático: {"cada " + str(minutes) + " min" if enabled else "desactivado"} '
            '(drafted solo publica ~3 días; mantén el bot encendido para no perder datos).', ephemeral=True)

    if enabled:
        @bot.listen('on_ready')
        async def _start():
            if not loop.is_running():
                loop.start()
    return store
