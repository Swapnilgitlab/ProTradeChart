/** `protrade`'s API as text for an AI that has never seen it, so it writes against the real API instead of
 *  guessing (`pandas`-flavoured API keys and libraries it knows from training rarely match what this app
 *  actually exposes). Two readers: the Python tab's own assistant, which sends it with every request (see
 *  `assistant.ts` and `python_body` in `src-tauri/src/ai/prompts.rs`), and an outside AI, through the prompt
 *  the user copies themselves.
 *
 *  Kept in sync with `python/protrade/` by hand — `reference.test.ts` checks that every name in
 *  `protrade.__all__` is mentioned here, so a new export without a line fails the tests. There's no automatic
 *  generation because the point is a short, human-readable reference, not a dump of docstrings. */
export function pythonApiReference(): string {
  return `ProTradeChart is a desktop charting app for Indian markets (NSE/BSE, through the user's own Zerodha or \
FYERS account). A script lives in the app's Python tab and runs on the user's own Python installation, when the \
user presses Run or when a schedule the user made comes due (while the app is open). Nothing is sandboxed.

Market data and reporting results both go through one local package:

    import protrade as pt

Don't use any other market-data source (yfinance, nsepy, ccxt, an API key of your own, screen-scraping, …) — \
the app's own broker connection is the only source of prices, and this package is how a script reaches it. \
Only the standard library, pandas and numpy are guaranteed to be installed; anything else (matplotlib, scipy, \
scikit-learn, …) needs installing into the user's Python first. Standard input is closed: \`input()\` fails.

## Getting data

- \`pt.bars(symbol, interval="D", start=None, end=None, limit=None, tz=None, naive=False) -> DataFrame\` — OHLCV \
bars for one symbol: float columns \`open high low close volume\` (volume is NaN for an index), indexed by \
\`time\`. \`symbol\` is \`provider:EXCHANGE:TICKER\` (e.g. \`"india:NSE:RELIANCE"\`, \`"india:NSE:NIFTY_50"\` for an index) or \
\`"csv:NAME"\` for a file the user imported. \`interval\` is \`"D"\` or minutes (\`"1"\`, \`"3"\`, \`"5"\`, \`"10"\`, \
\`"15"\`, \`"30"\`, \`"60"\` on Zerodha; FYERS also \`"2"\`, \`"20"\`, \`"120"\`, \`"240"\`) — anything else, fetch a \
finer interval and use \`pt.resample\`. \`start\`/\`end\` take a date or time (a string, \`datetime\` or Timestamp), \
read in IST; a bare \`end\` date includes that day; without \`start\` you get the newest \`limit\` bars (500 by \
default). The index is timezone-aware, in IST (\`naive=True\` drops the zone, handy for daily data); a daily bar \
sits at midnight of its date. \`frame.attrs\` has \`symbol\`, \`interval\`, \`covered_from\`, \`covered_to\`. When the \
broker won't serve as far back as \`start\`, a \`pt.DataLimitWarning\` is raised as a warning (not an error) and \
the frame starts later.
- \`pt.bars_many(symbols, interval="D", start=None, end=None, limit=None, workers=4, errors="raise", \
progress=True, tz=None, naive=False) -> BarsMap\` — \`pt.bars\` for a list of symbols in parallel, in the order \
given. A \`BarsMap\` is a \`dict[str, DataFrame]\`; with \`errors="skip"\` a failed symbol is left out and recorded \
in \`result.errors\` (\`{symbol: message}\`) instead of raising. Daily bars the app already holds come in one read; \
the rest are fetched at the broker's own rate limit, so a large universe's *first* run can take minutes — later \
runs only fetch what's new.
- \`pt.panel(symbols, start=None, end=None, bars=None) -> Panel\` — daily bars for many symbols in one read, from \
what the app already holds (all of NSE in about a second when "Keep the market loaded" is on; never waits on the \
broker). \`panel.frame(symbol)\` is one symbol's DataFrame shaped like \`pt.bars\`; \`panel.wide("close")\` (or \
\`"open"\`, \`"high"\`, \`"low"\`, \`"volume"\`) is a dates × symbols DataFrame (naive dates, NaN where a symbol \
didn't trade); \`panel.held\` lists the symbols it holds up to the latest session and \`panel.missing\` the ones it \
doesn't (read those with \`pt.bars\`, or just use \`pt.bars_many\`, which does both); \`panel.arrays(symbol)\` gives \
numpy arrays (\`time\` in epoch ms, then the price columns). \`bars\` keeps the newest that many per symbol.
- \`pt.snapshot(symbols) -> DataFrame\` — today's quote for many symbols at once (all of NSE in a few seconds): \
indexed by symbol, columns \`open high low close previous_close volume traded\` (\`close\` is the last traded \
price). \`result.attrs["session"]\` is the trading day the quotes speak for, or \`None\` in the pre-open window \
(09:00–09:15 IST). The quick way to narrow a market down before reading history.
- \`pt.resample(frame, rule, session_open="09:15") -> DataFrame\` — coarser bars from finer ones (\`"60min"\`, \
\`"4h"\`, \`"W-FRI"\`); an intraday rule starts each bucket at the trading session's open, not a fixed clock split.
- \`pt.universe(name=None, providers=("india",)) -> Universe\` (a \`list\` of symbols with \`.source\` saying \
where they came from) — the symbols to work on so a script runs the first time with nothing configured: a \
named watchlist, else the user's first non-empty one, else ten large NSE stocks. Prefer this over hardcoding \
tickers when the user hasn't named any.
- \`pt.watchlists() -> DataFrame\` (\`id\`, \`name\`, \`count\`) and \`pt.watchlist(name_or_id, providers=None) -> \
list[str]\` — the app's own watchlists, by name or id.
- \`pt.instruments(provider, exchange=None, kind=None, q=None, limit=None) -> DataFrame\` — a broker's tradable \
symbols (\`provider="india"\`), to build a universe from; its \`symbol\` column feeds straight into \`pt.bars\`.
- \`pt.providers() -> DataFrame\` and \`pt.status() -> dict\` — which data sources are set up, and a quick \
connection check.

## Showing results

Printing isn't enough for the app's Results tab — use one of these (each still prints something readable when \
the same script is run outside the app, from a terminal):

- \`pt.show(data, title=None, symbol_column="symbol")\` — a DataFrame or Series as a sortable table; a column of \
symbols becomes clickable (opens that chart) and the whole list can be added to a watchlist from the table.
- \`pt.report(trades=None, equity=None, benchmark=None, metrics=None, title=None)\` — a backtest: \`equity\` is a \
Series of account value over time (datetime index), \`trades\` a DataFrame with a \`pnl\` column (and optionally \
\`symbol\`, \`side\`, \`entry_time\`, \`exit_time\`, \`qty\`, …), \`benchmark\` a second curve (buy-and-hold, say), \
\`metrics\` adds figures of your own (\`{"Sharpe (mine)": 1.2}\`). Give \`equity\`, \`trades\`, or both.
- \`pt.plot(figure=None, title=None)\` — a matplotlib figure (the current one by default); needs matplotlib.
- \`pt.set_watchlist(name, symbols, mode="replace")\` — creates or refreshes one of the app's own watchlists \
from a result (a screen's matches, say — \`symbols\` can be a list, a Series/Index, or a DataFrame with a \
\`symbol\` column); \`mode="append"\` only adds. What a scheduled script usually ends with.

## Scheduled sequences, SQL, screenshots and email

- A schedule (made by the user in the app's Scheduler tab) runs a sequence of scripts one after another; the \
first that fails ends the run. \`pt.run_folder()\` — a folder (a \`pathlib.Path\`) the scripts of one scheduled run \
share, to pass files from one to the next; the app empties it when the run ends. \`pt.schedule()\` — \
\`{"name", "step", "steps"}\` for a scheduled run, \`None\` when run by hand.
- \`pt.sql(query, params=None, dry_run=False)\` — SQL on the app's database; returns the last statement's result \
as a DataFrame (its \`attrs\` say how many rows changed). It may read \`watchlists\` (\`id\`, \`name\`), \
\`watchlist_items\` (\`watchlist_id\`, \`symbol\`, \`position\`), \`watchlist_sections\`, \`symbol_flags\` (\`symbol\`, \
\`flag\`, \`flagged_at\`), \`market_symbols\`, \`datasets\`, \`dataset_bars\`, the instrument tables and (when the \
user saves prices) \`prices.price_series\` / \`prices.price_bars\`; it may change only the four watchlist tables. \
Symbols are \`india:NSE:RELIANCE\`. \`dry_run=True\` reports what would change without changing it.
- \`pt.screenshot(symbol, timeframe="D", layout=None, width=1280, height=720, path=None) -> bytes\` — a PNG of a \
chart the app draws (\`layout\` names one of the user's saved layouts to style it); \`path\` saves it too.
- \`pt.send_email(subject, body="", attachments=())\` — emails the user, to their own address only (no recipient \
argument), once they've set up email in the Scheduler tab; attachments are file paths, DataFrames (sent as CSV) or \
\`(name, bytes_or_text)\` pairs.

## Errors

Every error from the app is a \`pt.ProTradeError\` (\`.code\` says which): \`ConnectionFailed\` (the script wasn't \
started from the app, or the app closed), \`NotConfiguredError\` (no broker set up yet), \`AuthError\` (the \
broker's login expired — Zerodha's every morning; log in again under Data providers), \`NoAccessError\` (the \
broker's plan doesn't include this data), \`RateLimitedError\`, \`NotFoundError\` (a watchlist or symbol that \
doesn't exist), \`BadRequestError\` (a bad argument), \`UpstreamError\` (the broker failed or couldn't be reached).

## Worth knowing

- The script only ever *reads* market data — it can't place, modify or check an order, and it never sees the \
user's broker credentials. There's no market capitalisation, sector, fundamentals or news data, and prices are \
as the broker supplies them (not adjusted for splits or bonuses).
- For studying historical events across many stocks (not one script's own logic), there's a separate, more \
structured engine, \`protrade.ResearchStudy\` — normally built through the app's own Studies tab rather than by \
hand; only reach for it if that's really what's being asked for. It raises \`pt.SpecError\` for a specification \
it can't run and \`pt.StudyDataError\` for data the app doesn't have.`;
}
