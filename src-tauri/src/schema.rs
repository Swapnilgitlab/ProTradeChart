//! SQLite schema. Every statement is idempotent (`IF NOT EXISTS`) and runs on
//! each launch. `CREATE TABLE IF NOT EXISTS` is a no-op against a table that
//! already exists on disk, so a column added to an existing table later needs
//! its own guarded `ALTER TABLE` step in `Database::init`.

pub const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS ui_preferences (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Named chart sessions: one row is the whole session (every open tab's symbol
-- plus its full Vela state). `state_json` is opaque to Rust.
CREATE TABLE IF NOT EXISTS chart_layouts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  state_json  TEXT NOT NULL,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The user's Pine Script library. `source` is the script's own text; `kind` is
-- what its indicator()/strategy() declaration says, kept so the list can show it.
CREATE TABLE IF NOT EXISTS pine_scripts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('indicator', 'strategy')),
  source      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS watchlists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS watchlist_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  watchlist_id  INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  symbol        TEXT NOT NULL,
  name          TEXT,
  UNIQUE (watchlist_id, symbol)
);
CREATE INDEX IF NOT EXISTS idx_watchlist_items_list ON watchlist_items(watchlist_id);

-- Read-through cache of Yahoo Finance bars, used only as an offline fallback.
CREATE TABLE IF NOT EXISTS bars_cache (
  symbol    TEXT NOT NULL,
  interval  TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  open      REAL NOT NULL,
  high      REAL NOT NULL,
  low       REAL NOT NULL,
  close     REAL NOT NULL,
  volume    REAL,
  PRIMARY KEY (symbol, interval, ts)
) WITHOUT ROWID;

-- Per-symbol exchange timezone, remembered so offline bars from the cache are
-- still grouped into the right trading day.
CREATE TABLE IF NOT EXISTS symbol_meta (
  symbol      TEXT PRIMARY KEY,
  gmt_offset  INTEGER NOT NULL,
  timezone    TEXT
);

-- User-imported OHLCV datasets (CSV), chartable as `csv:<TICKER>`.
CREATE TABLE IF NOT EXISTS datasets (
  ticker       TEXT PRIMARY KEY,
  description  TEXT,
  base_tf      TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dataset_bars (
  ticker  TEXT NOT NULL REFERENCES datasets(ticker) ON DELETE CASCADE,
  ts      INTEGER NOT NULL,
  open    REAL NOT NULL,
  high    REAL NOT NULL,
  low     REAL NOT NULL,
  close   REAL NOT NULL,
  volume  REAL,
  PRIMARY KEY (ticker, ts)
) WITHOUT ROWID;

-- Per-provider settings: the `enabled` flag and non-secret configuration such
-- as a client id. Secrets never go here (see `secrets.rs`).
CREATE TABLE IF NOT EXISTS provider_settings (
  provider  TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (provider, key)
) WITHOUT ROWID;

-- Credentials, but ONLY when the operating system's credential store isn't
-- available (e.g. Linux without a Secret Service). Unencrypted; the UI says so.
CREATE TABLE IF NOT EXISTS provider_secrets_fallback (
  provider  TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (provider, key)
) WITHOUT ROWID;

-- Dhan's instrument master, trimmed to what can be charted (equities, indices,
-- futures). `ticker` is the chart symbol without its provider, e.g. NSE:RELIANCE.
CREATE TABLE IF NOT EXISTS dhan_instruments (
  ticker       TEXT PRIMARY KEY,
  exchange     TEXT NOT NULL,
  segment      INTEGER NOT NULL,
  security_id  INTEGER NOT NULL,
  instrument   TEXT NOT NULL,
  symbol       TEXT NOT NULL,
  name         TEXT,
  expiry       TEXT
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_dhan_instruments_id ON dhan_instruments(segment, security_id);

-- Zerodha's instrument master, trimmed the same way. `ticker` is the chart
-- symbol without its provider, e.g. NSE:RELIANCE or NSE:NIFTY_50; `symbol` is the
-- trading symbol as Kite spells it, which quote requests need.
CREATE TABLE IF NOT EXISTS zerodha_instruments (
  ticker       TEXT PRIMARY KEY,
  exchange     TEXT NOT NULL,
  token        INTEGER NOT NULL,
  instrument   TEXT NOT NULL,
  symbol       TEXT NOT NULL,
  name         TEXT,
  expiry       TEXT
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_zerodha_instruments_token ON zerodha_instruments(token);

-- Price alerts. The frontend's alert engine decides when one fires; this is
-- just the memory of what to watch and what already has.
CREATE TABLE IF NOT EXISTS price_alerts (
  id            TEXT PRIMARY KEY,
  symbol        TEXT NOT NULL,
  condition     TEXT NOT NULL,
  price         REAL NOT NULL,
  base_price    REAL,
  message       TEXT NOT NULL DEFAULT '',
  mode          TEXT NOT NULL,
  status        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  triggered_at  INTEGER,
  trigger_price REAL,
  trigger_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_price_alerts_status ON price_alerts(status);
"#;
