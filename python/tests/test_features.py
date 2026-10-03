"""Tests for the feature layer: its grammar, its numbers, and how conditions are judged."""

import math
import unittest

import support  # noqa: F401  (puts the package on the path)

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from protrade import features as feat  # noqa: E402


def frame(closes, volumes=None, spread=0.0):
    index = pd.date_range("2020-01-01", periods=len(closes), freq="B")
    closes = np.asarray(closes, dtype="float64")
    return pd.DataFrame(
        {
            "open": closes,
            "high": closes * (1 + spread),
            "low": closes * (1 - spread),
            "close": closes,
            "volume": np.asarray(volumes if volumes is not None else [1000.0] * len(closes), dtype="float64"),
        },
        index=index,
    )


class GrammarTests(unittest.TestCase):
    def test_names_are_canonical_and_aliases_resolve(self):
        self.assertEqual(feat.canonical("EMA_200"), "ema_200")
        self.assertEqual(feat.canonical("return_12m"), "return_252")
        self.assertEqual(feat.canonical("distance_from_52w_high"), "dist_high_252")
        self.assertEqual(feat.canonical("relative_volume"), "rvol_20")
        self.assertEqual(feat.canonical("close"), "close")
        self.assertEqual(feat.split("dist_sma_50"), ("dist_sma", 50))
        self.assertEqual(feat.split("macd_hist"), ("macd_hist", None))

    def test_unknown_names_and_windows_are_refused(self):
        for bad in ("ema", "ema_0", "ema_1001", "foo_20", "", "rsi_x", 7):
            with self.assertRaises(feat.FeatureError, msg=bad):
                feat.canonical(bad)

    def test_warmup_covers_what_a_feature_reads(self):
        self.assertEqual(feat.warmup("ema_200"), 200)
        self.assertEqual(feat.warmup("slope_sma_200"), 221)
        self.assertGreaterEqual(feat.warmup("rsi_14"), 14)


class ComputationTests(unittest.TestCase):
    def test_returns_and_moving_averages(self):
        f = feat.Features(frame([100, 110, 121, 133.1]))
        self.assertTrue(math.isnan(f.get("return_1").iloc[0]))
        self.assertAlmostEqual(f.get("return_1").iloc[1], 0.10)
        self.assertAlmostEqual(f.get("return_3").iloc[3], 0.331)
        self.assertAlmostEqual(f.get("sma_2").iloc[1], 105)
        self.assertTrue(math.isnan(f.get("ema_3").iloc[1]), "an average waits for a full window")
        self.assertFalse(math.isnan(f.get("ema_3").iloc[2]))

    def test_rsi_is_100_when_there_are_no_losses_and_near_50_when_balanced(self):
        rising = feat.Features(frame(np.arange(1, 60, dtype=float)))
        self.assertEqual(rising.get("rsi_14").iloc[-1], 100.0)
        zigzag = feat.Features(frame([100 + (i % 2) for i in range(80)]))
        self.assertAlmostEqual(zigzag.get("rsi_14").iloc[-1], 50, delta=5)

    def test_highs_lows_and_distances(self):
        f = feat.Features(frame([10, 20, 15, 12], spread=0.0))
        self.assertEqual(f.get("high_3").iloc[3], 20)
        self.assertEqual(f.get("prior_high_3").iloc[3], 20)
        self.assertAlmostEqual(f.get("dist_high_3").iloc[3], 12 / 20 - 1)
        self.assertAlmostEqual(f.get("dist_low_3").iloc[3], 0.0)
        self.assertAlmostEqual(f.get("drawdown_3").iloc[3], 12 / 20 - 1)

    def test_relative_volume_compares_with_the_bars_before(self):
        f = feat.Features(frame([10] * 6, volumes=[100, 100, 100, 100, 100, 400]))
        self.assertAlmostEqual(f.get("rvol_5").iloc[5], 4.0)
        self.assertAlmostEqual(f.get("avg_traded_value_2").iloc[1], 1000.0)

    def test_max_drawdown_is_the_worst_fall_inside_the_window(self):
        f = feat.Features(frame([100, 80, 120, 90, 110]))
        self.assertAlmostEqual(f.get("max_drawdown_3").iloc[2], -0.2)
        self.assertAlmostEqual(f.get("max_drawdown_3").iloc[4], -0.25)

    def test_relative_strength_needs_and_uses_the_benchmark(self):
        bars = frame([100, 100, 150])
        self.assertTrue(f_nan(feat.Features(bars).get("rs_2").iloc[2]))
        bench = pd.Series([100.0, 110.0, 110.0], index=bars.index)
        self.assertAlmostEqual(feat.Features(bars, bench).get("rs_2").iloc[2], 0.5 - 0.1)

    def test_every_family_computes_on_real_looking_data(self):
        rng = np.random.default_rng(1)
        closes = 100 * np.exp(np.cumsum(rng.normal(0, 0.02, 400)))
        bars = frame(closes, volumes=rng.integers(1000, 5000, 400), spread=0.01)
        f = feat.Features(bars, pd.Series(closes * 0.5, index=bars.index))
        for family in feat.FAMILIES:
            value = f.get(f"{family}_20").iloc[-1]
            self.assertTrue(np.isfinite(value), family)
        for plain in feat.PLAIN:
            self.assertTrue(np.isfinite(f.get(plain).iloc[-1]), plain)


def f_nan(x):
    return isinstance(x, float) and math.isnan(x)


