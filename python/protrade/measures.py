"""Measures: what a Study reads *over a stretch of time* around each event.

A snapshot (``metrics`` and ``characteristics`` in a Study Specification) reads one bar: RSI on the day
the stock doubled, or three months before. A *measure* reads a window of bars and sums it up, one
number per event: on how many of the 252 days before the event it closed within 3% of its 21 EMA, the
longest such streak, how long the run from its 12-month low took, how far it fell in the six months
after. That is how a Study looks at the journey to an event, at its aftermath, or at an episode
between two bars it finds (the stock's low; the day its trend broke).

The window model, which ``src/studies/measures.ts`` states in the same words:

* A window runs from bar A to bar B, A < B, and ``length = B - A``.
* Stats that count days read bars ``A+1 … B``; price stats read the closes at A and B (and the path
  between). So ``{offset: -252} → {offset: 0}`` covers the 252 days up to and including the event bar,
  and its ``return`` is ``return_252``; ``{0} → {126}`` covers the 126 days after, and its return is
  ``fwd_return_126``.
* An endpoint is a fixed offset from the event, or a bar found near it: the ``lowest`` or ``highest``
  value of a feature, or the ``first`` or ``last`` bar on which some conditions all held, searched in
  ``[event-within, event]`` (before) or ``[event+1, event+within]`` (after). A before-search never
  reads a bar after the event.
* Nothing is filled in. Every event gets a status: ``ok``; ``capped`` (a first/last that didn't happen
  within ``within`` bars, so the window runs to that edge and the value is a lower bound);
  ``never`` (a ``bars_to_first``/``bars_since_last`` whose conditions never held in the window);
  ``too_recent`` (the window runs past the last bar); ``no_history`` (it reaches before the first bar,
  or a bar it reads has no value yet); ``not_found`` (a first/last that didn't happen, with
  ``if_not_found: skip``); ``empty`` (A is not before B). Only ``ok``, ``capped`` and ``never`` carry
  a value.

Pure numpy over one symbol's arrays; ``ResearchStudy.measure`` calls :func:`measure_symbol` per symbol.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from . import features as feat

CONDITION_STATS = ("share", "count", "longest_run", "runs", "bars_to_first", "bars_since_last")
FEATURE_STATS = ("mean", "min", "max", "start_value", "end_value", "change")
PRICE_STATS = ("return", "max_gain", "max_drawdown", "length")
STATS = CONDITION_STATS + FEATURE_STATS + PRICE_STATS
# Censored stats: an event whose conditions never held in the window has no number, only "never".
CENSORED = ("bars_to_first", "bars_since_last")
FINDS = ("lowest", "highest", "first", "last")
DIRECTIONS = ("before", "after")
IF_NOT_FOUND = ("skip", "cap")
STATUSES = ("ok", "capped", "never", "too_recent", "no_history", "not_found", "empty")
MEASURED = ("ok", "capped", "never")

MAX_MEASURES = 12
MAX_HEADLINES = 3
MAX_QUESTION = 500
MAX_LABEL = 120
MAX_MEASURE_CONDITIONS = 8
MAX_OFFSET = 1000
TIMELINE_POINTS = 120


class MeasureError(ValueError):
    """A measure the engine can't run. ``study.normalize_spec`` turns it into a ``SpecError``."""


# ---- The specification ---------------------------------------------------------------------------


def _whole(value, field: str, low: int, high: int, default: int | None = None) -> int:
    if value is None:
        if default is None:
            raise MeasureError(f"{field} is required.")
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != int(value):
        raise MeasureError(f"{field} must be a whole number.")
    if not low <= value <= high:
        raise MeasureError(f"{field} must be between {low} and {high}.")
    return int(value)


def _conditions(value, field: str, need_one: bool) -> list[dict]:
    if value is None:
        value = []
    if not isinstance(value, list):
        raise MeasureError(f"{field} must be a list of conditions.")
    if need_one and not value:
        raise MeasureError(f"{field} needs 1 to {MAX_MEASURE_CONDITIONS} conditions.")
    if len(value) > MAX_MEASURE_CONDITIONS:
        raise MeasureError(f"{field} can hold at most {MAX_MEASURE_CONDITIONS} conditions.")
    out = []
    for i, item in enumerate(value):
        try:
            out.append(feat.parse_condition(item))
        except feat.FeatureError as e:
            raise MeasureError(f"{field}[{i}]: {e}") from None
    return out


