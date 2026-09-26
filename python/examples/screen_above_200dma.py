"""Screens stocks for those trading above their 200-day moving average.

It works the first time with no setup. What it looks at: the watchlist named in WATCHLIST below,
if you name one; otherwise your first watchlist with Zerodha or Dhan symbols on it; otherwise ten
large NSE stocks. The first run fetches history from your broker; the app keeps it, so later runs
only fetch what is new (a few hundred symbols take minutes the first time, at the brokers' rate
limits). The result opens in the Results tab: click a symbol to open its chart.
"""

import pandas as pd

import protrade as pt

WATCHLIST = None  # a watchlist's name from the app, like "Nifty 50"; None chooses for you
LENGTH = 200  # days in the average

symbols = pt.universe(WATCHLIST)
print(f"Screening {len(symbols)} symbols from {symbols.source}\n")

# A little more history than the average needs. `errors="skip"` leaves out a symbol the
# broker doesn't know instead of stopping the whole run.
panel = pt.bars_many(symbols, "D", limit=LENGTH + 50, errors="skip")

rows = []
for symbol, bars in panel.items():
    if len(bars) < LENGTH:
        continue  # too new to have an average
    close = bars["close"]
    average = close.rolling(LENGTH).mean().iloc[-1]
    rows.append(
        {
            "symbol": symbol,
            "close": close.iloc[-1],
            f"sma{LENGTH}": average,
            "above_pct": (close.iloc[-1] / average - 1) * 100,
        }
    )

result = pd.DataFrame(rows)
if result.empty:
    print("Nothing to show: no symbol had enough history.")
else:
    above = result[result["close"] > result[f"sma{LENGTH}"]].sort_values("above_pct", ascending=False)
    print(f"{len(above)} of {len(result)} are above their {LENGTH}-day average.")
    if not above.empty:
        pt.show(above, title=f"Above the {LENGTH}-day average")

if panel.errors:
    print(f"\n{len(panel.errors)} symbols could not be fetched:")
    for symbol, error in panel.errors.items():
        print(f"  {symbol}: {error}")
