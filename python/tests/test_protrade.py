"""Tests for the protrade client, against a stub of the app's local data API.

Run from the repository root:  python -m unittest discover -s python/tests -v
"""

import datetime as dt
import io
import itertools
import os
import unittest
import warnings
from contextlib import redirect_stdout
from unittest import mock

from support import Case, IST, TOKEN, Stub, bars_body, error, ms  # noqa: E402  (also puts the package on the path)

import pandas as pd  # noqa: E402

import protrade as pt  # noqa: E402
from protrade import api, client, frames  # noqa: E402


class ConnectionTests(Case):
    routes = {"/v1/ping": lambda q: (200, {"ok": True, "api": 1})}

    def test_a_request_carries_the_token_and_drops_none_parameters(self):
        self.assertEqual(client.get("/v1/ping", a="x y", b=None), {"ok": True, "api": 1})
        request = self.stub.requests[0]
        self.assertEqual(request["auth"], f"Bearer {TOKEN}")
        self.assertEqual(request["query"], {"a": "x y"})

    def test_status_reports_the_app(self):
        self.assertTrue(pt.status()["ok"])

    def test_a_script_not_started_by_the_app_is_told_how_to_run(self):
        os.environ.pop(client.API_ENV)
        with self.assertRaisesRegex(pt.ConnectionFailed, "Python tab"):
            client.get("/v1/ping")

    def test_an_app_that_has_closed_is_a_connection_error_not_a_traceback_from_urllib(self):
        self.stub.close()
        with self.assertRaises(pt.ConnectionFailed) as caught:
            client.get("/v1/ping")
        self.assertIn("still open", str(caught.exception))
        self.stub = Stub({})  # so tearDown has something to close


class ErrorTests(Case):
    def test_every_code_becomes_its_own_exception(self):
        cases = {
            "auth": pt.AuthError,
            "not_configured": pt.NotConfiguredError,
            "no_access": pt.NoAccessError,
            "rate_limited": pt.RateLimitedError,
            "bad_request": pt.BadRequestError,
            "not_found": pt.NotFoundError,
            "upstream": pt.UpstreamError,
            "unauthorized": pt.ConnectionFailed,
            "forbidden_host": pt.ConnectionFailed,
        }
        for code, expected in cases.items():
            with self.subTest(code=code):
                self.stub.routes["/v1/x"] = lambda q, code=code: error(400, code, f"message for {code}")
                with self.assertRaises(expected) as caught:
                    client.get("/v1/x")
                self.assertEqual(str(caught.exception), f"message for {code}")
                self.assertEqual(caught.exception.status, 400)

    def test_errors_can_be_caught_by_their_natural_python_type(self):
        self.stub.routes["/v1/x"] = lambda q: error(400, "bad_request")
        with self.assertRaises(ValueError):
            client.get("/v1/x")
        self.stub.routes["/v1/x"] = lambda q: error(404, "not_found")
        with self.assertRaises(LookupError):
            client.get("/v1/x")

    def test_an_unknown_code_or_a_body_that_is_not_ours_is_still_a_protrade_error(self):
        self.stub.routes["/v1/x"] = lambda q: error(500, "something_new", "odd")
        with self.assertRaisesRegex(pt.ProTradeError, "odd"):
            client.get("/v1/x")
        self.stub.routes["/v1/x"] = lambda q: (502, "<html>bad gateway</html>")
        with self.assertRaisesRegex(pt.ProTradeError, "HTTP 502"):
            client.get("/v1/x")

    def test_a_failure_that_would_hit_every_symbol_is_marked_fatal(self):
        for cls in (pt.ConnectionFailed, pt.AuthError, pt.NotConfiguredError, pt.NoAccessError):
            self.assertIsInstance(cls("x"), client.FATAL)
        for cls in (pt.NotFoundError, pt.BadRequestError, pt.UpstreamError, pt.RateLimitedError):
            self.assertNotIsInstance(cls("x"), client.FATAL)


