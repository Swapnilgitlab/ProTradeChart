# Third-party notices

ProTradeChart is Copyright (C) 2026 Swapnil Pawar and the ProTradeChart
contributors, and is licensed under the GNU Affero General Public License v3.0
(see [LICENSE](LICENSE)). It is built on the open-source components below.
Their licences apply to them, not to this project's own code. All of them are
compatible with distribution under the AGPL-3.0.

This page summarises them. The copyright notice and full licence text of every
component compiled into the app — some 550 npm packages and Rust crates — are in
[THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt), which is installed with the
app and shown under *About → Third-party licences*. It is generated from the
lockfiles by `npm run licenses` (`scripts/third-party-licenses.mjs`), and rebuilt
by the release workflow before every build.

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
bottom-left of each chart), and credits Vela in *About*.

**This app ships a modified copy of Vela.** As section 4(b) of the Apache License asks, note that
ProTradeChart changes Vela's distributed files before bundling them: it shrinks the fixed top and
bottom padding of the price scale's autoscale, and extends its chart context menu and menu surface
with submenus, labels that name the chart's symbol, and checkbox items. The changes are exactly the
diff in `patches/@luxalgo+vela+<version>.patch` in this repository, applied by `patch-package` when
dependencies are installed. Vela's attribution mark is not affected by them.

**Additional term (AGPL-3.0, section 7(b)).** The attribution requirement above
applies to the Vela material in this app and in any modified version of it: keep
Vela's attribution mark, or the equivalent visible attribution Vela's notice
describes, wherever a chart is shown.

## Pine Script support — PineTS and Vela PineTS (AGPL-3.0)

Pine Script indicators and strategies run on **PineTS**, a Pine Script runtime, through **Vela PineTS**
(`@luxalgo/vela-pinets`), the adapter that connects PineTS to Vela. Both are by LuxAlgo and are licensed under the
GNU Affero General Public License v3.0. They are the reason this app is AGPL-3.0 rather than MIT.

- PineTS: built by LuxAlgo. Copyright (C) 2026-present LuxAlgo. <https://github.com/LuxAlgo/PineTS>
- Vela PineTS: <https://github.com/LuxAlgo/Vela-pinets> (npm: `@luxalgo/vela-pinets`)

**Their source.** Every ProTradeChart release on GitHub carries, next to its installers, the
source of PineTS, Vela PineTS and Vela at the exact versions it was built with
(`pinets-<version>-source.tar.gz`, `vela-pinets-<version>-source.tar.gz`,
`vela-<version>-source.tar.gz`), taken from the upstream `v<version>` tags. The versions
are the ones pinned in `package-lock.json`; the app's own source is the release's tag, which also
holds the patch the app applies to Vela (above).

PineTS is an independently developed open source runtime. LuxAlgo Global, LLC and the PineTS project are not affiliated
with, sponsored by, endorsed by, or in any way officially associated with TradingView, Inc. "Pine Script®" and
"TradingView®" are registered trademarks of TradingView, Inc.; this app is not affiliated with TradingView either.

## Runtime dependencies

| Component | Licence | Used for |
| --- | --- | --- |
| [Tauri](https://tauri.app) 2 and its plugins | MIT OR Apache-2.0 | Desktop shell, native dialogs, logging, notifications, updates |
| [React](https://react.dev) 19 | MIT | User interface |
| [lucide-react](https://lucide.dev) | ISC | Icons |
| [CodeMirror](https://codemirror.net) 6 (`@codemirror/*`, `@lezer/highlight`) | MIT | The Pine script editor |
| [PineTS](https://github.com/LuxAlgo/PineTS), [Vela PineTS](https://www.npmjs.com/package/@luxalgo/vela-pinets) | AGPL-3.0-only | Running Pine Script indicators and strategies (see above) |
| [rusqlite](https://github.com/rusqlite/rusqlite) (bundles SQLite) | MIT (SQLite is public domain) | Local database |
| [reqwest](https://github.com/seanmonstar/reqwest) | MIT OR Apache-2.0 | HTTP client for market data |
| [serde](https://serde.rs), [futures](https://github.com/rust-lang/futures-rs) | MIT OR Apache-2.0 | Serialization, async utilities |
| [tokio](https://tokio.rs), [tokio-tungstenite](https://github.com/snapview/tokio-tungstenite) | MIT | Async runtime, the Zerodha live-feed WebSocket |
| [keyring](https://github.com/hwchen/keyring-rs) | MIT OR Apache-2.0 | Access to the operating system's credential store |
| [sha2](https://github.com/RustCrypto/hashes) | MIT OR Apache-2.0 | Signing Zerodha's login (a SHA-256 checksum, computed locally) |
| [csv](https://github.com/BurntSushi/rust-csv) | MIT OR Unlicense | Parsing the broker's instrument list |
| Microsoft Edge WebView2 SDK loader (through `webview2-com-sys`) | BSD-style, Microsoft | Starting the system web view (Windows builds) |

Their own dependencies bring in many more (MIT, Apache-2.0, BSD, ISC, Zlib,
Unicode-3.0, MPL-2.0 and CDLA-Permissive-2.0 licences among them); all are listed,
with their licence texts, in [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt).

## Build and test tooling

Vite, Vitest, TypeScript and `@vitejs/plugin-react` (all MIT or Apache-2.0)
are used to build and test the project and are not distributed in the app.

## Market data

Price data is fetched at runtime, directly from the user's computer, from a
third-party service: Zerodha, with the user's own account and credentials,
only if they connect one. No market data is bundled with the app or passes
through any server of this project, and the service's terms apply to how its
data is used. See the data-source notes in the [README](README.md#data-sources).

Zerodha and Kite Connect are trademarks of their respective owners.
ProTradeChart is not affiliated with, endorsed by or sponsored by either of
them; their names are used only to say where data comes from.

The exact versions of every dependency are pinned in `package-lock.json` and
`src-tauri/Cargo.lock`.
