"""Tests for screens: the shared validation cases, judging the latest bar, and a whole run against a
stub of the app."""

import copy
import datetime as dt
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

from support import Case, ms, panel_bytes  # noqa: E402  (also puts the package on the path)

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from protrade import features as feat, run_screen, screen  # noqa: E402

FIXTURES = os.path.join(os.path.dirname(__file__), "..", "..", "src", "screener", "fixtures")
CASES_PATH = os.path.join(FIXTURES, "screen-cases.json")
# Real engine output, which src/screener/result.test.ts parses. Regenerate it with
# `PROTRADE_WRITE_FIXTURE=1 python -m unittest discover -s python/tests -p test_screen.py` when the shape changes.
RESULT_PATH = os.path.join(FIXTURES, "engine-result.json")
# What differs from one run to the next.
VOLATILE = ("executed_at", "seconds", "engine_build")
DAYS = pd.bdate_range("2023-01-02", "2025-06-30")
TODAY = dt.date(2025, 7, 1)


def load_cases() -> dict:
    with open(CASES_PATH, encoding="utf-8") as f:
        return json.load(f)


def expand(value):
    """The placeholders screen-cases.json uses for lists too long to write out (spec.test.ts expands
    them the same way)."""
    if value == "TWENTY_ONE_FILTERS":
        return [{"left": "rsi_14", "op": "<", "right": 30}] * 21
    if value == "THIRTY_ONE_COLUMNS":
        return [f"sma_{n}" for n in range(1, 32)]
    if isinstance(value, dict):
        return {k: expand(v) for k, v in value.items()}
    return value


def patched(base: dict, patch: dict) -> dict:
    spec = copy.deepcopy(base)
    spec.update(expand(copy.deepcopy(patch)))
    return spec


class SharedCaseTests(unittest.TestCase):
    """The same cases src/screener/spec.test.ts runs against normalizeScreen."""

    def test_refused_cases_are_refused_with_their_reason(self):
        cases = load_cases()
        for case in cases["refused"]:
            with self.subTest(patch=case["patch"]):
                with self.assertRaises(screen.ScreenError) as caught:
                    screen.normalize_screen(patched(cases["base"], case["patch"]))
                self.assertIn(case["word"], str(caught.exception))

    def test_accepted_cases_normalise_exactly(self):
        cases = load_cases()
        for case in cases["accepted"]:
            with self.subTest(about=case["about"]):
                self.assertEqual(screen.normalize_screen(patched(cases["base"], case["patch"])), case["expect"])

    def test_the_base_itself_is_valid(self):
        screen.normalize_screen(load_cases()["base"])


def spec(**changes):
    base = {
        "name": "Above the 50 EMA",
        "universe": {"source": "instruments", "provider": "india", "exchanges": ["NSE"]},
        "filters": [{"left": "close", "op": ">", "right": "ema_50"}],
        "columns": ["close", "return_1"],
        "sort": {"column": "return_1", "descending": True},
    }
    base.update(changes)
    return base


def frame_of(closes, volume=1e5):
    return pd.DataFrame(
        {"open": closes, "high": closes * 1.01, "low": closes * 0.99, "close": closes, "volume": volume}, index=closes.index
    )


def body(symbol, closes, volume=1e5):
    return {
        "symbol": symbol,
        "interval": "D",
        "timezone": "Asia/Kolkata",
        "count": len(closes),
        "t": [ms(f"{d:%Y-%m-%d}") for d in closes.index],
        "o": list(closes.to_numpy()),
        "h": list(closes.to_numpy() * 1.01),
        "l": list(closes.to_numpy() * 0.99),
        "c": list(closes.to_numpy()),
        "v": [volume] * len(closes),
        "coveredFrom": ms(f"{closes.index[0]:%Y-%m-%d}") if len(closes) else 0,
        "coveredTo": ms(f"{closes.index[-1]:%Y-%m-%d}") if len(closes) else 0,
        "limitedFrom": None,
    }


def latest(frame, s):
    """One symbol's (passed, not judged, values), as a whole run judges it."""
    return screen.judge({"india:NSE:X": frame}, s)["india:NSE:X"][1:]


