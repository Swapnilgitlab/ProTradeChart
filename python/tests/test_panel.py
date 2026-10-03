"""Tests for reading many symbols' stored daily bars at once (`pt.panel`), and `bars_many` using it."""

import io
import json
import math
import unittest
from contextlib import redirect_stdout

from support import Case, bars_body, ms, panel_bytes  # noqa: E402  (also puts the package on the path)

import pandas as pd  # noqa: E402

import protrade as pt  # noqa: E402
from protrade import frames, panels  # noqa: E402

DAYS = [ms(d) for d in ("2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01")]


def body(times, base=0.0):
    b = bars_body(times)
    for k in "ohlc":
        b[k] = [x + base for x in b[k]]
    return b


A, B, C = "zerodha:NSE:AAA", "zerodha:NSE:BBB", "zerodha:NSE:CCC"


class PanelTests(Case):
    def setUp(self):
        super().setUp()
        self.held = {A: body(DAYS), B: body(DAYS[1:], base=100.0)}
        self.stub.posts["/v1/panel"] = lambda p: (
            200,
            panel_bytes([(s, self.held.get(s), s in self.held) for s in p["symbols"]]),
        )
        self.stub.routes["/v1/bars"] = lambda q: (200, body(DAYS, base=500.0))

    def test_a_panel_holds_each_symbols_bars_as_bars_would_return_them(self):
        got = pt.panel([A, B, C], bars=260)
        self.assertEqual(got.symbols, [A, B, C])
        self.assertEqual(got.held, [A, B])
        self.assertEqual(got.missing, [C])
        self.assertEqual(self.stub.posted("/v1/panel")[0]["bars"], 260)

        expected = frames.to_frame(self.held[B], naive=True)
        pd.testing.assert_frame_equal(got.frame(B, naive=True), expected)
        self.assertEqual(len(got.frame(C)), 0)
        self.assertEqual(got.frame(A).attrs["symbol"], A)

    def test_wide_lines_symbols_up_by_date(self):
        wide = pt.panel([A, B]).wide("close")
        self.assertEqual(list(wide.columns), [A, B])
        self.assertEqual(len(wide), 4)
        self.assertTrue(math.isnan(wide[B].iloc[0]), "B has no bar on the first day")
        self.assertEqual(wide[A].iloc[-1], self.held[A]["c"][-1])
        with self.assertRaises(ValueError):
            pt.panel([A]).wide("vwap")

    def test_bars_many_reads_held_symbols_from_the_panel_and_fetches_only_the_rest(self):
        with redirect_stdout(io.StringIO()):
            got = pt.bars_many([A, B, C], "D", start="2026-01-01", naive=True)
        self.assertEqual(list(got), [A, B, C])
        fetched = [r["query"]["symbol"] for r in self.stub.requests if r["path"] == "/v1/bars"]
        self.assertEqual(fetched, [C])
        self.assertEqual(got[A]["close"].iloc[-1], self.held[A]["c"][-1])
        self.assertEqual(got[C]["close"].iloc[-1], 500.0 + 1.5 + 3)

    def test_without_a_panel_route_every_symbol_is_fetched_as_before(self):
        del self.stub.posts["/v1/panel"]
        with redirect_stdout(io.StringIO()):
            got = pt.bars_many([A, B], "D")
        self.assertEqual(list(got), [A, B])
        self.assertEqual(len([r for r in self.stub.requests if r["path"] == "/v1/bars"]), 2)

    def test_intraday_never_asks_for_a_panel(self):
        with redirect_stdout(io.StringIO()):
            pt.bars_many([A, B], "5")
        self.assertEqual(self.stub.posted("/v1/panel"), [])

    def test_a_panel_in_an_unknown_format_is_refused(self):
        raw = panel_bytes([(A, self.held[A], True)])
        n = int.from_bytes(raw[:4], "little")
        head = json.loads(raw[4 : 4 + n])
        head["format"] = 99
        changed = json.dumps(head).encode()
        with self.assertRaises(pt.ProTradeError):
            panels.decode(len(changed).to_bytes(4, "little") + changed + raw[4 + n :])
        with self.assertRaises(ValueError):
            pt.panel([A], bars=0)


if __name__ == "__main__":
    unittest.main()
