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
                                │      Tauri IPC (lib/ipc.ts)                  │ │
                                ▼                                              ▼ ▼
                          ┌──────────── Rust backend (src-tauri) ────────────────────┐
                          │ commands.rs ─ zerodha/              ── broker API         │
                          │      └────── store/* ── SQLite (charting.db)             │
                          └───────────────────────────────────────────────────────────┘
```

Zerodha sits behind Rust: its commands live in `zerodha_commands.rs` / `zerodha/` (the provider settings in
`provider_commands.rs`), and its live feed is a single WebSocket owned by Rust that pushes `zerodha-tick` /
`zerodha-status` events to every window.

## Symbols and providers

A chart symbol is always `provider:TICKER` (`zerodha:NSE:RELIANCE`, `csv:MY_DATA`). The prefix is what
selects the data source: it's Vela's own routing rule, and `lib/symbols.ts` holds the helpers for it.

A provider is a Vela [`DataProvider`](../node_modules/@luxalgo/vela/dist/DataProvider-DLeFs1gE.d.ts): an object with
`getBars(ticker, timeframe, range)` and, optionally, `subscribe`, `listSymbols` and `info`. `src/data/providers/`
registers one shared instance of each, so search and watchlist quotes use the same instance the charts do.

| Provider | Where | Notes |
| --- | --- | --- |
| `zerodha` | `data/providers/zerodha.ts` + `src-tauri/src/zerodha/` | The user's own Kite Connect account. All calls go through Rust, which holds the credentials. |
| `csv` | `data/providers/csv.ts` + `src-tauri/src/store/datasets.rs` | User-imported files, served from SQLite. |

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

### Symbols from a source the app no longer has

A saved watchlist, layout or alert can hold a symbol whose `provider:` the app no longer has. User data isn't rewritten,
so such symbols stay where they were saved, and the handling is generic, keyed on `PROVIDER_LABELS`:

- `isSupportedSymbol` (`lib/symbols.ts`) is false for them. Opening a layout moves each affected tab, and each affected
  cell of a grid, to the starter symbol and says so (`withoutUnsupportedSymbols`, in `Workspace`); clicking such a
  watchlist row says the source is gone; their quotes and alerts stay empty. Saving the layout again drops them.
- **Defaults.** A bare ticker means Zerodha, naming NSE (`DEFAULT_PROVIDER`); a brand-new chart and the starter
  watchlist are NSE names too, though they need the user's own account connected to load. The TradingView watchlist
  importer maps NSE/BSE with a broker set up; everything else is reported as skipped.
- **Company names** come only from the broker's instrument list (`store/symbol_names.rs`); imported data has none.

Don't add a source that reads an unofficial endpoint.

### Binance, Coinbase and Hyperliquid were removed

The three free crypto providers were Vela's own bundled `DataProvider`s, fetched directly from the webview over HTTPS
and WebSocket rather than through Rust — the only providers that ever worked that way. They were removed at the
owner's request, leaving Zerodha as the only live data source (CSV import is still free, but needs a file). They were
hard-deleted: there's no purge job, and nothing tracks them as a special case.

- **Removed.** The imports (`@luxalgo/vela/providers/{binance,coinbase,hyperliquid}`), their shared instances and
  factories in `data/providers/index.ts`, `withoutRemoteIcons` (only they needed it), the crypto branch of
  `data/search.ts`'s `searchSymbols`, and the TradingView importer's `BINANCE`/`COINBASE`/`HYPERLIQUID` exchange
  mapping in `lib/watchlistImport.ts`.
- **Saved symbols** (`binance:…`, `coinbase:…`, `hyperliquid:…`) fall out of `PROVIDER_LABELS` like any other removed
  provider, so the existing generic handling picks them up for free: `isSupportedSymbol` is false for them, and
  `withoutUnsupportedSymbols` moves an affected tab (or grid cell) to the starter symbol when a layout opens (see
  above). Nothing deletes their old `provider_settings`; they're just never read again.
- **Defaults.** `DEFAULT_PROVIDER` moved from `binance` to `zerodha`; `starterSymbol()` (`data/providerStatus.ts`) and
  the seeded "Getting started" watchlist (`store::watchlists::STARTER_SYMBOLS`) moved from crypto pairs to well-known
  NSE names — which, unlike the old crypto starter, need the user's own Zerodha account connected before they actually
  load.
- **Python.** `pyapi`'s `WATCHLIST_PROVIDERS` (routes.rs) already only ever accepted `zerodha` and `csv`; the free
  crypto providers were never readable from a script, so nothing there changed.

Don't bring back a free crypto source without the owner's say-so, and don't widen `pyapi`'s `WATCHLIST_PROVIDERS` or
`ProviderId` beyond `zerodha`/`csv` without updating `DEFAULT_PROVIDER` and the starter symbols to match.

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
3. Search: write a results function beside `zerodhaResults`/`importedResults` in `data/search.ts` and call it from
   `searchSymbols`. If it needs the network from Rust (to dodge CORS, or to cache), add a command in
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

Zerodha is the worked example: `zerodha/` has the layers a broker needs, and its module docs say where Kite is unusual (a
login every morning, a bad key refused at the WebSocket handshake). Two things are meant to be shared: `throttle.rs`
(request pacing) and, on the webview side, `data/feedHub.ts` (fans one Rust socket's ticks out to the charts that want
them). A second streaming broker would be the moment to extract `zerodha/feed.rs`'s connect/backoff/refcount loop.

1. **Spec.** Add a `ProviderSpec` to `PROVIDERS` in `providers.rs`: fields (say `apiKey` non-secret, `accessToken` secret),
   `category: "broker"`, and its capabilities. The settings screen now shows it.
2. **Backend.** Add `src-tauri/src/<broker>/` beside `zerodha/`. Keep the layers the same: a pure `protocol.rs` (request
   bodies, response parsing, error classification, all unit-tested), an `instruments.rs` if the broker needs a symbol →
   id table, a `client.rs` for HTTP (paced, with retry on rate limits, tested against a local mock server), and a
   `feed.rs` if it streams. Read credentials with `providers::credential`; never accept them from the frontend per call.
3. **Commands.** Expose `<broker>_fetch_bars`, `_search_instruments`, `_quotes` and `_subscribe`/`_unsubscribe` in
   a `<broker>_commands.rs` beside `zerodha_commands.rs`, register them in `lib.rs`, and add typed wrappers to `lib/ipc.ts`.
4. **Symbols.** Use `provider:EXCHANGE:SYMBOL` (`zerodha:NSE:RELIANCE`), with the exchange codes Zerodha uses, so tickers
   stay consistent across Indian brokers. Add the id to `ProviderId` and `PROVIDER_LABELS` in
   `lib/symbols.ts`.
5. **Provider.** Add `data/providers/<broker>.ts` (a Vela `DataProvider`). Reuse `data/providers/common.ts` for range
   sizing and bar conversion, `lib/timeframes.ts` for resampling (add a `to<Broker>Plan` next to `toKitePlan`), and
   `lib/liveBar.ts` if the broker streams ticks rather than candles. Register it in `data/providers/index.ts`.
6. **Search and quotes.** Add a results function to `data/search.ts` and a batch to `data/quotes.ts`, both gated on
   `isProviderUsable`.
7. **Verify against the real service** with deliberately fake credentials: real error responses are the cheapest way to
   catch wrong endpoints, header names and error shapes. (A broker's feed can accept the socket and only
   then drop it on a bad token; only the real service shows that.)

## Timeframes and resampling

Vela speaks canonical timeframes — minutes as bare digits (`"5"`, `"60"`), and `D` / `W` / `M`. `lib/timeframes.ts`:

- parses them, and maps one to what a broker serves natively plus, when it doesn't serve it, a group size
  (`toKitePlan`: 4h = four 60m bars);
- builds coarser bars from finer ones. Intraday grouping **restarts at every session open** (a 4h chart on a US stock
  is 09:30–13:30 then 13:30–close, not a fixed clock split), and uses the exchange's timezone offset to decide where
  a day begins.

**Daily-and-up bars are stamped at local midnight of the exchange's calendar date; intraday bars keep their real
instant.** Each new chart is set to the machine's timezone (`ChartView.tsx`) so both read correctly on the axis.

## Side panels, watchlists and tab prices

### The right rail

A strip of icons down the window's right edge (`features/rail/RightRail.tsx`) shows one panel at a time beside the chart:
the watchlist, the price alerts, or Ask AI. Pressing the icon of the panel that is showing folds it away. `Workspace` holds the
choice (`railPanel`) and remembers it in the `right_panel` preference (`features/rail/railPanel.ts`, pure and tested: what a
saved value means, and the fallback to the old `watchlist_collapsed` setting for a first launch after the rail arrived).

The watchlist and Ask AI panels stay **mounted** while another panel shows (`display: none` — the watchlist stops fetching
prices; Ask AI keeps its conversation), so they're as you left them when either comes back; the alerts panel mounts when shown.
To add a panel: add its id to `RAIL_PANELS`, a button to `railPanels` in `Workspace.tsx`, and render it in `app-body`.

Below the panel buttons the rail also holds **actions** (`RailAction`): the Script Editor, Strategy Tester and Python buttons
(`railTools`) and, pinned to the bottom, the Data providers plug and the AI providers key icon (`railFooter`). They open something
elsewhere — a tab, the Strategy Tester dock, a dialog — rather than a side panel. An action that is either showing or not is lit
while it shows (`pressed`): the Script Editor or Python button when its tab is the active one, and the Strategy Tester button while
the dock is open on a chart tab, which `PineDock` reports through `onOpenChange` since it owns that state.

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

### Quick access, browsing and the Indices list

- **Quick access** (`lib/quickLists.ts`, pure; `features/watchlist/quickLists.ts`, the window's shared state): up to five
  watchlist ids in the `watchlist_quick` preference, in pin order. The panel shows them as buttons above the list; the browse
  dialog's stars and the list's **More** menu toggle them; a sixth is refused. Pins of deleted lists are dropped.
- **From the chart** (`chart/watchlistActions.ts`): pointing to **Add to watchlist** in the chart's right-click menu opens a
  submenu of every watchlist, checked where it holds the chart's symbol (`lib/watchlistMenu.ts`, pure: quick-access lists
  first, then by name, then **New watchlist…**). Picking one adds or removes the symbol; **New watchlist…** opens the
  add-to-watchlist dialog on a new list (`watchlistUi.ts` bus → `Workspace`). Vela builds its menu synchronously, so the
  lists and their symbols (`list_watchlist_members`) are cached and read again on every watchlist or pin change.
  Contributed actions can't have submenus in stock Vela; the patch in `patches/` adds that (see CLAUDE.md). Registered
  once per window in `main.tsx`.
- **Flags** are one click away: each row has a flag button before its ticker (coloured when set, an outline on hover when
  not) that opens the same swatches as the row's right-click menu (`FlagSwatches`).
- **Browsing** (`WatchlistBrowserDialog.tsx`): every list, searchable, with star, open, rename and delete.
- **The Indices list** (`store/index_catalog.rs`): a curated catalogue of ~55 NSE/BSE indices in three sections (Broad market,
  Sectors, Themes), each with its Zerodha ticker (`NSE:NIFTY_BANK`). `create_indices_watchlist` keeps only what the broker's instrument list has and builds the list with its
  sections. Strategy, factor and bond indices are left out. There are no sector *stock* lists: no source the app uses publishes
  index constituents (the owner chose not to add one).
- **Panel width** (`features/rail/panelWidth.ts`, pure; `PanelResizer.tsx`): the three side panels share
  `--side-panel-width`, set by dragging the panel's left edge (pointer capture) and kept in `side_panel_width`; clamped so
  the chart keeps at least 360px.

### Tab prices

Each chart tab shows its symbol's price and the day's change. `useTabQuotes` polls `fetchQuotes` for just the tabs' symbols (the
same call the watchlist and alerts use, every 20 s at most, not while the window is hidden). That gives the change from the
previous close and covers a tab whose chart isn't streaming. On top of it, every streaming provider publishes each bar it
delivers to `data/livePrices.ts` (`withLivePriceTap` in `data/providers/index.ts`), so the tabs of streaming charts tick with
the market at no extra cost; `lib/tabQuote.ts` (pure, tested) re-measures the change from the polled quote's previous close,
prefers whichever of the two is newer, and drops a streamed price that has gone stale. **A new streaming provider has to be
wrapped by the tap**, or its tabs fall back to the poll.

## Persistence

One SQLite file (`charting.db`, in the OS's per-user app data folder), opened by `src-tauri/src/db.rs`, shared through one
connection (`Database`). **No table holds broker price history**: Kite Connect's terms restrict permanent copies of its data,
so every broker bar lives in memory for the session (`store/bar_memory.rs`, see "Python") and is gone when the app closes.
Databases from before that had three bar tables (`bars_cache`, `research_bars`, `research_coverage`); `store/bar_tables.rs`
drops them on the first launch after the change and `Database::init` then runs `VACUUM` once to hand the space back. It also
carries the old market-data preferences over: a user who had downloaded the market (and left its daily update on) gets
"Keep the market loaded" switched on.

| Table | Holds |
| --- | --- |
| `ui_preferences` | Key/value settings (theme, which side panel the rail shows) |
| `chart_layouts` | Named sessions. `state_json` is **opaque to Rust** — the frontend owns its shape (`LayoutDocument`, versioned) |
| `pine_scripts` | The user's Pine Script library: name, kind (`indicator` / `strategy`) and source |
| `watchlists`, `watchlist_items`, `watchlist_sections` | Lists, their symbols (with a colour flag) and their section headings; see "Watchlists" |
| `datasets`, `dataset_bars` | Imported CSV data |
| `market_symbols` | Every symbol "Keep the market loaded" covers, with when it was first and last listed: names, never prices (see "Keep the market loaded") |
| `studies`, `study_results` | Saved Study Specifications and completed Study runs (see "Studies") |
| `notebooks`, `notebook_items` | Research Notebooks: Studies and runs grouped with the user's notes |
| `screeners` | Saved screens and the last run of each (see "Screener") |
| `symbol_drawings` | Each symbol's drawings, as Vela's own document (see "Drawings per symbol") |
| `script_schedules`, `schedule_runs` | Scheduled Python scripts and what happened each time one came due (see "Scheduled scripts") |
| `provider_settings` | Per-provider `enabled` flag and non-secret configuration |
| `provider_secrets_fallback` | Credentials, **only** when no OS keychain exists (unencrypted; the UI says so) |

`src-tauri/src/store/*` are plain functions over a `&Connection` with unit tests against an in-memory database.
`commands.rs` is a thin wrapper that locks the connection, calls into the store, and flattens errors to strings.
Schema changes: `CREATE TABLE IF NOT EXISTS` won't alter an existing table, so a new column needs a guarded
`ALTER TABLE` step in `Database::init`.

## Layouts and tabs

A tab is a chart or a workspace — Python or Studies (`features/workspace/tabs.ts`, pure and tested; at most one of
each, opened from the rail, Python also by `Ctrl+Shift+Y`). A workspace tab has no symbol and no chart, so:

- the chrome that needs a chart — the watchlist's highlight, the Strategy Tester, the chart the Script Editor adds to, a new alert's symbol, and where
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
`features/layouts/layoutDocument.ts` removes those settings — what `setTheme` changes, no more — both when saving and
when loading, which also cleans layouts saved by earlier versions. Colours the user picked themselves (candles, lines) are
kept.

**The canvas background is the exception: it belongs to the layout when one was chosen, and to the theme otherwise.**
Vela writes a background into every chart's settings — its own dark (`#151619`) or light (`#ffffff`) default when nobody
chose one — so the two are told apart by value (`chart/canvasBackground.ts`): either default is the theme's and is stripped
like the rest; any other colour (picked in the chart's settings → Canvas) is kept in the layout and restored with it. A
theme switch would re-skin it, so `ChartView`'s `applyTheme` reads each cell's chosen background first and re-applies it
after `setTheme` (Vela then re-derives a readable text colour for it). A colour picked to be exactly one of the two defaults
can't be told from the theme's and follows the theme.

Vela's workspace draws one attribution mark over the grid and inks it from the *theme*, not the canvas, so a dark chosen
background under a light theme would get a black mark on a dark canvas. The mark must stay visible (see "Vela specifics"),
so `tintAttribution` re-inks it from its cell's background with Vela's own rule (white on dark, black on light) after
construction, a theme switch, a grid change and any change to a chart's settings (`renderer.onConfigChanged`).

Vela owns a chart's state after construction, so `initialSymbol` / `initialState` are seeds only, and symbol changes go
through the imperative `ChartViewHandle`.

## Drawings per symbol

Vela keeps one set of drawings per chart and leaves them in place when the chart changes symbol. `chart/symbolDrawings.ts`
makes them belong to the symbol instead, for every cell of every grid (`ChartView`'s per-cell hooks):

- On `market:changed` to another symbol, the old symbol's pending edits are saved, the chart is cleared at once, and the new
  symbol's drawings are loaded (`get_symbol_drawings`). Timeframe changes don't swap anything.
- `drawing:created` / `edited` / `removed` save the chart's document (`chart.drawings.toJSON()`) under its symbol after
  `SAVE_DELAY_MS`; `save_symbol_drawings` tells every window (`symbol-drawings-changed`), and other charts of that symbol
  reload unless they have unsaved edits of their own. A load that returns after the chart moved on is ignored.
- **Layouts still carry drawings.** The stored document wins. A symbol with *no row* adopts the drawings a chart already has
  (a layout saved before this, or Vela's own state); an empty document is stored when everything is removed, so a cleared
  symbol isn't refilled from an old layout.
- **Vela quirk worked around:** `fromJSON` drops the selection without telling the renderer, which leaves a selected drawing's
  handles and floating edit toolbar on screen. The port deselects before and after, and — only when something was selected —
  calls `chart.resize()`, the one public path that closes that toolbar.

`SymbolDrawings` holds the rules with its chart and storage injected, and is unit-tested (`symbolDrawings.test.ts`).

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
| UI | `features/pine/` | The Script Editor is a workspace tab (`kind: 'pine'`, `PineEditor`: a script library beside CodeMirror 6, `pineLanguage.ts`), opened from the right rail, `Ctrl+E`, Home, or the "Edit script" button registered on every script's legend row (`pine/hostActions.ts`, through `dockBus` to `Workspace`). It adds scripts to `activeChartTab` — the chart last looked at — and names it in its toolbar. The Strategy Tester stays in a dock under the charts (`PineDock`, `Ctrl+Shift+E`), mounted on that same chart while a workspace tab shows (only hidden), because a strategy reports its results as it runs and a late listener would miss them |

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
use), holds them in memory for the session, and answers. It is for research — screening, backtesting, analysis. Nothing here
places an order, and nothing here writes a broker's prices to disk.

```
 Python tab ─── invoke ──▶ python_commands.rs ── spawn ──▶ <venv>/python script.py   (import protrade as pt)
      ▲                        │  stdout/stderr                       │
      └────── events ◀─────────┘                                      │ HTTP, Authorization: Bearer <token>
                                pyapi/ (127.0.0.1) ◀──────────────────┘
                                   │  bar memory  ── Zerodha client (paced) ──▶ broker
```

| Piece | Where | Notes |
| --- | --- | --- |
| Interpreter | `python/env.rs` | The app never bundles or downloads Python. It finds one by *running* `py -3` / `python` / `python3` and reading `sys.version_info` (so the Microsoft Store's stub, which is on `PATH` where no Python is installed, isn't taken for one), makes a venv in `<app data>/python/venv` and installs pandas and numpy. The user may name their own interpreter instead (preference `python_interpreter`), and then nothing is installed unless they ask. |
| Runner | `python/runner.rs` | Starts `python -u script.py` with no stdin (so `input()` fails instead of waiting), streams each line as a `python-output` event, and on Stop ends the whole process tree (`taskkill /T`, or a process group), because a script may use `multiprocessing`. A lone `\r` marks a progress-bar line the console overwrites. Output past 4 MB is dropped with a notice. It knows nothing of Tauri (output goes to a callback), so it is tested against a real Python. |
| Scripts | `python/scripts.rs` | Plain `.py` files in `<app data>/python/scripts`, so any editor and `git` work on them. The frontend names a script and never sends a path; `validate_name` refuses anything that could leave the folder, a Windows device name, and a name that would shadow a library (`pandas.py` beside a script replaces pandas for it). Examples (`python/examples/`) are copied in and kept current: the app records a hash of what it wrote (`.examples-seeded`), refreshes an example nobody has touched when a newer one ships, and leaves alone one the user edited or deleted. They must work with no setup (a test runs them for a user with no watchlists). |
| Client | `python/protrade/` | Standard library plus pandas. It is embedded in the app (`python/client_files.rs`), written to `<app data>/python/lib` at each run and put on the child's `PYTHONPATH`, so it is never `pip install`ed and always matches the running app. A debug build (`tauri:dev`) writes the repository's current copy instead of the embedded one, because the dev watcher doesn't rebuild for changes outside `src-tauri/`: a `git pull` of Python takes effect on the next run. A Study prints and records which engine ran (`[engine] protrade 1.0 (<hash>)`, `meta.engine_build`). A test fails if a module is added to the folder without being listed in `FILES`. |
| Local API | `pyapi/` | `data.rs` (bars: memory reads plus broker fetches; also `sync_daily`, the quote top-up, and `snapshot`, a whole market's quote), `routes.rs` (auth and routing, against a `Backend` trait), `server.rs` (hyper), `backend.rs` (the real `Backend`, plus the error mapping), `wire.rs` (JSON, and the panel's binary columns). Read-only `GET`s: `/v1/bars`, `/v1/instruments`, `/v1/watchlists`, `/v1/watchlist`, `/v1/providers`, `/v1/ping`; and `POST /v1/panel` and `POST /v1/snapshot`, reads posted only because a market's symbol list doesn't fit a URL (see "Keep the market loaded" and "Screener"). `POST /v1/results` (which, for kind `watchlist`, writes a watchlist: see "Scripts writing watchlists") and `POST /v1/bars/sync` (brings many symbols' daily coverage up to date from a batched broker quote and answers a per-symbol status, never bars — see "Screener") are the two writes. |
| Results | `pyapi` `POST /v1/results` → `python-result` → `python/results.ts` → `features/python/Results*.tsx` | What a script shows: `pt.show` (a table), `pt.report` (a backtest) and `pt.plot` (a matplotlib PNG); a Study's result is kind `study` (see "Studies"), and one sent by a script in the Python tab is stored with the Studies' results. Rust checks only what makes forwarding safe — the run id, the kind, a title's length, and that a figure's bytes really start like a PNG — and the webview validates the shape before drawing. The report reuses the Strategy Tester's `EquityChart`. |
| Bar memory | `store/bar_memory.rs`, `store/research_bars.rs` | Every broker bar the app holds, in memory only, with a *coverage* per series (`bar_memory`), and the pure sync policy over it (`research_bars::plan`). See below. |
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
- **Bars live in memory, never on disk.** `BarMemory` (Tauri state, one per process) holds every series the session has read: the
  Python API's, the Screener's and Studies', "Keep the market loaded"'s, and the charts' recent bars (put there without coverage,
  as the offline fallback when the network drops). It has a budget (about 400 MB) and drops the series read least recently, bars
  and coverage together, so a dropped series is simply fetched again. Its lock is never held across an await. It records per
  `(symbol, interval)` the span whose bars are complete, because "no bars" (a holiday, a stock not yet listed) and "not fetched
  yet" look alike. `research_bars::plan` is the whole sync policy and is pure: given
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
  batch endpoint for history, and every caller (charts, backfill, scripts) shares one client whose `Throttle` releases a request
  every 350 ms however many are waiting, so `bars_many`'s workers only overlap the waiting: 984 symbols is about six minutes, once.
  A daily request's span is rounded up to 90-day blocks (`lookback_ms`) so two screens asking for 250 and 257 bars start on the
  same date; otherwise each symbol needs a second request for the few days between them, which doubled the run. **Every run after
  that first one is fast** while the app stays open: `store::day_topup` and `pyapi::data::sync_daily` bring a symbol's coverage up
  to date from one batched quote instead (`POST /v1/bars/sync`, called by `api._top_up` ahead of the Screener's and a Study's own
  fetch loop) — `GET /quote`, up to 500 symbols a call (Kite's own limit; `zerodha::live` checks Kite accepts the URL a batch of
  its longest symbols makes), not Kite's `/quote/ohlc`, whose `ohlc.close` is the *previous* close (today's is `last_price`) and
  which carries no volume. A quote is trusted only when its previous close matches what is already held; a mismatch (a corporate
  action, a missed session) falls back to the historical endpoint instead, which re-fetches and self-corrects, and a series that
  has volume is never silently given a blank one.
- **Record what was fetched, not what was asked.** The brokers' clients answer a range longer than one call may span with only its
  newest part (`MAX_CHUNKS`). `Fetcher::fetch` returns where the fetch *really began*,
  the store records that, and `limitedFrom` tells the script the data starts later than it asked (a `DataLimitWarning` in Python).
- **Daily bars belong to an IST calendar date.** They are put on midnight IST whichever instant the broker stamped them with, a
  daily range selects whole dates (an `end` date includes that day), and the client returns them on a timezone-aware IST index.
  Intraday bars keep their real instant. Only the brokers' native intervals are served (Kite 1, 3, 5, 10, 15, 30, 60 minutes and
  daily); `pt.resample` builds the rest, restarting each bucket at the session open like the charts.
- **Sources.** Zerodha and imported CSV datasets only — the only two providers there are.
  Errors carry a stable `code` (`auth`, `not_configured`, `no_access`, `rate_limited`, `not_found`, `bad_request`, `upstream`) that the
  client turns into an exception class; `auth` and its kin are *fatal* to a batch, since every later symbol would fail the same way.
- **Python is not a sandbox.** A script has the user's own privileges, as from a terminal, so it could read `charting.db` or the
  OS keychain like any local program. What this design guarantees is narrower: the app never *hands* a script a credential, no route
  returns one, and a script runs only when the user presses Run — never on opening a layout, importing a file or starting the app.
  The environment a script inherits has `TAURI_*` (the updater's signing key, during development) removed.

### Scheduled scripts

A script can run by itself at set times — to refresh a watchlist every evening, say. This is the one way a script runs without
the user pressing Run, so it is narrow on purpose.

| Piece | Where | Notes |
| --- | --- | --- |
| Rules | `scheduler/plan.rs` | Pure. A `Rule` is the days (Monday first) and either a time (`daily`) or every N minutes (5–720) between two times (`every`), all **IST** like `market.rs` (no DST, no timezone crate). `next_after` finds the next firing; `decide` says what to do with a schedule on one look: wait, plan it, run it, skip it (its last run is still going) or record it **missed**. |
| Store | `store/schedules.rs`; `script_schedules`, `schedule_runs` | A schedule names a script (checked to exist when saved) and keeps `next_run_at`. Each time one comes due a history row records it: `running` → `ok` / `failed` / `stopped`, or `missed` / `skipped` at once, with a message and the tail of the output (16 KB). The newest 30 are kept per schedule; deleting a schedule deletes its history. |
| Engine | `scheduler/engine.rs` | One task for the process, started once in `lib.rs` (not per window, so a run never starts twice). Every 15 s it applies `decide` to each switched-on schedule and starts due ones through `start_python` — the Run button's path, same environment and token — with a `StartRun::on_exit` that records how the run ended. A run that can't start (the script is gone, Python isn't set up) is recorded as failed. Emits `schedules-changed` and `schedule-run-finished`; the main window toasts a failure. |
| UI | `features/python/SchedulesPane.tsx`, `python/schedules.ts` | The Python tab's third output tab, and a **Schedule** button in its toolbar that opens a new schedule for the open script. `schedules.ts` (pure, tested) words a rule, shows times on the IST clock and repeats `Rule::check`. |

- **Nothing is made up.** A schedule runs only while the app is open. On the engine's first look after launch, anything already
  due is recorded as missed (however recently it came due), so starting the app never runs a script; later, a run more than two
  minutes late (the machine slept) is missed too. Many missed firings are one row ("Missed 26 runs"). Switching a schedule on,
  or editing it, plans it from now. A run left `running` when the app closed is marked failed at the next launch.
- **Only the user makes a schedule**, with the form in the Schedules pane (`save_schedule`). Ask AI has no tool for it, and a
  script or a layout can't create one.

### Scripts writing watchlists

`pt.set_watchlist(name, symbols, mode)` posts a result of kind `watchlist`. Unlike the other kinds it isn't forwarded to a window:
`pyapi/routes.rs` checks it (`watchlist_update`: a name of 1–100 characters, at most 2,000 symbols, each `provider:TICKER` from a
provider the app has; a bare broker ticker becomes `NSE:`) and `Backend::set_watchlist` writes it with
`store::watchlists::sync_named` — in one transaction, matched by name ignoring case, created if missing. `replace` removes what's
no longer listed and keeps the rest in place with their flags; new symbols go at the end in the script's order, with company
names from the instrument lists; section headings are untouched. The script is answered with what was done, which the client
prints. `watchlists-changed` tells every window, and `watchlistBus` relays it to the panel. It is the only write the local API
makes besides showing a result.

## Keep the market loaded

Five years of daily bars for every NSE stock (EQ series, one listing per company by the Studies' own rule) and every NSE index,
read into memory while the app is open, so the Screener, Studies and scripts read a whole market at once instead of a request
per symbol. It is opt-in (the preference `marketData.keepLoaded`) and nothing of it reaches the disk: after a relaunch the
market is read again.

| Piece | Where | Notes |
| --- | --- | --- |
| Rules | `marketdata/plan.rs` | Pure: the universe (`study_universe::pick_listings` over the instrument list), how far back (`HISTORY_DAYS`, more than the deepest screen), when the daily update is due (once per settled session, `market::last_settled_ms`; an hour's wait after a failure) and how a holiday shows (`was_holiday`). |
| Job | `marketdata/job.rs` | One pass over the listing, tested against a fake broker: record the listing (`market_symbols`; a new row is a new listing), read into memory any history it lacks through `pyapi::data::load_bars` (the user's watchlist symbols first), then top up every series with the batched quote (`sync_daily`). A series the quote can't update is dropped and read again whole (`BarMemory::forget`): Kite serves five years of daily bars in one call, so that costs what reading the missing tail would, and old and adjusted prices are never mixed after a split. Quotes that last traded before the session trigger one probe (NIFTY 50): on a holiday every current series is marked current through it (`carry_daily_through`), and nothing else is read. |
| Engine, commands | `marketdata/mod.rs`, `marketdata_commands.rs` | One job at a time (`MarketData` state, which also keeps the session's record of the last load, in memory), stoppable, `market-data-progress` / `market-data-finished` events. The loop starts in `lib.rs`, first looks two minutes after launch, and does nothing unless the user has switched loading on. Switching it on starts a load at once; off stops one. |
| Broker lanes | `throttle.rs` | Every job runs inside `throttle::in_background`: its broker requests wait while any interactive one (a chart, a script) is queued, at the same gap, so the broker's limit holds and a chart waits at most one gap. The lane is a task-local, so it must wrap each spawned task. |
| Panel | `pyapi/data.rs` `read_panel`, `wire.rs` `panel_body`, `protrade/panels.py` | Many symbols' held daily bars in one answer, from memory alone (never a broker call), each marked `current` when a `/v1/bars` read of the same span would fetch nothing. Binary columns (a JSON header, then `ts` i64 and `o h l c v` f64, every series back to back): a market's history is millions of numbers. `pt.panel`, and `pt.bars_many` for daily bars, read it first and fetch only what isn't current. |
| Wide features | `protrade/wide.py` | `WideFeatures` computes a feature for many symbols at once on a table with a column per symbol, **aligned on bar position** (each symbol's bars fill the bottom of its column), so rolling windows, `ewm` and `shift` count that symbol's own bars and the numbers equal `Features`'. `features.py` is written to work on a Series and a DataFrame alike; `tests/test_wide.py` checks every family. The Screener judges all symbols with it; a Study computes detection's features per batch with it. |
| Charts | `marketdata::chart_daily` | A daily (so weekly and monthly) chart of a held symbol is answered from memory, with what it lacks read through `load_bars` on the interactive lane and held. Intraday is unchanged. |

- **These are Rust jobs, not scripts.** Nothing here starts Python, so the rule that a script runs only on a press or a
  user-made schedule is untouched. Loading runs only while the app is open, never during startup, and never makes up a
  run: coverage decides what is fetched.

## Screener

The Screener tab answers "which stocks meet these conditions **today**?". It shares the Studies' engine plumbing and feature
grammar, so an RSI in a screen is the same number a Study measures.

| Piece | Where | Notes |
| --- | --- | --- |
| Screen | `src/screener/spec.ts`, `protrade/screen.py` `normalize_screen` | Universe (the Study universe's shape, without the size filters), `filters` (Study conditions, all must hold), `columns` (features), `sort` and `benchmark`. The two validators run `src/screener/fixtures/screen-cases.json`. A result's columns are the chosen ones plus every feature a filter reads (`outputColumns` / `output_columns`). |
| Engine | `protrade/screen.py`, `protrade/run_screen.py`, `screener_commands.rs` | `screen_run` writes the screen to a file and starts `python -m protrade.run_screen`. First the **quote pre-filter**: the filters today's quote alone decides (`snapshot_decidable`: every feature in `SNAPSHOT_FEATURES` — the day's own prices, `gap*`, `return_1`, `change_1` — on the daily interval, and a crossing only of the close) are judged on one `POST /v1/snapshot` for the whole universe, on two-bar frames (the previous close, then the quote) that give exactly the number the full history's latest bar would; symbols that fail are counted as screened (`meta.prefiltered`) and never read further. If every filter and column is such a feature, the ones that pass need no history either. A symbol whose quote isn't this session's (suspended) or has no previous close is left to history, and the pre-filter is skipped in the pre-open window (`sessionDay` null), on any failure, or with `PROTRADE_NO_SNAPSHOT=1`. Then it reads every remaining symbol the app holds in memory in one `POST /v1/panel`; only the rest are offered for the quote top-up (`POST /v1/bars/sync`) and loaded through `/v1/bars` (`LOAD_WORKERS` in flight, as a Study). Bars reach back far enough for every column to settle (`history_bars`: twice the slowest warm-up, at least 260 bars) and judges every symbol together (`judge`, on `wide.WideFeatures`) on its **latest bar**: `crosses_above` means it crossed on that bar. A symbol whose last bar is a week older than the universe's is left out as stale; one with too little history for a filter doesn't match, and both are counted in warnings. Matches are sorted and capped at 5,000. |
| Result | `src/screener/result.ts` | Posted as kind `screen`; untrusted, so checked whole (spec through `normalizeScreen`, columns equal to the spec's, every row's shape) and drawn as text. `fixtures/engine-result.json` is real engine output; `python/tests/test_screen.py` fails when the engine's output drifts from it. |
| Storage | `store/screeners.rs`; `screeners` | Saved screens, each with only its **last** run — a screen asks what qualifies now, so older runs aren't kept. A run of an unsaved screen is shown, not stored. |
| UI | `features/screener/` | A workspace tab like Studies (`WORKSPACE_LABELS` in `tabs.ts`), opened from the rail. Filters (`ConditionList`, shared with Studies) and columns on the left; name, universe and the pre-run readiness (`screener/readiness.ts`, using `study_estimate` for the cost) on the right; the results table below (sortable, a row opens its chart, add all to a watchlist, CSV). Eight presets (`screener/presets.ts`). |

A screen on today's prices alone is one quote of the whole universe: seconds, with or without anything loaded. With the market
loaded, a whole-NSE screen that needs history is one panel read and one wide computation: seconds. Without it, the first such
screen after launch fetches every surviving symbol's history at the broker's pace (about 15 minutes for all of NSE on Kite);
what is fetched is held until the app closes. After that, each symbol's daily coverage is brought current with one batched
broker quote instead of a rate-limited history call each (`POST /v1/bars/sync`, `store/day_topup.rs`). A symbol the quote can't
vouch for (its previous close doesn't match what's held, or it's missing volume a series normally has) falls back to the
historical endpoint automatically, never a wrong bar. `python/tests/test_screen.py`'s property test runs random screens with
and without the pre-filter and requires identical results.

## Studies

A **Study** asks what stocks looked like around historical market events — *which stocks doubled in twelve months, and
what did they look like 3, 6 and 12 months before?* It is research, not a scanner (what qualifies today) and not a backtest
(what trading rules would have made): its output is events, measurements around them, distributions and comparisons.

```
 Studies tab ── spec (JSON) ── invoke study_run ──▶ study_commands.rs ── writes <app data>/python/studies/<run>.json
      ▲                                                   │ spawn: python -m protrade.run_study <file>   (start_python)
      │ python-result (kind "study") ◀── pyapi POST /v1/results ◀── protrade/study.py ── GET /v1/bars … ── bar memory
      └── studies/result.ts validates ── save_study_result ── study_results table
```

The pipeline is fixed — **universe → historical data → event detection → event context → measurement → comparison →
aggregation → result** — and every part of it is described by the **Study Specification**, which is the product:

| Piece | Where | Notes |
| --- | --- | --- |
| Specification | `src/studies/spec.ts`, `protrade/study.py` `normalize_spec` | A JSON document (snake_case, because Python reads it and it is exported). The two sides apply the same rules and defaults — **keep them in step**; both run the cases in `src/studies/fixtures/spec-cases.json`. Versioned (`version: 1`). `question` is the Study's question, shown above its answer; `measures` are read over windows (see "Three lenses" below). |
| Features | `protrade/features.py`, `src/studies/metrics.ts` | One grammar of names: a family and a window in bars (`return_252`, `ema_200`, `rsi_14`, `dist_high_252`, `rvol_20`, `rs_126`…) plus aliases (`return_12m`, `distance_from_52w_high`). Python computes them; TypeScript accepts the same names and labels them. Returns and distances are fractions. A rolling feature is NaN until its window is full. |
| Conditions | both of the above | `{left, op, right}` with `>`, `>=`, `<`, `<=`, `crosses_above`, `crosses_below`; `right` is a number or a feature. Events, pre-event filters and characteristics are all conditions. |
| Engine | `protrade/study.py` (`ResearchStudy`), `protrade/measures.py` | Universe (instrument list, watchlist or symbols) → `load` (offers the universe for the quote top-up, same as the Screener, then daily bars through the local API, in chunks so progress can be reported) → `detect_events` → `measure` (snapshots, measures, forward returns) → `control_group` or `split_by_outcome` → `analyze`. Each step is callable on its own; "Generate Python" writes a script that calls them one by one. `engine_build()` hashes every module the numbers depend on. |
| Runner | `protrade/run_study.py`, `study_commands.rs` | `python -m protrade.run_study spec.json`, started through the same `start_python` as a script (same environment, token and events), and only by the Run Study button. It is a module of its own because `-m protrade.study` would import the module twice. |
| Result | `studies/result.ts` | Posted as result kind `study`. Untrusted like any script output: re-validated (the spec included) and drawn as text and SVG only. `fixtures/engine-result.json` is real engine output (`python/tests/make_study_fixture.py`); a Python test fails when the engine's output shape drifts from it. |
| Storage | `store/studies.rs`; `studies`, `study_results` tables | Saved Studies (spec JSON, opaque to Rust) and completed runs (the whole result, so a run reopens without running again). The last 20 runs of each Study are kept. A run of a script's Study is stored under a `script:` id. |
| UI | `features/studies/` | A tab of its own like Python (`features/workspace/tabs.ts`): My Studies, templates and recent results on the left; the Builder or the Results page on the right. The **Builder** (`StudyBuilder.tsx`) has the question, a "What to measure" section (`MeasureList.tsx`, `WindowPicker.tsx`: a stat, its conditions or feature, a named window or a custom one from a start to an end, a headline toggle), the event, and the snapshot sections folded under "Event-day snapshot"; beside it the interpretation and **data readiness**. The **Results page** (`StudyResults.tsx`) is answer first: the question, the answer (`StudyAnswer.tsx`, from `studies/answer.ts`), one chart (`MeasureChart.tsx`: how a measure spreads across the stocks, or for a condition measure the share of stocks where it held day by day), the stocks one by one (`StudyStockTable.tsx`, a row opens its chart at the event), a one-line caveat, then **Details** (`StudyDetails.tsx`: the measures table, summary, event table, event timeline, distributions, before/after, liquidity groups, comparison, stock explorer), folded away unless the Study has no measures. Pure helpers are in `src/studies/` and tested. |
| Chart | `chart/studyEvent.ts`, `ChartViewHandle.showEvent` | Opening an event points the followed chart at the symbol, daily, framed by `visibleRange` around the date, with a timeline mark. Vela treats marks as data to re-supply after a market switch, so `ChartView` re-applies the mark when that symbol's market lands and clears it when the chart moves elsewhere. |

- **Events are edges.** An event is the *first* bar on which all its conditions hold together, not every bar they hold, and
  the same stock can't have another for `cooldown_days` bars. Liquidity, price and pre-event filters are judged at the event
  (or `at` bars before), never with later data. The measurements at each observation point (`T-252 … T0 … T+252`, in bars)
  are the feature's value on that bar; a point outside the loaded history is blank, never filled from a neighbour.
- **Three lenses: snapshots, measures, episodes.** Metrics and characteristics are *snapshots*: one bar at an observation
  point ("what did it look like 3 months before?", "what share of events were above the 200 EMA that day?"). *Measures*
  (`spec.measures`, `protrade/measures.py`) read a window of bars and give one number per event — the journey to the event or
  its aftermath: `share`/`count` of days a set of conditions all held (a band is two conditions), `longest_run`, `runs`
  (separate stretches, e.g. pullbacks into a zone), `bars_to_first`/`bars_since_last`, a feature's `mean`/`min`/`max`/
  `start_value`/`end_value`/`change`, and on price `return`, `max_gain`, `max_drawdown`, `length`. An *episode* is a measure
  whose window starts or ends on a day found near the event (`{find: lowest|highest|first|last, …, direction, within}`): from
  its 12-month low to the event, from the event until its first close below the 50 SMA.
  - **The window model.** Bar A → bar B (A < B). Counting stats read bars A+1…B; price stats the closes at A and B and the path
    between. So `{offset:-252}→{offset:0}` is the 252 days up to and including the event bar (its `return` is `return_252`) and
    `{0}→{126}` the 126 days after (its return is `fwd_return_126`). A before-search reads bars −within…0 only; ties for a
    lowest/highest go to the latest bar. `measures.ts` words every window ("in the 12 months up to and including the event").
  - **Nothing is filled in.** Each event gets a status: `ok`; `capped` (a first/last that didn't happen in `within` bars, with
    `if_not_found: cap` — the window runs to that edge and the value is a lower bound); `never` (a `bars_to_first`/
    `bars_since_last` whose conditions never held: it ranks after every number, and a median that lands among them is null);
    `too_recent` (the window runs past the data); `no_history` (it reaches before the data, or reads a bar with no value yet);
    `not_found`; `empty`. The per-event columns are `measure_k`, `measure_k_status`, and for an episode `measure_k_from` and
    `measure_k_bars`. `history_bars` reaches back as far as any window.
  - **Result.** `measures[]` per measure: `describe` of the values (censored-aware) with status counts, the control group's,
    episode lengths (`window_bars`), a Mann–Whitney test in the same Benjamini–Hochberg pool (finding kind `measure`), a
    histogram, and for a condition measure a day-by-day `timeline` of the share of events where the conditions held. Old runs
    parse with `measures: []`; nothing about the spec or result format changed version (additive fields with defaults).
  - **The answer.** `studies/answer.ts` turns the headline measures into sentences ("For the typical stock, “…” held on 24% of
    days in the 12 months up to and including the event (about 60 of 252). Middle half: 18%–31%. Random stock-dates: 14% — a
    large difference (q < 0.001).") plus a coverage line (how many events were measured, and why not the rest) — from the
    numbers, deterministically, drawn as text. A Study without measures gets a fallback answer from forward returns and findings.
  - **Keeping the validators in step.** `src/studies/fixtures/spec-cases.json` lists refused specs (with the word the message must
    contain) and accepted ones (with their exact normalised measures); `spec.test.ts` and `python/tests/test_measures.py` both
    run it. Every stat is also checked against a bar-by-bar reference on random series, and a no-look-ahead test rewrites the
    bars after each event and checks that no before-window changes.
- **Comparison.** Either a control group — random dates (seeded, so reproducible) from the same universe and period that pass
  the same filters, with no event within `cooldown_days` either side, so a run-up to an event isn't counted as "no event" — or,
  with an `outcome`, the events split by whether they went on to gain `min_return` within `window` bars. Everything is labelled
  a **historical association**; nothing in the UI or the report claims a cause.
- **Is a difference more than noise?** With a comparison group, `analyze` tests every comparison (`protrade/stats_tests.py`,
  standard library + numpy/pandas, checked against scipy/statsmodels): Mann–Whitney U for measurements and forward returns
  (effect size: Cliff's δ, −1…+1), a two-proportion z-test with Newcombe's 95% interval for characteristics, and a
  Benjamini–Hochberg adjustment across *all* of a Study's tests, since a Study makes dozens of comparisons and some would look
  significant by chance. Each item carries `test: {p, q, effect | diff/low/high, n_events, n_control}`; `summary.findings` lists
  up to ten that stand out (q < 0.05 and at least a small effect), one per measurement. Fewer than five on either side means no
  test. The results page words them as associations (`studies/significance.ts`).
- **Comparing runs.** `studies/compare.ts` sets two stored runs side by side: their spec differences in the builder's own words
  (`interpret`) and their figures where both measured the same thing. Nothing reruns.
- **Research Notebooks** (`store/notebooks.rs`; `notebooks`, `notebook_items`) group Studies and runs with the user's notes, in
  their order (positions from 1). An entry refers by id and outlives its target ("no longer available"); a run in a notebook is
  never pruned, and survives its Study's deletion (`store/studies.rs`). Notes are plain text, drawn as text.
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
- *Not built:* historical market cap and point-in-time universes (they need data the app doesn't have).

### AI providers

Two providers, either with the user's **own API key**: Anthropic (Claude) and OpenAI (GPT). The Study Builder (drafts,
revisions, explanations, research plans and syntheses) and Ask AI (below) both run on whichever is configured, or whichever the
user prefers when both are. Neither ever runs anything by itself — the Study Builder proposes a spec for the user to review, and
Ask AI proposes actions the user must approve one by one.

- **A provider-neutral core, two thin clients.** `src-tauri/src/ai/mod.rs` defines `AiRequest` (`system`, `messages`, and either
  a `schema` the answer's JSON text must follow, or `tools` it may call — never both), `Reply` (`text`, `tool_calls`, `model`)
  and the shared `AiError`/`Progress` types. `ai/claude.rs` and `ai/openai.rs` each build their own wire shape from an
  `AiRequest` and implement the same two methods (`check_key`, `message`) — no trait, since two is a closed set here, not a
  plugin point; `ai_commands.rs` picks between them with one `match` on the provider id (`provider_for`, see below). Anthropic
  speaks its Messages API (`x-api-key`, `output_config.format.json_schema`, `"fallbacks": "default"` with the
  `server-side-fallback-2026-07-01` beta header re-running a declined request on Anthropic's own recommended fallback model);
  OpenAI speaks Chat Completions (`Authorization: Bearer`, `response_format: {type: "json_schema", json_schema: {strict: true,
  …}}` — chosen over the Responses API for being the simpler, closer-to-Anthropic single-request shape). `MODEL` is one constant
  per file (`claude-opus-5`, `gpt-5.1`) — change either in one place. Both calls are plain HTTP (no Rust SDK for either), so the
  CSP is unchanged.
- **Keys are secrets like a broker's**, one per provider under its own id (`("anthropic", "apiKey")`, `("openai", "apiKey")`).
  `ai_set_key(provider, key)` checks it with that provider first (`GET /v1/models`, free on both) and only then saves it with
  `Secrets::set`; a key is read only in `ai_commands.rs`, never returned to the webview (`list_ai_providers` says only whether
  each is configured and where) and never logged. Neither is a data provider, so neither is in `providers.rs`. The **AI
  providers** dialog (`features/ai/AiProvidersDialog.tsx`) manages both from one place — the rail's key icon and Studies' own
  open it — and, once both are configured, which one is *active* (`ai_active_provider`, a UI preference; `provider_for` falls
  back to whichever is configured if the preferred one no longer is, and defaults to Anthropic so an existing Claude-only setup
  is unaffected). Studies' AI features and Ask AI both resolve their provider this same way — a request in flight always names
  which model actually answered it (`Reply.model`), since the active provider can change between one request and the next.
- **Who owns what.** Rust owns the *policy*: the system prompts (no invented data — market cap, sector, fundamentals and a
  point-in-time universe go in `unavailable`, with any alternative offered for the user to choose, never put in the spec;
  association, never causation; the user's text is material, not instructions) and the answer's outer shape. The frontend owns
  the *spec reference*: `studies/assistant.ts` builds the field notes and the feature grammar from `metrics.ts` (`FAMILY_MEANING`
  is a `Record` over `FAMILIES`, so a new family can't be left out) and `SPEC_SCHEMA`, which a test checks against every
  template.
- **A spec travels as JSON text.** Anthropic compiles a structured-output schema into a grammar and refuses a large one ("The
  compiled grammar is too large"); a full Study Specification's schema — nullable fields, number-or-feature conditions — was
  refused. So the answer's schema has `spec` as a *string* holding the spec's JSON, `SPEC_SCHEMA` goes to the model as reference
  text in the system prompt instead, and `parseDraft` parses the string before `normalizeSpec`. Keep output schemas small and
  free of `anyOf`/`enum`/`format`: `output_schemas_stay_small` (`ai/prompts.rs`) fails otherwise — and since the same schema
  objects are sent to OpenAI's `strict: true` mode unchanged (every property required, `additionalProperties: false` at every
  level, which that mode itself demands), this discipline keeps both providers working from one schema, not two.
- **What comes back is untrusted.** `parseDraft` runs the proposed spec through `normalizeSpec` (a failure is shown with its
  reason), caps every string, and never lets a proposal claim a template. The Studies tab shows the reply, *what changed*
  (`specChanges`, the builder's own wording), the assumptions and what can't be studied; **Open as a new Study** / **Apply to
  this Study** only load it into the builder, where readiness and the cost estimate apply as usual. A Study still runs only from
  Run Study. A follow-up revises the last proposal (the conversation, up to 20 turns, is resent each time).
- **Explanations** (`ai_explain_result`) are given `explainSummary(result)`: counts, medians, tests and findings — never the
  event rows, symbols or prices — plus the result's warnings. The answer is plain text in paragraphs with caveats, drawn as
  text, labelled as association, and not stored.
- What leaves the machine is said where a key is entered: the question, the spec and, for an explanation, that summary, sent to
  whichever provider is active under the user's account and billed to it.
- **Answers stream.** Both clients set `"stream": true` and read server-sent events with `Response::chunk()` (no extra reqwest
  feature), giving up only when the stream goes quiet for 120 s (`IDLE_TIMEOUT`; Anthropic pings while the model thinks) rather
  than after a fixed total, so `max_tokens`/`max_completion_tokens` can be 32 000. Each has its own pure, byte-split-tested SSE
  accumulator (Anthropic's `content_block_delta` events vs. OpenAI's `choices[0].delta`, ending in `data: [DONE]`) that keeps
  text deltas and reassembles a tool call's arguments from its `input_json_delta`/`function.arguments` chunks; a `fallback`
  block (Claude only) discards what the declining model had written. `stop_reason`/`finish_reason` is judged at the end, and a
  stream that ends without one is an error — but a tool-only answer with no text is not treated as empty. Every command takes a
  `requestId` and emits `ai-progress {requestId, stage, chars}` (at most 4 a second), which `useAiRequest` (generic over the
  answer type — Study Builder calls return `AiAnswer`, Ask AI's `AskAiAnswer`) turns into "Thinking…" / "Writing… 2.1k
  characters".

#### Research agent

*Research with AI* in the Studies sidebar (`ResearchView.tsx`, pure logic in `studies/research.ts`) runs rounds of
question → plan → approval → runs → synthesis → follow-up questions.

- **Plan** (`ai_plan_research`): one to four complementary Studies, each with its purpose, assumptions and what it can't study,
  plus what the question asks for that no Study can. `parsePlan` validates each spec as `parseDraft` does and makes names unique
  within the plan. Each card shows `interpret(spec)` and its readiness against this machine (`checkReadiness` with the universe's
  `estimateUniverse`); a Study that isn't ready can't be approved (open it in the builder instead).
- **Approval is the only way anything runs.** Studies start *proposed*; ticking makes them *approved*; the one **Run N approved
  Studies** press (which says how long the data will take) moves exactly those to *queued* (`queue` in `research.ts`, a pure
  reducer). The runs go one at a time through `useStudyRunner` — the hook Run Study uses too, extracted from `StudiesPanel` —
  because the broker's pace is shared. A failure moves on to the next; **Stop** stops the current run and skips the rest.
- **Everything is recorded as it happens** in a Research Notebook (created on the first Run, "Research: <question>"): each
  round's question and plan in its notes, each approved Study saved and added with its purpose as the entry's note, each result
  added as it lands (so a notebook keeps it from being pruned).
- **Synthesis** (`ai_synthesize_research`) is its own press, as it is a billed call. It is given each finished Study's purpose,
  spec and `explainSummary` (never events or prices) and returns paragraphs, a note per Study (matched by index; others are
  dropped), caveats and up to five follow-up *questions*. It is appended to the notebook's notes and the per-Study notes to the
  result entries — text only, labelled as association.
- **A follow-up** is a new plan with the synthesis as context, and needs its own approval; its Studies join the same notebook.

#### Ask AI

The rail's own assistant (`features/ai/AskAiPanel.tsx`, its allowlist and executors in `actions.ts`) answers questions about
using the app and, unlike the Study Builder, can **propose actions** — but never runs one itself. See "Ask AI never touches app
state" in "Security model" for the approval rule; this is the shape that rule takes in code.

- **The request** (`ai_ask_ai` → `prompts::ask_ai_body`) carries the conversation and a small, explicit context: the active
  chart's symbol and timeframe (read fresh from `ChartView`'s handle at the moment of asking, via `getMarket()` — not kept as
  React state, so it can't go stale between renders), the open tabs' labels, and watchlist *names* (never their contents, never
  a secret or a broker token — `AskAiContext` in `ai/prompts.rs` is the whole of what it sees).
- **Tools, not a JSON schema.** `AiRequest::with_tools` carries `ask_ai_tools()` — eight hand-written `ToolSpec`s (add/remove a
  watchlist symbol, create a watchlist, open a symbol, change timeframe, add/remove an indicator, create a price alert), each a
  strict object schema (every property required, no open objects). Hand-written rather than generated, unlike the Study
  Specification's grammar: the list is small and stable, not a large evolving spec.
  A reply's `tool_calls` become `ProposedAction { tool, arguments }` — inert data, same trip out as a Study's proposed spec.
- **`actions.ts` is the only place a proposal becomes a real call.** `prepareAction` re-validates a tool's arguments itself
  (never trusting the model followed its schema) and, only for a recognised tool with valid arguments, returns a plain-language
  `summary` for the confirmation card plus a `run()` that calls the exact function the matching UI does — `addWatchlistItems`,
  `savePriceAlert`, or one of `ChartViewHandle`'s `setTimeframe`/`addIndicator`/`removeIndicator` (new methods there, reached
  from `Workspace.tsx` the same way `goToSymbol` reaches `setSymbol`). An unrecognised tool or bad arguments return `null` and
  the proposal is dropped silently — never shown as a broken card. Nothing runs until the card's Approve is pressed; Reject or
  leaving it alone calls nothing.
- **A symbol argument is resolved the same way the search box would type it** (`resolveTypedSymbol`): a bare ticker gets the
  default provider, a known `provider:` prefix is honoured, and Zerodha tickers get `NSE:` where they need an exchange.
- **Single-turn.** A proposed action's result isn't fed back to the model automatically — simpler, and keeps every action fully
  human-gated; a user who wants the assistant to react to what happened asks a plain follow-up, the same as they would a person.

## Themes

`src/theme/themes.ts` is a registry: each theme supplies every token in `ThemeTokens` (TypeScript enforces it) and a
`baseMode` of `light` or `dark`, the nearest mode Vela understands. `ThemeProvider` applies the tokens as CSS custom
properties on `<html>` and persists the choice. To add a theme, append one entry — nothing else changes.

## Security model

- The webview's Content-Security-Policy (`tauri.conf.json`) blocks remote scripts, frames and images, and allows no
  outbound connections beyond the app itself and Tauri IPC (`connect-src 'self' ipc: http://ipc.localhost`). Both
  providers, `zerodha` and `csv`, call out through Rust over IPC, as do Ask AI, Studies and the updater, so nothing in
  the webview needs the network. Vela and PineTS still ship their own Binance, Coinbase and FMP fetchers; under this
  policy any path that reaches one fails instead of contacting those hosts, and a Pine script — which runs in a worker
  with `'unsafe-eval'` — can't send chart data anywhere. The workers inherit the page's policy. Check a release build
  after changing it: the dev server doesn't enforce the CSP.
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
- An AI provider's API key (Claude, GPT) is kept and read the same way, one per provider. Its answers are untrusted: a proposed
  spec is re-validated and shown for review, an explanation is drawn as text, and neither can start a run.
- **Ask AI never touches app state — it only proposes.** A tool call names an action and its arguments; `ai_commands.rs` hands
  it to the webview exactly as received, and `features/ai/actions.ts` turns it into a card only after re-validating those
  arguments itself (never trusting that the model followed its schema). The action runs — through the very function a click on
  the matching UI would call, nothing new — only once the user presses Approve on that specific card; Reject or leaving it
  alone does nothing. The action allowlist is small, reversible and non-financial (watchlists, the active chart's symbol,
  timeframe and indicators, price alerts): nothing that deletes a watchlist or layout, touches a secret or a provider setting,
  or reaches Python or Studies. This mirrors the rule Python's results already follow — a script's output is data to render,
  never something that runs itself — one step further out, onto actions instead of output.
- **A script runs without a press only on a schedule the user made** (see "Scheduled scripts"): never on startup (a run due
  then is missed, not made up), never on opening a layout or importing a file, and nothing but the user's form creates a schedule.
- The Python data API (see "Python") listens on the loopback interface only, refuses any request without the per-launch token, a
  matching `Host`, and no `Origin`, and serves read-only market data. The webview never talks to it (Rust does), so the CSP is
  unchanged. Python itself is *not* sandboxed: a script runs with the user's own privileges and only when they press Run.
- **The webview can now run code.** The Python commands let the webview save a script and run it, so an injection into the webview
  would mean code execution on the machine, where before it could only change what a chart shows. Keep the CSP strict, render
  nothing from a broker, a file or a script's output as HTML (the console draws text), and treat any new way for outside content to
  reach the DOM as a security matter.
