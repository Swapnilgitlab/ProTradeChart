# Third-party notices

Candor is licensed under the GNU Affero General Public License
v3.0 (see [LICENSE](LICENSE)). It is built on the open-source components below.
Their licences apply to them, not to this project's own code. All of them are
compatible with distribution under the AGPL-3.0.

## Vela — charting engine (Apache-2.0, attribution required)

Every chart in this app is drawn by **Vela™**, a charting library by LuxAlgo.

```
Vela
Copyright (c) 2026 LuxAlgo
https://luxalgo.com/vela

This product includes the Vela charting library, developed by LuxAlgo.

ATTRIBUTION REQUIREMENT

Any product, website, or application that displays charts rendered by this
software must show a visible attribution to the Vela project on every page or
screen where such a chart is displayed.

The library satisfies this requirement automatically: it renders an attribution
mark (the project logomark linking to the Vela project page) on the chart
itself, enabled by default. You may restyle or reposition this mark to fit your
design.

You may disable the built-in mark (renderer feature `attribution`) ONLY if you
display an equivalent visible attribution — the name "Vela" together with a
link to the project page above — elsewhere on the same page or screen, in a
place available to your users.

Removing, hiding, or obscuring the attribution without providing the
equivalent notice described above is not permitted.

This file constitutes the NOTICE file described in Section 4(d) of the Apache
License, Version 2.0: redistributions of this software, in source or binary
form, must include a readable copy of these attribution notices.
```

Vela is licensed under the Apache License, Version 2.0
(<https://www.apache.org/licenses/LICENSE-2.0>).

**This app keeps Vela's built-in attribution mark enabled** (the logomark in the
bottom-left of each chart), and credits Vela in *About*. If you fork this
project, please leave both in place.

## Pine Script support — PineTS and Vela PineTS (AGPL-3.0)

Pine Script indicators and strategies run on **PineTS**, a Pine Script runtime, through **Vela PineTS**
(`@luxalgo/vela-pinets`), the adapter that connects PineTS to Vela. Both are by LuxAlgo and are licensed under the
GNU Affero General Public License v3.0. They are the reason this app is AGPL-3.0 rather than MIT.

- PineTS: built by LuxAlgo. Copyright (C) 2026-present LuxAlgo. <https://github.com/LuxAlgo/PineTS>
- Vela PineTS: <https://www.npmjs.com/package/@luxalgo/vela-pinets>

PineTS is an independently developed open source runtime. LuxAlgo Global, LLC and the PineTS project are not affiliated
with, sponsored by, endorsed by, or in any way officially associated with TradingView, Inc. "Pine Script®" and
"TradingView®" are registered trademarks of TradingView, Inc.; this app is not affiliated with TradingView either.

## Runtime dependencies

| Component | Licence | Used for |
| --- | --- | --- |
| [Tauri](https://tauri.app) 2 and its plugins | MIT OR Apache-2.0 | Desktop shell, native dialogs, logging, notifications |
| [React](https://react.dev) 19 | MIT | User interface |
| [lucide-react](https://lucide.dev) | ISC | Icons |
| [CodeMirror](https://codemirror.net) 6 (`@codemirror/*`, `@lezer/highlight`) | MIT | The Pine script editor |
| [PineTS](https://github.com/LuxAlgo/PineTS), [Vela PineTS](https://www.npmjs.com/package/@luxalgo/vela-pinets) | AGPL-3.0-only | Running Pine Script indicators and strategies (see above) |
| [rusqlite](https://github.com/rusqlite/rusqlite) (bundles SQLite) | MIT (SQLite is public domain) | Local database |
| [reqwest](https://github.com/seanmonstar/reqwest) | MIT OR Apache-2.0 | HTTP client for market data |
| [serde](https://serde.rs), [futures](https://github.com/rust-lang/futures-rs) | MIT OR Apache-2.0 | Serialization, async utilities |
| [tokio](https://tokio.rs), [tokio-tungstenite](https://github.com/snapview/tokio-tungstenite) | MIT | Async runtime, the Dhan and Zerodha live-feed WebSockets |
| [keyring](https://github.com/hwchen/keyring-rs) | MIT OR Apache-2.0 | Access to the operating system's credential store |
| [sha2](https://github.com/RustCrypto/hashes) | MIT OR Apache-2.0 | Signing Zerodha's login (a SHA-256 checksum, computed locally) |
| [csv](https://github.com/BurntSushi/rust-csv), [base64](https://github.com/marshallpierce/rust-base64) | MIT OR Unlicense, MIT OR Apache-2.0 | Parsing the brokers' instrument lists, reading token expiry |

## Build and test tooling

Vite, Vitest, TypeScript and `@vitejs/plugin-react` (all MIT or Apache-2.0)
are used to build and test the project and are not distributed in the app.

## Market data

Price data is fetched at runtime from third-party services — Yahoo Finance,
Binance, Coinbase and Hyperliquid, and Dhan (using the user's own account and
credentials, only if they connect it). No data from those services is
bundled with the app, and their terms of use apply to how you use it. See the
data-source notes in the [README](README.md#data-sources).

The exact versions of every dependency are pinned in `package-lock.json` and
`src-tauri/Cargo.lock`.
