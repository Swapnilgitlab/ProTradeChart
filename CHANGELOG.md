# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com), and the
project uses [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added

- **A Home tab.** A house icon in the right rail opens an overview of the application — starting a chart or opening a
  saved layout, the watchlist and alerts, Ask AI, Python, Studies and the Screener, connecting data and AI providers,
  importing your own data, the theme and keyboard shortcuts, and About and Help — one click from each other.
- **Flag a watchlist symbol in one click.** Each row has a flag button before its ticker. A click flags the symbol with the
  colour you last used; a right-click (or a click on a flagged symbol) offers every colour and **Remove flag**.
- **A list per flag colour.** A flag now belongs to the symbol — it shows on every list the symbol is on — and each colour
  has its own list (**Red flag** … **Purple flag**, under **Flagged** in the list selector) of every symbol flagged with it,
  newest first. Adding a symbol to one flags it; removing it unflags it. Flags set on individual lists before this are
  carried over (a symbol flagged differently on two lists keeps the first list's colour).
- **Add to watchlist from the chart, as in TradingView.** Point to **Add SYMBOL to watchlist** in a chart's right-click
  menu to see every watchlist with a checkbox, ticked where it already holds the symbol. Tick or untick as many as you like —
  the menu stays open — or choose **New watchlist…**. Quick-access lists come first. (This replaces the separate
  "Add to “name”" items.)
- **Tabs fit however many are open.** Tabs narrow together as more open — dropping the price, then the day's change, then the
  close button on inactive tabs — and the active tab stays readable. Past their minimum width the strip scrolls, with arrows
  at its ends, the mouse wheel, and the active tab always kept in view; the **+** button stays beside the tabs.
- **A chart's background belongs to its layout.** A canvas background chosen in a chart's settings is saved with the layout,
  restored with it, and kept when the theme changes; a chart without one follows the theme as before. Vela's attribution
  mark is re-inked to stay visible on whatever background it sits on.
- **Drawings belong to their symbol.** A drawing made on RELIANCE now shows on every chart of RELIANCE — any tab, window,
  layout or timeframe — and no longer follows a chart onto another symbol. Drawings are saved automatically; those saved in
  existing layouts are taken over by their symbol the first time the layout opens.
- **Add to a watchlist from the chart.** Right-click a chart → **Add to watchlist…** (any list, or a new one), or one click on
  **Add to “name”** for each quick-access list.
- **Quick-access watchlists.** Star up to five lists: they sit as buttons across the top of the watchlist panel and appear in
  the chart's right-click menu.
- **Browse all watchlists.** A dialog listing every watchlist, to search, open, star, rename, delete and create them.
- **Indices watchlist.** One click builds a watchlist of Indian indices from your Zerodha or Dhan instrument list, grouped as
  Broad market, Sectors (Nifty Bank, IT, Pharma, Auto, FMCG, Metal…) and Themes.
- **Resizable side panel.** Drag the left edge of the watchlist, alerts or Ask AI panel to change its width (double-click to
  reset); the width is remembered.
- **Help Center.** A **Help** icon at the bottom of the right rail (or `F1`) opens a searchable guide to every part of the
  app — charts, grids, layouts, the Script Editor and Strategy Tester, watchlists, alerts, the Screener, Python, schedules,
  Studies, Ask AI, data and AI providers, importing data, themes and updates — with an indicator reference, the keyboard
  shortcuts, privacy and security, and troubleshooting.
- **Scheduled Python scripts.** In the Python tab, **Schedule** runs a script by itself at set times while the app is open:
  once a day, or every N minutes between two times, on the days you choose (IST). The new **Schedules** tab lists every schedule
  with its next run and what happened each time — with the output of each run, why one failed (the main window also says so),
  and runs that were **missed** because the app was closed or the computer asleep. A missed run is never made up, and starting
  the app never runs a script. Switch one off, run it now, stop it, edit or delete it.
- **Scripts can keep a watchlist up to date.** `pt.set_watchlist(name, symbols)` makes the watchlist or refreshes it — replacing
  its symbols (those it keeps stay where they were, flags and sections untouched) or, with `mode="append"`, adding to them. It
  takes a list, a Series or a screen's DataFrame. Schedule such a script for after the close and the list is fresh every evening.
- **A Screener.** A new rail button opens a Screener tab: pick a universe (a broker's NSE/BSE list, a watchlist, or symbols),
  filter on any of the Studies' indicators judged on each stock's latest bar ("crosses above" means today), choose columns and
  an order, and run it. Matches come back as a sortable table — click one to chart it, add them all to a watchlist, or save a
  CSV. Screens are saved with their last result; eight presets (52-week highs, volume spikes, golden crosses, RSI oversold in
  an uptrend…) are there to start from.
- **OpenAI as a second AI provider, and one place to manage both keys.** A new **AI providers** icon on the right rail opens a
  dialog for either provider's API key — Claude (Anthropic) or GPT (OpenAI) — with a choice of which one to use once both are
  configured. The Study Builder's drafts, revisions, explanations, research plans and syntheses, and the new Ask AI below, all
  work with either.
- **Ask AI: an assistant on the rail that can act in the app.** A new rail panel (`Alt+A`) answers questions and can propose
  adding or removing a watchlist symbol, creating a watchlist, opening a symbol or changing the chart's timeframe, adding or
  removing an indicator, and creating a price alert — each shown as its own card that does nothing until you press **Approve**;
  **Reject**, or leaving it alone, does nothing. It never sees your watchlists' contents, only their names, and never anything
  from Python or Studies.
- **A right-hand icon rail with switchable panels.** A strip of icons down the right edge shows the **Watchlist** or the
  **Alerts** panel beside the chart, and folds it away when you press the icon again (`Alt+W` for the watchlist). The
  choice is remembered. Alerts now have a panel of their own — pause, resume, re-arm, edit and delete from it, click one
  to chart its symbol — instead of a pop-up list; the bell moved from the tab bar to the rail, badge and all, and making or
  editing an alert still opens the form. The **Script Editor**, **Python** and **Data providers** buttons moved from the tab
  bar to the rail too (the plug pinned at the bottom), and light up while the editor or the Python tab is showing.
- **Richer watchlist rows.** Right-click a row to flag it with a colour, add an alert, open it in a new tab, move it to the
  top, add a section above it or remove it. Group symbols under **sections** that fold away (click the heading; rename or
  delete it from its menu), and **drag** rows or whole sections into any order. A price that moves flashes green or red.
  Sorting by a column still shows a flat list.
- **Live price and day change in every tab**, beside the symbol's name. Tabs of streaming charts follow the market tick
  by tick; the rest refresh every 20 seconds.
- **Python for screening and research.** A Python tab (`Ctrl+Shift+Y`) beside your charts, with a script list, an editor,
  a console and a results view, runs your
  own scripts against your Zerodha or Dhan data. Scripts `import protrade as pt` for DataFrames of bars
  (`pt.bars`, `pt.bars_many`), instrument lists, watchlists and `pt.resample`, and can use any library you install beside them.
  It uses your own Python 3.10+ in a private environment the app creates (or an interpreter you name); nothing is bundled.
  Scripts are plain `.py` files you can edit anywhere, run only when you press Run, and stop with everything they started.
  Your broker credentials never reach a script: it asks the app, over a local connection protected by a one-off token, and the
  app fetches, paces and keeps the bars, so a second screen fetches only what is new (after the market closes, nothing at
  all) and a long first run shows its rate and time left. Research only — nothing places an order.
  Scripts show their work in the panel: `pt.show(frame)` puts a sortable table in the **Results** tab where clicking a symbol
  opens its chart and the list can be added to a watchlist, `pt.report(trades=…, equity=…)` shows a backtest (return, drawdown,
  CAGR, Sharpe, win rate, profit factor, an equity curve against a benchmark, and the trades), and `pt.plot()` shows a
  matplotlib figure. Run outside the app they print instead. Four examples are included: three screens and a backtest.
  See the README's Python section.

- **Studies: a historical market research engine.** A Studies tab (the flask on the rail) asks what stocks looked like around
  past events rather than what qualifies today. A Study is a saved, rerunnable **Study Specification** — universe, period,
  event, observation and forward windows, metrics, characteristics and a comparison group — built in a form, read back in
  plain words, and checked for **data readiness** before it runs (market cap, sectors and point-in-time universes are reported
  unavailable, never guessed; a market-cap filter is blocked with a traded-value floor offered instead). The Python engine
  (`protrade.study`) finds **every historical date** the event first happened, measures ~30 families of price, volume and
  technical features at each observation point, compares with a seeded control group of non-event dates (or splits the events
  by a later outcome), and returns distributions, characteristic shares, forward returns and the typical price path. The
  results page has a summary, an event table whose rows open the chart framed and marked at the event, the event timeline,
  distributions, before vs after, liquidity groups, the comparison and a stock explorer — all labelled historical
  association. Nine templates (100% and 200% Winners, Breakout Winners, Post-Consolidation Breakouts, Volume Expansion, Trend
  Transition, Relative Strength Leaders, Drawdown Recovery, Custom). Runs are stored with their spec, data span, data version
  and software versions; **Generate Python** writes an editable step-by-step script, and **Export** saves the spec, Python,
  event / stock / metric CSVs, the full result or a report.

- **Studies load much faster, and say how long they will take.** A Study now fetches only shares — an exchange's "equity"
  list is mostly bonds, gold bonds, G-secs, T-bills and funds, and they were each costing a broker request — and studies a
  company listed on NSE and BSE once. Loading keeps the broker's rate limit busy the whole time and finds events while the
  rest is still arriving, with the rate and time left in the progress bar. Before a run, the data check shows how many stocks
  will be loaded, how many are already stored and roughly how long the rest will take, and offers a trial on 100 stocks.
  New *Listings* choices add the trade-for-trade (BE) and SME series. Each result records how long each stage took.

- **Studies: significance, comparisons and Research Notebooks.** Each Study now tests whether its events really differ from
  the comparison group — a Mann–Whitney test with an effect size for every measurement and forward return, and a difference
  in shares with a 95% interval for every characteristic, adjusted for the Study's many comparisons — and lists what stands out
  in plain words, still as historical association. Two stored results can be compared side by side, with how their Studies
  differ spelled out. Research Notebooks group Studies and results with your notes; a result kept in a notebook is never pruned.
  The CSV and the report include the tests.
- **Studies: an AI Study Builder, with your own Claude API key.** Describe a research question in plain words and Claude drafts a
  Study Specification — or changes the current one on request — showing what changed, what it assumed and what can't be studied
  with the data available (it never substitutes data that doesn't exist). Every proposal is checked like any spec and only loaded
  into the builder when you choose; nothing runs until you press Run Study. **Explain with Claude** reads a result back in plain
  words, as historical association. The key is checked with Anthropic and kept in the OS keychain; requests are made by the app's
  backend, not the web view.
- **Studies: research with Claude.** Ask a research question and Claude plans up to four complementary Studies; approve the
  ones to run and they run one after another, then Claude writes a synthesis across the results — what they agree on, where the
  evidence is thin — and suggests follow-up questions, each needing its own approval. Every round is recorded in a Research
  Notebook. Claude's answers now stream, so long plans don't time out, and every Claude button shows its progress.
- **Studies: measure the journey to an event, its aftermath, and episodes.** A Study could only take snapshots on single days
  around each event, so a question such as "on how many days in the 12 months before doubling did it close just above its 21
  EMA?" came back as "what share of stocks were above it on that one day". Studies now have **measures**: one number per event
  over a window — days (or share of days) a set of conditions all held, the longest streak, separate stretches (pullbacks), a
  feature's average, lowest or highest, the return, biggest rise, worst fall — over a fixed window (the 12 months before, the 6
  months after) or an **episode** that starts or ends on a day found near the event (from its 12-month low; until its first
  close below the 50 SMA). Nothing is estimated: an event whose window is too recent, lacks history, or whose trend hadn't broken
  within the search says so. Each result now opens with a plain-English **answer** from the Study's headline measures, with the
  comparison group and how many events it covers. A Study can have a **question**, shown above its answer. Claude now drafts
  such questions as measures, and says what a Study can't express instead of approximating it. Earlier Studies and results open
  as before.
- **Studies: an answer-first results page and a builder for measures.** A result now opens with its question and plain
  answer, one chart (how a measure spreads across the stocks, or day by day how many stocks were, say, sitting just above
  their 21 EMA), and the stocks one by one with each measure's value — click a row to open its chart at the event. Every
  table the page had before is still there, folded under **Details**. The builder has a **Question** box and a **What to
  measure** section: pick a stat, its conditions or feature, and a window — the 12 months up to the event, the 6 months after,
  from the stock's 12-month low, until its first close below the 50 SMA, or a custom start and end. The single-day snapshot
  settings are folded under **Event-day snapshot**. Two new templates, **How Winners Got There** and **After the Breakout**,
  and measures on 100% Winners, 200% Winners and Breakout Winners.

### Fixed

- **Charts no longer leave a stock at all-time highs sitting well below the top of the pane.** Vela's own autoscale padded
  every chart by nearly 29% above the highest visible price and 14% below the lowest, with no setting to change it; a small
  patch to the bundled library (`patches/`, applied automatically) brings both down to 10%.
- **Asking Claude to draft or change a Study no longer fails** with "The compiled grammar is too large": the answer's schema is
  now small, and the Study Specification comes back as JSON text that the app validates as before.
- **Cached daily bars no longer vanish.** The offline cache trimmed old intraday data by comparing against interval names the
  brokers never use, so every broker daily bar older than 45 days was deleted each time the app started. Charts fell back to
  much less data than they should have when a request failed.
- **Broker requests no longer read the OS credential store every time.** Each request used to make three lookups in Windows
  Credential Manager (or the equivalent), each while holding the database lock the rest of the app waits on: thousands over one
  large watchlist or Python screen, and thousands of lines in the debug log. Credentials are now remembered in memory for up to a
  minute; saving or removing one takes effect at once.

- **Zerodha logs in with one click.** Set your Kite app's redirect URL to `http://127.0.0.1:47821` (shown, with a
  Copy button, next to the login button) and *Log in with Zerodha* now collects the access token itself — no copying
  the address out of the browser. Pasting it by hand is still there for Kite apps that redirect elsewhere.

- **Licences in the app.** *About* now has a Legal section with the copyright notice and the AGPL's no-warranty statement,
  links to the source code, and shows the licence and **THIRD_PARTY_LICENSES.txt** — the copyright notice and licence
  text of every npm package and Rust crate compiled into the app — without leaving it. The file is installed with the app
  too. `npm run licenses` regenerates it, and releases rebuild it before building and attach the source of PineTS,
  Vela PineTS and Vela at the exact versions used.

- **Checksums.** Every release now carries a `SHA256SUMS` file listing the SHA-256 hash of each installer, so a download can
  be verified (PowerShell, `shasum` and `sha256sum` instructions are in SECURITY.md). The release workflow attaches it after all
  the platform builds finish, and `node scripts/checksums.mjs <folder>` writes the same file for installers you host yourself.
- **Automatic updates.** ProTradeChart checks GitHub for a newer release about once a day and shows a dot on the About button and
  a notice when one is waiting; *About → Updates* checks on demand, downloads with progress and installs. Every update
  is verified against a signing key built into the app before it runs, and the daily check can be turned off. Releases now
  need the updater signing key in the repository's secrets (see CONTRIBUTING).
- **Price alerts.** Set an alert on any chart — right-click → *Add alert here…* (starting at the price under the cursor), the
  chart toolbar's *Alert* button, or `Alt+A` — and get a system notification, a toast and a chime when the price crosses
  your level, once or every time. The bell in the tab bar lists, pauses, edits and deletes alerts and badges the ones that
  fired while you were away. Works with every data source; a level crossed while the app was closed still fires when it
  next opens. Alert levels aren't drawn on the chart yet.
- **Zerodha** as a second broker provider: Kite Connect history (1/3/5/10/15/30/60-minute and daily candles, built up to
  other timeframes), a live tick feed shared across all charts and windows, watchlist quotes, and symbol search over
  Zerodha's public instrument lists (about 24,000 equities, indices and futures). Kite tokens expire every morning, so the
  Data providers screen has an in-app login: open Zerodha's page, paste the address it redirects to, and the token is
  saved to your keychain. Needs a Kite Connect subscription with market data.
- **Bundled Pine indicators.** Every `.pine` file under `pine/indicators/` is built into the app: it appears in the chart's
  Indicators dialog (grouped by its folder) and in the Script Editor's **Open** menu, and is saved by name in layouts. Adding
  one is just writing the file (`pine/README.md`); `npm test` runs each on the real engine so a broken script can't ship.
- **Pine Script: your own indicators and a strategy tester.** A Script Editor (syntax colouring, completion, a console for
  errors and warnings) and a Strategy Tester share a resizable panel under the charts, opened from the tab bar or with
  `Ctrl+E`. Start from an example, write `indicator()` or `strategy()` code, and add it to the chart. Saved scripts live
  in your script library; scripts on a chart are saved with the layout, and the pencil on a script's legend row reopens its
  code. Inputs and (for strategies) properties such as capital, commission and order size are edited in the chart's
  settings dialog. The Strategy Tester shows an Overview with the equity curve against buy & hold, a Performance summary
  (all / long / short) and a List of trades. Backtests run on the chart's loaded bars and are approximate: they can
  differ from TradingView's. Powered by [PineTS](https://github.com/LuxAlgo/PineTS).
- **Older history loads as you scroll back.** Charts used to stop at their first ~500 candles (two years of daily bars)
  and show empty space beyond. Scrolling or zooming toward the oldest loaded candle now fetches more, in the background
  and without moving the view, until the source has nothing older. Works for every data source and every chart of a
  grid.
- **Chart grids.** Each tab can now show 1 to 16 charts (1×1 up to 4×4), chosen from the layout button in the chart's
  toolbar, with sync switches for symbol, interval, crosshair and style. The active chart is the one the search box and
  watchlist act on and the one the tab is named after. Saved layouts keep the grid. New charts start on the tab's symbol;
  the first time a tab grows into a grid, a hint explains how to change one chart's symbol.
- **Data providers.** A settings screen to turn each data source on or off, enter and test broker credentials, and choose
  the default provider for symbols typed without one. Search can be scoped to a single source.
- **Dhan** as the first broker provider: exchange-grade history (1/5/15/25/60-minute and daily bars, built up to other
  timeframes), a live tick feed shared across all charts and windows, watchlist quotes, and symbol search over Dhan's
  instrument list. Credentials are kept in the OS keychain and used only by the Rust backend.
- Watchlist import maps NSE/BSE symbols to your broker (Dhan or Zerodha) when you have one set up.

### Fixed

- **Forget credentials** in *Data providers* now works as soon as anything is saved. It used to need a complete setup, so
  a wrong Zerodha API key and secret, saved before the first login, could not be cleared.

- Restoring a saved layout that contains a moving average could throw an error ("Cannot read properties of undefined
  (reading 'bars')") because the indicator was handed its saved settings before it had been started.
- **Layouts no longer carry the theme.** Saving a layout used to record the current theme and loading it switched the
  app to that theme; it also baked the theme's chart colours into the layout, so a layout saved in a dark theme turned a
  light-theme chart dark. Layouts now leave the theme alone, and layouts you already saved are cleaned up when loaded.

### Changed

- **Symbols read as the ticker alone.** Watchlists, tabs, chart titles, the chart's status line and watermark, alerts,
  search results and a script's screener output no longer show the data source or the usual exchange: `HFCL`, not
  `zerodha:NSE:HFCL`. An exchange is still shown when leaving it out would make two instruments look alike
  (`BSE:RELIANCE` beside `RELIANCE`), and the status line keeps the timeframe. Hovering the symbol in a chart's status line
  shows the full symbol, and nothing stored changes: watchlists, layouts and alerts keep their existing symbols.
- **Crypto symbols show a two-letter badge instead of a coin logo.** The logos came from Ledger's icon server, a third
  party you never chose to contact. The web view no longer loads images from the internet at all.
- The README, About and third-party notices now spell out each data source's terms: the crypto exchanges' own terms, and
  broker data being licensed to you alone.
- **About** now credits the developer, Swapnil Pawar of ProTradeJournal, with links to their X and GitHub profiles.
- **New logo and app icon.** A single candlestick in a green rounded tile, with the wordmark in Geist and "Trade" in
  green. The README carries the full logo, and the app icon (window, taskbar, installers), the favicon and the About
  dialog use the tile; the smallest sizes are drawn with a thicker candle so they stay sharp at 16px.

- **The app is now licensed under the GNU AGPL-3.0** (it was MIT) because Pine Script support bundles PineTS, which is
  AGPL-3.0. Nothing changes for using the app; anyone who redistributes it, or a modified version, must do so under the
  same licence with the source available.
- The Content-Security-Policy now allows `'unsafe-eval'`, which PineTS needs to compile scripts. Scripts run in a Web
  Worker with no access to the page or the backend.
- **Binance is the default data source.** New charts, symbols typed without a provider, and the starter watchlist (crypto
  pairs from Binance, Coinbase and Hyperliquid) use sources that need no account. Importing a watchlist sends a bare
  ticker to the default provider, NSE/BSE symbols to your Dhan or Zerodha account when one is set up, and reports any
  symbol no source can chart as skipped.

### Removed

- **Yahoo Finance is no longer a data source.** The provider, its rate limiter, the opt-in terms dialog and the first-run
  intro are gone, and the app makes no request to Yahoo. US and world stocks, FX, indices and futures are no longer available
  (Indian markets remain available through Dhan or Zerodha). Watchlists, layouts and alerts you saved with `yahoo:`
  symbols are left as they are — a layout opened with such a tab swaps it for Bitcoin and says so — and the cached Yahoo
  bars and settings are deleted once, on first launch.

## [0.1.0] — initial release

### Added

- Candlestick charting on [Vela](https://luxalgo.com/vela): chart styles, drawing tools, 70+ indicators, multiple panes.
- Data from Yahoo Finance (stocks, ETFs, indices, FX, futures; 1-minute to monthly bars, 2h/3h/4h built from hourly),
  and live-streaming crypto from Binance, Coinbase and Hyperliquid.
- Import your own OHLCV CSV and chart it offline; coarser timeframes are built automatically.
- Browser-style chart tabs, extra windows, and named layouts (with a default layout that also seeds new tabs).
- Watchlists with live prices and day change, sorting, and import from TradingView exports.
- Six themes; the starting theme follows the OS.
- Local-only SQLite storage, with an offline fallback cache for Yahoo bars.
