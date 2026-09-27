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
- Not every tab is a chart: the Python and Studies workspaces are tabs too (`features/workspace/tabs.ts`). Anything outside the tab
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
  folder and not listed. A debug build writes the repository's copy instead (so Python changes need no rebuild under `tauri:dev`);
  a release build always writes the embedded one. The package is standard library plus pandas, and must work on pandas 2 and 3. Script names refuse
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
- **Yahoo Finance is not a data source, and shouldn't come back without the owner's say-so.** It was removed entirely: its
  provider, backend client and rate limiter, its terms/opt-in UI, and its `yahoo:` symbols. Symbols saved from it stay in
  users' watchlists, layouts and alerts but can't load: `isSupportedSymbol` (`lib/symbols.ts`) recognises them, and
  `withoutUnsupportedSymbols` moves a layout's tabs off them when it opens (nothing stored is rewritten). `store/retired.rs`
  purges its cache and settings once. A bare ticker now means Binance (`DEFAULT_PROVIDER`), which needs no account. Don't add
  a source that scrapes an unofficial endpoint, and don't leave `yahoo` in any provider list.
