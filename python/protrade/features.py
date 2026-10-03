"""Reusable market features: the measurements a Study is made of.

Every feature is named by a small grammar — a family and, for most, a window in bars:
``return_252``, ``ema_200``, ``rsi_14``, ``dist_high_252``. The same names are used by the
Study Specification, the app's Study Builder (``src/studies/metrics.ts``, which must accept
exactly the same grammar) and the event conditions (``return_252 crosses_above 1.0``).

Returns, distances, slopes and volatilities are *fractions* (0.25 is +25%). Everything is
computed from the OHLCV series the data source supplied, which is taken as already adjusted
for corporate actions: nothing here adjusts a price. Rolling windows need their full length
before they report a value, so a feature is NaN until there is enough history rather than
quietly computed on less.
"""

from __future__ import annotations

import math
import re

import numpy as np
import pandas as pd

# Plain columns and features that take no window.
PLAIN = ("open", "high", "low", "close", "volume", "macd", "macd_signal", "macd_hist", "gap", "gap_up", "gap_down")

# Families that take a window in bars: ``<family>_<n>``.
FAMILIES = (
    "return",
    "change",
    "gain_from_low",
    "sma",
    "ema",
    "dist_sma",
    "dist_ema",
    "slope_sma",
    "slope_ema",
    "rsi",
    "atr",
    "atr_pct",
    "high",
    "low",
    "prior_high",
    "prior_low",
    "dist_high",
    "dist_low",
    "range",
    "avg_volume",
    "rvol",
    "avg_traded_value",
    "volatility",
    "drawdown",
    "max_drawdown",
    "rs",
    "adx",
    "bb_pctb",
    "bb_width",
    "stoch_k",
    "stoch_d",
)

# Friendlier names people (and the spec in the docs) use. Resolved before anything else.
ALIASES = {
    "return_1d": "return_1",
    "return_5d": "return_5",
    "return_1m": "return_21",
    "return_3m": "return_63",
    "return_6m": "return_126",
    "return_12m": "return_252",
    "high_52w": "high_252",
    "low_52w": "low_252",
    "distance_from_52w_high": "dist_high_252",
    "distance_from_52w_low": "dist_low_252",
    "relative_volume": "rvol_20",
    "relative_volume_20": "rvol_20",
    "relative_volume_50": "rvol_50",
    "drawdown_from_high": "drawdown_252",
    "relative_strength_vs_index": "rs_126",
}

MAX_WINDOW = 1000
# How far a moving average's slope looks back: about a month.
SLOPE_BARS = 21
TRADING_DAYS = 252

_NAME = re.compile(r"^([a-z_]+?)_(\d+)$")

# The bars a feature can be computed on. Weekly and monthly bars are built from the daily ones; a
# week ends on Friday. Only a screen uses them (it judges the latest bar, whose week or month is the
# one still forming); a Study refuses them, since a past day's week includes days after it.
INTERVALS = ("D", "W", "M")
BARS_PER_INTERVAL = {"D": 1, "W": 5, "M": 21}
BAR_COLUMNS = ("open", "high", "low", "close", "volume")
_DAY_NS = 86_400_000_000_000


