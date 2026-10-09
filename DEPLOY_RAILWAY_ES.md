# Condor Bet 3.0 — Despliegue en Railway

## Alcance actual
MVP: menú Discord `/condor`, catálogos, `/partidos`, `/cuotas` si hay clave, y avisos de juegos prepartido / en vivo opcionales. **Los avisos actuales NO son recomendaciones con valor estadístico validado.** Mercados de tenis y otros deportes en el catálogo no garantizan cobertura de proveedor.

## Desde móvil (GitHub + Railway)
1. Crea un repositorio PRIVADO en GitHub y sube el contenido de la carpeta `condor_bet_3` a la RAÍZ del repositorio (no subir `data`, `.env`, archivos SQLite ni tokens).
2. Abre Railway > New Project > Deploy from GitHub repo. Vincula el repositorio.
3. Railway detectará el `Dockerfile` y construirá la imagen.
4. Antes de activar el servicio, en Variables configura:
   - `DISCORD_BOT_TOKEN`: token de la nueva aplicación **Condor Bet 3.0**.
   - `DISCORD_GUILD_ID`: Server ID del servidor de Discord.
   - `TIMEZONE`: `America/New_York`.
   - `ALERTS_ENABLED`: `false` inicialmente.
   - `DISCORD_ALERT_CHANNEL_ID`: ID del canal dedicado a alertas (si se activan).
   - `THE_ODDS_API_KEY`: opcional, para cuotas (puede implicar cargos y límites).
   - `MAX_API_CALLS_PER_DAY`: `40` inicialmente.
5. Implementa el servicio con **una sola réplica**. No necesitas un dominio público ni HTTP para el bot Gateway.
6. Revisa logs. Debería figurar `Bot test logged in as ...` y sincronizar comandos en el servidor indicado.
7. Ejecuta `/condor` y `/partidos` en Discord. Luego configura el canal de alertas, activa `ALERTS_ENABLED=true` y despliega los cambios de Variables.

## Límites y seguridad
- El contenedor usa almacenamiento efímero. SQLite usado por el MVP para deduplicación puede perderse al desplegar/reiniciar. Para historial permanente se requiere un volumen o base de datos persistente.
- No alojar otro bot con el mismo token simultáneamente.
- No copiar el token en código, GitHub, capturas ni chats.
- Railway factura uso de recursos según el plan. Establece límites y revisa Usage/Billing antes de mantenerlo 24/7.
- Alertas de eventos no son pronósticos ni recomendaciones de apuesta; el motor de detección de valor necesita desarrollo y validación.
