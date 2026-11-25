# Condor NHL Radar

Panel web con **todos los jugadores activos de los 32 equipos de la NHL**, sus estadísticas oficiales partido a partido, tendencias de forma (🔥 En racha, ▲ Mejorando, ● Estable, ▼ Empeorando, ❄ Frío), velas semanales de rendimiento, Índice de Fuerza y probabilidades estimadas de gol / punto para el próximo partido.

## Datos
Fuente única: APIs públicas oficiales de la NHL (`api-web.nhle.com` y `api.nhle.com/stats`), las mismas que alimentan NHL.com. El script descarga cada partido de cada jugador (patinadores, golpes/bloqueos/robos y porteros), la clasificación, las plantillas actuales y el calendario de la semana, y calcula todo lo demás. Sin claves ni dependencias: solo Python 3.9+.

```bash
python nhl_dashboard/fetch_nhl.py           # genera nhl_dashboard/site/data/nhl.json (~10-20 s)
cd nhl_dashboard/site && python -m http.server 8000   # abrir http://localhost:8000
```

## Jugador vs portero
`nhl_dashboard/h2h.py` lee el play-by-play oficial de cada partido de las últimas 3 temporadas (regular + playoffs, sin penales) y registra tiros, goles y asistencias de cada jugador contra cada portero que estaba en la red. Resultado en `site/data/h2h.json`; la pestaña **Vs portero** muestra los mejores duelos de la semana, cada partido con el portero elegible y un explorador libre. La caché `nhl_dashboard/cache/` hace que la ejecución diaria solo descargue los partidos nuevos (la primera ejecución completa tarda ~2-3 min).

## Actualización cada 24 h
`.github/workflows/nhl-dashboard.yml` se ejecuta todos los días a las 10:17 UTC: vuelve a descargar los datos, los guarda en el repo y publica la web en GitHub Pages.

Para activarlo una sola vez:
1. Fusiona esta rama en `main` (los workflows programados solo corren desde la rama por defecto).
2. En GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. **Actions → "NHL Radar - actualización diaria" → Run workflow** para la primera publicación.

La web quedará en `https://<usuario>.github.io/<repo>/`.

## Métricas
La pestaña **Metodología** del panel explica cada fórmula (IMP, tendencia, forma, Fuerza, velas y probabilidades). Las probabilidades son estimaciones estadísticas para ordenar candidatos, no garantías: no incluyen lesiones del día ni alineaciones confirmadas.