def period_bounds(index, tf: str) -> tuple[np.ndarray, np.ndarray]:
    """For daily bars on ``index`` (one symbol's, in order): which week (Saturday to Friday) or
    calendar month each falls in, numbered from 0, and the position of each period's last bar."""
    index = pd.DatetimeIndex(index)
    if index.tz is not None:
        index = index.tz_localize(None)
    ns = index.as_unit("ns").asi8
    if tf == "W":
        # Day 0 (1970-01-01) was a Thursday, so a week ending on Friday starts on day 2 mod 7.
        period = (ns // _DAY_NS - 2) // 7
    else:
        period = ns.astype("datetime64[ns]").astype("datetime64[M]").astype(np.int64)
    if len(period) == 0:
        empty = np.array([], dtype=np.int64)
        return empty, empty
    starts = np.r_[True, period[1:] != period[:-1]]
    codes = np.cumsum(starts) - 1
    last = np.r_[np.flatnonzero(starts)[1:] - 1, len(period) - 1]
    return codes, last


def period_bars(columns: dict[str, np.ndarray], codes: np.ndarray, last: np.ndarray) -> dict[str, np.ndarray]:
    """Daily ``open high low close volume`` arrays as one bar per period: the first open, the
    highest high, the lowest low, the last close and the summed volume (NaN when none was reported)."""
    if len(last) == 0:
        return {c: np.array([], dtype="float64") for c in BAR_COLUMNS}
    first = np.r_[0, last[:-1] + 1]
    volume = columns["volume"]
    reported = ~np.isnan(volume)
    total = np.add.reduceat(np.where(reported, volume, 0.0), first)
    return {
        "open": columns["open"][first],
        "high": np.maximum.reduceat(columns["high"], first),
        "low": np.minimum.reduceat(columns["low"], first),
        "close": columns["close"][last],
        "volume": np.where(np.add.reduceat(reported, first) > 0, total, np.nan),
    }


class FeatureError(ValueError):
    """A feature name the grammar doesn't know."""


def _canonical_base(name: str, original: str) -> str:
    key = ALIASES.get(name, name)
    if key in PLAIN:
        return key
    match = _NAME.match(key)
    if match and match.group(1) in FAMILIES:
        n = int(match.group(2))
        if 1 <= n <= MAX_WINDOW:
            return f"{match.group(1)}_{n}"
        raise FeatureError(f"{original}: the window must be between 1 and {MAX_WINDOW} bars.")
    raise FeatureError(f"Unknown feature {original!r}. Examples: return_63, ema_200, rsi_14, dist_high_252, rvol_20.")


def canonical(name: str) -> str:
    """The canonical spelling of a feature name, or :class:`FeatureError`. A feature on weekly or
    monthly bars carries ``@W`` or ``@M`` (``rsi_14@W``); daily is the bare name."""
    if not isinstance(name, str):
        raise FeatureError(f"A feature name must be text, not {name!r}.")
    key, _, tf = name.strip().lower().partition("@")
    base = _canonical_base(key.strip(), name)
    tf = tf.strip().upper() or "D"
    if tf not in INTERVALS:
        raise FeatureError(f"{name}: the interval must be one of {', '.join(INTERVALS)} (daily, weekly, monthly).")
    return base if tf == "D" else f"{base}@{tf}"


def interval(name: str) -> str:
    """``D``, ``W`` or ``M``: the bars a feature is computed on."""
    key = canonical(name)
    return key.partition("@")[2] or "D"


def base(name: str) -> str:
    """The feature without its interval: ``rsi_14`` for ``rsi_14@W``."""
    return canonical(name).partition("@")[0]


def split(name: str) -> tuple[str, int | None]:
    """``("ema", 200)`` for ``ema_200`` (on any interval); ``("close", None)`` for a plain one."""
    key = base(name)
    if key in PLAIN:
        return key, None
    family, n = key.rsplit("_", 1)
    return family, int(n)


def needs_benchmark(name: str) -> bool:
    return split(name)[0] == "rs"


def warmup(name: str) -> int:
    """Daily bars of history a feature needs before it has a value (roughly, for planning a fetch)."""
    return _base_warmup(name) * BARS_PER_INTERVAL[interval(name)]


def _base_warmup(name: str) -> int:
    family, n = split(name)
    if n is None:
        return 35 if family.startswith("macd") else 1
    if family in ("slope_sma", "slope_ema"):
        return n + SLOPE_BARS
    if family in ("rsi", "atr", "atr_pct", "adx"):
        return 3 * n
    if family in ("max_drawdown",):
        return 2 * n
    if family in ("gain_from_low", "rvol", "stoch_d"):
        return n + 3
    return n


# ---- The computations ------------------------------------------------------------------------


def _wilder(series: pd.Series, n: int) -> pd.Series:
    return series.ewm(alpha=1.0 / n, adjust=False, min_periods=n).mean()


# Everything below works on a Series (one symbol, ``Features``) and on a DataFrame with a column per
# symbol (``wide.WideFeatures``) alike, and must give the same numbers: pandas computes rolling
# windows, ``ewm`` and ``shift`` column by column, and a wide frame's rows before a symbol's first
# bar are NaN, which those skip. Anything that would turn such a row into a value (a ``where`` with
# a default, a positional ``iloc``) is written so it doesn't.


def _true_range(bars) -> pd.Series:
    prev = bars["close"].shift(1)
    # Element-wise, NaN wherever any part is (a first bar has no previous close).
    return np.maximum(np.maximum(bars["high"] - bars["low"], (bars["high"] - prev).abs()), (bars["low"] - prev).abs())


def _rolling_max_drawdown(close, n: int):
    """The worst peak-to-trough fall inside each trailing window of ``n`` bars (≤ 0)."""
    if isinstance(close, pd.DataFrame):
        return close.apply(lambda column: _rolling_max_drawdown(column.dropna(), n).reindex(column.index))
    values = close.to_numpy(dtype="float64")
    out = np.full(len(values), np.nan)
    if len(values) >= n:
        windows = np.lib.stride_tricks.sliding_window_view(values, n)
        peaks = np.maximum.accumulate(windows, axis=1)
        with np.errstate(divide="ignore", invalid="ignore"):
            falls = np.nanmin(windows / peaks - 1.0, axis=1)
        out[n - 1:] = falls
    return pd.Series(out, index=close.index)


def _adx(bars, n: int) -> pd.Series:
    up = bars["high"].diff()
    down = -bars["low"].diff()
    exists = bars["high"].notna()
    plus_dm = up.where((up > down) & (up > 0), 0.0).where(exists)
    minus_dm = down.where((down > up) & (down > 0), 0.0).where(exists)
    atr = _wilder(_true_range(bars), n)
    plus_di = 100 * _wilder(plus_dm, n) / atr
    minus_di = 100 * _wilder(minus_dm, n) / atr
    total = (plus_di + minus_di).replace(0, np.nan)
    dx = 100 * (plus_di - minus_di).abs() / total
    return _wilder(dx, n)


class Features:
    """The features of one symbol's bars, computed on demand and remembered.

    ``bars`` has ``open high low close volume`` on a time index. ``benchmark`` is an index's
    close on its own index (aligned here by date, carrying the last value over a day the
    index didn't trade); only ``rs_*`` needs it.
    """

    def __init__(self, bars: pd.DataFrame, benchmark: pd.Series | None = None):
        self.bars = bars
        self.benchmark = None
        self._raw_benchmark = benchmark
        if benchmark is not None and len(benchmark):
            self.benchmark = benchmark.reindex(bars.index, method="ffill")
        self._cache: dict[str, pd.Series] = {}
        self._timelines: dict[str, tuple] = {}

    def __len__(self) -> int:
        return len(self.bars)

    @property
    def index(self) -> pd.DatetimeIndex:
        return self.bars.index

    def get(self, name: str) -> pd.Series:
        key = canonical(name)
        if key not in self._cache:
            tf = interval(key)
            if tf == "D":
                self._cache[key] = self._compute(key).astype("float64")
            else:
                sub, to_period, _ = self._timeline(tf)
                self._cache[key] = self.to_daily(sub.get(base(key)), to_period).astype("float64")
        return self._cache[key]

    def release(self) -> None:
        """Forgets the computed features, keeping the bars. A Study over a whole exchange would
        otherwise hold dozens of full-length series per symbol at once; recomputing is cheap."""
        self._cache.clear()
        self._timelines.clear()

    def frame(self, names) -> pd.DataFrame:
        return pd.DataFrame({canonical(n): self.get(n) for n in names}, index=self.index)

    # -- weekly and monthly bars

    def _timeline(self, tf: str) -> tuple:
        """The bars of interval ``tf`` as their own ``Features``, which period each daily bar falls
        in, and each period's last daily bar."""
        if tf not in self._timelines:
            codes, last = period_bounds(self.index, tf)
            columns = period_bars({c: self.bars[c].to_numpy(dtype="float64") for c in BAR_COLUMNS}, codes, last)
            periods = pd.DataFrame(columns, index=self.index[last])
            self._timelines[tf] = (Features(periods, self._raw_benchmark), codes, last)
        return self._timelines[tf]

    def to_daily(self, values, to_period):
        """A per-period series as a daily one: each day gets its period's value."""
        return pd.Series(values.to_numpy()[to_period], index=self.index)

    def on(self, tf: str, name: str):
        """A feature on interval ``tf``'s bars: a coarser one as it is, a daily one as of each
        period's last day."""
        daily = self.get(name)
        if tf == "D":
            return daily
        sub, _, last = self._timeline(tf)
        return pd.Series(daily.to_numpy()[last], index=sub.index)

    def _compute(self, key: str) -> pd.Series:
        bars = self.bars
        close, high, low, volume = bars["close"], bars["high"], bars["low"], bars["volume"]
        if key in ("open", "high", "low", "close", "volume"):
            return bars[key]
        if key == "gap":
            return bars["open"] / close.shift(1) - 1
        if key == "gap_up":
            gap = self.get("gap")
            return gap.where(gap > 0, 0.0).where(gap.notna())
        if key == "gap_down":
            gap = self.get("gap")
            return (-gap).where(gap < 0, 0.0).where(gap.notna())
        if key in ("macd", "macd_signal", "macd_hist"):
            macd = self.get("ema_12") - self.get("ema_26")
            signal = macd.ewm(span=9, adjust=False, min_periods=9).mean()
            # As a fraction of the price, so it compares across stocks priced ₹10 and ₹10,000.
            value = {"macd": macd, "macd_signal": signal, "macd_hist": macd - signal}[key]
            return value / close

        family, n = split(key)
        if family == "return":
            return close / close.shift(n) - 1
        if family == "change":
            return close - close.shift(n)
        if family == "gain_from_low":
            return close / close.rolling(n + 1, min_periods=n + 1).min() - 1
        if family == "sma":
            return close.rolling(n, min_periods=n).mean()
        if family == "ema":
            ema = close.ewm(span=n, adjust=False).mean()
            # Not reported until a full window has passed, like every other average.
            return ema.where(close.notna().cumsum() >= n)
        if family in ("dist_sma", "dist_ema"):
            return close / self.get(f"{family[5:]}_{n}") - 1
        if family in ("slope_sma", "slope_ema"):
            average = self.get(f"{family[6:]}_{n}")
            return average / average.shift(SLOPE_BARS) - 1
        if family == "rsi":
            delta = close.diff()
            gain = _wilder(delta.clip(lower=0), n)
            loss = _wilder(-delta.clip(upper=0), n)
            rsi = 100 - 100 / (1 + gain / loss)
            return rsi.where(loss != 0, 100.0).where(gain.notna())
        if family == "atr":
            return _wilder(_true_range(bars), n)
        if family == "atr_pct":
            return self.get(f"atr_{n}") / close
        if family == "high":
            return high.rolling(n, min_periods=n).max()
        if family == "low":
            return low.rolling(n, min_periods=n).min()
        if family == "prior_high":
            return self.get(f"high_{n}").shift(1)
        if family == "prior_low":
            return self.get(f"low_{n}").shift(1)
        if family == "dist_high":
            return close / self.get(f"high_{n}") - 1
        if family == "dist_low":
            return close / self.get(f"low_{n}") - 1
        if family == "range":
            return self.get(f"high_{n}") / self.get(f"low_{n}") - 1
        if family == "avg_volume":
            return volume.rolling(n, min_periods=n).mean()
        if family == "rvol":
            # Against the average of the n bars *before*, so a spike doesn't dilute itself.
            base = self.get(f"avg_volume_{n}").shift(1)
            return volume / base.where(base > 0)
        if family == "avg_traded_value":
            return (close * volume).rolling(n, min_periods=n).mean()
        if family == "volatility":
            return (close / close.shift(1) - 1).rolling(n, min_periods=n).std() * math.sqrt(TRADING_DAYS)
        if family == "drawdown":
            return close / close.rolling(n, min_periods=n).max() - 1
        if family == "max_drawdown":
            return _rolling_max_drawdown(close, n)
        if family == "rs":
            if self.benchmark is None:
                return close * np.nan
            bench = self.benchmark
            return (close / close.shift(n) - 1) - (bench / bench.shift(n) - 1)
        if family == "adx":
            return _adx(bars, n)
        if family in ("bb_pctb", "bb_width"):
            mid = self.get(f"sma_{n}")
            sd = close.rolling(n, min_periods=n).std(ddof=0)
            upper, lower = mid + 2 * sd, mid - 2 * sd
            if family == "bb_width":
                return (upper - lower) / mid
            return (close - lower) / (upper - lower).replace(0, np.nan)
        if family == "stoch_k":
            lowest = low.rolling(n, min_periods=n).min()
            highest = high.rolling(n, min_periods=n).max()
            return 100 * (close - lowest) / (highest - lowest).replace(0, np.nan)
        if family == "stoch_d":
            return self.get(f"stoch_k_{n}").rolling(3, min_periods=3).mean()
        raise FeatureError(f"Unknown feature {key!r}.")  # pragma: no cover - canonical() guards


# ---- Conditions --------------------------------------------------------------------------------

OPS = (">", ">=", "<", "<=", "crosses_above", "crosses_below", "between", "outside")
# Operators whose right side is a range, ``[low, high]``, both ends included in ``between``.
RANGE_OPS = ("between", "outside")
_CONDITION = re.compile(r"^\s*([A-Za-z0-9_@]+)\s*(>=|<=|>|<|crosses_above|crosses_below)\s*(\S+)\s*$")


def parse_condition(value) -> dict:
    """A condition as ``{"left", "op", "right"}``: from that dict, or from text such as
    ``"return_252 crosses_above 1.0"`` or ``"close > ema_200"``. ``right`` is a number or a
    feature name, or ``[low, high]`` for ``between`` and ``outside``."""
    if isinstance(value, str):
        match = _CONDITION.match(value)
        if not match:
            raise FeatureError(
                f"Can't read the condition {value!r}. Write it as <feature> <op> <number or feature>, "
                f"with op one of {', '.join(o for o in OPS if o not in RANGE_OPS)}."
            )
        left, op, right = match.groups()
        try:
            right = float(right)
        except ValueError:
            pass
        value = {"left": left, "op": op, "right": right}
    if not isinstance(value, dict):
        raise FeatureError(f"A condition must be text or a dict, not {type(value).__name__}.")
    op = value.get("op")
    if op not in OPS:
        raise FeatureError(f"The operator must be one of {', '.join(OPS)}, not {op!r}.")
    right = value.get("right")
    if op in RANGE_OPS:
        if (
            not isinstance(right, (list, tuple))
            or len(right) != 2
            or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in right)
        ):
            raise FeatureError(f"{op} needs a range: [low, high], two numbers.")
        if right[0] > right[1]:
            raise FeatureError(f"{op}: the low end of the range is above the high end.")
        right = [right[0], right[1]]
    else:
        if isinstance(right, bool) or not isinstance(right, (int, float, str)):
            raise FeatureError(f"The right side of a condition must be a number or a feature, not {right!r}.")
        if isinstance(right, (int, float)) and not math.isfinite(right):
            raise FeatureError("The right side of a condition must be a finite number.")
        if isinstance(right, str):
            right = canonical(right)
    out = {"left": canonical(value.get("left", "")), "op": op, "right": right}
    if isinstance(value.get("label"), str) and value["label"].strip():
        out["label"] = value["label"].strip()
    return out


