"""Showing things in the app: a table, a backtest report, a figure.

Run from the app's Python tab, each appears in its Results view. Run anywhere else
(a terminal, a notebook) they print instead, so a script written in the app also runs outside it.
"""

from __future__ import annotations

import base64
import io
import math
import os
import sys

import numpy as np
import pandas as pd

from . import client, frames, stats

# More rows than this only slow the panel down; the table says how many there were.
MAX_ROWS = 2000
MAX_CURVE_POINTS = 5000


def in_app() -> bool:
    """Was this script started from the app's Python tab, which is listening for results?"""
    return all(os.environ.get(key) for key in (client.API_ENV, client.TOKEN_ENV, client.RUN_ENV))


def cell(value):
    """One table cell as something JSON can carry: a number, text, true/false or None."""
    if value is None or value is pd.NaT or value is pd.NA:
        return None
    if isinstance(value, (bool, np.bool_)):
        return bool(value)
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, (float, np.floating)):
        number = float(value)
        return number if math.isfinite(number) else None
    if isinstance(value, pd.Timestamp):
        # A date for a daily bar; date and time for anything intraday.
        return value.strftime("%Y-%m-%d" if value == value.normalize() else "%Y-%m-%d %H:%M")
    return value if isinstance(value, str) else str(value)


def table_data(data, symbol_column: str | None = "symbol", max_rows: int = MAX_ROWS, digits: int = 2) -> dict:
    """A DataFrame (or Series) as the table the app draws."""
    if isinstance(data, pd.Series):
        frame = data.to_frame(name=data.name if data.name is not None else "value")
    elif isinstance(data, pd.DataFrame):
        frame = data
    else:
        raise TypeError(f"Pass a DataFrame or a Series, not {type(data).__name__}.")
    if isinstance(frame.index, pd.DatetimeIndex) and frame.index.name is None:
        frame = frame.rename_axis("time")
    # A named index (a date, a symbol) is data. An unnamed row number is not: a filtered
    # frame keeps its old row numbers, which would only be noise.
    if frame.index.name is not None or isinstance(frame.index, pd.MultiIndex):
        frame = frame.reset_index()
    columns = [" ".join(map(str, c)) if isinstance(c, tuple) else str(c) for c in frame.columns]
    rows = [[cell(v) for v in row] for row in frame.head(max_rows).itertuples(index=False, name=None)]
    symbol_index = None
    if symbol_column:
        symbol_index = next((i for i, c in enumerate(columns) if c.lower() == symbol_column.lower()), None)
    return {
        "columns": columns,
        "rows": rows,
        "totalRows": len(frame),
        "symbolColumn": symbol_index,
        "digits": int(digits),
    }


def _post(kind: str, title: str | None, data: dict) -> None:
    client.post(
        "/v1/results",
        {"runId": os.environ[client.RUN_ENV], "kind": kind, "title": title, "data": data},
    )


def set_watchlist(name: str, symbols, mode: str = "replace") -> dict | None:
    """Creates the app's watchlist called ``name``, or refreshes it, from ``symbols``.

    ``symbols`` is a list of symbols like ``zerodha:NSE:TCS`` (a bare broker ticker such as
    ``zerodha:TCS`` means NSE), a pandas Series or Index of them, or a DataFrame with a ``symbol``
    column (or a symbol index) — a screen's matches, say. With ``mode="replace"`` (the default) the
    list ends up holding exactly these: symbols no longer on it are removed, those it keeps stay
    where they are, and new ones go at the end in this order. ``mode="append"`` only adds. A list
    that doesn't exist yet is made. Returns what was done (``created``, ``added``, ``removed``,
    ``total``) and prints it. Outside the app (a terminal) nothing is written; it says what would be.
    """
    if mode not in ("replace", "append"):
        raise ValueError(f"mode must be 'replace' or 'append', not {mode!r}.")
    if isinstance(symbols, pd.DataFrame):
        if "symbol" in symbols.columns:
            symbols = symbols["symbol"]
        elif symbols.index.name == "symbol":
            symbols = symbols.index
        else:
            raise ValueError("Pass a DataFrame with a 'symbol' column (or index), or a list of symbols.")
    if isinstance(symbols, str):
        raise TypeError("Pass a list of symbols, not one string.")
    listed = [str(s).strip() for s in symbols if s is not None and str(s).strip()]
    if not in_app():
        print(f"(outside the app) would {mode} the watchlist {name!r} with {len(listed)} symbols")
        return None
    answer = client.post(
        "/v1/results",
        {
            "runId": os.environ[client.RUN_ENV],
            "kind": "watchlist",
            "title": str(name)[:200],
            "data": {"name": name, "symbols": listed, "mode": mode},
        },
    )
    done = answer.get("watchlist") or {}
    verb = "made" if done.get("created") else "refreshed" if mode == "replace" else "added to"
    print(
        f"Watchlist {done.get('name', name)!r} {verb}: {done.get('added', 0)} added, "
        f"{done.get('removed', 0)} removed, {done.get('total', 0)} on it."
    )
    return done


