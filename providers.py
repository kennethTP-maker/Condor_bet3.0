"""Fixtures and odds are separate feeds: absence of odds NEVER hides games."""
import datetime as dt
import aiohttp
from catalog import SPORTS

class DataError(RuntimeError):
    pass

class SportsClient:
    def __init__(self):
        self.timeout = aiohttp.ClientTimeout(total=12)

    async def fixtures(self, sport, date):
        path = SPORTS[sport]['espn']
        if not path:
            return [], 'Sin proveedor de calendario configurado para este deporte'
        url = f'https://site.api.espn.com/apis/site/v2/sports/{path}/scoreboard'
        async with aiohttp.ClientSession(timeout=self.timeout) as session:
            async with session.get(url, params={'dates':date.strftime('%Y%m%d'), 'limit':200}) as r:
                if r.status != 200:
                    raise DataError(f'Proveedor de partidos HTTP {r.status}')
                payload = await r.json()
        events = []
        for e in payload.get('events',[]):
            comp = (e.get('competitions') or [{}])[0]
            competitors = comp.get('competitors',[])
            names = [c.get('team',{}).get('displayName','Desconocido') for c in competitors]
            state = e.get('status',{}).get('type',{}).get('state','unknown')
            events.append({'id':str(e.get('id','')), 'name':' vs '.join(names) if len(names)>1 else e.get('name','Partido'), 'date':e.get('date',''), 'state':state, 'sport':sport})
        return events, 'ESPN scoreboard (cobertura según liga)'

    async def odds(self, sport, api_key):
        if not api_key or not SPORTS[sport]['odds']:
            return [], 'No configurado'
        url=f"https://api.the-odds-api.com/v4/sports/{SPORTS[sport]['odds']}/odds/"
        async with aiohttp.ClientSession(timeout=self.timeout) as session:
            async with session.get(url, params={'apiKey':api_key,'regions':'us','markets':'h2h,totals','oddsFormat':'decimal'}) as r:
                if r.status != 200:
                    raise DataError(f'Proveedor de cuotas HTTP {r.status}')
                return await r.json(), 'The Odds API; confirmar cobertura y vigencia'
