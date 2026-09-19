# Contributing

Thanks for helping! This is a small, friendly project. The short version: open an issue for anything non-trivial
before writing a lot of code, keep pull requests focused, and make sure the checks below pass.

## Set up

Prerequisites are in the [README](README.md#build-from-source). Then:

```bash
npm install
npm run tauri:dev
```

## Before you open a pull request

```bash
npm run typecheck
npm test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

CI runs exactly these, on Linux, macOS and Windows.

## Guidelines

- **Test the logic that can be tested.** Parsers, request planning, resampling and the SQLite store are pure and have
  unit tests — new behaviour there should come with tests. UI work is checked by running the app; say in the PR
  description what you tried.
- **Keep pure logic out of components and commands.** Put it in `src/lib/` or `src-tauri/src/{yahoo,store}/` where it can
  be tested without a window.
- **Match the surrounding code.** Comments explain *why*, not what. Prefer small functions and plain data over
  abstraction.
- **No new network calls without saying so.** This app talks only to the market-data sources listed in the README. A
  new one needs a note in the README's *Data sources* section and in the PR.
- **Dependencies.** Prefer what's already here. A new dependency needs a reason, and its licence has to be compatible
  with AGPL-3.0 distribution (add it to [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
- **Keep Vela's attribution intact.** See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

### App icon

The icon set in `src-tauri/icons/` is generated from [`assets/logo.svg`](assets/logo.svg):
`npx tauri icon assets/logo.svg` (then delete the `android/` and `ios/` folders it creates — this is a desktop app).

## Reporting bugs

Please include your OS, the app version (*About*), the symbol and timeframe involved, and — if it's a data problem —
whether the same symbol works on finance.yahoo.com. The app writes a log file that is very helpful to attach — Windows:
`%LOCALAPPDATA%\io.github.swapnilgitlab.candor\logs`, macOS: `~/Library/Logs/io.github.swapnilgitlab.candor`, Linux:
`~/.local/share/io.github.swapnilgitlab.candor/logs`. Remove anything private first.

Security issues: see [SECURITY.md](SECURITY.md) — please don't file those publicly.

## Licence

By contributing you agree that your contribution is licensed under the [GNU AGPL-3.0](LICENSE).
