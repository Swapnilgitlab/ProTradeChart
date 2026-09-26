# protrade — the Python client

The package Python scripts import to reach ProTradeChart's market data. Scripts run from the app's Python tab
(`Ctrl+Shift+Y`) are started with everything they need; see the README's *Python* section for the overview and
[docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) for how it is built.

```python
import protrade as pt

bars = pt.bars("zerodha:NSE:RELIANCE", "D", start="2023-01-01")   # a DataFrame
```

It needs **Python 3.10+ and pandas**, and nothing else: HTTP is the standard library. It is not installed with `pip`: the app
writes a copy that matches the running app next to its virtual environment and puts it on the script's `PYTHONPATH`.

## Functions

| | |
| --- | --- |
| `pt.bars(symbol, interval="D", start=None, end=None, limit=None, tz=None, naive=False)` | OHLCV as a DataFrame (`open high low close volume`) on a time index. `symbol` is `provider:EXCHANGE:TICKER` (`zerodha:NSE:RELIANCE`, `dhan:NSE:TCS`) or `csv:NAME`. Without `start` you get the newest `limit` bars (500). |
| `pt.bars_many(symbols, interval="D", start=None, end=None, limit=None, workers=4, errors="raise", progress=True)` | `{symbol: DataFrame}` for many symbols, in order. `errors="skip"` leaves failed symbols out and lists them in `result.errors`. |
| `pt.instruments(provider, exchange=None, kind=None, q=None, limit=None)` | A broker's instruments, to build a universe from. `kind` is `EQUITY`, `INDEX` or `FUT`. |
| `pt.watchlists()` / `pt.watchlist(name_or_id, providers=None)` | The app's watchlists; the symbols on one, optionally only from some sources. |
| `pt.providers()` | Which sources are set up (`usable`). |
| `pt.resample(bars, rule, session_open="09:15")` | Coarser bars from finer ones. Intraday rules (`"15min"`, `"4h"`) restart at each day's session open. |
| `pt.universe(name=None, providers=("zerodha", "dhan"))` | The symbols to work on, so a script runs with nothing set up: that watchlist, else your first with readable symbols, else ten large NSE stocks. `.source` says which. |
| `pt.status()` | The app's version; a quick connection check. |

## Showing results

| | |
| --- | --- |
| `pt.show(frame, title=None, symbol_column="symbol", max_rows=2000, digits=2)` | A DataFrame as a sortable table in the Results tab. A `symbol` column's cells open that chart, and the list can be added to a watchlist. |
| `pt.report(trades=None, equity=None, benchmark=None, metrics=None, title=None, initial_capital=None)` | A backtest: figures (return, drawdown, CAGR, Sharpe, win rate, profit factor…), the equity curve against a benchmark, and the trades. Give `equity`, `trades`, or both; `equity` is a Series on a datetime index, `trades` a DataFrame with a `pnl` column. `metrics={"Exposure": 0.6}` adds figures of your own. |
| `pt.plot(figure=None, title=None)` | A matplotlib figure (the current one by default). Needs matplotlib, which the app does not install. |

Run outside the app — a terminal, a notebook — these print instead, so the same script works in both places.

- **Times.** `start` and `end` are dates or times, read in IST when they have no zone; a bare `end` date includes that day.
  Numbers are refused (epoch units are ambiguous). The index is timezone-aware, in the exchange's zone; a daily bar is at
  midnight of its date. `naive=True` drops the zone.
- **Intervals.** `"D"` and minutes. Kite serves 1, 3, 5, 10, 15, 30, 60 and D; Dhan 1, 5, 15, 25, 60 and D. For anything else,
  fetch finer and `resample`.
- **Volume** is NaN for an index.
- **A broker that won't go back far enough** (Kite: 60 days per call at one minute, capped in total; Dhan: five years of
  intraday) gives you what it has and a `DataLimitWarning`; `df.attrs["limited_from"]` says where the data really starts.

## Studies

The engine behind the app's Studies tab is `protrade.study`, usable from any script:

