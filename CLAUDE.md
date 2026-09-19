# CLAUDE.md

Guidance for AI coding assistants (and humans) working in this repo. Start with [README.md](README.md) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What this is

Candor is an open-source (AGPL-3.0) Tauri 2 desktop charting app. React 19 + TypeScript frontend, Rust backend, charts by Vela
(`@luxalgo/vela`, Apache-2.0 — its attribution mark must stay visible), SQLite for storage.

## Commands

```bash
npm run tauri:dev                       # run the app with hot reload
npm run typecheck && npm test           # frontend checks
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Run all of the above before finishing a change. `npm run build` type-checks and bundles the frontend.

## Conventions

- A chart symbol is always `provider:TICKER` (`yahoo:AAPL`). Use the helpers in `src/lib/symbols.ts`; never split on `:`
  by hand.
- Pure logic lives in `src/lib/` (TypeScript) or `src-tauri/src/{yahoo.rs,store/}` (Rust) and has unit tests. Components
  and Tauri commands stay thin.
- All `invoke` calls go through `src/lib/ipc.ts`; its types mirror `src-tauri/src/models.rs` (camelCase over the wire).
- Data providers report failures with `notify()` from `src/data/events.ts` and return `[]` — they don't throw into Vela.
- Data providers are declared in `src-tauri/src/providers.rs` (the source of truth for settings) and registered in
  `src/data/providers/index.ts`. Broker credentials are secrets: they live in the OS keychain via `secrets.rs`, are read
  only in Rust, and must never be sent to the webview or logged. See "Adding a broker" in `docs/ARCHITECTURE.md`.
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
- Daily-and-up bars are stamped at local midnight of the exchange's date; intraday bars keep their real instant. Each new
  chart is switched to the machine's timezone so both display correctly.
- The Content-Security-Policy in `tauri.conf.json` is **not applied by the Vite dev server** — test CSP-sensitive changes
  in a release build (`npx tauri build --no-bundle`).
- Keep `writing` `﻿` and similar invisible characters as escape sequences, not literals.
- Pine Script runs on PineTS in a **Worker** (`pine/engine.ts`), which is why the CSP has `'unsafe-eval'` — never use the
  in-process `PineEngine`, and don't add other uses of `eval`. `installPineEngine`, `installPinePersistence` and
  `installPineHostActions` (`main.tsx`) must run before the first `VelaWorkspace`. See "Pine Script" in
  `docs/ARCHITECTURE.md`.
- On a Vela script handle, `title` is a placeholder until the script runs (use `declaredTitle(source)` or `run.title`),
  and `ready` fires once — after `updateCode`, wait for `script:run` with `cause: 'code'`. `propValues()` includes
  the defaults: persist `inputDeltas(...)`, never the raw values.
- Backtests are approximate (PineTS's broker emulator differs from TradingView's) and cover only the bars the chart has
  loaded. The app is AGPL-3.0 because it bundles PineTS: new dependencies must be compatible with that.
- Verify a new broker integration against the real service with fake credentials (real error bodies, real socket
  behaviour) before trusting the docs: Dhan's feed, for one, accepts the socket and drops it on a bad token.
- Zerodha (Kite Connect) tokens expire every morning and have no expiry field: the app estimates the reset (next 06:00 IST)
  from when the token was saved (`accessTokenSavedAt`). Kite's instrument lists are public (no login) and its bad-token
  errors are `{"status":"error","error_type":"TokenException"}`. `cargo test --lib zerodha::live -- --ignored` runs opt-in
  tests against the real service (no credentials needed) — run them when touching `zerodha/`.
- Price alerts fire from exactly one place: the engine in the `main` window (`alerts/engine.ts`). Don't start it elsewhere or
  alerts will ring once per window. A crossing is judged between two price samples, so anything that changes an alert's
  status (pause, re-arm, edit) must clear `basePrice` (or set it to the current price) so it doesn't fire over a move that
  happened while it was off.
- Yahoo Finance endpoints are unofficial and have no published limits. Every request must go through `Market::get_json`
  (which applies the `Gate` in `gate.rs`: pacing, a per-minute budget, and a pause after HTTP 429) — never call Yahoo
  from anywhere else. Batch (`spark` takes 20 symbols), cache, and share polls (`data/livePoll.ts`) rather than adding
  per-symbol or per-pane requests. See "Yahoo Finance and rate limits" in `docs/ARCHITECTURE.md`.
