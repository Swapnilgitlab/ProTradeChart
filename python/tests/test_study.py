"""Tests for Studies: the specification's rules, event detection, measurement, the control group,
and a whole run against a stub of the app."""

import copy
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

from support import Case, ms  # noqa: E402  (also puts the package on the path)

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from protrade import features as feat, run_study, study  # noqa: E402

DAYS = pd.bdate_range("2016-01-01", "2021-12-31")


def spec(**changes):
    base = {
        "version": 1,
        "name": "100% Winners",
        "universe": {"source": "instruments", "provider": "zerodha", "exchanges": ["NSE"]},
        "period": {"start": "2018-01-01", "end": None},
        "event": {"conditions": [{"left": "return_252", "op": "crosses_above", "right": 1.0}], "cooldown_days": 252},
        "lookback_windows": [252, 126, 63, 21],
        "forward_windows": [63, 126],
        "metrics": ["return_63", "rsi_14", "dist_high_252", "rvol_20"],
        "characteristics": [{"label": "Above 200 EMA", "left": "close", "op": ">", "right": "ema_200"}],
        "control_group": {"enabled": True, "samples_per_event": 2, "seed": 7},
    }
    base.update(changes)
    return base


def doubler(double_at="2019-06-03"):
    """Flat at 100, then a steady climb to 250 over the year before ``double_at``, then flat."""
    closes = pd.Series(100.0, index=DAYS)
    end = DAYS.get_indexer([pd.Timestamp(double_at)])[0]
    closes.iloc[end - 252: end + 60] = np.linspace(100, 250, 312)
    closes.iloc[end + 60:] = 250.0
    return closes


def wobble(seed):
    rng = np.random.default_rng(seed)
    return pd.Series(100 * np.exp(np.cumsum(rng.normal(0, 0.005, len(DAYS)))), index=DAYS)


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
        "coveredFrom": ms(f"{closes.index[0]:%Y-%m-%d}"),
        "coveredTo": ms(f"{closes.index[-1]:%Y-%m-%d}"),
        "limitedFrom": None,
    }


def features_of(closes, volume=1e5):
    frame = pd.DataFrame(
        {"open": closes, "high": closes * 1.01, "low": closes * 0.99, "close": closes, "volume": volume}, index=closes.index
    )
    return feat.Features(frame)


class SpecTests(unittest.TestCase):
    def test_a_spec_is_completed_with_defaults_and_canonical_names(self):
        s = study.normalize_spec({"name": " X ", "period": {"start": "2018-01-01"}, "event": {"conditions": ["return_12m >= 1"]}, "metrics": ["relative_volume"]})
        self.assertEqual(s["name"], "X")
        self.assertEqual(s["event"]["conditions"], [{"left": "return_252", "op": ">=", "right": 1.0}])
        self.assertEqual(s["event"]["label"], "return_252 >= 1")
        self.assertEqual(s["metrics"], ["rvol_20"])
        self.assertEqual(s["lookback_windows"], [21, 63, 126, 252])
        self.assertEqual(s["universe"]["exchanges"], ["NSE"])
        self.assertTrue(s["control_group"]["enabled"])
        self.assertEqual(study.normalize_spec(s), s, "normalising twice changes nothing")

    def test_bad_specs_say_what_is_wrong(self):
        cases = [
            ({"name": ""}, "name"),
            ({"version": 2}, "version"),
            ({"period": {"start": None}}, "period.start"),
            ({"period": {"start": "2020-01-01", "end": "2019-01-01"}}, "period.end"),
            ({"event": {"conditions": []}}, "event.conditions"),
            ({"metrics": ["nonsense_3"]}, "metrics"),
            ({"universe": {"source": "watchlist"}}, "universe.watchlist"),
            ({"universe": {"exchanges": ["NYSE"]}}, "universe.exchanges"),
            ({"metrics": ["rs_126"]}, "benchmark"),
            ({"lookback_windows": [0]}, "lookback_windows"),
        ]
        for change, word in cases:
            with self.subTest(change=change):
                with self.assertRaises(study.SpecError) as caught:
                    study.normalize_spec(spec(**change))
                self.assertIn(word, str(caught.exception))

    def test_observation_points_and_history_needed(self):
        s = study.normalize_spec(spec())
        self.assertEqual(study.offsets(s), [-252, -126, -63, -21, 0, 63, 126])
        self.assertEqual(study.column("rsi_14", -63), "rsi_14@-63")
        self.assertEqual(study.column("rsi_14", 0), "rsi_14@0")
        self.assertEqual(study.column("rsi_14", 63), "rsi_14@+63")
        # 252 bars of lookback plus a 52-week high measured there.
        self.assertGreaterEqual(study.history_bars(s), 504)
        self.assertLess(study.fetch_start(s), pd.Timestamp("2016-01-15").date())


