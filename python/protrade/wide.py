"""Features for many symbols at once: one pass over a table with a column per symbol, instead of a
pandas computation per symbol (most of a whole-market screen's time, before this).

The rows are *bar positions*, not dates. Each symbol's bars fill the bottom of its own column, so
row -1 is every symbol's latest bar, row -2 its previous one, and a column's rows above its first
bar are NaN. That is what keeps the numbers identical to :class:`protrade.features.Features`: a
rolling window, an ``ewm`` or a ``shift`` then counts that symbol's own bars, never a date another
symbol traded and it didn't. ``python/tests/test_wide.py`` checks every feature family against
``Features`` — keep that test when either side changes.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import features as feat
from .frames import COLUMNS


def _ns(index) -> np.ndarray:
    return pd.DatetimeIndex(index).as_unit("ns").asi8


class WideFeatures(feat.Features):
    """The features of many symbols' bars, each a DataFrame with a column per symbol.

    ``frames`` maps a symbol to its bars (``open high low close volume`` on a time index, as
    :func:`protrade.bars` returns them). ``benchmark`` is an index's close on its own dates, aligned
    to each symbol's dates as ``Features`` aligns it.
    """

    def __init__(self, frames: dict[str, pd.DataFrame], benchmark: pd.Series | None = None):
        self.symbols = list(frames)
        lengths = np.array([len(frames[s]) for s in self.symbols], dtype=np.int64)
        rows = int(lengths.max()) if len(lengths) else 0
        self._rows = rows
        self.lengths = pd.Series(lengths, index=self.symbols)

        columns = {name: np.full((rows, len(self.symbols)), np.nan) for name in COLUMNS}
        dates = np.full((rows, len(self.symbols)), np.iinfo(np.int64).min, dtype=np.int64)
        for j, symbol in enumerate(self.symbols):
            n = lengths[j]
            if n == 0:
                continue
            frame = frames[symbol]
            for name in COLUMNS:
                columns[name][rows - n :, j] = frame[name].to_numpy(dtype="float64")
            dates[rows - n :, j] = _ns(frame.index)
        self.bars = {name: pd.DataFrame(columns[name], columns=self.symbols) for name in COLUMNS}
        self._dates = dates
        self._present = dates != np.iinfo(np.int64).min

        self._frames = frames
        self._raw_benchmark = benchmark
        self._timelines: dict[str, tuple] = {}
        self.benchmark = None
        if benchmark is not None and len(benchmark):
            times, values = _ns(benchmark.index), benchmark.to_numpy(dtype="float64")
            pos = np.searchsorted(times, dates, side="right") - 1
            aligned = np.where((pos >= 0) & self._present, values[np.clip(pos, 0, None)], np.nan)
            self.benchmark = pd.DataFrame(aligned, columns=self.symbols)
        self._cache: dict[str, pd.DataFrame] = {}

    def __len__(self) -> int:
        return self._rows

    @property
    def index(self) -> pd.RangeIndex:
        return pd.RangeIndex(self._rows)

    def latest_dates(self) -> pd.Series:
        """Each symbol's latest bar's date (NaT for a symbol with none)."""
        if self._rows == 0:
            return pd.Series(pd.NaT, index=self.symbols, dtype="datetime64[ns]")
        last = np.where(self._present[-1], self._dates[-1], np.iinfo(np.int64).min)
        return pd.Series(pd.to_datetime(last.astype("datetime64[ns]")), index=self.symbols)

    # -- weekly and monthly bars, per symbol, bottom-aligned like the daily ones

    def _timeline(self, tf: str) -> tuple:
        if tf not in self._timelines:
            periods, bounds = {}, {}
            for symbol in self.symbols:
                frame = self._frames[symbol]
                codes, last = feat.period_bounds(frame.index, tf)
                columns = feat.period_bars({c: frame[c].to_numpy(dtype="float64") for c in COLUMNS}, codes, last)
                periods[symbol] = pd.DataFrame(columns, index=frame.index[last])
                bounds[symbol] = (codes, last)
            sub = WideFeatures(periods, self._raw_benchmark)
            rows, sub_rows = self._rows, len(sub)
            to_period = np.full((rows, len(self.symbols)), -1, dtype=np.int64)
            last_day = np.full((sub_rows, len(self.symbols)), -1, dtype=np.int64)
            for j, symbol in enumerate(self.symbols):
                codes, last = bounds[symbol]
                n, m = len(codes), len(last)
                if n:
                    to_period[rows - n :, j] = sub_rows - m + codes
                    last_day[sub_rows - m :, j] = rows - n + last
            self._timelines[tf] = (sub, to_period, last_day)
        return self._timelines[tf]

    def _gather(self, values: pd.DataFrame, rows: np.ndarray) -> pd.DataFrame:
        """``values``' row ``rows[r, j]`` of column j at each ``[r, j]``; blank where it is -1."""
        source = values.to_numpy()
        boolean = source.dtype == bool
        out = np.zeros(rows.shape, dtype=bool) if boolean else np.full(rows.shape, np.nan)
        valid = rows >= 0
        cols = np.broadcast_to(np.arange(rows.shape[1]), rows.shape)
        out[valid] = source[rows[valid], cols[valid]]
        return pd.DataFrame(out, columns=self.symbols)

    def to_daily(self, values, to_period):
        return self._gather(values, to_period)

    def on(self, tf: str, name: str):
        daily = self.get(name)
        if tf == "D":
            return daily
        _, _, last_day = self._timeline(tf)
        return self._gather(daily, last_day)

    def release(self) -> None:
        self._cache.clear()
        self._timelines.clear()

    def frame(self, names) -> pd.DataFrame:  # pragma: no cover - a per-symbol view; use get()
        raise NotImplementedError("WideFeatures holds one DataFrame per feature: use get(name).")
