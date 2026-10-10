# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Use GitHub's
[private vulnerability reporting](../../security/advisories/new) on this repository (Security → *Report a
vulnerability*). Include what you found, how to reproduce it, and the app version.

You'll get an acknowledgement as soon as a maintainer sees it, and we'll keep you updated until it's fixed. This is a
volunteer project, so please allow some time.

## What the app does and doesn't do

- It has **no accounts, no telemetry and no server of its own.** Nothing you do is sent anywhere except the market-data
  requests needed to draw charts — and those go only to Zerodha, only if you connect your own account: the symbol
  you're looking at, and what you type into the search box. The app loads no images, fonts or scripts from the
  internet. The one other request is the **update check**: about once a day (and when you press
  *Check for updates*) the app asks GitHub for the latest release's manifest, which reveals your IP address to GitHub like
  any download. You can switch it off in *About → Updates*.
- **Updates are signed.** An update is only installed if it verifies against a public key built into the app
  (`plugins.updater.pubkey` in `tauri.conf.json`); the matching private key is held by the maintainer and used only by the
  release workflow. This is separate from the operating-system code signing described below.
- **Broker credentials** (such as a Zerodha access token) are stored in your operating system's credential store — Windows
  Credential Manager, the macOS Keychain, or the Linux Secret Service — and are used only by the app's Rust backend; the web
  view never receives them and the settings screen cannot read them back. If no credential store is available the value is
  kept in the app's database **unencrypted**, and the app says so. Access tokens are short-lived (Zerodha's last until about 6 AM the next
  morning), but treat one like a password: anyone holding it can read your account's market data. Zerodha's API secret is only
  used on this computer, to sign the login; it is never sent anywhere.
- Your layouts, watchlists and imported data are stored **unencrypted** in a SQLite file in your user
  profile (the *About* dialog shows the path). Treat it like any other document of yours.
- The web view runs with a restrictive Content-Security-Policy and only the Tauri permissions it uses; see
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#security-model).

## Verifying a download

Release builds are produced by the public [release workflow](.github/workflows/release.yml) from a tagged commit, and
are **not code-signed**, so Windows SmartScreen and macOS Gatekeeper will warn on first launch. If you'd rather not
trust a prebuilt binary, [build from source](README.md#build-from-source) — the result is the same app.

### Checking a download against its checksum

Every release has a **`SHA256SUMS`** file next to the installers. It lists each file's SHA-256 hash, one per line
(`<hash>  <file name>`). A download that matches its line is byte-for-byte the file that was published — not cut short by a
dropped connection, and not altered on the way. Compare yours:

- **Windows** (PowerShell), in the folder you downloaded to:

  ```powershell
  (Get-FileHash .\ProTradeChart_0.2.0_x64-setup.exe -Algorithm SHA256).Hash
  ```

  Then check that it equals the hash on that file's line in `SHA256SUMS` (upper or lower case doesn't matter).
- **macOS**, with `SHA256SUMS` in the same folder as the download:

  ```sh
  grep ' ProTradeChart_0.2.0_aarch64.dmg$' SHA256SUMS | shasum -a 256 -c
  ```

- **Linux:**

  ```sh
  grep ' ProTradeChart_0.2.0_amd64.deb$' SHA256SUMS | sha256sum -c
  ```

Both Unix commands print `<file name>: OK` when it matches and `FAILED` when it doesn't; if it fails, delete the file and download it
again. A checksum proves the file is the one that was published, **not that the publisher is who you think**: a copy of
`SHA256SUMS` served from the same place as the installers can't help if that place were compromised. Where the sums are
also published somewhere else (the project's website, say), compare both. Updates delivered by the app itself are checked
against a signing key built into it, and don't need this.

## Supported versions

Only the latest release receives fixes.
