"""Studies: what did stocks look like around historical market events?

A Study is described by a *Study Specification* — a plain dict (JSON in the app) that is the
source of truth; this module is one engine that executes it::

    universe → historical data → event detection → event context → measurement
             → comparison (control group) → aggregation → a result the app draws

In the app, Studies are built and run from the Studies tab, which starts
``python -m protrade.run_study spec.json``. The same engine is a Python API for scripts::

    from protrade.study import ResearchStudy

    study = ResearchStudy(spec)                 # spec: a dict, as saved by the Studies tab
    universe = study.universe(exchanges=["NSE"], min_avg_traded_value=5e7)
    data = study.load(universe)
    events = study.detect_events(data, conditions=["return_252 crosses_above 1.0"])
    results = study.measure(events, data)
    control = study.control_group(data, events)
    study.analyze(results, control)

Everything here describes *historical association*. Nothing measures or claims a cause.

The OHLCV series are taken exactly as the data source supplies them (already adjusted for
corporate actions): the engine never adjusts a price. Data it doesn't have — market cap,
sectors, a point-in-time list of what was listed when — it says it doesn't have, and never
estimates or substitutes.
"""

from __future__ import annotations

import datetime as _dt
import re
import hashlib
import json
import math
import platform
import sys
import time
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
import pandas as pd

from . import api, client, features as feat, measures as msr, results, stats_tests as tests_mod, wide
from .wide import WideFeatures

SPEC_VERSION = 1
# 1.1: measures (what a Study reads over a window of bars) and the Study's question.
ENGINE_VERSION = "1.1"
RESULT_FORMAT = 1

# Studies read Indian market data (through whichever broker the app uses); a spec saved under a
# broker's name (`zerodha`) reads as the Indian namespace.
PROVIDERS = (client.INDIA,)
EXCHANGES = ("NSE", "BSE")
UNIVERSE_SOURCES = ("instruments", "watchlist", "symbols")
# Which listings of an instrument list count as stocks: ordinary shares ("EQ"), the trade-for-trade
# series ("BE", Kite's -BE/-BZ) and the SME platforms ("SME", -SM/-ST/-SZ). Everything else an
# exchange lists as "equity" (bonds, SGBs, G-secs, T-bills, ETFs, REIT/InvIT units) is never a stock.
SERIES = ("EQ", "BE", "SME")
_SERIES_SUFFIX = {"BE": "BE", "BZ": "BE", "SM": "SME", "ST": "SME", "SZ": "SME"}
_FUND_NAME = re.compile(r"\b(ETF|FOF|FUND|BEES|INVIT|REIT)\b|BEES$|ETF$", re.IGNORECASE)
_COMPANY_NOISE = re.compile(r"\b(LIMITED|LTD|THE)\b|[^A-Z0-9]")
MAX_CONDITIONS = 8
MAX_FILTERS = 12
MAX_WINDOWS = 8
MAX_METRICS = 40
MAX_CHARACTERISTICS = 20
MAX_SYMBOLS = 10_000
DEFAULT_MAX_EVENTS = 5_000
MAX_EVENTS = 10_000
MAX_CONTROL = 20_000
HISTOGRAM_BINS = 20
PATH_POINTS = 120
LIQUIDITY_FEATURE = "avg_traded_value_50"
# A difference "stands out" below this false-discovery rate; at most this many are listed.
FINDING_Q = 0.05
MAX_FINDINGS = 10
# Requests kept in flight to the app. It paces the broker itself; this only has to be enough that
# a request is always waiting at that pace, whatever each round trip costs.
LOAD_WORKERS = 8
# Symbols per panel read from the app's memory: a few years of a few hundred symbols is a few MB, and
# the features detection needs are computed for each batch together.
PANEL_BATCH = 400


class SpecError(ValueError):
    """The Study Specification is not one this engine can run."""


class StudyDataError(RuntimeError):
    """The Study asks for data the app doesn't have (market cap, say)."""


# ---- The specification ---------------------------------------------------------------------------


def _date(value, field: str) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise SpecError(f"{field} must be a date written YYYY-MM-DD.")
    try:
        return _dt.date.fromisoformat(value.strip()).isoformat()
    except ValueError:
        raise SpecError(f"{field} must be a date written YYYY-MM-DD, not {value!r}.") from None


def _number(value, field: str, minimum: float | None = None):
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise SpecError(f"{field} must be a number.")
    if minimum is not None and value < minimum:
        raise SpecError(f"{field} must be at least {minimum:g}.")
    return float(value)


def _int(value, field: str, low: int, high: int, default: int | None = None):
    if value is None:
        if default is None:
            raise SpecError(f"{field} is required.")
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != int(value):
        raise SpecError(f"{field} must be a whole number.")
    if not low <= value <= high:
        raise SpecError(f"{field} must be between {low} and {high}.")
    return int(value)


def _windows(value, field: str) -> list[int]:
    if not isinstance(value, list) or not value:
        raise SpecError(f"{field} must list at least one window, in bars.")
    if len(value) > MAX_WINDOWS:
        raise SpecError(f"{field} can hold at most {MAX_WINDOWS} windows.")
    return sorted({_int(v, field, 1, feat.MAX_WINDOW) for v in value})


def _conditions(value, field: str, limit: int, need_one: bool, with_at: bool = False, need_label: bool = False) -> list[dict]:
    if value is None:
        value = []
    if not isinstance(value, list):
        raise SpecError(f"{field} must be a list of conditions.")
    if need_one and not value:
        raise SpecError(f"{field} needs at least one condition.")
    if len(value) > limit:
        raise SpecError(f"{field} can hold at most {limit} conditions.")
    out = []
    for i, item in enumerate(value):
        try:
            condition = feat.parse_condition(item)
        except feat.FeatureError as e:
            raise SpecError(f"{field}[{i}]: {e}") from None
        if with_at:
            at = item.get("at") if isinstance(item, dict) else None
            condition["at"] = _int(at, f"{field}[{i}].at", 0, feat.MAX_WINDOW, default=0)
        if need_label and "label" not in condition:
            condition["label"] = feat.describe_condition(condition)
        out.append(condition)
    return out


