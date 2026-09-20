# Bundled Pine indicators

Every `.pine` file under [`indicators/`](indicators) is built into the app. Users see them in the chart's
**Indicators** dialog, and in the Pine Editor under **Open → Bundled with the app**. Nothing else is needed to ship a
script: the installer contains it once you build.

## Adding one

1. Create `pine/indicators/<Category>/<Name>.pine`. The folder name is the group the script appears under in the
   Indicators dialog (nest folders for `A / B`); a file directly in `indicators/` goes under "Pine scripts".
2. Write a normal Pine script, starting with `//@version=6` and an `indicator(...)` (or `strategy(...)`) call.
3. Run `npm run tauri:dev`. Saving a `.pine` file reloads the app, so you can edit in your own editor and watch the chart.
   You can also write and try scripts in the app's Pine Editor first, then paste the finished text into a file here.
4. Run `npm test`. It compiles and runs **every** bundled script on the real engine, so a script with a mistake fails the
   build instead of reaching users.

## Rules that keep saved layouts working

- **The declared title is the script's identity.** `indicator("My RSI")` is what saved layouts remember it by, so two
  files can't share a title, and renaming a title makes layouts that used the old name drop it. Rename deliberately.
- One script per file. `library()` scripts can't be added to a chart and are skipped.
- Keep scripts self-contained: no `request.security` to symbols you don't control, no network access.
- **Licence.** The app is AGPL-3.0, and bundled scripts ship as part of it. Write your own, or use code whose licence
  allows redistribution under the AGPL-3.0. Don't paste scripts from TradingView's public library or anyone else's
  without checking their licence (many are non-commercial or share-alike). Put your name and year in a header comment.
- Pine Script® and TradingView® are trademarks of TradingView, Inc. Call these "Pine Script-compatible", not "Pine Script
  indicators from TradingView".

Strategies work the same way (put them in a folder such as `indicators/Strategies/`); they appear in the same dialog.