class DateTests(unittest.TestCase):
    def test_a_time_without_a_zone_is_read_in_ist(self):
        self.assertEqual(frames.to_millis("2024-01-01"), ms("2024-01-01"))
        self.assertEqual(frames.to_millis("2024-01-01 09:15"), ms("2024-01-01 09:15"))
        self.assertEqual(frames.to_millis(dt.datetime(2024, 1, 1, 9, 15)), ms("2024-01-01 09:15"))

    def test_a_time_with_a_zone_is_taken_as_it_is(self):
        utc = pd.Timestamp("2024-01-01 03:45", tz="UTC")
        self.assertEqual(frames.to_millis(utc), ms("2024-01-01 09:15"))

    def test_a_bare_end_date_includes_the_whole_day_but_a_start_does_not(self):
        day = 24 * 3600 * 1000
        self.assertEqual(frames.to_millis("2024-03-01", end=True), ms("2024-03-01") + day - 1)
        self.assertEqual(frames.to_millis(dt.date(2024, 3, 1), end=True), ms("2024-03-01") + day - 1)
        self.assertEqual(frames.to_millis("2024-03-01"), ms("2024-03-01"))

    def test_an_end_with_a_time_is_exact(self):
        self.assertEqual(frames.to_millis("2024-03-01 10:00", end=True), ms("2024-03-01 10:00"))
        self.assertEqual(frames.to_millis(dt.datetime(2024, 3, 1), end=True), ms("2024-03-01"))

    def test_numbers_are_refused_because_epoch_units_are_ambiguous(self):
        for value in (1700000000000, 1700000000, 1.5, True):
            with self.assertRaises(TypeError):
                frames.to_millis(value)

    def test_none_stays_none(self):
        self.assertIsNone(frames.to_millis(None))
        self.assertIsNone(frames.from_millis(None))


class BarsTests(Case):
    def setUp(self):
        super().setUp()
        self.times = [ms("2024-01-01"), ms("2024-01-02"), ms("2024-01-03")]
        self.stub.routes["/v1/bars"] = lambda q: (200, bars_body(self.times))

    def test_the_request_carries_ist_bounds_and_the_interval(self):
        pt.bars("zerodha:NSE:X", "D", start="2024-01-01", end="2024-01-31", limit=50)
        query = self.stub.requests[0]["query"]
        self.assertEqual(query["symbol"], "zerodha:NSE:X")
        self.assertEqual(query["interval"], "D")
        self.assertEqual(query["from"], str(ms("2024-01-01")))
        self.assertEqual(query["to"], str(ms("2024-01-31") + 24 * 3600 * 1000 - 1))
        self.assertEqual(query["limit"], "50")

    def test_an_interval_may_be_given_as_a_number(self):
        pt.bars("zerodha:NSE:X", 15)
        self.assertEqual(self.stub.requests[0]["query"]["interval"], "15")

    def test_what_is_not_given_is_not_sent(self):
        pt.bars("zerodha:NSE:X")
        self.assertEqual(set(self.stub.requests[0]["query"]), {"symbol", "interval"})

    def test_the_answer_is_a_dataframe_in_the_exchanges_zone(self):
        df = pt.bars("zerodha:NSE:X", start="2024-01-01")
        self.assertEqual(list(df.columns), ["open", "high", "low", "close", "volume"])
        self.assertEqual(str(df.index.tz), IST)
        self.assertEqual(df.index.name, "time")
        self.assertEqual(df.index[0], pd.Timestamp("2024-01-01", tz=IST))
        self.assertEqual(list(df["close"]), [1.5, 2.5, 3.5])
        self.assertTrue((df.dtypes == "float64").all())

    def test_daily_bars_are_at_midnight_and_can_be_made_naive(self):
        df = pt.bars("zerodha:NSE:X", naive=True)
        self.assertIsNone(df.index.tz)
        self.assertEqual(df.index[0], pd.Timestamp("2024-01-01"))
        self.assertTrue((df.index == df.index.normalize()).all())

    def test_another_zone_can_be_asked_for(self):
        df = pt.bars("zerodha:NSE:X", tz="UTC")
        self.assertEqual(str(df.index.tz), "UTC")
        self.assertEqual(df.index[0], pd.Timestamp("2023-12-31 18:30", tz="UTC"))

    def test_a_missing_volume_is_nan_even_when_every_volume_is_missing(self):
        self.stub.routes["/v1/bars"] = lambda q: (200, bars_body(self.times, v=[None, None, None]))
        df = pt.bars("zerodha:NSE:X")
        self.assertTrue(df["volume"].isna().all())
        self.assertEqual(df["volume"].dtype, "float64")
        self.stub.routes["/v1/bars"] = lambda q: (200, bars_body(self.times, v=[5.0, None, 7.0]))
        self.assertEqual(int(pt.bars("zerodha:NSE:X")["volume"].isna().sum()), 1)

    def test_no_bars_is_an_empty_frame_with_the_right_columns(self):
        self.stub.routes["/v1/bars"] = lambda q: (200, bars_body([]))
        df = pt.bars("zerodha:NSE:X")
        self.assertEqual(len(df), 0)
        self.assertEqual(list(df.columns), ["open", "high", "low", "close", "volume"])

    def test_the_frame_remembers_what_it_is(self):
        df = pt.bars("zerodha:NSE:X", "D")
        self.assertEqual(df.attrs["symbol"], "zerodha:NSE:X")
        self.assertEqual(df.attrs["interval"], "D")
        self.assertEqual(df.attrs["covered_from"], pd.Timestamp("2024-01-01", tz=IST))
        self.assertIsNone(df.attrs["limited_from"])

    def test_a_broker_that_would_not_go_back_far_enough_is_a_warning_not_a_silent_short_frame(self):
        later = ms("2024-01-02")
        self.stub.routes["/v1/bars"] = lambda q: (200, bars_body(self.times, limitedFrom=later))
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            df = pt.bars("zerodha:NSE:X", start="2020-01-01")
        self.assertEqual([w.category for w in caught], [pt.DataLimitWarning])
        self.assertIn("2024-01-02", str(caught[0].message))
        self.assertEqual(df.attrs["limited_from"], pd.Timestamp("2024-01-02", tz=IST))

    def test_no_warning_when_no_start_was_asked_for(self):
        self.stub.routes["/v1/bars"] = lambda q: (200, bars_body(self.times, limitedFrom=ms("2024-01-02")))
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            pt.bars("zerodha:NSE:X")
        self.assertEqual(caught, [])

    def test_a_broker_error_surfaces_as_the_matching_exception(self):
        self.stub.routes["/v1/bars"] = lambda q: error(401, "auth", "Zerodha rejected your access token.")
        with self.assertRaisesRegex(pt.AuthError, "rejected your access token"):
            pt.bars("zerodha:NSE:X")


