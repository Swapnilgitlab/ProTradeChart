"""The functions a script calls. ``import protrade as pt`` re-exports them."""

from __future__ import annotations

import sys
import time
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed

import pandas as pd

from . import client, frames


class DataLimitWarning(UserWarning):
    """The broker would not serve as far back as the request asked."""


def status() -> dict:
    """The app's version and API level. A quick way to check the connection."""
    return client.get("/v1/ping")


def providers() -> pd.DataFrame:
    """The data sources a script can read, and whether each is set up (``usable``)."""
    return pd.DataFrame(client.get("/v1/providers"), columns=["id", "label", "usable"])


def instruments(provider: str, exchange: str | None = None, kind: str | None = None,
                q: str | None = None, limit: int | None = None) -> pd.DataFrame:
    """A broker's instrument list, to build a universe from.

    ``provider`` is ``"zerodha"`` or ``"dhan"``. ``exchange`` is ``"NSE"``, ``"BSE"``,
    ``"NFO"``, ``"MCX"``...; ``kind`` is ``"EQUITY"``, ``"INDEX"`` or ``"FUT"``; ``q`` matches
    the symbol or name. The ``symbol`` column can be passed straight to :func:`bars`.
    """
    rows = client.get("/v1/instruments", provider=provider, exchange=exchange, kind=kind, q=q, limit=limit)
    return pd.DataFrame(rows, columns=["symbol", "name", "exchange", "kind", "expiry"])


def watchlists() -> pd.DataFrame:
    """The watchlists made in the app: ``id``, ``name`` and ``count``."""
    return pd.DataFrame(client.get("/v1/watchlists"), columns=["id", "name", "count"])


def watchlist(which: str | int, providers: tuple[str, ...] | list[str] | None = None) -> list[str]:
    """The symbols on one of the app's watchlists, by name or id.

    Symbols from sources a script can't read (the crypto exchanges) are easy to have on a
    list; pass ``providers=("zerodha", "dhan")`` to keep only the ones that can be.
    """
    key = "id" if isinstance(which, int) and not isinstance(which, bool) else "name"
    symbols = [row["symbol"] for row in client.get("/v1/watchlist", **{key: which})["symbols"]]
    if providers is not None:
        wanted = {p.lower() for p in providers}
        symbols = [s for s in symbols if s.split(":", 1)[0].lower() in wanted]
    return symbols


# Ten large NSE stocks: something to work on the first time, before any watchlist exists.
SAMPLE_TICKERS = ("RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", "HINDUNILVR", "ITC", "SBIN", "BHARTIARTL", "LT")


class Universe(list):
    """A list of symbols that remembers where it came from, as ``.source``."""

    def __init__(self, symbols, source: str):
        super().__init__(symbols)
        self.source = source


def universe(name: str | None = None, providers: tuple[str, ...] | list[str] = ("zerodha", "dhan")) -> Universe:
    """The symbols to work on, so a script runs the first time with nothing set up.

    With a ``name``, that watchlist (`NotFoundError` if there is none, or nothing on it comes from
    ``providers``). Without one: your first watchlist that has symbols from ``providers``; failing
    that, ten large NSE stocks through the first of ``providers`` that is set up. ``.source`` says which.
    """
    wanted = tuple(p.lower() for p in providers)
    if name is not None:
        symbols = watchlist(name, providers=wanted)
        if not symbols:
            raise client.NotFoundError(f"The watchlist {name!r} has no {' or '.join(wanted)} symbols on it.")
        return Universe(symbols, f"the watchlist {name!r}")
    for listed in watchlists()["name"]:
        symbols = watchlist(listed, providers=wanted)
        if symbols:
            return Universe(symbols, f"the watchlist {listed!r}")
    usable = {p["id"] for p in client.get("/v1/providers") if p["usable"]}
    broker = next((p for p in wanted if p in usable), None)
    if broker is None:
        raise client.NotConfiguredError(
            "No broker is set up yet. Open Data providers, add Zerodha or Dhan, log in, and switch it on."
        )
    return Universe([f"{broker}:NSE:{ticker}" for ticker in SAMPLE_TICKERS], "a sample of large NSE stocks")


