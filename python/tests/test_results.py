"""Tests for what a script shows in the app (tables, reports, figures), and pt.universe()."""

import io
import math
import sys
import unittest
from contextlib import redirect_stdout
from unittest import mock

from support import Case, IST, TOKEN, error  # noqa: E402  (also puts the package on the path)

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import protrade as pt  # noqa: E402
from protrade import results, stats  # noqa: E402

ACCEPT = {"/v1/results": lambda payload: (200, {"ok": True})}


class InApp(Case):
    """A script started from the app's panel: it has a run id, and the app accepts results."""

    posts = ACCEPT
    run_id = "run-1"

    def single(self):
        posted = self.stub.posted()
        self.assertEqual(len(posted), 1, posted)
        return posted[0]


class ShowTests(InApp):
    def test_a_table_is_posted_to_the_run_that_started_the_script(self):
        pt.show(pd.DataFrame({"symbol": ["zerodha:NSE:TCS"], "close": [4000.5]}), title="Above 200-DMA")
        request = self.stub.requests[0]
        self.assertEqual((request["method"], request["path"]), ("POST", "/v1/results"))
        self.assertEqual(request["auth"], f"Bearer {TOKEN}")
        self.assertEqual(request["content_type"], "application/json")
        posted = self.single()
        self.assertEqual((posted["runId"], posted["kind"], posted["title"]), ("run-1", "table", "Above 200-DMA"))
        self.assertEqual(posted["data"]["columns"], ["symbol", "close"])
        self.assertEqual(posted["data"]["rows"], [["zerodha:NSE:TCS", 4000.5]])
        self.assertEqual(posted["data"]["symbolColumn"], 0)
        self.assertEqual(posted["data"]["totalRows"], 1)

    def test_a_table_needs_no_title(self):
        pt.show(pd.DataFrame({"a": [1]}))
        self.assertIsNone(self.single()["title"])

    def test_cells_become_things_json_can_carry(self):
        frame = pd.DataFrame(
            {
                "n": np.array([1, 2], dtype="int64"),
                "x": [1.5, float("nan")],
                "inf": [float("inf"), -float("inf")],
                "flag": np.array([True, False]),
                "text": ["a", None],
                "when": [pd.Timestamp("2024-03-01", tz=IST), pd.Timestamp("2024-03-01 09:15", tz=IST)],
            }
        )
        pt.show(frame)
        rows = self.single()["data"]["rows"]
        self.assertEqual(rows[0], [1, 1.5, None, True, "a", "2024-03-01"])
        self.assertEqual(rows[1], [2, None, None, False, None, "2024-03-01 09:15"])
        # A numpy integer must arrive as a JSON integer, not a float or a string.
        self.assertIsInstance(rows[0][0], int)

    def test_every_kind_of_missing_value_is_null(self):
        frame = pd.DataFrame({"a": pd.array([1, None], dtype="Int64"), "b": [pd.NaT, pd.Timestamp("2024-01-01")]})
        pt.show(frame)
        self.assertEqual(self.single()["data"]["rows"][1][0], None)
        self.assertEqual(self.single()["data"]["rows"][0][1], None)

    def test_a_filtered_frames_old_row_numbers_are_not_a_column(self):
        frame = pd.DataFrame({"symbol": list("abcde"), "x": range(5)})
        pt.show(frame[frame["x"] >= 3])
        data = self.single()["data"]
        self.assertEqual(data["columns"], ["symbol", "x"])
        self.assertEqual(len(data["rows"]), 2)

    def test_a_named_index_is_data_and_so_is_a_time_index(self):
        by_symbol = pd.DataFrame({"close": [1.0, 2.0]}, index=pd.Index(["p:A", "p:B"], name="symbol"))
        pt.show(by_symbol)
        data = self.single()["data"]
        self.assertEqual(data["columns"], ["symbol", "close"])
        self.assertEqual(data["symbolColumn"], 0)

        bars = pd.DataFrame({"close": [1.0]}, index=pd.DatetimeIndex(["2024-03-01"], tz=IST))
        pt.show(bars)
        data = self.stub.posted()[1]["data"]
        self.assertEqual(data["columns"], ["time", "close"])
        self.assertEqual(data["rows"], [["2024-03-01", 1.0]])

    def test_a_series_is_a_one_column_table(self):
        pt.show(pd.Series([1.0, 2.0], name="close"))
        self.assertEqual(self.single()["data"]["columns"], ["close"])
        pt.show(pd.Series([3.0]))
        self.assertEqual(self.stub.posted()[1]["data"]["columns"], ["value"])

    def test_the_symbol_column_is_found_without_regard_to_case_or_named_or_turned_off(self):
        pt.show(pd.DataFrame({"Symbol": ["p:A"], "x": [1]}))
        self.assertEqual(self.stub.posted()[0]["data"]["symbolColumn"], 0)
        pt.show(pd.DataFrame({"ticker": ["p:A"], "x": [1]}), symbol_column="ticker")
        self.assertEqual(self.stub.posted()[1]["data"]["symbolColumn"], 0)
        pt.show(pd.DataFrame({"symbol": ["p:A"], "x": [1]}), symbol_column=None)
        self.assertIsNone(self.stub.posted()[2]["data"]["symbolColumn"])
        pt.show(pd.DataFrame({"x": [1]}))
        self.assertIsNone(self.stub.posted()[3]["data"]["symbolColumn"])

    def test_only_max_rows_are_sent_and_the_table_says_how_many_there_were(self):
        pt.show(pd.DataFrame({"x": range(50)}), max_rows=10, digits=4)
        data = self.single()["data"]
        self.assertEqual((len(data["rows"]), data["totalRows"], data["digits"]), (10, 50, 4))

    def test_something_that_is_not_a_table_is_refused_before_anything_is_sent(self):
        for value in ([1, 2], {"a": 1}, "text", 5, None):
            with self.assertRaises(TypeError):
                pt.show(value)
        self.assertEqual(self.stub.requests, [])

    def test_a_refusal_from_the_app_reaches_the_script(self):
        self.stub.posts["/v1/results"] = lambda payload: error(413, "too_large", "That is over the 16 MB the app accepts.")
        with self.assertRaisesRegex(pt.BadRequestError, "16 MB"):
            pt.show(pd.DataFrame({"x": [1]}))


