"""What the client's tests share: a stub of the app's local API, and helpers to build its answers."""

import json
import os
import struct
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pandas as pd  # noqa: E402

from protrade import client  # noqa: E402

TOKEN = "t" * 64
IST = "Asia/Kolkata"


def ms(text: str) -> int:
    """Epoch milliseconds of an IST date or time."""
    return int((pd.Timestamp(text, tz=IST).tz_convert("UTC") - pd.Timestamp("1970-01-01", tz="UTC")) // pd.Timedelta(milliseconds=1))


def error(status, code, message="nope"):
    return status, {"error": {"code": code, "message": message}}


def bars_body(times, interval="D", **extra):
    n = len(times)
    body = {
        "symbol": "india:NSE:X",
        "interval": interval,
        "timezone": IST,
        "count": n,
        "t": times,
        "o": [1.0 + i for i in range(n)],
        "h": [2.0 + i for i in range(n)],
        "l": [0.5 + i for i in range(n)],
        "c": [1.5 + i for i in range(n)],
        "v": [100.0 + i for i in range(n)],
        "coveredFrom": times[0] if times else 0,
        "coveredTo": times[-1] if times else 0,
        "limitedFrom": None,
    }
    body.update(extra)
    return body


def panel_bytes(series):
    """A `/v1/panel` answer, as the app encodes it (`panel_body` in src-tauri/src/pyapi/wire.rs).
    `series` is `[(symbol, bars_body or None, current)]`; a `None` body holds no bars."""
    heads, columns = [], {k: [] for k in "tohlcv"}
    for symbol, body, current in series:
        n = body["count"] if body else 0
        heads.append(
            {
                "symbol": symbol,
                "count": n,
                "current": current,
                "coveredFrom": body["coveredFrom"] if body else None,
                "coveredTo": body["coveredTo"] if body else None,
            }
        )
        for k in "tohlcv":
            columns[k].extend((body[k] if body else [])[:n])
    head = json.dumps({"format": 1, "interval": "D", "timezone": IST, "count": len(columns["t"]), "series": heads}).encode()
    out = struct.pack("<I", len(head)) + head
    out += b"\0" * ((-len(out)) % 8)
    out += struct.pack(f"<{len(columns['t'])}q", *columns["t"])
    for k in "ohlcv":
        out += struct.pack(f"<{len(columns[k])}d", *[float("nan") if x is None else x for x in columns[k]])
    return out


class Stub:
    """A local HTTP server standing in for the app.

    `routes` maps a path to a function of the query (a dict) and `posts` a path to a function of
    the decoded JSON body; each returns `(status, json)`. Every request is recorded in
    `requests`."""

    def __init__(self, routes, posts=None):
        self.routes = routes
        self.posts = posts if posts is not None else {}
        self.requests = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def reply(self, status, body):
                binary = isinstance(body, bytes)
                data = body if binary else json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/octet-stream" if binary else "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                parsed = urlparse(self.path)
                query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
                stub.requests.append({"method": "GET", "path": parsed.path, "query": query, "auth": self.headers.get("Authorization")})
                route = stub.routes.get(parsed.path)
                self.reply(*(route(query) if route else error(404, "not_found", "no such route")))

            def do_POST(self):
                parsed = urlparse(self.path)
                raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                try:
                    payload = json.loads(raw)
                except ValueError:
                    payload = None
                stub.requests.append(
                    {
                        "method": "POST",
                        "path": parsed.path,
                        "auth": self.headers.get("Authorization"),
                        "content_type": self.headers.get("Content-Type"),
                        "payload": payload,
                        "raw": raw,
                    }
                )
                route = stub.posts.get(parsed.path)
                self.reply(*(route(payload) if route else error(404, "not_found", "no such route")))

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        # The default poll interval (0.5 s) is also how long shutdown() takes.
        threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def posted(self, path=None):
        """The bodies of the POSTs received, in order; `path` narrows it to one route."""
        return [r["payload"] for r in self.requests if r["method"] == "POST" and (path is None or r["path"] == path)]


class Case(unittest.TestCase):
    """A test with a stub API running, and the environment a script from the app would have."""

    routes = {}
    posts = {}
    run_id = None  # set to a run id to give the script one

    def setUp(self):
        keys = (client.API_ENV, client.TOKEN_ENV, client.TIMEOUT_ENV, client.RUN_ENV, client.NO_TOPUP_ENV, client.NO_SNAPSHOT_ENV)
        self._saved = {k: os.environ.get(k) for k in keys}
        self.stub = Stub(dict(self.routes), dict(self.posts))
        os.environ[client.API_ENV] = self.stub.url
        os.environ[client.TOKEN_ENV] = TOKEN
        os.environ[client.TIMEOUT_ENV] = "10"
        if self.run_id:
            os.environ[client.RUN_ENV] = self.run_id
        else:
            os.environ.pop(client.RUN_ENV, None)
        os.environ.pop(client.NO_TOPUP_ENV, None)
        os.environ.pop(client.NO_SNAPSHOT_ENV, None)

    def tearDown(self):
        self.stub.close()
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