class ConditionTests(unittest.TestCase):
    def test_conditions_are_read_from_text_or_dicts(self):
        self.assertEqual(feat.parse_condition("return_12m crosses_above 1.0"), {"left": "return_252", "op": "crosses_above", "right": 1.0})
        self.assertEqual(feat.parse_condition("close > EMA_200"), {"left": "close", "op": ">", "right": "ema_200"})
        self.assertEqual(feat.parse_condition({"left": "rsi_14", "op": "<", "right": 30, "label": "Oversold"})["label"], "Oversold")
        for bad in ("close", "close ~ 3", {"left": "close", "op": "=", "right": 1}, {"left": "close", "op": ">", "right": True}):
            with self.assertRaises(feat.FeatureError, msg=bad):
                feat.parse_condition(bad)

    def test_a_cross_is_the_bar_it_happens_on_only(self):
        f = feat.Features(frame([1, 2, 3, 2, 1, 2, 3]))
        crossed = feat.evaluate(f, feat.parse_condition("close crosses_above 2.5"))
        self.assertEqual(list(crossed), [False, False, True, False, False, False, True])
        above = feat.evaluate(f, feat.parse_condition("close >= 2"))
        self.assertEqual(list(above), [False, True, True, True, False, True, True])

    def test_an_unknown_value_never_satisfies_a_condition(self):
        f = feat.Features(frame([1, 2, 3]))
        self.assertEqual(list(feat.evaluate(f, feat.parse_condition("return_1 > -5"))), [False, True, True])


class PriceChangeAndGapTests(unittest.TestCase):
    def setUp(self):
        days = pd.bdate_range("2024-01-01", periods=3)
        self.f = feat.Features(
            pd.DataFrame(
                {"open": [100.0, 103.0, 98.0], "high": [101.0, 104.0, 99.0], "low": [99.0, 102.0, 97.0], "close": [100.0, 102.0, 99.0], "volume": [1.0, 1.0, 1.0]},
                index=days,
            )
        )

    def test_a_gap_is_the_open_against_the_previous_close(self):
        np.testing.assert_allclose(self.f.get("gap").to_numpy()[1:], [0.03, 98 / 102 - 1])
        self.assertTrue(math.isnan(self.f.get("gap").iloc[0]))
        np.testing.assert_allclose(self.f.get("gap_up").to_numpy()[1:], [0.03, 0.0])
        np.testing.assert_allclose(self.f.get("gap_down").to_numpy()[1:], [0.0, 1 - 98 / 102])
        self.assertTrue(math.isnan(self.f.get("gap_down").iloc[0]))

    def test_price_change_is_in_rupees(self):
        np.testing.assert_allclose(self.f.get("change_1").to_numpy()[1:], [2.0, -3.0])
        np.testing.assert_allclose(self.f.get("change_2").to_numpy()[2:], [-1.0])


class IntervalTests(unittest.TestCase):
    def setUp(self):
        # Mon 1 Jan 2024 to Wed 17 Jan: two whole weeks, then three days of a third.
        days = pd.bdate_range("2024-01-01", "2024-01-17")
        closes = np.arange(len(days), dtype=float) + 100
        self.days = days
        self.f = feat.Features(
            pd.DataFrame({"open": closes - 0.5, "high": closes + 1, "low": closes - 1, "close": closes, "volume": np.ones(len(days))}, index=days)
        )

    def test_names_carry_an_interval_and_daily_is_bare(self):
        self.assertEqual(feat.canonical("RSI_14@w"), "rsi_14@W")
        self.assertEqual(feat.canonical("close@D"), "close")
        self.assertEqual((feat.interval("ema_50@M"), feat.base("ema_50@M")), ("M", "ema_50"))
        self.assertEqual(feat.warmup("ema_50@W"), 250)
        with self.assertRaises(feat.FeatureError):
            feat.canonical("close@H")

    def test_a_week_ends_on_friday_and_each_day_reads_its_weeks_bar(self):
        weekly_close = self.f.get("close@W")
        self.assertEqual(weekly_close[self.days[0]], 104.0, "the first week's Friday close")
        self.assertEqual(weekly_close[self.days[-1]], 112.0, "the week still forming, as of its latest day")
        self.assertEqual(self.f.get("volume@W")[self.days[0]], 5.0)
        self.assertEqual(self.f.get("high@M")[self.days[-1]], 113.0)

    def test_a_weekly_cross_is_this_week_against_last_week(self):
        crossed = feat.evaluate(self.f, feat.parse_condition("close@W crosses_above 106"))
        self.assertFalse(crossed[self.days[0]])
        self.assertTrue(crossed[self.days[5]] and crossed[self.days[9]], "the whole second week")
        self.assertFalse(crossed[self.days[-1]], "already above last week")


class RangeConditionTests(unittest.TestCase):
    def test_between_includes_its_ends_and_outside_excludes_them(self):
        f = feat.Features(frame([10, 20, 30, 40]))
        self.assertEqual(list(feat.evaluate(f, {"left": "close", "op": "between", "right": [20, 30]})), [False, True, True, False])
        self.assertEqual(list(feat.evaluate(f, {"left": "close", "op": "outside", "right": [20, 30]})), [True, False, False, True])

    def test_a_range_needs_two_numbers_low_first(self):
        self.assertEqual(feat.parse_condition({"left": "rsi_14", "op": "between", "right": [40, 60]})["right"], [40, 60])
        for right in (50, [60, 40], [40], ["a", 1], "ema_50"):
            with self.assertRaises(feat.FeatureError, msg=right):
                feat.parse_condition({"left": "rsi_14", "op": "between", "right": right})
        with self.assertRaises(feat.FeatureError):
            feat.parse_condition({"left": "rsi_14", "op": ">", "right": [40, 60]})


if __name__ == "__main__":
    unittest.main()