class SetWatchlistTests(Case):
    """pt.set_watchlist: the list is posted as a `watchlist` result and the app says what it did."""

    posts = {
        "/v1/results": lambda payload: (
            200,
            {"ok": True, "watchlist": {"name": payload["data"]["name"], "created": True, "added": 2, "removed": 0, "total": 2}},
        )
    }
    run_id = "run-1"

    def test_a_list_is_posted_and_what_the_app_did_is_returned_and_printed(self):
        out = io.StringIO()
        with redirect_stdout(out):
            done = pt.set_watchlist("Momentum", ["zerodha:NSE:TCS", " zerodha:INFY ", "", None])
        posted = self.stub.posted()[0]
        self.assertEqual((posted["runId"], posted["kind"]), ("run-1", "watchlist"))
        self.assertEqual(posted["data"], {"name": "Momentum", "symbols": ["zerodha:NSE:TCS", "zerodha:INFY"], "mode": "replace"})
        self.assertEqual(done["total"], 2)
        self.assertIn("Watchlist 'Momentum' made: 2 added, 0 removed, 2 on it.", out.getvalue())

    def test_a_screens_matches_can_be_passed_as_they_are(self):
        frame = pd.DataFrame({"symbol": ["zerodha:NSE:A", "zerodha:NSE:B"], "close": [1.0, 2.0]})
        with redirect_stdout(io.StringIO()):
            pt.set_watchlist("L", frame, mode="append")
            pt.set_watchlist("L", frame.set_index("symbol"))
            pt.set_watchlist("L", frame["symbol"])
        posted = self.stub.posted()
        self.assertEqual([p["data"]["symbols"] for p in posted], [["zerodha:NSE:A", "zerodha:NSE:B"]] * 3)
        self.assertEqual(posted[0]["data"]["mode"], "append")

    def test_a_mistake_is_caught_before_anything_is_sent(self):
        with self.assertRaises(ValueError):
            pt.set_watchlist("L", ["zerodha:NSE:A"], mode="merge")
        with self.assertRaises(TypeError):
            pt.set_watchlist("L", "zerodha:NSE:A")
        with self.assertRaises(ValueError):
            pt.set_watchlist("L", pd.DataFrame({"close": [1.0]}))
        self.assertEqual(self.stub.requests, [])

    def test_the_apps_refusal_is_an_error(self):
        self.stub.posts["/v1/results"] = lambda payload: error(400, "bad_request", "'TCS' isn't a symbol the app can show")
        with self.assertRaises(pt.BadRequestError):
            pt.set_watchlist("L", ["TCS"])


