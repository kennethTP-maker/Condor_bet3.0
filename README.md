# 🦅 Condor Bet 3.0 — Discord MVP

A **standalone test bot**. Does not read or change Condor Bet 2.0 files or production SQLite. Created for testing: no guarantee of predictive edges.

## What works

- `/condor`: Discord embedded dashboard and sports picker
- `/partidos`: **shows fixtures even when there are zero bets**, today/tomorrow, by sport, via ESPN scoreboards where supported
- `/cuotas`: reads actual h2h/totals markets from configured The Odds API account, with sportsbook, odds and implied probability; **no invented EV**
- `/alertas`: monitor status
- Automatic optional **pre-game (within 90 min)** and **live-game** event notices posted to a channel, deduplicated across restarts in local SQLite
- 8 sport categories including NCAA; tennis is catalogued but requires its own fixture adapter.

**Not yet implemented**: validated betting probability models, automated value bet recommendations, reliable in-play odds monitoring, player props, ticket OCR, historical database import, all legacy analytics, complete L5/L10/L15 data. These are planned modules, not functioning claims. Live events are *not* the same as live betting opportunities. ESPN is a best-effort, unofficial public scoreboard and may omit games or alter its responses. Markets are restricted to h2h and totals in this MVP.

## Local installation

Python 3.11+.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env ONLY LOCALLY; never commit it
PYTHONPATH=src python -m condor.bot
```

At minimum set `DISCORD_BOT_TOKEN` to the token of a **new, separate** test Discord application and `DISCORD_GUILD_ID` to the testing server. For scheduled notices set `DISCORD_ALERT_CHANNEL_ID` and `ALERTS_ENABLED=true`; start with false and verify first. Optionally set `THE_ODDS_API_KEY`. Do not copy the existing production bot token. The test bot needs `bot` and `applications.commands` scopes and permission to send messages and embeds; add `View Channel` on chosen test channel. Commands will sync to specified test server only. **Never put any actual token in ChatGPT.**

### Hosting

For an always-connected Gateway client, an always-running background process (worker/service) is recommended. Railway Hobby has a $5 monthly minimum which includes $5 resource spend; usage beyond it is extra. Attach a persistent volume if using SQLite for durable state, mounted at the data directory; or replace SQLite with hosted Postgres. Running on ephemeral storage loses history and deduplication when containers restart. Configure env vars in host dashboard and run `PYTHONPATH=src python -m condor.bot`. Set a spending cap/alerts on cloud and data accounts.

### API consumption

ESPN scoreboard is requested once per sport per alert polling cycle, even if no relevant games. With 7 supported categories and 15-minute interval, that can cause ~672 scoreboard calls/day. Choose 30-60 minutes or add cache and schedules to cut queries. The `MAX_API_CALLS_PER_DAY` counter **only** applies to calls from `/cuotas`, not ESPN; external API quota may use a different unit per request or market. The Odds API key is optional; odds requests may incur vendor quota usage and market coverage depends on subscription. **This starter does not make automatic paid odds API requests.**

### Risk management

This is an informational screening system, not an auto-betting product. No bets are placed; no claimed win rates or guaranteed profitable picks. Markets, start times, outages and latency should be independently checked. Do not expose an open HTTP endpoint with credentials. Use dedicated test token, guild and data store. If you add predictive models later, validate them on out-of-sample seasons and track closing-line value and calibration, not just historic hit rate.

## Catálogo ampliado (Oct 2026)

El menú `/condor` muestra categorías y **tipos de mercados posibles** para todos los deportes, incluidos touchdowns (anytime, primer TD del partido/equipo, 2+, passing TD), yardas (passing, rushing, receiving), recepciones y props NFL; moneyline, sets, marcador de sets, juegos, hándicaps y aces de tenis; además de Soccer, NHL, NBA, MLB y NCAA. Fuente de verdad: `src/condor/markets.py`.

**Importante:** este catálogo es la taxonomía de la interfaz, no una afirmación de que ESPN o The Odds API ofrecen todos esos mercados. La primera versión solo consulta mercados principales (`h2h,totals`) para los deportes configurados; los mercados de jugadores, sets, períodos y las alertas cuantitativas requieren proveedores contratados, implementación y validación adicionales. Los escaneos automáticos del starter avisan de partidos, *no* de oportunidades de apuesta de valor positivo.

Para una instalación totalmente nueva en Discord, crea una tercera aplicación independiente llamada `Condor Bet 3.0`, conserva los bots originales y coloca su token únicamente en el secret `DISCORD_BOT_TOKEN` del nuevo despliegue. No copies ninguna base de datos ni token de producción.
