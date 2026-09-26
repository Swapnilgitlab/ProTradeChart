"""Finds stocks closing within a few percent of their 52-week high, strongest first.

Like the other screens it works with no setup: the watchlist named in WATCHLIST, else your first
watchlist with Zerodha or Dhan symbols, else ten large NSE stocks. The result opens in the Results
tab; click a symbol to open its chart, or add the lot to a watchlist.
"""

import pandas as pd

import protrade as pt

WATCHLIST = None  # a watchlist's name from the app; None chooses for you
DAYS = 252  # trading days in a year
WITHIN_PCT = 3  # how close to the high counts as "near"

symbols = pt.universe(WATCHLIST)
print(f"Screening {len(symbols)} symbols from {symbols.source}\n")

panel = pt.bars_many(symbols, "D", limit=DAYS + 5, errors="skip")

rows = []
for symbol, bars in panel.items():
    if len(bars) < DAYS:
        continue  # not a full year of history
    year = bars.tail(DAYS)
    high = year["high"].max()
    close = year["close"].iloc[-1]
    rows.append(
        {
            "symbol": symbol,
            "close": close,
            "high_52w": high,
            "from_high_pct": (close / high - 1) * 100,  # zero or negative
            "high_on": year["high"].idxmax(),
        }
    )

result = pd.DataFrame(rows, columns=["symbol", "close", "high_52w", "from_high_pct", "high_on"])
near = result[result["from_high_pct"] >= -WITHIN_PCT].sort_values("from_high_pct", ascending=False)
print(f"{len(near)} of {len(result)} closed within {WITHIN_PCT}% of their 52-week high.")
if not near.empty:
    pt.show(near, title=f"Within {WITHIN_PCT}% of the 52-week high")

if panel.errors:
    print(f"\n{len(panel.errors)} symbols could not be fetched:")
    for symbol, error in panel.errors.items():
        print(f"  {symbol}: {error}")
