"""Checks one symbol's history for the problems that quietly spoil an analysis.

It reads a daily and an intraday series of SYMBOL from your broker (Zerodha or FYERS, whichever
serves Indian market data in Data providers), through the app, and checks each one:

- the bars are in time order, and no bar appears twice;
- no price is missing, and each bar's open, high, low and close agree with each other;
- the dates you asked for are covered (a broker may serve less history than asked for, and says so);
- no bar falls on a weekend or, for intraday bars, outside the 09:15 to 15:30 IST session;
- weekdays with no bar are listed as possible holidays. Nothing is filled in: the app never makes
  up a bar, so a gap stays a gap.

The checks open in the Results tab as one table. Nothing is written to disk: your broker's prices
stay in the app's memory, as its terms require.
"""

import pandas as pd

import protrade as pt

# ---- What to check ----------------------------------------------------------------------------
SYMBOL = "india:NSE:RELIANCE"  # any symbol the app can chart, like "india:BSE:SBIN" or "csv:MY_DATA"
START = "2025-01-01"  # the first date to check (IST)
END = None  # the last date, inclusive; None means today
INTRADAY = "5"  # minutes per intraday bar (your broker's own sizes: 1, 3, 5, 15, 30, 60 …)
INTRADAY_DAYS = 20  # how many recent days of intraday bars to read
# -----------------------------------------------------------------------------------------------

SESSION_OPEN, SESSION_CLOSE = "09:15", "15:30"
SHOWN = 5  # how many examples a finding lists

rows = []


def note(series: str, check: str, ok: bool, detail: str) -> None:
    rows.append({"series": series, "check": check, "result": "OK" if ok else "Check", "detail": detail})


def sample(index) -> str:
    """A few of the timestamps a finding is about."""
    shown = [str(t) for t in list(index)[:SHOWN]]
    more = f" and {len(index) - SHOWN} more" if len(index) > SHOWN else ""
    return ", ".join(shown) + more


def validate(series: str, frame: pd.DataFrame, intraday: bool, asked_from: pd.Timestamp) -> None:
    if frame.empty:
        note(series, "Bars", False, "The broker returned no bars for this range.")
        return
    index = frame.index
    note(series, "Bars", True, f"{len(frame)} bars from {index[0]} to {index[-1]}.")

    ordered = index.is_monotonic_increasing
    note(series, "Time order", ordered, "Oldest first." if ordered else "Some bars are out of order.")

    repeats = index[index.duplicated()]
    note(series, "Repeated bars", len(repeats) == 0, "None." if len(repeats) == 0 else f"{len(repeats)}: {sample(repeats)}.")

    prices = frame[["open", "high", "low", "close"]]
    gaps = prices[prices.isna().any(axis=1)].index
    note(series, "Missing prices", len(gaps) == 0, "None." if len(gaps) == 0 else f"{len(gaps)} bars: {sample(gaps)}.")
    if frame["volume"].isna().all():
        note(series, "Volume", True, "None reported (normal for an index).")
    else:
        no_volume = frame[frame["volume"].isna()].index
        note(series, "Volume", len(no_volume) == 0, "Every bar has one." if len(no_volume) == 0 else f"Missing on {len(no_volume)} bars: {sample(no_volume)}.")

    p = prices.dropna()
    bad = p[(p["low"] > p[["open", "close"]].min(axis=1)) | (p["high"] < p[["open", "close"]].max(axis=1)) | (p["low"] > p["high"])].index
    note(series, "High and low", len(bad) == 0, "Every bar's range holds its open and close." if len(bad) == 0 else f"{len(bad)} bars: {sample(bad)}.")

    limited = frame.attrs.get("limited_from")
    first_day = index[0].normalize()
    if limited is not None:
        note(series, "Coverage", False, f"The broker serves this only from {limited:%Y-%m-%d}, later than asked ({asked_from:%Y-%m-%d}).")
    elif first_day > asked_from + pd.Timedelta(days=7):
        note(series, "Coverage", False, f"The first bar is {first_day:%Y-%m-%d}, later than asked ({asked_from:%Y-%m-%d}): listed later, or no trading.")
    else:
        note(series, "Coverage", True, f"From {first_day:%Y-%m-%d}, as asked.")

    weekend = index[index.dayofweek >= 5]
    note(series, "Weekend bars", len(weekend) == 0, "None." if len(weekend) == 0 else f"{len(weekend)}: {sample(weekend)}.")

    if intraday:
        times = index.strftime("%H:%M")
        outside = index[(times < SESSION_OPEN) | (times >= SESSION_CLOSE)]
        note(
            series,
            "Session hours",
            len(outside) == 0,
            f"Every bar starts between {SESSION_OPEN} and {SESSION_CLOSE} IST." if len(outside) == 0 else f"{len(outside)} bars outside: {sample(outside)}.",
        )
        days = pd.Series(index.normalize()).value_counts()
        full = days.max()
        short = days[days < full].sort_index()
        note(
            series,
            "Bars per day",
            short.empty,
            f"{full} every day." if short.empty else f"{len(short)} days have fewer than {full}: {sample(short.index.strftime('%Y-%m-%d'))}.",
        )

    traded = set(index.normalize().strftime("%Y-%m-%d"))
    weekdays = pd.bdate_range(first_day.tz_localize(None), index[-1].normalize().tz_localize(None))
    quiet = [d for d in weekdays.strftime("%Y-%m-%d") if d not in traded]
    note(
        series,
        "Weekdays with no bar",
        True,
        "None." if not quiet else f"{len(quiet)} (holidays, or days it didn't trade; not filled in): {sample(quiet)}.",
    )


sources = pt.providers()
ready = sources[sources["usable"]]["id"].tolist()
provider = SYMBOL.split(":", 1)[0].lower()
if provider in ("india", "zerodha", "fyers") and "india" not in ready:
    print("No broker is set up yet. Open Data providers in the app, connect Zerodha or FYERS, log in, and switch it on.")
else:
    start = pd.Timestamp(START, tz="Asia/Kolkata")
    daily = pt.bars(SYMBOL, "D", start=START, end=END)
    validate("Daily", daily, False, start)

    intraday_from = (pd.Timestamp.now(tz="Asia/Kolkata") - pd.Timedelta(days=INTRADAY_DAYS)).normalize()
    intraday = pt.bars(SYMBOL, INTRADAY, start=intraday_from.strftime("%Y-%m-%d"))
    validate(f"{INTRADAY}-minute", intraday, True, intraday_from)

    table = pd.DataFrame(rows)
    flagged = (table["result"] != "OK").sum()
    print(f"{SYMBOL}: {len(table)} checks, {flagged} to look at.")
    pt.show(table, title=f"History checks: {SYMBOL}", symbol_column=None)