class PaceTests(unittest.TestCase):
    def test_there_is_no_estimate_until_there_is_enough_history(self):
        self.assertIsNone(api._pace(4, 984, 60), "too few symbols")
        self.assertIsNone(api._pace(200, 984, 2), "too little time: cached symbols arrive instantly")
        self.assertIsNone(api._pace(984, 984, 400), "nothing left")

    def test_the_estimate_is_the_rate_so_far_carried_forward(self):
        rate, left = api._pace(100, 984, 36)
        self.assertAlmostEqual(rate, 100 / 36)
        self.assertAlmostEqual(left, 884 / (100 / 36))

    def test_durations_read_as_a_person_would_say_them(self):
        self.assertEqual(api._duration(0), "0s")
        self.assertEqual(api._duration(59.4), "59s")
        self.assertEqual(api._duration(312), "5m 12s")
        self.assertEqual(api._duration(3 * 3600 + 5 * 60), "3h 05m")
        self.assertEqual(api._duration(-5), "0s")


class ManyTests(Case):
    def setUp(self):
        super().setUp()
        self.times = [ms("2024-01-01"), ms("2024-01-02")]

        def route(query):
            symbol = query["symbol"]
            if symbol.endswith(":MISSING"):
                return error(404, "not_found", f"no instrument {symbol}")
            if symbol.endswith(":EXPIRED"):
                return error(401, "auth", "token expired")
            return 200, bars_body(self.times, symbol=symbol)

        self.stub.routes["/v1/bars"] = route

    def test_every_symbol_comes_back_in_the_order_given_without_repeats(self):
        symbols = [f"zerodha:NSE:S{i}" for i in range(12)]
        result = pt.bars_many(symbols + symbols[:3], progress=False)
        self.assertEqual(list(result), symbols)
        self.assertTrue(all(len(df) == 2 for df in result.values()))
        bar_reads = [r for r in self.stub.requests if r["path"] == "/v1/bars"]
        self.assertEqual(len(bar_reads), 12, "repeats were fetched once")

    def test_the_first_failure_stops_the_run_by_default(self):
        with self.assertRaises(pt.NotFoundError):
            pt.bars_many(["zerodha:NSE:A", "zerodha:NSE:MISSING"], progress=False, workers=1)

    def test_skip_keeps_the_rest_and_records_what_failed(self):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            result = pt.bars_many(
                ["zerodha:NSE:A", "zerodha:NSE:MISSING", "zerodha:NSE:B"], errors="skip", progress=False
            )
        self.assertEqual(list(result), ["zerodha:NSE:A", "zerodha:NSE:B"])
        self.assertEqual(list(result.errors), ["zerodha:NSE:MISSING"])
        self.assertIsInstance(result.errors["zerodha:NSE:MISSING"], pt.NotFoundError)
        self.assertEqual(len(caught), 1)

    def test_an_expired_token_stops_even_a_skipping_run(self):
        with self.assertRaises(pt.AuthError):
            pt.bars_many(["zerodha:NSE:A", "zerodha:NSE:EXPIRED", "zerodha:NSE:B"], errors="skip", progress=False, workers=1)

    def test_progress_is_reported_on_one_redrawn_line(self):
        out = io.StringIO()
        with redirect_stdout(out):
            pt.bars_many(["zerodha:NSE:A", "zerodha:NSE:B"], progress=True)
        text = out.getvalue()
        self.assertIn("\rfetched 2/2", text)
        self.assertTrue(text.endswith("\n"))

    def test_the_progress_line_shows_a_rate_and_says_once_when_the_run_will_take_minutes(self):
        symbols = [f"zerodha:NSE:S{i}" for i in range(12)]
        # A clock that moves ten seconds each time it is read: slow enough that twelve
        # symbols would take minutes.
        clock = itertools.count(0, 10)
        out = io.StringIO()
        with redirect_stdout(out), mock.patch("protrade.api.time.monotonic", lambda: next(clock)):
            pt.bars_many(symbols, workers=1)
        text = out.getvalue()
        self.assertIn("/s, about", text)
        self.assertIn(" left", text)
        self.assertEqual(text.count("This will take a few minutes"), 1)

    def test_a_quick_run_gets_no_estimate_and_no_warning(self):
        out = io.StringIO()
        with redirect_stdout(out):
            pt.bars_many([f"zerodha:NSE:S{i}" for i in range(12)], workers=1)
        self.assertNotIn("left", out.getvalue())
        self.assertNotIn("a few minutes", out.getvalue())

    def test_progress_can_be_switched_off_and_a_single_symbol_needs_none(self):
        out = io.StringIO()
        with redirect_stdout(out):
            pt.bars_many(["zerodha:NSE:A", "zerodha:NSE:B"], progress=False)
            pt.bars_many(["zerodha:NSE:A"], progress=True)
        self.assertEqual(out.getvalue(), "")

    def test_a_bad_errors_option_is_refused_before_any_request(self):
        with self.assertRaises(ValueError):
            pt.bars_many(["zerodha:NSE:A"], errors="ignore")
        self.assertEqual(self.stub.requests, [])


