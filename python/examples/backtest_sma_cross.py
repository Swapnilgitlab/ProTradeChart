"""Backtests a moving-average crossover on one stock, and shows the result in the Results tab.

Buy when the fast average crosses above the slow one; sell when it crosses back. Long only, all
the money in, and every trade at that day's closing price. This is plain pandas, so it is a
sketch of a method, not a broker: no slippage, no partial fills. (Pine strategies in the Strategy
Tester follow TradingView's rules instead, so their numbers differ.)

It works with no setup: SYMBOL is the first symbol of your watchlist, or of ten large NSE stocks.
"""

import pandas as pd

import protrade as pt

SYMBOL = None  # like "india:NSE:RELIANCE"; None uses the first stock pt.universe() gives
START = "2018-01-01"
FAST, SLOW = 20, 50  # days in the two averages
CAPITAL = 1_000_000
COMMISSION_PCT = 0.05  # each way, as a percent of what is traded


def backtest(bars: pd.DataFrame):
    """The trades and the account's value at each close."""
    close = bars["close"]
    fee = COMMISSION_PCT / 100
    on = close.rolling(FAST).mean() > close.rolling(SLOW).mean()  # the signal at each close
    held = on.shift(1, fill_value=False)  # in the trade for the move into this close
    entered = on & ~held  # the close a trade begins on
    exited = held & ~on  # the close it ends on

    day = close.pct_change().fillna(0.0).where(held, 0.0)
    cost = (entered | exited) * fee
    equity = CAPITAL * ((1 + day) * (1 - cost)).cumprod()

    entries = list(close.index[entered])
    exits = list(close.index[exited])
    if len(exits) < len(entries):
        exits.append(close.index[-1])  # still open at the end: valued at the last close
    before = equity.shift(1)
    rows = [
        {
            "entry": entry,
            "exit": leave,
            "entry_price": close[entry],
            "exit_price": close[leave],
            "return_pct": (close[leave] / close[entry] - 1) * 100,
            "pnl": equity[leave] - before[entry],
        }
        for entry, leave in zip(entries, exits)
    ]
    return pd.DataFrame(rows, columns=["entry", "exit", "entry_price", "exit_price", "return_pct", "pnl"]), equity


symbol = SYMBOL or pt.universe()[0]
bars = pt.bars(symbol, "D", start=START)
print(f"{symbol}: {len(bars)} daily bars from {bars.index[0]:%Y-%m-%d}" if len(bars) else f"{symbol}: no bars")

if len(bars) < SLOW + 10:
    print(f"Not enough history for a {FAST}/{SLOW} crossover.")
else:
    trades, equity = backtest(bars)
    buy_and_hold = CAPITAL * bars["close"] / bars["close"].iloc[0]
    print(f"{len(trades)} trades. Ended at {equity.iloc[-1]:,.0f}; buying and holding ended at {buy_and_hold.iloc[-1]:,.0f}.")
    pt.report(
        trades=trades,
        equity=equity,
        benchmark=buy_and_hold,
        initial_capital=CAPITAL,
        title=f"{FAST}/{SLOW} moving-average crossover on {symbol}",
    )