```python
from protrade.study import ResearchStudy

study = ResearchStudy({
    "name": "100% Winners",
    "universe": {"source": "instruments", "provider": "zerodha", "exchanges": ["NSE"], "min_avg_traded_value": 1e7},
    "period": {"start": "2018-01-01"},
    "event": {"conditions": ["return_12m crosses_above 1.0"]},
    "metrics": ["return_63", "rsi_14", "dist_high_252", "rvol_20"],
})
universe = study.universe()
data = study.load(universe)                                  # {symbol: Features}
events = study.detect_events(data)                           # one row per event: symbol, event_date, price…
results = study.measure(events, data)                        # metrics at every observation point, forward returns
control = study.measure(study.control_group(data, events), data)
study.analyze(results, control, data)                        # shows the Study in the app (prints outside it)
```

Each step takes overrides (`study.detect_events(data, conditions=["close crosses_above prior_high_252"])`). The spec's rules are
in `normalize_spec`; features are named `family_window` (`return_63`, `ema_200`, `dist_high_252`, `rvol_20`, `rs_126`…, see
`protrade/features.py`) and conditions read `left op right`. Market cap isn't available, so a spec that asks for it is refused
(`StudyDataError`) rather than run without it. `python -m protrade.run_study spec.json` runs a spec file, which is what the app does.

## Errors
## Errors

Every failure is a `ProTradeError`:

| Exception | Meaning |
| --- | --- |
| `AuthError` | The broker rejected its credentials. Kite tokens expire every morning: log in again in the app. |
| `NotConfiguredError` | The broker isn't set up, or is switched off, under Data providers. |
| `NoAccessError` | The broker's plan doesn't include this data (Kite Connect's paid plan; Dhan's Data API). |
| `RateLimitedError` | The broker is rate limiting. |
| `NotFoundError` | No such instrument, watchlist or dataset (also a `LookupError`). |
| `BadRequestError` | The request was wrong (also a `ValueError`). |
| `UpstreamError` | The broker couldn't be reached, or failed. |
| `ConnectionFailed` | The app's local API couldn't be reached, or refused the request. |

`AuthError`, `NotConfiguredError`, `NoAccessError` and `ConnectionFailed` end a `bars_many` run even with `errors="skip"`: every
later symbol would fail the same way.

## The connection

The app starts each script with three environment variables: `PROTRADE_API` (`http://127.0.0.1:<port>`), `PROTRADE_TOKEN`
(a one-off token) and `PROTRADE_RUN_ID` (which run to show results in). Every request carries
`Authorization: Bearer <token>`, and the app answers only to its own `Host` and refuses any request that has an `Origin`
header (a browser's). Everything is read-only market data apart from posting a result, and there is no route that places an
order or returns a credential. The token is new on every launch of the app, so it is not something to keep.

| Route | |
| --- | --- |
| `GET /v1/bars?symbol=&interval=&from=&to=&limit=` | Columnar JSON (`t`, `o`, `h`, `l`, `c`, `v`) with `timezone`, `coveredFrom`, `coveredTo`, `limitedFrom`. `from`/`to` are epoch milliseconds. |
| `GET /v1/instruments?provider=&exchange=&kind=&q=&limit=` | Rows of `symbol`, `name`, `exchange`, `kind`, `expiry`. |
| `GET /v1/watchlists`, `GET /v1/watchlist?name=` or `?id=` | The lists, and the symbols on one. |
| `GET /v1/providers`, `GET /v1/ping` | Sources and their state; the app's version. |
| `POST /v1/results` | `{runId, kind, title, data}`, where `kind` is `table`, `report` or `figure`. The only route that isn't a read: it shows something in the panel of the run that posted it. At most 16 MB. |

Errors are `{"error": {"code": "...", "message": "..."}}` with an HTTP status.

## Tests

```bash
npm run test:python        # or: python -m unittest discover -s python/tests
```

They run the client against a stub of the API, so they need pandas but no app. The Rust side has its own tests for the API and,
end to end, for a real Python process talking to the real server (`cargo test --lib python::e2e`).
