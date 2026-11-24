"""Discord command group /ebasket: professional eBasketball analyst."""
from __future__ import annotations

import os
from datetime import datetime, timezone

import discord
from discord import app_commands

from ebasket import (EBasketModel, Match, backtest, evaluate_markets, fair_odds, live_projection,
                     parse_csv, parse_date)
from ebasket_store import EBasketStore
import kalshi_bot
import drafted_sync

COLOR = 0xE8590C
VERDICT_ICON = {'VALOR': '🟢', 'MARGINAL': '🟡', 'PASS': '⚪', 'REVISAR': '🟠', 'SIN DATOS': '⚫'}
DISCLAIMER = 'Modelo estadístico propio; valida con /ebasket backtest. No es garantía de beneficio.'


def _cfg():
    return {
        'league': os.getenv('EBASKET_DEFAULT_LEAGUE', 'H2H GG League 4x5'),
        'min_games': max(3, int(os.getenv('EBASKET_MIN_GAMES', '12'))),
        'min_ev': float(os.getenv('EBASKET_MIN_EV', '0.04')),
        'kelly': float(os.getenv('EBASKET_KELLY_FRACTION', '0.25')),
        'game_minutes': float(os.getenv('EBASKET_GAME_MINUTES', '20')),
        'bankroll_units': float(os.getenv('EBASKET_BANKROLL_UNITS', '100')),
    }


def _pct(x):
    return f'{x:.1%}'


def _odds(x):
    return '∞' if x == float('inf') else f'{x:.2f}'


