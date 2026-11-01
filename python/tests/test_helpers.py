"""Tests for pt.sql, pt.send_email, pt.screenshot and a scheduled run's folder."""

import base64
import io
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from support import Case, error  # noqa: E402  (also puts the package on the path)

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import protrade as pt  # noqa: E402
from protrade import helpers  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\n" + b"rest"


def sql_answer(payload):
    return 200, {
        "columns": ["symbol", "n"],
        "rows": [["india:NSE:TCS", 1]],
        "truncated": False,
        "changes": 2 if "DELETE" in payload["sql"] else 0,
        "tables": ["watchlist_items"] if "DELETE" in payload["sql"] else [],
        "dryRun": payload["dryRun"],
    }


class SqlTests(Case):
    posts = {"/v1/sql": sql_answer}

    def test_the_rows_come_back_as_a_frame_with_what_changed(self):
        frame = pt.sql("SELECT symbol, 1 AS n FROM watchlist_items")
        self.assertEqual(list(frame.columns), ["symbol", "n"])
        self.assertEqual(frame.iloc[0].tolist(), ["india:NSE:TCS", 1])
        self.assertEqual((frame.attrs["changes"], frame.attrs["tables"]), (0, []))
        self.assertEqual(self.stub.posted("/v1/sql")[0], {"sql": "SELECT symbol, 1 AS n FROM watchlist_items", "params": None, "dryRun": False})

    def test_a_change_is_reported_and_a_dry_run_says_would(self):
        out = io.StringIO()
        with redirect_stdout(out):
            pt.sql("DELETE FROM watchlist_items WHERE symbol = ?", ["india:NSE:TCS"])
            pt.sql("DELETE FROM watchlist_items", dry_run=True)
        self.assertIn("Changed 2 row(s) in watchlist_items.", out.getvalue())
        self.assertIn("Would change 2 row(s) in watchlist_items.", out.getvalue())
        self.assertEqual(self.stub.posted("/v1/sql")[1]["dryRun"], True)

    def test_parameters_become_json_and_named_ones_lose_their_colon(self):
        pt.sql("SELECT :a, :b", {":a": np.int64(3), "b": float("nan")})
        pt.sql("SELECT ?, ?", (np.float64(1.5), pd.Timestamp("2026-10-30")))
        posted = self.stub.posted("/v1/sql")
        self.assertEqual(posted[0]["params"], {"a": 3, "b": None})
        self.assertEqual(posted[1]["params"], [1.5, "2026-10-30T00:00:00"])
        with self.assertRaises(TypeError):
            pt.sql("SELECT ?", "not a list")
        with self.assertRaises(ValueError):
            pt.sql("  ")

    def test_the_apps_refusal_reaches_the_script(self):
        self.stub.posts["/v1/sql"] = lambda payload: error(400, "bad_request", "pt.sql can't do that (reading main.ui_preferences).")
        with self.assertRaises(pt.BadRequestError) as caught:
            pt.sql("SELECT * FROM ui_preferences")
        self.assertIn("can't do that", str(caught.exception))


class EmailTests(Case):
    posts = {"/v1/email": lambda payload: (200, {"ok": True})}

    def test_files_frames_and_pairs_are_attached(self):
        folder = Path(tempfile.mkdtemp())
        (folder / "chart.png").write_bytes(PNG)
        frame = pd.DataFrame({"symbol": ["india:NSE:TCS"], "close": [4000.5]})
        with redirect_stdout(io.StringIO()) as out:
            pt.send_email("Breakouts", "Today", attachments=[folder / "chart.png", frame, ("notes.txt", "hello")])
        posted = self.stub.posted("/v1/email")[0]
        self.assertEqual((posted["subject"], posted["body"]), ("Breakouts", "Today"))
        self.assertNotIn("to", posted, "there is no recipient: it goes to you")
        names = [a["name"] for a in posted["attachments"]]
        self.assertEqual(names, ["chart.png", "table-2.csv", "notes.txt"])
        decoded = [base64.b64decode(a["data"]) for a in posted["attachments"]]
        self.assertEqual(decoded[0], PNG)
        self.assertEqual(decoded[1].decode().splitlines(), ["symbol,close", "india:NSE:TCS,4000.5"])
        self.assertEqual(decoded[2], b"hello")
        self.assertIn("Emailed 'Breakouts' to you with 3 attachment(s).", out.getvalue())

    def test_a_subject_is_needed_and_email_not_set_up_is_an_error(self):
        with self.assertRaises(ValueError):
            pt.send_email(" ")
        self.stub.posts["/v1/email"] = lambda payload: error(409, "not_configured", "Email isn't set up")
        with self.assertRaises(pt.NotConfiguredError):
            pt.send_email("Hi")


class ScreenshotTests(Case):
    posts = {"/v1/screenshot": lambda payload: (200, PNG)}

    def test_the_png_is_returned_and_saved_where_asked(self):
        path = Path(tempfile.mkdtemp()) / "RELIANCE.png"
        png = pt.screenshot("RELIANCE", timeframe="W", layout="Swing", path=path)
        self.assertEqual(png, PNG)
        self.assertEqual(path.read_bytes(), PNG)
        posted = self.stub.posted("/v1/screenshot")[0]
        self.assertEqual(posted, {"symbol": "RELIANCE", "timeframe": "W", "layout": "Swing", "width": 1280, "height": 720})


class RunFolderTests(unittest.TestCase):
    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in (helpers.RUN_FOLDER_ENV, helpers.SCHEDULE_ENV, helpers.STEP_ENV)}

    def tearDown(self):
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_a_scheduled_run_shares_its_folder_and_says_where_it_is(self):
        folder = Path(tempfile.mkdtemp()) / "run-1"
        os.environ[helpers.RUN_FOLDER_ENV] = str(folder)
        os.environ[helpers.SCHEDULE_ENV] = "Evening screen"
        os.environ[helpers.STEP_ENV] = "2/4"
        self.assertEqual(pt.run_folder(), folder)
        self.assertTrue(folder.is_dir())
        self.assertEqual(pt.schedule(), {"name": "Evening screen", "step": 2, "steps": 4})

    def test_run_by_hand_there_is_no_schedule_and_a_folder_of_its_own(self):
        for key in self._saved:
            os.environ.pop(key, None)
        self.assertIsNone(pt.schedule())
        self.assertTrue(pt.run_folder().is_dir())


if __name__ == "__main__":
    unittest.main()
