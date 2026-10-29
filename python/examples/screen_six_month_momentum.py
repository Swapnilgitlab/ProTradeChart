"""Ranks stocks by their six-month return, reading every symbol's history in one go.

pt.panel reads the market data the app holds in memory (Data providers -> Market data -> Keep the
market loaded), so a whole universe arrives in about a second instead of one broker request per
symbol. Symbols it doesn't hold yet are listed and left out; pt.bars_many would fetch them instead.

Like the other screens it works with no setup: the watchlist named in WATCHLIST, else your first
watchlist with Indian market symbols, else ten large NSE stocks.
"""

import pandas as pd

import protrade as pt

WATCHLIST = None  # a watchlist's name from the app; None chooses for you
DAYS = 126  # about six months of trading days
TOP = 20

symbols = pt.universe(WATCHLIST)
stored = pt.panel(symbols, bars=DAYS + 1)
print(f"{len(stored.held)} of {len(symbols)} symbols read from the market data the app holds.")
if stored.missing:
    print(f"Not loaded yet (keep the market loaded to include them): {', '.join(stored.missing[:10])}")

closes = stored.wide("close")
rows = []
for symbol in stored.held:
    series = closes[symbol].dropna()
    if len(series) <= DAYS:
        continue  # not six months of history
    rows.append({"symbol": symbol, "close": series.iloc[-1], "return_6m_pct": (series.iloc[-1] / series.iloc[0] - 1) * 100})

result = pd.DataFrame(rows, columns=["symbol", "close", "return_6m_pct"]).sort_values("return_6m_pct", ascending=False)
print(f"{len(result)} symbols had six months of history.")
if not result.empty:
    pt.show(result.head(TOP), title=f"Top {TOP} by six-month return")