class TopUpTests(Case):
    """``api._top_up``: the daily quote top-up a screen asks for ahead of its own fetch loop."""

    def setUp(self):
        super().setUp()
        self.stub.posts["/v1/bars/sync"] = lambda payload: (
            200,
            {"results": [{"symbol": s, "status": "current", "reason": None} for s in payload["symbols"]]},
        )

    def test_fewer_than_two_symbols_makes_no_call(self):
        self.assertIsNone(api._top_up(["zerodha:NSE:X"]))
        self.assertEqual(self.stub.posted("/v1/bars/sync"), [])

    def test_a_non_daily_interval_makes_no_call(self):
        self.assertIsNone(api._top_up(["zerodha:NSE:X", "zerodha:NSE:Y"], interval="5"))
        self.assertEqual(self.stub.posted("/v1/bars/sync"), [])

    def test_disabled_by_its_environment_variable(self):
        os.environ[client.NO_TOPUP_ENV] = "1"
        self.assertIsNone(api._top_up(["zerodha:NSE:X", "zerodha:NSE:Y"]))
        self.assertEqual(self.stub.posted("/v1/bars/sync"), [])

    def test_the_request_carries_the_span_symbols_and_interval(self):
        api._top_up(["zerodha:NSE:X", "zerodha:NSE:Y", "zerodha:NSE:X"], start="2024-01-01", end="2024-01-31", limit=50)
        posted = self.stub.posted("/v1/bars/sync")
        self.assertEqual(len(posted), 1)
        self.assertEqual(posted[0]["symbols"], ["zerodha:NSE:X", "zerodha:NSE:Y"], "no repeats, order kept")
        self.assertEqual(posted[0]["interval"], "D")
        self.assertEqual(posted[0]["from"], ms("2024-01-01"))
        self.assertEqual(posted[0]["to"], ms("2024-01-31") + 24 * 3600 * 1000 - 1)
        self.assertEqual(posted[0]["limit"], 50)

    def test_counts_are_tallied_by_status(self):
        self.stub.posts["/v1/bars/sync"] = lambda payload: (
            200,
            {
                "results": [
                    {"symbol": "zerodha:NSE:A", "status": "current", "reason": None},
                    {"symbol": "zerodha:NSE:B", "status": "updated", "reason": None},
                    {"symbol": "zerodha:NSE:C", "status": "fetch", "reason": "no quote for it"},
                    {"symbol": "zerodha:NSE:D", "status": "skipped", "reason": "not a symbol a quote top-up covers"},
                ]
            },
        )
        counts = api._top_up(["zerodha:NSE:A", "zerodha:NSE:B", "zerodha:NSE:C", "zerodha:NSE:D"])
        self.assertEqual(counts, {"current": 1, "updated": 1, "fetch": 1, "skipped": 1})

    def test_a_missing_or_broken_route_is_swallowed_not_raised(self):
        del self.stub.posts["/v1/bars/sync"]  # as an older app build with no such route would 404
        self.assertIsNone(api._top_up(["zerodha:NSE:X", "zerodha:NSE:Y"]))

        self.stub.posts["/v1/bars/sync"] = lambda payload: error(401, "auth", "token expired")
        self.assertIsNone(api._top_up(["zerodha:NSE:X", "zerodha:NSE:Y"]))

    def test_more_symbols_than_one_batch_are_sent_as_several_calls(self):
        with mock.patch.object(api, "_SYNC_BATCH", 2):
            counts = api._top_up(["zerodha:NSE:A", "zerodha:NSE:B", "zerodha:NSE:C"])
        posted = self.stub.posted("/v1/bars/sync")
        self.assertEqual([p["symbols"] for p in posted], [["zerodha:NSE:A", "zerodha:NSE:B"], ["zerodha:NSE:C"]])
        self.assertEqual(counts, {"current": 3, "updated": 0, "fetch": 0, "skipped": 0})


