"""Screens: which stocks meet a set of conditions *today*, with the columns asked for.

A screen is the Screener tab's saved document (``src/screener/spec.ts``, whose ``normalizeScreen``
applies the same rules as :func:`normalize_screen` here — keep the two in step; both run the cases
in ``src/screener/fixtures/screen-cases.json``). It is written in the Studies' feature grammar
(``protrade/features.py``), so an RSI here is the same number a Study measures.

Where a Study looks for every day in history its conditions held, a screen judges them on each
symbol's *latest* bar only: ``crosses_above`` means "crossed on the latest bar". Bars come through
the app's local API, which holds them in memory while it is open, so a second screen the same day
fetches nothing.

Filters that today's quote alone decides (:func:`snapshot_decidable`: the day's prices, its gap
and its change from the previous close) are judged first, on one batched quote for the whole
universe, and history is read only for the stocks that pass them.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import pandas as pd

from . import api, client, results
from . import features as feat
from .study import EXCHANGES, LOAD_WORKERS, PROVIDERS, SERIES, UNIVERSE_SOURCES, pick_listings
from . import wide
from .wide import WideFeatures

SCREEN_VERSION = 1
ENGINE_VERSION = "1.0"
RESULT_FORMAT = 1
MAX_FILTERS = 20
MAX_COLUMNS = 30
MAX_SYMBOLS = 10_000
MAX_NAME = 120
# More matches than this are cut after sorting; the result says how many there were.
MAX_ROWS = 5_000
# At least this many bars are loaded, so smoothed features (EMA, RSI, ADX) have settled.
MIN_HISTORY_BARS = 260
# At most this many: what "Keep the market loaded" holds (five years) with room to spare, so a weekly
# or monthly column on a long window reads memory rather than going back to the broker. Such a
# column settles a little less than twice its warm-up, which only touches its first values.
MAX_HISTORY_BARS = 1_200
# A symbol whose latest bar is this many days older than the universe's is left out: it hasn't traded
# (suspended, delisted), and judging it on an old bar would present stale news as today's.
STALE_DAYS = 7
# Features today's quote alone decides: the day's own bar and the previous close, nothing older.
SNAPSHOT_FEATURES = frozenset(
    {"open", "high", "low", "close", "volume", "gap", "gap_up", "gap_down", "return_1", "change_1"}
)
CROSSING = ("crosses_above", "crosses_below")


class ScreenError(ValueError):
    """A screen that can't run as written: the message says what to change."""


def _given(value, default):
    """A field's value, or ``default`` when it is missing or null (as ``??`` reads it in TypeScript)."""
    return default if value is None else value


def _conditions(value, field: str) -> list[dict]:
    items = value if value is not None else []
    if not isinstance(items, list):
        raise ScreenError(f"{field} must be a list of conditions.")
    if len(items) > MAX_FILTERS:
        raise ScreenError(f"{field} can hold at most {MAX_FILTERS} conditions.")
    out = []
    for i, item in enumerate(items):
        try:
            condition = feat.parse_condition(item)
        except feat.FeatureError as e:
            raise ScreenError(f"{field}[{i}]: {e}") from None
        condition.pop("label", None)
        out.append(condition)
    return out


