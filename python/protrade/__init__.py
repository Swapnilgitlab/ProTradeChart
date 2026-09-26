"""ProTradeChart's Python client.

Scripts run from the app's Python tab reach market data through it::

    import protrade as pt

    df = pt.bars("zerodha:NSE:RELIANCE", "D", start="2023-01-01")
    universe = pt.watchlist("Nifty 50", providers=("zerodha",))
    panel = pt.bars_many(universe, "D", start="2024-01-01")

The app fetches from the broker (it holds the credentials, and this package never sees
them), keeps what it fetched, and answers over a local, token-protected connection.

Studies (``pt.ResearchStudy``, see ``protrade.study``) measure what stocks looked like around
historical events, from a Study Specification the app's Studies tab builds.
"""

from .api import (
    BarsMap,
    DataLimitWarning,
    Universe,
    bars,
    bars_many,
    instruments,
    providers,
    resample,
    status,
    universe,
    watchlist,
    watchlists,
)
from .client import (
    AuthError,
    BadRequestError,
    ConnectionFailed,
    NoAccessError,
    NotConfiguredError,
    NotFoundError,
    ProTradeError,
    RateLimitedError,
    UpstreamError,
)
from .results import plot, report, show
from .study import ResearchStudy, SpecError, StudyDataError

__all__ = [
    "AuthError",
    "BadRequestError",
    "BarsMap",
    "ConnectionFailed",
    "DataLimitWarning",
    "NoAccessError",
    "NotConfiguredError",
    "NotFoundError",
    "ProTradeError",
    "RateLimitedError",
    "ResearchStudy",
    "SpecError",
    "StudyDataError",
    "UpstreamError",
    "Universe",
    "bars",
    "bars_many",
    "instruments",
    "plot",
    "providers",
    "report",
    "resample",
    "show",
    "status",
    "universe",
    "watchlist",
    "watchlists",
]
