# CLAUDE.md

Guidance for AI coding assistants (and humans) working in this repo. Start with [README.md](README.md) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What this is

ProTradeChart is an open-source (AGPL-3.0) Tauri 2 desktop charting app. React 19 + TypeScript frontend, Rust backend, charts by Vela
(`@luxalgo/vela`, Apache-2.0 — its attribution mark must stay visible), SQLite for storage.

## Commands

```bash
npm run tauri:dev                       # run the app with hot reload
npm run typecheck && npm test           # frontend checks
npm run test:python                     # the protrade client's tests (needs Python 3.10+ with pandas)
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo fmt --manifest-path src-tauri/Cargo.toml
node scripts/checksums.mjs <folder>     # SHA256SUMS for a folder of installers (its tests run with npm test)
npm run licenses                        # regenerate THIRD_PARTY_LICENSES.txt after any dependency change
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Run all of the above before finishing a change. `npm run build` type-checks and bundles the frontend.

## Conventions

- A chart symbol is always `provider:TICKER` (`zerodha:NSE:RELIANCE`). Use the helpers in `src/lib/symbols.ts`; never split on
  `:` by hand.
- Pure logic lives in `src/lib/` (TypeScript) or `src-tauri/src/store/` (Rust) and has unit tests. Components
  and Tauri commands stay thin.
- All `invoke` calls go through `src/lib/ipc.ts`; its types mirror `src-tauri/src/models.rs` (camelCase over the wire).
- Data providers report failures with `notify()` from `src/data/events.ts` and return `[]` — they don't throw into Vela.
- Data providers are declared in `src-tauri/src/providers.rs` (the source of truth for settings) and registered in
  `src/data/providers/index.ts`. Broker credentials are secrets: they live in the OS keychain via `secrets.rs`, are read
  only in Rust, and must never be sent to the webview or logged. `Secrets` remembers the OS store's answer for a minute, so
  write a credential only through `Secrets::set` / `delete` (which update it), never to `keyring` directly. See "Adding a
  broker" in `docs/ARCHITECTURE.md`.
- A chart's canvas background belongs to the layout when one was chosen, and falls back to the theme
  (`chart/canvasBackground.ts`): `withoutTheme` keeps any background that isn't Vela's own dark/light default, and
  `ChartView`'s `applyTheme` re-applies chosen backgrounds after every `setTheme`. Vela inks its attribution mark from the
  theme, so `tintAttribution` re-inks it from the canvas — keep that wherever backgrounds change, or the mark can vanish.
- Every theme must define every token in `ThemeTokens` (`src/theme/themes.ts`); a test enforces it.
- AI providers (Anthropic, OpenAI) are two plain structs with the same `check_key`/`message` pair, not a trait — `ai/claude.rs`,
  `ai/openai.rs`, both built from the provider-neutral `AiRequest`/`Reply` in `ai/mod.rs`. Add a third the same way, then add it
  to `PROVIDERS` and the `match` in `ai_commands.rs`'s `send`. Their keys are secrets like a broker's (`("anthropic"|"openai",
  "apiKey")`); the "AI providers" dialog (`features/ai/AiProvidersDialog.tsx`) is the one place both are managed.
- Comments explain why, not what. Match the surrounding style.

## Gotchas

- A plain `#[tauri::command] pub fn` runs on the **window's main thread**: if it waits (the `Database` mutex held by an
  instrument-list refresh, a slow query), the window freezes until
  it's done. So every command that touches the database or the disk is `#[tauri::command(async)]` (a worker thread; it must
  return a `Result`); keep that for new commands, and only leave a command synchronous when it touches neither. Never hold
  a lock across an `.await` either (`std` guards aren't `Send`, so spawning would refuse it anyway).
- `installThinMovingAverages()` has to run after **every** `new VelaWorkspace(...)` (Vela re-registers its own on each
  construction).
- Vela's price-scale autoscale hardcodes its top/bottom padding (`MARGIN_TOP`/`MARGIN_BOTTOM` in its compiled
  `computePaneScale`) and exposes no config for it — that's why an unpatched chart leaves a stock at all-time highs well
  short of the top of the pane. We patch it to a smaller, symmetric margin via `patches/@luxalgo+vela+*.patch`
  (`patch-package`, wired as `postinstall`). The patch targets a literal string across every bundle copy in
  `node_modules/@luxalgo/vela/dist/` (chunk, `index.cjs`, `vela.global.js`, `widget.cjs`, `workspace.cjs`); a Vela version
  bump can rename the chunk or reformat the constant and silently fail to apply (`postinstall` will error loudly, it
  won't apply partially) — regenerate it by re-editing `node_modules` and rerunning `npx patch-package @luxalgo/vela`,
  and rename the old patch file away since it's pinned to the old version.
- The same patch extends Vela's menus for the chart's **Add SYMBOL to watchlist** list (`chart/watchlistActions.ts`):
  (1) a contributed context-menu action may carry `labelFor(ctx)` (a label naming the chart's symbol) and a **submenu**
  (`submenu(ctx)` items, ids `action:<id>::<item>`, picked ones routed to `runItem(ctx, item)`) — `ChartContextMenu` in
  `chunk-EMB53WNQ.js`, `widget.cjs`, `workspace.cjs`; (2) a menu item may be a **checkbox** (`checkbox: true`): a box in the
  mark column, the menu stays open when it is picked, and the box flips at once — the `Menu` surface in
  `chunk-BKHSQ4YM.js`, `ui.cjs`, `index.cjs`, `widget.cjs`, `workspace.cjs`, `vela.global.js`, styled by `.vela-menu-checkbox`
  in `app.css`. Vite pre-bundles Vela, so after changing `node_modules` restart the dev server with `--force` (or delete
  `node_modules/.vite`).
- A background tab is `display: none`, so its chart isn't built until first shown (`ChartView`). Don't assume a tab has a
  live chart.
- Vela loads a chart to a fixed depth (`market.bars`) and doesn't page on scroll: `chart/historyBackfill.ts` raises the
  depth as the view nears the oldest bar. A provider's `getBars` must return an *empty* array only when there really is
  nothing older (Vela treats that as the start of history), and must *throw* on a failed backfill instead of returning
  `[]` or toasting — see `isBackfillRequest` in `data/providers/common.ts`.
- A tab is a grid of up to 16 charts, not one chart. `ws.chart` is only the *active* cell and cells are created and
  destroyed as the grid changes: never cache a chart, and apply per-chart settings to `ws.cells()`.
- Not every tab is a chart: the Script Editor, Python, Studies and Screener workspaces are tabs too (`features/workspace/tabs.ts`). Anything outside the tab
  that needs a chart must go through `activeChartTab`, never `tabs[i].symbol`; layouts save chart tabs only; and the
  last chart tab can't be closed. See "Layouts and tabs" in `docs/ARCHITECTURE.md`.
- Daily-and-up bars are stamped at local midnight of the exchange's date; intraday bars keep their real instant. Each new
  chart is switched to the machine's timezone so both display correctly.
- The Content-Security-Policy in `tauri.conf.json` is **not applied by the Vite dev server** — test CSP-sensitive changes
  in a release build (`npx tauri build --no-bundle`).
- `THIRD_PARTY_LICENSES.txt` is bundled with the installers and shown in About; it reproduces every dependency's licence.
  Regenerate it (`npm run licenses`) whenever `package-lock.json` or `Cargo.lock` changes. The About dialog also carries
  the AGPL's legal notices (copyright, no warranty, licence, source link): keep them.
- The web view loads nothing from third-party servers the user didn't choose: the CSP has no remote `img-src`.
- Keep `writing` `﻿` and similar invisible characters as escape sequences, not literals.
- Pine Script runs on PineTS in a **Worker** (`pine/engine.ts`), which is why the CSP has `'unsafe-eval'` — never use the
  in-process `PineEngine`, and don't add other uses of `eval`. `installPineEngine`, `installPinePersistence` and
  `installPineHostActions` (`main.tsx`) must run before the first `VelaWorkspace`. See "Pine Script" in
  `docs/ARCHITECTURE.md`.
- Pine scripts that ship with the app are the `.pine` files under `pine/indicators/` (see `pine/README.md`). Their declared
  title is their identity in saved layouts (Vela stores manifest indicators by name), so don't rename one casually or give two
  files the same title. `npm test` runs each on the real engine; keep that gate.
- On a Vela script handle, `title` is a placeholder until the script runs (use `declaredTitle(source)` or `run.title`),
  and `ready` fires once — after `updateCode`, wait for `script:run` with `cause: 'code'`. `propValues()` includes
  the defaults: persist `inputDeltas(...)`, never the raw values.
- Backtests are approximate (PineTS's broker emulator differs from TradingView's) and cover only the bars the chart has
  loaded. The app is AGPL-3.0 because it bundles PineTS: new dependencies must be compatible with that.
- Verify a new broker integration against the real service with fake credentials (real error bodies, real socket
  behaviour) before trusting the docs: a broker's feed may accept the socket and only then drop it on a bad token.
- Zerodha's one-click login (`zerodha/callback.rs`) catches Kite's redirect on `127.0.0.1:47821`, so the port is part of
  the user's Kite app configuration: changing it silently breaks every existing setup. Bind before opening the browser,
  keep it loopback-only, and leave `zerodha_complete_login` (paste the address) working for apps that redirect elsewhere.
- Zerodha (Kite Connect) tokens expire every morning and have no expiry field: the app estimates the reset (next 06:00 IST)
  from when the token was saved (`accessTokenSavedAt`). Kite's instrument lists are public (no login) and its bad-token
  errors are `{"status":"error","error_type":"TokenException"}`. `cargo test --lib zerodha::live -- --ignored` runs opt-in
  tests against the real service (no credentials needed) — run them when touching `zerodha/`.
- Zerodha gives Vela's OWN symbol index (`listSymbols`, `capabilities.enumerate`) only its NSE equities
  (`list_nse_equities` → `store::instrument_list`, ~2,000 symbols) — its full instrument list (BSE, F&O, indices) are
  50x that and were deliberately left out of an eager in-memory index. That index is what powers clicking a chart's
  symbol name or bare-typing to search; it's read once, when Vela registers the provider, so connecting a broker
  mid-session needs a restart to be indexed. It has nothing to do with the app's own search box (`SymbolSearchBox`,
  `data/search.ts`), which already searches everything live and doesn't use this.
- Price alerts fire from exactly one place: the engine in the `main` window (`alerts/engine.ts`). Don't start it elsewhere or
  alerts will ring once per window. A crossing is judged between two price samples, so anything that changes an alert's
  status (pause, re-arm, edit) must clear `basePrice` (or set it to the current price) so it doesn't fire over a move that
  happened while it was off.
- The auto-updater (`src/updates/`, `tauri-plugin-updater`) trusts only the public key in `tauri.conf.json`
  (`plugins.updater.pubkey`). Never commit, print or paste the private key (`*.key` is git-ignored; it lives outside the
  repo), and never change the pubkey without a plan for existing installs — they will refuse updates signed with any other
  key. `bundle.createUpdaterArtifacts` makes `tauri build` demand `TAURI_SIGNING_PRIVATE_KEY` unless `--no-bundle` is used.
  The check runs only in the `main` window and only in release builds (`startBackgroundUpdates`); see "Releasing" in
  `CONTRIBUTING.md`.
- Python scripts get market data only through the local API in `pyapi/` (see "Python" in `docs/ARCHITECTURE.md`). It must stay
  loopback-only and behind its three checks (matching `Host`, no `Origin`, the per-launch bearer token), which `server.rs`
  applies *before* reading any body: don't add a route that returns a credential or touches an order, don't add CORS, and don't
  let the webview or anything else reach it. `POST /v1/results` is the one route that isn't a read.
- What a script shows (`pt.show`, `pt.report`, `pt.plot`) is untrusted data: `python/results.ts` validates it and the panel
  draws text and a checked PNG only. Never render a script's output as HTML, and refuse a result you don't recognise rather
  than guessing at it. A script runs only when the user presses Run, or when a **schedule the user made by hand** in the Python
  tab comes due while the app is open — never on startup, on importing a file, or on opening a layout. Python isn't sandboxed;
  don't imply it is. And since the Python commands let the webview save and run a script, anything that lets outside content reach the
  DOM (HTML from a broker, a file or a script's output) is now a code-execution risk: keep the CSP strict and render text only.
- Scheduled scripts (`scheduler/`, `store/schedules.rs`, `features/python/SchedulesPane.tsx`) are the one way a script runs
  without a press, so the rules are strict. Only `save_schedule`, called from the Schedules pane, makes one: never give Ask AI a
  tool for it, and never let a script or a layout create one. The engine (`scheduler::engine`, started once in `lib.rs`) never
  makes up a run: anything already due on its **first look after launch** is recorded as missed, as is a run more than
  `GRACE_MS` late (the machine slept), and switching a schedule on or editing it plans from now. Keep `plan::decide` pure and
  that rule in it. Times are IST, like `market.rs`; don't add a timezone crate.
- A script writes a watchlist only through `pt.set_watchlist` — a result of kind `watchlist` that `pyapi/routes.rs`
  (`watchlist_update`) checks and `store::watchlists::sync_named` writes; it is not forwarded to a window. Its symbols are
  made canonical there (a bare broker ticker is NSE). `replace` keeps surviving rows where they are, with their flags, and never
  touches section headings. Every write emits `watchlists-changed`, which `watchlistBus` relays to the panel. Don't add any
  other route that gives a script a way to change something a window shows (a layout, an alert, a setting) — `POST
  /v1/bars/sync` (and `POST /v1/snapshot`'s top-up) is not one of these: like `GET /v1/bars`'s own caching, it only ever
  writes broker bars to the session's memory, never anything a script asked it to store, and a script can't tell it what to write.
- A screen (the Screener tab, `src/screener/`, `protrade/screen.py`) judges its filters on each symbol's **latest bar** only, in
  the Studies' feature grammar. `normalizeScreen` and `normalize_screen` apply the same rules (both run
  `src/screener/fixtures/screen-cases.json`), and `src/screener/fixtures/engine-result.json` is real engine output that
  `result.test.ts` parses: when the result's shape changes, regenerate it with `PROTRADE_WRITE_FIXTURE=1` (see
  `python/tests/test_screen.py`). A saved screen keeps only its last run (`store/screeners.rs`).
- The Screener's toolbar (`ScreenerPanel.tsx`) has quick shortcuts into `draft.universe` — a `<select>` for the screen name
  (styled as `.screener-name-select`, listing `screens` so it doubles as a switcher), and `.screener-quickbar`'s universe
  source and NSE/BSE pills — that write the exact same `setUniverse` the full Universe section (now behind **More
  options**, `.screener-more-panel`) does; there is no separate state to keep in sync. The side list still owns creating,
  presets and delete, and can itself collapse to a thin strip (`sideCollapsed`, `.screener-panel.side-collapsed`) for more
  room. Everything that used to sit beside the filters in a fixed column — rename, the full universe form, and **Before
  it runs** — now lives behind the quickbar's **More options** toggle (`moreOpen`), so `.screener-builder` is a single
  column and Filters/Columns get the width. A column is added by picking it from a dropdown off a **+** button
  (`.screener-columns`'s `menu`/`menu-item`, reusing the `.menu-anchor` pattern from `LayoutMenu.tsx`), not by typing a
  name — it filters out columns already added and stays open so several can be picked in one go.
- Filters in the Screener are chips (`FilterChips.tsx`), not the always-expanded rows `ConditionList.tsx` still draws for
  Study Builder — the two are deliberately separate components over the same `Condition` type, so a Screener-only UI
  change never touches Study Builder's filters. A chip collapses to `describeCondition(c)`; clicking it opens that one
  condition's own popover (a period, via `parseFeature`'s `window` — skipped for a feature with none, like `close` —
  friendlier operator words in `OP_LABELS`, and a value or another feature). A feature is added the same picker-menu way
  as a column, and immediately opens its new chip's editor. The period `<select>` always injects the condition's actual
  window as an option even when it isn't one of `WINDOW_CHOICES`' curated ones (a hand-edited or older spec, or a short
  period like RSI's 14) — never silently rounds it to the nearest offered choice.
- The Screener's and a Study's first run over a whole exchange after launch pays Kite's historical rate limit once (unless the
  market is loaded; `store/day_topup.rs`, `pyapi/data.rs`'s `sync_daily`); every run after that, while the app stays open, calls
  `api._top_up` (`POST /v1/bars/sync`, from `screen.py`'s `Screen.run` and `study.py`'s `Study.load`, right before their own fetch
  loop) to bring already-held symbols' latest bar up to date from one batched broker quote instead of a historical call each. `candidate()` only offers a symbol with no unaccounted weekday gap since
  its last settled session; `snapshot_bar()` then only trusts a quote whose previous close matches the prior stored bar (within a
  tick) and whose volume isn't newly missing — anything it rejects, or any provider whose quote call fails, falls back to the
  existing per-symbol `/v1/bars` read untouched, so a mismatch degrades to slow-but-correct, never a wrong bar. `_top_up` itself
  never raises (`PROTRADE_NO_TOPUP=1` disables it outright); don't let it block a run.
- Before any of that, a screen judges the filters today's quote alone decides on one `POST /v1/snapshot` for the whole universe
  (`screen.py`'s `_prefilter`, `snapshot_decidable`, `SNAPSHOT_FEATURES`; `spec.ts`'s `snapshotDecidable`/`quoteUse` mirror it for
  the readiness text, keep the two lists in step). It must give **exactly** the full run's answer: a feature qualifies only if a
  two-bar frame (previous close, then the quote) yields the number the history's latest bar would, a crossing only of the close,
  and a symbol whose quote isn't this session's (or that has no previous close) goes to history. `as_of` counts the quotes'
  session, or a suspended stock would set it. It's best-effort like the top-up (skipped pre-open, on any error, or with
  `PROTRADE_NO_SNAPSHOT=1`); `test_screen.py`'s `PrefilterTests` runs random screens both ways and requires identical results.
- Drawings belong to the symbol (`chart/symbolDrawings.ts`, `store/symbol_drawings.rs`), not the chart: every chart swaps
  them on a symbol change. A symbol with no stored row adopts a layout's drawings; an *empty* document means "cleared" — never
  delete the row instead. Anything that replaces a chart's drawings must go through the port (deselect, `fromJSON`, deselect,
  and `chart.resize()` if a drawing was selected) or Vela leaves an orphaned edit toolbar on screen.
