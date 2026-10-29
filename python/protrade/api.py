"""The functions a script calls. ``import protrade as pt`` re-exports them."""

from __future__ import annotations

import os
import sys
import time
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed

import pandas as pd

from . import client, frames
from . import panels as _panel
from .client import INDIA, canonical_provider, canonical_symbol_prefix


class DataLimitWarning(UserWarning):
    """The broker would not serve as far back as the request asked."""


def status() -> dict:
    """The app's version and API level. A quick way to check the connection."""
    return client.get("/v1/ping")


def providers() -> pd.DataFrame:
    """The data sources a script can read, and whether each is set up (``usable``): ``india`` (Indian
    markets, through the broker the app uses, named in ``broker``) and ``csv`` (imported files)."""
    return pd.DataFrame(client.get("/v1/providers"), columns=["id", "label", "usable", "broker"])


def instruments(provider: str, exchange: str | None = None, kind: str | None = None,
                q: str | None = None, limit: int | None = None) -> pd.DataFrame:
    """The broker's instrument list, to build a universe from.

    ``provider`` is ``"india"``. ``exchange`` is ``"NSE"``, ``"BSE"``,
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
    list; pass ``providers=("india",)`` to keep only the ones that can be.
    """
    key = "id" if isinstance(which, int) and not isinstance(which, bool) else "name"
    symbols = [row["symbol"] for row in client.get("/v1/watchlist", **{key: which})["symbols"]]
    if providers is not None:
        wanted = {canonical_provider(p) for p in providers}
        symbols = [s for s in symbols if canonical_provider(s.split(":", 1)[0]) in wanted]
    return symbols


# Ten large NSE stocks: something to work on the first time, before any watchlist exists.
SAMPLE_TICKERS = ("RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", "HINDUNILVR", "ITC", "SBIN", "BHARTIARTL", "LT")


class Universe(list):
    """A list of symbols that remembers where it came from, as ``.source``."""

    def __init__(self, symbols, source: str):
        super().__init__(symbols)
        self.source = source


def universe(name: str | None = None, providers: tuple[str, ...] | list[str] = (INDIA,)) -> Universe:
    """The symbols to work on, so a script runs the first time with nothing set up.

    With a ``name``, that watchlist (`NotFoundError` if there is none, or nothing on it comes from
    ``providers``). Without one: your first watchlist that has symbols from ``providers``; failing
    that, ten large NSE stocks through the first of ``providers`` that is set up. ``.source`` says which.
    """
    wanted = tuple(dict.fromkeys(canonical_provider(p) for p in providers))
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
            "No broker is set up yet. Open Data providers, connect Zerodha or FYERS, log in, and switch it on."
        )
    return Universe([f"{broker}:NSE:{ticker}" for ticker in SAMPLE_TICKERS], "a sample of large NSE stocks")