def normalize_screen(spec) -> dict:
    """The screen checked and completed, every feature in its canonical spelling. Raises
    :class:`ScreenError` naming the first problem. The same rules as ``normalizeScreen``."""
    if not isinstance(spec, dict):
        raise ScreenError("A screen is a JSON object.")
    version = _given(spec.get("version"), SCREEN_VERSION)
    if version != SCREEN_VERSION:
        raise ScreenError(f"This app runs version {SCREEN_VERSION} screens, not {version}.")
    name = spec.get("name").strip() if isinstance(spec.get("name"), str) else ""
    if not name:
        raise ScreenError("A screen needs a name.")
    if len(name) > MAX_NAME:
        raise ScreenError(f"A screen's name can be at most {MAX_NAME} characters.")

    u = spec.get("universe") if isinstance(spec.get("universe"), dict) else {}
    source = _given(u.get("source"), "instruments")
    if source not in UNIVERSE_SOURCES:
        raise ScreenError("universe.source must be instruments, watchlist or symbols.")
    provider = _given(u.get("provider"), client.INDIA)
    if isinstance(provider, str):
        provider = client.canonical_provider(provider)
    if provider not in PROVIDERS:
        raise ScreenError("universe.provider must be india.")
    exchanges = _given(u.get("exchanges"), ["NSE"])
    if not isinstance(exchanges, list) or not exchanges or any(e not in EXCHANGES for e in exchanges):
        raise ScreenError("universe.exchanges must list one or more of NSE, BSE.")
    series = _given(u.get("series"), ["EQ"])
    if not isinstance(series, list) or not series or any(x not in SERIES for x in series):
        raise ScreenError("universe.series must list one or more of EQ, BE, SME.")
    watchlist = u.get("watchlist").strip() if isinstance(u.get("watchlist"), str) and u.get("watchlist").strip() else None
    if source == "watchlist" and watchlist is None:
        raise ScreenError("universe.watchlist must name a watchlist.")
    symbols = _given(u.get("symbols"), [])
    if not isinstance(symbols, list) or any(not isinstance(s, str) or ":" not in s for s in symbols):
        raise ScreenError("universe.symbols must be a list of symbols like india:NSE:RELIANCE.")
    if source == "symbols" and not symbols:
        raise ScreenError("universe.symbols needs at least one symbol.")
    if len(symbols) > MAX_SYMBOLS:
        raise ScreenError(f"universe.symbols can hold at most {MAX_SYMBOLS} symbols.")
    max_symbols = u.get("max_symbols")
    if max_symbols is not None:
        if isinstance(max_symbols, bool) or not isinstance(max_symbols, int) or not 1 <= max_symbols <= MAX_SYMBOLS:
            raise ScreenError(f"universe.max_symbols must be a whole number between 1 and {MAX_SYMBOLS}.")

    filters = _conditions(spec.get("filters"), "filters")

    columns_raw = _given(spec.get("columns"), [])
    if not isinstance(columns_raw, list):
        raise ScreenError("columns must be a list of features.")
    if len(columns_raw) > MAX_COLUMNS:
        raise ScreenError(f"columns can hold at most {MAX_COLUMNS} features.")
    columns = []
    for item in columns_raw:
        try:
            key = feat.canonical(item)
        except feat.FeatureError:
            raise ScreenError(f"columns: unknown feature {item!r}.") from None
        if key not in columns:
            columns.append(key)

    out = {
        "version": SCREEN_VERSION,
        "name": name,
        "universe": {
            "source": source,
            "provider": provider,
            "exchanges": list(dict.fromkeys(exchanges)),
            "series": [x for x in SERIES if x in series],
            "watchlist": watchlist,
            "symbols": list(dict.fromkeys(client.canonical_symbol_prefix(s.strip()) for s in symbols)),
            "max_symbols": max_symbols,
        },
        "filters": filters,
        "columns": columns,
        "sort": None,
        "benchmark": None,
    }

    sort = spec.get("sort")
    if sort is not None:
        if not isinstance(sort, dict):
            raise ScreenError("sort must be {column, descending} or null.")
        try:
            column = feat.canonical(sort.get("column", ""))
        except feat.FeatureError:
            raise ScreenError(f"sort.column: unknown feature {sort.get('column')!r}.") from None
        if column not in output_columns(out):
            raise ScreenError(f"sort.column must be one of the screen's columns, and {column} isn't.")
        out["sort"] = {"column": column, "descending": bool(sort.get("descending", True))}

    benchmark = spec.get("benchmark")
    if benchmark is not None and (not isinstance(benchmark, str) or ":" not in benchmark):
        raise ScreenError("benchmark must be a symbol like india:NSE:NIFTY_500, or null.")
    out["benchmark"] = client.canonical_symbol_prefix(benchmark.strip()) if isinstance(benchmark, str) else None
    if out["benchmark"] is None:
        needing = [n for n in output_columns(out) if feat.needs_benchmark(n)]
        if needing:
            raise ScreenError(f"{', '.join(needing)} compare against an index: set a benchmark (e.g. india:NSE:NIFTY_500).")
    return out


