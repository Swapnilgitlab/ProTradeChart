# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Use GitHub's
[private vulnerability reporting](../../security/advisories/new) on this repository (Security → *Report a
vulnerability*). Include what you found, how to reproduce it, and the app version.

You'll get an acknowledgement as soon as a maintainer sees it, and we'll keep you updated until it's fixed. This is a
volunteer project, so please allow some time.

## What the app does and doesn't do

- It has **no accounts, no telemetry and no server of its own.** Nothing you do is sent anywhere except the market-data
  requests needed to draw charts (Yahoo Finance, Binance, Coinbase, Hyperliquid, and — only if you connect them — Dhan and Zerodha):
  the symbol you're looking at, and what you type into the search box.
- **Broker credentials** (such as a Dhan access token) are stored in your operating system's credential store — Windows
  Credential Manager, the macOS Keychain, or the Linux Secret Service — and are used only by the app's Rust backend; the web
  view never receives them and the settings screen cannot read them back. If no credential store is available the value is
  kept in the app's database **unencrypted**, and the app says so. Access tokens are short-lived (Dhan's last 24 hours, Zerodha's until about 6 AM the next
  morning), but treat one like a password: anyone holding it can read your account's market data. Zerodha's API secret is only
  used on this computer, to sign the login; it is never sent anywhere.
- Your layouts, watchlists, imported data and a price cache are stored **unencrypted** in a SQLite file in your user
  profile (the *About* dialog shows the path). Treat it like any other document of yours.
- The web view runs with a restrictive Content-Security-Policy and only the Tauri permissions it uses; see
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#security-model).

## Verifying a download

Release builds are produced by the public [release workflow](.github/workflows/release.yml) from a tagged commit, and
are **not code-signed**, so Windows SmartScreen and macOS Gatekeeper will warn on first launch. If you'd rather not
trust a prebuilt binary, [build from source](README.md#build-from-source) — the result is the same app.

## Supported versions

Only the latest release receives fixes.
