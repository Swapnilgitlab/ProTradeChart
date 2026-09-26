# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com), and the
project uses [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added

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

### Fixed

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
- **New logo and app icon.** The README carries the full logo, and the app icon (window, taskbar, installers), the favicon
  and the About dialog use its P mark on a light rounded plate, so they stay legible on dark taskbars and docks.

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