def normalize_spec(spec: dict) -> dict:
    """The spec checked and completed: defaults filled in and every feature name in its
    canonical spelling. Raises :class:`SpecError` naming the first problem.

    ``src/studies/spec.ts`` applies the same rules in the app; keep the two in step.
    """
    if not isinstance(spec, dict):
        raise SpecError("A Study Specification is a JSON object.")
    version = spec.get("version", SPEC_VERSION)
    if version != SPEC_VERSION:
        raise SpecError(f"This engine runs version {SPEC_VERSION} specifications, not {version!r}.")
    name = spec.get("name")
    if not isinstance(name, str) or not name.strip():
        raise SpecError("A Study needs a name.")
    if len(name) > 120:
        raise SpecError("A Study's name can be at most 120 characters.")

    raw = spec.get("universe") or {}
    if not isinstance(raw, dict):
        raise SpecError("universe must be an object.")
    source = raw.get("source", "instruments")
    if source not in UNIVERSE_SOURCES:
        raise SpecError(f"universe.source must be one of {', '.join(UNIVERSE_SOURCES)}.")
    provider = raw.get("provider", client.INDIA)
    if isinstance(provider, str):
        provider = client.canonical_provider(provider)
    if provider not in PROVIDERS:
        raise SpecError(f"universe.provider must be one of {', '.join(PROVIDERS)}.")
    exchanges = raw.get("exchanges", ["NSE"])
    if not isinstance(exchanges, list) or not exchanges or any(e not in EXCHANGES for e in exchanges):
        raise SpecError(f"universe.exchanges must list one or more of {', '.join(EXCHANGES)}.")
    watchlist = raw.get("watchlist")
    if source == "watchlist" and (not isinstance(watchlist, str) or not watchlist.strip()):
        raise SpecError("universe.watchlist must name a watchlist.")
    symbols = raw.get("symbols") or []
    if not isinstance(symbols, list) or any(not isinstance(s, str) or ":" not in s for s in symbols):
        raise SpecError("universe.symbols must be a list of symbols like india:NSE:RELIANCE.")
    if source == "symbols" and not symbols:
        raise SpecError("universe.symbols needs at least one symbol.")
    if len(symbols) > MAX_SYMBOLS:
        raise SpecError(f"universe.symbols can hold at most {MAX_SYMBOLS} symbols.")
    max_symbols = raw.get("max_symbols")
    series = raw.get("series", ["EQ"])
    if not isinstance(series, list) or not series or any(x not in SERIES for x in series):
        raise SpecError(f"universe.series must list one or more of {', '.join(SERIES)}.")
    universe = {
        "source": source,
        "provider": provider,
        "exchanges": list(dict.fromkeys(exchanges)),
        "series": [x for x in SERIES if x in series],
        "watchlist": watchlist.strip() if isinstance(watchlist, str) and watchlist.strip() else None,
        "symbols": list(dict.fromkeys(client.canonical_symbol_prefix(s.strip()) for s in symbols)),
        "market_cap_min": _number(raw.get("market_cap_min"), "universe.market_cap_min", 0),
        "min_avg_traded_value": _number(raw.get("min_avg_traded_value"), "universe.min_avg_traded_value", 0),
        "min_price": _number(raw.get("min_price"), "universe.min_price", 0),
        "max_symbols": None if max_symbols is None else _int(max_symbols, "universe.max_symbols", 1, MAX_SYMBOLS),
    }

    period = spec.get("period") or {}
    start = _date(period.get("start"), "period.start")
    end = _date(period.get("end"), "period.end")
    if start is None:
        raise SpecError("period.start is required: the first date an event may fall on.")
    if end is not None and end <= start:
        raise SpecError("period.end must come after period.start.")

    event = spec.get("event") or {}
    if not isinstance(event, dict):
        raise SpecError("event must be an object.")
    conditions = _conditions(event.get("conditions"), "event.conditions", MAX_CONDITIONS, need_one=True)
    label = event.get("label")
    label = label.strip() if isinstance(label, str) and label.strip() else " and ".join(map(feat.describe_condition, conditions))

    question = spec.get("question")
    if question is not None and not isinstance(question, str):
        raise SpecError("question must be text.")
    question = question.strip() if isinstance(question, str) else ""
    if len(question) > msr.MAX_QUESTION:
        raise SpecError(f"question can be at most {msr.MAX_QUESTION} characters.")
    try:
        measures = msr.normalize_measures(spec.get("measures"))
    except msr.MeasureError as e:
        raise SpecError(str(e)) from None

    metrics = spec.get("metrics")
    if metrics is None:
        metrics = []
    if not isinstance(metrics, list):
        raise SpecError("metrics must be a list of features.")
    if len(metrics) > MAX_METRICS:
        raise SpecError(f"metrics can hold at most {MAX_METRICS} features.")
    try:
        metrics = list(dict.fromkeys(feat.canonical(m) for m in metrics))
    except feat.FeatureError as e:
        raise SpecError(f"metrics: {e}") from None
    if not metrics and not measures:
        raise SpecError("A Study needs at least one metric or one measure.")

    control = spec.get("control_group") or {}
    output = spec.get("output") or {}
    outcome = spec.get("outcome")
    if outcome is not None:
        if not isinstance(outcome, dict):
            raise SpecError("outcome must be an object with window and min_return, or null.")
        min_return = _number(outcome.get("min_return"), "outcome.min_return", -1)
        if min_return is None:
            raise SpecError("outcome.min_return is required.")
        outcome = {"window": _int(outcome.get("window"), "outcome.window", 1, feat.MAX_WINDOW), "min_return": min_return}
    benchmark = spec.get("benchmark")
    if benchmark is not None and (not isinstance(benchmark, str) or ":" not in benchmark):
        raise SpecError("benchmark must be a symbol like india:NSE:NIFTY_500, or null.")

    normalized = {
        "version": SPEC_VERSION,
        "name": name.strip(),
        "description": spec.get("description") if isinstance(spec.get("description"), str) else "",
        "question": question,
        "template": spec.get("template") if isinstance(spec.get("template"), str) else None,
        "universe": universe,
        "period": {"start": start, "end": end},
        "event": {
            "label": label,
            "conditions": conditions,
            "cooldown_days": _int(event.get("cooldown_days"), "event.cooldown_days", 1, 2520, default=252),
        },
        "pre_event_filters": _conditions(spec.get("pre_event_filters"), "pre_event_filters", MAX_FILTERS, need_one=False, with_at=True),
        "lookback_windows": _windows(spec.get("lookback_windows", [252, 126, 63, 21]), "lookback_windows"),
        "forward_windows": _windows(spec.get("forward_windows", [63, 126, 252]), "forward_windows"),
        "metrics": metrics,
        "characteristics": _conditions(spec.get("characteristics"), "characteristics", MAX_CHARACTERISTICS, need_one=False, need_label=True),
        "measures": measures,
        "benchmark": client.canonical_symbol_prefix(benchmark.strip()) if isinstance(benchmark, str) else None,
        "outcome": outcome,
        "control_group": {
            "enabled": bool(control.get("enabled", True)),
            "samples_per_event": _int(control.get("samples_per_event"), "control_group.samples_per_event", 1, 10, default=2),
            "seed": _int(control.get("seed"), "control_group.seed", 0, 2**31 - 1, default=42),
        },
        "output": {"max_events": _int(output.get("max_events"), "output.max_events", 1, MAX_EVENTS, default=DEFAULT_MAX_EVENTS)},
    }
    # On a past day, that week's or month's bar includes the days after it: a look-ahead.
    periodic = [n for n in required_features(normalized) if feat.interval(n) != "D"]
    if periodic:
        raise SpecError(f"{', '.join(periodic)}: weekly and monthly features are for the Screener; a Study reads daily bars.")
    if normalized["benchmark"] is None:
        needing = [n for n in required_features(normalized) if feat.needs_benchmark(n)]
        if needing:
            raise SpecError(f"{', '.join(needing)} compare against an index: set benchmark (e.g. india:NSE:NIFTY_500).")
    return normalized


def required_features(spec: dict) -> list[str]:
    """Every feature a run of ``spec`` computes."""
    names = ["close", "high", "low", LIQUIDITY_FEATURE, *spec["metrics"]]
    for group in (spec["event"]["conditions"], spec["pre_event_filters"], spec["characteristics"]):
        for condition in group:
            names += feat.condition_features(condition)
    for measure in spec.get("measures", []):
        names += msr.measure_features(measure)
    return list(dict.fromkeys(names))


def offsets(spec: dict) -> list[int]:
    """The observation points, in bars from the event: before it, the event itself, after it."""
    return [-w for w in reversed(spec["lookback_windows"])] + [0] + list(spec["forward_windows"])


def offset_key(offset: int) -> str:
    return "0" if offset == 0 else f"{offset:+d}"


def column(metric: str, offset: int) -> str:
    """The event table's column for a metric at an observation point: ``rsi_14@-63``."""
    return f"{metric}@{offset_key(offset)}"


def measure_column(index: int, part: str | None = None) -> str:
    """The event table's columns for measure ``index``: its value (``measure_0``), its status
    (``measure_0_status``) and, for a window with a found endpoint, where it began (``measure_0_from``)
    and how many bars it spans (``measure_0_bars``)."""
    return f"measure_{index}" if part is None else f"measure_{index}_{part}"


