"""What a script can ask the app for besides prices: the folder a scheduled run's scripts share,
SQL on the app's own database, an email to yourself, and a chart the app draws.

    import protrade as pt

    picks = pt.sql("SELECT symbol FROM watchlist_items WHERE watchlist_id = :id", {"id": 3})
    pt.sql("DELETE FROM watchlist_items WHERE symbol = 'india:NSE:TCS'")
    pt.screenshot("india:NSE:RELIANCE", path=pt.run_folder() / "RELIANCE.png")
    pt.send_email("Breakouts", "Today's names", attachments=[picks, pt.run_folder() / "RELIANCE.png"])

Each needs the app: run from its Python tab (or a schedule), the script is given the address and
token it uses. Email goes only to the address set up in the Scheduler tab's Email settings, and
the app keeps the password; this package never sees it.
"""

from __future__ import annotations

import base64
import io
import math
import os
import tempfile
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

from . import client

RUN_FOLDER_ENV = "PROTRADE_RUN_FOLDER"
SCHEDULE_ENV = "PROTRADE_SCHEDULE"
STEP_ENV = "PROTRADE_STEP"


def run_folder() -> Path:
    """The folder the scripts of one scheduled run share. Write a file there for the next script in
    the sequence to read; the app empties it when the run ends. Run by hand, it is a folder in your
    temporary files that stays until you delete it."""
    folder = os.environ.get(RUN_FOLDER_ENV)
    path = Path(folder) if folder else Path(tempfile.gettempdir()) / "protrade-run"
    path.mkdir(parents=True, exist_ok=True)
    return path


def schedule() -> dict | None:
    """The schedule running this script, ``{"name": "Evening screen", "step": 2, "steps": 4}``, or
    ``None`` when it was started by hand."""
    name = os.environ.get(SCHEDULE_ENV)
    if not name:
        return None
    try:
        step, steps = (int(part) for part in os.environ.get(STEP_ENV, "").split("/"))
    except ValueError:
        step, steps = 0, 0
    return {"name": name, "step": step, "steps": steps}


def _param(value):
    """One SQL parameter as JSON can carry it."""
    if value is None or value is pd.NaT or value is pd.NA:
        return None
    if isinstance(value, (bool, np.bool_)):
        return bool(value)
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, (float, np.floating)):
        number = float(value)
        return number if math.isfinite(number) else None
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if isinstance(value, str):
        return value
    raise TypeError(f"A SQL parameter must be a number, text, True/False or None, not {type(value).__name__}.")


def sql(query: str, params=None, dry_run: bool = False) -> pd.DataFrame:
    """Runs SQL on the app's database and returns the rows of the last statement that returned any
    (an empty DataFrame when none did).

    It may read ``watchlists``, ``watchlist_items``, ``watchlist_sections``, ``symbol_flags``,
    ``market_symbols``, ``datasets``, ``dataset_bars``, the instrument tables and, when the app saves
    prices, ``prices.price_series`` and ``prices.price_bars``. It may add, change and delete rows in
    the four watchlist tables only. Symbols are written like ``india:NSE:RELIANCE`` (a bare
    ``RELIANCE`` is made into that), and the app renumbers the lists' rows afterwards.

    Every call is one transaction: if anything fails, or a change would break a list (an unknown
    flag colour, a symbol it can't read), nothing is changed. ``params`` is a list for ``?`` or a dict
    for ``:name``. ``dry_run=True`` runs it and rolls it back, to see what it would do.

    The DataFrame's ``attrs`` say what changed: ``changes`` (rows) and ``tables``.
    """
    if not isinstance(query, str) or not query.strip():
        raise ValueError("Pass the SQL to run as text.")
    if isinstance(params, tuple):
        params = list(params)
    if isinstance(params, list):
        params = [_param(v) for v in params]
    elif isinstance(params, dict):
        params = {str(k).lstrip(":@$"): _param(v) for k, v in params.items()}
    elif params is not None:
        raise TypeError("params must be a list (for ?) or a dict (for :name).")
    answer = client.post("/v1/sql", {"sql": query, "params": params, "dryRun": bool(dry_run)})
    frame = pd.DataFrame(answer["rows"], columns=answer["columns"])
    frame.attrs.update(
        changes=answer["changes"], tables=answer["tables"], truncated=answer["truncated"], dry_run=answer["dryRun"]
    )
    if answer["truncated"]:
        warnings.warn(f"Only the first {len(frame):,} rows came back; narrow the query for the rest.", stacklevel=2)
    if answer["tables"]:
        verb = "Would change" if answer["dryRun"] else "Changed"
        print(f"{verb} {answer['changes']} row(s) in {', '.join(answer['tables'])}.")
    return frame


def _attachment(item, index: int) -> dict:
    """One attachment: a file path, a DataFrame (sent as CSV), or a ``(name, contents)`` pair."""
    if isinstance(item, tuple) and len(item) == 2:
        name, contents = item
    elif isinstance(item, (pd.DataFrame, pd.Series)):
        name, contents = f"table-{index}.csv", item
    else:
        path = Path(item)
        name, contents = path.name, path.read_bytes()
    if isinstance(contents, (pd.DataFrame, pd.Series)):
        buffer = io.StringIO()
        contents.to_csv(buffer, index=not isinstance(contents.index, pd.RangeIndex))
        contents = buffer.getvalue()
    if isinstance(contents, str):
        contents = contents.encode("utf-8")
    if not isinstance(contents, (bytes, bytearray)):
        raise TypeError(f"Attachment {name}: give a file path, a DataFrame, or (name, bytes or text).")
    return {"name": str(name), "data": base64.b64encode(bytes(contents)).decode("ascii")}


def send_email(subject: str, body: str = "", attachments=()) -> None:
    """Emails you: from and to the address in the Scheduler tab's Email settings, through your own
    mail account. There is no recipient to choose; nothing goes to anyone else.

    ``attachments`` can hold file paths, DataFrames (attached as CSV, ``table-1.csv`` and so on) and
    ``(name, contents)`` pairs, where contents is bytes, text or a DataFrame. Together they can come
    to 10 MB.
    """
    if not isinstance(subject, str) or not subject.strip():
        raise ValueError("An email needs a subject.")
    if isinstance(attachments, (str, Path, pd.DataFrame, pd.Series)):
        attachments = [attachments]
    files = [_attachment(item, i + 1) for i, item in enumerate(attachments)]
    client.post("/v1/email", {"subject": subject, "body": str(body), "attachments": files})
    print(f"Emailed '{subject}' to you" + (f" with {len(files)} attachment(s)." if files else "."))


def screenshot(symbol: str, timeframe: str = "D", layout: str | None = None, width: int = 1280, height: int = 720, path=None) -> bytes:
    """A chart the app draws, as PNG bytes; saved to ``path`` too when one is given.

    ``timeframe`` is the chart's (``D``, ``W``, ``M``, ``60``, ``15`` …). ``layout`` names one of your
    saved layouts: the chart then has its first chart's indicators and style. Your drawings on the
    symbol are on it, as on every chart. The app's main window must be open (it draws the chart).
    """
    png = client.post_raw(
        "/v1/screenshot",
        {"symbol": symbol, "timeframe": str(timeframe), "layout": layout, "width": int(width), "height": int(height)},
        accept="image/png",
    )
    if path is not None:
        Path(path).write_bytes(png)
    return png
