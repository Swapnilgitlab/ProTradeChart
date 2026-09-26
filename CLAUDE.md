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

- A chart symbol is always `provider:TICKER` (`binance:BTCUSDT`). Use the helpers in `src/lib/symbols.ts`; never split on
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
- Every theme must define every token in `ThemeTokens` (`src/theme/themes.ts`); a test enforces it.
- Comments explain why, not what. Match the surrounding style.

## Gotchas

- `installThinMovingAverages()` has to run after **every** `new VelaWorkspace(...)` (Vela re-registers its own on each
  construction).
- A background tab is `display: none`, so its chart isn't built until first shown (`ChartView`). Don't assume a tab has a
  live chart.
- Vela loads a chart to a fixed depth (`market.bars`) and doesn't page on scroll: `chart/historyBackfill.ts` raises the
  depth as the view nears the oldest bar. A provider's `getBars` must return an *empty* array only when there really is
  nothing older (Vela treats that as the start of history), and must *throw* on a failed backfill instead of returning
  `[]` or toasting — see `isBackfillRequest` in `data/providers/common.ts`.
- A tab is a grid of up to 16 charts, not one chart. `ws.chart` is only the *active* cell and cells are created and
  destroyed as the grid changes: never cache a chart, and apply per-chart settings to `ws.cells()`.
- Not every tab is a chart: the Python workspace is a tab too (`features/workspace/tabs.ts`). Anything outside the tab
  that needs a chart must go through `activeChartTab`, never `tabs[i].symbol`; layouts save chart tabs only; and the
  last chart tab can't be closed. See "Layouts and tabs" in `docs/ARCHITECTURE.md`.
- Daily-and-up bars are stamped at local midnight of the exchange's date; intraday bars keep their real instant. Each new
  chart is switched to the machine's timezone so both display correctly.
- The Content-Security-Policy in `tauri.conf.json` is **not applied by the Vite dev server** — test CSP-sensitive changes
  in a release build (`npx tauri build --no-bundle`).
- `THIRD_PARTY_LICENSES.txt` is bundled with the installers and shown in About; it reproduces every dependency's licence.
  Regenerate it (`npm run licenses`) whenever `package-lock.json` or `Cargo.lock` changes. The About dialog also carries
  the AGPL's legal notices (copyright, no warranty, licence, source link): keep them.
- The web view loads nothing from third-party servers the user didn't choose: the CSP has no remote `img-src`, and Vela's
  crypto providers have `resolveSymbolIcon` switched off (`data/providers/index.ts`) so no coin logos come from Ledger.
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
  behaviour) before trusting the docs: Dhan's feed, for one, accepts the socket and drops it on a bad token.
- Zerodha's one-click login (`zerodha/callback.rs`) catches Kite's redirect on `127.0.0.1:47821`, so the port is part of
  the user's Kite app configuration: changing it silently breaks every existing setup. Bind before opening the browser,
  keep it loopback-only, and leave `zerodha_complete_login` (paste the address) working for apps that redirect elsewhere.
- Zerodha (Kite Connect) tokens expire every morning and have no expiry field: the app estimates the reset (next 06:00 IST)
  from when the token was saved (`accessTokenSavedAt`). Kite's instrument lists are public (no login) and its bad-token
  errors are `{"status":"error","error_type":"TokenException"}`. `cargo test --lib zerodha::live -- --ignored` runs opt-in
  tests against the real service (no credentials needed) — run them when touching `zerodha/`.
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
  than guessing at it. A script runs
  only when the user presses Run — never on startup, on importing a file, or on opening a layout. Python isn't sandboxed; don't
  imply it is. And since the Python commands let the webview save and run a script, anything that lets outside content reach the
  DOM (HTML from a broker, a file or a script's output) is now a code-execution risk: keep the CSP strict and render text only.
- The Python API serves from its own store (`store/research_bars.rs`), not `bars_cache`, and records what a broker call *really*
  covered: the brokers' clients silently answer an over-long range with only its newest part, so `Fetcher::fetch` reports where it
  began. Daily bars sit on IST midnight. A new broker fetch path must keep both. A daily series' freshness follows the exchange's
  calendar (`market.rs`), not the age of the last sync: a settled session's bar never changes, and an age-based ttl re-fetched every
  symbol on every run. Keep `plan` pure (`now` is an argument) and don't add a holiday list.
- `python/protrade/*.py` is embedded in the binary (`python/client_files.rs`, `FILES`); a test fails when a module is added to the
  folder and not listed. The package is standard library plus pandas, and must work on pandas 2 and 3. Script names refuse
  anything that could shadow a library (`scripts.rs`), because a script's folder is first on Python's import path.
- A broker symbol is stored and compared in its long form (`zerodha:NSE:HFCL`) but *shown* short (`HFCL`) — never render
  `symbol` or `splitSymbol(...).ticker` to the user; use `displayTicker`. A chart is given the short form (`chartSymbol`), so
  anything read back from Vela must go through `normalizeSymbol` before it is compared or stored, or a watchlist row, an
  alert and a chart will disagree about what they are looking at. `NSE:` is the one exchange hidden (both brokers read a bare
  ticker as NSE); don't hide another without giving the backends a way to find it from a bare ticker. See "How a symbol is
  shown" in `docs/ARCHITECTURE.md`.
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
  the Script Editor, Python and Data providers buttons (actions, not panels) — the tab bar no longer has them.
- **Yahoo Finance is not a data source, and shouldn't come back without the owner's say-so.** It was removed entirely: its
  provider, backend client and rate limiter, its terms/opt-in UI, and its `yahoo:` symbols. Symbols saved from it stay in
  users' watchlists, layouts and alerts but can't load: `isSupportedSymbol` (`lib/symbols.ts`) recognises them, and
  `withoutUnsupportedSymbols` moves a layout's tabs off them when it opens (nothing stored is rewritten). `store/retired.rs`
  purges its cache and settings once. A bare ticker now means Binance (`DEFAULT_PROVIDER`), which needs no account. Don't add
  a source that scrapes an unofficial endpoint, and don't leave `yahoo` in any provider list.