def measure_columns(spec: dict) -> list[str]:
    out = []
    for k, measure in enumerate(spec.get("measures", [])):
        out += [measure_column(k), measure_column(k, "status")]
        if msr.is_anchored(measure["window"]):
            out += [measure_column(k, "from"), measure_column(k, "bars")]
    return out


def history_bars(spec: dict) -> int:
    """Bars needed before the first possible event date for every measurement to have a value."""
    names = required_features(spec)
    deepest = max(feat.warmup(n) for n in names)
    filters = max((f["at"] for f in spec["pre_event_filters"]), default=0)
    reach = max([max(spec["lookback_windows"])] + [msr.reach(m) for m in spec.get("measures", [])])
    return reach + max(deepest, filters) + 5


def fetch_start(spec: dict) -> _dt.date:
    """The first date to load: enough trading days before ``period.start``, in calendar days."""
    start = _dt.date.fromisoformat(spec["period"]["start"])
    return start - _dt.timedelta(days=math.ceil(history_bars(spec) * 365 / 245) + 10)


# ---- Small helpers -------------------------------------------------------------------------------


def describe(values) -> dict:
    """Count, mean, median, min, max and quartiles of the finite values (``None`` where empty)."""
    array = np.asarray(values, dtype="float64")
    array = array[np.isfinite(array)]
    if array.size == 0:
        return {"count": 0, "mean": None, "median": None, "min": None, "max": None, "p25": None, "p75": None}
    p25, median, p75 = np.percentile(array, [25, 50, 75])
    return {
        "count": int(array.size),
        "mean": _round(array.mean()),
        "median": _round(median),
        "min": _round(array.min()),
        "max": _round(array.max()),
        "p25": _round(p25),
        "p75": _round(p75),
    }


def _round(value, digits: int = 6):
    """A float for JSON with six significant digits, or None."""
    if value is None:
        return None
    x = float(value)
    if not math.isfinite(x):
        return None
    if x == 0:
        return 0.0
    return round(x, max(0, digits - 1 - int(math.floor(math.log10(abs(x))))))


def histogram(event_values, control_values, bins: int = HISTOGRAM_BINS) -> dict | None:
    """Shared bin edges for the events and the control group, clipped to the 2nd-98th percentile so
    one outlier doesn't squash the rest into a single bar (the clipped tails fall in the end bins)."""
    ev = np.asarray(event_values, dtype="float64")
    ev = ev[np.isfinite(ev)]
    cv = np.asarray(control_values, dtype="float64")
    cv = cv[np.isfinite(cv)]
    both = np.concatenate([ev, cv])
    if both.size == 0:
        return None
    low, high = np.percentile(both, [2, 98])
    if not high > low:
        low, high = float(both.min()), float(both.max())
    if not high > low:
        high = low + (abs(low) * 0.01 or 1.0)
    edges = np.linspace(low, high, bins + 1)

    def counts(values):
        clipped = np.clip(values, low, high)
        return [int(c) for c in np.histogram(clipped, bins=edges)[0]]

    return {"edges": [_round(e) for e in edges], "events": counts(ev), "control": counts(cv)}


def _cell(value):
    if isinstance(value, (float, np.floating)):
        return _round(value)
    return results.cell(value)


def _progress(pct: int, stage: str) -> None:
    """A line the app turns into its progress bar; readable in a terminal as it is."""
    print(f"[progress] {max(0, min(100, int(pct))):3d}% {stage}", flush=True)


def _title_case_offset(offset: int) -> str:
    return "T0" if offset == 0 else f"T{offset:+d}"


# ---- The universe ---------------------------------------------------------------------------------


def listing_series(ticker: str, name: str | None) -> str | None:
    """Which kind of stock a listing is — ``"EQ"``, ``"BE"`` or ``"SME"`` — or None when it isn't a
    stock at all. ``ticker`` is without its exchange (``RELIANCE``, ``XYZ-BE``, ``SGBAUG28V-GB``).

    Brokers list every exchange "equity" row, which is mostly not shares: an NSE list holds thousands
    of bonds, SGBs, G-secs and T-bills, and a BSE list many more. Each would cost a broker request
    for a series that can never be an event, so they are left out before anything is fetched.
    """
    ticker = ticker.strip().upper()
    if not ticker:
        return None
    if "-" in ticker:
        return _SERIES_SUFFIX.get(ticker.rsplit("-", 1)[1])
    # Debt and T-bills are spelled from their coupon or tenor: 1030FC24, 364D210226.
    if ticker[0].isdigit():
        return None
    if _FUND_NAME.search(ticker) or (isinstance(name, str) and _FUND_NAME.search(name)):
        return None
    return "EQ"


def company_key(name: str | None) -> str | None:
    """A company's name reduced to what two exchanges' lists agree on: ``Reliance Industries Ltd.``
    and ``RELIANCE INDUSTRIES`` are one key."""
    if not isinstance(name, str):
        return None
    key = _COMPANY_NOISE.sub("", name.upper())
    return key or None


def pick_listings(rows, series=("EQ",)) -> list[tuple[str, str | None]]:
    """``(symbol, name)`` rows of one or more exchanges' lists, in order, reduced to one listing per
    company among the chosen ``series``. A company on two exchanges is kept on the first one seen,
    matched by ticker or by name, since the two exchanges don't always spell its ticker alike."""
    wanted = set(series)
    out, tickers, companies = [], set(), set()
    for symbol, name in rows:
        ticker = symbol.rsplit(":", 1)[-1]
        kind = listing_series(ticker, name)
        if kind is None or kind not in wanted:
            continue
        base = ticker.rsplit("-", 1)[0] if kind != "EQ" else ticker
        company = company_key(name)
        if base in tickers or (company is not None and company in companies):
            continue
        tickers.add(base)
        if company is not None:
            companies.add(company)
        out.append((symbol, name if isinstance(name, str) and name else None))
    return out


# ---- The engine ------------------------------------------------------------------------------------


