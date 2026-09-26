"""The numbers a backtest report shows, worked out from an equity curve and a list of trades.

Each is a ``{"label", "value", "format"}`` dict, which is what the app draws. ``format`` says how
to write the value: ``money``, ``percent``, ``ratio``, ``int``, ``number`` or ``text``. A value
that can't be worked out (a profit factor with no losing trade) is ``None``, drawn as a dash.
"""

from __future__ import annotations

import math

import pandas as pd


def number(value):
    """A float, or None for anything that isn't a finite number."""
    if value is None:
        return None
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def metric(label: str, value, fmt: str) -> dict:
    if fmt == "text":
        return {"label": label, "value": None if value is None else str(value), "format": fmt}
    figure = number(value)
    if fmt == "int" and figure is not None:
        figure = int(figure)
    return {"label": label, "value": figure, "format": fmt}


def equity_metrics(equity: pd.Series) -> list[dict]:
    """Return, drawdown and (with dates) annual growth and a Sharpe ratio, from account value over time.

    The Sharpe ratio is the mean over the standard deviation of *daily* returns (the curve's
    last value each day), times the square root of 252, with no risk-free rate.
    """
    equity = pd.to_numeric(equity, errors="coerce").dropna()
    if len(equity) < 2:
        return []
    start, end = float(equity.iloc[0]), float(equity.iloc[-1])
    out = []
    if start > 0:
        out.append(metric("Total return", (end / start - 1) * 100, "percent"))
    peak = equity.cummax()
    drawdown = (equity / peak - 1).where(peak > 0)
    out.append(metric("Max drawdown", drawdown.min() * 100, "percent"))
    if isinstance(equity.index, pd.DatetimeIndex):
        years = (equity.index[-1] - equity.index[0]).total_seconds() / (365.25 * 86400)
        # Growing "per year" over a few days says nothing, so a month is the least it is worked out for.
        if years >= 1 / 12 and start > 0 and end > 0:
            out.append(metric("CAGR", ((end / start) ** (1 / years) - 1) * 100, "percent"))
        daily = equity.resample("D").last().dropna().pct_change().dropna()
        if len(daily) >= 2 and daily.std() > 0:
            out.append(metric("Sharpe", daily.mean() / daily.std() * math.sqrt(252), "ratio"))
    out.append(metric("Start equity", start, "money"))
    out.append(metric("End equity", end, "money"))
    return out


def trade_metrics(trades: pd.DataFrame) -> list[dict]:
    """Win rate, profit factor and the rest, from a ``pnl`` column (each trade's net profit)."""
    if trades is None or "pnl" not in trades.columns:
        return []
    pnl = pd.to_numeric(trades["pnl"], errors="coerce").dropna()
    if pnl.empty:
        return []
    wins, losses = pnl[pnl > 0], pnl[pnl < 0]
    gross_loss = -losses.sum()
    return [
        metric("Trades", len(pnl), "int"),
        metric("Net profit", pnl.sum(), "money"),
        metric("Win rate", len(wins) / len(pnl) * 100, "percent"),
        metric("Profit factor", wins.sum() / gross_loss if gross_loss > 0 else None, "ratio"),
        metric("Average win", wins.mean() if len(wins) else None, "money"),
        metric("Average loss", losses.mean() if len(losses) else None, "money"),
        metric("Largest win", wins.max() if len(wins) else None, "money"),
        metric("Largest loss", losses.min() if len(losses) else None, "money"),
    ]


def custom_metrics(extra: dict) -> list[dict]:
    """Figures the script worked out itself, shown after the built-in ones."""
    out = []
    for label, value in extra.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            out.append(metric(str(label), value, "text"))
        else:
            out.append(metric(str(label), value, "number"))
    return out


def describe(item: dict) -> str:
    """A metric as one line of text, for printing when a script isn't running in the app."""
    value, fmt = item["value"], item["format"]
    if value is None:
        text = "-"
    elif fmt == "money":
        text = f"{value:,.2f}"
    elif fmt == "percent":
        text = f"{value:.2f}%"
    elif fmt == "ratio":
        text = f"{value:.2f}"
    elif fmt == "int":
        text = f"{int(value):,}"
    elif fmt == "number":
        text = f"{value:,.4g}"
    else:
        text = str(value)
    return f"{item['label']}: {text}"
