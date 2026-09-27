"""Tests for measures: what a Study reads over a window of bars around each event.

Every stat is checked against a plain, bar-by-bar reference on random series with random windows, so
the vectorised engine and the definitions in ``protrade/measures.py`` can't drift apart."""

import copy
import io
import json
import os
import unittest
from contextlib import redirect_stderr, redirect_stdout

from support import Case  # noqa: F401  (also puts the package on the path)

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from protrade import features as feat, measures as msr, study  # noqa: E402

import test_study as ts  # noqa: E402

CASES_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "src", "studies", "fixtures", "spec-cases.json")


def load_cases() -> dict:
    with open(CASES_PATH, encoding="utf-8") as f:
        return json.load(f)


def expand(value, base: dict):
    """The placeholders spec-cases.json uses for values too long to write out (spec.test.ts expands
    them the same way)."""
    one = base["measures"][0]
    if value == "QUESTION_TOO_LONG":
        return "x" * 501
    if value == "LABEL_TOO_LONG":
        return "x" * 121
    if value == "THIRTEEN_MEASURES":
        return [copy.deepcopy(one) for _ in range(13)]
    if value == "FOUR_HEADLINES":
        return [copy.deepcopy(one) for _ in range(4)]
    if isinstance(value, list):
        return [expand(v, base) for v in value]
    if isinstance(value, dict):
        return {k: expand(v, base) for k, v in value.items()}
    return value


def patched(base: dict, patch: dict) -> dict:
    spec = copy.deepcopy(base)
    spec.update(expand(copy.deepcopy(patch), base))
    return spec


class SharedCaseTests(unittest.TestCase):
    """The same cases src/studies/spec.test.ts runs against normalizeSpec."""

    def test_the_base_case_is_valid(self):
        study.normalize_spec(load_cases()["base"])

    def test_refused_cases_name_the_problem(self):
        cases = load_cases()
        for case in cases["refused"]:
            with self.subTest(word=case["word"]):
                with self.assertRaises(study.SpecError) as caught:
                    study.normalize_spec(patched(cases["base"], case["patch"]))
                self.assertIn(case["word"], str(caught.exception))

    def test_accepted_cases_normalise_to_the_same_measures_in_both_languages(self):
        cases = load_cases()
        for case in cases["accepted"]:
            with self.subTest(case=case["name"]):
                spec = study.normalize_spec(patched(cases["base"], case["patch"]))
                if "measures" in case:
                    self.assertEqual(spec["measures"], case["measures"])
                self.assertEqual(study.normalize_spec(spec), spec, "normalising twice changes nothing")


# ---- The reference: one event at a time, bar by bar -----------------------------------------------