def output_columns(spec: dict) -> list[str]:
    """The columns a result has: those asked for, then every feature a filter reads that isn't one
    already, so each match shows why it matched."""
    names = list(spec["columns"])
    for condition in spec["filters"]:
        for name in feat.condition_features(condition):
            if name not in names:
                names.append(name)
    return names


def history_bars(spec: dict) -> int:
    """Bars to load so every column has settled by the latest bar."""
    deepest = max((feat.warmup(n) for n in output_columns(spec)), default=1)
    return min(MAX_HISTORY_BARS, max(MIN_HISTORY_BARS, 2 * deepest + 10))


def fetch_start(spec: dict, today: _dt.date) -> _dt.date:
    """The first date to load, in calendar days (a Study's ratio of trading to calendar days)."""
    return today - _dt.timedelta(days=math.ceil(history_bars(spec) * 365 / 245) + 10)


def engine_build() -> str:
    """A fingerprint of the code a screen's numbers depend on."""
    digest = hashlib.sha256()
    for module in (__file__, feat.__file__, wide.__file__):
        try:
            with open(module, "rb") as f:
                digest.update(f.read().replace(b"\r\n", b"\n"))
        except OSError:
            return "unknown"
    return digest.hexdigest()[:8]


def _progress(pct: int, stage: str) -> None:
    print(f"[progress] {max(0, min(100, int(pct))):3d}% {stage}", flush=True)


def _number(value) -> float | None:
    if value is None:
        return None
    number = float(value)
    return round(number, 6) if math.isfinite(number) else None


def snapshot_decidable(condition: dict) -> bool:
    """Whether a filter can be judged on today's quote alone, with exactly the answer the full
    history would give: every feature it reads is a :data:`SNAPSHOT_FEATURES` one on the daily
    interval. A crossing also needs the day before's value of both sides, which a quote carries only
    for the close, so one qualifies only when it compares the close."""
    names = [feat.canonical(n) for n in feat.condition_features(condition)]
    if not all(feat.interval(n) == "D" and n in SNAPSHOT_FEATURES for n in names):
        return False
    return condition["op"] not in CROSSING or all(n == "close" for n in names)