class ListingTests(Case):
    def test_instruments_are_a_frame_whose_symbol_column_feeds_bars(self):
        self.stub.routes["/v1/instruments"] = lambda q: (
            200,
            [{"symbol": "zerodha:NSE:RELIANCE", "name": "Reliance", "exchange": "NSE", "kind": "EQUITY", "expiry": None}],
        )
        df = pt.instruments("zerodha", exchange="NSE", kind="EQUITY", q="reli", limit=10)
        self.assertEqual(list(df["symbol"]), ["zerodha:NSE:RELIANCE"])
        self.assertEqual(self.stub.requests[0]["query"], {"provider": "zerodha", "exchange": "NSE", "kind": "EQUITY", "q": "reli", "limit": "10"})

    def test_an_empty_listing_still_has_its_columns(self):
        self.stub.routes["/v1/instruments"] = lambda q: (200, [])
        self.assertEqual(list(pt.instruments("zerodha").columns), ["symbol", "name", "exchange", "kind", "expiry"])

    def test_a_watchlist_is_found_by_name_or_by_id_and_can_be_filtered_to_readable_sources(self):
        content = {"id": 3, "name": "Mixed", "symbols": [
            {"symbol": "zerodha:NSE:RELIANCE", "name": None},
            {"symbol": "binance:BTCUSDT", "name": None},
            {"symbol": "csv:MY_DATA", "name": None},
        ]}
        self.stub.routes["/v1/watchlist"] = lambda q: (200, content)
        self.assertEqual(len(pt.watchlist("Mixed")), 3)
        self.assertEqual(self.stub.requests[-1]["query"], {"name": "Mixed"})
        self.assertEqual(pt.watchlist(3, providers=("zerodha", "CSV")), ["zerodha:NSE:RELIANCE", "csv:MY_DATA"])
        self.assertEqual(self.stub.requests[-1]["query"], {"id": "3"})

    def test_watchlists_and_providers_are_frames(self):
        self.stub.routes["/v1/watchlists"] = lambda q: (200, [{"id": 1, "name": "A", "count": 4}])
        self.stub.routes["/v1/providers"] = lambda q: (200, [{"id": "zerodha", "label": "Zerodha", "usable": True}])
        self.assertEqual(list(pt.watchlists()["count"]), [4])
        self.assertTrue(pt.providers().loc[0, "usable"])


