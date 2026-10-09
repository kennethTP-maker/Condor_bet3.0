import asyncio
import datetime as dt
import logging
from zoneinfo import ZoneInfo
import discord
from discord import app_commands
from discord.ext import commands, tasks
from dotenv import load_dotenv
from catalog import SPORTS
from markets import categories, markets_for, count_markets
from config import load_settings
from providers import SportsClient, DataError
from engine import odds_candidates
from state import State

load_dotenv()
settings=load_settings()
logging.basicConfig(level=logging.INFO)
log=logging.getLogger('condor')

intents=discord.Intents.default()
bot=commands.Bot(command_prefix='!', intents=intents)
client=SportsClient()
state=State()

class Home(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=600)
        self.add_item(SportSelector())

class SportSelector(discord.ui.Select):
    def __init__(self):
        options=[discord.SelectOption(label=x['label'],value=k,emoji=x['emoji']) for k,x in SPORTS.items()]
        super().__init__(placeholder='Selecciona el deporte',options=options)
    async def callback(self, interaction):
        sport=self.values[0]
        em=discord.Embed(title=f"{SPORTS[sport]['emoji']} {SPORTS[sport]['label']}",description=f"{count_markets(sport)} tipos de mercados catalogados. Selecciona una categoría para explorarlos.\n\n⚠️ El catálogo NO confirma disponibilidad de cuotas ni estadísticas en tu proveedor.",color=0x297cb5)
        await interaction.response.send_message(embed=em,view=MarketCategories(sport),ephemeral=True)

class MarketCategories(discord.ui.View):
    def __init__(self, sport):
        super().__init__(timeout=600)
        self.add_item(CategorySelector(sport))

class CategorySelector(discord.ui.Select):
    def __init__(self, sport):
        self.sport=sport
        opts=[discord.SelectOption(label=cat[:100],value=cat) for cat in categories(sport)]
        super().__init__(placeholder='Selecciona una categoría de mercados',options=opts)

    async def callback(self, interaction):
        category=self.values[0]
        markets=markets_for(self.sport,category)
        content='\n'.join(f'• {x}' for x in markets)
        embed=discord.Embed(title=f"{SPORTS[self.sport]['emoji']} {category}",description=content[:3900],color=0x297cb5)
        embed.set_footer(text='Catálogo de mercados posibles ≠ líneas o cuotas verificadas. /partidos muestra encuentros disponibles.')
        await interaction.response.send_message(embed=embed,ephemeral=True)

@bot.tree.command(name='condor',description='Panel de análisis Condor Bet 3.0')
async def condor(interaction:discord.Interaction):
    em=discord.Embed(title='🦅 Condor Bet 3.0', description='Partidos ≠ oportunidades. Los datos incompletos nunca se ocultan.',color=0x297cb5)
    em.add_field(name='📆 /partidos',value='Partidos de hoy y mañana',inline=False)
    em.add_field(name='💰 /cuotas',value='Mercados disponibles (sin predicción no hay EV)',inline=False)
    em.add_field(name='🔔 /alertas',value='Estado de alertas programadas',inline=False)
    await interaction.response.send_message(embed=em,view=Home(),ephemeral=True)

SPORT_CHOICES=[app_commands.Choice(name=s['label'],value=k) for k,s in SPORTS.items()]

@bot.tree.command(name='partidos',description='Listar TODOS los partidos encontrados, aunque no haya apuestas')
@app_commands.choices(deporte=SPORT_CHOICES)
@app_commands.describe(deporte='Selecciona el deporte',dias='0 = hoy; 1 = hoy y mañana')
async def partidos(interaction:discord.Interaction,deporte:app_commands.Choice[str],dias:app_commands.Range[int,0,1]=1):
    await interaction.response.defer(ephemeral=True)
    local_today=dt.datetime.now(ZoneInfo(settings.timezone)).date()
    try:
        events=[]; source=''
        for i in range(dias+1):
            fetched,source=await client.fixtures(deporte.value,local_today+dt.timedelta(days=i))
            events.extend(fetched)
    except (DataError,asyncio.TimeoutError) as ex:
        return await interaction.followup.send(f'⚠️ Error al obtener partidos: {ex}',ephemeral=True)
    if not events:
        return await interaction.followup.send(f'ℹ️ {deporte.name}: 0 partidos encontrados. Fuente: {source}. Esto NO significa cero oportunidades verificadas.',ephemeral=True)
    descriptions=[]
    for x in events[:30]:
        descriptions.append(f"• **{x['name']}** | {x['state']} | {x['date'][:16]} UTC")
    chunks=[]; chunk=''
    for line in descriptions:
        if len(chunk)+len(line)+1>3500:
            chunks.append(chunk);chunk=''
        chunk+=line+'\n'
    if chunk:chunks.append(chunk)
    embeds=[discord.Embed(title=f"{SPORTS[deporte.value]['emoji']} {deporte.name} | {len(events)} encontrados",description=c,color=0x3e96b6) for c in chunks[:8]]
    embeds[-1].set_footer(text=f'Fuente: {source} | Mostrando {min(30,len(events))}/{len(events)} | Sin filtros de picks')
    await interaction.followup.send(embeds=embeds,ephemeral=True)