def bars(symbol: str, interval: str = "D", start=None, end=None, limit: int | None = None,
         tz: str | None = None, naive: bool = False) -> pd.DataFrame:
    """OHLCV bars for one symbol, as a DataFrame.

    ``symbol`` is ``provider:EXCHANGE:TICKER``, like ``"india:NSE:RELIANCE"``, or
    ``"csv:NAME"`` for a file imported in the app. ``interval`` is ``"D"`` or minutes
    (``"1"``, ``"5"``, ``"15"``, ``"60"``): what your broker serves natively (Zerodha: 1, 3, 5, 10,
    15, 30, 60 and D; FYERS also 2, 20, 120 and 240).
    For anything else fetch a finer interval and use
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


def panel(symbols, start=None, end=None, bars: int | None = None) -> _panel.Panel:
    """Daily bars for many symbols at once, from what the app holds in memory.

    With "Keep the market loaded" on (Data providers → Market data), the app holds five years of
    every NSE stock and index while it is open, so this answers a whole market in about a second
    and never waits on the broker. Nothing is kept on disk: after the app restarts, the market is
    read again. ``start``/``end`` limit the dates; ``bars`` keeps the newest that many per symbol.
    A symbol the app doesn't hold up to the latest session is listed in ``result.missing`` (read
    those with :func:`bars`); :func:`bars_many` does that for you.

    ``result.frame(symbol)`` is one symbol's DataFrame, as :func:`bars` gives it;
    ``result.wide("close")`` is a dates × symbols table.
    """
    symbols = list(dict.fromkeys(canonical_symbol_prefix(s) for s in symbols))
    if bars is not None and (isinstance(bars, bool) or not isinstance(bars, int) or bars < 1):
        raise ValueError("bars must be a whole number of bars, at least 1")
    start_ms, end_ms = frames.to_millis(start), frames.to_millis(end, end=True)
    return _panel.combine(
        [
            _panel.fetch(symbols[i : i + _PANEL_BATCH], start_ms, end_ms, bars)
            for i in range(0, max(len(symbols), 1), _PANEL_BATCH)
        ]
    )


# Keep at or below the app's own cap (`MAX_PANEL_SYMBOLS`, src-tauri/src/pyapi/routes.rs).
_PANEL_BATCH = 5_000


def _from_panel(symbols, start, end, limit, tz=None, naive=False) -> tuple[dict, list]:
    """The daily frames the app already holds, and the symbols it doesn't. An app that can't answer
    a panel answers nothing, and every symbol is fetched as before."""
    if not symbols:
        return {}, []
    try:
        stored = panel(symbols, start=start, end=end, bars=limit)
    except client.FATAL:
        raise
    except client.ProTradeError:
        return {}, list(symbols)
    held = set(stored.held)
    # Keyed and listed as the caller spelled them (a script may still write `zerodha:`).
    frames_ = {s: stored.frame(s, tz=tz, naive=naive) for s in symbols if canonical_symbol_prefix(s) in held}
    return frames_, [s for s in symbols if canonical_symbol_prefix(s) not in held]


def snapshot(symbols) -> pd.DataFrame:
    """Today's quote for many symbols at once: one row per symbol (indexed by symbol, in the order
    given) with ``open high low close previous_close volume`` and when it last ``traded``.

    It comes from the broker's batched quote, all of NSE in a few seconds where history costs a
    request per symbol, so it is the quick way to find the stocks worth reading :func:`bars` for.
    ``close`` is the last traded price (the day's close once the session has settled). A symbol
    the broker had no quote for has NaN prices.

    ``result.attrs["session"]`` is the trading day the quotes speak for (a Timestamp at IST
    midnight), or ``None`` in the pre-open window (09:00 to 09:15 IST), when a quote is an
    indicative price rather than the day's bar. A row whose ``traded`` falls on another day is an
    earlier session's quote (a suspended stock), not today's.
    """
    symbols = list(dict.fromkeys(symbols))
    rows, session = [], None
    for i in range(0, len(symbols), _SNAPSHOT_BATCH):
        batch = [canonical_symbol_prefix(s) for s in symbols[i : i + _SNAPSHOT_BATCH]]
        answer = client.post("/v1/snapshot", {"symbols": batch})
        session = answer.get("sessionDay")
        rows.extend(answer.get("snapshots", []))
    nan = float("nan")
    frame = pd.DataFrame(
        {
            "open": [nan if r.get("open") is None else r["open"] for r in rows],
            "high": [nan if r.get("high") is None else r["high"] for r in rows],
            "low": [nan if r.get("low") is None else r["low"] for r in rows],
            "close": [nan if r.get("last") is None else r["last"] for r in rows],
            "previous_close": [nan if r.get("previousClose") is None else r["previousClose"] for r in rows],
            "volume": [nan if r.get("volume") is None else r["volume"] for r in rows],
        },
        # The app answers in the order asked; the index keeps the caller's own spelling.
        index=pd.Index(symbols[: len(rows)], name="symbol"),
    )
    traded = pd.to_datetime(pd.Series([r.get("tradedAt") for r in rows], dtype="float64"), unit="ms", utc=True)
    frame["traded"] = traded.dt.tz_convert(frames.MARKET_TZ).array
    frame.attrs["session"] = frames.from_millis(session) if session is not None else None
    return frame


# Keep at or below the app's own cap (`MAX_SNAPSHOT_SYMBOLS`, src-tauri/src/pyapi/routes.rs).
_SNAPSHOT_BATCH = 5_000


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

    Daily bars come from the app's memory in one read (see :func:`panel`) for every symbol it
    holds; only the rest are fetched one by one. The app paces the broker itself, so extra
    ``workers`` only overlap waiting; a first run over a few hundred symbols the app doesn't hold
    takes minutes at the brokers' rate limits, later runs (while it stays open) fetch only what is new.
    ``errors="raise"`` stops at the first failure; ``"skip"`` leaves a failed symbol out of the
    result and records it in ``result.errors`` (a problem that would hit every symbol, like an
    expired token, still stops the run). The progress line shows the rate and the time left,
    and says so once when the run will take minutes.
    """
    if errors not in ("raise", "skip"):
        raise ValueError('errors must be "raise" or "skip"')
    symbols = list(dict.fromkeys(symbols))  # no repeats, order kept
    result = BarsMap()
    fetched: dict[str, pd.DataFrame] = {}
    remaining = symbols
    if str(interval) == "D":
        fetched, remaining = _from_panel(symbols, start, end, limit, tz, naive)
    total, done = len(remaining), 0
    started, warned, shown = time.monotonic(), False, 0

    def one(symbol: str) -> pd.DataFrame:
        return bars(symbol, interval, start, end, limit, tz, naive)

    pool = ThreadPoolExecutor(max_workers=max(1, workers))
    try:
        futures = {pool.submit(one, s): s for s in remaining}
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
            f"{len(result.errors)} of {len(symbols)} symbols could not be fetched; see result.errors.",
            stacklevel=2,
        )
    return result