class ResampleTests(unittest.TestCase):
    def five_minute_day(self, date, opens):
        index = pd.date_range(f"{date} 09:15", periods=len(opens), freq="5min", tz=IST)
        return pd.DataFrame(
            {"open": opens, "high": [o + 1 for o in opens], "low": [o - 1 for o in opens], "close": [o + 0.5 for o in opens], "volume": [10.0] * len(opens)},
            index=index,
        )

    def test_finer_bars_build_coarser_ones_from_the_session_open(self):
        df = self.five_minute_day("2024-01-01", [10, 11, 12, 20, 21, 22])
        out = frames.resample(df, "15min")
        self.assertEqual(list(out.index), [pd.Timestamp("2024-01-01 09:15", tz=IST), pd.Timestamp("2024-01-01 09:30", tz=IST)])
        first = out.iloc[0]
        self.assertEqual((first["open"], first["high"], first["low"], first["close"], first["volume"]), (10, 13, 9, 12.5, 30))
        self.assertEqual(out.iloc[1]["open"], 20)

    def test_each_day_starts_a_fresh_bucket_at_the_open(self):
        df = pd.concat([self.five_minute_day("2024-01-01", [10, 11, 12, 13]), self.five_minute_day("2024-01-02", [20, 21, 22, 23])])
        out = frames.resample(df, "15min")
        self.assertEqual(list(out.index.strftime("%m-%d %H:%M")), ["01-01 09:15", "01-01 09:30", "01-02 09:15", "01-02 09:30"])
        self.assertEqual(list(out["open"]), [10, 13, 20, 23])

    def test_a_four_hour_bar_is_anchored_to_the_open_not_to_the_clock(self):
        index = pd.date_range("2024-01-01 09:15", "2024-01-01 15:15", freq="60min", tz=IST)
        df = pd.DataFrame({"open": range(len(index)), "high": range(len(index)), "low": range(len(index)), "close": range(len(index)), "volume": 1.0}, index=index)
        out = frames.resample(df, "4h")
        self.assertEqual(list(out.index.strftime("%H:%M")), ["09:15", "13:15"])

    def test_a_gap_in_the_data_does_not_invent_bars(self):
        df = self.five_minute_day("2024-01-01", [10, 11, 12])
        df = df.drop(df.index[1])  # no bar at 09:20
        out = frames.resample(df, "15min")
        self.assertEqual(len(out), 1)
        self.assertEqual(out.iloc[0]["volume"], 20)

    def test_daily_bars_go_to_weeks_through_pandas(self):
        index = pd.date_range("2024-01-01", periods=10, freq="B", tz=IST)  # two working weeks, Mon-Fri
        df = pd.DataFrame({"open": range(10), "high": range(10), "low": range(10), "close": range(10), "volume": 1.0}, index=index)
        out = frames.resample(df, "W-FRI")
        self.assertEqual(len(out), 2)
        self.assertEqual(list(out["volume"]), [5.0, 5.0])
        self.assertEqual(list(out["open"]), [0, 5])

    def test_a_zero_length_rule_is_refused(self):
        df = self.five_minute_day("2024-01-01", [10, 11])
        with self.assertRaises(ValueError):
            frames.resample(df, "0min")


if __name__ == "__main__":
    unittest.main()
