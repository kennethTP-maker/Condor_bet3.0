"""Declarative market catalog: availability is confirmed by a data provider, not this list.

Each entry is a category with specific market labels. This catalog is UI metadata,
not a promise that a sportsbook or data API offers any of these markets.
"""
MARKET_CATALOG = {
    'soccer': {
        'Ganador y hándicap': ['1X2 / Moneyline', 'Doble oportunidad', 'Empate no apuesta (DNB)', 'Hándicap asiático', 'Hándicap europeo', 'Resultado al descanso'],
        'Goles': ['Total goles FT O/U', 'Goles de equipo', 'Goles 1.er tiempo O/U', 'Goles 2.º tiempo O/U', 'Ambos marcan (BTTS)', 'BTTS + total', 'Primer equipo en marcar', 'Gol en ambos tiempos', 'Marcador correcto'],
        'Jugadores y otros': ['Anotador en cualquier momento', 'Primer anotador', 'Tiros', 'Tiros a puerta', 'Asistencias', 'Córners totales/equipo', 'Tarjetas', 'Faltas'],
    },
    'nfl': {
        'Ganador y puntos': ['Moneyline', 'Spread', 'Total del partido O/U', 'Total de equipo', '1.ª y 2.ª mitad', 'Cuartos O/U', 'Margen de victoria'],
        'Touchdowns': ['Anytime touchdown', 'First touchdown del partido', 'First touchdown del equipo', 'Último touchdown', '2+ touchdowns', '3+ touchdowns', 'Touchdowns de carrera', 'Touchdowns de recepción', 'Passing touchdowns', 'Touchdowns totales del equipo'],
        'Quarterback': ['Passing yards O/U', 'Passing touchdowns O/U', 'Pass completions', 'Pass attempts', 'Interceptions', 'Longest completion', 'Rushing yards del QB'],
        'Carrera y recepción': ['Rushing yards O/U', 'Rushing attempts', 'Longest rush', 'Receiving yards O/U', 'Receptions O/U', 'Longest reception', 'Targets (estadística)', 'Rush + receiving yards'],
        'Otros': ['Field goals', 'Sacks', 'Turnovers', 'Primer equipo en anotar', 'Primer drive', 'Defensive/special teams TD'],
    },
    'nba': {
        'Partido': ['Moneyline', 'Spread', 'Total O/U', 'Team totals', '1.er tiempo', '2.º tiempo', 'Puntos por cuarto', 'Margen de victoria'],
        'Jugadores': ['Puntos', 'Rebotes', 'Asistencias', 'Triples anotados', 'PRA', 'Puntos + rebotes', 'Puntos + asistencias', 'Rebotes + asistencias', 'Robos', 'Tapones', 'Dobles-dobles', 'Triples-dobles'],
    },
    'nhl': {
        'Partido': ['Moneyline', 'Puck line', 'Goles O/U', 'Team totals', 'Totales por período', 'Resultado por período', 'Ambos equipos anotan', 'Primer gol'],
        'Jugadores': ['Tiros a puerta', 'Puntos', 'Goles', 'Asistencias', 'Anytime goal scorer', 'First goal scorer', 'Atajadas del portero'],
    },
    'mlb': {
        'Partido': ['Moneyline', 'Run line', 'Total carreras', 'Totales de equipo', 'Primeras cinco entradas (F5)', 'NRFI/YRFI', 'Carreras por entrada', 'Ganador primera mitad'],
        'Jugadores': ['Pitcher strikeouts', 'Hits', 'Total bases', 'Home run', 'RBI', 'Runs scored', 'Walks', 'Hits permitidos', 'Outs registrados'],
    },
    'tennis': {
        'Ganador y sets': ['Match moneyline', 'Set 1 winner', 'Set 2 winner', 'Ganador de cada set', 'Marcador exacto en sets', 'Total de sets O/U', 'Jugador gana un set', 'Hándicap de sets'],
        'Juegos': ['Total games O/U', 'Hándicap de juegos', 'Juegos por set O/U', 'Ganador de game', 'Primer break', 'Tie-break sí/no', 'Total de tie-breaks', 'Set goes to tie-break'],
        'Jugadores': ['Aces', 'Double faults', 'First serve % (estadística)', 'Break points converted (estadística)', 'Total service games won'],
    },
    'ncaa_football': {
        'Partido': ['Moneyline', 'Spread', 'Total O/U', 'Team totals', '1.ª mitad', '2.ª mitad', 'Cuartos O/U'],
        'Jugadores': ['Anytime touchdown', 'First touchdown', '2+ touchdowns', 'Passing yards', 'Passing touchdowns', 'Rushing yards', 'Receiving yards', 'Receptions'],
    },
    'ncaa_basketball': {
        'Partido': ['Moneyline', 'Spread', 'Total O/U', 'Team totals', '1.er tiempo', '2.º tiempo'],
        'Jugadores': ['Puntos', 'Rebotes', 'Asistencias', 'Triples', 'PRA'],
    },
}

def categories(sport: str):
    return list(MARKET_CATALOG.get(sport, {}))

def markets_for(sport: str, category: str):
    return MARKET_CATALOG.get(sport, {}).get(category, [])

def count_markets(sport: str) -> int:
    return sum(len(v) for v in MARKET_CATALOG.get(sport, {}).values())