class UniverseTests(unittest.TestCase):
    def test_only_shares_count_as_stocks(self):
        cases = {
            ("RELIANCE", "RELIANCE INDUSTRIES"): "EQ",
            ("XYZ-BE", "XYZ"): "BE",
            ("XYZ-BZ", "XYZ"): "BE",
            ("ABC-SM", "ABC"): "SME",
            ("ABC-ST", "ABC"): "SME",
            ("IRFC-N2", "IRFC"): None,  # a bond
            ("SGBAUG28V-GB", "SGB"): None,  # a sovereign gold bond
            ("GS2030-GS", "GOI"): None,
            ("364D210226", "TBILL"): None,
            ("1030FC24", "ABC FINANCE NCD"): None,
            ("NIFTYBEES", "NIPPON INDIA ETF NIFTY BEES"): None,
            ("GOLDETF", None): None,
            ("EMBASSY-RR", "EMBASSY OFFICE PARKS REIT"): None,
            ("", None): None,
        }
        for (ticker, name), expected in cases.items():
            self.assertEqual(study.listing_series(ticker, name), expected, ticker)

    def test_a_company_on_two_exchanges_is_studied_once(self):
        rows = [
            ("zerodha:NSE:RELIANCE", "RELIANCE INDUSTRIES"),
            ("zerodha:NSE:IRFC-N2", "IRFC"),
            ("zerodha:NSE:XYZ-BE", "XYZ"),
            ("zerodha:BSE:RELIANCE", "Reliance Industries Ltd."),
            ("zerodha:BSE:RELIND", "RELIANCE INDUSTRIES LIMITED"),  # spelled differently on BSE
            ("zerodha:BSE:XYZ", "XYZ Ltd"),
            ("zerodha:BSE:BSEONLY", "BSE ONLY LTD"),
        ]
        self.assertEqual([s for s, _ in study.pick_listings(rows)], ["zerodha:NSE:RELIANCE", "zerodha:BSE:XYZ", "zerodha:BSE:BSEONLY"])
        self.assertEqual(
            [s for s, _ in study.pick_listings(rows, ["EQ", "BE"])],
            ["zerodha:NSE:RELIANCE", "zerodha:NSE:XYZ-BE", "zerodha:BSE:BSEONLY"],
        )

    def test_the_series_are_part_of_the_spec(self):
        self.assertEqual(study.normalize_spec(spec())["universe"]["series"], ["EQ"])
        self.assertEqual(study.normalize_spec(spec(universe={"series": ["SME", "EQ"]}))["universe"]["series"], ["EQ", "SME"])
        with self.assertRaises(study.SpecError):
            study.normalize_spec(spec(universe={"series": ["GB"]}))


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.data = {"zerodha:NSE:WIN": features_of(doubler()), "zerodha:NSE:FLAT": features_of(wobble(3))}
        self.study = study.ResearchStudy(spec(), progress=False)

    def test_an_event_is_the_day_the_condition_first_holds(self):
        events = self.study.detect_events(self.data)
        self.assertEqual(list(events["symbol"]), ["zerodha:NSE:WIN"])
        row = events.iloc[0]
        closes = self.data["zerodha:NSE:WIN"].get("close")
        pos = int(row["pos"])
        self.assertGreaterEqual(closes.iloc[pos] / closes.iloc[pos - 252], 2.0)
        self.assertLess(closes.iloc[pos - 1] / closes.iloc[pos - 253], 2.0)
        self.assertAlmostEqual(row["event_value"], closes.iloc[pos] / closes.iloc[pos - 252] - 1)
        self.assertIsNone(row["market_cap"])

    def test_events_before_the_period_or_failing_a_filter_are_left_out(self):
        late = study.ResearchStudy(spec(period={"start": "2020-01-01"}), progress=False)
        self.assertTrue(late.detect_events(self.data).empty)
        rich = study.ResearchStudy(spec(universe={"source": "instruments", "min_avg_traded_value": 1e12}), progress=False)
        self.assertTrue(rich.detect_events(self.data).empty)
        # A pre-event filter is judged `at` bars before the event: 63 bars before a steady climb,
        # the price was already above its 200-day EMA, but not 400 bars before.
        above = study.ResearchStudy(spec(pre_event_filters=[{"at": 63, "left": "close", "op": ">", "right": "ema_200"}]), progress=False)
        self.assertEqual(len(above.detect_events(self.data)), 1)
        before = study.ResearchStudy(spec(pre_event_filters=[{"at": 300, "left": "close", "op": ">", "right": "ema_200"}]), progress=False)
        self.assertTrue(before.detect_events(self.data).empty)

    def test_the_cooldown_keeps_one_event_per_move(self):
        data = {"zerodha:NSE:WIN": features_of(doubler())}
        every = study.ResearchStudy(spec(event={"conditions": ["return_21 > 0.03"], "cooldown_days": 1}), progress=False)
        once = study.ResearchStudy(spec(event={"conditions": ["return_21 > 0.03"], "cooldown_days": 2000}), progress=False)
        self.assertGreaterEqual(len(every.detect_events(data)), 1)
        self.assertEqual(len(once.detect_events(data)), 1)

    def test_measurements_are_taken_at_each_observation_point(self):
        events = self.study.detect_events(self.data)
        measured = self.study.measure(events, self.data)
        pos = int(events["pos"].iloc[0])
        f = self.data["zerodha:NSE:WIN"]
        self.assertAlmostEqual(measured["return_63@-63"].iloc[0], f.get("return_63").iloc[pos - 63])
        self.assertAlmostEqual(measured["rsi_14@0"].iloc[0], f.get("rsi_14").iloc[pos])
        self.assertAlmostEqual(measured["fwd_return_63"].iloc[0], f.get("close").iloc[pos + 63] / f.get("close").iloc[pos] - 1)
        self.assertLessEqual(measured["fwd_max_drawdown_63"].iloc[0], 0.0)
        self.assertEqual(measured["char_0@-21"].iloc[0], 1.0, "a climbing stock is above its 200 EMA")

    def test_forward_gains_and_falls_are_the_best_and_worst_after_the_event(self):
        events = self.study.detect_events(self.data)
        measured = self.study.measure(events, self.data)
        pos = int(events["pos"].iloc[0])
        bars = self.data["zerodha:NSE:WIN"].bars
        close = bars["close"].iloc[pos]
        for window in (63, 126):
            after = bars.iloc[pos + 1: pos + window + 1]
            self.assertAlmostEqual(measured[f"fwd_max_gain_{window}"].iloc[0], after["high"].max() / close - 1)
            self.assertAlmostEqual(measured[f"fwd_max_drawdown_{window}"].iloc[0], after["low"].min() / close - 1)

    def test_measuring_many_symbols_reports_progress_along_the_way(self):
        # Progress is reported every 50 symbols; a report past the first once crashed because the
        # loop reused the band's names for each symbol's high and low prices.
        data = {f"zerodha:NSE:W{i}": features_of(doubler()) for i in range(120)}
        s = study.ResearchStudy(spec(), progress=True)
        out = io.StringIO()
        with redirect_stdout(out):
            events = s.detect_events(data)
            measured = s.measure(events, data)
        self.assertEqual(len(measured), 120)
        self.assertEqual(out.getvalue().count("Calculating metrics"), 3, "at symbols 0, 50 and 100")

    def test_differences_from_the_control_group_are_tested_and_the_clear_ones_listed(self):
        # Thirty stocks that double (each at a different date) and thirty that drift: before the
        # event the winners were climbing, the control dates weren't.
        days = pd.Timestamp("2019-03-01")
        data = {f"zerodha:NSE:W{i}": features_of(doubler(f"{days + pd.offsets.BDay(7 * i):%Y-%m-%d}")) for i in range(30)}
        data.update({f"zerodha:NSE:F{i}": features_of(wobble(i)) for i in range(30)})
        s = study.ResearchStudy(spec(), progress=False)
        events = s.detect_events(data)
        measured = s.measure(events, data)
        control = s.measure(s.control_group(data, events), data)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            result = s.analyze(measured, control, data, show=False)
        tested = next(x for x in result["stats"] if x["metric"] == "return_63" and x["offset"] == -21)
        self.assertLess(tested["test"]["q"], 0.05)
        self.assertGreater(tested["test"]["effect"], 0.474, "winners were climbing far more than control dates")
        self.assertEqual(tested["test"]["n_events"], 30)
        character = next(x for x in result["characteristics"] if x["offset"] == -21)
        self.assertGreater(character["test"]["diff"], 0)
        self.assertLessEqual(character["test"]["low"], character["test"]["diff"])
        findings = result["summary"]["findings"]
        self.assertTrue(findings)
        self.assertLessEqual(len(findings), study.MAX_FINDINGS)
        self.assertTrue(all(f["test"]["q"] < study.FINDING_Q for f in findings))
        keys = [(f["kind"], f.get("metric") or f.get("label") or f.get("window")) for f in findings]
        self.assertEqual(len(keys), len(set(keys)), "one finding per measurement")
        json.dumps(result)

    def test_with_too_few_events_there_are_no_tests(self):
        events = self.study.detect_events(self.data)
        measured = self.study.measure(events, self.data)
        control = self.study.measure(self.study.control_group(self.data, events), self.data)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            result = self.study.analyze(measured, control, self.data, show=False)
        self.assertTrue(all(x["test"] is None for x in result["stats"]))
        self.assertEqual(result["summary"]["findings"], [])

    def test_a_point_outside_the_history_is_blank(self):
        events = self.study.detect_events(self.data)
        events.loc[0, "pos"] = 10
        measured = self.study.measure(events, self.data)
        self.assertTrue(np.isnan(measured["rsi_14@-252"].iloc[0]))

    def test_the_control_group_avoids_events_and_is_reproducible(self):
        events = self.study.detect_events(self.data)
        control = self.study.control_group(self.data, events)
        self.assertEqual(len(control), 2 * len(events))
        again = study.ResearchStudy(spec(), progress=False)
        again.detect_events(self.data)
        self.assertEqual(list(again.control_group(self.data, events)["pos"]), list(control["pos"]))
        event_pos = int(events["pos"].iloc[0])
        for symbol, pos in zip(control["symbol"], control["pos"]):
            if symbol == "zerodha:NSE:WIN":
                self.assertGreater(abs(pos - event_pos), 252)

    def test_the_result_aggregates_and_labels_what_it_lacks(self):
        events = self.study.detect_events(self.data)
        measured = self.study.measure(events, self.data)
        control = self.study.measure(self.study.control_group(self.data, events), self.data)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            result = self.study.analyze(measured, control, self.data, show=False)
        self.assertEqual(result["summary"]["events"], 1)
        self.assertEqual(result["summary"]["unique_symbols"], 1)
        self.assertEqual(result["events"]["columns"][:3], ["symbol", "name", "event_date"])
        self.assertEqual(len(result["events"]["rows"]), 1)
        self.assertFalse(result["availability"]["market_cap"])
        self.assertIn("market_cap_unavailable", [w["code"] for w in result["warnings"]])
        stat = next(s for s in result["stats"] if s["metric"] == "return_63" and s["offset"] == -63)
        self.assertEqual(stat["events"]["count"], 1)
        self.assertEqual(stat["control"]["count"], 2)
        character = next(c for c in result["characteristics"] if c["offset"] == -21)
        self.assertEqual(character["events"], {"count": 1, "true": 1, "share": 1.0})
        self.assertEqual(result["path"]["median"][result["path"]["offsets"].index(0)], 1.0)
        self.assertTrue(result["meta"]["data_version"])
        json.dumps(result)  # everything is JSON

    def test_an_outcome_splits_events_into_those_that_reached_it_and_those_that_did_not(self):
        data = {"zerodha:NSE:WIN": features_of(doubler()), "zerodha:NSE:FLAT": features_of(wobble(3))}
        s = study.ResearchStudy(spec(event={"conditions": ["return_21 crosses_above 0.02"], "cooldown_days": 60}, outcome={"window": 63, "min_return": 0.2}), progress=False)
        events = s.detect_events(data)
        met, missed = s.split_by_outcome(events, data)
        self.assertEqual(len(met) + len(missed) + s.outcome_counts["unknown"], len(events))
        for group, reached in ((met, True), (missed, False)):
            for symbol, pos in zip(group["symbol"], group["pos"]):
                close = data[symbol].get("close").to_numpy()
                best = close[pos + 1: pos + 64].max() / close[pos] - 1
                self.assertEqual(best >= 0.2, reached)
        self.assertGreater(len(met), 0)
        with self.assertRaises(study.SpecError):
            study.normalize_spec(spec(outcome={"window": 63}))

    def test_the_apps_fixture_has_the_shape_the_engine_posts(self):
        # src/studies/fixtures/engine-result.json is what the app's tests parse. If the engine's
        # output changes shape, regenerate it (see src/studies/result.test.ts) so the two agree.
        events = self.study.detect_events(self.data)
        measured = self.study.measure(events, self.data)
        control = self.study.measure(self.study.control_group(self.data, events), self.data)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            live = self.study.analyze(measured, control, self.data, show=False)
        fixture_path = os.path.join(os.path.dirname(__file__), "..", "..", "src", "studies", "fixtures", "engine-result.json")
        with open(fixture_path, encoding="utf-8") as f:
            fixture = json.load(f)

        def shape(value):
            if isinstance(value, dict):
                return {k: shape(v) for k, v in value.items() if k not in ("outcome",)}
            if isinstance(value, list):
                return [shape(value[0])] if value and isinstance(value[0], (dict, list)) else "list"
            return "value"

        self.assertEqual(shape(fixture), shape(live))
        self.assertEqual(fixture["events"]["columns"], live["events"]["columns"])

    def test_describe_and_histogram(self):
        d = study.describe([1, 2, 3, 4, float("nan")])
        self.assertEqual((d["count"], d["median"], d["min"], d["max"]), (4, 2.5, 1.0, 4.0))
        self.assertEqual(study.describe([])["median"], None)
        h = study.histogram([1, 2, 3, 100], [2, 2])
        self.assertEqual(len(h["edges"]), study.HISTOGRAM_BINS + 1)
        self.assertEqual(sum(h["events"]), 4)
        self.assertEqual(sum(h["control"]), 2)
        self.assertIsNotNone(study.histogram([5, 5], []), "one value still makes a bar")

    def test_market_cap_is_never_silently_ignored(self):
        s = study.ResearchStudy(spec(universe={"source": "instruments", "market_cap_min": 1e10}), progress=False)
        with self.assertRaises(study.StudyDataError):
            s.universe()


