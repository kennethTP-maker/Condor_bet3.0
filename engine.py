"""Transparent, non-predictive candidate screening. No fabricated EV or confidence."""
from dataclasses import dataclass

@dataclass(frozen=True)
class Candidate:
    event: str
    market: str
    selection: str
    price: float
    bookmaker: str
    implied_probability: float
    verdict: str
    reason: str

def implied_probability(decimal_odds):
    if decimal_odds <= 1:
        raise ValueError('Decimal odds must be above 1')
    return 1/decimal_odds

def expected_value(probability, decimal_odds):
    if probability < 0 or probability > 1:
        raise ValueError('Probability must be between 0 and 1')
    return probability*decimal_odds - 1

def odds_candidates(payload, max_items=25):
    result=[]
    for e in payload:
        title=f"{e.get('away_team','?')} vs {e.get('home_team','?')}"
        for book in e.get('bookmakers',[])[:3]:
            for market in book.get('markets',[]):
                if market.get('key') not in {'h2h','totals'}: continue
                for outcome in market.get('outcomes',[]):
                    try:
                        price=float(outcome['price'])
                        prob=implied_probability(price)
                    except (ValueError, TypeError, KeyError): continue
                    selection=outcome.get('name','?')
                    if outcome.get('point') is not None:
                        selection+=f" {outcome['point']}"
                    result.append(Candidate(title, market['key'], selection,price,book.get('title','?'),prob,'REVISAR','Cuota disponible, pero no existe una probabilidad predictiva validada ni EV evaluable'))
                    if len(result)>=max_items:return result
    return result
