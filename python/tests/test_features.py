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


if __name__ == "__main__":
    unittest.main()