def setup(bot: discord.ext.commands.Bot, db):
    store = EBasketStore(db)
    cfg = _cfg()
    group = app_commands.Group(name='ebasket', description='Analista profesional de eBasketball')

    def model_for(league):
        matches = store.matches(league)
        return EBasketModel.fit(matches, min_games=cfg['min_games']), len(matches)

    # ------------------------------------------------------------ autocomplete
    async def ac_player(interaction: discord.Interaction, current: str):
        league = getattr(interaction.namespace, 'liga', None)
        names = store.players(league, current) or store.players(None, current)
        return [app_commands.Choice(name=n[:100], value=n[:100]) for n in names]

    async def ac_league(interaction: discord.Interaction, current: str):
        names = [x for x in store.leagues() if current.lower() in x.lower()] or [cfg['league']]
        return [app_commands.Choice(name=n[:100], value=n[:100]) for n in names[:25]]

    # ------------------------------------------------------------ registrar
    @group.command(name='registrar', description='Registrar el resultado final de un partido')
    @app_commands.describe(local='Jugador local (nick)', visitante='Jugador visitante (nick)',
                           pts_local='Puntos local', pts_visitante='Puntos visitante',
                           liga='Liga/formato (ej. H2H GG League 4x5)', fecha='ISO o dd/mm/aaaa hh:mm (UTC); vacío = ahora')
    @app_commands.autocomplete(local=ac_player, visitante=ac_player, liga=ac_league)
    async def registrar(interaction: discord.Interaction, local: str, visitante: str,
                        pts_local: app_commands.Range[int, 0, 400], pts_visitante: app_commands.Range[int, 0, 400],
                        liga: str | None = None, fecha: str | None = None):
        try:
            when = parse_date(fecha)
        except ValueError as ex:
            return await interaction.response.send_message(f'⚠️ {ex}', ephemeral=True)
        m = Match(when, liga or cfg['league'], local, visitante, pts_local, pts_visitante)
        settled_before = len(store.picks('OPEN'))
        added = store.add_matches([m], source=f'discord:{interaction.user.id}')
        settled = settled_before - len(store.picks('OPEN'))
        msg = (f'✅ Registrado: **{local} {pts_local} - {pts_visitante} {visitante}** · {m.league}'
               if added else '⚠️ Ese resultado ya existía (duplicado ignorado).')
        if settled:
            msg += f'\n📒 {settled} pick(s) liquidado(s). Revisa `/ebasket balance`.'
        await interaction.response.send_message(msg, ephemeral=True)

    # ------------------------------------------------------------ importar
    @group.command(name='importar', description='Importar historial CSV (fecha,liga,local,visitante,pts_local,pts_visitante)')
    @app_commands.autocomplete(liga=ac_league)
    async def importar(interaction: discord.Interaction, archivo: discord.Attachment, liga: str | None = None):
        await interaction.response.defer(ephemeral=True)
        if archivo.size > 5_000_000:
            return await interaction.followup.send('⚠️ Archivo demasiado grande (máx 5 MB).', ephemeral=True)
        raw = await archivo.read()
        try:
            text = raw.decode('utf-8-sig')
        except UnicodeDecodeError:
            text = raw.decode('latin-1')
        matches, errors = parse_csv(text, liga or cfg['league'])
        added = store.add_matches(matches, source=f'csv:{interaction.user.id}')
        msg = f'📥 Filas válidas: {len(matches)} · nuevas: {added} · duplicadas: {len(matches) - added} · errores: {len(errors)}'
        if errors:
            msg += '\n```' + '\n'.join(errors[:10]) + '```'
        await interaction.followup.send(msg, ephemeral=True)

    @group.command(name='deshacer', description='Borrar el último resultado registrado')
    async def deshacer(interaction: discord.Interaction):
        row = store.delete_last()
        await interaction.response.send_message(
            f'🗑️ Borrado: {row[1]} {row[3]} - {row[4]} {row[2]}' if row else 'No hay resultados.', ephemeral=True)

    # ------------------------------------------------------------ analizar
    @group.command(name='analizar', description='Análisis pre-partido: proyección, probabilidades y valor vs cuotas')
    @app_commands.describe(
        local='Jugador local', visitante='Jugador visitante', liga='Liga/formato',
        linea_total='Línea de puntos totales (ej. 165.5)', cuota_over='Cuota decimal Over', cuota_under='Cuota decimal Under',
        handicap_local='Hándicap del LOCAL (ej. -4.5)', cuota_hcp_local='Cuota hándicap local',
        cuota_hcp_visitante='Cuota hándicap visitante', cuota_ml_local='Cuota ganador local',
        cuota_ml_visitante='Cuota ganador visitante')
    @app_commands.autocomplete(local=ac_player, visitante=ac_player, liga=ac_league)
    async def analizar(interaction: discord.Interaction, local: str, visitante: str, liga: str | None = None,
                       linea_total: float | None = None, cuota_over: float | None = None,
                       cuota_under: float | None = None, handicap_local: float | None = None,
                       cuota_hcp_local: float | None = None, cuota_hcp_visitante: float | None = None,
                       cuota_ml_local: float | None = None, cuota_ml_visitante: float | None = None):
        await interaction.response.defer(ephemeral=True)
        league = liga or cfg['league']
        model, n = model_for(league)
        if not n:
            return await interaction.followup.send(
                f'ℹ️ No hay resultados en **{league}**. Usa `/ebasket registrar` o `/ebasket importar`.', ephemeral=True)
        proj = model.project(local, visitante)
        evals = evaluate_markets(
            proj, total_line=linea_total, over_odds=cuota_over, under_odds=cuota_under,
            spread_line=handicap_local, home_spread_odds=cuota_hcp_local, away_spread_odds=cuota_hcp_visitante,
            home_ml=cuota_ml_local, away_ml=cuota_ml_visitante, min_ev=cfg['min_ev'], kelly_fraction=cfg['kelly'])
        embed = analysis_embed(model, proj, evals, league, n)
        view = PickView(store, interaction.user.id, league, proj, evals, cfg) if any(
            e.verdict in ('VALOR', 'MARGINAL') for e in evals) else discord.utils.MISSING
        await interaction.followup.send(embed=embed, view=view, ephemeral=True)

    # ------------------------------------------------------------ envivo
    @group.command(name='envivo', description='Proyección en vivo con el marcador y minutos restantes')
    @app_commands.describe(minutos_restantes='Minutos de juego que faltan', minutos_totales='Duración total (4x5 = 20)',
                           linea_total='Línea en vivo de totales', handicap_local='Hándicap en vivo del local')
    @app_commands.autocomplete(local=ac_player, visitante=ac_player, liga=ac_league)
    async def envivo(interaction: discord.Interaction, local: str, visitante: str,
                     pts_local: app_commands.Range[int, 0, 400], pts_visitante: app_commands.Range[int, 0, 400],
                     minutos_restantes: app_commands.Range[float, 0, 120], liga: str | None = None,
                     minutos_totales: app_commands.Range[float, 1, 120] | None = None,
                     linea_total: float | None = None, cuota_over: float | None = None,
                     cuota_under: float | None = None, handicap_local: float | None = None,
                     cuota_hcp_local: float | None = None, cuota_hcp_visitante: float | None = None,
                     cuota_ml_local: float | None = None, cuota_ml_visitante: float | None = None):
        await interaction.response.defer(ephemeral=True)
        league = liga or cfg['league']
        model, n = model_for(league)
        if not n:
            return await interaction.followup.send(f'ℹ️ No hay resultados en **{league}**.', ephemeral=True)
        total_min = minutos_totales or cfg['game_minutes']
        proj = model.project(local, visitante)
        live = live_projection(proj, pts_local, pts_visitante, minutos_restantes, total_min)
        evals = evaluate_markets(
            proj, total_line=linea_total, over_odds=cuota_over, under_odds=cuota_under,
            spread_line=handicap_local, home_spread_odds=cuota_hcp_local, away_spread_odds=cuota_hcp_visitante,
            home_ml=cuota_ml_local, away_ml=cuota_ml_visitante, min_ev=cfg['min_ev'], kelly_fraction=cfg['kelly'],
            total_mean=live.total, total_sd=live.sd_total, margin_mean=live.margin, margin_sd=live.sd_margin,
            p_home=live.p_home, max_gap=0.30)
        em = discord.Embed(title=f'🔴 EN VIVO · {proj.home} {pts_local} - {pts_visitante} {proj.away}',
                           description=f'{league} · {live.elapsed_frac:.0%} jugado · quedan {minutos_restantes:g} min',
                           color=0xD6336C)
        em.add_field(name='📈 Ritmo', value=(f'Ritmo actual → {live.pace_total:.1f} pts/partido\n'
                                             f'Pre-partido: {proj.total:.1f}'), inline=True)
        em.add_field(name='🎯 Final proyectado', value=(f'Total **{live.total:.1f}** ± {live.sd_total:.1f}\n'
                                                       f'Margen local **{live.margin:+.1f}** ± {live.sd_margin:.1f}'),
                     inline=True)
        em.add_field(name='🏆 Prob. victoria', value=(f'{proj.home}: **{_pct(live.p_home)}** (justa {_odds(fair_odds(live.p_home))})\n'
                                                     f'{proj.away}: **{_pct(1 - live.p_home)}** (justa {_odds(fair_odds(1 - live.p_home))})'),
                     inline=False)
        _add_market_field(em, evals)
        em.set_footer(text=f'Confianza base: {proj.confidence} · Las cuotas en vivo cambian en segundos. {DISCLAIMER}')
        await interaction.followup.send(embed=em, ephemeral=True)

    # ------------------------------------------------------------ jugador
    @group.command(name='jugador', description='Perfil de un jugador: rating, forma y tendencias')
    @app_commands.autocomplete(nombre=ac_player, liga=ac_league)
    async def jugador(interaction: discord.Interaction, nombre: str, liga: str | None = None):
        league = liga or cfg['league']
        model, _ = model_for(league)
        p = model.known(nombre)
        if not p:
            return await interaction.response.send_message(f'ℹ️ {nombre} no tiene partidos en {league}.', ephemeral=True)
        rank = [x.name for x in model.ranking(1)].index(p.name) + 1
        f10, f5 = model.form(nombre, 10), model.form(nombre, 5)
        em = discord.Embed(title=f'🎮 {p.name}', description=f'{league} · #{rank} de {len(model.players)}', color=COLOR)
        em.add_field(name='Rating', value=(f'Elo **{p.elo:.0f}**\nAtaque {p.off:+.1f} pts\n'
                                           f'Defensa {-p.dfn:+.1f} pts\nNeto {p.off - p.dfn:+.1f}'), inline=True)
        em.add_field(name='Global', value=(f'{p.games} partidos\n{p.wins}-{p.games - p.wins} '
                                           f'({p.wins / p.games:.0%})'), inline=True)
        for label, f in (('Últimos 5', f5), ('Últimos 10', f10)):
            em.add_field(name=label, value=(f"`{f['string']}` · racha {f['streak']}\nPF {f['pf']:.1f} · PC {f['pa']:.1f}\n"
                                            f"Total medio {f['total']:.1f}"), inline=False)
        last = p.history[-5:][::-1]
        em.add_field(name='Recientes', value='\n'.join(
            f"{'✅' if pf > pa else '❌'} {pf}-{pa} vs {opp} · {d:%d/%m %H:%M}" for d, opp, pf, pa in last), inline=False)
        await interaction.response.send_message(embed=em, ephemeral=True)

    # ------------------------------------------------------------ ranking
    @group.command(name='ranking', description='Ranking Elo de jugadores')
    @app_commands.autocomplete(liga=ac_league)
    async def ranking(interaction: discord.Interaction, liga: str | None = None,
                      minimo_partidos: app_commands.Range[int, 1, 500] = 5):
        league = liga or cfg['league']
        model, n = model_for(league)
        rows = model.ranking(minimo_partidos)[:20]
        if not rows:
            return await interaction.response.send_message(f'ℹ️ Sin jugadores con ≥{minimo_partidos} partidos en {league}.', ephemeral=True)
        lines = [f'`{i:>2}.` **{p.name}** · Elo {p.elo:.0f} · neto {p.off - p.dfn:+.1f} · '
                 f'{p.wins}-{p.games - p.wins}' for i, p in enumerate(rows, 1)]
        em = discord.Embed(title=f'🏅 Ranking · {league}', description='\n'.join(lines), color=COLOR)
        em.set_footer(text=f'{n} partidos · media liga {model.mu * 2:.1f} pts/partido · σ total {model.var_total ** .5:.1f}')
        await interaction.response.send_message(embed=em, ephemeral=True)

    # ------------------------------------------------------------ backtest
    @group.command(name='backtest', description='Validación walk-forward del modelo (calibración y error)')
    @app_commands.autocomplete(liga=ac_league)
    async def backtest_cmd(interaction: discord.Interaction, liga: str | None = None):
        await interaction.response.defer(ephemeral=True)
        league = liga or cfg['league']
        bt = backtest(store.matches(league), min_games=cfg['min_games'])
        if not bt:
            return await interaction.followup.send(
                f'ℹ️ Datos insuficientes en {league}: hacen falta jugadores con ≥{cfg["min_games"]} partidos.', ephemeral=True)
        skill = 1 - bt.brier / bt.brier_baseline if bt.brier_baseline else 0
        em = discord.Embed(title=f'🧪 Backtest · {league}', color=0x5C7CFA,
                           description=f'{bt.n} partidos predichos solo con información previa a cada uno.')
        em.add_field(name='Ganador', value=(f'Acierto {_pct(bt.accuracy)}\nBrier {bt.brier:.4f} (base {bt.brier_baseline:.4f})\n'
                                            f'Skill {skill:+.1%}\nLog-loss {bt.logloss:.4f}'), inline=True)
        em.add_field(name='Puntos', value=(f'MAE total {bt.mae_total:.2f} (base {bt.mae_total_baseline:.2f})\n'
                                           f'MAE margen {bt.mae_margin:.2f}\nDentro de ±1σ: {_pct(bt.within_1sd_total)} (ideal ≈68%)'),
                     inline=True)
        em.add_field(name='Calibración (pred → real)', value='\n'.join(
            f'`{b:>7}` n={c:<4} {_pct(p)} → {_pct(o)}' for b, c, p, o in bt.calibration), inline=False)
        verdict = ('✅ El modelo mejora la referencia.' if skill > 0.02 and bt.mae_total < bt.mae_total_baseline
                   else '⚠️ El modelo NO supera claramente la referencia: no apuestes por sus señales todavía.')
        em.add_field(name='Diagnóstico', value=verdict, inline=False)
        await interaction.followup.send(embed=em, ephemeral=True)

    # ------------------------------------------------------------ balance
    @group.command(name='balance', description='Seguimiento de picks registrados: ROI, unidades y abiertos')
    async def balance(interaction: discord.Interaction):
        rows = store.picks()
        settled = [r for r in rows if r[12] != 'OPEN']
        open_ = [r for r in rows if r[12] == 'OPEN']
        em = discord.Embed(title='📒 Balance de picks eBasketball', color=0x37B24D)
        if settled:
            staked = sum(r[11] for r in settled)
            profit = sum(r[13] for r in settled)
            wins = sum(r[12] == 'WIN' for r in settled)
            losses = sum(r[12] == 'LOSS' for r in settled)
            exp_profit = sum(r[10] * r[11] for r in settled)
            em.add_field(name='Resultados', value=(f'{wins}-{losses}-{len(settled) - wins - losses} (G-P-N)\n'
                                                   f'Stake {staked:.2f} u · Beneficio **{profit:+.2f} u**\n'
                                                   f'ROI **{profit / staked:+.1%}** · EV esperado {exp_profit / staked:+.1%}'),
                         inline=False)
        else:
            em.description = 'Sin picks liquidados todavía.'
        if open_:
            em.add_field(name=f'Abiertos ({len(open_)})', value='\n'.join(
                f"#{r[0]} {r[3]} vs {r[4]} · {r[6].split(':', 1)[-1]} @ {r[8]:.2f} · {r[11]:.2f}u" for r in open_[:10]),
                inline=False)
        em.set_footer(text='Los picks se liquidan automáticamente al registrar el resultado del cruce.')
        await interaction.response.send_message(embed=em, ephemeral=True)

    kalshi_bot.setup(group, db)
    drafted_sync.setup(bot, group, db, store)
    bot.tree.add_command(group)
    return store