def _feature(value, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise MeasureError(f"{field} needs a feature.")
    try:
        return feat.canonical(value)
    except feat.FeatureError as e:
        raise MeasureError(f"{field}: {e}") from None


def normalize_endpoint(value, field: str) -> dict:
    """``{"offset": k}``, or an anchor with every key present."""
    if not isinstance(value, dict):
        raise MeasureError(f"{field} must be {{offset}} or {{find, …}}.")
    if "find" not in value:
        if "offset" not in value:
            raise MeasureError(f"{field} must be {{offset}} or {{find, …}}.")
        return {"offset": _whole(value.get("offset"), f"{field}.offset", -MAX_OFFSET, MAX_OFFSET)}
    find = value.get("find")
    if find not in FINDS:
        raise MeasureError(f"{field}.find must be lowest, highest, first or last.")
    direction = value.get("direction", "before")
    if direction not in DIRECTIONS:
        raise MeasureError(f"{field}.direction must be before or after.")
    if_not_found = value.get("if_not_found", "cap")
    if if_not_found not in IF_NOT_FOUND:
        raise MeasureError(f"{field}.if_not_found must be skip or cap.")
    within = _whole(value.get("within"), f"{field}.within", 1, MAX_OFFSET)
    if find in ("lowest", "highest"):
        return {
            "find": find,
            "feature": _feature(value.get("feature"), f"{field}.feature"),
            "conditions": [],
            "direction": direction,
            "within": within,
            "if_not_found": if_not_found,
        }
    return {
        "find": find,
        "feature": None,
        "conditions": _conditions(value.get("conditions"), f"{field}.conditions", need_one=True),
        "direction": direction,
        "within": within,
        "if_not_found": if_not_found,
    }


def endpoint_range(endpoint: dict) -> tuple[int, int]:
    """The bars (from the event) an endpoint can resolve to: ``[k, k]`` for a fixed one, the searched
    range for an anchor."""
    if "offset" in endpoint:
        return endpoint["offset"], endpoint["offset"]
    if endpoint["direction"] == "before":
        return -endpoint["within"], 0
    return 1, endpoint["within"]


def is_anchored(window: dict) -> bool:
    return "find" in window["start"] or "find" in window["end"]


def side(window: dict) -> str:
    """``before`` when the window can't reach past the event bar, ``after`` when it can't start before
    it, ``spanning`` otherwise."""
    if endpoint_range(window["end"])[1] <= 0:
        return "before"
    if endpoint_range(window["start"])[0] >= 0:
        return "after"
    return "spanning"


def default_label(stat: str, conditions: list[dict], feature: str | None) -> str:
    if stat in CONDITION_STATS:
        return " and ".join(feat.describe_condition(c) for c in conditions)
    if stat in FEATURE_STATS:
        return f"{stat} of {feature}"
    return stat


def normalize_measure(value, field: str) -> dict:
    if not isinstance(value, dict):
        raise MeasureError(f"{field} must be an object.")
    stat = value.get("stat")
    if stat not in STATS:
        raise MeasureError(f"{field}.stat must be one of {', '.join(STATS)}.")
    conditions = _conditions(value.get("conditions"), f"{field}.conditions", need_one=True) if stat in CONDITION_STATS else []
    feature = _feature(value.get("feature"), f"{field}.feature") if stat in FEATURE_STATS else None
    window = value.get("window")
    if not isinstance(window, dict) or "start" not in window or "end" not in window:
        raise MeasureError(f"{field}.window needs a start and an end.")
    start = normalize_endpoint(window.get("start"), f"{field}.window.start")
    end = normalize_endpoint(window.get("end"), f"{field}.window.end")
    window = {"start": start, "end": end}
    if endpoint_range(start)[0] >= endpoint_range(end)[1]:
        raise MeasureError(f"{field}.window can never contain a bar: its start can't come before its end.")
    if stat == "length" and not is_anchored(window):
        raise MeasureError(f"{field}: length needs a window with a found start or end (a fixed window is the same length for every event).")
    label = value.get("label")
    if label is not None and not isinstance(label, str):
        raise MeasureError(f"{field}.label must be text.")
    label = label.strip() if isinstance(label, str) and label.strip() else default_label(stat, conditions, feature)
    if len(label) > MAX_LABEL:
        raise MeasureError(f"{field}.label can be at most {MAX_LABEL} characters.")
    return {
        "label": label,
        "stat": stat,
        "conditions": conditions,
        "feature": feature,
        "window": window,
        "headline": bool(value.get("headline", False)),
    }


def normalize_measures(value) -> list[dict]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise MeasureError("measures must be a list.")
    if len(value) > MAX_MEASURES:
        raise MeasureError(f"measures can hold at most {MAX_MEASURES} measures.")
    out = [normalize_measure(item, f"measures[{i}]") for i, item in enumerate(value)]
    if sum(1 for m in out if m["headline"]) > MAX_HEADLINES:
        raise MeasureError(f"At most {MAX_HEADLINES} measures can be headline measures.")
    return out


def measure_features(measure: dict) -> list[str]:
    """Every feature a measure reads, anchors included."""
    names: list[str] = ["close"]
    for condition in measure["conditions"]:
        names += feat.condition_features(condition)
    if measure["feature"]:
        names.append(measure["feature"])
    for endpoint in (measure["window"]["start"], measure["window"]["end"]):
        if "find" in endpoint:
            if endpoint["feature"]:
                names.append(endpoint["feature"])
            for condition in endpoint["conditions"]:
                names += feat.condition_features(condition)
    return list(dict.fromkeys(names))


def _uses_cross(measure: dict) -> bool:
    groups = [measure["conditions"]] + [e["conditions"] for e in (measure["window"]["start"], measure["window"]["end"]) if "find" in e]
    return any(c["op"].startswith("crosses") for group in groups for c in group)


def reach(measure: dict) -> int:
    """How many bars before the event a measure can read (0 when it only reads after it)."""
    earliest = min(endpoint_range(measure["window"]["start"])[0], endpoint_range(measure["window"]["end"])[0])
    return max(0, -earliest) + (1 if _uses_cross(measure) else 0)


# ---- One symbol's arrays -------------------------------------------------------------------------


def evaluate_known(features: feat.Features, conditions: list[dict]) -> tuple[np.ndarray, np.ndarray]:
    """Where all ``conditions`` held (bool), and where they could be judged at all (bool): every input
    has a value, and for a cross, the bar before it too. Fresh, writable arrays."""
    n = len(features)
    held = np.ones(n, dtype=bool)
    known = np.ones(n, dtype=bool)
    for condition in conditions:
        held &= feat.evaluate(features, condition).to_numpy(dtype=bool, copy=True)
        for name in feat.condition_features(condition):
            has = features.get(name).notna().to_numpy(dtype=bool, copy=True)
            known &= has
            if condition["op"].startswith("crosses"):
                prev = np.zeros(n, dtype=bool)
                prev[1:] = has[:-1]
                known &= prev
    return held & known, known


def _prefix(mask: np.ndarray) -> np.ndarray:
    """``p[i]`` = how many of ``mask[0:i]`` are true, so ``p[b+1] - p[a]`` counts ``a…b``."""
    out = np.zeros(len(mask) + 1, dtype=np.int64)
    np.cumsum(mask, out=out[1:])
    return out


def _next_true(held: np.ndarray) -> np.ndarray:
    """``nt[i]`` = the first held bar at or after ``i`` (``n`` if none)."""
    n = len(held)
    idx = np.where(held, np.arange(n), n)
    return np.minimum.accumulate(idx[::-1])[::-1] if n else idx


def _prev_true(held: np.ndarray) -> np.ndarray:
    """``pt[i]`` = the last held bar at or before ``i`` (``-1`` if none)."""
    n = len(held)
    idx = np.where(held, np.arange(n), -1)
    return np.maximum.accumulate(idx) if n else idx


class _Anchor:
    """An anchor's arrays for one symbol, computed once and used for every event."""

    def __init__(self, endpoint: dict, features: feat.Features):
        self.endpoint = endpoint
        if endpoint["feature"]:
            self.values = features.get(endpoint["feature"]).to_numpy(dtype="float64", copy=True)
            self.unknown = _prefix(~np.isfinite(self.values))
        else:
            held, known = evaluate_known(features, endpoint["conditions"])
            self.next_true = _next_true(held)
            self.prev_true = _prev_true(held)
            self.unknown = _prefix(~known)


def _resolve(endpoint: dict, pos: np.ndarray, n: int, anchor: _Anchor | None) -> tuple[np.ndarray, np.ndarray]:
    """Each event's bar for ``endpoint``, and its status (``ok``/``capped``/``not_found``/
    ``too_recent``/``no_history``)."""
    idx = np.full(len(pos), -1, dtype=np.int64)
    status = np.full(len(pos), "ok", dtype=object)
    if "offset" in endpoint:
        target = pos + endpoint["offset"]
        idx[:] = target
        status[target < 0] = "no_history"
        status[target >= n] = "too_recent"
        return idx, status
    assert anchor is not None
    find, within, cap = endpoint["find"], endpoint["within"], endpoint["if_not_found"] == "cap"
    before = endpoint["direction"] == "before"

    def unknown(a: int, b: int) -> bool:  # any bar a…b (inclusive) that couldn't be judged
        return a <= b and anchor.unknown[b + 1] - anchor.unknown[a] > 0

    for i, p in enumerate(pos):
        lo, hi = (p - within, p) if before else (p + 1, p + within)
        if find in ("lowest", "highest"):
            if lo < 0:
                status[i] = "no_history"
            elif hi >= n:
                status[i] = "too_recent"
            elif unknown(lo, hi):
                status[i] = "no_history"
            else:
                window = anchor.values[lo: hi + 1][::-1]  # reversed, so ties go to the latest bar
                k = int(np.argmin(window) if find == "lowest" else np.argmax(window))
                idx[i] = hi - k
            continue
        if find == "last":
            # Searched from the end of the range backwards: found wherever the last held bar is.
            j = int(anchor.prev_true[min(hi, n - 1)]) if lo < n else -1
            if hi >= n:
                status[i] = "too_recent"  # bars after the data could hold a later one
                continue
            if j >= max(lo, 0):
                if unknown(j + 1, hi):
                    status[i] = "no_history"
                else:
                    idx[i] = j
                continue
            if lo < 0:
                status[i] = "no_history"
            elif unknown(lo, hi):
                status[i] = "no_history"
            elif cap:
                idx[i], status[i] = lo, "capped"
            else:
                status[i] = "not_found"
            continue
        # first: searched from the start of the range forwards.
        if lo < 0:
            status[i] = "no_history"
            continue
        j = int(anchor.next_true[lo]) if lo < n else n
        if j <= hi and j < n:
            if unknown(lo, j - 1):
                status[i] = "no_history"
            else:
                idx[i] = j
            continue
        if hi >= n:
            status[i] = "too_recent"
        elif unknown(lo, hi):
            status[i] = "no_history"
        elif cap:
            idx[i], status[i] = hi, "capped"
        else:
            status[i] = "not_found"
    return idx, status


def _combine(a_status: np.ndarray, b_status: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    status = np.full(len(a), "ok", dtype=object)
    for i in range(len(a)):
        sa, sb = a_status[i], b_status[i]
        if "no_history" in (sa, sb):
            status[i] = "no_history"
        elif "too_recent" in (sa, sb):
            status[i] = "too_recent"
        elif "not_found" in (sa, sb):
            status[i] = "not_found"
        elif a[i] >= b[i]:
            status[i] = "empty"
        elif "capped" in (sa, sb):
            status[i] = "capped"
    return status


def measure_symbol(measure: dict, features: feat.Features, pos: np.ndarray) -> dict:
    """One measure for one symbol's events at bars ``pos``: ``value`` (float; ``inf`` for ``never``,
    NaN where there is no value), ``status``, the window's start bar ``start`` (``-1`` if unresolved)
    and its length ``bars``."""
    n = len(features)
    pos = np.asarray(pos, dtype=np.int64)
    start_ep, end_ep = measure["window"]["start"], measure["window"]["end"]
    anchors = {
        key: _Anchor(ep, features) if "find" in ep else None for key, ep in (("start", start_ep), ("end", end_ep))
    }
    a, a_status = _resolve(start_ep, pos, n, anchors["start"])
    b, b_status = _resolve(end_ep, pos, n, anchors["end"])
    status = _combine(a_status, b_status, a, b)
    value = np.full(len(pos), np.nan)
    stat = measure["stat"]
    live = np.flatnonzero((status == "ok") | (status == "capped"))

    close = features.get("close").to_numpy(dtype="float64", copy=True)
    if stat in CONDITION_STATS:
        held, known = evaluate_known(features, measure["conditions"])
        held_sum, unknown_sum = _prefix(held), _prefix(~known)
        starts = held & ~np.concatenate([[False], held[:-1]])  # first bar of each stretch
        start_sum = _prefix(starts)
        next_true, prev_true = _next_true(held), _prev_true(held)
        for i in live:
            lo, hi = a[i] + 1, b[i]  # the bars counted
            if unknown_sum[hi + 1] - unknown_sum[lo] > 0:
                status[i] = "no_history"
                continue
            length = hi - lo + 1
            if stat in ("share", "count"):
                count = held_sum[hi + 1] - held_sum[lo]
                value[i] = count / length if stat == "share" else count
            elif stat == "runs":
                # Stretches that start inside the window, plus one already under way at its first bar.
                value[i] = start_sum[hi + 1] - start_sum[lo] + (1 if held[lo] and not starts[lo] else 0)
            elif stat == "longest_run":
                value[i] = _longest_run(held[lo: hi + 1])
            elif stat == "bars_to_first":
                j = next_true[lo]
                if j <= hi:
                    value[i] = j - a[i]
                else:
                    value[i], status[i] = math.inf, "never"
            else:  # bars_since_last
                j = prev_true[hi]
                if j >= lo:
                    value[i] = hi - j
                else:
                    value[i], status[i] = math.inf, "never"
    elif stat in FEATURE_STATS:
        x = features.get(measure["feature"]).to_numpy(dtype="float64", copy=True)
        for i in live:
            lo, hi = a[i], b[i]
            if stat in ("mean", "min", "max"):
                chunk = x[lo + 1: hi + 1]
                if not np.isfinite(chunk).all():
                    status[i] = "no_history"
                    continue
                value[i] = chunk.mean() if stat == "mean" else (chunk.min() if stat == "min" else chunk.max())
                continue
            first, last = x[lo], x[hi]
            needed = {"start_value": (first,), "end_value": (last,), "change": (first, last)}[stat]
            if not all(np.isfinite(v) for v in needed):
                status[i] = "no_history"
                continue
            value[i] = first if stat == "start_value" else (last if stat == "end_value" else last - first)
    else:
        for i in live:
            lo, hi = a[i], b[i]
            if stat == "length":
                value[i] = hi - lo
                continue
            path = close[lo: hi + 1]
            if not np.isfinite(path).all() or path[0] <= 0:
                status[i] = "no_history"
                continue
            if stat == "return":
                value[i] = path[-1] / path[0] - 1
            elif stat == "max_gain":
                value[i] = path[1:].max() / path[0] - 1
            else:  # max_drawdown: the worst fall from a running peak, on closes
                peaks = np.maximum.accumulate(path)
                value[i] = float((path / peaks - 1).min())

    resolved = (a >= 0) & (b >= 0) & np.isin(status, MEASURED)
    bars = np.where(resolved, b - a, np.nan).astype("float64")
    start = np.where(resolved, a, -1)
    return {"value": value, "status": status, "start": start, "bars": bars}


def _longest_run(held: np.ndarray) -> int:
    if not held.any():
        return 0
    padded = np.concatenate([[0], held.astype(np.int8), [0]])
    edges = np.flatnonzero(np.diff(padded))
    return int((edges[1::2] - edges[::2]).max())


# ---- Summaries -----------------------------------------------------------------------------------


def status_counts(statuses) -> dict:
    values = list(statuses) if statuses is not None else []
    return {s: sum(1 for v in values if v == s) for s in STATUSES}


def describe_censored(values, round_=lambda v: v) -> dict:
    """``describe`` for values that may include ``inf`` (``never``): percentiles from the ranks of
    every measured value, ``None`` where one lands among the ``never`` ones; mean and max ``None`` when
    any is ``never``."""
    array = np.asarray(pd.to_numeric(pd.Series(values), errors="coerce"), dtype="float64")
    array = array[~np.isnan(array)]
    if array.size == 0:
        return {"count": 0, "mean": None, "median": None, "min": None, "max": None, "p25": None, "p75": None}
    array = np.sort(array)
    has_never = bool(np.isinf(array).any())

    def pct(q: float):
        position = (array.size - 1) * q
        low, high = int(math.floor(position)), int(math.ceil(position))
        a, b = array[low], array[high]
        if not (math.isfinite(a) and math.isfinite(b)):
            return None
        return round_(a + (b - a) * (position - low))

    finite = array[np.isfinite(array)]
    return {
        "count": int(array.size),
        "mean": None if has_never else round_(array.mean()),
        "median": pct(0.5),
        "min": round_(finite.min()) if finite.size else None,
        "max": None if has_never else round_(array.max()),
        "p25": pct(0.25),
        "p75": pct(0.75),
    }


def ranked(event_values, control_values) -> tuple[np.ndarray, np.ndarray]:
    """Both groups with ``never`` replaced by one value above every finite one, so a rank test puts
    them last (a rank test drops infinities)."""
    ev = np.asarray(pd.to_numeric(pd.Series(event_values), errors="coerce"), dtype="float64")
    cv = np.asarray(pd.to_numeric(pd.Series(control_values), errors="coerce"), dtype="float64")
    both = np.concatenate([ev, cv])
    finite = both[np.isfinite(both)]
    sentinel = (finite.max() if finite.size else 0.0) + 1.0
    return np.where(np.isposinf(ev), sentinel, ev), np.where(np.isposinf(cv), sentinel, cv)


def timeline_grid(measure: dict) -> list[int]:
    """At most :data:`TIMELINE_POINTS` offsets across the bars the measure can read, with the event."""
    lo = min(endpoint_range(measure["window"]["start"])[0], endpoint_range(measure["window"]["end"])[0])
    hi = max(endpoint_range(measure["window"]["start"])[1], endpoint_range(measure["window"]["end"])[1])
    step = max(1, math.ceil((hi - lo) / TIMELINE_POINTS))
    grid = list(range(lo, hi + 1, step))
    if grid[-1] != hi:
        grid.append(hi)
    if lo <= 0 <= hi and 0 not in grid:
        grid = sorted({*grid, 0})
    return grid


def timeline(measure: dict, groups, grid: list[int]) -> tuple[list, list]:
    """For a condition measure: at each offset of ``grid``, the share of events whose conditions held
    that day (of those where they could be judged), and how many could. ``groups`` yields
    ``(features, pos)`` per symbol."""
    grid_array = np.asarray(grid, dtype=np.int64)
    held_count = np.zeros(len(grid), dtype=np.int64)
    known_count = np.zeros(len(grid), dtype=np.int64)
    for features, pos in groups:
        n = len(features)
        held, known = evaluate_known(features, measure["conditions"])
        target = np.asarray(pos, dtype=np.int64)[:, None] + grid_array[None, :]
        inside = (target >= 0) & (target < n)
        safe = np.where(inside, target, 0)
        k = known[safe] & inside
        held_count += (held[safe] & k).sum(axis=0)
        known_count += k.sum(axis=0)
    shares = [(float(h) / float(c)) if c else None for h, c in zip(held_count, known_count)]
    return shares, [int(c) for c in known_count]
