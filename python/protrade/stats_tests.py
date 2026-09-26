"""The statistics a Study uses to say whether a difference is more than noise.

Standard library and numpy/pandas only (no scipy): a Mann–Whitney U test for a measurement, a
two-proportion test for a yes/no characteristic, and Benjamini–Hochberg to account for a Study
making dozens of comparisons at once. None of this turns an association into a cause.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

# Fewer values than this on either side and a test says nothing useful.
MIN_PER_GROUP = 5
# Cliff's delta thresholds (Romano et al.): below SMALL is negligible.
SMALL, MEDIUM, LARGE = 0.147, 0.33, 0.474
Z_95 = 1.959963984540054


def _finite(values) -> np.ndarray:
    array = np.asarray(pd.to_numeric(pd.Series(values), errors="coerce"), dtype="float64")
    return array[np.isfinite(array)]


def normal_two_sided_p(z: float) -> float:
    """The chance of a standard normal value at least ``|z|`` from zero."""
    return math.erfc(abs(z) / math.sqrt(2))


def mann_whitney(a, b) -> dict | None:
    """Two-sided Mann–Whitney U test of ``a`` against ``b``, with ties corrected and a normal
    approximation (fine at the sizes a Study has). ``effect`` is Cliff's delta: +1 when every value
    of ``a`` is above every value of ``b``, −1 the other way, 0 when they are mixed evenly.
    ``None`` when either side has fewer than :data:`MIN_PER_GROUP` values."""
    x, y = _finite(a), _finite(b)
    n1, n2 = len(x), len(y)
    if n1 < MIN_PER_GROUP or n2 < MIN_PER_GROUP:
        return None
    ranks = pd.Series(np.concatenate([x, y])).rank(method="average").to_numpy()
    u1 = float(ranks[:n1].sum() - n1 * (n1 + 1) / 2)
    mean = n1 * n2 / 2
    n = n1 + n2
    _, counts = np.unique(np.concatenate([x, y]), return_counts=True)
    ties = float((counts**3 - counts).sum())
    variance = n1 * n2 / 12 * ((n + 1) - ties / (n * (n - 1)))
    if variance <= 0:
        p = 1.0  # every value is the same
    else:
        # Continuity correction, as most references apply it.
        z = (abs(u1 - mean) - 0.5) / math.sqrt(variance)
        p = normal_two_sided_p(max(z, 0.0))
    return {"u": u1, "p": min(1.0, p), "effect": 2 * u1 / (n1 * n2) - 1, "n1": n1, "n2": n2}


def _wilson(k: int, n: int) -> tuple[float, float]:
    """95% Wilson score interval for a proportion."""
    if n == 0:
        return (math.nan, math.nan)
    p = k / n
    z2 = Z_95**2
    centre = (p + z2 / (2 * n)) / (1 + z2 / n)
    half = Z_95 * math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / (1 + z2 / n)
    return centre - half, centre + half


def two_proportions(k1: int, n1: int, k2: int, n2: int) -> dict | None:
    """The difference between two shares (``k1/n1 − k2/n2``) with Newcombe's 95% interval (from two
    Wilson intervals) and a two-proportion z-test. ``None`` when either group is too small."""
    if n1 < MIN_PER_GROUP or n2 < MIN_PER_GROUP:
        return None
    p1, p2 = k1 / n1, k2 / n2
    diff = p1 - p2
    l1, u1 = _wilson(k1, n1)
    l2, u2 = _wilson(k2, n2)
    low = diff - math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2)
    high = diff + math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2)
    pooled = (k1 + k2) / (n1 + n2)
    se = math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2))
    p = 1.0 if se == 0 else normal_two_sided_p(diff / se)
    return {"diff": diff, "low": low, "high": high, "p": p, "n1": n1, "n2": n2}


def benjamini_hochberg(ps) -> list[float | None]:
    """False-discovery-rate q-values for a list of p-values (``None`` stays ``None``): the smallest
    FDR at which each test would count as a discovery."""
    indexed = [(p, i) for i, p in enumerate(ps) if p is not None and math.isfinite(p)]
    out: list[float | None] = [None] * len(ps)
    m = len(indexed)
    if m == 0:
        return out
    indexed.sort()
    running = 1.0
    for rank in range(m, 0, -1):
        p, i = indexed[rank - 1]
        running = min(running, p * m / rank)
        out[i] = min(1.0, running)
    return out


def effect_size_word(effect: float | None) -> str | None:
    """Cliff's delta as a word: negligible, small, medium or large."""
    if effect is None or not math.isfinite(effect):
        return None
    size = abs(effect)
    if size < SMALL:
        return "negligible"
    if size < MEDIUM:
        return "small"
    if size < LARGE:
        return "medium"
    return "large"