class LatestBarTests(unittest.TestCase):
    def test_filters_are_judged_on_the_latest_bar_only(self):
        s = screen.normalize_screen(spec())
        rising = pd.Series(np.linspace(100, 200, len(DAYS)), index=DAYS)
        passed, unknown, values = latest(frame_of(rising), s)
        self.assertTrue(passed)
        self.assertFalse(unknown)
        self.assertEqual(screen.output_columns(s), ["close", "return_1", "ema_50"])
        self.assertEqual(values[0], 200.0)
        # Above its EMA for most of history but not on the last bar: no match.
        dipped = rising.copy()
        dipped.iloc[-1] = 120.0
        self.assertFalse(latest(frame_of(dipped), s)[0])

    def test_a_cross_means_it_crossed_on_the_latest_bar(self):
        s = screen.normalize_screen(spec(filters=[{"left": "close", "op": "crosses_above", "right": 150}]))
        closes = pd.Series(100.0, index=DAYS[:60])
        closes.iloc[-1] = 160.0
        self.assertTrue(latest(frame_of(closes), s)[0])
        closes.iloc[-2] = 160.0  # crossed the day before: not today's news
        self.assertFalse(latest(frame_of(closes), s)[0])

    def test_too_little_history_is_no_match_and_is_said(self):
        s = screen.normalize_screen(spec(filters=[{"left": "close", "op": ">", "right": "sma_200"}]))
        short = pd.Series(np.linspace(100, 200, 50), index=DAYS[:50])
        passed, unknown, values = latest(frame_of(short), s)
        self.assertFalse(passed)
        self.assertTrue(unknown)
        self.assertIsNone(values[screen.output_columns(s).index("sma_200")])

    def test_history_is_deep_enough_for_the_slowest_column(self):
        s = screen.normalize_screen(spec(columns=["ema_200", "slope_sma_200"], sort=None))
        self.assertEqual(screen.history_bars(s), 2 * (200 + feat.SLOPE_BARS) + 10)
        self.assertEqual(screen.history_bars(screen.normalize_screen(spec(filters=[], columns=["close"], sort=None))), screen.MIN_HISTORY_BARS)


SERIES = {
    "india:NSE:UP": pd.Series(np.linspace(100, 300, len(DAYS)), index=DAYS),
    "india:NSE:FAST": pd.Series(np.concatenate([np.linspace(100, 200, len(DAYS) - 1), [260.0]]), index=DAYS),
    "india:NSE:DOWN": pd.Series(np.linspace(300, 100, len(DAYS)), index=DAYS),
    # Stopped trading a month before the others: never judged on its old bar.
    "india:NSE:HALTED": pd.Series(np.linspace(100, 300, len(DAYS) - 22), index=DAYS[:-22]),
}


def bars_route(query):
    closes = SERIES.get(query["symbol"])
    if closes is None:
        return 404, {"error": {"code": "not_found", "message": "unknown symbol"}}
    # Everything, whatever the start: the series end in the past, and a run asks from today.
    return 200, body(query["symbol"], closes)


def sync_route(payload):
    return 200, {"results": [{"symbol": s, "status": "current", "reason": None} for s in payload["symbols"]]}


