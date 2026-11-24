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

## 🏀🎮 Analista eBasketball (`/ebasket`)

Analista estadístico para eBasketball (H2H GG League, Battle, etc.). **Aprende solo de los resultados que tú registras o importas**, sin depender de APIs de pago, y valida su propio rendimiento antes de mostrar señales.

| Comando | Qué hace |
|---|---|
| `/ebasket registrar` | Guarda un resultado final (liquida automáticamente los picks abiertos de ese cruce) |
| `/ebasket importar` | Importa historial CSV: `fecha,liga,local,visitante,pts_local,pts_visitante` (`,` o `;`). Ver `ejemplo_ebasket.csv` |
| `/ebasket deshacer` | Borra el último resultado registrado |
| `/ebasket analizar` | Pre-partido: marcador proyectado, total ± σ, margen, prob. de victoria (puntos + Elo), líneas justas, forma L10, H2H. Si das líneas/cuotas: prob. modelo vs mercado sin vig, **EV**, **Kelly fraccional** y veredicto, con botón para registrar el pick |
| `/ebasket envivo` | En vivo: con marcador y minutos restantes mezcla el ritmo observado con el pre-partido y reevalúa totales, hándicap y ML |
| `/ebasket jugador` | Perfil: Elo, ataque/defensa, L5/L10, rachas, últimos partidos |
| `/ebasket ranking` | Ranking Elo por liga |
| `/ebasket backtest` | Validación walk-forward: acierto, Brier vs referencia, log-loss, MAE de totales, calibración |
| `/ebasket balance` | Seguimiento de picks: G-P-N, unidades, ROI real vs EV esperado |

**Modelo**: Elo con multiplicador por margen + ratings de ataque/defensa aprendidos online (encogidos hacia la media de liga con pocas muestras, ponderados hacia la forma reciente) + nivel de anotación, ventaja local y varianza residual de la liga (EWMA). Probabilidades por aproximación normal, con pushes en líneas enteras. Cada liga/formato se modela por separado (4x5 y 4x6 minutos no son comparables).

**Veredictos**: 🟢 VALOR (EV ≥ umbral), 🟡 MARGINAL, ⚪ PASS, 🟠 REVISAR (el modelo discrepa >20 pp del mercado: probablemente falta información), ⚫ SIN DATOS (muestra insuficiente). Ejecuta `/ebasket backtest` antes de confiar en cualquier señal; si el diagnóstico dice que no supera la referencia, no apuestes por ella.

Variables opcionales:

```
EBASKET_DEFAULT_LEAGUE=H2H GG League 4x5
EBASKET_MIN_GAMES=12          # partidos mínimos por jugador para emitir señales
EBASKET_MIN_EV=0.04           # EV mínimo para VALOR
EBASKET_KELLY_FRACTION=0.25   # fracción de Kelly (stake máx 5% del bank)
EBASKET_GAME_MINUTES=20       # duración del partido para /ebasket envivo
EBASKET_BANKROLL_UNITS=100    # bank en unidades para calcular stakes
```

Tests: `python -m unittest discover -s tests`.

## 📈 Kalshi eBasketball + backtest real

Kalshi lista partidos de eBasketball (serie `KXEBASKETBALLGAME`, **Valhalla League**, liquidados por drafted.gg). Solo se usan endpoints públicos (sin clave, sin órdenes). Kalshi publica el ganador, no el marcador, así que se usa un modelo de victoria propio (`winmodel.py`: rating del jugador + rating del equipo 2K + sesgo del primer listado).

- `/ebasket kalshi [horas]`: próximos partidos con prob. del modelo, prob. del mercado y edge = prob − ask − comisión (0.07·P·(1−P)).
- `/ebasket kalshi_ranking`: ranking de jugadores Valhalla.
- `python kalshi_backtest.py [--refresh]`: descarga todo el historial liquidado y el precio 2 min antes de cada partido (reanudable), ajusta parámetros solo en la 1.ª mitad y evalúa fuera de muestra en la 2.ª.

### Resultado del backtest (7 oct – 24 nov 2026, 4.329 partidos, 2.103 de test)

| | Modelo | Mercado Kalshi |
|---|---|---|
| Log-loss (menor = mejor) | 0.6653 | **0.6541** |
| Brier | 0.2366 | **0.2319** |
| Acierto ganador | 58.6 % | **59.6 %** |

Apuestas simuladas comprando al ask + comisión: **ROI entre −4 % y −8 %** para todos los umbrales de edge (t ≈ −0.6 a −2.2). Referencias: siempre favorito −7.2 %, siempre underdog −5.2 %. Un modelo "anclado al mercado" (corrige el precio por jugador) dio ROI +1 % a +15 % con t < 1.3 en pocas apuestas: indistinguible del ruido.

**Conclusión: con datos públicos (solo ganador) el modelo no supera al precio de Kalshi.** El spread (~5¢) más la comisión cuestan ~5 % por operación. El bot muestra esta advertencia en `/ebasket kalshi`. Para buscar ventaja harían falta datos que el mercado no incorpore rápido (marcadores por cuarto, en vivo, alineaciones/equipo asignado antes de que se fije el precio) y repetir el backtest.

## 🗂️ drafted.gg (fuente oficial de Kalshi)

`drafted.py` lee los resultados de la Valhalla League en drafted.gg (robots.txt lo permite): ID del partido, hora, jugador y equipo NBA de local/visitante, **marcador final y por cuartos**. Coincide al 100 % con los ganadores de Kalshi (278/278 emparejados).

**Limitación:** drafted solo publica ~**3 días** de historial. Por eso el bot sincroniza automáticamente (`DRAFTED_SYNC=true`, cada `DRAFTED_SYNC_MINUTES=60`) y guarda cada partido en la base local; `/ebasket drafted` fuerza la sincronización y muestra cuánto historial hay. Los partidos quedan disponibles para `/ebasket analizar`, `envivo`, `jugador`, `ranking` y `backtest` con `liga: Valhalla League`. **Mantén el bot encendido con volumen persistente** o se pierde historial.

`python drafted_backtest.py --db data/condor3.sqlite3` cruza el modelo de puntos con los precios de Kalshi (`kalshi_backtest.py` debe haberse ejecutado antes para el caché de precios).

Backtest preliminar (21–24 nov, 116 partidos de test, **muestra demasiado pequeña para concluir**): log-loss modelo 0.624 vs mercado 0.598; ROI simulado negativo. Repetir con ≥3–4 semanas acumuladas.