def condition_features(condition: dict) -> list[str]:
    names = [condition["left"]]
    if isinstance(condition["right"], str):
        names.append(condition["right"])
    return names


def describe_condition(condition: dict) -> str:
    right = condition["right"]
    if isinstance(right, list):
        right_text = f"{right[0]:g} and {right[1]:g}"
    else:
        right_text = right if isinstance(right, str) else f"{right:g}"
    return f"{condition['left']} {condition['op']} {right_text}"


def evaluate(features: Features, condition: dict) -> pd.Series:
    """Where a condition holds, as a boolean Series (a DataFrame, for ``wide.WideFeatures``). A bar
    where either side is unknown is False.

    A condition is judged on its left feature's interval: ``rsi_14@W crosses_above 50`` crossed this
    week, compared with last week. A daily right side is taken as of each week's last day, a coarser
    one as its period's value; the answer is then given for each day, from the period it falls in."""
    tf = interval(condition["left"])
    left = features.on(tf, condition["left"])
    right = condition["right"]
    if isinstance(right, str):
        right = features.on(tf, right)
    out = _compare(left, condition["op"], right)
    if tf == "D":
        return out
    _, to_period, _ = features._timeline(tf)
    return features.to_daily(out, to_period).astype(bool)


def _compare(left, op: str, right):
    if op in RANGE_OPS:
        low, high = float(right[0]), float(right[1])
        inside = (left >= low) & (left <= high)
        out = inside if op == "between" else (left < low) | (left > high)
        return (out & left.notna()).astype(bool)
    if isinstance(right, (pd.Series, pd.DataFrame)):
        known = left.notna() & right.notna()
    else:
        right = float(right)
        known = left.notna() & (not math.isnan(right))
    if op == ">":
        out = left > right
    elif op == ">=":
        out = left >= right
    elif op == "<":
        out = left < right
    elif op == "<=":
        out = left <= right
    else:
        above = left > right if op == "crosses_above" else left < right
        prev_known = known.shift(1, fill_value=False)
        prev = above.shift(1, fill_value=False)
        out = above & ~prev & prev_known
    return (out & known).astype(bool)