class OutsideTheApp(Case):
    """No run id: a terminal or a notebook. Nothing is posted; the table is printed."""

    posts = ACCEPT

    def test_show_prints_and_posts_nothing(self):
        out = io.StringIO()
        with redirect_stdout(out):
            pt.show(pd.DataFrame({"symbol": ["p:A"], "close": [1.5]}), title="ignored here")
        self.assertIn("p:A", out.getvalue())
        self.assertIn("1.5", out.getvalue())
        self.assertEqual(self.stub.requests, [])

    def test_set_watchlist_writes_nothing_and_says_so(self):
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertIsNone(pt.set_watchlist("L", ["zerodha:NSE:A"]))
        self.assertIn("would replace the watchlist 'L' with 1 symbols", out.getvalue())
        self.assertEqual(self.stub.requests, [])

    def test_report_prints_its_figures(self):
        equity = pd.Series([100.0, 110.0, 121.0], index=pd.date_range("2024-01-01", periods=3, freq="D"))
        out = io.StringIO()
        with redirect_stdout(out):
            pt.report(equity=equity, title="My test")
        self.assertIn("My test", out.getvalue())
        self.assertIn("Total return: 21.00%", out.getvalue())
        self.assertEqual(self.stub.requests, [])

    def test_an_external_tool_that_knows_the_address_and_token_still_has_no_run_to_show_things_in(self):
        self.assertFalse(results.in_app())


PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452")


def fake_matplotlib(figure):
    """A `matplotlib` whose current figure is `figure`, patched in for the length of a `with`."""
    pyplot = mock.Mock()
    pyplot.gcf.return_value = figure
    return mock.patch.dict(sys.modules, {"matplotlib": mock.Mock(pyplot=pyplot), "matplotlib.pyplot": pyplot})


def drawable():
    """Something like a Figure: it can be saved as a PNG, and has no `.figure` of its own."""
    figure = mock.Mock(spec=["savefig"])
    figure.savefig.side_effect = lambda buffer, **kwargs: buffer.write(PNG)
    return figure


class PlotTests(InApp):
    def test_a_figure_is_posted_as_a_png(self):
        figure = drawable()
        with fake_matplotlib(figure):
            pt.plot(title="Distribution")
        posted = self.single()
        self.assertEqual((posted["kind"], posted["title"]), ("figure", "Distribution"))
        self.assertTrue(posted["data"]["png"].startswith("iVBORw0KGgo"), posted["data"]["png"])
        self.assertEqual(figure.savefig.call_args.kwargs["format"], "png")

    def test_a_given_figure_is_used_instead_of_the_current_one(self):
        current, chosen = drawable(), drawable()
        with fake_matplotlib(current):
            pt.plot(chosen)
        chosen.savefig.assert_called_once()
        current.savefig.assert_not_called()

    def test_an_axes_is_drawn_through_its_figure(self):
        figure = drawable()
        axes = mock.Mock(spec=["figure"])
        axes.figure = figure
        with fake_matplotlib(drawable()):
            pt.plot(axes)
        figure.savefig.assert_called_once()

    def test_without_matplotlib_the_error_says_how_to_get_it(self):
        with mock.patch.dict(sys.modules, {"matplotlib": None, "matplotlib.pyplot": None}):
            with self.assertRaises(ImportError) as caught:
                pt.plot()
        message = str(caught.exception)
        self.assertIn("pip", message)
        self.assertIn("matplotlib", message)
        self.assertIn(repr(sys.executable), message, "the command names this very Python")
        self.assertEqual(self.stub.requests, [])


def days(n, start="2024-01-01"):
    return pd.date_range(start, periods=n, freq="D")