def snapshot_frames(quotes: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """Each symbol quoted on the session ``quotes`` speak for, as two daily bars: the previous close,
    then the day's quote. That is all a :data:`SNAPSHOT_FEATURES` feature reads, so it is the number
    the full history gives on its latest bar. A symbol with no quote, no previous close, or a quote
    from another day (a suspended stock) is left out, to be judged on its history."""
    session = quotes.attrs.get("session")
    if session is None or not len(quotes):
        return {}
    day = pd.Timestamp(session.date())
    index = pd.DatetimeIndex([day - pd.Timedelta(days=1), day])
    traded_today = quotes["traded"].dt.date == session.date()
    usable = quotes[traded_today & quotes["close"].notna() & quotes["previous_close"].notna()]
    nan = float("nan")
    return {
        symbol: pd.DataFrame(
            {
                "open": [nan, q.open],
                "high": [nan, q.high],
                "low": [nan, q.low],
                "close": [q.previous_close, q.close],
                "volume": [nan, q.volume],
            },
            index=index,
        )
        for symbol, q in usable.iterrows()
    }


def judge(frames: dict[str, pd.DataFrame], spec: dict, benchmark: pd.Series | None = None) -> dict[str, tuple]:
    """Every symbol with bars, judged on its own latest bar: ``(its date, whether it passes the
    filters, whether a filter couldn't be judged there for want of history, its values for
    :func:`output_columns`)``.

    All symbols are computed together (:class:`protrade.wide.WideFeatures`), which gives exactly
    the numbers a per-symbol :class:`protrade.features.Features` would, in a fraction of the time."""
    frames = {s: f for s, f in frames.items() if len(f)}
    if not frames:
        return {}
    w = WideFeatures(frames, benchmark)
    passed = pd.Series(True, index=w.symbols)
    unknown = pd.Series(False, index=w.symbols)
    for condition in spec["filters"]:
        holds = feat.evaluate(w, condition).iloc[-1].astype(bool)
        blank = pd.Series(False, index=w.symbols)
        for name in feat.condition_features(condition):
            blank |= w.get(name).iloc[-1].isna()
        unknown |= ~holds & blank
        passed &= holds
    names = output_columns(spec)
    latest = {name: w.get(name).iloc[-1] for name in names}
    dates = w.latest_dates()
    return {
        s: (dates[s], bool(passed[s]), bool(unknown[s]), [_number(latest[name][s]) for name in names])
        for s in w.symbols
    }


class Screen:
    """One run of a screen. :meth:`run` is what the Screener tab's Run does."""

    def __init__(self, spec: dict, progress: bool = True):
        self.spec = normalize_screen(spec)
        self.show_progress = progress
        self.warnings: list[dict] = []
        self.names: dict[str, str] = {}
        self.failed: dict[str, str] = {}
        # The session today's quotes spoke for, when the pre-filter used them.
        self.quote_day: pd.Timestamp | None = None

    def warn(self, code: str, message: str) -> None:
        if not any(w["code"] == code for w in self.warnings):
            self.warnings.append({"code": code, "message": message})
            if not results.in_app():
                print(f"warning: {message}", file=sys.stderr)

    def progress(self, pct: int, stage: str) -> None:
        if self.show_progress:
            _progress(pct, stage)

    def universe(self) -> list[str]:
        """The symbols screened: a broker's instrument list (stocks only), a watchlist, or a list."""
        u = self.spec["universe"]
        self.progress(1, "Reading the universe")
        if u["source"] == "symbols":
            chosen = list(u["symbols"])
        elif u["source"] == "watchlist":
            rows = client.get("/v1/watchlist", name=u["watchlist"])["symbols"]
            chosen = []
            for row in rows:
                if client.canonical_provider(row["symbol"].split(":", 1)[0]) in PROVIDERS:
                    symbol = client.canonical_symbol_prefix(row["symbol"])
                    chosen.append(symbol)
                    if row.get("name"):
                        self.names[symbol] = row["name"]
            if len(chosen) < len(rows):
                self.warn("watchlist_other", f"{len(rows) - len(chosen)} symbols on the watchlist aren't Indian market symbols and were left out.")
            if not chosen:
                raise client.NotFoundError(f"The watchlist {u['watchlist']!r} has no Indian market symbols on it.")
        else:
            rows = []
            for exchange in u["exchanges"]:
                listed = api.instruments(u["provider"], exchange=exchange, kind="EQUITY", limit=50_000)
                rows += list(zip(listed["symbol"], listed["name"]))
            picked = pick_listings(rows, u["series"])
            chosen = [symbol for symbol, _ in picked]
            self.names.update({symbol: name for symbol, name in picked if name})
            if not chosen:
                raise client.NotFoundError(
                    f"The broker's instrument list has no equities for {', '.join(u['exchanges'])}. "
                    "Open Data providers and update the instrument list."
                )
            if len(u["exchanges"]) > 1:
                self.warn("dual_listing", "A stock listed on more than one exchange is screened once, on the first exchange named.")
        chosen = list(dict.fromkeys(chosen))
        if u["max_symbols"] is not None and len(chosen) > u["max_symbols"]:
            chosen = chosen[: u["max_symbols"]]
            self.warn("sampled_universe", f"Only the first {u['max_symbols']} symbols of the universe were screened.")
        return chosen

    def _fetch(self, symbols: list[str], start, started: float) -> dict[str, pd.DataFrame]:
        """Daily bars for the symbols the store didn't hold, a request each: first the quote top-up
        (one batched call brings an already-held symbol's latest bar up to date), then a pool kept
        busy at the broker's pace. A failure is recorded and that symbol left out."""
        if not symbols:
            return {}
        topup = api._top_up(symbols, start=start)
        if topup:
            ready = topup["current"] + topup["updated"]
            if ready:
                self.progress(2, f"{ready} of {len(symbols)} symbols already up to date")
        out: dict[str, pd.DataFrame] = {}
        total, done, last_report = len(symbols), 0, 0.0
        pool = ThreadPoolExecutor(max_workers=LOAD_WORKERS)
        try:
            futures = {pool.submit(api.bars, s, "D", start=start, naive=True): s for s in symbols}
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
                if frame is not None and len(frame):
                    out[symbol] = frame
                now = time.monotonic()
                if now - last_report >= 1.0 or done == total:
                    last_report = now
                    line = f"Loading ({done}/{total})"
                    pace = api._pace(done, total, now - started)
                    if pace:
                        line += f" · {pace[0]:.1f}/s, about {api._duration(pace[1])} left"
                    self.progress(2 + int(93 * done / max(total, 1)), line)
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
        return out

    def _prefilter(self, symbols: list[str]) -> tuple[dict[str, pd.DataFrame], set[str]]:
        """Judges the filters today's quote decides, on one batched quote for every symbol. Returns
        the two-bar frames of the symbols that passed and the symbols it ruled out. Best-effort, like
        the quote top-up: before the session opens, without a quote, or if anything fails, it rules
        nothing out and every symbol is read in full."""
        quick = [c for c in self.spec["filters"] if snapshot_decidable(c)]
        if not quick or len(symbols) < 2 or os.environ.get(client.NO_SNAPSHOT_ENV):
            return {}, set()
        self.progress(1, "Checking today's quotes")
        try:
            quotes = api.snapshot(symbols)
        except client.ProTradeError:
            return {}, set()
        frames = snapshot_frames(quotes)
        if frames:
            self.quote_day = pd.Timestamp(quotes.attrs["session"].date())
        judged = judge(frames, {**self.spec, "filters": quick, "columns": []})
        ruled_out = {s for s, (_, passed, _, _) in judged.items() if not passed}
        return {s: f for s, f in frames.items() if s not in ruled_out}, ruled_out

    def run(self, today: _dt.date | None = None) -> dict:
        started = time.monotonic()
        spec = self.spec
        today = today or _dt.date.today()
        everything = self.universe()
        start = fetch_start(spec, today)

        # Today's quote rules out what it can; if it decides every filter and column, the stocks that
        # pass need no history either. Only the rest are read in full.
        passed_quote, ruled_out = self._prefilter(everything)
        quick_only = all(snapshot_decidable(c) for c in spec["filters"]) and all(
            feat.interval(n) == "D" and feat.canonical(n) in SNAPSHOT_FEATURES for n in output_columns(spec)
        )
        loaded = judge(passed_quote, spec) if quick_only else {}
        symbols = [s for s in everything if s not in ruled_out and s not in loaded]
        if ruled_out:
            self.progress(2, f"{len(ruled_out)} of {len(everything)} symbols ruled out by today's quote")
            self.warn(
                "prefiltered",
                f"{len(ruled_out)} symbols were ruled out on today's quote alone, without reading their history.",
            )

        # What the app holds in memory up to the latest session comes in one read; only the rest is
        # topped up and fetched symbol by symbol.
        frames_by_symbol, missing = api._from_panel(symbols, start, None, None, naive=True)
        if frames_by_symbol:
            self.progress(2, f"{len(frames_by_symbol)} of {len(symbols)} symbols already loaded")

        benchmark = None
        if spec["benchmark"] and symbols:
            try:
                benchmark = api.bars(spec["benchmark"], "D", start=start, naive=True)["close"]
            except client.FATAL:
                raise
            except client.ProTradeError as e:
                self.warn("benchmark_missing", f"The benchmark {spec['benchmark']} couldn't be loaded ({e}); relative strength is blank.")

        total = len(everything)
        frames_by_symbol.update(self._fetch(missing, start, started))

        self.progress(96, f"Screening {len(frames_by_symbol) + len(loaded)} symbols")
        loaded.update(judge(frames_by_symbol, spec, benchmark))

        if self.failed:
            self.warn("load_failed", f"{len(self.failed)} of {total} symbols couldn't be loaded and are left out.")
        if not loaded and not ruled_out:
            raise client.NotFoundError("No symbol in the universe had any daily data to screen.")

        # The day the screen describes is the newest bar it saw, and the quotes' session counts too:
        # otherwise, with every current stock ruled out by its quote, a suspended one would set it.
        seen = [last for last, *_ in loaded.values()]
        if self.quote_day is not None:
            seen.append(self.quote_day)
        as_of = max(seen)
        cutoff = as_of - pd.Timedelta(days=STALE_DAYS)
        matches, stale, unknown = [], 0, 0
        for symbol, (last, passed, not_judged, values) in loaded.items():
            if last < cutoff:
                stale += 1
                continue
            unknown += not_judged
            if passed:
                matches.append({"symbol": symbol, "name": self.names.get(symbol), "date": f"{last:%Y-%m-%d}", "values": values})
        if stale:
            self.warn("stale", f"{stale} symbols have no bar in the week before {as_of:%Y-%m-%d} (suspended or delisted) and were left out.")
        if unknown:
            self.warn("short_history", f"{unknown} symbols have too little history for a filter to be judged, so they don't match.")

        columns = output_columns(spec)
        matches.sort(key=lambda row: row["symbol"])
        if spec["sort"]:
            k = columns.index(spec["sort"]["column"])
            known = [r for r in matches if r["values"][k] is not None]
            blank = [r for r in matches if r["values"][k] is None]
            known.sort(key=lambda r: r["values"][k], reverse=spec["sort"]["descending"])
            matches = known + blank
        matched = len(matches)
        if matched > MAX_ROWS:
            matches = matches[:MAX_ROWS]
            self.warn("truncated", f"{matched} stocks matched; the first {MAX_ROWS} are shown.")

        self.progress(100, "Complete")
        return {
            "format": RESULT_FORMAT,
            "spec": spec,
            "columns": columns,
            "rows": matches,
            "meta": {
                "engine_version": ENGINE_VERSION,
                "engine_build": engine_build(),
                "executed_at": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "seconds": round(time.monotonic() - started, 1),
                "as_of": f"{as_of:%Y-%m-%d}",
                "symbols_requested": total,
                "symbols_loaded": len(loaded) + len(ruled_out),
                "prefiltered": len(ruled_out),
                "symbols_failed": len(self.failed),
                "symbols_stale": stale,
                "matched": matched,
            },
            "warnings": self.warnings,
        }


def run_screen(spec: dict) -> dict:
    """Runs a screen and shows it: in the app's Screener tab, or printed in a terminal."""
    result = Screen(spec).run()
    if results.in_app():
        results._post("screen", result["spec"]["name"][:200], result)
    else:
        _print(result)
    return result


def _print(result: dict) -> None:
    meta = result["meta"]
    print(f"\n{result['spec']['name']}: {meta['matched']} of {meta['symbols_loaded']} matched (as of {meta['as_of']})")
    frame = pd.DataFrame([r["values"] for r in result["rows"]], columns=result["columns"], index=[r["symbol"] for r in result["rows"]])
    if len(frame):
        print(frame.to_string(max_rows=50))
    for warning in result["warnings"]:
        print(f"  note: {warning['message']}")
