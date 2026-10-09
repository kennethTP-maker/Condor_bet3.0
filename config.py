import os
from dataclasses import dataclass
from zoneinfo import ZoneInfo

@dataclass(frozen=True)
class Settings:
    token: str
    guild_id: int
    alert_channel_id: int
    odds_api_key: str
    alerts_enabled: bool
    scan_minutes: int
    odds_scan_minutes: int
    max_api_calls: int
    timezone: str


def load_settings():
    tz = os.getenv('TIMEZONE', 'America/New_York')
    ZoneInfo(tz)
    scan = max(5, int(os.getenv('SCAN_INTERVAL_MINUTES', '15')))
    odds_scan = max(15, int(os.getenv('ODDS_SCAN_INTERVAL_MINUTES', '60')))
    return Settings(
        token=os.getenv('DISCORD_BOT_TOKEN', ''),
        guild_id=int(os.getenv('DISCORD_GUILD_ID') or 0),
        alert_channel_id=int(os.getenv('DISCORD_ALERT_CHANNEL_ID') or 0),
        odds_api_key=os.getenv('THE_ODDS_API_KEY', ''),
        alerts_enabled=os.getenv('ALERTS_ENABLED', 'false').lower() == 'true',
        scan_minutes=scan, odds_scan_minutes=odds_scan,
        max_api_calls=max(0,int(os.getenv('MAX_API_CALLS_PER_DAY','40'))),
        timezone=tz,
    )
