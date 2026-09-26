"""Turning the API's JSON into pandas objects, and dates into what the API takes."""

from __future__ import annotations

import datetime as _dt

import pandas as pd

# Every broker here serves Indian exchanges. A date typed without a zone means this one.
MARKET_TZ = "Asia/Kolkata"

_EPOCH = pd.Timestamp("1970-01-01", tz="UTC")
_MS = pd.Timedelta(milliseconds=1)
COLUMNS = ("open", "high", "low", "close", "volume")


def to_millis(value, *, end: bool = False) -> int | None:
    """Epoch milliseconds for a date or time the way a person writes it.

    A time without a zone is read in the market's zone (IST). With ``end=True`` a bare
    date (``"2024-03-01"`` or a ``datetime.date``) means the *end* of that day, so an
    ``end="2024-03-01"`` includes March 1st's bars. ``None`` stays ``None``.
    """
    if value is None:
        return None
    if isinstance(value, bool) or isinstance(value, (int, float)):
        raise TypeError(
            "Pass a date or time (a string, datetime or pandas Timestamp), not a number: "
            f"{value!r}. Epoch milliseconds are ambiguous."
        )
    date_only = (isinstance(value, _dt.date) and not isinstance(value, _dt.datetime)) or (
        isinstance(value, str) and len(value.strip()) <= 10 and ":" not in value
    )
    ts = pd.Timestamp(value)
    if ts.tzinfo is None:
        ts = ts.tz_localize(MARKET_TZ)
    ms = int((ts.tz_convert("UTC") - _EPOCH) // _MS)
    if end and date_only:
        ms += 24 * 3600 * 1000 - 1
    return ms


def to_frame(body: dict, tz: str | None = None, naive: bool = False) -> pd.DataFrame:
    """A bars response as a DataFrame: ``open high low close volume`` on a time index.

    The index is in the exchange's zone (or ``tz``). A daily bar is at midnight of its
    date. Volume is NaN where the exchange reported none (an index).
    """
    index = pd.DatetimeIndex(pd.to_datetime(body["t"], unit="ms", utc=True)).tz_convert(
        tz or body.get("timezone") or MARKET_TZ
    )
    frame = pd.DataFrame(
        {"open": body["o"], "high": body["h"], "low": body["l"], "close": body["c"], "volume": body["v"]},
        index=index,
    ).astype("float64")
    frame.index.name = "time"
    if naive:
        frame.index = frame.index.tz_localize(None)
    return frame


def index_millis(index: pd.DatetimeIndex) -> list[int]:
    """Epoch milliseconds for each time of an index; times without a zone are read in IST."""
    if index.tz is None:
        index = index.tz_localize(MARKET_TZ)
    return [int(v) for v in ((index.tz_convert("UTC") - _EPOCH) // _MS)]


def from_millis(ms: int | None, tz: str = MARKET_TZ):
    """A Timestamp for epoch milliseconds, or ``None``."""
    if ms is None:
        return None
    return pd.Timestamp(ms, unit="ms", tz="UTC").tz_convert(tz)


_AGG = {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}


def resample(frame: pd.DataFrame, rule: str, session_open: str = "09:15") -> pd.DataFrame:
    """Coarser bars from finer ones.

    Intraday rules (``"15min"``, ``"60min"``, ``"4h"``) start a new bucket at each day's
    session open, as the app's charts do, so a 4-hour chart of an Indian stock is
    09:15-13:15 then 13:15-close, never a fixed clock split. Any other rule (``"W-FRI"``,
    ``"MS"``) goes to pandas' own ``resample``.
    """
    columns = {c: a for c, a in _AGG.items() if c in frame.columns}
    try:
        step = pd.Timedelta(rule)
    except (ValueError, TypeError):
        step = None
    if step is None or step >= pd.Timedelta(days=1):
        return frame.resample(rule).agg(columns).dropna(subset=["open"])
    if step <= pd.Timedelta(0):
        raise ValueError(f"resample rule must be a positive length, not {rule!r}")

    hours, minutes = (int(part) for part in session_open.split(":"))
    opened = pd.Timedelta(hours=hours, minutes=minutes)
    index = frame.index
    day = index.normalize()
    bucket = ((index - day - opened) // step).to_numpy()
    # Whole microseconds, so no numpy-times-Timedelta arithmetic is involved.
    step_us = int(step // pd.Timedelta(microseconds=1))
    starts = day + opened + pd.to_timedelta(bucket * step_us, unit="us")
    out = frame.groupby(starts).agg(columns)
    out.index.name = frame.index.name
    return out.dropna(subset=["open"])