def reference(measure: dict, f: feat.Features, pos: int):
    """(value, status) for one event, from the definitions, without prefix sums or accumulators."""
    n = len(f)

    def known_held(conditions):
        held, known = msr.evaluate_known(f, conditions)
        return held, known

    def resolve(ep):
        if "offset" in ep:
            t = pos + ep["offset"]
            if t < 0:
                return None, "no_history"
            if t >= n:
                return None, "too_recent"
            return t, "ok"
        within = ep["within"]
        lo, hi = (pos - within, pos) if ep["direction"] == "before" else (pos + 1, pos + within)
        if ep["find"] in ("lowest", "highest"):
            if lo < 0:
                return None, "no_history"
            if hi >= n:
                return None, "too_recent"
            vals = f.get(ep["feature"]).to_numpy()[lo: hi + 1]
            if not np.isfinite(vals).all():
                return None, "no_history"
            best = None
            for j in range(lo, hi + 1):  # ties go to the latest bar
                v = vals[j - lo]
                if best is None or (v <= vals[best - lo] if ep["find"] == "lowest" else v >= vals[best - lo]):
                    best = j
            return best, "ok"
        held, known = known_held(ep["conditions"])
        if ep["find"] == "last":
            if hi >= n:
                return None, "too_recent"
            for j in range(hi, max(lo, 0) - 1, -1):
                if not known[j]:
                    return None, "no_history"
                if held[j]:
                    return j, "ok"
            if lo < 0:
                return None, "no_history"
            return (lo, "capped") if ep["if_not_found"] == "cap" else (None, "not_found")
        if lo < 0:
            return None, "no_history"
        for j in range(lo, min(hi, n - 1) + 1):
            if not known[j]:
                return None, "no_history"
            if held[j]:
                return j, "ok"
        if hi >= n:
            return None, "too_recent"
        return (hi, "capped") if ep["if_not_found"] == "cap" else (None, "not_found")

    a, sa = resolve(measure["window"]["start"])
    b, sb = resolve(measure["window"]["end"])
    for s in ("no_history", "too_recent", "not_found"):
        if s in (sa, sb):
            return None, s
    if a >= b:
        return None, "empty"
    status = "capped" if "capped" in (sa, sb) else "ok"
    stat = measure["stat"]
    if stat in msr.CONDITION_STATS:
        held, known = known_held(measure["conditions"])
        bars = list(range(a + 1, b + 1))
        if not all(known[j] for j in bars):
            return None, "no_history"
        h = [bool(held[j]) for j in bars]
        if stat == "share":
            return sum(h) / len(h), status
        if stat == "count":
            return sum(h), status
        if stat == "longest_run":
            best = run = 0
            for x in h:
                run = run + 1 if x else 0
                best = max(best, run)
            return best, status
        if stat == "runs":
            return sum(1 for i, x in enumerate(h) if x and (i == 0 or not h[i - 1])), status
        if stat == "bars_to_first":
            for i, x in enumerate(h):
                if x:
                    return i + 1, status
            return float("inf"), "never"
        for i in range(len(h) - 1, -1, -1):  # bars_since_last
            if h[i]:
                return len(h) - 1 - i, status
        return float("inf"), "never"
    if stat in msr.FEATURE_STATS:
        x = f.get(measure["feature"]).to_numpy()
        if stat in ("mean", "min", "max"):
            chunk = x[a + 1: b + 1]
            if not np.isfinite(chunk).all():
                return None, "no_history"
            return {"mean": np.mean, "min": np.min, "max": np.max}[stat](chunk), status
        needed = {"start_value": [a], "end_value": [b], "change": [a, b]}[stat]
        if not all(np.isfinite(x[j]) for j in needed):
            return None, "no_history"
        return {"start_value": x[a], "end_value": x[b], "change": x[b] - x[a]}[stat], status
    if stat == "length":
        return b - a, status
    close = f.get("close").to_numpy()
    path = close[a: b + 1]
    if stat == "return":
        return path[-1] / path[0] - 1, status
    if stat == "max_gain":
        return max(path[1:]) / path[0] - 1, status
    worst, peak = 0.0, path[0]
    for c in path:
        peak = max(peak, c)
        worst = min(worst, c / peak - 1)
    return worst, status


def random_series(seed: int, n: int = 700) -> feat.Features:
    rng = np.random.default_rng(seed)
    days = pd.bdate_range("2019-01-01", periods=n)
    closes = pd.Series(100 * np.exp(np.cumsum(rng.normal(0.0005, 0.02, n))), index=days)
    return ts.features_of(closes)


def random_endpoint(rng, side_hint: str) -> dict:
    if rng.random() < 0.5:
        k = int(rng.integers(-120, 1)) if side_hint == "start" else int(rng.integers(-40, 121))
        return {"offset": k}
    find = str(rng.choice(msr.FINDS))
    direction = "before" if side_hint == "start" or rng.random() < 0.3 else "after"
    ep = {"find": find, "direction": direction, "within": int(rng.integers(5, 150)), "if_not_found": str(rng.choice(msr.IF_NOT_FOUND))}
    if find in ("lowest", "highest"):
        ep["feature"] = str(rng.choice(["close", "rsi_14", "dist_ema_21"]))
    else:
        ep["conditions"] = [{"left": "close", "op": str(rng.choice([">", "<", "crosses_above"])), "right": "ema_20"}]
    return ep