class ResearchStudy:
    """One Study: its specification, the data it loaded, and what it found.

    The steps can be called one at a time (each takes overrides of the spec, so a script can
    try a variation without writing a new spec) or all at once with :meth:`run`.
    """

    def __init__(self, spec: dict, progress: bool = True):
        self.spec = normalize_spec(spec)
        self.show_progress = progress
        self.warnings: list[dict] = []
        self.names: dict[str, str] = {}
        self.failed: dict[str, str] = {}
        self.requested = 0
        self.benchmark_close: pd.Series | None = None
        self.started = time.monotonic()
        self.outcome_counts: dict | None = None
        self.skipped_listings = 0
        # symbol -> (first bar, last bar, bars, last close) of every series loaded, kept even when
        # its bars are dropped, for the result's coverage and data version.
        self._series_info: dict[str, tuple] = {}
        self.timings: dict[str, float] = {}
        # Where measure() reports its progress, and as what; run() sets it for each group it measures.
        self._measure_band = (75, 90)
        self._measure_stage = "Calculating metrics"
        self._eligible: dict[str, np.ndarray] = {}
        self._event_mask: dict[str, np.ndarray] = {}

    # -- reporting

    def warn(self, code: str, message: str) -> None:
        if not any(w["code"] == code for w in self.warnings):
            self.warnings.append({"code": code, "message": message})
            if not results.in_app():
                print(f"warning: {message}", file=sys.stderr)

    def progress(self, pct: int, stage: str) -> None:
        if self.show_progress:
            _progress(pct, stage)

    def _respec(self, section: str | None, **changes) -> None:
        """Applies overrides passed to a step, and checks the spec again."""
        changes = {k: v for k, v in changes.items() if v is not None}
        if not changes:
            return
        spec = json.loads(json.dumps(self.spec))
        if section:
            spec[section] = {**spec[section], **changes}
        else:
            spec.update(changes)
        self.spec = normalize_spec(spec)

    # -- 1. universe

    def universe(self, source=None, provider=None, exchanges=None, exchange=None, watchlist=None,
                 symbols=None, market_cap_min=None, min_avg_traded_value=None, min_price=None,
                 max_symbols=None) -> list[str]:
        """The symbols the Study covers, from the broker's instrument list, a watchlist, or a list.

        A market-cap filter can't be honoured — no data source here supplies market cap — so
        asking for one raises :class:`StudyDataError` rather than being quietly ignored.
        """
        self._respec(
            "universe", source=source, provider=provider, exchanges=exchanges or exchange,
            watchlist=watchlist, symbols=symbols, market_cap_min=market_cap_min,
            min_avg_traded_value=min_avg_traded_value, min_price=min_price, max_symbols=max_symbols,
        )
        u = self.spec["universe"]
        if u["market_cap_min"] is not None:
            raise StudyDataError(
                "Market cap isn't available from the app's data sources, so a market-cap filter can't be applied. "
                "Remove it, or filter on average traded value (universe.min_avg_traded_value) instead."
            )
        self.progress(1, "Scanning universe")
        if u["source"] == "symbols":
            chosen = list(u["symbols"])
            self.warn("hindsight_universe", "The universe is a list chosen today, so it may carry hindsight (survivorship or selection bias).")
        elif u["source"] == "watchlist":
            rows = client.get("/v1/watchlist", name=u["watchlist"])["symbols"]
            chosen = []
            for row in rows:
                if client.canonical_provider(row["symbol"].split(":", 1)[0]) in PROVIDERS:
                    chosen.append(client.canonical_symbol_prefix(row["symbol"]))
                    if row.get("name"):
                        self.names[client.canonical_symbol_prefix(row["symbol"])] = row["name"]
            if not chosen:
                raise client.NotFoundError(f"The watchlist {u['watchlist']!r} has no Indian market symbols on it.")
            self.warn("hindsight_universe", "The universe is a watchlist chosen today, so it may carry hindsight (survivorship or selection bias).")
        else:
            rows = []
            for exchange in u["exchanges"]:
                listed = api.instruments(u["provider"], exchange=exchange, kind="EQUITY", limit=50_000)
                rows += list(zip(listed["symbol"], listed["name"]))
            picked = pick_listings(rows, u["series"])
            self.skipped_listings = len(rows) - len(picked)
            chosen = [symbol for symbol, _ in picked]
            self.names.update({symbol: name for symbol, name in picked if name})
            if not chosen:
                raise client.NotFoundError(
                    f"The broker's instrument list has no equities for {', '.join(u['exchanges'])}. "
                    "Open Data providers and update the instrument list."
                )
            if len(u["exchanges"]) > 1:
                self.warn("dual_listing", "A stock listed on more than one exchange is studied once, on the first exchange named.")
            if u["series"] != ["EQ"]:
                self.warn("series", f"The universe includes the {', '.join(x for x in u['series'] if x != 'EQ')} series as well as ordinary shares.")
            self.warn(
                "survivorship",
                "Historical universe data is incomplete: the universe is today's instrument list, so stocks that were "
                "delisted before today are missing. Results may contain survivorship bias.",
            )
        if u["max_symbols"] is not None and len(chosen) > u["max_symbols"]:
            chosen = chosen[: u["max_symbols"]]
            self.warn("sampled_universe", f"Only the first {u['max_symbols']} symbols of the universe were studied (universe.max_symbols).")
        self.requested = len(chosen)
        return chosen

    # -- 2. historical data

    def load(self, symbols, on_symbol=None) -> dict[str, feat.Features]:
        """Daily bars for each symbol (and the benchmark), from the study's first needed date.

        Symbols the app holds in memory come in batches, one read each, with the features
        event detection needs computed for the whole batch at once; only the rest are fetched one by
        one. ``on_symbol(symbol, features)`` is called as each symbol arrives; a falsy answer leaves
        that symbol out of the result (it can never be used). The result is in universe order, so
        nothing downstream depends on which fetch finished first."""
        spec = self.spec
        start, end = fetch_start(spec), spec["period"]["end"]
        symbols = list(dict.fromkeys(symbols))
        self.requested = self.requested or len(symbols)

        if spec["benchmark"]:
            try:
                bench = api.bars(spec["benchmark"], "D", start=start, end=end, naive=True)
                self.benchmark_close = bench["close"]
                if bench.attrs.get("limited_from") is not None:
                    self.warn("benchmark_short", f"The benchmark {spec['benchmark']} has history only from {bench.attrs['limited_from']:%Y-%m-%d}.")
            except client.FATAL:
                raise
            except client.ProTradeError as e:
                self.warn("benchmark_missing", f"The benchmark {spec['benchmark']} couldn't be loaded ({e}); relative strength is blank.")

        data: dict[str, feat.Features] = {}
        total = len(symbols)
        started = time.monotonic()
        last_report = 0.0
        done = 0

        def accept(symbol: str, frame: pd.DataFrame | None, computed: dict | None = None) -> None:
            if frame is None or not len(frame):
                return
            self._series_info[symbol] = (frame.index[0], frame.index[-1], len(frame), float(frame["close"].iloc[-1]))
            features = feat.Features(frame, self.benchmark_close)
            features._cache.update(computed or {})
            if on_symbol is None or on_symbol(symbol, features):
                data[symbol] = features

        def report(stage: str) -> None:
            nonlocal last_report
            now = time.monotonic()
            if now - last_report >= 1.0 or done == total:
                last_report = now
                line = f"{stage} ({done}/{total})"
                pace = api._pace(done, total, now - started)
                if pace:
                    line += f" · {pace[0]:.1f}/s, about {api._duration(pace[1])} left"
                self.progress(2 + int(70 * done / max(total, 1)), line)

        missing: list[str] = []
        for i in range(0, total, PANEL_BATCH):
            batch = symbols[i : i + PANEL_BATCH]
            frames, lacking = api._from_panel(batch, start, end, None, naive=True)
            missing += lacking
            computed = self._detection_features(frames)
            for symbol in batch:
                if symbol in frames:
                    accept(symbol, frames[symbol], computed.get(symbol))
                    done += 1
            report("Reading historical data")

        if missing:
            topup = api._top_up(missing, start=start, end=end)
            if topup:
                ready = topup["current"] + topup["updated"]
                if ready:
                    self.progress(2, f"{ready} of {len(missing)} symbols already up to date")

            def fetch(symbol: str) -> pd.DataFrame:
                return api.bars(symbol, "D", start=start, end=end, naive=True)

            # One pool over everything the store lacks, so the app always has requests queued at the
            # broker's pace (it paces them itself); whatever arrives is processed while the rest is
            # fetched.
            pool = ThreadPoolExecutor(max_workers=LOAD_WORKERS)
            try:
                futures = {pool.submit(fetch, s): s for s in missing}
                for future in as_completed(futures):
                    symbol = futures[future]
                    done += 1
                    try:
                        frame = future.result()
                    except client.FATAL:
                        raise
                    except client.ProTradeError as e:
                        self.failed[symbol] = str(e)
                        frame = None
                    accept(symbol, frame)
                    report("Loading historical data")
            finally:
                pool.shutdown(wait=False, cancel_futures=True)
        data = {s: data[s] for s in symbols if s in data}
        self.timings["load"] = round(time.monotonic() - started, 1)
        if self.failed:
            self.warn("load_failed", f"{len(self.failed)} of {total} symbols couldn't be loaded and are left out.")
        if not self._series_info:
            raise StudyDataError("No symbol in the universe had any daily data to study.")
        return data

    def _detection_features(self, frames: dict[str, pd.DataFrame]) -> dict[str, dict[str, pd.Series]]:
        """The features event detection reads (its conditions, the pre-event filters, liquidity and
        price), for a batch of symbols at once: ``{symbol: {feature: series on its own dates}}``.
        The same numbers ``Features`` would compute one symbol at a time (``tests/test_wide.py``)."""
        if not frames:
            return {}
        spec = self.spec
        names = {"close", LIQUIDITY_FEATURE}
        for condition in [*spec["event"]["conditions"], *spec["pre_event_filters"]]:
            names.update(feat.condition_features(condition))
        table = WideFeatures(frames, self.benchmark_close)
        rows = len(table)
        out: dict[str, dict[str, pd.Series]] = {s: {} for s in frames}
        for name in names:
            key = feat.canonical(name)
            values = table.get(key)
            for symbol, frame in frames.items():
                n = len(frame)
                out[symbol][key] = pd.Series(values[symbol].to_numpy()[rows - n :], index=frame.index)
        return out

    # -- 3. events

    def _mask(self, features: feat.Features, conditions: list[dict]) -> pd.Series:
        mask = pd.Series(True, index=features.index)
        for condition in conditions:
            mask &= feat.evaluate(features, condition)
        return mask

    def _eligible_positions(self, features: feat.Features) -> np.ndarray:
        """Bars that pass the universe's point-in-time filters and fall inside the study period."""
        spec, u = self.spec, self.spec["universe"]
        index = features.index
        ok = index >= pd.Timestamp(spec["period"]["start"])
        if spec["period"]["end"]:
            ok &= index <= pd.Timestamp(spec["period"]["end"])
        ok = np.asarray(ok, dtype=bool)
        if u["min_avg_traded_value"] is not None:
            ok &= (features.get(LIQUIDITY_FEATURE) >= u["min_avg_traded_value"]).to_numpy()
        if u["min_price"] is not None:
            ok &= (features.get("close") >= u["min_price"]).to_numpy()
        for f in spec["pre_event_filters"]:
            ok &= feat.evaluate(features, f).shift(f["at"], fill_value=False).to_numpy(dtype=bool)
        return ok

    def detect_events(self, data: dict[str, feat.Features], conditions=None, cooldown_days=None, label=None) -> pd.DataFrame:
        """Every historical date the event happened: all its conditions became true together.

        An event is the *first* bar of a run where the conditions hold, so a stock that stays above
        a threshold for months is one event, not one per day; and after an event the same stock
        can't have another for ``cooldown_days`` bars. The universe's liquidity and price filters and
        the pre-event filters are judged at the time, never with later data.
        """
        if isinstance(conditions, str):
            conditions = [conditions]
        self._respec("event", conditions=conditions, cooldown_days=cooldown_days, label=label)
        rows = []
        for n, (symbol, features) in enumerate(data.items()):
            rows += self._detect_symbol(symbol, features)
            if n % 50 == 0:
                self.progress(60 + int(15 * n / max(len(data), 1)), "Detecting events")
        return self._events_frame(rows)

    def _detect_symbol(self, symbol: str, features: feat.Features) -> list[dict]:
        """One symbol's events (see :meth:`detect_events`), remembering which of its bars could be
        control dates. Its computed features are released afterwards."""
        spec = self.spec
        conds, cooldown = spec["event"]["conditions"], spec["event"]["cooldown_days"]
        mask = self._mask(features, conds)
        edges = (mask & ~mask.shift(1, fill_value=False)).to_numpy(dtype=bool)
        eligible = self._eligible_positions(features)
        self._eligible[symbol] = eligible
        self._event_mask[symbol] = mask.to_numpy(dtype=bool)
        rows, last = [], -(10**9)
        close = features.get("close").to_numpy()
        value = features.get(conds[0]["left"]).to_numpy()
        liquidity = features.get(LIQUIDITY_FEATURE).to_numpy()
        for pos in np.flatnonzero(edges & eligible):
            if pos - last < cooldown:
                continue
            last = pos
            rows.append(
                {
                    "symbol": symbol,
                    "name": self.names.get(symbol),
                    "event_date": features.index[pos],
                    "event_value": value[pos],
                    "price": close[pos],
                    "market_cap": None,
                    "avg_traded_value": liquidity[pos],
                    "pos": int(pos),
                }
            )
        features.release()
        return rows

    @staticmethod
    def _events_frame(rows: list[dict]) -> pd.DataFrame:
        events = pd.DataFrame(rows, columns=["symbol", "name", "event_date", "event_value", "price", "market_cap", "avg_traded_value", "pos"])
        return events.sort_values(["event_date", "symbol"], kind="stable").reset_index(drop=True)

    # -- 4. control group

    def control_group(self, data: dict[str, feat.Features], events: pd.DataFrame, samples_per_event=None, seed=None) -> pd.DataFrame:
        """Dates in the same universe and period, passing the same filters, when the event did *not*
        happen: not on an event bar, and not within ``cooldown_days`` of one either side (so the
        run-up to an event isn't counted as "no event"). Sampled at random, reproducibly (``seed``)."""
        self._respec("control_group", samples_per_event=samples_per_event, seed=seed)
        cfg, cooldown = self.spec["control_group"], self.spec["event"]["cooldown_days"]
        columns = ["symbol", "name", "event_date", "event_value", "price", "market_cap", "avg_traded_value", "pos"]
        if not cfg["enabled"] or events.empty:
            return pd.DataFrame(columns=columns)
        by_symbol = events.groupby("symbol")["pos"].apply(list).to_dict()
        pools, symbols = [], []
        for symbol, features in data.items():
            eligible = self._eligible.get(symbol)
            if eligible is None:
                eligible = self._eligible_positions(features)
            candidates = eligible & ~self._event_mask.get(symbol, np.zeros(len(features), dtype=bool))
            for pos in by_symbol.get(symbol, []):
                candidates[max(0, pos - cooldown): pos + cooldown + 1] = False
            found = np.flatnonzero(candidates)
            if found.size:
                pools.append(found)
                symbols.append(symbol)
        if not pools:
            self.warn("no_control", "No dates qualified for a control group.")
            return pd.DataFrame(columns=columns)
        sizes = np.array([p.size for p in pools])
        total = int(sizes.sum())
        wanted = min(total, len(events) * cfg["samples_per_event"], MAX_CONTROL)
        rng = np.random.default_rng(cfg["seed"])
        picks = np.sort(rng.choice(total, size=wanted, replace=False))
        bounds = np.cumsum(sizes)
        which = np.searchsorted(bounds, picks, side="right")
        rows = []
        for pick, k in zip(picks, which):
            symbol = symbols[k]
            pos = int(pools[k][pick - (bounds[k - 1] if k else 0)])
            features = data[symbol]
            rows.append(
                {
                    "symbol": symbol,
                    "name": self.names.get(symbol),
                    "event_date": features.index[pos],
                    "event_value": features.get(self.spec["event"]["conditions"][0]["left"]).iloc[pos],
                    "price": features.get("close").iloc[pos],
                    "market_cap": None,
                    "avg_traded_value": features.get(LIQUIDITY_FEATURE).iloc[pos],
                    "pos": pos,
                }
            )
        for features in data.values():
            features.release()
        return pd.DataFrame(rows, columns=columns)

    # -- 5. measurement

    def measure(self, events: pd.DataFrame, data: dict[str, feat.Features], lookback=None, forward=None, metrics=None) -> pd.DataFrame:
        """Each event's metrics at every observation point, its characteristics there, and what
        happened after it (return, best gain and worst fall over each forward window).

        A point outside the loaded history is blank, never filled from a neighbour.
        """
        self._respec(None, lookback_windows=lookback, forward_windows=forward, metrics=metrics)
        spec = self.spec
        points = offsets(spec)
        out = events.copy()
        if events.empty:
            return out
        columns: dict[str, np.ndarray] = {}

        def put(name: str, i: np.ndarray, values: np.ndarray, kind: str = "number") -> None:
            if name not in columns:
                columns[name] = np.full(len(events), np.nan) if kind == "number" else np.full(len(events), None, dtype=object)
            columns[name][i] = values

        groups = events.groupby("symbol", sort=False)
        # Named apart from the loop's own `n`, `high` and `low` (a symbol's length and prices).
        band_low, band_high = self._measure_band
        for done, (symbol, group) in enumerate(groups):
            if done % 50 == 0:
                self.progress(band_low + int((band_high - band_low) * done / max(groups.ngroups, 1)), self._measure_stage)
            features = data[symbol]
            n = len(features)
            rows = group.index.to_numpy()
            pos = group["pos"].to_numpy(dtype=int)

            def at(series: np.ndarray, offset: int) -> np.ndarray:
                target = pos + offset
                valid = (target >= 0) & (target < n)
                values = np.full(len(pos), np.nan)
                values[valid] = series[target[valid]]
                return values

            for metric in spec["metrics"]:
                series = features.get(metric).to_numpy()
                for offset in points:
                    put(column(metric, offset), rows, at(series, offset))
            for k, condition in enumerate(spec["characteristics"]):
                # A copy: under pandas 3's copy-on-write, to_numpy() can be a read-only view.
                held = feat.evaluate(features, condition).to_numpy(dtype="float64", copy=True)
                known = np.ones(n, dtype=bool)
                for name in feat.condition_features(condition):
                    known &= features.get(name).notna().to_numpy()
                held[~known] = np.nan
                for offset in points:
                    put(f"char_{k}@{offset_key(offset)}", rows, at(held, offset))
            for k, measure in enumerate(spec["measures"]):
                got = msr.measure_symbol(measure, features, pos)
                put(measure_column(k), rows, got["value"])
                put(measure_column(k, "status"), rows, got["status"], kind="text")
                if msr.is_anchored(measure["window"]):
                    dates = np.full(len(pos), None, dtype=object)
                    found = got["start"] >= 0
                    dates[found] = [features.index[s] for s in got["start"][found]]
                    put(measure_column(k, "from"), rows, dates, kind="text")
                    put(measure_column(k, "bars"), rows, got["bars"])
            close = features.get("close").to_numpy()
            high = features.get("high").to_numpy()
            low = features.get("low").to_numpy()
            for window in spec["forward_windows"]:
                ret, gain, fall = (np.full(len(pos), np.nan) for _ in range(3))
                target = pos + window
                ok = (target < n) & (close[pos] > 0)
                if ok.any():
                    p, t = pos[ok], target[ok]
                    # The best high and worst low of the `window` bars after each event: a rolling
                    # window ending at the target bar covers exactly those.
                    best = pd.Series(high).rolling(window, min_periods=1).max().to_numpy()
                    worst = pd.Series(low).rolling(window, min_periods=1).min().to_numpy()
                    ret[ok] = close[t] / close[p] - 1
                    gain[ok] = best[t] / close[p] - 1
                    fall[ok] = worst[t] / close[p] - 1
                put(f"fwd_return_{window}", rows, ret)
                put(f"fwd_max_gain_{window}", rows, gain)
                put(f"fwd_max_drawdown_{window}", rows, fall)
            features.release()
        return pd.concat([out, pd.DataFrame(columns, index=events.index)], axis=1)

    def path(self, events: pd.DataFrame, data: dict[str, feat.Features]) -> dict | None:
        """The typical price path around the event: close as a multiple of the event's close,
        median and quartiles across events, from the earliest observation point to the last."""
        if events.empty:
            return None
        points = offsets(self.spec)
        lo, hi = points[0], points[-1]
        step = max(1, math.ceil((hi - lo) / PATH_POINTS))
        grid = list(range(lo, hi + 1, step))
        if grid[-1] != hi:
            grid.append(hi)
        if 0 not in grid:
            grid = sorted({*grid, 0})
        grid_array = np.array(grid)
        paths = np.full((len(events), len(grid)), np.nan)
        for i, (symbol, pos) in enumerate(zip(events["symbol"], events["pos"])):
            close = data[symbol].get("close").to_numpy()
            target = int(pos) + grid_array
            valid = (target >= 0) & (target < len(close))
            if close[int(pos)] > 0:
                paths[i, valid] = close[target[valid]] / close[int(pos)]
        counts = np.isfinite(paths).sum(axis=0)
        with np.errstate(all="ignore"), warnings.catch_warnings():
            # A column no event reaches (too near the data's ends) is all NaN, which is expected.
            warnings.simplefilter("ignore", RuntimeWarning)
            p25, median, p75 = np.nanpercentile(paths, [25, 50, 75], axis=0)
        return {
            "offsets": grid,
            "median": [_round(v) for v in median],
            "p25": [_round(v) for v in p25],
            "p75": [_round(v) for v in p75],
            "count": [int(c) for c in counts],
        }

    # -- 6. aggregation, and the result

    def analyze(self, measured: pd.DataFrame, control: pd.DataFrame | None = None, data=None, show: bool = True) -> dict:
        """Aggregates the measurements into the Study result and shows it in the app (or prints a
        summary outside it). Returns the result."""
        self.progress(90, "Generating statistics")
        spec = self.spec
        points = offsets(spec)
        control = control if control is not None else pd.DataFrame()
        has_control = not control.empty

        stats, histograms = [], []
        for metric in spec["metrics"]:
            for offset in points:
                name = column(metric, offset)
                ev = measured[name] if name in measured else []
                cv = control[name] if has_control and name in control else []
                stats.append({"metric": metric, "offset": offset, "events": describe(ev), "control": describe(cv) if has_control else None})
                hist = histogram(ev, cv)
                if hist:
                    histograms.append({"metric": metric, "offset": offset, **hist})

        characteristics = []
        for k, condition in enumerate(spec["characteristics"]):
            for offset in points:
                name = f"char_{k}@{offset_key(offset)}"
                characteristics.append(
                    {
                        "index": k,
                        "label": condition["label"],
                        "offset": offset,
                        "events": _share(measured.get(name)),
                        "control": _share(control.get(name)) if has_control else None,
                    }
                )

        forward = []
        for window in spec["forward_windows"]:
            ret = measured.get(f"fwd_return_{window}")
            forward.append(
                {
                    "window": window,
                    "events": {
                        **describe(ret if ret is not None else []),
                        "positive": _share(None if ret is None else _positive(ret)),
                        "max_gain_median": _round(_median(measured.get(f"fwd_max_gain_{window}"))),
                        "max_drawdown_median": _round(_median(measured.get(f"fwd_max_drawdown_{window}"))),
                    },
                    "control": _forward_control(control, window) if has_control else None,
                }
            )

        measures = self._measures_section(measured, control if has_control else None, data or {})

        findings = self._test_differences(measured, control, stats, characteristics, forward, measures) if has_control else []

        max_events = spec["output"]["max_events"]
        table_columns = ["symbol", "name", "event_date", "event_value", "price", "market_cap", "avg_traded_value"]
        table_columns += [column(m, o) for m in spec["metrics"] for o in points]
        for window in spec["forward_windows"]:
            table_columns += [f"fwd_return_{window}", f"fwd_max_gain_{window}", f"fwd_max_drawdown_{window}"]
        table_columns += measure_columns(spec)
        table = measured.reindex(columns=table_columns)
        rows = [[_cell(v) for v in row] for row in table.head(max_events).itertuples(index=False, name=None)]
        if len(measured) > max_events:
            self.warn("events_truncated", f"{len(measured)} events were found; the table holds the first {max_events}. Statistics cover all of them.")

        loaded = data or {}
        # Every series that was loaded, including those dropped for never passing the filters.
        series = self._series_info or {
            s: (f.index[0], f.index[-1], len(f), float(f.bars["close"].iloc[-1])) for s, f in loaded.items() if len(f)
        }
        firsts = [info[0] for info in series.values()]
        lasts = [info[1] for info in series.values()]
        needed_from = pd.Timestamp(fetch_start(spec))
        short = sum(1 for f in firsts if f > needed_from + pd.Timedelta(days=10))
        executed = _dt.datetime.now(_dt.timezone.utc)
        summary = {
            "events": int(len(measured)),
            "unique_symbols": int(measured["symbol"].nunique()) if len(measured) else 0,
            "first_event": _cell(measured["event_date"].min()) if len(measured) else None,
            "last_event": _cell(measured["event_date"].max()) if len(measured) else None,
            "median_price": _round(_median(measured.get("price"))),
            "median_avg_traded_value": _round(_median(measured.get("avg_traded_value"))),
            "median_event_value": _round(_median(measured.get("event_value"))),
            "control_samples": int(len(control)),
            "control_kind": "outcome" if spec["outcome"] is not None else ("random" if has_control else "none"),
            "findings": findings,
            "outcome": self.outcome_counts,
        }
        meta = {
            "executed_at": executed.isoformat(timespec="seconds"),
            "engine_version": ENGINE_VERSION,
            "engine_build": engine_build(),
            "app_version": _app_version(),
            "python_version": platform.python_version(),
            "pandas_version": pd.__version__,
            "data_source": _data_source(series),
            "data_from": _cell(min(firsts)) if firsts else None,
            "data_through": _cell(max(lasts)) if lasts else None,
            "data_version": _data_version(series),
            "symbols_requested": int(self.requested or len(series)),
            "symbols_loaded": len(series),
            "symbols_kept": len(loaded),
            "listings_skipped": int(self.skipped_listings),
            "symbols_failed": len(self.failed),
            "symbols_short_history": short,
            "history_bars_needed": history_bars(spec),
            "elapsed_seconds": round(time.monotonic() - self.started, 1),
            # Seconds per stage, so a slow run says where its time went.
            "timings": dict(self.timings),
        }
        availability = {
            "ohlc": True,
            "volume": True,
            "market_cap": False,
            "sector": False,
            "benchmark": self.benchmark_close is not None,
            "point_in_time_universe": False,
        }
        self.warn(
            "market_cap_unavailable",
            "Market cap is not available from the configured data sources: no event carries a market cap, and none was used to filter.",
        )
        result = {
            "format": RESULT_FORMAT,
            "spec": spec,
            "meta": meta,
            "availability": availability,
            "warnings": self.warnings,
            "summary": summary,
            "offsets": points,
            "events": {"columns": table_columns, "rows": rows, "total": int(len(measured))},
            "stats": stats,
            "characteristics": characteristics,
            "forward": forward,
            "measures": measures,
            "histograms": histograms,
            "path": self.path(measured, loaded) if loaded else None,
            "control_path": self.path(control, loaded) if loaded and has_control else None,
            "failed": [{"symbol": s, "error": e[:200]} for s, e in list(self.failed.items())[:200]],
        }
        self.progress(99, "Storing results")
        if show:
            _show(result)
        self.progress(100, "Complete")
        return result

    def _measures_section(self, measured: pd.DataFrame, control: pd.DataFrame | None, data: dict) -> list[dict]:
        """Each measure summed up across the events (and the comparison group): the spread of its
        values, how many events it could be measured for and why not, the episode lengths of a window
        with a found endpoint, a histogram, and for a condition measure the day-by-day share of events
        where the conditions held."""
        out = []
        for k, measure in enumerate(self.spec["measures"]):
            name = measure_column(k)

            def summary(frame: pd.DataFrame | None) -> dict | None:
                if frame is None:
                    return None
                values = frame[name] if name in frame else []
                statuses = frame[measure_column(k, "status")] if measure_column(k, "status") in frame else []
                return {**msr.describe_censored(values, _round), "status": msr.status_counts(statuses)}

            anchored = msr.is_anchored(measure["window"])
            bars_name = measure_column(k, "bars")
            ev = measured[name] if name in measured else pd.Series(dtype="float64")
            cv = control[name] if control is not None and name in control else pd.Series(dtype="float64")
            finite_ev = pd.to_numeric(ev, errors="coerce").replace([np.inf, -np.inf], np.nan)
            finite_cv = pd.to_numeric(cv, errors="coerce").replace([np.inf, -np.inf], np.nan)
            item = {
                "index": k,
                "label": measure["label"],
                "stat": measure["stat"],
                "events": summary(measured),
                "control": summary(control),
                "window_bars": describe(measured[bars_name]) if anchored and bars_name in measured else None,
                "test": None,
                "histogram": histogram(finite_ev, finite_cv if control is not None else []),
                "timeline": None,
            }
            if measure["stat"] in msr.CONDITION_STATS and data:
                grid = msr.timeline_grid(measure)
                events_share, events_count = msr.timeline(measure, self._groups(measured, data), grid)
                control_share = None
                if control is not None and not control.empty:
                    control_share, _ = msr.timeline(measure, self._groups(control, data), grid)
                item["timeline"] = {
                    "offsets": grid,
                    "events": [_round(v) for v in events_share],
                    "control": [_round(v) for v in control_share] if control_share is not None else None,
                    "count": events_count,
                }
            out.append(item)
        return out

    @staticmethod
    def _groups(frame: pd.DataFrame, data: dict):
        """``(features, positions)`` per symbol of a frame of events, releasing each symbol's features
        once it has been read."""
        if frame.empty:
            return
        for symbol, group in frame.groupby("symbol", sort=False):
            features = data.get(symbol)
            if features is None:
                continue
            yield features, group["pos"].to_numpy(dtype=np.int64)
            features.release()

    def split_by_outcome(self, events: pd.DataFrame, data: dict[str, feat.Features]) -> tuple[pd.DataFrame, pd.DataFrame]:
        """With an ``outcome`` in the spec: the events that went on to gain at least ``min_return``
        within ``window`` bars, and the ones that didn't. An event too recent to know is in neither."""
        outcome = self.spec["outcome"]
        window, target = outcome["window"], outcome["min_return"]
        reached = np.full(len(events), np.nan)
        for i, (symbol, pos) in enumerate(zip(events["symbol"], events["pos"])):
            close = data[symbol].get("close").to_numpy()
            if pos + window < len(close) and close[pos] > 0:
                best = np.nanmax(close[pos + 1: pos + window + 1]) / close[pos] - 1
                reached[i] = 1.0 if best >= target else 0.0
        unknown = int(np.isnan(reached).sum())
        self.outcome_counts = {"met": int((reached == 1).sum()), "not_met": int((reached == 0).sum()), "unknown": unknown}
        if unknown:
            self.warn("outcome_unknown", f"{unknown} events are too recent to know whether they reached the outcome, and are left out of both groups.")
        met = events[reached == 1].reset_index(drop=True)
        missed = events[reached == 0].reset_index(drop=True)
        return met, missed

    def _test_differences(self, measured, control, stats, characteristics, forward, measures=()) -> list[dict]:
        """Tests every comparison of the events with the comparison group, in place: a Mann–Whitney
        test for each measurement, forward return and measure, a two-proportion test for each
        characteristic. The p-values are adjusted together (Benjamini–Hochberg), since a Study makes
        dozens of comparisons and some would look significant by chance. Returns the differences that
        stand out: q < 0.05 and at least a small effect, strongest first."""
        tests: list[dict] = []
        for item in stats:
            name = column(item["metric"], item["offset"])
            result = tests_mod.mann_whitney(measured.get(name, []), control.get(name, []))
            item["test"] = _test_json(result, "effect")
            if item["test"]:
                tests.append({"kind": "metric", "metric": item["metric"], "offset": item["offset"], "test": item["test"]})
        for item in characteristics:
            e, c = item["events"], item["control"] or {}
            result = tests_mod.two_proportions(e["true"], e["count"], c.get("true", 0), c.get("count", 0))
            item["test"] = _test_json(result, "diff")
            if item["test"]:
                tests.append({"kind": "characteristic", "label": item["label"], "offset": item["offset"], "test": item["test"]})
        for item in forward:
            name = f"fwd_return_{item['window']}"
            result = tests_mod.mann_whitney(measured.get(name, []), control.get(name, []))
            item["test"] = _test_json(result, "effect")
            if item["test"]:
                tests.append({"kind": "forward", "window": item["window"], "test": item["test"]})
        for item in measures:
            name = measure_column(item["index"])
            # "never" (conditions that never held in the window) ranks after every number.
            ev, cv = msr.ranked(measured.get(name, []), control.get(name, []))
            result = tests_mod.mann_whitney(ev, cv)
            item["test"] = _test_json(result, "effect")
            if item["test"]:
                tests.append({"kind": "measure", "index": item["index"], "label": item["label"], "test": item["test"]})
        qs = tests_mod.benjamini_hochberg([t["test"]["p"] for t in tests])
        for t, q in zip(tests, qs):
            t["test"]["q"] = _round(q)

        def strength(t: dict) -> float:
            if t["kind"] == "characteristic":
                return abs(t["test"]["diff"] or 0)
            return abs(t["test"]["effect"] or 0)

        notable = [
            t
            for t in tests
            if t["test"]["q"] is not None
            and t["test"]["q"] < FINDING_Q
            and (t["kind"] == "characteristic" or abs(t["test"]["effect"] or 0) >= tests_mod.SMALL)
        ]
        notable.sort(key=strength, reverse=True)
        # One line per measurement: the observation point where it differs most, so the list shows
        # several traits rather than one trait at every point.
        seen, out = set(), []
        for t in notable:
            key = (t["kind"], t["index"]) if t["kind"] == "measure" else (t["kind"], t.get("metric") or t.get("label") or t.get("window"))
            if key not in seen:
                seen.add(key)
                out.append(t)
        return out[:MAX_FINDINGS]

    def run(self) -> dict:
        """Every step, as the spec describes them. What the app's Run Study does."""
        symbols = self.universe()
        rows: list[dict] = []

        def detect(symbol: str, features: feat.Features) -> bool:
            rows.extend(self._detect_symbol(symbol, features))
            # A symbol with no bar that passes the filters in the period can be neither an event nor
            # a control date: its bars needn't be kept.
            return bool(self._eligible[symbol].any())

        data = self.load(symbols, on_symbol=detect)
        events = self._events_frame(rows)
        self.timings["load_and_detect"] = self.timings.pop("load")
        started = time.monotonic()
        if self.spec["outcome"] is not None:
            # The comparison is within the events: those that went on to the outcome against those that didn't.
            events, control = self.split_by_outcome(events, data)
        else:
            control = self.control_group(data, events)
        self._measure_band, self._measure_stage = (75, 84), f"Calculating metrics ({len(events)} events)"
        measured = self.measure(events, data)
        self._measure_band, self._measure_stage = (84, 90), f"Calculating metrics (comparison group, {len(control)} dates)"
        control = self.measure(control, data) if not control.empty else control
        self.timings["measure"] = round(time.monotonic() - started, 1)
        return self.analyze(measured, control, data)