@bot.tree.command(name='cuotas',description='Consultar cuotas reales disponibles sin fingir probabilidades')
@app_commands.choices(deporte=SPORT_CHOICES)
async def cuotas(interaction:discord.Interaction,deporte:app_commands.Choice[str]):
    await interaction.response.defer(ephemeral=True)
    if not settings.odds_api_key:
        return await interaction.followup.send('⚠️ Configura THE_ODDS_API_KEY para consultar cuotas; los partidos siguen disponibles con /partidos.',ephemeral=True)
    if not state.allow_call(settings.max_api_calls):
        return await interaction.followup.send('⛔ Límite local de consultas diarias alcanzado.',ephemeral=True)
    try:
        payload,source=await client.odds(deporte.value,settings.odds_api_key)
    except (DataError,asyncio.TimeoutError) as ex:
        return await interaction.followup.send(f'⚠️ Cuotas no disponibles: {ex}',ephemeral=True)
    candidates=odds_candidates(payload)
    if not candidates:
        return await interaction.followup.send(f'Sin cuotas en la respuesta para {deporte.name}. No es un pronóstico de PASS.',ephemeral=True)
    lines=[f"**{c.event}** · {c.market}: {c.selection} · {c.price:.2f} ({c.bookmaker}) · Implícita {c.implied_probability:.1%} · **{c.verdict}**" for c in candidates[:12]]
    await interaction.followup.send(embed=discord.Embed(title=f'💰 Cuotas {deporte.name}',description='\n'.join(lines)[:3900],color=0xdda53a).set_footer(text='No se calculan ventajas sin modelos validados'),ephemeral=True)

@bot.tree.command(name='alertas',description='Revisar estado del monitor automático')
async def alertas(interaction:discord.Interaction):
    await interaction.response.send_message(f"🔔 Alertas {'activas' if settings.alerts_enabled else 'desactivadas'} · Frecuencia {settings.scan_minutes} min · Canal {'configurado' if settings.alert_channel_id else 'no configurado'} · No se envían picks sin datos confirmados.",ephemeral=True)

async def scan_once():
    """MVP alerts: announce a previously-unseen live game and imminent start.
    No claims of betting value until a validated probabilistic model exists."""
    if not settings.alerts_enabled or not settings.alert_channel_id:return
    channel=bot.get_channel(settings.alert_channel_id)
    if channel is None:
        try: channel=await bot.fetch_channel(settings.alert_channel_id)
        except discord.DiscordException: return
    today=dt.datetime.now(ZoneInfo(settings.timezone)).date()
    now=dt.datetime.now(dt.timezone.utc)
    for sport in SPORTS:
        if SPORTS[sport]['espn'] is None:continue
        try:
            events,_=await client.fixtures(sport,today)
        except (DataError,asyncio.TimeoutError) as ex:
            log.warning('Could not scan %s: %s',sport,ex);continue
        for e in events:
            try: kickoff=dt.datetime.fromisoformat(e['date'].replace('Z','+00:00'))
            except ValueError:continue
            mins=(kickoff-now).total_seconds()/60
            kind='LIVE' if e['state']=='in' else ('PREPARTIDO' if e['state']=='pre' and 0<=mins<=90 else None)
            if not kind:continue
            fingerprint=f"{sport}:{e['id']}:{kind}"
            if state.already_sent(fingerprint):continue
            await channel.send(f"{SPORTS[sport]['emoji']} **{kind} | {e['name']}**\nEvento confirmado, no una apuesta recomendada. Usa `/partidos` y `/cuotas` para revisar mercados.",allowed_mentions=discord.AllowedMentions.none())
            state.mark_sent(fingerprint)

@tasks.loop(minutes=15)
async def scheduled_scan():
    await scan_once()

@scheduled_scan.before_loop
async def before_scan():
    await bot.wait_until_ready()

@bot.event
async def on_ready():
    log.info('Bot test logged in as %s',bot.user)
    if not getattr(bot,'_synced',False):
        if settings.guild_id:
            guild=discord.Object(id=settings.guild_id)
            bot.tree.copy_global_to(guild=guild)
            await bot.tree.sync(guild=guild)
        else:
            log.warning('No guild configured; no guild command sync performed')
        bot._synced=True
    if settings.alerts_enabled and not scheduled_scan.is_running():
        scheduled_scan.change_interval(minutes=settings.scan_minutes)
        scheduled_scan.start()

if __name__=='__main__':
    if not settings.token:raise SystemExit('Configure DISCORD_BOT_TOKEN in environment')
    bot.run(settings.token,log_handler=None)
