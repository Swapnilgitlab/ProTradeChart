"""Tests for the Study's significance tests. Expected values were computed with scipy
(mannwhitneyu, asymptotic, continuity-corrected) and statsmodels (Newcombe interval,
proportions_ztest, fdr_bh), which the package itself doesn't depend on."""

import math
import unittest

import support  # noqa: F401  (puts the package on the path)

from protrade import stats_tests as st  # noqa: E402


class MannWhitneyTests(unittest.TestCase):
    def test_matches_scipy_with_ties(self):
        a = [0.1, 0.4, 0.4, 1.2, -0.3, 0.9, 0.4, 2.0]
        b = [-0.5, 0.4, -1.1, 0.0, -0.2, 0.3, -0.8]
        r = st.mann_whitney(a, b)
        # scipy.stats.mannwhitneyu(a, b, alternative="two-sided", method="asymptotic") -> U=48.5, p=0.019517
        self.assertEqual(r["u"], 48.5)
        self.assertAlmostEqual(r["p"], 0.019517, places=6)
        self.assertAlmostEqual(r["effect"], 48.5 * 2 / 56 - 1)

    def test_fully_separated_groups_have_the_largest_effect(self):
        r = st.mann_whitney([1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11])
        self.assertEqual((r["u"], r["effect"]), (0.0, -1.0))
        self.assertAlmostEqual(r["p"], 0.008113, places=6)

    def test_identical_groups_differ_by_nothing(self):
        r = st.mann_whitney([3] * 6, [3] * 7)
        self.assertEqual((r["p"], r["effect"]), (1.0, 0.0))

    def test_too_few_values_is_no_test(self):
        self.assertIsNone(st.mann_whitney([1, 2, 3, 4], [5, 6, 7, 8, 9]))
        self.assertIsNone(st.mann_whitney([1, 2, 3, 4, float("nan"), None], [5, 6, 7, 8, 9]))


class ProportionTests(unittest.TestCase):
    def test_matches_statsmodels(self):
        r = st.two_proportions(30, 50, 20, 60)
        self.assertAlmostEqual(r["diff"], 0.266667, places=6)
        self.assertAlmostEqual(r["low"], 0.079595, places=6)
        self.assertAlmostEqual(r["high"], 0.429761, places=6)
        self.assertAlmostEqual(r["p"], 0.005161, places=6)

    def test_small_groups_and_equal_shares(self):
        self.assertIsNone(st.two_proportions(1, 4, 2, 10))
        self.assertEqual(st.two_proportions(0, 10, 0, 12)["p"], 1.0)


class FdrTests(unittest.TestCase):
    def test_matches_statsmodels_and_keeps_gaps(self):
        qs = st.benjamini_hochberg([0.01, 0.04, 0.03, 0.2, 0.001, None, 0.5])
        expected = [0.03, 0.06, 0.06, 0.24, 0.006, None, 0.5]
        for q, e in zip(qs, expected):
            if e is None:
                self.assertIsNone(q)
            else:
                self.assertAlmostEqual(q, e)

    def test_q_values_never_fall_below_p_and_keep_the_order(self):
        ps = [0.001, 0.002, 0.2, 0.9, 0.04]
        qs = st.benjamini_hochberg(ps)
        self.assertTrue(all(q >= p for p, q in zip(ps, qs)))
        order = sorted(range(len(ps)), key=ps.__getitem__)
        self.assertEqual(order, sorted(range(len(qs)), key=qs.__getitem__))
        self.assertEqual(st.benjamini_hochberg([]), [])

    def test_effect_words(self):
        self.assertEqual([st.effect_size_word(x) for x in (0.1, -0.2, 0.4, -0.9)], ["negligible", "small", "medium", "large"])
        self.assertIsNone(st.effect_size_word(None))
        self.assertIsNone(st.effect_size_word(math.nan))


if __name__ == "__main__":
    unittest.main()