class ReportTests(InApp):
    def figures(self, posted):
        return {m["label"]: m for m in posted["data"]["metrics"]}

    def test_a_report_carries_figures_a_curve_and_the_trades(self):
        equity = pd.Series([100.0, 110.0, 99.0, 121.0], index=days(4))
        trades = pd.DataFrame({"symbol": ["p:A"] * 4, "pnl": [10.0, -5.0, 20.0, -5.0]})
        pt.report(trades=trades, equity=equity, title="SMA cross")
        posted = self.single()
        self.assertEqual((posted["kind"], posted["title"]), ("report", "SMA cross"))
        f = self.figures(posted)

        self.assertAlmostEqual(f["Total return"]["value"], 21.0)
        self.assertAlmostEqual(f["Max drawdown"]["value"], (99 / 110 - 1) * 100)
        self.assertEqual((f["Start equity"]["value"], f["End equity"]["value"]), (100.0, 121.0))
        self.assertEqual(f["Trades"], {"label": "Trades", "value": 4, "format": "int"})
        self.assertEqual(f["Net profit"]["value"], 20.0)
        self.assertEqual(f["Win rate"]["value"], 50.0)
        self.assertAlmostEqual(f["Profit factor"]["value"], 3.0)
        self.assertEqual((f["Average win"]["value"], f["Average loss"]["value"]), (15.0, -5.0))
        self.assertEqual((f["Largest win"]["value"], f["Largest loss"]["value"]), (20.0, -5.0))

        data = posted["data"]
        self.assertEqual(data["equity"]["v"], [100.0, 110.0, 99.0, 121.0])
        self.assertEqual(len(data["equity"]["t"]), 4)
        self.assertTrue(all(isinstance(t, int) for t in data["equity"]["t"]))
        self.assertEqual(data["initialCapital"], 100.0)
        self.assertIsNone(data["benchmark"])
        self.assertEqual(data["trades"]["totalRows"], 4)
        self.assertEqual(data["trades"]["symbolColumn"], 0)

    def test_a_time_without_a_zone_is_read_in_ist_like_everywhere_else(self):
        equity = pd.Series([1.0, 2.0], index=pd.DatetimeIndex(["2024-01-01", "2024-01-02"]))
        pt.report(equity=equity)
        t = self.single()["data"]["equity"]["t"]
        expected = int((pd.Timestamp("2024-01-01", tz=IST).tz_convert("UTC") - pd.Timestamp("1970-01-01", tz="UTC")) // pd.Timedelta(milliseconds=1))
        self.assertEqual(t[0], expected)
        self.assertEqual(t[1] - t[0], 86_400_000)

    def test_a_benchmark_and_a_starting_capital_can_be_given(self):
        equity = pd.Series([100.0, 120.0], index=days(2))
        bench = pd.Series([100.0, 105.0], index=days(2))
        pt.report(equity=equity, benchmark=bench, initial_capital=1_000_000)
        data = self.single()["data"]
        self.assertEqual(data["benchmark"]["v"], [100.0, 105.0])
        self.assertEqual(data["initialCapital"], 1_000_000.0)

    def test_figures_of_your_own_follow_the_built_in_ones(self):
        pt.report(equity=pd.Series([1.0, 2.0], index=days(2)), metrics={"Exposure": 0.62, "Notes": "ok", "Live": True, "Days": 3})
        f = self.figures(self.single())
        self.assertEqual(f["Exposure"], {"label": "Exposure", "value": 0.62, "format": "number"})
        self.assertEqual(f["Notes"]["format"], "text")
        self.assertEqual(f["Live"], {"label": "Live", "value": "True", "format": "text"})
        self.assertEqual(f["Days"]["format"], "number")
        labels = [m["label"] for m in self.single()["data"]["metrics"]]
        self.assertEqual(labels[-4:], ["Exposure", "Notes", "Live", "Days"])

    def test_trades_alone_are_enough(self):
        pt.report(trades=pd.DataFrame({"pnl": [1.0, 2.0]}))
        data = self.single()["data"]
        self.assertIsNone(data["equity"])
        self.assertIsNone(data["initialCapital"])
        self.assertIn("Trades", self.figures(self.single()))
        self.assertNotIn("Total return", self.figures(self.single()))

    def test_an_average_that_does_not_exist_is_null_not_nan(self):
        pt.report(trades=pd.DataFrame({"pnl": [5.0, 3.0]}))  # no losing trade
        f = self.figures(self.single())
        self.assertIsNone(f["Profit factor"]["value"])
        self.assertIsNone(f["Average loss"]["value"])
        self.assertEqual(f["Average win"]["value"], 4.0)

    def test_a_long_curve_is_thinned_but_keeps_its_ends_in_order(self):
        n = 12_000
        equity = pd.Series(np.linspace(100, 200, n), index=pd.date_range("2000-01-01", periods=n, freq="D"))
        pt.report(equity=equity)
        curve = self.single()["data"]["equity"]
        self.assertLessEqual(len(curve["t"]), results.MAX_CURVE_POINTS + 1)
        self.assertEqual(curve["v"][0], 100.0)
        self.assertEqual(curve["v"][-1], 200.0)
        self.assertEqual(curve["t"], sorted(curve["t"]))
        self.assertEqual(len(curve["t"]), len(curve["v"]))

    def test_wrong_inputs_are_refused_before_anything_is_sent(self):
        good = pd.Series([1.0, 2.0], index=days(2))
        for call, error_type in [
            (lambda: pt.report(), ValueError),
            (lambda: pt.report(equity=[1, 2, 3]), TypeError),
            (lambda: pt.report(equity=pd.Series([1.0, 2.0])), ValueError),  # no times
            (lambda: pt.report(trades=[1, 2]), TypeError),
            (lambda: pt.report(equity=good, benchmark=[1, 2]), TypeError),
        ]:
            with self.assertRaises(error_type):
                call()
        self.assertEqual(self.stub.requests, [])


class StatsTests(unittest.TestCase):
    def test_a_curve_of_fewer_than_two_points_has_no_figures(self):
        self.assertEqual(stats.equity_metrics(pd.Series([100.0], index=days(1))), [])
        self.assertEqual(stats.equity_metrics(pd.Series([], dtype="float64", index=pd.DatetimeIndex([]))), [])

    def test_a_year_of_growth_is_that_growth_a_year(self):
        index = pd.date_range("2023-01-01", "2024-01-01", freq="D")
        equity = pd.Series(np.linspace(100, 121, len(index)), index=index)
        f = {m["label"]: m["value"] for m in stats.equity_metrics(equity)}
        self.assertAlmostEqual(f["Total return"], 21.0)
        self.assertAlmostEqual(f["CAGR"], 21.0, delta=0.1)
        self.assertEqual(f["Max drawdown"], 0.0)  # it only ever rose

    def test_growth_per_year_is_not_claimed_for_a_few_days(self):
        f = {m["label"] for m in stats.equity_metrics(pd.Series([100.0, 110.0, 120.0], index=days(3)))}
        self.assertNotIn("CAGR", f)

    def test_the_sharpe_ratio_is_daily_and_needs_variation(self):
        flat = pd.Series([100.0] * 10, index=days(10))
        self.assertNotIn("Sharpe", {m["label"] for m in stats.equity_metrics(flat)})
        wobble = pd.Series([100, 101, 100.5, 102, 101.5, 103, 102.5], index=days(7), dtype="float64")
        sharpe = next(m for m in stats.equity_metrics(wobble) if m["label"] == "Sharpe")
        returns = wobble.pct_change().dropna()
        self.assertAlmostEqual(sharpe["value"], returns.mean() / returns.std() * math.sqrt(252))

    def test_intraday_points_are_reduced_to_a_days_last_value_for_the_ratio(self):
        index = pd.DatetimeIndex([])
        for day in ("2024-01-01", "2024-01-02", "2024-01-03"):
            index = index.append(pd.date_range(f"{day} 09:15", periods=6, freq="60min"))
        equity = pd.Series(np.linspace(100, 110, len(index)), index=index)
        self.assertIn("Sharpe", {m["label"] for m in stats.equity_metrics(equity)})

    def test_trades_without_a_pnl_column_or_with_only_blanks_have_no_figures(self):
        self.assertEqual(stats.trade_metrics(pd.DataFrame({"price": [1.0]})), [])
        self.assertEqual(stats.trade_metrics(pd.DataFrame({"pnl": [float("nan"), None]})), [])
        self.assertEqual(stats.trade_metrics(None), [])

    def test_a_blank_pnl_is_left_out_of_the_count(self):
        f = {m["label"]: m["value"] for m in stats.trade_metrics(pd.DataFrame({"pnl": [2.0, float("nan"), -1.0]}))}
        self.assertEqual(f["Trades"], 2)

    def test_every_figure_can_be_written_as_a_line(self):
        for item in [
            {"label": "a", "value": 1234.5, "format": "money"},
            {"label": "b", "value": 12.345, "format": "percent"},
            {"label": "c", "value": 1.5, "format": "ratio"},
            {"label": "d", "value": 12, "format": "int"},
            {"label": "e", "value": 0.123456, "format": "number"},
            {"label": "f", "value": "ok", "format": "text"},
            {"label": "g", "value": None, "format": "money"},
        ]:
            self.assertTrue(stats.describe(item).startswith(item["label"] + ": "))
        self.assertEqual(stats.describe({"label": "g", "value": None, "format": "money"}), "g: -")
        self.assertEqual(stats.describe({"label": "a", "value": 1234.5, "format": "money"}), "a: 1,234.50")


class UniverseTests(Case):
    """`pt.universe()`: the symbols to work on, so an example runs the first time with nothing set up."""

    def setUp(self):
        self.lists = {}  # name -> symbols
        self.usable = {"zerodha": True, "dhan": False}
        self.routes = {
            "/v1/watchlists": lambda q: (200, [{"id": i, "name": n, "count": len(s)} for i, (n, s) in enumerate(self.lists.items())]),
            "/v1/watchlist": self.watchlist_route,
            "/v1/providers": lambda q: (200, [{"id": k, "label": k.title(), "usable": v} for k, v in self.usable.items()]),
        }
        super().setUp()

    def watchlist_route(self, query):
        name = query.get("name")
        if name not in self.lists:
            return error(404, "not_found", f"There is no watchlist called '{name}'. Your watchlists: {', '.join(self.lists) or 'none'}.")
        return 200, {"id": 1, "name": name, "symbols": [{"symbol": s, "name": None} for s in self.lists[name]]}

    def test_a_named_watchlist_is_used_and_says_so(self):
        self.lists["Nifty 50"] = ["zerodha:NSE:TCS", "binance:BTCUSDT", "dhan:NSE:INFY"]
        u = pt.universe("Nifty 50")
        self.assertEqual(list(u), ["zerodha:NSE:TCS", "dhan:NSE:INFY"], "only symbols a script can read")
        self.assertEqual(u.source, "the watchlist 'Nifty 50'")
        self.assertIsInstance(u, list)

    def test_a_named_watchlist_that_does_not_exist_is_an_error_that_lists_the_real_ones(self):
        self.lists["Mine"] = ["zerodha:NSE:TCS"]
        with self.assertRaisesRegex(pt.NotFoundError, "Your watchlists: Mine"):
            pt.universe("Nifty 50")

    def test_a_named_watchlist_with_nothing_readable_on_it_is_an_error(self):
        self.lists["Crypto"] = ["binance:BTCUSDT"]
        with self.assertRaisesRegex(pt.NotFoundError, "no zerodha or dhan symbols"):
            pt.universe("Crypto")

    def test_without_a_name_the_first_watchlist_with_readable_symbols_is_used(self):
        self.lists["Crypto"] = ["binance:BTCUSDT"]
        self.lists["Banks"] = ["zerodha:NSE:HDFCBANK"]
        self.lists["More"] = ["zerodha:NSE:TCS"]
        u = pt.universe()
        self.assertEqual(list(u), ["zerodha:NSE:HDFCBANK"])
        self.assertEqual(u.source, "the watchlist 'Banks'")

    def test_with_no_watchlists_it_is_ten_large_stocks_through_the_broker_that_is_set_up(self):
        u = pt.universe()
        self.assertEqual(len(u), 10)
        self.assertTrue(all(s.startswith("zerodha:NSE:") for s in u), list(u))
        self.assertIn("zerodha:NSE:RELIANCE", u)
        self.assertEqual(u.source, "a sample of large NSE stocks")

    def test_the_brokers_are_tried_in_the_order_given(self):
        self.usable = {"zerodha": True, "dhan": True}
        self.assertTrue(pt.universe()[0].startswith("zerodha:"))
        self.assertTrue(pt.universe(providers=("dhan", "zerodha"))[0].startswith("dhan:"))
        self.usable = {"zerodha": False, "dhan": True}
        self.assertTrue(pt.universe()[0].startswith("dhan:"))

    def test_with_no_broker_set_up_it_says_what_to_do(self):
        self.usable = {"zerodha": False, "dhan": False}
        with self.assertRaisesRegex(pt.NotConfiguredError, "Data providers"):
            pt.universe()


if __name__ == "__main__":
    unittest.main()