def _add_market_field(em, evals):
    if not evals:
        em.add_field(name='💰 Mercados', value='Añade línea y cuotas para evaluar valor (EV, Kelly).', inline=False)
        return
    lines = []
    for e in evals:
        mkt = f' · mercado {_pct(e.p_market)}' if e.p_market is not None else ''
        push = f' · push {_pct(e.p_push)}' if e.p_push > 0.001 else ''
        stake = f' · stake {e.kelly:.1%} bank' if e.kelly else ''
        lines.append(f"{VERDICT_ICON[e.verdict]} **{e.selection}** @ {e.odds:.2f} → modelo {_pct(e.p_model)}{mkt}{push} · "
                     f"EV **{e.ev:+.1%}** · {e.verdict}{stake}")
    em.add_field(name='💰 Mercados', value='\n'.join(lines)[:1024], inline=False)


def analysis_embed(model, proj, evals, league, n):
    em = discord.Embed(title=f'🏀🎮 {proj.home} vs {proj.away}', description=f'{league} · modelo entrenado con {n} partidos',
                       color=COLOR)
    em.add_field(name='🎯 Proyección', value=(f'**{proj.home_pts:.1f} - {proj.away_pts:.1f}**\n'
                                             f'Total {proj.total:.1f} ± {proj.sd_total:.1f}\n'
                                             f'Margen local {proj.margin:+.1f} ± {proj.sd_margin:.1f}'), inline=True)
    em.add_field(name='🏆 Prob. victoria', value=(f'{proj.home}: **{_pct(proj.p_home)}**\n{proj.away}: **{_pct(1 - proj.p_home)}**\n'
                                                 f'(puntos {_pct(proj.p_home_points)} · Elo {_pct(proj.p_home_elo)})'), inline=True)
    em.add_field(name='⚖️ Líneas justas', value=(f'ML {_odds(fair_odds(proj.p_home))} / {_odds(fair_odds(1 - proj.p_home))}\n'
                                                f'Total {proj.total:.1f}\nHándicap local {-proj.margin:+.1f}'), inline=True)
    for name in (proj.home, proj.away):
        p, f = model.known(name), model.form(name, 10)
        if not p:
            em.add_field(name=f'🎮 {name}', value='Sin historial en esta liga', inline=True)
            continue
        em.add_field(name=f'🎮 {p.name}', value=(f'Elo {p.elo:.0f} · {p.games} PJ\nAtq {p.off:+.1f} · Def {-p.dfn:+.1f}\n'
                                               f"L10 `{f['string']}` ({f['streak']})\nPF {f['pf']:.1f} · PC {f['pa']:.1f}"), inline=True)
    h2h = model.head_to_head(proj.home, proj.away)
    em.add_field(name='🤝 H2H', value=(f"{h2h['home_wins']}-{h2h['n'] - h2h['home_wins']} para {proj.home}\n"
                                      f"Total medio {h2h['avg_total']:.1f}\nMargen medio {h2h['avg_margin']:+.1f}")
                 if h2h else 'Sin enfrentamientos previos', inline=True)
    _add_market_field(em, evals)
    em.set_footer(text=f'Confianza: {proj.confidence} · {DISCLAIMER}')
    return em