class StatTests(unittest.TestCase):
    CONDITIONS = [
        [{"left": "dist_ema_21", "op": ">=", "right": 0}, {"left": "dist_ema_21", "op": "<=", "right": 0.03}],
        [{"left": "close", "op": ">", "right": "sma_50"}],
        [{"left": "rsi_14", "op": "crosses_above", "right": 50}],
    ]

    def test_every_stat_matches_the_bar_by_bar_reference_on_random_windows(self):
        rng = np.random.default_rng(11)
        checked = {s: 0 for s in msr.STATS}
        for trial in range(60):
            f = random_series(trial)
            pos = np.sort(rng.choice(np.arange(0, len(f)), size=25, replace=False))
            for stat in msr.STATS:
                raw = {
                    "stat": stat,
                    "conditions": self.CONDITIONS[trial % len(self.CONDITIONS)],
                    "feature": ["close", "rsi_14", "dist_sma_50"][trial % 3],
                    "window": {"start": random_endpoint(rng, "start"), "end": random_endpoint(rng, "end")},
                }
                if stat == "length" and not msr.is_anchored(raw["window"]):
                    raw["window"]["end"] = {"find": "first", "conditions": [{"left": "close", "op": "<", "right": "ema_20"}], "direction": "after", "within": 60}
                try:
                    measure = msr.normalize_measure(raw, "m")
                except msr.MeasureError:
                    continue  # a random window that can never hold a bar
                got = msr.measure_symbol(measure, f, pos)
                for i, p in enumerate(pos):
                    want, status = reference(measure, f, int(p))
                    with self.subTest(trial=trial, stat=stat, pos=int(p), window=measure["window"]):
                        self.assertEqual(got["status"][i], status)
                        if want is None:
                            self.assertTrue(np.isnan(got["value"][i]))
                        elif np.isinf(want):
                            self.assertTrue(np.isposinf(got["value"][i]))
                        else:
                            self.assertAlmostEqual(float(got["value"][i]), float(want), places=9)
                            checked[stat] += 1
        for stat, count in checked.items():
            self.assertGreater(count, 0, f"no random case exercised {stat} with a value")

    def test_a_fixed_window_up_to_the_event_matches_the_features_it_should(self):
        f = random_series(3)
        pos = np.array([300, 400, 650])
        window = {"start": {"offset": -252}, "end": {"offset": 0}}
        ret = msr.measure_symbol(msr.normalize_measure({"stat": "return", "window": window}, "m"), f, pos)
        np.testing.assert_allclose(ret["value"], f.get("return_252").to_numpy()[pos])
        after = {"start": {"offset": 0}, "end": {"offset": 21}}
        fwd = msr.measure_symbol(msr.normalize_measure({"stat": "return", "window": after}, "m"), f, pos)
        close = f.get("close").to_numpy()
        self.assertAlmostEqual(fwd["value"][0], close[321] / close[300] - 1)
        self.assertEqual(fwd["status"][2], "ok")
        self.assertEqual(msr.measure_symbol(msr.normalize_measure({"stat": "return", "window": {"start": {"offset": 0}, "end": {"offset": 60}}}, "m"), f, pos)["status"][2], "too_recent")