SERIES = {"zerodha:NSE:WIN": doubler(), "zerodha:NSE:FLAT": wobble(3), "zerodha:NSE:SLOW": wobble(4)}


def bars_route(query):
    closes = SERIES.get(query["symbol"])
    if closes is None:
        return 404, {"error": {"code": "not_found", "message": "no such symbol"}}
    start = pd.Timestamp(int(query["from"]), unit="ms", tz="UTC").tz_convert("Asia/Kolkata").tz_localize(None).normalize()
    return 200, body(query["symbol"], closes[closes.index >= start])


class RunTests(Case):
    routes = {
        "/v1/ping": lambda q: (200, {"ok": True, "api": 1, "app": "9.9.9"}),
        "/v1/instruments": lambda q: (
            200,
            [{"symbol": s, "name": s.split(":")[-1].title(), "exchange": "NSE", "kind": "EQUITY", "expiry": None} for s in [*SERIES, "zerodha:NSE:GONE"]],
        ),
        "/v1/bars": bars_route,
    }
    posts = {"/v1/results": lambda payload: (200, {"ok": True})}
    run_id = "run-9"

    def test_a_spec_file_runs_from_start_to_finish_and_posts_one_study(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "spec.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(spec(), f)
            out = io.StringIO()
            with redirect_stdout(out), redirect_stderr(io.StringIO()):
                code = run_study.main(["run_study", path])
        self.assertEqual(code, 0)
        self.assertIn("[progress] 100% Complete", out.getvalue())
        self.assertIn(f"[engine] protrade {study.ENGINE_VERSION} ({study.engine_build()})", out.getvalue())
        posted = self.stub.posted()
        self.assertEqual(len(posted), 1)
        self.assertEqual((posted[0]["runId"], posted[0]["kind"], posted[0]["title"]), ("run-9", "study", "100% Winners"))
        data = posted[0]["data"]
        self.assertEqual(data["summary"]["events"], 1)
        self.assertEqual(data["events"]["rows"][0][:2], ["zerodha:NSE:WIN", "Win"])
        self.assertEqual(data["meta"]["app_version"], "9.9.9")
        self.assertRegex(data["meta"]["engine_build"], r"^[0-9a-f]{8}$")
        self.assertEqual(data["meta"]["symbols_requested"], 4)
        self.assertEqual(data["meta"]["symbols_failed"], 1)
        self.assertIn("survivorship", [w["code"] for w in data["warnings"]])
        # The fetch reached back far enough for a 52-week high 12 months before a 2018 event.
        starts = sorted(int(r["query"]["from"]) for r in self.stub.requests if r["path"] == "/v1/bars")
        self.assertLessEqual(starts[0], ms("2016-01-20"))

    def test_loading_keeps_many_requests_in_flight_and_reports_time_left(self):
        # The app paces the broker; the engine's job is to always have requests waiting at that
        # pace, so a slow round trip never leaves the pace idle.
        import threading
        import time as _time

        state = {"now": 0, "most": 0}
        lock = threading.Lock()
        many = {f"zerodha:NSE:S{i}": wobble(i) for i in range(40)}

        def slow(query):
            with lock:
                state["now"] += 1
                state["most"] = max(state["most"], state["now"])
            _time.sleep(0.05)
            with lock:
                state["now"] -= 1
            closes = many[query["symbol"]]
            return 200, body(query["symbol"], closes[-300:])

        self.stub.routes["/v1/bars"] = slow
        s = study.ResearchStudy(spec(universe={"source": "symbols", "symbols": list(many)}), progress=True)
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(io.StringIO()):
            data = s.load(list(many))
        self.assertEqual(len(data), 40)
        self.assertGreaterEqual(state["most"], study.LOAD_WORKERS - 1)
        self.assertIn("Loading historical data (40/40)", out.getvalue())
        self.assertIn("load", s.timings)

    def test_symbols_that_can_never_qualify_are_not_kept(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "spec.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(spec(universe={"source": "instruments", "min_avg_traded_value": 1.2e7}), f)
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(run_study.main(["run_study", path]), 0)
        meta = self.stub.posted()[0]["data"]["meta"]
        # All three series were loaded and fingerprinted; only the one liquid enough is kept.
        self.assertEqual(meta["symbols_loaded"], 3)
        self.assertLess(meta["symbols_kept"], 3)
        self.assertIn("load_and_detect", meta["timings"])

    def test_a_problem_the_user_can_fix_is_said_without_a_traceback(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "spec.json")
            bad = copy.deepcopy(spec())
            bad["universe"]["market_cap_min"] = 1e10
            with open(path, "w", encoding="utf-8") as f:
                json.dump(bad, f)
            err = io.StringIO()
            with redirect_stdout(io.StringIO()), redirect_stderr(err):
                code = run_study.main(["run_study", path])
        self.assertEqual(code, 1)
        self.assertIn("Market cap isn't available", err.getvalue())
        self.assertNotIn("Traceback", err.getvalue())


if __name__ == "__main__":
    unittest.main()
