"""The HTTP side: one authenticated GET to ProTradeChart's local data API.

Standard library only. The app starts every script with the API's address and a one-off
token in ``PROTRADE_API`` and ``PROTRADE_TOKEN``; nothing here ever sees a broker
credential, because the app holds those and fetches the data itself.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

API_ENV = "PROTRADE_API"
TOKEN_ENV = "PROTRADE_TOKEN"
TIMEOUT_ENV = "PROTRADE_TIMEOUT"
# Names this run to the app, so what the script shows appears in the window that started it.
RUN_ENV = "PROTRADE_RUN_ID"
# Set to disable the daily quote top-up (``api._top_up``) outright: a kill switch, and a way to
# diff a screen's results with and without it.
NO_TOPUP_ENV = "PROTRADE_NO_TOPUP"
# Set to stop the Screener judging filters on today's quote before it reads history
# (``screen.Screen.run``): a kill switch, and a way to diff a screen's results with and without it.
NO_SNAPSHOT_ENV = "PROTRADE_NO_SNAPSHOT"
# A request can queue behind the app's broker pacing (Kite allows three history calls a
# second), so a long first sync of many symbols is normal, not a hang.
DEFAULT_TIMEOUT = 900.0

INDIA = "india"
"""The namespace every Indian market symbol lives in (``india:NSE:RELIANCE``), whichever of the
user's brokers serves it. The app's Data providers say which one does."""

# Older spellings of the Indian namespace: what scripts said while Zerodha was the only broker, and a
# broker's name written by hand. The app reads them as ``india`` too; this side does the same, so a
# script's own spelling and the app's answer agree. The same rule as `src/lib/symbols.ts`.
_ALIASES = {"zerodha": INDIA, "fyers": INDIA}


def canonical_provider(provider: str) -> str:
    """The namespace a provider prefix stands for: ``"zerodha"`` is ``"india"``."""
    lower = provider.strip().lower()
    return _ALIASES.get(lower, lower)


def canonical_symbol_prefix(symbol: str) -> str:
    """``symbol`` with an old spelling of its prefix replaced (``zerodha:NSE:X`` is
    ``india:NSE:X``) and nothing else changed. The same rule as ``withCanonicalPrefix``."""
    head, sep, rest = symbol.partition(":")
    if sep and head.lower() in _ALIASES:
        return f"{INDIA}:{rest}"
    return symbol


class ProTradeError(Exception):
    """Anything ProTradeChart's data API refused or could not do."""

    code = "error"

    def __init__(self, message: str, code: str | None = None, status: int | None = None):
        super().__init__(message)
        if code:
            self.code = code
        self.status = status


class ConnectionFailed(ProTradeError):
    """The data API could not be reached: the script was not started from ProTradeChart,
    or the app has closed."""

    code = "connection"


class AuthError(ProTradeError):
    """The broker rejected its credentials. Kite tokens expire every morning: log in again
    under Data providers in the app."""

    code = "auth"


class NotConfiguredError(ProTradeError):
    """The broker is not set up (or is switched off) in the app's Data providers."""

    code = "not_configured"


class NoAccessError(ProTradeError):
    """The broker's plan does not include this data (Kite Connect's paid plan)."""

    code = "no_access"


class RateLimitedError(ProTradeError):
    code = "rate_limited"


class BadRequestError(ProTradeError, ValueError):
    code = "bad_request"


class NotFoundError(ProTradeError, LookupError):
    code = "not_found"


class UpstreamError(ProTradeError):
    """The broker could not be reached, or failed."""

    code = "upstream"


# Errors after which every further request would fail the same way: a batch should stop
# rather than collect one failure per symbol.
FATAL = (ConnectionFailed, AuthError, NotConfiguredError, NoAccessError)

_BY_CODE = {
    "auth": AuthError,
    "not_configured": NotConfiguredError,
    "no_access": NoAccessError,
    "rate_limited": RateLimitedError,
    "bad_request": BadRequestError,
    "too_large": BadRequestError,
    "unsupported_media_type": BadRequestError,
    "not_found": NotFoundError,
    "upstream": UpstreamError,
    "unauthorized": ConnectionFailed,
    "forbidden_host": ConnectionFailed,
    "forbidden_origin": ConnectionFailed,
}

# Never send this through a proxy: it is the loopback interface.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def connection() -> tuple[str, str]:
    """The API's address and token, from the environment the app gave this script."""
    url = os.environ.get(API_ENV, "").rstrip("/")
    token = os.environ.get(TOKEN_ENV, "")
    if not url or not token:
        raise ConnectionFailed(
            f"{API_ENV} and {TOKEN_ENV} are not set. Run this script from ProTradeChart's "
            "Python tab, which starts it with them."
        )
    return url, token


def _timeout() -> float:
    try:
        return float(os.environ.get(TIMEOUT_ENV, DEFAULT_TIMEOUT))
    except ValueError:
        return DEFAULT_TIMEOUT


def error_from(status: int, body: bytes) -> ProTradeError:
    """Turns an error response into the matching exception."""
    try:
        detail = json.loads(body)["error"]
        code, message = detail["code"], detail["message"]
    except (ValueError, KeyError, TypeError):
        code, message = "error", f"ProTradeChart's data API answered HTTP {status}."
    return _BY_CODE.get(code, ProTradeError)(message, code=code, status=status)


def get(path: str, **params):
    """GET ``path`` with the given query parameters (``None`` ones are left out) and return
    the decoded JSON. Raises a :class:`ProTradeError` on any failure."""
    url, token = connection()
    query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    return _send(
        urllib.request.Request(
            f"{url}{path}" + (f"?{query}" if query else ""),
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        ),
        url,
    )


def post(path: str, payload):
    """POST ``payload`` as JSON to ``path`` and return the decoded answer. NaN and infinity are
    refused (JSON has no such numbers); the callers turn them into ``None`` first."""
    return json.loads(post_raw(path, payload, accept="application/json"))


def post_raw(path: str, payload, accept: str = "application/octet-stream") -> bytes:
    """POST ``payload`` as JSON to ``path`` and return the answer's bytes, undecoded."""
    url, token = connection()
    return _send(
        urllib.request.Request(
            f"{url}{path}",
            data=json.dumps(payload, allow_nan=False).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": accept,
                "Content-Type": "application/json",
            },
        ),
        url,
        decode=False,
    )


def _send(request: urllib.request.Request, url: str, decode: bool = True):
    try:
        with _OPENER.open(request, timeout=_timeout()) as response:
            body = response.read()
            return json.loads(body) if decode else body
    except urllib.error.HTTPError as e:
        raise error_from(e.code, e.read()) from None
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
        reason = getattr(e, "reason", e)
        raise ConnectionFailed(
            f"Couldn't reach ProTradeChart's data API at {url} ({reason}). Is the app still open?"
        ) from None
