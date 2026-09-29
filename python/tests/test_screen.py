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

from support import Case, ms  # noqa: E402  (also puts the package on the path)

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
        "universe": {"source": "instruments", "provider": "zerodha", "exchanges": ["NSE"]},
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


class LatestBarTests(unittest.TestCase):
    def test_filters_are_judged_on_the_latest_bar_only(self):
        s = screen.normalize_screen(spec())
        rising = pd.Series(np.linspace(100, 200, len(DAYS)), index=DAYS)
        passed, unknown, values = screen.latest(feat.Features(frame_of(rising)), s)
        self.assertTrue(passed)
        self.assertFalse(unknown)
        self.assertEqual(screen.output_columns(s), ["close", "return_1", "ema_50"])
        self.assertEqual(values[0], 200.0)
        # Above its EMA for most of history but not on the last bar: no match.
        dipped = rising.copy()
        dipped.iloc[-1] = 120.0
        self.assertFalse(screen.latest(feat.Features(frame_of(dipped)), s)[0])

    def test_a_cross_means_it_crossed_on_the_latest_bar(self):
        s = screen.normalize_screen(spec(filters=[{"left": "close", "op": "crosses_above", "right": 150}]))
        closes = pd.Series(100.0, index=DAYS[:60])
        closes.iloc[-1] = 160.0
        self.assertTrue(screen.latest(feat.Features(frame_of(closes)), s)[0])
        closes.iloc[-2] = 160.0  # crossed the day before: not today's news
        self.assertFalse(screen.latest(feat.Features(frame_of(closes)), s)[0])

    def test_too_little_history_is_no_match_and_is_said(self):
        s = screen.normalize_screen(spec(filters=[{"left": "close", "op": ">", "right": "sma_200"}]))
        short = pd.Series(np.linspace(100, 200, 50), index=DAYS[:50])
        passed, unknown, values = screen.latest(feat.Features(frame_of(short)), s)
        self.assertFalse(passed)
        self.assertTrue(unknown)
        self.assertIsNone(values[screen.output_columns(s).index("sma_200")])

    def test_history_is_deep_enough_for_the_slowest_column(self):
        s = screen.normalize_screen(spec(columns=["ema_200", "slope_sma_200"], sort=None))
        self.assertEqual(screen.history_bars(s), 2 * (200 + feat.SLOPE_BARS) + 10)
        self.assertEqual(screen.history_bars(screen.normalize_screen(spec(filters=[], columns=["close"], sort=None))), screen.MIN_HISTORY_BARS)


SERIES = {
    "zerodha:NSE:UP": pd.Series(np.linspace(100, 300, len(DAYS)), index=DAYS),
    "zerodha:NSE:FAST": pd.Series(np.concatenate([np.linspace(100, 200, len(DAYS) - 1), [260.0]]), index=DAYS),
    "zerodha:NSE:DOWN": pd.Series(np.linspace(300, 100, len(DAYS)), index=DAYS),
    # Stopped trading a month before the others: never judged on its old bar.
    "zerodha:NSE:HALTED": pd.Series(np.linspace(100, 300, len(DAYS) - 22), index=DAYS[:-22]),
}


def bars_route(query):
    closes = SERIES.get(query["symbol"])
    if closes is None:
        return 404, {"error": {"code": "not_found", "message": "unknown symbol"}}
    # Everything, whatever the start: the series end in the past, and a run asks from today.
    return 200, body(query["symbol"], closes)


class RunTests(Case):
    routes = {
        "/v1/ping": lambda q: (200, {"ok": True, "api": 1, "app": "9.9.9"}),
        "/v1/instruments": lambda q: (
            200,
            [
                {"symbol": s, "name": s.split(":")[-1].title(), "exchange": "NSE", "kind": "EQUITY", "expiry": None}
                for s in [*SERIES, "zerodha:NSE:GONE", "zerodha:NSE:SGBAUG28V-GB"]
            ],
        ),
        "/v1/bars": bars_route,
    }
    posts = {"/v1/results": lambda payload: (200, {"ok": True})}
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
        posted = self.stub.posted()
        self.assertEqual(len(posted), 1)
        self.assertEqual((posted[0]["runId"], posted[0]["kind"], posted[0]["title"]), ("run-7", "screen", "Above the 50 EMA"))
        data = posted[0]["data"]
        self.assertEqual(data["columns"], ["close", "return_1", "ema_50"])
        # The day's biggest gainer first; the falling stock and the halted one don't match.
        self.assertEqual([r["symbol"] for r in data["rows"]], ["zerodha:NSE:FAST", "zerodha:NSE:UP"])
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
        self.assertNotIn("zerodha:NSE:SGBAUG28V-GB", fetched)

    def test_matches_past_the_cap_are_cut_after_sorting(self):
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            old = screen.MAX_ROWS
            screen.MAX_ROWS = 1
            try:
                data = screen.Screen(spec()).run(today=TODAY)
            finally:
                screen.MAX_ROWS = old
        self.assertEqual([r["symbol"] for r in data["rows"]], ["zerodha:NSE:FAST"])
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


if __name__ == "__main__":
    unittest.main()
