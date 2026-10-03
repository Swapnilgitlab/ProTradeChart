"""Many symbols' daily bars in one read from the app's market-data store (``POST /v1/panel``).

The app keeps five years of daily bars for every NSE stock and index once its market data has
been downloaded (Data providers → Market data). A panel reads them straight from that store,
without asking the broker, so a whole market arrives in about a second instead of one request
per symbol. A symbol the store doesn't hold up to the latest session is listed in
:attr:`Panel.missing`; read those with :func:`protrade.bars`, which fetches what is new.

The answer is binary columns (see ``panel_body`` in ``src-tauri/src/pyapi/wire.rs``): each array
is taken as it arrived, without copying, and every symbol's bars sit back to back in it.
"""

from __future__ import annotations

import json
import struct

import numpy as np
import pandas as pd

from . import client
from .frames import COLUMNS, MARKET_TZ, from_millis

FORMAT = 1


class Panel:
    """Stored daily bars for many symbols.

    ``symbols`` keeps the order asked for. ``frame(symbol)`` is one symbol's bars as a DataFrame,
    exactly as :func:`protrade.bars` returns them; ``wide("close")`` lines every symbol up by date.
    """

    def __init__(self, head: dict, columns: dict[str, np.ndarray]):
        self.interval: str = head["interval"]
        self.timezone: str = head.get("timezone") or MARKET_TZ
        series = head["series"]
        self.symbols: list[str] = [s["symbol"] for s in series]
        counts = np.array([s["count"] for s in series], dtype=np.int64)
        self.offsets = np.concatenate([[0], np.cumsum(counts)]).astype(np.int64)
        self._position = {s: i for i, s in enumerate(self.symbols)}
        self._current = {s["symbol"]: bool(s["current"]) for s in series}
        self._covered = {s["symbol"]: (s.get("coveredFrom"), s.get("coveredTo")) for s in series}
        self.time = columns["time"]
        self.open, self.high, self.low = columns["open"], columns["high"], columns["low"]
        self.close, self.volume = columns["close"], columns["volume"]

    def __len__(self) -> int:
        return len(self.symbols)

    def __contains__(self, symbol: str) -> bool:
        return symbol in self._position

    @property
    def held(self) -> list[str]:
        """The symbols the store holds up to the latest session, in order."""
        return [s for s in self.symbols if self._current[s]]

    @property
    def missing(self) -> list[str]:
        """The symbols it doesn't: read these with :func:`protrade.bars`."""
        return [s for s in self.symbols if not self._current[s]]

    def count(self, symbol: str) -> int:
        i = self._position[symbol]
        return int(self.offsets[i + 1] - self.offsets[i])

    def arrays(self, symbol: str) -> dict[str, np.ndarray]:
        """One symbol's ``time`` (epoch ms) and price columns, as views into the panel."""
        i = self._position[symbol]
        part = slice(int(self.offsets[i]), int(self.offsets[i + 1]))
        return {
            "time": self.time[part],
            "open": self.open[part],
            "high": self.high[part],
            "low": self.low[part],
            "close": self.close[part],
            "volume": self.volume[part],
        }

    def frame(self, symbol: str, tz: str | None = None, naive: bool = False) -> pd.DataFrame:
        """One symbol's bars, shaped as :func:`protrade.bars` shapes them."""
        a = self.arrays(symbol)
        index = pd.DatetimeIndex(pd.to_datetime(a["time"], unit="ms", utc=True)).tz_convert(tz or self.timezone)
        frame = pd.DataFrame({c: a[c] for c in COLUMNS}, index=index).astype("float64")
        frame.index.name = "time"
        if naive:
            frame.index = frame.index.tz_localize(None)
        covered_from, covered_to = self._covered[symbol]
        frame.attrs.update(
            symbol=symbol,
            interval=self.interval,
            covered_from=from_millis(covered_from),
            covered_to=from_millis(covered_to),
            limited_from=None,
        )
        return frame

    def wide(self, field: str = "close", naive: bool = True) -> pd.DataFrame:
        """One column per symbol, one row per date any of them traded (NaN where one didn't)."""
        if field not in COLUMNS:
            raise ValueError(f"field must be one of {', '.join(COLUMNS)}, not {field!r}")
        columns = {}
        for s in self.symbols:
            a = self.arrays(s)
            if len(a["time"]):
                index = pd.to_datetime(a["time"], unit="ms", utc=True).tz_convert(self.timezone)
                if naive:
                    index = index.tz_localize(None)
                columns[s] = pd.Series(a[field], index=index)
        out = pd.DataFrame(columns).sort_index()
        out.index.name = "time"
        return out


def combine(parts: list[Panel]) -> Panel:
    """Several panels (one per batch of symbols) as one, in order."""
    if len(parts) == 1:
        return parts[0]
    first = parts[0]
    head = {
        "interval": first.interval,
        "timezone": first.timezone,
        "series": [
            {
                "symbol": s,
                "count": p.count(s),
                "current": p._current[s],
                "coveredFrom": p._covered[s][0],
                "coveredTo": p._covered[s][1],
            }
            for p in parts
            for s in p.symbols
        ],
    }
    columns = {name: np.concatenate([getattr(p, name) for p in parts]) for name in ("time", *COLUMNS)}
    return Panel(head, columns)


def decode(raw: bytes) -> Panel:
    """Reads a ``/v1/panel`` answer."""
    if len(raw) < 4:
        raise client.ProTradeError("The app sent an empty panel.")
    (head_len,) = struct.unpack_from("<I", raw, 0)
    head = json.loads(raw[4 : 4 + head_len])
    if head.get("format") != FORMAT:
        raise client.ProTradeError(
            f"The app sent a panel in format {head.get('format')}; this client reads format {FORMAT}. "
            "Restart the app so scripts get the matching client."
        )
    n = int(head["count"])
    base = (4 + head_len + 7) // 8 * 8
    if len(raw) < base + 48 * n:
        raise client.ProTradeError("The app sent a panel shorter than its header says.")
    columns = {"time": np.frombuffer(raw, dtype="<i8", count=n, offset=base)}
    for k, name in enumerate(COLUMNS):
        columns[name] = np.frombuffer(raw, dtype="<f8", count=n, offset=base + 8 * n * (k + 1))
    return Panel(head, columns)


def fetch(symbols, start_ms: int | None = None, end_ms: int | None = None, bars: int | None = None) -> Panel:
    """Asks the app for ``symbols``' stored daily bars."""
    payload = {"symbols": list(symbols), "interval": "D", "from": start_ms, "to": end_ms, "bars": bars}
    return decode(client.post_raw("/v1/panel", payload))