class CensoringTests(unittest.TestCase):
    def setUp(self):
        # Rises steadily, then falls from bar 400: the first close below the 50 SMA comes a little after.
        days = pd.bdate_range("2019-01-01", periods=600)
        closes = np.concatenate([np.linspace(100, 300, 400), np.linspace(300, 150, 200)])
        self.f = ts.features_of(pd.Series(closes, index=days))
        self.below = [{"left": "close", "op": "<", "right": "sma_50"}]

    def run_measure(self, raw, pos):
        return msr.measure_symbol(msr.normalize_measure(raw, "m"), self.f, np.asarray(pos))

    def test_a_trend_that_had_not_broken_is_capped_or_skipped_never_invented(self):
        until_break = {"start": {"offset": 0}, "end": {"find": "first", "conditions": self.below, "direction": "after", "within": 100}}
        capped = self.run_measure({"stat": "length", "window": until_break}, [150, 380])
        self.assertEqual(capped["status"][0], "capped")  # still rising 100 bars later
        self.assertEqual(capped["value"][0], 100)
        self.assertEqual(capped["status"][1], "ok")  # broke within the window
        self.assertLess(capped["value"][1], 100)
        skip = dict(until_break, end=dict(until_break["end"], if_not_found="skip"))
        skipped = self.run_measure({"stat": "length", "window": skip}, [150])
        self.assertEqual(skipped["status"][0], "not_found")
        self.assertTrue(np.isnan(skipped["value"][0]))

    def test_an_anchor_the_data_ends_before_finding_is_too_recent_not_capped(self):
        until_break = {"start": {"offset": 0}, "end": {"find": "first", "conditions": [{"left": "close", "op": ">", "right": 10_000}], "direction": "after", "within": 100}}
        got = self.run_measure({"stat": "length", "window": until_break}, [550])
        self.assertEqual(got["status"][0], "too_recent")

    def test_conditions_that_never_held_are_never_not_a_number(self):
        after = {"start": {"offset": 0}, "end": {"offset": 50}}
        got = self.run_measure({"stat": "bars_to_first", "conditions": self.below, "window": after}, [100, 420])
        self.assertEqual(got["status"][0], "never")
        self.assertTrue(np.isposinf(got["value"][0]))
        self.assertEqual(got["status"][1], "ok")
        summary = msr.describe_censored([1, 2, 3, np.inf, np.inf, np.inf, np.inf])
        self.assertIsNone(summary["median"], "the median lands among the nevers")
        self.assertIsNone(summary["mean"])
        self.assertEqual(summary["min"], 1)
        self.assertEqual(msr.describe_censored([1, 2, 3, 4, np.inf])["median"], 3)

    def test_warm_up_bars_make_a_window_blank_never_partial(self):
        early = {"start": {"offset": -30}, "end": {"offset": 0}}
        got = self.run_measure({"stat": "share", "conditions": self.below, "window": early}, [40, 200])
        self.assertEqual(got["status"][0], "no_history")  # the 50 SMA has no value yet
        self.assertEqual(got["status"][1], "ok")
        before_data = self.run_measure({"stat": "return", "window": {"start": {"offset": -300}, "end": {"offset": 0}}}, [100])
        self.assertEqual(before_data["status"][0], "no_history")

    def test_ties_for_the_lowest_go_to_the_latest_bar(self):
        days = pd.bdate_range("2019-01-01", periods=60)
        closes = np.array([100.0] * 20 + [90.0] * 5 + [100.0] * 20 + [90.0] * 5 + [120.0] * 10)
        f = ts.features_of(pd.Series(closes, index=days))
        window = {"start": {"find": "lowest", "feature": "close", "within": 50}, "end": {"offset": 0}}
        got = msr.measure_symbol(msr.normalize_measure({"stat": "length", "window": window}, "m"), f, np.array([59]))
        self.assertEqual(int(got["start"][0]), 49)
        self.assertEqual(got["value"][0], 10)


