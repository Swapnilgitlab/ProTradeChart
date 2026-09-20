# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com), and the
project uses [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added

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
  Indicators dialog (grouped by its folder) and in the Pine Editor's **Open** menu, and is saved by name in layouts. Adding
  one is just writing the file (`pine/README.md`); `npm test` runs each on the real engine so a broken script can't ship.
- **Pine Script: your own indicators and a strategy tester.** A Pine Editor (syntax colouring, completion, a console for
  errors and warnings) and a Strategy Tester share a resizable panel under the charts, opened from the tab bar or with
  `Ctrl+E`. Start from an example, write `indicator()` or `strategy()` code, and add it to the chart. Saved scripts live
  in your script library; scripts on a chart are saved with the layout, and the pencil on a script's legend row reopens its
  code. Inputs and (for strategies) properties such as capital, commission and order size are edited in the chart's
  settings dialog. The Strategy Tester shows an Overview with the equity curve against buy & hold, a Performance summary
  (all / long / short) and a List of trades. Backtests run on the chart's loaded bars and are approximate: they can
  differ from TradingView's. Powered by [PineTS](https://github.com/LuxAlgo/PineTS).
- **Older history loads as you scroll back.** Charts used to stop at their first ~500 candles (two years of daily bars)
  and show empty space beyond. Scrolling or zooming toward the oldest loaded candle now fetches more, in the background
  and without moving the view, until the source has nothing older — a daily Yahoo chart reaches back to the stock's
  listing, intraday charts to the limit Yahoo keeps. Works for every data source and every chart of a grid.
- **Chart grids.** Each tab can now show 1 to 16 charts (1×1 up to 4×4), chosen from the layout button in the chart's
  toolbar, with sync switches for symbol, interval, crosshair and style. The active chart is the one the search box and
  watchlist act on and the one the tab is named after. Saved layouts keep the grid. New charts start on the tab's symbol;
  the first time a tab grows into a grid, a hint explains how to change one chart's symbol.
- **Data providers.** A settings screen to turn each data source on or off, enter and test broker credentials, and choose
  the default provider for symbols typed without one. Search can be scoped to a single source.
- **Dhan** as the first broker provider: exchange-grade history (1/5/15/25/60-minute and daily bars, built up to other
  timeframes), a live tick feed shared across all charts and windows, watchlist quotes, and symbol search over Dhan's
  instrument list. Credentials are kept in the OS keychain and used only by the Rust backend.
- Watchlist import maps NSE/BSE symbols to Dhan when it is the default provider.

### Fixed

- Restoring a saved layout that contains a moving average could throw an error ("Cannot read properties of undefined
  (reading 'bars')") because the indicator was handed its saved settings before it had been started.
- **Layouts no longer carry the theme.** Saving a layout used to record the current theme and loading it switched the
  app to that theme; it also baked the theme's chart colours into the layout, so a layout saved in a dark theme turned a
  light-theme chart dark. Layouts now leave the theme alone, and layouts you already saved are cleaned up when loaded.

### Changed

- **About** now credits the developer, Swapnil Pawar of ProTradeJournal, with links to their X and GitHub profiles.
- **New logo and app icon.** The README carries the full logo, and the app icon (window, taskbar, installers), the favicon
  and the About dialog use its P mark on a light rounded plate, so they stay legible on dark taskbars and docks.

- **The app is now licensed under the GNU AGPL-3.0** (it was MIT) because Pine Script support bundles PineTS, which is
  AGPL-3.0. Nothing changes for using the app; anyone who redistributes it, or a modified version, must do so under the
  same licence with the source available.
- The Content-Security-Policy now allows `'unsafe-eval'`, which PineTS needs to compile scripts. Scripts run in a Web
  Worker with no access to the page or the backend.
- Asking Yahoo for a window before a symbol's first trade, or an intraday window past what it keeps, now counts as "no
  data there" (an empty result) instead of an error.

- **Kinder to Yahoo Finance.** Yahoo publishes no rate limits, so every request is now paced (at least 250 ms apart, at
  most 60 a minute) and the app stops sending anything for 30 seconds — doubling on repeated failures, up to 15 minutes —
  as soon as Yahoo answers *429 Too Many Requests*, drawing charts from the local cache meanwhile.
- Watchlist prices are fetched 20 symbols to a request instead of one request per symbol, and reused for 20 seconds;
  symbol searches are cached for 5 minutes.
- Charts showing the same Yahoo symbol and timeframe now share one live poll, and a failing poll backs off instead of
  retrying at full speed. Regaining window focus no longer refreshes prices fetched in the last 10 seconds.

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
