"""Every feature computed for many symbols at once (`protrade.wide`) must equal the same feature
computed one symbol at a time (`protrade.features.Features`), which Studies and screens are built on."""

import unittest

import support  # noqa: F401  (puts the package on the path)

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from protrade import features as feat  # noqa: E402
from protrade.wide import WideFeatures  # noqa: E402

# Every family, at a short and a long window; and the plain ones.
WINDOWS = (3, 14, 50)
NAMES = list(feat.PLAIN) + [f"{family}_{n}" for family in feat.FAMILIES for n in WINDOWS]
# The same on weekly and monthly bars, for a cross-section of families.
NAMES += [f"{name}@{tf}" for tf in ("W", "M") for name in ("close", "volume", "gap", "rsi_3", "ema_3", "sma_14", "atr_3", "rs_3", "high_3", "macd", "rvol_3")]


def series(seed: int, n: int, start: str, volume: bool = True, flat: bool = False) -> pd.DataFrame:
    """`n` business-day bars from `start`: a random walk (or a flat line), with a few gaps."""
    rng = np.random.default_rng(seed)
    days = pd.bdate_range(start, periods=n + n // 20)
    days = days[np.sort(rng.choice(len(days), size=n, replace=False))]
    close = np.full(n, 100.0) if flat else 100 * np.exp(np.cumsum(rng.normal(0, 0.02, n)))
    spread = 0.0 if flat else rng.uniform(0.0, 0.03, n)
    return pd.DataFrame(
        {
            "open": close * (1 + rng.normal(0, 0.005, n) * (not flat)),
            "high": close * (1 + spread),
            "low": close * (1 - spread),
            "close": close,
            "volume": rng.uniform(1e5, 1e6, n) if volume else np.full(n, np.nan),
        },
        index=days,
    )


FRAMES = {
    "long": series(1, 400, "2023-01-02"),
    "short": series(2, 60, "2024-03-01"),
    "tiny": series(3, 2, "2024-06-03"),
    "late": series(4, 250, "2023-11-01"),
    "index": series(5, 380, "2023-01-16", volume=False),
    "flat": series(6, 120, "2024-01-01", flat=True),
    "empty": series(7, 0, "2024-01-01"),
}
BENCHMARK = series(8, 420, "2022-12-01")["close"]


class WideMatchesPerSymbol(unittest.TestCase):
    def setUp(self):
        self.wide = WideFeatures(FRAMES, BENCHMARK)
        self.one = {s: feat.Features(f, BENCHMARK) for s, f in FRAMES.items()}

    def column(self, name: str, symbol: str) -> np.ndarray:
        """The wide result's values for one symbol's own bars."""
        n = len(FRAMES[symbol])
        return self.wide.get(name)[symbol].to_numpy()[len(self.wide) - n :]

    def test_every_feature_family_matches_for_every_kind_of_series(self):
        for name in NAMES:
            for symbol, frame in FRAMES.items():
                with self.subTest(feature=name, symbol=symbol):
                    expected = self.one[symbol].get(name).to_numpy()
                    got = self.column(name, symbol)
                    np.testing.assert_array_equal(np.isnan(got), np.isnan(expected))
                    np.testing.assert_allclose(got, expected, rtol=1e-12, atol=1e-12, equal_nan=True)

    def test_rows_above_a_symbols_first_bar_stay_blank(self):
        for name in ("ema_3", "adx_14", "rs_3", "atr_3", "macd", "stoch_d_3"):
            top = self.wide.get(name)["short"].to_numpy()[: len(self.wide) - len(FRAMES["short"])]
            self.assertTrue(np.isnan(top).all(), name)

    def test_conditions_match_including_crossings_on_the_latest_bar(self):
        conditions = [
            {"left": "close", "op": ">", "right": "sma_14"},
            {"left": "rsi_14", "op": "<", "right": 30},
            {"left": "close", "op": "crosses_above", "right": "ema_3"},
            {"left": "return_3", "op": "crosses_below", "right": 0},
            {"left": "rs_14", "op": ">=", "right": 0.0},
            {"left": "rsi_14", "op": "between", "right": [40, 60]},
            {"left": "gap", "op": "outside", "right": [-0.01, 0.01]},
            {"left": "close@W", "op": "crosses_above", "right": "ema_3@W"},
            {"left": "rsi_3@W", "op": ">", "right": 50},
            {"left": "close", "op": ">", "right": "sma_3@M"},
            {"left": "close@M", "op": "crosses_below", "right": "sma_14"},
        ]
        for condition in conditions:
            wide = feat.evaluate(self.wide, condition)
            for symbol, frame in FRAMES.items():
                with self.subTest(condition=condition, symbol=symbol):
                    expected = feat.evaluate(self.one[symbol], condition).to_numpy()
                    got = wide[symbol].to_numpy()[len(self.wide) - len(frame) :]
                    np.testing.assert_array_equal(got, expected)

    def test_without_a_benchmark_relative_strength_is_blank(self):
        wide = WideFeatures(FRAMES)
        self.assertTrue(wide.get("rs_14").isna().all().all())

    def test_each_symbols_latest_date_is_its_own(self):
        latest = self.wide.latest_dates()
        self.assertEqual(latest["late"], FRAMES["late"].index[-1])
        self.assertEqual(latest["tiny"], FRAMES["tiny"].index[-1])
        self.assertTrue(pd.isna(latest["empty"]))


if __name__ == "__main__":
    unittest.main()