# Keep at or below the app's own cap (`MAX_SYNC_SYMBOLS`, src-tauri/src/pyapi/routes.rs).
_SYNC_BATCH = 5_000


def _top_up(symbols, interval: str = "D", start=None, end=None, limit: int | None = None) -> dict | None:
    """Best-effort: brings many symbols' daily coverage up to date from a batched broker quote
    (``POST /v1/bars/sync``), ahead of the per-symbol :func:`bars` calls that follow it (as
    :func:`protrade.screen.Screen.run` does). A symbol this helps needs no broker call at all
    when :func:`bars` reaches it next; everything else is untouched and falls through to the
    ordinary fetch, exactly as before this existed.

    Never raises: an older app build with no such route, a broker outage, or any other
    `ProTradeError` just means the fast lane is skipped for (the rest of) this call — never that
    the run fails. Returns counts by status (``current``, ``updated``, ``fetch``, ``skipped``),
    or ``None`` when it didn't run at all (too few symbols, a non-daily interval, or
    ``PROTRADE_NO_TOPUP`` set) or didn't finish. Partial progress before a failure is still
    saved in the app; only the count this call returns is lost.
    """
    symbols = list(dict.fromkeys(symbols))
    if str(interval) != "D" or len(symbols) < 2 or os.environ.get(client.NO_TOPUP_ENV):
        return None
    body_from, body_to = frames.to_millis(start), frames.to_millis(end, end=True)
    counts = {"current": 0, "updated": 0, "fetch": 0, "skipped": 0}
    try:
        for i in range(0, len(symbols), _SYNC_BATCH):
            batch = [canonical_symbol_prefix(s) for s in symbols[i : i + _SYNC_BATCH]]
            answer = client.post(
                "/v1/bars/sync",
                {"symbols": batch, "interval": "D", "from": body_from, "to": body_to, "limit": limit},
            )
            for row in answer.get("results", []):
                counts[row["status"]] = counts.get(row["status"], 0) + 1
    except client.ProTradeError:
        return None
    return counts


resample = frames.resample
