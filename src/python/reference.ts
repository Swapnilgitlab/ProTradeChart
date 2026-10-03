/** A prompt describing `protrade` for an outside LLM (ChatGPT, Claude.ai, …) that has never seen it — so it
 *  writes against the real API instead of guessing (`pandas`-flavoured API keys and libraries it knows from
 *  training rarely match what this app actually exposes). Copied from the Python tab's toolbar, never sent
 *  anywhere by the app itself: unlike Ask AI or the Study Builder, this text leaves the machine only if the
 *  user pastes it somewhere themselves.
 *
 *  Kept in sync with `python/protrade/api.py` and `results.py` by hand — `reference.test.ts` checks a curated
 *  list of the names this prompt documents against the real `protrade.__all__` and against this text, so a
 *  rename or removal is caught here. There's no automatic generation because the point is a short,
 *  human-readable prompt, not a dump of docstrings. */
export function pythonApiReference(): string {
  return `You are helping write a Python script for ProTradeChart, a desktop charting app for Indian (NSE/BSE, \
via the user's Zerodha account) and crypto markets. The script runs from the app's own Python tab, on \
the user's own Python installation — nothing is sandboxed, but it only runs when the user presses Run.

Market data and reporting results both go through one local package:

    import protrade as pt

Don't use any other market-data source (yfinance, ccxt, an API key of your own, screen-scraping, …) — the \
app's own broker connection is the only source of prices, and this package is how a script reaches it. Only \
the standard library and pandas are guaranteed to be installed; anything else (numpy, matplotlib, \
scikit-learn, …) needs installing into the user's Python first, or asking them to.

## Getting data

- \`pt.bars(symbol, interval="D", start=None, end=None, limit=None, tz=None, naive=False) -> DataFrame\` — OHLCV \
bars for one symbol. \`symbol\` is \`provider:EXCHANGE:TICKER\` (e.g. \`"zerodha:NSE:RELIANCE"\`) or \`"csv:NAME"\` \
for a file the user imported. \`interval\` is \`"D"\` or minutes (\`"1"\`, \`"3"\`, \`"5"\`, \`"10"\`, \`"15"\`, \
\`"30"\`, \`"60"\` on Zerodha) — anything else, fetch a finer interval \
and use \`pt.resample\`. \`start\`/\`end\` take a date string, read in IST; without \`start\` you get the newest \
\`limit\` bars (500 by default). The index is timezone-aware (\`naive=True\` drops it, handy for daily data); a \
daily bar sits at midnight of its date.
- \`pt.bars_many(symbols, interval="D", ..., workers=4, errors="raise", progress=True) -> BarsMap\` — \`pt.bars\` \
for a list of symbols in parallel (\`BarsMap\` is a \`dict[str, DataFrame]\`); \`errors="skip"\` keeps going and \
records failures in \`result.errors\` instead of raising. The app paces every request at the broker's own rate \
limit, so a large universe's *first* run can take minutes — later runs only fetch what's new.
- \`pt.resample(frame, rule, session_open="09:15") -> DataFrame\` — coarser bars from finer ones (\`"60min"\`, \
\`"4h"\`, \`"W-FRI"\`); an intraday rule starts each bucket at the trading session's open, not a fixed clock split.
- \`pt.universe(name=None, providers=("zerodha",)) -> Universe\` (a list of symbols with \`.source\` saying \
where they came from) — the symbols to work on so a script runs the first time with nothing configured: a \
named watchlist, else the user's first non-empty one, else ten large NSE stocks. Prefer this over hardcoding \
tickers when the user hasn't named any.
- \`pt.watchlists() -> DataFrame\` (\`id\`, \`name\`, \`count\`) and \`pt.watchlist(name_or_id, providers=None) -> \
list[str]\` — the app's own watchlists, by name or id.
- \`pt.instruments(provider, exchange=None, kind=None, q=None, limit=None) -> DataFrame\` — a broker's tradable \
symbols, to build a universe from; its \`symbol\` column feeds straight into \`pt.bars\`.
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
- \`pt.plot(figure=None, title=None)\` — a matplotlib figure (the current one by default).
- \`pt.set_watchlist(name, symbols, mode="replace")\` — creates or refreshes one of the app's own watchlists \
from a result (a screen's matches, say — \`symbols\` can be a list, a Series/Index, or a DataFrame with a \
\`symbol\` column); \`mode="append"\` only adds. What a script schedule (run automatically at set times) usually \
ends with.

## Worth knowing

- Errors are \`protrade.ProTradeError\` subclasses: \`NotConfiguredError\` (no broker set up yet), \`NotFoundError\` \
(a watchlist or symbol that doesn't exist), \`RateLimitedError\`, \`AuthError\`, \`BadRequestError\`.
- The script only ever *reads* market data — it can't place, modify or check an order, and it never sees the \
user's broker credentials.
- For studying historical events across many stocks (not one script's own logic), there's a separate, more \
structured engine, \`protrade.ResearchStudy\` — normally built through the app's own Studies tab rather than by \
hand; only reach for it if that's really what's being asked for.`;
}