class PickView(discord.ui.View):
    def __init__(self, store, user_id, league, proj, evals, cfg):
        super().__init__(timeout=900)
        for e in [x for x in evals if x.verdict in ('VALOR', 'MARGINAL')][:5]:
            self.add_item(PickButton(store, user_id, league, proj, e, cfg))


class PickButton(discord.ui.Button):
    def __init__(self, store, user_id, league, proj, e, cfg):
        super().__init__(label=f'📌 {e.selection} @ {e.odds:.2f}'[:80],
                         style=discord.ButtonStyle.success if e.verdict == 'VALOR' else discord.ButtonStyle.secondary)
        self.args = (store, user_id, league, proj, e, cfg)

    async def callback(self, interaction: discord.Interaction):
        store, user_id, league, proj, e, cfg = self.args
        sel = f'{e.side}:{e.selection}'
        # Stake in units: fractional Kelly of the bankroll, minimum 0.5u for tracking MARGINAL picks.
        stake = round(max(e.kelly * cfg['bankroll_units'], 0.5), 2)
        pid = store.add_pick(user_id, league, proj.home, proj.away, e.market, sel, e.line, e.odds, e.p_model, e.ev, stake)
        self.disabled = True
        await interaction.response.edit_message(view=self.view)
        await interaction.followup.send(f'📌 Pick #{pid} registrado: {e.selection} @ {e.odds:.2f} · {stake}u. '
                                        'Se liquidará al registrar el resultado.', ephemeral=True)