def _median(series) -> float | None:
    if series is None:
        return None
    values = pd.to_numeric(pd.Series(series), errors="coerce").dropna()
    return float(values.median()) if len(values) else None


def _test_json(result: dict | None, key: str) -> dict | None:
    """A test's result for the payload: rounded, with the group sizes, and a q-value filled in later."""
    if result is None:
        return None
    out = {"p": _round(result["p"]), "q": None, "n_events": int(result["n1"]), "n_control": int(result["n2"])}
    if key == "effect":
        out["effect"] = _round(result["effect"])
    else:
        out.update(diff=_round(result["diff"]), low=_round(result["low"]), high=_round(result["high"]))
    return out


def _positive(series: pd.Series) -> pd.Series:
    """1 where a value is above zero, 0 where it isn't, NaN where it is unknown."""
    return series.gt(0).astype("float64").where(series.notna())


def _share(series) -> dict:
    """How many known values are true, of how many are known."""
    if series is None:
        return {"count": 0, "true": 0, "share": None}
    values = pd.to_numeric(pd.Series(series), errors="coerce").dropna()
    count, true = int(len(values)), int((values > 0).sum())
    return {"count": count, "true": true, "share": _round(true / count) if count else None}


def _forward_control(control: pd.DataFrame, window: int) -> dict:
    ret = control.get(f"fwd_return_{window}")
    if ret is None:
        return describe([])
    return {
        **describe(ret),
        "positive": _share(_positive(ret)),
        "max_gain_median": _round(_median(control.get(f"fwd_max_gain_{window}"))),
        "max_drawdown_median": _round(_median(control.get(f"fwd_max_drawdown_{window}"))),
    }