def bars(symbol: str, interval: str = "D", start=None, end=None, limit: int | None = None,
         tz: str | None = None, naive: bool = False) -> pd.DataFrame:
    """OHLCV bars for one symbol, as a DataFrame.

    ``symbol`` is ``provider:EXCHANGE:TICKER``, like ``"zerodha:NSE:RELIANCE"``, or
    ``"csv:NAME"`` for a file imported in the app. ``interval`` is ``"D"`` or minutes
    (``"1"``, ``"5"``, ``"15"``, ``"60"``); Zerodha serves 1, 3, 5, 10, 15, 30, 60 and D,
    Dhan 1, 5, 15, 25, 60 and D. For anything else fetch a finer interval and use
    :func:`resample`.

    ``start`` and ``end`` are dates or times (``"2020-01-01"``, a ``datetime``, a pandas
    Timestamp), read in IST when they carry no zone; a bare ``end`` date includes that day.
    Without ``start`` you get the newest ``limit`` bars (500 by default).

    The index is timezone-aware, in the exchange's zone (or ``tz``); a daily bar is at
    midnight of its date. ``naive=True`` drops the zone, which is convenient for daily data.
    Volume is NaN for an index. The first request for a symbol is fetched from the broker
    and kept by the app; later ones only fetch what is new.
    """
    body = client.get(
        "/v1/bars",
        symbol=symbol,
        interval=str(interval),
        **{"from": frames.to_millis(start), "to": frames.to_millis(end, end=True), "limit": limit},
    )
    frame = frames.to_frame(body, tz=tz, naive=naive)
    limited = body.get("limitedFrom")
    frame.attrs.update(
        symbol=symbol,
        interval=body["interval"],
        covered_from=frames.from_millis(body.get("coveredFrom")),
        covered_to=frames.from_millis(body.get("coveredTo")),
        limited_from=frames.from_millis(limited),
    )
    if limited is not None and start is not None:
        warnings.warn(
            f"{symbol}: the broker only serves {body['interval']} bars from "
            f"{frames.from_millis(limited):%Y-%m-%d}, later than the start you asked for ({start}).",
            DataLimitWarning,
            stacklevel=2,
        )
    return frame


class BarsMap(dict):
    """The result of :func:`bars_many`: ``{symbol: DataFrame}``, plus ``.errors`` for the
    symbols that failed when ``errors="skip"``."""

    errors: dict

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.errors = {}


def _duration(seconds: float) -> str:
    minutes, seconds = divmod(max(0, round(seconds)), 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h {minutes:02d}m"
    return f"{minutes}m {seconds:02d}s" if minutes else f"{seconds}s"


def _pace(done: int, total: int, elapsed: float) -> tuple[float, float] | None:
    """Symbols a second and seconds left, once there is enough history for either to mean
    something: symbols the app already holds arrive in milliseconds, and would otherwise
    promise an instant finish."""
    if done < 5 or elapsed < 3 or done >= total:
        return None
    rate = done / elapsed
    return rate, (total - done) / rate


def bars_many(symbols, interval: str = "D", start=None, end=None, limit: int | None = None,
              workers: int = 4, errors: str = "raise", progress: bool = True,
              tz: str | None = None, naive: bool = False) -> BarsMap:
    """:func:`bars` for many symbols, in parallel, in the order given.

    The app paces the broker itself, so extra ``workers`` only overlap waiting; the first
    run over a few hundred symbols takes minutes at the brokers' rate limits, later runs
    fetch only what is new. ``errors="raise"`` stops at the first failure; ``"skip"`` leaves
    a failed symbol out of the result and records it in ``result.errors`` (a problem that
    would hit every symbol, like an expired token, still stops the run). The progress line
    shows the rate and the time left, and says so once when the run will take minutes.
    """
    if errors not in ("raise", "skip"):
        raise ValueError('errors must be "raise" or "skip"')
    symbols = list(dict.fromkeys(symbols))  # no repeats, order kept
    result = BarsMap()
    total, done = len(symbols), 0
    fetched: dict[str, pd.DataFrame] = {}
    started, warned, shown = time.monotonic(), False, 0

    def one(symbol: str) -> pd.DataFrame:
        return bars(symbol, interval, start, end, limit, tz, naive)

    pool = ThreadPoolExecutor(max_workers=max(1, workers))
    try:
        futures = {pool.submit(one, s): s for s in symbols}
        for future in as_completed(futures):
            symbol = futures[future]
            try:
                fetched[symbol] = future.result()
            except client.FATAL:
                raise
            except client.ProTradeError as e:
                if errors == "raise":
                    raise
                result.errors[symbol] = e
            done += 1
            if progress and total > 1:
                line = f"\rfetched {done}/{total} ({symbol})"
                pace = _pace(done, total, time.monotonic() - started)
                if pace:
                    rate, left = pace
                    line += f"  {rate:.1f}/s, about {_duration(left)} left"
                    if left > 60 and not warned:
                        warned = True
                        print("\nThis will take a few minutes: the app fetches at the broker's rate limit. "
                              "What it fetches is kept, so later runs are quick.")
                # Padded so a shorter line (the time left shrinks) doesn't leave the old tail
                # showing in a terminal.
                shown = max(shown, len(line))
                print(line.ljust(shown), end="", flush=True)
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
        if progress and total > 1:
            print(file=sys.stdout, flush=True)

    for symbol in symbols:
        if symbol in fetched:
            result[symbol] = fetched[symbol]
    if result.errors:
        warnings.warn(
            f"{len(result.errors)} of {total} symbols could not be fetched; see result.errors.",
            stacklevel=2,
        )
    return result


resample = frames.resample