- The Help Center's content is `src/help/topics.ts` (data, drawn as text by `features/help/HelpDialog.tsx`, never as HTML).
  When you add or change a feature a user sees, update its topic in the same change; name buttons exactly as the UI does.
  `SHORTCUTS` there is also what About lists, and the indicator reference is built from `studies/assistant.ts`'s meanings.
- Ask AI never acts on its own: a tool call is data (`ProposedAction`) until `features/ai/actions.ts::prepareAction` turns it into
  a confirmation card, and only pressing Approve calls the real function. Adding an allowlisted action means adding it in *two*
  places that must agree — a `ToolSpec` in `ai/prompts.rs::ask_ai_tools` and a matching case in `prepareAction` — and a tool
  without a case there is dropped silently, never run. Keep the allowlist to what's already reversible and non-financial; don't
  add anything that deletes a watchlist or layout, touches a secret, or reaches Python or Studies.
- **Broker price history never touches disk** (Kite Connect's terms restrict permanent copies of its data). Every broker bar
  lives in `store::bar_memory::BarMemory` (Tauri state) for the session: the Python API's, the Screener's and Studies', "Keep the
  market loaded"'s, and the charts' recent bars (put without coverage, as the offline fallback). Only the user's imported
  datasets are persisted. Don't add a table, file or cache that holds a broker's prices; derived results (a screen's or Study's
  last run) are the one thing kept, and `market_symbols` holds names, never prices. `store/bar_tables.rs` drops the old bar
  tables once (then `VACUUM`). `BarMemory`'s lock is never held across an await.
- The Python API serves from that memory and records what a broker call *really*
  covered: the brokers' clients silently answer an over-long range with only its newest part, so `Fetcher::fetch` reports where it
  began. Daily bars sit on IST midnight. A new broker fetch path must keep both. A daily series' freshness follows the exchange's
  calendar (`market.rs`), not the age of the last sync: a settled session's bar never changes, and an age-based ttl re-fetched every
  symbol on every run. Keep `plan` pure (`now` is an argument) and don't add a holiday list.
- `python/protrade/*.py` is embedded in the binary (`python/client_files.rs`, `FILES`); a test fails when a module is added to the
  folder and not listed. A debug build writes the repository's copy instead (so Python changes need no rebuild under `tauri:dev`);
  a release build always writes the embedded one. The package is standard library plus pandas, and must work on pandas 2 and 3. Script names refuse
  anything that could shadow a library (`scripts.rs`), because a script's folder is first on Python's import path.
- `python/examples/*.py` (a different embedding: `scripts.rs`'s `EXAMPLES`, `include_str!`) are the scripts seeded into a new
  Python tab. One the user hasn't touched is replaced when a newer version ships (their own edit or deletion is left alone).
  `python::e2e`'s example-scripts test runs every one against the real API and expects it to fit one of three shapes: prints
  only (`hello.py` — extend that list for another pure-side-effect script), a `pt.show` table
  (`screen_*.py`), or a `pt.report` (everything else) — a new example needs a matching branch there, not just a spot in
  `EXAMPLES`.
- A broker symbol is stored and compared in its long form (`zerodha:NSE:HFCL`) but *shown* short (`HFCL`) — never render
  `symbol` or `splitSymbol(...).ticker` to the user; use `displayTicker`. A chart is given the short form (`chartSymbol`), so
  anything read back from Vela must go through `normalizeSymbol` before it is compared or stored, or a watchlist row, an
  alert and a chart will disagree about what they are looking at. `NSE:` is the one exchange hidden (Zerodha reads a bare
  ticker as NSE); don't hide another without giving the backends a way to find it from a bare ticker. See "How a symbol is
  shown" in `docs/ARCHITECTURE.md`.
- A colour flag belongs to the **symbol** (`symbol_flags`), not a list's row: `watchlists::get` joins it in, and
  `watchlist_items.flag` is legacy (migrated once, then cleared — don't write it). Each colour's list has a reserved
  **negative** id (red -1 … purple -6, `flag_list_id` / `ipc.ts` `flagOfList`, kept in step by tests): `get_watchlist`
  builds it from the flags, adding to or removing from it flags or unflags, and `real_list` refuses rename, delete, order and
  sections for it. Anything new that takes a watchlist id must handle a negative one.
- A watchlist's rows are `watchlist_items` and `watchlist_sections` sharing one `position` sequence (numbered from 1: `0` would
  read as "not migrated"). Add rows through `add_items` / `add_section` so they get one, and reorder only through `set_order`.
  The list is windowed on **one fixed row height**, so anything else that lives in it (a section heading) must be exactly a
  row tall. Dragging is pointer events (`useRowDrag`), not HTML5 drag and drop, which the window's file-drop handler eats on
  Windows. See "Side panels, watchlists and tab prices" in `docs/ARCHITECTURE.md`.
- A tab's price comes from two places (`lib/tabQuote.ts`): a poll of the tabs' symbols and the ticks a streaming provider
  delivers. Providers publish those in `data/providers/index.ts` (`withLivePriceTap`); a new streaming provider must be wrapped
  there, and its `subscribe` receives the chart's ticker in whatever form Vela chose, so the tap goes through `normalizeSymbol`.
- The right rail (`features/rail/`) shows one panel at a time; the watchlist panel stays mounted while hidden and must not fetch
  prices then (`visible`). The alerts *list* is that rail's panel; only the new/edit **form** is a dialog. The rail also carries
  the Home, Script Editor, Strategy Tester, Python, Studies and Screener buttons, and at the bottom, Import data, New window, Data providers,
  AI providers, Help and About (all `RailAction`s, not panels) — the tab bar keeps only the Layout menu, search and theme.
  A `RailAction` can carry `dot: true` for a small "something's ready" indicator (About's update dot); that's different from
  a `RailPanelButton`'s numeric `badge` (the alerts count) — don't conflate the two.
- The Home tab (`features/home/HomePage.tsx`, `kind: 'home'` in `features/workspace/tabs.ts`) is a workspace tab like Python,
  at most one open, opened from the rail's Home button. Every card just calls the same callback its equivalent elsewhere in
  `Workspace.tsx` already uses (`openPython`, `showRailPanel('watchlist')`, `setAboutOpen`, …), so add a new card by wiring
  it the same way rather than duplicating logic. Add a feature here too, and it belongs on the Home tab: update its section
  in `HomePage.tsx` in the same change, the same rule the Help Center gotcha above already follows. The Setup section is the
  one exception to "no state of its own": it reads its cards' Done/Pending status itself (a broker connected, an AI key set,
  a dataset imported, Python ready), on its own mount, since Home may be the first thing opened —
  it can't assume `Workspace.tsx` or another tab has already loaded any of that. Give a new Setup card a status only if it
  has a genuine finished state; an ongoing action (open a tool, import another file) stays unmarked, and so does Market data,
  whose loaded state goes when the app closes.
- The window has no native title bar (`"decorations": false` on every window, `tauri.conf.json` and `lib/windows.ts`'s
  `openNewWindow`): the tab bar is it. `.tab-brand` (the logo and "ProTradeChart") and `.tab-bar-drag` (the spacer before
  the actions) are what's draggable (`data-tauri-drag-region`, `app.css`); double-click either to maximize needs no code —
  Tauri's own `internal_toggle_maximize` handles it, pre-granted by `core:window:default` — so don't wire that by hand, it
  would double-toggle against the native one. `WindowControls.tsx` draws the minimize/maximize/close the OS no longer does,
  and each of those (plus dragging itself) needs its own permission in `src-tauri/capabilities/default.json`
  (`core:window:allow-minimize`/`allow-maximize`/`allow-unmaximize`/`allow-toggle-maximize`/`allow-close`/
  `allow-start-dragging`) — `core:default` only covers read-only window state (`is-maximized` and the like), so a window
  control added without its permission silently does nothing, no error shown. Built and tested on Windows only; macOS and
  Linux haven't been checked.
- A Study's source of truth is its **Study Specification** (`src/studies/spec.ts`), not Python. `normalizeSpec` (TS) and
  `normalize_spec` (`python/protrade/study.py`) apply the same rules, and `studies/metrics.ts` accepts exactly the feature
  grammar `protrade/features.py` computes: change one side, change the other. The engine's result is untrusted script output
  (`studies/result.ts` re-validates it, spec included, and nothing is drawn as HTML); if its shape changes, regenerate
  `src/studies/fixtures/engine-result.json` with `python/tests/make_study_fixture.py` (a Python test fails until you do).
  A Study runs only from Run Study (or a script the user runs). The rule for which instrument-list rows are stocks
  (`listing_series` / `pick_listings`) exists in `protrade/study.py` and `store/study_universe.rs` (for the pre-run estimate):
  change both. A first run is bound by the broker's pace, so never fetch what can't be a stock, and keep the load a single
  pool rather than batches. See "Studies" in `docs/ARCHITECTURE.md`.
- A Study looks at an event three ways: **snapshots** (`metrics`, `characteristics`: one bar at an observation point),
  **measures** over a window (`measures`: one number per event, e.g. days a condition held in the 12 months before), and
  **episodes** (a measure whose window starts or ends on a day found near the event: its 12-month low, the first close below
  the 50 SMA). A question about time must be a measure, never snapshots sampled at a few points — that silently answers
  something else. Measures live in `protrade/measures.py` (pure numpy, per symbol) and `spec.ts`/`measures.ts`; the window
  model is fixed: bar A → bar B, counting stats read A+1…B, price stats the closes at A and B (so `{-252}→{0}` includes the
  event bar and its return is `return_252`). A before-window never reads a bar after the event; a window with any unknown
  bar is blank (`no_history`), never partial; a search that didn't find its day is `capped` (a lower bound, said so) or
  `not_found`, and one the data ended on is `too_recent` — never a made-up number. Both validators are tested against the one
  file `src/studies/fixtures/spec-cases.json`: add a rule there, not to one side. A new `protrade/*.py` module the engine uses
  goes in `client_files.rs` `FILES` **and** `engine_build()`'s list. The answer a result opens with (`studies/answer.ts`) is
  built from the numbers, deterministically, and drawn as text. The results page is answer first (`StudyResults.tsx`: answer,
  one chart, stock by stock) with every older table kept under Details (`StudyDetails.tsx`) — add new detail tables there, not
  above the answer. Every event table sorts through `views.ts` `sortRows`.
- A Study's significance tests (`protrade/stats_tests.py`) are standard library + numpy/pandas — don't add scipy — and their
  known-answer tests were computed with scipy/statsmodels; keep them. A q-value below 0.05 is still an association: never word
  a finding as a cause (`studies/significance.ts`). A run in a Research Notebook is never pruned (`store/studies.rs`).
- Studies never invent data. There is no market cap, sector or point-in-time universe: say so (`studies/readiness.ts`), block a
  run that needs it, and offer an alternative only for the user to pick — never substitute silently. Events are the first bar
  their conditions hold, filters are judged at the time (no look-ahead), prices are used as the broker supplied them (no
  corporate-action adjustment), and results are labelled historical association, never causation.
- The AI Study Builder's Anthropic API key is a secret like a broker's: saved through `Secrets` (`anthropic` / `apiKey`) only
  after Anthropic accepts it, read only in `ai_commands.rs`, never sent to the webview or logged. Claude is called from Rust
  (`ai/`), never the webview. What it returns is an untrusted *proposal*: `parseDraft` re-validates the spec with
  `normalizeSpec`, the user reviews it, and it never starts a run; an explanation is drawn as text only and worded as
  association. Explanations get `explainSummary` (counts, medians, tests), never event rows, symbols or prices. The system
  prompts (`ai/prompts.rs`) forbid substituting unavailable data, and forbid answering a question about time with snapshots
  (a test checks the wording): what the spec can't express goes in `unavailable`. `SPEC_SCHEMA` / `specReference` (`studies/assistant.ts`)
  describe the spec and must change with it (a test checks the schema against every template). `SPEC_SCHEMA` is prompt *text*,
  never the request's output schema: that is compiled into a grammar, and a spec-sized one is refused ("compiled grammar is too
  large"), so a spec comes back as a JSON string. Keep output schemas small, with no `anyOf` (a test checks). See "AI Study Builder" in
  `docs/ARCHITECTURE.md`.
- The research agent (`ResearchView.tsx`, `studies/research.ts`) never runs a Study the user didn't approve: only the **Run N
  approved Studies** press queues them, exactly the ticked ones, one at a time through `useStudyRunner` (shared with Run Study;
  don't start runs any other way). A synthesis is a separate press, drawn as text; follow-ups are *questions* that become a new
  plan needing a new approval. Claude's answers stream (`SseAccumulator`): judge `stop_reason` at the end, and drop text written
  before a `fallback` block.
- "Keep the market loaded" (`marketdata/`, "Keep the market loaded" in `docs/ARCHITECTURE.md`) reads five years of every NSE
  stock's and index's daily bars into memory. It is opt-in (`marketData.keepLoaded`). Its jobs are **Rust jobs, not scripts**:
  they run only after the user switched it on, only while the app is open, never during startup (first look two minutes after
  launch), and always inside `throttle::in_background` so charts and user-run scripts go ahead of it at the broker (the lane is a
  task-local: wrap every task a job spawns). A series the quote can't update is dropped and read again whole
  (`BarMemory::forget`), never mixed across a split. The session's record of loads is in memory too. New listings are found
  through `market_symbols`, which outlives the instrument tables.
- `POST /v1/panel` is a read (posted because the symbol list doesn't fit a URL): it answers from memory alone, never the broker,
  in the binary layout documented on `wire::panel_body`, which `protrade/panels.py` reads — change both together. A series not
  `current` is the caller's to read through `/v1/bars`.
- A feature name may carry an interval, `rsi_14@W` / `ema_50@M` (bare = daily): weekly (to Friday) and monthly bars are built
  from the daily ones by `features.period_bounds`/`period_bars`, which `Features` and `WideFeatures` share. A condition is
  judged on its **left** feature's interval (a weekly cross is this week against last week). Intervals are for the Screener
  only: `normalize_spec`/`normalizeSpec` refuse them, because a past day's week includes the days after it. `between` /
  `outside` take `right: [low, high]`; `withOp` reshapes the right side when the operator changes. The Screener's filter
  editor is driven by `src/screener/catalog.ts` (picker groups, titles, chip text, which families compare); a new feature
  family needs an entry there as well as in both grammars.
- `protrade/wide.py` computes features for many symbols on a table **aligned by bar position** (each symbol's bars at the bottom of
  its column), which is what makes its numbers equal `Features`'. `features.py`'s maths must work on a Series and a DataFrame alike:
  don't add an `iloc` by position or a `where(..., value)` that turns a row above a symbol's first bar into a value. Keep
  `tests/test_wide.py`, which checks every family, and the Screener fixture, which must not change.
- **Binance, Coinbase and Hyperliquid are not data sources** — Vela's own bundled crypto providers, free and
  needing no account, removed at the owner's request so Zerodha is the only live data source. They're hard-deleted:
  just gone from `ProviderId`/`PROVIDER_LABELS` (`lib/symbols.ts`) and `providers.rs`, with no purge job —
  `isSupportedSymbol`'s normal handling of an unknown provider covers `binance:`/`coinbase:`/`hyperliquid:` symbols
  saved before the removal, as it would any provider the app doesn't have. `DEFAULT_PROVIDER` is now `zerodha` (naming
  NSE), so a bare ticker and the starter watchlist need the user's own Zerodha account connected to actually load — they no longer work with zero setup. Don't bring back a free crypto
  source without the owner's say-so, and don't add a source that scrapes an unofficial endpoint.