def _app_version() -> str | None:
    try:
        return api.status().get("app")
    except client.ProTradeError:
        return None


def _data_source(series) -> str | None:
    """Where the bars came from, as the app names it: the broker serving Indian market symbols
    ("Zerodha", "FYERS"), not the symbols' namespace — so a run says which broker it read even after
    the user switches. A run outside the app names the namespace."""
    namespaces = sorted({client.canonical_provider(s.split(":", 1)[0]) for s in series})
    try:
        labels = {p["id"]: p.get("label") for p in client.get("/v1/providers")}
    except client.ProTradeError:
        labels = {}
    return ", ".join(labels.get(n) or n for n in namespaces) or None


def _data_version(series: dict[str, tuple]) -> str | None:
    """A fingerprint of the bars studied: which series, their span, length and last close. Two runs
    with the same fingerprint studied the same data."""
    if not series:
        return None
    digest = hashlib.sha256()
    for symbol in sorted(series):
        first, last, count, close = series[symbol]
        digest.update(f"{symbol}|{first:%Y-%m-%d}|{last:%Y-%m-%d}|{count}|{close:.6g}\n".encode())
    return digest.hexdigest()[:16]


def _show(result: dict) -> None:
    title = result["spec"]["name"]
    if results.in_app():
        results._post("study", title[:200], result)
        return
    s = result["summary"]
    print(f"\n{title}")
    if result["spec"].get("question"):
        print(f"  {result['spec']['question']}")
    print(f"  {s['events']} events, {s['unique_symbols']} unique stocks, {s['first_event']} to {s['last_event']}")
    for item in result.get("measures", []):
        e = item["events"]
        measured = sum(e["status"][k] for k in msr.MEASURED)
        print(f"  {item['label']} ({item['stat']}): median {e['median']}  (p25 {e['p25']}, p75 {e['p75']}; measured for {measured} of {s['events']})")
    for item in result["stats"]:
        if item["offset"] < 0 and item["events"]["count"]:
            e = item["events"]
            print(f"  {item['metric']:>24} {_title_case_offset(item['offset']):>6}: median {e['median']}  (p25 {e['p25']}, p75 {e['p75']})")
    for warning in result["warnings"]:
        print(f"  note: {warning['message']}")
    print("  Historical association only: none of this shows that a characteristic caused a move.")


def engine_build() -> str:
    """A fingerprint of the engine's own code, so a run says exactly which engine it was, and one that
    ran an out-of-date copy is plain to see."""
    digest = hashlib.sha256()
    # Every module a Study's numbers depend on: a new one belongs here as well as in client_files.rs.
    for module in (__file__, feat.__file__, msr.__file__, wide.__file__):
        try:
            with open(module, "rb") as f:
                digest.update(f.read().replace(b"\r\n", b"\n"))
        except OSError:
            return "unknown"
    return digest.hexdigest()[:8]


def run_spec(spec: dict) -> dict:
    """Runs a Study Specification from start to finish."""
    return ResearchStudy(spec).run()
