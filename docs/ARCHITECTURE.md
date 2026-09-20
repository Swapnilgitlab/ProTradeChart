# Architecture

A [Tauri 2](https://tauri.app) desktop app: a **React + TypeScript** frontend running in the OS webview, and a small
**Rust** backend that owns the database, holds broker credentials, and talks to Yahoo Finance and broker APIs. Charts
are drawn by [Vela](https://luxalgo.com/vela).

```
┌────────────────────────── webview (React + TypeScript) ──────────────────────────┐
│  Workspace (tabs, layouts) ── ChartView ── VelaWorkspace ── data providers ──┐   │
│  WatchlistPanel ── quotes ─────────────────────────────────────────────────┐ │   │
│  SymbolSearchBox ── search ──┐                                              │ │   │
└──────────────────────────────┼──────────────────────────────────────────────┼─┼───┘
        Vela's own providers   │      Tauri IPC (lib/ipc.ts)                  │ │
   (Binance / Coinbase /       │                                              │ │
    Hyperliquid, over HTTPS    ▼                                              ▼ ▼
    and WebSocket)        ┌──────────── Rust backend (src-tauri) ────────────────────┐
                          │ commands.rs ─ market.rs ─ yahoo.rs   ── Yahoo Finance   │
                          │      └────── store/* ── SQLite (charting.db)             │
                          └───────────────────────────────────────────────────────────┘
```

Dhan follows the same shape as Yahoo, with two additions: its commands live in `provider_commands.rs` and `dhan/`, and its
live feed is a single WebSocket owned by Rust that pushes `dhan-tick` and `dhan-status` events to every window.

## Symbols and providers

A chart symbol is always `provider:TICKER` (`yahoo:AAPL`, `binance:BTCUSDT`, `csv:MY_DATA`). The prefix is what
selects the data source: it's Vela's own routing rule, and `lib/symbols.ts` holds the helpers for it.

A provider is a Vela [`DataProvider`](../node_modules/@luxalgo/vela/dist/DataProvider-DLeFs1gE.d.ts): an object with
`getBars(ticker, timeframe, range)` and, optionally, `subscribe`, `listSymbols` and `info`. `src/data/providers/`
registers one shared instance of each — shared so the crypto providers' cached symbol lists are downloaded once, and
so search and watchlist quotes use the same instance the charts do.

| Provider | Where | Notes |
| --- | --- | --- |
| `yahoo` | `data/providers/yahoo.ts` + `src-tauri/src/{yahoo,market}.rs` | Fetched by Rust (no browser CORS, cacheable). |
| `dhan` | `data/providers/dhan.ts` + `src-tauri/src/dhan/` | The user's own Dhan account. All calls go through Rust, which holds the credentials. |
| `csv` | `data/providers/csv.ts` + `src-tauri/src/store/datasets.rs` | User-imported files, served from SQLite. |
| `binance`, `coinbase`, `hyperliquid` | Vela's bundled providers | Fetched directly from the webview; they also stream live. |

### Yahoo Finance and rate limits

Yahoo publishes **no rate limits** for the endpoints this app uses, and what users report varies with time and IP
address. So the app doesn't aim at a number it can't verify; it keeps well below any reported figure and stops the
moment Yahoo says stop. All of it lives in the Rust backend, in `gate.rs` and `market.rs`:

- **Every Yahoo request goes through a `Gate`** (`gate.rs`, a pure state machine that takes the time as an argument, so
  it is unit-tested without sleeping). It spaces request starts at least 250 ms apart, caps them at 60 per rolling
  minute (our own ceiling, not Yahoo's), and *refuses* a request that would have to queue for more than 12 s instead of
  building an unbounded backlog. A refused chart request falls back to the local bar cache.
- **On HTTP 429 the gate closes**: nothing is sent to Yahoo until the pause ends — 30 s, doubling for each consecutive
  429 up to 15 min, or the server's `Retry-After` if that is longer. Requests already queued are dropped when the 429
  lands, and a stray success from before the pause doesn't reopen or reset it. Continuing to hit a limiter that has said
  "stop" is what turns a short throttle into a block that lasts hours.
- **Fewer requests.** Watchlist prices use `/v8/finance/spark`, which takes 20 symbols per request (a longer list is
  chunked), instead of one chart request per symbol; results are reused for 20 s and symbol searches for 5 min.
- **Merged history requests.** Simultaneous identical history requests share one fetch (`data/inflight.ts`) — a grid of
  charts that all boot on the same symbol makes one request, not sixteen. It is not a cache: it only merges requests that
  overlap in time.
- **Shared polling.** Yahoo has no push feed, so live bars are polled. `data/livePoll.ts` gives every chart showing the
  same symbol and timeframe one shared timer and one request per tick. Polling is skipped while the window is hidden,
  slows down when the market is quiet, and backs off exponentially when polls fail.

The knobs are the constants in `gate.rs` (`Limits::default`) and `market.rs` (`QUOTE_TTL`, `SEARCH_TTL`). Run a debug build
and each request logs `yahoo request: <path>`, which is the easiest way to count what the app really sends.

### History on demand

A Vela chart loads to a fixed *depth* (`market.bars`, 500 by default — two years of daily candles) and never fetches more
by itself; scrolling past the oldest bar just shows empty space. `chart/historyBackfill.ts` closes that gap:

- **When.** It watches each chart's `viewport:changed` and, once the left edge is within half a screen of the oldest
  loaded bar, raises the depth with `setMarket({ bars })`. Vela then fetches the extra bars in the background and
  prepends them with the view unmoved. Each step doubles the depth (at least +500), and it repeats until the view is
  covered.
- **When to stop.** `history:complete` reports `genesis` when the source has nothing older — that ends it for the
  current symbol and timeframe (a new load starts afresh). A failed load (`aborted`) is retried after 30 s, and three
  in a row end it. Depth is capped at 50,000 bars.
- **Testable.** The decision logic is the pure `HistoryBackfill` class, driven by a clock and callbacks; `watchHistory`
  only wires it to a chart. `ChartView` attaches it to every cell of the grid.

What the providers must do for this to work: Vela asks for "`limit` bars ending at `to`" with no start time
(`isBackfillRequest`), and reads an *empty* answer as the start of history. So `lookbackMs` never uses a window shorter
than the longest market closure (a chunk ending just after a weekend must not come back empty), and the backend turns
Yahoo's "no data before the first trade" answers (HTTP 400 `Data doesn't exist for startDate…`, HTTP 422 for intraday
windows past what Yahoo keeps) into an empty result rather than an error (`yahoo::is_window_without_data`). A real
failure during a backfill is thrown, not toasted: Vela keeps what it has and the watcher retries later.

Each step is one request through the Yahoo `Gate`, so it stays inside the rate limits.

### Price alerts

Alerts are a small feature with a clean split:

- **Storage** (`store/alerts.rs`, `alert_commands.rs`): a `price_alerts` table, and commands to list, save, delete and
  clear fired alerts. Saving tells every window (`alerts-changed`), so lists and the engine stay current.
- **Rules** (`alerts/logic.ts`, pure): what counts as *crossing* a level (reaching it counts; leaving a level you sat on
  counts; staying on it doesn't), what an alert looks like after firing, and the wording. Unit-tested to the edge cases.
- **Engine** (`alerts/engine.ts`): every 20 s (and on any change) it asks `fetchQuotes` for the prices of the active
  alerts' symbols — one request per provider batch, so it works for every data source — and fires those that crossed.
  A crossing is judged between two samples; the first sample is compared with the alert's stored `basePrice` (the price
  when it was made or last fired), which is how a level crossed while the app was closed still fires. An alert that fails
  to save is not announced and is looked at again next time. The engine takes its dependencies as arguments, so its tests
  run without a network or database.
- **One watcher.** Every window shares the alerts, so only the window labelled `main` runs the engine
  (`Workspace.tsx`); otherwise each open window would fire the same alert.
- **Announcing** (`alerts/notifier.ts`): a toast (the `alert` toast kind lingers), a system notification through
  `tauri-plugin-notification`, and a chime made with the Web Audio API. Each channel fails independently.
- **On the chart** (`chart/alertActions.ts`): Vela's `registerWidgetAction` puts *Add alert here…* in the chart's context
  menu, *Add alert at this price…* in the price axis menu, and an *Alert* button in the toolbar. Vela's context object
  doesn't carry the clicked price, so the chart's crosshair is tracked (`renderer.onCrosshairMove`) and the last price
  under the cursor is used. The actions only ask the app to open the dialog (`alerts/ui.ts`); the dialog is React.

Not done yet: drawing alert levels on the chart. Vela's drawings (`chart.drawings.add('hline', …)`) could carry them, but
they would share the undo history, be saved into layouts (they'd need stripping, like `withoutTheme`), and be draggable, all
of which needs designing.

### Updates

ProTradeChart updates itself through `tauri-plugin-updater`; the pieces:

- **The manifest.** `plugins.updater.endpoints` (in `tauri.conf.json`) is
  `…/releases/latest/download/latest.json` on GitHub. `tauri-action` uploads that file with every release, and it only
  resolves once the release is *published* (a draft is invisible), so publishing is the moment an update goes live.
- **Trust.** Each installer is signed with the updater key (`bundle.createUpdaterArtifacts`); the plugin verifies the
  signature against `plugins.updater.pubkey` before running anything. It is independent of OS code signing.
- **Logic** (`updates/updater.ts`, pure): a small state machine — idle, checking, current, available, downloading,
  installed, error — with the plugin and the restart injected, so it is unit-tested without Tauri. `updates/autoCheck.ts`
  runs the background check (20 s after launch, then daily; the `autoUpdateCheck` preference is read each time; a failed
  background check is silent). `updates/service.ts` wires the real plugin.
- **UI.** *About → Updates* (`features/about/UpdatesSection.tsx`) checks, installs and holds the switch; a dot on the About
  button and one toast announce a waiting update. Only the `main` window checks in the background.
- **Restart.** Windows' installer closes the app itself; on macOS and Linux the `restart_app` command
  (`update_commands.rs`) relaunches through Tauri's normal exit path.

### Adding a data provider

1. Implement `DataProvider` in `src/data/providers/<name>.ts`. Return bars sorted ascending, `time` in epoch
   milliseconds. Report failures with `notify('error', …)` from `data/events.ts` (it becomes a toast) and return `[]`.
2. Add it to `instances` and `providerFactories` in `data/providers/index.ts`, and add its id to `ProviderId` and
   `PROVIDER_LABELS` in `lib/symbols.ts`.
3. Search: if it can enumerate symbols (`listSymbols`), add its id to `CRYPTO_PROVIDERS` in `data/search.ts` or write a
   results function beside the others. If it needs the network from Rust (to dodge CORS, or to cache), add a command in
   `src-tauri/src/commands.rs` and a wrapper in `lib/ipc.ts`.
4. Add tests for anything that parses or plans a request.

## Provider settings and credentials

`src-tauri/src/providers.rs` is the single source of truth for **what providers exist and what each needs configured**:
a `ProviderSpec` lists its label, category (`free`, `broker`, `local`), capabilities, and its credential fields (which are
secret). The frontend never hard-codes any of that — the *Data providers* screen renders itself from `list_providers`, so
a new provider appears there with no UI work.

- **Enabled vs configured.** A provider is *usable* when it is switched on and every field has a value. Free providers start
  on; brokers start off. `data/providerStatus.ts` mirrors this for non-React code (search, quotes and the providers
  consult `isProviderUsable`); every provider is still *registered* with Vela regardless, so a saved layout that holds a
  symbol from a provider that has since been switched off says so instead of failing to resolve.
- **Secrets never touch SQLite.** Non-secret settings (the `enabled` flag, a client ID) live in `provider_settings`.
  Secret fields go to the OS credential store through `secrets.rs`. If that store is unavailable the value falls back to the
  `provider_secrets_fallback` table and `Storage::Database` is reported, which the UI shows as an explicit "unencrypted"
  warning. Secrets are write-only over IPC: `list_providers` says *whether* one is set, never what it is.
- **The default provider** (what a bare typed ticker means) is a UI preference; the search box also lets you scope a search
  to one source.

### Adding a broker

Dhan and Zerodha are the two worked examples: `dhan/` and `zerodha/` have the same layers, and where they differ (Dhan
renews a 24-hour token and silently drops the socket on a bad one; Zerodha needs a login every morning and refuses a bad
key at the WebSocket handshake) each says so in its module docs. Two things are shared: `throttle.rs` (request pacing)
and, on the webview side, `data/feedHub.ts` (fans one Rust socket's ticks out to the charts that want them). The two
feed actors (`dhan/feed.rs`, `zerodha/feed.rs`) are near copies with different protocols; a third streaming broker would
be the moment to extract the shared connect/backoff/refcount loop into one.

1. **Spec.** Add a `ProviderSpec` to `PROVIDERS` in `providers.rs`: fields (say `apiKey` non-secret, `accessToken` secret),
   `category: "broker"`, and its capabilities. The settings screen now shows it.
2. **Backend.** Add `src-tauri/src/<broker>/` beside `dhan/`. Keep the layers the same: a pure `protocol.rs` (request
   bodies, response parsing, error classification, all unit-tested), an `instruments.rs` if the broker needs a symbol →
   id table, a `client.rs` for HTTP (paced, with retry on rate limits, tested against a local mock server), and a
   `feed.rs` if it streams. Read credentials with `providers::credential`; never accept them from the frontend per call.
3. **Commands.** Expose `<broker>_fetch_bars`, `_search_instruments`, `_quotes` and `_subscribe`/`_unsubscribe` in
   `provider_commands.rs` (or a sibling file), register them in `lib.rs`, and add typed wrappers to `lib/ipc.ts`.
4. **Symbols.** Use `provider:EXCHANGE:SYMBOL` (`zerodha:NSE:RELIANCE`) — the same exchange codes `Segment::exchange()` uses
   for Dhan — so tickers stay consistent across Indian brokers. Add the id to `ProviderId` and `PROVIDER_LABELS` in
   `lib/symbols.ts`.
5. **Provider.** Add `data/providers/<broker>.ts` (a Vela `DataProvider`). Reuse `data/providers/common.ts` for range
   sizing and bar conversion, `lib/timeframes.ts` for resampling (add a `to<Broker>Plan` next to `toDhanPlan`), and
   `lib/liveBar.ts` if the broker streams ticks rather than candles. Register it in `data/providers/index.ts`.
6. **Search and quotes.** Add a results function to `data/search.ts` and a batch to `data/quotes.ts`, both gated on
   `isProviderUsable`.
7. **Verify against the real service** with deliberately fake credentials: real error responses are the cheapest way to
   catch wrong endpoints, header names and error shapes. (That is how Dhan's "accept the socket, then drop it" behaviour
   on a bad token was found.)

## Dhan

- **Symbols** are `dhan:EXCHANGE:SYMBOL`. Dhan identifies instruments by a numeric `SecurityId`, so the backend downloads
  Dhan's public instrument master (~26 MB, ~207k rows), keeps the ~11k rows that can be charted (stocks and ETFs, indices,
  futures — not options), and resolves tickers from SQLite. Search runs against the same table.
- **History** is `POST /charts/historical` (daily) and `/charts/intraday` (1/5/15/25/60 minutes, 90 days per request). The
  client splits long intraday ranges, paces requests, and retries on rate limits. Other timeframes are built from those by
  the resampling in `lib/timeframes.ts`, anchored to the session open.
- **Timestamps are checked, not trusted.** Dhan's docs say only "epoch". `detect_timestamp_shift` (Rust) compares the returned
  times with the requested window — and, for intraday, with trading hours — to catch a 1980-based epoch or an IST clock
  written as UTC. The live feed's times get the same treatment in `lib/liveBar.ts`, against the local clock.
- **The live feed** (`dhan/feed.rs`) is one WebSocket shared across the app, reference-counted per instrument, connecting only
  while something is subscribed. It reconnects with backoff, and it recognises that a wrong token isn't refused with a message
  — the socket opens and is dropped at once — by stopping after three such drops and telling the user. Ticks reach every
  window as `dhan-tick` events; `data/dhanLive.ts` fans them out to charts, and `LiveBarBuilder` turns them into the forming
  candle.

## Timeframes and resampling

Vela speaks canonical timeframes — minutes as bare digits (`"5"`, `"60"`), and `D` / `W` / `M`. `lib/timeframes.ts`:

- parses them, and maps one to a Yahoo interval plus, when Yahoo doesn't serve it natively, a group size (4h = four 60m
  bars);
- builds coarser bars from finer ones. Intraday grouping **restarts at every session open** (a 4h chart on a US stock
  is 09:30–13:30 then 13:30–close, not a fixed clock split), and uses the exchange's timezone offset to decide where
  a day begins.

**Daily-and-up bars are stamped at local midnight of the exchange's calendar date; intraday bars keep their real
instant.** Each new chart is set to the machine's timezone (`ChartView.tsx`) so both read correctly on the axis.

## Persistence

One SQLite file (`charting.db`, in the OS's per-user app data folder), opened by `src-tauri/src/db.rs`.

| Table | Holds |
| --- | --- |
| `ui_preferences` | Key/value settings (theme, watchlist panel state) |
| `chart_layouts` | Named sessions. `state_json` is **opaque to Rust** — the frontend owns its shape (`LayoutDocument`, versioned) |
| `pine_scripts` | The user's Pine Script library: name, kind (`indicator` / `strategy`) and source |
| `watchlists`, `watchlist_items` | Lists and their symbols |
| `datasets`, `dataset_bars` | Imported CSV data |
| `bars_cache`, `symbol_meta` | Offline fallback for Yahoo and Dhan bars, and each symbol's exchange timezone |
| `provider_settings` | Per-provider `enabled` flag and non-secret configuration |
| `provider_secrets_fallback` | Credentials, **only** when no OS keychain exists (unencrypted; the UI says so) |
| `dhan_instruments` | Dhan's instrument list, for symbol search and `SecurityId` lookup |

`src-tauri/src/store/*` are plain functions over a `&Connection` with unit tests against an in-memory database.
`commands.rs` is a thin wrapper that locks the connection, calls into the store, and flattens errors to strings.
Schema changes: `CREATE TABLE IF NOT EXISTS` won't alter an existing table, so a new column needs a guarded
`ALTER TABLE` step in `Database::init`.

## Layouts and tabs

Each tab is its own `VelaWorkspace`, which is a grid of one to sixteen charts ("cells"). It starts as a single chart
(`layout: '1'`); Vela's toolbar offers 1×1 to 4×4 and the sync switches, so the app has no grid UI of its own. A
background tab is `display: none`, so it has no size and Vela can't be built into it; `ChartView` therefore builds the
grid on the **first non-zero size** and forwards later resizes. Saving a layout reads every live tab's state
(`getState()`, which covers all of its cells); a tab that was never shown falls back to the state it was restored with.
Loading a layout replaces the tab set.

With more than one cell, code must not assume "the chart": `ws.chart` is the *active* cell's chart, and cells come and go
(and may be rebuilt) when the grid changes. So a tab's symbol is that of its active cell — `ChartView` re-points its
`market:changed` subscription on `cell:active`, `layout:changed` and `cell:created` — and per-chart tweaks (the softened
grid lines) are applied to `ws.cells()`, not to one chart. Symbol picks from the search box or watchlist go to the
active cell. Because new cells boot on the tab's symbol, a large grid asks for the same history many times at once;
`data/inflight.ts` merges those into one request (see "Yahoo Finance and rate limits").

**A layout never carries the theme.** The theme is an app-wide preference, so saving records no theme name and loading
changes none. Vela's state would otherwise smuggle one in: `rendererConfig` holds the chart's background, text, grid and
border colours, and restoring a state does not re-skin the chart (`setTheme` with the mode it is already in does
nothing), so a layout saved in the dark theme turned a light-theme chart dark. `withoutTheme()` in
`features/layouts/layoutDocument.ts` removes exactly those six settings — what `setTheme` changes, no more — both when
saving and when loading, which also cleans layouts saved by earlier versions. Colours the user picked themselves
(candles, lines) are kept.

Vela owns a chart's state after construction, so `initialSymbol` / `initialState` are seeds only, and symbol changes go
through the imperative `ChartViewHandle`.

## Vela specifics worth knowing

- `installThinMovingAverages()` must run **after every** `new VelaWorkspace(...)`, because Vela re-registers its built-in
  moving-average indicators on each construction. It swaps in 1px-wide lines.
- Vela's attribution mark is left on. Don't disable it without showing an equivalent credit — see
  [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
- Links rendered by Vela (its attribution mark) would navigate the app window; `lib/externalLinks.ts` sends every
  `http(s)` link to the system browser instead.

## Pine Script

Custom indicators and strategy backtests run on [PineTS](https://github.com/LuxAlgo/PineTS) through LuxAlgo's
`@luxalgo/vela-pinets`, which plugs into Vela's `ScriptingEngine` port. Vela then does all the drawing — plots, fills,
labels, tables, trade markers — plus the legend and the settings dialog (Inputs / Properties tabs). Nothing here draws a
script.

| Piece | Where | Notes |
| --- | --- | --- |
| Engine | `pine/engine.ts` | `registerDefaultEngine('pine', …)` in `main.tsx`, before any workspace exists. A `PineWorkerEngine` wrapped in `BarsTap`, which records the bars each script runs on (Vela hands them only to the engine) so the tester can build an equity curve |
| Library | `store/scripts.rs`, `pine_scripts` table, `lib/ipc.ts` | Saved scripts. The frontend detects a script's kind from its declaration (`pine/source.ts`) |
| Layout persistence | `pine/persistence.ts` | Vela doesn't save runtime-added scripts, so a `registerStatePersistence` handler stores each chart's script indicators in the layout's per-chart `ext`: source, plus only the input and prop values that differ from the defaults. The layout is self-contained: it still opens if the script was deleted from the library |
| Ids | `pine/ids.ts` | An indicator this app adds is `<libraryScriptId>~<suffix>`, so a legend row leads back to its library script, and one Vela added itself (a bundled script) can be told apart |
| Bundled scripts | `pine/indicators/**/*.pine`, `pine/bundled.ts` | Scripts that ship with the app. Vite inlines them (`import.meta.glob(…, '?raw')`), and they are handed to Vela as its indicator **manifest** with `enabled: false`, so they appear in the chart's Indicators dialog (grouped by folder) without being added to every chart. Vela saves a manifest indicator in layouts **by name**, so a script's declared title is its identity; `persistence.ts` skips them so they aren't restored twice. `bundled.engine.test.ts` compiles and runs every one on the real engine. Editing a `.pine` file reloads the dev app (`reloadOnPineChange` in `vite.config.ts`: a hot-swapped module would leave the live chart on the old script). See `pine/README.md` |
| Backtest report | `pine/tester.ts` | Pure. The engine reports fills and account state, not P&L, commission or an equity history, so trades, net P&L, run-up, drawdown, the equity curve and the summary are derived from fills + bars + the strategy's commission setting. Tests hold the numbers to PineTS's own ledger (`tester.engine.test.ts`) |
| UI | `features/pine/` | A bottom dock (`PineDock`) with the Pine Editor (CodeMirror 6, `pineLanguage.ts`) and the Strategy Tester. Opened from the tab bar, `Ctrl+E`, or the "Edit script" button registered on every script's legend row (`pine/hostActions.ts`) |

- **The backtest covers the bars the chart has loaded**, so a longer test means scrolling the chart back (see "History on
  demand"). `script:run` events drive the tester; strategies removed from the chart are pruned.
- **Results are approximate.** PineTS's broker emulator differs from TradingView's in order-handling details
  (LuxAlgo/PineTS#316), and equity, run-up and drawdown here are measured on bar closes. One case bites often: an order
  for 100% of equity plus commission is closed at once by a "Margin call". The tester detects and explains it.
- Adding a script to a chart uses `chart.runScript`, which puts it on the chart only if it compiles. Editing one in place
  uses `handle.updateCode`, whose success is the script's next `script:run` with `cause: 'code'` — a handle's own
  `ready` event fires only once.
- `handle.title` is a placeholder until a script runs; the title it declares comes from `script:run` or
  `declaredTitle(source)`.

## Themes

`src/theme/themes.ts` is a registry: each theme supplies every token in `ThemeTokens` (TypeScript enforces it) and a
`baseMode` of `light` or `dark`, the nearest mode Vela understands. `ThemeProvider` applies the tokens as CSS custom
properties on `<html>` and persists the choice. To add a theme, append one entry — nothing else changes.

## Security model

- The webview's Content-Security-Policy (`tauri.conf.json`) blocks remote scripts and frames, and allows outbound
  connections (`connect-src https: wss:`), which the crypto providers need.
- **`script-src` includes `'unsafe-eval'`, and only for Pine.** PineTS compiles a script to JavaScript with
  `new Function`, which the policy otherwise blocks (checked: without it every script fails to compile). The engine is
  always the worker one (`PineWorkerEngine`): a Worker has no DOM and no Tauri IPC, so a pasted script can't reach the
  backend or a broker credential. Never switch to the in-process `PineEngine`, and don't add other uses of `eval`.
- Tauri capabilities (`src-tauri/capabilities/default.json`) grant only what's used: window creation, the system
  browser opener, native dialogs, notifications, updates, and logging. The frontend has **no file-system access**; files are read through the
  browser's file picker.
- Broker credentials live in the OS keychain and are read only by the Rust backend; the web view never receives an access
  token, and the settings screen can't read one back.
- Yahoo symbols are percent-encoded as a single URL path segment on the Rust side, so a hostile ticker can't alter the
  request path.
