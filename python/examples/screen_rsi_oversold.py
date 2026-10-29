"""Finds stocks whose 14-day RSI is below 30 (oversold), most oversold first.

Like the other screens it works with no setup: the watchlist named in WATCHLIST, else your first
watchlist with Indian market symbols, else ten large NSE stocks. The result opens in the
Results tab; click a symbol to open its chart, or add the lot to a watchlist.
"""

import pandas as pd

import protrade as pt

WATCHLIST = None  # a watchlist's name from the app; None chooses for you
LENGTH = 14  # days in the RSI
BELOW = 30  # oversold is below this


def rsi(close: pd.Series, length: int = LENGTH) -> pd.Series:
    """Wilder's relative strength index."""
    change = close.diff()
    gain = change.clip(lower=0).ewm(alpha=1 / length, adjust=False, min_periods=length).mean()
    loss = (-change.clip(upper=0)).ewm(alpha=1 / length, adjust=False, min_periods=length).mean()
    return 100 - 100 / (1 + gain / loss)


symbols = pt.universe(WATCHLIST)
print(f"Screening {len(symbols)} symbols from {symbols.source}\n")

# RSI settles after a few times its length, so ask for a comfortable amount.
panel = pt.bars_many(symbols, "D", limit=LENGTH * 10, errors="skip")

rows = []
for symbol, bars in panel.items():
    if len(bars) < LENGTH * 3:
        continue
    close = bars["close"]
    rows.append(
        {
            "symbol": symbol,
            "close": close.iloc[-1],
            "rsi": rsi(close).iloc[-1],
            "change_5d_pct": (close.iloc[-1] / close.iloc[-6] - 1) * 100,
        }
    )

result = pd.DataFrame(rows, columns=["symbol", "close", "rsi", "change_5d_pct"]).dropna(subset=["rsi"])
oversold = result[result["rsi"] < BELOW].sort_values("rsi")
print(f"{len(oversold)} of {len(result)} have an RSI({LENGTH}) below {BELOW}.")
if not oversold.empty:
    pt.show(oversold, title=f"RSI({LENGTH}) below {BELOW}")

if panel.errors:
    print(f"\n{len(panel.errors)} symbols could not be fetched:")
    for symbol, error in panel.errors.items():
        print(f"  {symbol}: {error}")