class LookAheadTests(unittest.TestCase):
    def test_a_before_window_never_reads_a_bar_after_the_event(self):
        f = random_series(5)
        pos = np.array([300, 450])
        before_measures = [
            {"stat": "share", "conditions": [{"left": "close", "op": ">", "right": "ema_20"}], "window": {"start": {"offset": -252}, "end": {"offset": 0}}},
            {"stat": "length", "window": {"start": {"find": "lowest", "feature": "close", "within": 200}, "end": {"offset": 0}}},
            {"stat": "longest_run", "conditions": [{"left": "rsi_14", "op": ">", "right": 50}], "window": {"start": {"find": "last", "conditions": [{"left": "close", "op": "<", "right": "sma_50"}], "within": 200}, "end": {"offset": 0}}},
            {"stat": "max_drawdown", "window": {"start": {"find": "highest", "feature": "close", "within": 120}, "end": {"offset": 0}}},
        ]
        closes = f.bars["close"].copy()
        for raw in before_measures:
            measure = msr.normalize_measure(raw, "m")
            self.assertEqual(msr.side(measure["window"]), "before")
            base = msr.measure_symbol(measure, f, pos)
            for p in pos:
                changed = closes.copy()
                changed.iloc[int(p) + 1:] = changed.iloc[int(p) + 1:] * 3.7  # rewrite the future
                g = ts.features_of(changed)
                again = msr.measure_symbol(measure, g, np.array([p]))
                i = list(pos).index(p)
                with self.subTest(stat=raw["stat"], pos=int(p)):
                    self.assertEqual(again["status"][0], base["status"][i])
                    np.testing.assert_allclose(again["value"][0], base["value"][i])


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.data = {"zerodha:NSE:WIN": ts.features_of(ts.doubler()), "zerodha:NSE:FLAT": ts.features_of(ts.wobble(3))}
        self.study = study.ResearchStudy(ts.spec(), progress=False)

    def analyzed(self):
        events = self.study.detect_events(self.data)
        measured = self.study.measure(events, self.data)
        control = self.study.measure(self.study.control_group(self.data, events), self.data)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            return measured, control, self.study.analyze(measured, control, self.data, show=False)

    def test_the_user_question_is_answered_per_stock(self):
        zone = [{"left": "dist_ema_21", "op": ">=", "right": 0}, {"left": "dist_ema_21", "op": "<=", "right": 0.03}]
        window = {"start": {"offset": -252}, "end": {"offset": 0}}
        self.study = study.ResearchStudy(
            ts.spec(metrics=[], characteristics=[], measures=[{"stat": "share", "conditions": zone, "window": window}, {"stat": "count", "conditions": zone, "window": window}]),
            progress=False,
        )
        measured, _, result = self.analyzed()
        f = self.data["zerodha:NSE:WIN"]
        pos = int(measured["pos"].iloc[0])
        d = f.get("dist_ema_21").to_numpy()[pos - 251: pos + 1]
        self.assertAlmostEqual(measured["measure_0"].iloc[0], np.mean((d >= 0) & (d <= 0.03)))
        self.assertAlmostEqual(measured["measure_1"].iloc[0], measured["measure_0"].iloc[0] * 252)
        self.assertEqual(result["measures"][0]["events"]["status"]["ok"], 1)

    def test_the_result_carries_each_measure_with_its_comparison_and_timeline(self):
        measured, control, result = self.analyzed()
        self.assertEqual([m["label"] for m in result["measures"]], ["Above the 50 EMA", "The run from the 12-month low"])
        share, run = result["measures"]
        self.assertIsNotNone(share["control"])
        self.assertEqual(share["control"]["count"], sum(share["control"]["status"][s] for s in msr.MEASURED))
        self.assertIsNotNone(share["timeline"])
        self.assertEqual(len(share["timeline"]["offsets"]), len(share["timeline"]["events"]))
        self.assertIn(0, share["timeline"]["offsets"])
        self.assertIsNone(run["timeline"], "only a condition measure has a day-by-day share")
        self.assertIsNotNone(run["window_bars"], "an episode reports its lengths")
        self.assertIn("measure_1_from", result["events"]["columns"])
        self.assertNotIn("measure_0_from", result["events"]["columns"])
        # The control dates were measured the same way.
        self.assertIn("measure_0", control)
        self.assertTrue(set(control["measure_0_status"]) <= set(msr.STATUSES))

    def test_the_history_loaded_reaches_back_as_far_as_any_window(self):
        deep = ts.spec(lookback_windows=[21], measures=[{"stat": "return", "window": {"start": {"offset": -600}, "end": {"offset": 0}}}])
        self.assertGreaterEqual(study.history_bars(study.normalize_spec(deep)), 600)
        anchored = ts.spec(lookback_windows=[21], measures=[{"stat": "length", "window": {"start": {"find": "lowest", "feature": "close", "within": 700}, "end": {"offset": 0}}}])
        self.assertGreaterEqual(study.history_bars(study.normalize_spec(anchored)), 700)

    def test_a_measure_joins_the_significance_tests(self):
        winners = {f"zerodha:NSE:W{i}": ts.features_of(ts.doubler() * (1 + i / 100)) for i in range(30)}
        drifters = {f"zerodha:NSE:D{i}": ts.features_of(ts.wobble(i)) for i in range(30)}
        self.data = {**winners, **drifters}
        measured, control, result = self.analyzed()
        test = result["measures"][0]["test"]
        self.assertIsNotNone(test)
        self.assertIsNotNone(test["q"])
        kinds = {f["kind"] for f in result["summary"]["findings"]}
        self.assertIn("measure", kinds)

    def test_arrays_handed_back_are_writable_under_copy_on_write(self):
        f = random_series(1)
        held, known = msr.evaluate_known(f, [{"left": "close", "op": ">", "right": "ema_20"}])
        held[0] = not held[0]
        known[0] = not known[0]
        got = msr.measure_symbol(msr.normalize_measure({"stat": "return", "window": {"start": {"offset": -10}, "end": {"offset": 0}}}, "m"), f, np.array([100]))
        got["value"][0] = 1.0


if __name__ == "__main__":
    unittest.main()