def show(data, title: str | None = None, symbol_column: str | None = "symbol",
         max_rows: int = MAX_ROWS, digits: int = 2) -> None:
    """Show a DataFrame as a table in the app's Results tab.

    A column called ``symbol`` (or the one named by ``symbol_column``) holding symbols like
    ``zerodha:NSE:TCS`` becomes clickable, to open that chart, and the whole list can be added to a
    watchlist. Columns can be sorted. At most ``max_rows`` rows are sent; ``digits`` is how many
    decimals numbers are drawn with. Outside the app the table is printed.
    """
    table = table_data(data, symbol_column, max_rows, digits)
    if not in_app():
        print(pd.DataFrame(table["rows"], columns=table["columns"]).to_string(index=False))
        return
    _post("table", title, table)


def plot(figure=None, title: str | None = None, dpi: int = 110) -> None:
    """Show a matplotlib figure (the current one by default) in the app's Results tab.

    Needs matplotlib, which the app doesn't install for you. Outside the app it calls
    ``plt.show()``.
    """
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        raise ImportError(
            "matplotlib isn't installed in this Python. Install it once, from a script:\n"
            f"    import subprocess; subprocess.run([{sys.executable!r}, '-m', 'pip', 'install', 'matplotlib'])"
        ) from None
    fig = getattr(figure, "figure", figure) if figure is not None else plt.gcf()
    if not in_app():
        plt.show()
        return
    buffer = io.BytesIO()
    fig.savefig(buffer, format="png", dpi=dpi, bbox_inches="tight")
    _post("figure", title, {"png": base64.b64encode(buffer.getvalue()).decode("ascii")})


def _curve(series: pd.Series | None) -> dict | None:
    """A series over time as ``{"t": [epoch ms], "v": [values]}``, thinned to a plottable size."""
    if series is None:
        return None
    series = pd.to_numeric(series, errors="coerce").dropna()
    n = len(series)
    if n == 0:
        return None
    step = max(1, math.ceil(n / MAX_CURVE_POINTS))
    keep = list(range(0, n, step))
    if keep[-1] != n - 1:
        keep.append(n - 1)
    thinned = series.iloc[keep]
    return {"t": frames.index_millis(thinned.index), "v": [float(v) for v in thinned.to_numpy()]}


def _as_curve(value, name: str) -> pd.Series:
    if not isinstance(value, pd.Series):
        raise TypeError(f"{name} must be a pandas Series of values indexed by time, not {type(value).__name__}.")
    if not isinstance(value.index, pd.DatetimeIndex):
        raise ValueError(f"{name} needs a datetime index (a value for each time).")
    return value


def report(trades: pd.DataFrame | None = None, equity: pd.Series | None = None,
           benchmark: pd.Series | None = None, metrics: dict | None = None, title: str | None = None,
           initial_capital: float | None = None, max_trades: int = MAX_ROWS) -> None:
    """Show a backtest in the app's Results tab: figures, an equity curve and a list of trades.

    ``equity`` is the account's value over time (a Series with a datetime index). ``trades`` is a
    DataFrame with a ``pnl`` column (each trade's net profit) and, if you like, ``symbol``,
    ``side``, ``entry_time``, ``exit_time``, ``entry_price``, ``exit_price``, ``qty``. ``benchmark``
    is a second curve in the same units (buy and hold, say). ``metrics`` adds figures of your own:
    ``{"Sharpe (mine)": 1.2}``. Give ``equity``, ``trades``, or both. Outside the app it prints.
    """
    if trades is None and equity is None:
        raise ValueError("report() needs trades, equity, or both.")
    if trades is not None and not isinstance(trades, pd.DataFrame):
        raise TypeError(f"trades must be a DataFrame, not {type(trades).__name__}.")
    equity = _as_curve(equity, "equity") if equity is not None else None
    benchmark = _as_curve(benchmark, "benchmark") if benchmark is not None else None

    figures = []
    if equity is not None:
        figures += stats.equity_metrics(equity)
    if trades is not None:
        figures += stats.trade_metrics(trades)
    figures += stats.custom_metrics(metrics or {})

    if initial_capital is None and equity is not None and len(equity):
        initial_capital = float(equity.iloc[0])
    data = {
        "metrics": figures,
        "equity": _curve(equity),
        "benchmark": _curve(benchmark),
        "initialCapital": stats.number(initial_capital),
        "trades": table_data(trades, "symbol", max_trades) if trades is not None else None,
    }
    if not in_app():
        print(title or "Backtest")
        for item in figures:
            print("  " + stats.describe(item))
        if trades is not None and len(trades):
            print(trades.head(max_trades).to_string(index=False))
        return
    _post("report", title, data)
