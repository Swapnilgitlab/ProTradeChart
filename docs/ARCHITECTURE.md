# Architecture

A [Tauri 2](https://tauri.app) desktop app: a **React + TypeScript** frontend running in the OS webview, and a small
**Rust** backend that owns the database, holds broker credentials, and talks to the broker APIs. Charts
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
                          │ commands.rs ─ dhan/ ─ zerodha/      ── broker APIs        │
                          │      └────── store/* ── SQLite (charting.db)             │
                          └───────────────────────────────────────────────────────────┘
```

Dhan and Zerodha sit behind Rust: their commands live in `provider_commands.rs` / `dhan/` and `zerodha_commands.rs` /
`zerodha/`, and each live feed is a single WebSocket owned by Rust that pushes `dhan-tick` / `dhan-status` (and
`zerodha-tick` / `zerodha-status`) events to every window.

## Symbols and providers

A chart symbol is always `provider:TICKER` (`binance:BTCUSDT`, `dhan:NSE:RELIANCE`, `csv:MY_DATA`). The prefix is what
selects the data source: it's Vela's own routing rule, and `lib/symbols.ts` holds the helpers for it.

A provider is a Vela [`DataProvider`](../node_modules/@luxalgo/vela/dist/DataProvider-DLeFs1gE.d.ts): an object with
`getBars(ticker, timeframe, range)` and, optionally, `subscribe`, `listSymbols` and `info`. `src/data/providers/`
registers one shared instance of each — shared so the crypto providers' cached symbol lists are downloaded once, and
so search and watchlist quotes use the same instance the charts do.

| Provider | Where | Notes |
| --- | --- | --- |
| `dhan` | `data/providers/dhan.ts` + `src-tauri/src/dhan/` | The user's own Dhan account. All calls go through Rust, which holds the credentials. |
| `zerodha` | `data/providers/zerodha.ts` + `src-tauri/src/zerodha/` | The user's own Kite Connect account, the same shape as Dhan. |
| `csv` | `data/providers/csv.ts` + `src-tauri/src/store/datasets.rs` | User-imported files, served from SQLite. |
| `binance`, `coinbase`, `hyperliquid` | Vela's bundled providers | Fetched directly from the webview; they also stream live. |

### How a symbol is shown

The stored and canonical form of a broker symbol spells its exchange (`zerodha:NSE:HFCL`), so a watchlist row, an alert
and a chart always agree on one string. What people see is shorter, and there are three forms in `lib/symbols.ts`:

- `normalizeSymbol` — the canonical form. A broker ticker with no exchange means NSE, so `zerodha:HFCL` becomes
  `zerodha:NSE:HFCL`. Everything that comes *back from Vela* passes through it.
- `displayTicker` — for the app's own screens (watchlist, tabs, alerts, search, script results): no data source, and no
  `NSE:`. Other exchanges stay, because `BSE:RELIANCE` is a different instrument from `RELIANCE`.
- `chartSymbol` — the form a chart is *given*. Vela writes a chart's title, status line and watermark from the ticker part
  of the symbol it holds, so a chart holding `zerodha:HFCL` shows `HFCL`. The backends read a bare ticker as NSE, so it
  loads the same instrument. `ChartView` applies it at every point a symbol goes into Vela, and `withChartSymbols`
  (`features/layouts`) does the same for the charts inside a layout as it opens.

Vela also prints the data source in the status line (`· ZERODHA · 1D`), from its provider registry rather than from the
symbol. `chart/statuslineMeta.ts` removes the source and keeps the timeframe, and puts the full symbol in the hover text.
It watches Vela's `.vela-sl-meta` element, so a Vela upgrade that renames that class only brings the source name back.

### Yahoo Finance was removed

Yahoo Finance used to be a data source, through its unofficial public endpoints. It was removed entirely — provider,
backend client, rate limiter and the terms/opt-in UI that existed only for it — so the app has **no source for US and most
world stocks, ETFs, FX or indices**; those need an imported CSV. What it left behind, and how that is handled:

- **Saved symbols.** Watchlists, layouts and alerts keep their `yahoo:…` symbols (user data isn't rewritten), but nothing
  can load them. `isSupportedSymbol` (`lib/symbols.ts`) recognises them. Opening a layout moves each affected tab, and
  each affected cell of a grid, to the starter symbol and says so (`withoutUnsupportedSymbols`, in `Workspace`);
  clicking such a watchlist row says the source is gone; their quotes and alerts stay empty. Saving the layout again
  drops the old symbols.
- **Stored cache and settings.** `store/retired.rs` runs once at startup and deletes what Yahoo put in SQLite: every
  `bars_cache` row whose key isn't a broker's (`dhan:…` / `zerodha:…`), the `symbol_meta` and `symbol_names` tables, its
  `provider_settings` and the preferences only it used. Nothing the user wrote is touched.
- **Defaults.** A bare ticker means Binance (`DEFAULT_PROVIDER`), which needs no account; a brand-new chart and the
  starter watchlist are crypto. The TradingView watchlist importer maps the crypto exchanges and, with a broker set up,
  NSE/BSE; everything else is reported as skipped.
- **Company names** now come only from the brokers' instrument lists (`store/symbol_names.rs`); crypto and imported data
  have none.

Don't bring back a source that reads an unofficial endpoint, and keep `yahoo` out of every provider list
(`providers::spec("yahoo")` is tested to be absent).

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
than the longest market closure (a chunk ending just after a weekend must not come back empty), and a provider answers
"nothing older" with an empty result rather than an error. A real failure during a backfill is thrown, not toasted: Vela
keeps what it has and the watcher retries later.

Each step is one request, paced by the broker client's own throttle (`throttle.rs`), so it stays inside the broker's limits.

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
  under the cursor is used. The actions only ask the app to open the new-alert form (`alerts/ui.ts`); the form is React (`AlertFormDialog`), and the list
  of alerts is the rail's Alerts panel (`AlertsPanel`).

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
  warning. Secrets are write-only over IPC: `list_providers` says *whether* one is set, never what it is. `Secrets` remembers
  what the OS store said for a minute, because every broker request reads its credentials and each read is an OS call made
  while holding the database lock; every write goes through `Secrets::set` / `delete`, which update the memory at once, so a
  token saved after the daily login applies to the next request. That changes how long a credential stays in the process (up to a
  minute, where each request already held it briefly), not which ones; it never reaches disk, the web view or the log. `has`
  answers "is it set?" without copying a value out.
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

- parses them, and maps one to what a broker serves natively plus, when it doesn't serve it, a group size
  (`toDhanPlan`, `toKitePlan`: 4h = four 60m bars);
- builds coarser bars from finer ones. Intraday grouping **restarts at every session open** (a 4h chart on a US stock
  is 09:30–13:30 then 13:30–close, not a fixed clock split), and uses the exchange's timezone offset to decide where
  a day begins.

**Daily-and-up bars are stamped at local midnight of the exchange's calendar date; intraday bars keep their real
instant.** Each new chart is set to the machine's timezone (`ChartView.tsx`) so both read correctly on the axis.

## Side panels, watchlists and tab prices

### The right rail

A strip of icons down the window's right edge (`features/rail/RightRail.tsx`) shows one panel at a time beside the chart:
the watchlist or the price alerts. Pressing the icon of the panel that is showing folds it away. `Workspace` holds the choice
(`railPanel`) and remembers it in the `right_panel` preference (`features/rail/railPanel.ts`, pure and tested: what a saved
value means, and the fallback to the old `watchlist_collapsed` setting for a first launch after the rail arrived).

The watchlist panel stays **mounted** while another panel shows (it is `display: none`, and stops fetching prices), so its
list, sort and scroll position are still there when it comes back; the alerts panel mounts when shown. To add a panel: add its
id to `RAIL_PANELS`, a button to `railPanels` in `Workspace.tsx`, and render it in `app-body`.

Below the panel buttons the rail also holds **actions** (`RailAction`): the Script Editor and Python buttons (`railTools`) and, pinned
to the bottom, the Data providers plug (`railFooter`). They open something elsewhere — the Pine dock, the Python tab, a dialog —
rather than a side panel. An action that is either showing or not is lit while it shows (`pressed`): the Python button when the
Python tab is the active one, and the Script Editor button while the dock is open, which `PineDock` reports through
`onOpenChange` since it owns that state (and isn't mounted, so isn't showing, while the Python tab is).

### Watchlists

- **Storage.** `watchlist_items` and `watchlist_sections` share one sequence: both have a `position`, numbered from 1
  (`store/watchlists.rs`), so a section heading sits wherever its position falls among the symbols, and a section owns the
  symbols after it up to the next heading. `set_order` takes the whole order of rows (`RowRef { kind, id }`) and renumbers; rows
  it leaves out follow in their current order and unknown ones are skipped, so an order that went stale (a Python script added a
  symbol meanwhile) can neither fail nor scramble the list. `migrate` adds the `position` and `flag` columns to a database made
  before them, once. `WatchlistDetail` keeps `items` and `sections` apart, so the Python API and everything else that reads a
  list still sees symbols only, in list order.
- **Rows.** `lib/watchlistRows.ts` (pure, tested) merges the two into one list, hides what a collapsed section holds, works out
  where a dragged row may land (a symbol never inside a collapsed section; a section only between blocks, and it takes its
  symbols with it) and renumbers after a move.
- **One row height.** The list is windowed and finds a row by dividing by a single measured height, so section headings are
  exactly one row tall too. Sorting by a column shows a flat list without headings and switches dragging off.
- **Dragging uses pointer events** (`useRowDrag.ts`), not HTML5 drag and drop: the window's file-drop handler swallows in-page
  drags on Windows. Changes (order, flag, a section's name or folding) show at once and are then saved; if the backend refuses
  one, the list is read again (`saveOrReload`).

### Tab prices

Each chart tab shows its symbol's price and the day's change. `useTabQuotes` polls `fetchQuotes` for just the tabs' symbols (the
same call the watchlist and alerts use, every 20 s at most, not while the window is hidden). That gives the change from the
previous close and covers a tab whose chart isn't streaming. On top of it, every streaming provider publishes each bar it
delivers to `data/livePrices.ts` (`withLivePriceTap` in `data/providers/index.ts`), so the tabs of streaming charts tick with
the market at no extra cost; `lib/tabQuote.ts` (pure, tested) re-measures the change from the polled quote's previous close,
prefers whichever of the two is newer, and drops a streamed price that has gone stale. **A new streaming provider has to be
wrapped by the tap**, or its tabs fall back to the poll.

## Persistence

One SQLite file (`charting.db`, in the OS's per-user app data folder), opened by `src-tauri/src/db.rs`.

| Table | Holds |
| --- | --- |
| `ui_preferences` | Key/value settings (theme, which side panel the rail shows) |
| `chart_layouts` | Named sessions. `state_json` is **opaque to Rust** — the frontend owns its shape (`LayoutDocument`, versioned) |
| `pine_scripts` | The user's Pine Script library: name, kind (`indicator` / `strategy`) and source |
| `watchlists`, `watchlist_items`, `watchlist_sections` | Lists, their symbols (with a colour flag) and their section headings; see "Watchlists" |
| `datasets`, `dataset_bars` | Imported CSV data |
| `bars_cache` | Offline fallback for the brokers' bars (keys start `dhan:` / `zerodha:`) |
| `research_bars`, `research_coverage` | The Python API's store of the brokers' bars, and which span of each series is complete (see "Python") |
| `studies`, `study_results` | Saved Study Specifications and completed Study runs (see "Studies") |
| `provider_settings` | Per-provider `enabled` flag and non-secret configuration |
| `provider_secrets_fallback` | Credentials, **only** when no OS keychain exists (unencrypted; the UI says so) |
| `dhan_instruments` | Dhan's instrument list, for symbol search and `SecurityId` lookup |

`src-tauri/src/store/*` are plain functions over a `&Connection` with unit tests against an in-memory database.
`commands.rs` is a thin wrapper that locks the connection, calls into the store, and flattens errors to strings.
Schema changes: `CREATE TABLE IF NOT EXISTS` won't alter an existing table, so a new column needs a guarded
`ALTER TABLE` step in `Database::init`.

## Layouts and tabs

A tab is a chart or a workspace — Python or Studies (`features/workspace/tabs.ts`, pure and tested; at most one of
each, opened from the rail, Python also by `Ctrl+Shift+Y`). A workspace tab has no symbol and no chart, so:

- the chrome that needs a chart — the watchlist's highlight, the Pine dock, a new alert's symbol, and where
  a picked symbol loads — follows `activeChartTab`, which is the active tab when that is a chart and otherwise
  the chart last looked at, so opening Python doesn't move the watchlist off the symbol you were on;
- picking a symbol anywhere (the search box, the watchlist, a script's results) loads it into that chart **and
  shows it**, which is how a screen's clickable symbols work;
- **a layout holds charts only.** `captureLayoutDocument` saves the chart tabs and an `activeTabIndex` among
  them; loading one replaces the charts and leaves the Python tab open, with its scripts and any running script
  untouched. So a saved session never carries a Python tab, by design;
- **the last chart tab can't be closed** (`canCloseTab`), because the chrome above needs one; the Python tab
  always can.

Each chart tab is its own `VelaWorkspace`, which is a grid of one to sixteen charts ("cells"). It starts as a single chart
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
the brokers' clients pace their own requests (`throttle.rs`), so the burst is spread out.

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
| UI | `features/pine/` | A bottom dock (`PineDock`) with the Script Editor (CodeMirror 6, `pineLanguage.ts`) and the Strategy Tester. Opened from the right rail, `Ctrl+E`, or the "Edit script" button registered on every script's legend row (`pine/hostActions.ts`) |

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

## Python

The user's own scripts run as **child processes** of the app and reach market data through a small **local API**, so a
broker's credentials never leave Rust: a script asks for bars, and Rust fetches (through the same paced clients the charts
use), keeps them, and answers. It is for research — screening, backtesting, analysis. Nothing here places an order.

```
 Python tab ─── invoke ──▶ python_commands.rs ── spawn ──▶ <venv>/python script.py   (import protrade as pt)
      ▲                        │  stdout/stderr                       │
      └────── events ◀─────────┘                                      │ HTTP, Authorization: Bearer <token>
                                pyapi/ (127.0.0.1) ◀──────────────────┘
                                   │  research store  ── Zerodha / Dhan clients (paced) ──▶ brokers
```

| Piece | Where | Notes |
| --- | --- | --- |
| Interpreter | `python/env.rs` | The app never bundles or downloads Python. It finds one by *running* `py -3` / `python` / `python3` and reading `sys.version_info` (so the Microsoft Store's stub, which is on `PATH` where no Python is installed, isn't taken for one), makes a venv in `<app data>/python/venv` and installs pandas and numpy. The user may name their own interpreter instead (preference `python_interpreter`), and then nothing is installed unless they ask. |
| Runner | `python/runner.rs` | Starts `python -u script.py` with no stdin (so `input()` fails instead of waiting), streams each line as a `python-output` event, and on Stop ends the whole process tree (`taskkill /T`, or a process group), because a script may use `multiprocessing`. A lone `\r` marks a progress-bar line the console overwrites. Output past 4 MB is dropped with a notice. It knows nothing of Tauri (output goes to a callback), so it is tested against a real Python. |
| Scripts | `python/scripts.rs` | Plain `.py` files in `<app data>/python/scripts`, so any editor and `git` work on them. The frontend names a script and never sends a path; `validate_name` refuses anything that could leave the folder, a Windows device name, and a name that would shadow a library (`pandas.py` beside a script replaces pandas for it). Examples (`python/examples/`) are copied in and kept current: the app records a hash of what it wrote (`.examples-seeded`), refreshes an example nobody has touched when a newer one ships, and leaves alone one the user edited or deleted. They must work with no setup (a test runs them for a user with no watchlists). |
| Client | `python/protrade/` | Standard library plus pandas. It is embedded in the app (`python/client_files.rs`), written to `<app data>/python/lib` at each run and put on the child's `PYTHONPATH`, so it is never `pip install`ed and always matches the running app. A test fails if a module is added to the folder without being listed in `FILES`. |
| Local API | `pyapi/` | `data.rs` (bars: store reads plus broker fetches), `routes.rs` (auth and routing, against a `Backend` trait), `server.rs` (hyper), `backend.rs` (the real `Backend`, plus the error mapping), `wire.rs` (JSON). Read-only `GET`s: `/v1/bars`, `/v1/instruments`, `/v1/watchlists`, `/v1/watchlist`, `/v1/providers`, `/v1/ping`; plus `POST /v1/results`. |
| Results | `pyapi` `POST /v1/results` → `python-result` → `python/results.ts` → `features/python/Results*.tsx` | What a script shows: `pt.show` (a table), `pt.report` (a backtest) and `pt.plot` (a matplotlib PNG); a Study's result is kind `study` (see "Studies"), and one sent by a script in the Python tab is stored with the Studies' results. Rust checks only what makes forwarding safe — the run id, the kind, a title's length, and that a figure's bytes really start like a PNG — and the webview validates the shape before drawing. The report reuses the Strategy Tester's `EquityChart`. |
| Research store | `store/research_bars.rs` | Bars kept for the API, with a *coverage* per series. See below. |
| UI | `features/python/`, `python/` (TS) | **A tab of its own**, beside the charts (`features/workspace/tabs.ts`), holding the script list, the editor, the console and the results. `python/console.ts`, `format.ts` and `results.ts` are pure and tested. It loads nothing until the tab is first shown: no Python is probed and no example is written for someone who never opens it. |

- **A script's output is data, never markup.** A script is code the user wrote, so `python/results.ts` refuses anything it
  doesn't recognise rather than drawing it: a table's rows are squared off to its columns and unusable cells become blanks,
  a curve keeps only points where both the time and the value are numbers, and a figure must be base64 that begins with
  PNG's own bytes (an SVG would carry script). Nothing is ever put into the DOM as HTML. Keep it that way.
- **The API is loopback-only and every request must prove itself** (`pyapi/routes.rs`). Binding to `127.0.0.1` alone doesn't make
  it private: any local program can connect, and so can a web page in the user's browser, directly or through a DNS name pointed
  at 127.0.0.1. So the `Host` header must name this listener's own address and port (defeats DNS rebinding), a request with an
  `Origin` header is a browser's and is refused, and the `Authorization: Bearer` token must match. The token is 256 random bits made
  when the API starts, given only to scripts the app runs (`PROTRADE_API`, `PROTRADE_TOKEN`), and compared in constant time. Don't
  loosen any of it, add a route that returns a credential or touches an order, or add CORS headers. Each connection has a header
  timeout and there is a cap on connections, so a stalled or runaway client can't hold it up. **Who is asking is settled before any
  body is read** (`server.rs` calls `authorize` first), so an unauthorised caller can't make the app buffer megabytes; a body is
  capped at 16 MB, by its declared length and again as it arrives.
- **The store is not `bars_cache`.** `bars_cache` is the charts' offline fallback and its pruning is tuned for them. The research store
  is never pruned, and records per `(symbol, interval)` the span whose bars are complete, because "no bars" (a holiday, a stock not
  yet listed) and "not fetched yet" look alike in the bars table. `research_bars::plan` is the whole sync policy and is pure: given
  the coverage, the request and the time it says which ranges to fetch. Ranges always touch the existing coverage, so it stays one
  span, and a series whose last sync reached the present is served as it stands rather than refetched because "now" moved. An
  intraday tail is refetched from a few bars back (to replace the forming bar) once it is older than its ttl. A **daily** series
  follows the exchange's calendar instead (`market.rs`, pure like the planner): a settled session's bar never changes, so the age of
  a sync is no reason to look again. Only a session that settled after the coverage's end (15:30 IST plus half an hour) triggers a
  refresh, from that last day, or during market hours a forming bar older than five minutes. So a second screen the same evening,
  or over a weekend, costs no broker requests. Holidays are deliberately not modelled (a list in a binary rots): one is a single
  empty check, after which coverage reaches past it. MCX trades to 23:30, so its daily bar is taken as final early until the next
  refresh corrects it.
- **The first run is bound by the broker, and a script can't change that.** Kite allows three history requests a second and has no
  batch endpoint, and every caller (charts, backfill, scripts) shares one client whose `Throttle` releases a request every 350 ms
  however many are waiting, so `bars_many`'s workers only overlap the waiting: 984 symbols is about six minutes, once. A daily
  request's span is rounded up to 90-day blocks (`lookback_ms`) so two screens asking for 250 and 257 bars start on the same date;
  otherwise each symbol needs a second request for the few days between them, which doubled the run. *Not built:* Kite's
  `/quote/ohlc` returns today's bar for 200+ symbols a call, the only way past the first run of each trading day, but its
  `ohlc.close` is the previous close (today's is `last_price`) and volume needs the fuller `/quote`.
- **Record what was fetched, not what was asked.** The brokers' clients answer a range longer than one call may span with only its
  newest part (`MAX_CHUNKS`), and Dhan's intraday history stops at five years. `Fetcher::fetch` returns where the fetch *really began*,
  the store records that, and `limitedFrom` tells the script the data starts later than it asked (a `DataLimitWarning` in Python).
- **Daily bars belong to an IST calendar date.** They are put on midnight IST whichever instant the broker stamped them with, a
  daily range selects whole dates (an `end` date includes that day), and the client returns them on a timezone-aware IST index.
  Intraday bars keep their real instant. Only the brokers' native intervals are served (Kite 1, 3, 5, 10, 15, 30, 60 minutes and
  daily; Dhan 1, 5, 15, 25, 60 and daily); `pt.resample` builds the rest, restarting each bucket at the session open like the charts.
- **Sources.** Zerodha, Dhan and imported CSV datasets. The crypto sources are fetched by the webview, not Rust, and are not offered.
  Errors carry a stable `code` (`auth`, `not_configured`, `no_access`, `rate_limited`, `not_found`, `bad_request`, `upstream`) that the
  client turns into an exception class; `auth` and its kin are *fatal* to a batch, since every later symbol would fail the same way.
- **Python is not a sandbox.** A script has the user's own privileges, as from a terminal, so it could read `charting.db` or the
  OS keychain like any local program. What this design guarantees is narrower: the app never *hands* a script a credential, no route
  returns one, and a script runs only when the user presses Run — never on opening a layout, importing a file or starting the app.
  The environment a script inherits has `TAURI_*` (the updater's signing key, during development) removed.

## Studies

A **Study** asks what stocks looked like around historical market events — *which stocks doubled in twelve months, and
what did they look like 3, 6 and 12 months before?* It is research, not a scanner (what qualifies today) and not a backtest
(what trading rules would have made): its output is events, measurements around them, distributions and comparisons.

```
 Studies tab ── spec (JSON) ── invoke study_run ──▶ study_commands.rs ── writes <app data>/python/studies/<run>.json
      ▲                                                   │ spawn: python -m protrade.run_study <file>   (start_python)
      │ python-result (kind "study") ◀── pyapi POST /v1/results ◀── protrade/study.py ── GET /v1/bars … ── research store
      └── studies/result.ts validates ── save_study_result ── study_results table
```

The pipeline is fixed — **universe → historical data → event detection → event context → measurement → comparison →
aggregation → result** — and every part of it is described by the **Study Specification**, which is the product:

| Piece | Where | Notes |
| --- | --- | --- |
| Specification | `src/studies/spec.ts`, `protrade/study.py` `normalize_spec` | A JSON document (snake_case, because Python reads it and it is exported). The two sides apply the same rules and defaults — **keep them in step**; the tests on each side list the same refusals. Versioned (`version: 1`). |
| Features | `protrade/features.py`, `src/studies/metrics.ts` | One grammar of names: a family and a window in bars (`return_252`, `ema_200`, `rsi_14`, `dist_high_252`, `rvol_20`, `rs_126`…) plus aliases (`return_12m`, `distance_from_52w_high`). Python computes them; TypeScript accepts the same names and labels them. Returns and distances are fractions. A rolling feature is NaN until its window is full. |
| Conditions | both of the above | `{left, op, right}` with `>`, `>=`, `<`, `<=`, `crosses_above`, `crosses_below`; `right` is a number or a feature. Events, pre-event filters and characteristics are all conditions. |
| Engine | `protrade/study.py` (`ResearchStudy`) | Universe (instrument list, watchlist or symbols) → `load` (daily bars through the local API, in chunks so progress can be reported) → `detect_events` → `measure` → `control_group` or `split_by_outcome` → `analyze`. Each step is callable on its own; "Generate Python" writes a script that calls them one by one. |
| Runner | `protrade/run_study.py`, `study_commands.rs` | `python -m protrade.run_study spec.json`, started through the same `start_python` as a script (same environment, token and events), and only by the Run Study button. It is a module of its own because `-m protrade.study` would import the module twice. |
| Result | `studies/result.ts` | Posted as result kind `study`. Untrusted like any script output: re-validated (the spec included) and drawn as text and SVG only. `fixtures/engine-result.json` is real engine output (`python/tests/make_study_fixture.py`); a Python test fails when the engine's output shape drifts from it. |
| Storage | `store/studies.rs`; `studies`, `study_results` tables | Saved Studies (spec JSON, opaque to Rust) and completed runs (the whole result, so a run reopens without running again). The last 20 runs of each Study are kept. A run of a script's Study is stored under a `script:` id. |
| UI | `features/studies/` | A tab of its own like Python (`features/workspace/tabs.ts`): My Studies, templates and recent results on the left; the Builder (form, interpretation, **data readiness**) or the Results page (summary, event table, event timeline, distributions, before/after, liquidity groups, comparison, stock explorer) on the right. Pure helpers are in `src/studies/` and tested. |
| Chart | `chart/studyEvent.ts`, `ChartViewHandle.showEvent` | Opening an event points the followed chart at the symbol, daily, framed by `visibleRange` around the date, with a timeline mark. Vela treats marks as data to re-supply after a market switch, so `ChartView` re-applies the mark when that symbol's market lands and clears it when the chart moves elsewhere. |

- **Events are edges.** An event is the *first* bar on which all its conditions hold together, not every bar they hold, and
  the same stock can't have another for `cooldown_days` bars. Liquidity, price and pre-event filters are judged at the event
  (or `at` bars before), never with later data. The measurements at each observation point (`T-252 … T0 … T+252`, in bars)
  are the feature's value on that bar; a point outside the loaded history is blank, never filled from a neighbour.
- **Comparison.** Either a control group — random dates (seeded, so reproducible) from the same universe and period that pass
  the same filters, with no event within `cooldown_days` either side, so a run-up to an event isn't counted as "no event" — or,
  with an `outcome`, the events split by whether they went on to gain `min_return` within `window` bars. Everything is labelled
  a **historical association**; nothing in the UI or the report claims a cause.
- **Data the app doesn't have is said, not invented.** No source supplies market cap (current or historical), sectors, or a
  point-in-time list of listings. `studies/readiness.ts` reports each as unavailable before a run; a market-cap filter **blocks**
  the run (and the engine refuses one too) and the builder offers the honest alternative — a floor on 50-day average traded
  value, judged at the event — applied only when the user picks it. Every result carries a survivorship warning, and events
  carry `market_cap: null`. Sector grouping isn't shown; grouping by liquidity is.
- **Prices are used as supplied.** The broker's OHLCV is taken as already adjusted for corporate actions; nothing adjusts it.
- **Reproducibility.** A result carries its normalised spec, the engine, app, Python and pandas versions, the data span and a
  *data version* (a hash of each series' span, length and last close), the execution time and how long it took.
- **Performance.** Nothing heavy runs in the webview: the engine computes, the webview draws. A first run is bound by the
  broker's pace — one shared `Throttle` (Kite ≈ 2.9 history requests a second), one request per new symbol (a daily request
  spans up to 2000 days) — so what matters is how many symbols are fetched and that the pace is never idle:
  - **Only stocks are fetched.** A broker's "equity" list is mostly not shares (bonds, SGBs, G-secs, T-bills, ETFs, REIT/InvIT
    units; on BSE, thousands more). `listing_series` / `pick_listings` (`protrade/study.py`, mirrored in
    `store/study_universe.rs` for the estimate — keep them in step) keep ordinary shares, plus the BE and SME series when
    `universe.series` asks, and study a company listed on both exchanges once (matched by ticker or by name).
  - **The pace is kept busy.** `load` keeps `LOAD_WORKERS` requests in flight over the whole universe (the app queues them at
    the broker's pace) and detects each symbol's events as it arrives, so computing overlaps fetching. A symbol with no bar
    that passes the filters in the period is dropped once seen; its span still counts toward coverage and the data version.
  - **The cost is shown before the run.** `study_estimate` (reads the database only) counts the symbols, how many the research
    store already holds far enough back, and the requests left; readiness shows it and offers a trial on 100 symbols when it
    is long. The result records seconds per stage (`meta.timings`).
  What is fetched is kept, so a rerun the same day fetches nothing. *Not built:* a rerun on a later day still tops up each
  symbol with one request; Kite's batch quote could fill the newest bar for 1000 symbols a call (see "Python").
- *Not built yet:* a natural-language builder, AI interpretation, a research notebook, historical market cap and point-in-time
  universes (they need data the app doesn't have), and statistical tests beyond distributions. The spec, the step-by-step
  engine API and the stored results are what those will build on.

## Themes

`src/theme/themes.ts` is a registry: each theme supplies every token in `ThemeTokens` (TypeScript enforces it) and a
`baseMode` of `light` or `dark`, the nearest mode Vela understands. `ThemeProvider` applies the tokens as CSS custom
properties on `<html>` and persists the choice. To add a theme, append one entry — nothing else changes.

## Security model

- The webview's Content-Security-Policy (`tauri.conf.json`) blocks remote scripts, frames and images, and allows
  outbound connections (`connect-src https: wss:`), which the crypto providers need. Nothing is loaded from a server the
  user didn't choose: Vela's crypto providers would show coin logos from Ledger's icon server, so
  `data/providers/index.ts` turns their `resolveSymbolIcon` off and charts show Vela's initials badge.
- **`script-src` includes `'unsafe-eval'`, and only for Pine.** PineTS compiles a script to JavaScript with
  `new Function`, which the policy otherwise blocks (checked: without it every script fails to compile). The engine is
  always the worker one (`PineWorkerEngine`): a Worker has no DOM and no Tauri IPC, so a pasted script can't reach the
  backend or a broker credential. Never switch to the in-process `PineEngine`, and don't add other uses of `eval`.
- Tauri capabilities (`src-tauri/capabilities/default.json`) grant only what's used: window creation, the system
  browser opener, native dialogs, notifications, updates, and logging. The frontend has **no file-system access**; files are read through the
  browser's file picker. A Study export is written by Rust (`export_study_file`) where the user chooses in the system's save
  dialog, which Rust opens: the webview supplies the contents, a suggested name and the kind, never a path.
- Broker credentials live in the OS keychain and are read only by the Rust backend; the web view never receives an access
  token, and the settings screen can't read one back.
- The Python data API (see "Python") listens on the loopback interface only, refuses any request without the per-launch token, a
  matching `Host`, and no `Origin`, and serves read-only market data. The webview never talks to it (Rust does), so the CSP is
  unchanged. Python itself is *not* sandboxed: a script runs with the user's own privileges and only when they press Run.
- **The webview can now run code.** The Python commands let the webview save a script and run it, so an injection into the webview
  would mean code execution on the machine, where before it could only change what a chart shows. Keep the CSP strict, render
  nothing from a broker, a file or a script's output as HTML (the console draws text), and treat any new way for outside content to
  reach the DOM as a security matter.