class RunTests(Case):
    routes = {
        "/v1/ping": lambda q: (200, {"ok": True, "api": 1, "app": "9.9.9"}),
        "/v1/instruments": lambda q: (
            200,
            [
                {"symbol": s, "name": s.split(":")[-1].title(), "exchange": "NSE", "kind": "EQUITY", "expiry": None}
                for s in [*SERIES, "india:NSE:GONE", "india:NSE:SGBAUG28V-GB"]
            ],
        ),
        "/v1/bars": bars_route,
    }
    posts = {"/v1/results": lambda payload: (200, {"ok": True}), "/v1/bars/sync": sync_route}
    run_id = "run-7"

    def test_a_screen_file_runs_and_posts_its_matches_sorted(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "screen.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(spec(), f)
            out = io.StringIO()
            with redirect_stdout(out), redirect_stderr(io.StringIO()):
                code = run_screen.main(["run_screen", path])
        self.assertEqual(code, 0)
        self.assertIn("[progress] 100% Complete", out.getvalue())
        self.assertIn(f"[engine] protrade screen {screen.ENGINE_VERSION} ({screen.engine_build()})", out.getvalue())
        posted = self.stub.posted("/v1/results")
        self.assertEqual(len(posted), 1)
        self.assertEqual((posted[0]["runId"], posted[0]["kind"], posted[0]["title"]), ("run-7", "screen", "Above the 50 EMA"))
        data = posted[0]["data"]
        self.assertEqual(data["columns"], ["close", "return_1", "ema_50"])
        # The day's biggest gainer first; the falling stock and the halted one don't match.
        self.assertEqual([r["symbol"] for r in data["rows"]], ["india:NSE:FAST", "india:NSE:UP"])
        self.assertEqual(data["rows"][0]["name"], "Fast")
        self.assertEqual(data["rows"][0]["date"], "2025-06-30")
        self.assertEqual(data["rows"][0]["values"][0], 260.0)
        meta = data["meta"]
        self.assertEqual(meta["as_of"], "2025-06-30")
        self.assertEqual(
            (meta["symbols_requested"], meta["symbols_loaded"], meta["symbols_failed"], meta["symbols_stale"], meta["matched"]),
            (5, 4, 1, 1, 2),
        )
        self.assertEqual({w["code"] for w in data["warnings"]}, {"load_failed", "stale"})
        # A bond on the equity list is never fetched.
        fetched = {r["query"]["symbol"] for r in self.stub.requests if r["path"] == "/v1/bars"}
        self.assertNotIn("india:NSE:SGBAUG28V-GB", fetched)

    def test_the_universe_is_offered_for_a_quote_top_up_before_the_historical_fetch(self):
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(io.StringIO()):
            screen.Screen(spec()).run(today=TODAY)
        synced = self.stub.posted("/v1/bars/sync")
        self.assertEqual(len(synced), 1)
        self.assertEqual(set(synced[0]["symbols"]), set(SERIES) | {"india:NSE:GONE"}, "the bond is never offered either")
        self.assertEqual(synced[0]["interval"], "D")
        self.assertIn("already up to date", out.getvalue())

    def test_symbols_the_market_data_store_holds_are_read_in_one_go_with_the_same_result(self):
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            before = screen.Screen(spec()).run(today=TODAY)
        self.stub.requests.clear()
        held = {s for s in SERIES if s != "india:NSE:DOWN"}
        self.stub.posts["/v1/panel"] = lambda p: (
            200,
            panel_bytes([(s, body(s, SERIES[s]) if s in held else None, s in held) for s in p["symbols"]]),
        )
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            after = screen.Screen(spec()).run(today=TODAY)
        fetched = {r["query"]["symbol"] for r in self.stub.requests if r["path"] == "/v1/bars"}
        self.assertEqual(fetched, {"india:NSE:DOWN", "india:NSE:GONE"}, "only what the store lacks")
        self.assertEqual(set(self.stub.posted("/v1/bars/sync")[0]["symbols"]), {"india:NSE:DOWN", "india:NSE:GONE"})
        for key in ("rows", "columns", "warnings"):
            self.assertEqual(after[key], before[key], key)
        for key in ("symbols_requested", "symbols_loaded", "symbols_failed", "symbols_stale", "matched", "as_of"):
            self.assertEqual(after["meta"][key], before["meta"][key], key)

    def test_a_missing_or_broken_sync_route_does_not_stop_the_run(self):
        del self.stub.posts["/v1/bars/sync"]  # as an app build without the route would 404
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            data = screen.Screen(spec()).run(today=TODAY)
        self.assertEqual(data["meta"]["matched"], 2, "the ordinary per-symbol fetch still ran")

    def test_matches_past_the_cap_are_cut_after_sorting(self):
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            old = screen.MAX_ROWS
            screen.MAX_ROWS = 1
            try:
                data = screen.Screen(spec()).run(today=TODAY)
            finally:
                screen.MAX_ROWS = old
        self.assertEqual([r["symbol"] for r in data["rows"]], ["india:NSE:FAST"])
        self.assertEqual(data["meta"]["matched"], 2)
        self.assertIn("truncated", {w["code"] for w in data["warnings"]})

    def test_the_fetch_reaches_back_far_enough(self):
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            screen.Screen(spec(columns=["ema_200"], sort=None)).run(today=TODAY)
        starts = [int(r["query"]["from"]) for r in self.stub.requests if r["path"] == "/v1/bars"]
        self.assertLessEqual(max(starts), ms(f"{screen.fetch_start(screen.normalize_screen(spec(columns=['ema_200'], sort=None)), TODAY)}"))
        self.assertLessEqual(max(starts), ms("2024-01-01"))

    def test_the_result_is_the_shape_the_app_parses(self):
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            data = screen.Screen(spec()).run(today=TODAY)
        data = json.loads(json.dumps(data))
        for key in VOLATILE:
            data["meta"][key] = None
        if os.environ.get("PROTRADE_WRITE_FIXTURE"):
            with open(RESULT_PATH, "w", encoding="utf-8", newline="\n") as f:
                json.dump(data, f, indent=2)
                f.write("\n")
        with open(RESULT_PATH, encoding="utf-8") as f:
            fixture = json.load(f)
        self.assertEqual(data, fixture, "the engine's result changed: regenerate src/screener/fixtures/engine-result.json")

    def test_a_problem_the_user_can_fix_is_said_without_a_traceback(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "screen.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(spec(columns=["rs_126"], sort=None), f)
            err = io.StringIO()
            with redirect_stdout(io.StringIO()), redirect_stderr(err):
                code = run_screen.main(["run_screen", path])
        self.assertEqual(code, 1)
        self.assertIn("Screen stopped:", err.getvalue())
        self.assertNotIn("Traceback", err.getvalue())


# ---- The quote pre-filter ---------------------------------------------------------------------


def quotes_of(series, session="2025-06-30"):
    """What `/v1/snapshot` answers for `series` ({symbol: frame}): each symbol's last bar as today's
    quote, traded on that bar's own day, with the bar before as its previous close."""

    def answer(payload):
        rows = []
        for symbol in payload["symbols"]:
            frame = series.get(symbol)
            if frame is None or len(frame) < 2:
                rows.append({"symbol": symbol, "open": None, "high": None, "low": None, "last": None,
                             "previousClose": None, "volume": None, "tradedAt": None})
                continue
            last, prev = frame.iloc[-1], frame.iloc[-2]
            rows.append(
                {
                    "symbol": symbol,
                    "open": float(last["open"]),
                    "high": float(last["high"]),
                    "low": float(last["low"]),
                    "last": float(last["close"]),
                    "previousClose": float(prev["close"]),
                    "volume": float(last["volume"]),
                    "tradedAt": ms(f"{frame.index[-1]:%Y-%m-%d} 15:29"),
                }
            )
        return 200, {"sessionDay": ms(session) if session else None, "snapshots": rows}

    return answer


class SnapshotRuleTests(unittest.TestCase):
    def test_only_filters_a_quote_decides_exactly_qualify(self):
        decidable = [
            {"left": "close", "op": ">", "right": 100},
            {"left": "return_1d", "op": ">", "right": 0.03},
            {"left": "gap", "op": "between", "right": [0.01, 0.05]},
            {"left": "volume", "op": ">", "right": "open"},
            {"left": "close", "op": "crosses_above", "right": 150},
        ]
        not_decidable = [
            {"left": "close", "op": ">", "right": "ema_50"},
            {"left": "return_5", "op": ">", "right": 0.1},
            {"left": "close@W", "op": ">", "right": 100},
            # Yesterday's volume isn't in a quote, so it can't say whether volume *crossed*.
            {"left": "volume", "op": "crosses_above", "right": 1e6},
            {"left": "return_1", "op": "crosses_above", "right": 0},
        ]
        for c in decidable:
            self.assertTrue(screen.snapshot_decidable(feat.parse_condition(c)), c)
        for c in not_decidable:
            self.assertFalse(screen.snapshot_decidable(feat.parse_condition(c)), c)

    def test_a_quote_from_another_session_or_without_a_previous_close_is_left_to_history(self):
        session = pd.Timestamp("2025-06-30", tz="Asia/Kolkata")
        quotes = pd.DataFrame(
            {
                "open": [10.0, 20.0, 30.0],
                "high": [11.0, 21.0, 31.0],
                "low": [9.0, 19.0, 29.0],
                "close": [10.5, 20.5, 30.5],
                "previous_close": [10.0, float("nan"), 30.0],
                "volume": [1.0, 2.0, 3.0],
                "traded": pd.to_datetime(["2025-06-30 15:29", "2025-06-30 15:29", "2025-06-20 15:29"]).tz_localize("Asia/Kolkata"),
            },
            index=["india:NSE:A", "india:NSE:NOPREV", "india:NSE:SUSPENDED"],
        )
        quotes.attrs["session"] = session
        frames = screen.snapshot_frames(quotes)
        self.assertEqual(list(frames), ["india:NSE:A"])
        self.assertEqual(list(frames["india:NSE:A"]["close"]), [10.0, 10.5])
        self.assertEqual(frames["india:NSE:A"].index[-1], pd.Timestamp("2025-06-30"))
        quotes.attrs["session"] = None
        self.assertEqual(screen.snapshot_frames(quotes), {}, "pre-open: no quote is a day's bar")


def random_series(seed: int, n_symbols: int = 14) -> dict:
    """Random daily bars for a universe, ending together on DAYS[-1]: random walks with gaps and
    volumes that vary, so quote filters split the universe a different way each time."""
    rng = np.random.default_rng(seed)
    out = {}
    for i in range(n_symbols):
        n = len(DAYS) if i % 7 else len(DAYS) - 30  # one in seven stopped trading a while ago
        close = 100 * np.exp(np.cumsum(rng.normal(0, 0.02, n)))
        opened = np.concatenate([[close[0]], close[:-1]]) * np.exp(rng.normal(0, 0.01, n))
        out[f"india:NSE:S{i:02d}"] = pd.DataFrame(
            {
                "open": opened,
                "high": np.maximum(opened, close) * 1.01,
                "low": np.minimum(opened, close) * 0.99,
                "close": close,
                "volume": rng.integers(1_000, 100_000, n).astype(float),
            },
            index=DAYS[:n],
        )
    return out


def frame_body(symbol, frame):
    return {
        "symbol": symbol,
        "interval": "D",
        "timezone": "Asia/Kolkata",
        "count": len(frame),
        "t": [ms(f"{d:%Y-%m-%d}") for d in frame.index],
        "o": list(frame["open"]),
        "h": list(frame["high"]),
        "l": list(frame["low"]),
        "c": list(frame["close"]),
        "v": list(frame["volume"]),
        "coveredFrom": ms(f"{frame.index[0]:%Y-%m-%d}"),
        "coveredTo": ms(f"{frame.index[-1]:%Y-%m-%d}"),
        "limitedFrom": None,
    }


QUICK = [
    lambda r: {"left": "close", "op": ">", "right": float(r.uniform(60, 160))},
    lambda r: {"left": "return_1", "op": ">", "right": float(r.uniform(-0.02, 0.02))},
    lambda r: {"left": "change_1", "op": "<", "right": float(r.uniform(-1, 1))},
    lambda r: {"left": "gap", "op": "between", "right": [float(r.uniform(-0.02, 0)), float(r.uniform(0, 0.02))]},
    lambda r: {"left": "gap_up", "op": ">", "right": 0},
    lambda r: {"left": "volume", "op": ">", "right": float(r.uniform(10_000, 90_000))},
    lambda r: {"left": "close", "op": ">", "right": "open"},
    lambda r: {"left": "high", "op": "<", "right": float(r.uniform(80, 200))},
    lambda r: {"left": "close", "op": "crosses_above", "right": float(r.uniform(80, 140))},
]
SLOW = [
    lambda r: {"left": "close", "op": ">", "right": "sma_20"},
    lambda r: {"left": "rsi_14", "op": "<", "right": float(r.uniform(40, 80))},
    lambda r: {"left": "return_5", "op": ">", "right": float(r.uniform(-0.05, 0.05))},
    lambda r: {"left": "volume", "op": "crosses_above", "right": float(r.uniform(20_000, 80_000))},
]


class PrefilterTests(Case):
    """The pre-filter only saves work: a run with it and one without give exactly the same screen."""

    run_id = None

    def setUp(self):
        super().setUp()
        self.series = {}
        self.stub.routes.update(
            {
                "/v1/ping": lambda q: (200, {"ok": True, "api": 1, "app": "9.9.9"}),
                "/v1/bars": lambda q: (200, frame_body(q["symbol"], self.series[q["symbol"]]))
                if q["symbol"] in self.series
                else (404, {"error": {"code": "not_found", "message": "unknown symbol"}}),
            }
        )
        self.stub.posts.update(
            {
                "/v1/snapshot": lambda p: quotes_of(self.series)(p),
                "/v1/bars/sync": sync_route,
            }
        )

    def run_both(self, spec_):
        spec_ = {**spec_, "universe": {"source": "symbols", "symbols": list(self.series)}}
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            fast = screen.Screen(spec_).run(today=TODAY)
            os.environ["PROTRADE_NO_SNAPSHOT"] = "1"
            try:
                full = screen.Screen(spec_).run(today=TODAY)
            finally:
                os.environ.pop("PROTRADE_NO_SNAPSHOT")
        return fast, full

    def test_random_screens_match_exactly_with_and_without_the_prefilter(self):
        rng = np.random.default_rng(7)
        used = 0
        for trial in range(40):
            self.series = random_series(1000 + trial)
            filters = [QUICK[i](rng) for i in rng.choice(len(QUICK), size=rng.integers(1, 3), replace=False)]
            filters += [SLOW[i](rng) for i in rng.choice(len(SLOW), size=rng.integers(0, 3), replace=False)]
            columns = ["close", "return_1"] if trial % 2 else ["close", "rsi_14"]
            fast, full = self.run_both(spec(filters=filters, columns=columns, sort=None))
            self.assertEqual(fast["rows"], full["rows"], f"trial {trial}: {filters}")
            for key in ("matched", "symbols_requested", "symbols_loaded", "symbols_failed", "symbols_stale", "as_of"):
                self.assertEqual(fast["meta"][key], full["meta"][key], f"trial {trial} {key}: {filters}")
            self.assertEqual(full["meta"]["prefiltered"], 0)
            used += fast["meta"]["prefiltered"] > 0
        self.assertGreater(used, 20, "most trials ruled stocks out on the quote")

    def test_a_screen_the_quote_decides_reads_no_history_for_the_stocks_it_judged(self):
        self.series = random_series(3)
        self.stub.requests.clear()
        fast, full = self.run_both(spec(filters=[{"left": "return_1", "op": ">", "right": 0}], columns=["close"], sort=None))
        self.assertEqual(fast["rows"], full["rows"])
        fetched = {r["query"]["symbol"] for r in self.stub.requests if r["path"] == "/v1/bars"}
        # Only the symbol whose last quote isn't this session's was read in full in the fast run, and
        # every symbol in the full one.
        stopped = {s for s, f in self.series.items() if f.index[-1] != DAYS[-1]}
        self.assertEqual(len(self.stub.posted("/v1/snapshot")), 1)
        self.assertTrue(stopped <= fetched)
        self.assertIn("prefiltered", {w["code"] for w in fast["warnings"]})

    def test_before_the_open_or_without_the_route_nothing_is_ruled_out(self):
        self.series = random_series(5)
        filters = [{"left": "return_1", "op": ">", "right": 0}]
        for answer in (quotes_of(self.series, session=None), lambda p: (404, {"error": {"code": "not_found", "message": "no"}})):
            self.stub.posts["/v1/snapshot"] = answer
            fast, full = self.run_both(spec(filters=filters, columns=["close"], sort=None))
            self.assertEqual(fast["meta"]["prefiltered"], 0)
            self.assertEqual(fast["rows"], full["rows"])

    def test_when_the_quote_rules_everything_out_the_screen_is_empty_not_an_error(self):
        self.series = random_series(9)
        fast, _ = self.run_both(spec(filters=[{"left": "close", "op": ">", "right": 1e9}], columns=["close"], sort=None))
        self.assertEqual(fast["rows"], [])
        self.assertEqual(fast["meta"]["matched"], 0)
        self.assertEqual(fast["meta"]["as_of"], f"{DAYS[-1]:%Y-%m-%d}")


if __name__ == "__main__":
    unittest.main()
