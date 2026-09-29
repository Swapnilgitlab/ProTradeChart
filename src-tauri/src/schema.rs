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

-- `position` orders a list's rows, and is shared with `watchlist_sections`: the two tables together
-- are one sequence, so a section header sits wherever its position falls among the symbols.
-- `flag` is one of the colour names in `store::watchlists::FLAGS`. Databases made before these two
-- columns get them from `store::watchlists::migrate`.
CREATE TABLE IF NOT EXISTS watchlist_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  watchlist_id  INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  symbol        TEXT NOT NULL,
  name          TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  flag          TEXT,
  UNIQUE (watchlist_id, symbol)
);
CREATE INDEX IF NOT EXISTS idx_watchlist_items_list ON watchlist_items(watchlist_id);

-- A heading inside a watchlist ("Indices", "Banks"). It owns the symbols that follow it, up to the next
-- heading; `collapsed` hides them.
CREATE TABLE IF NOT EXISTS watchlist_sections (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  watchlist_id  INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  position      INTEGER NOT NULL DEFAULT 0,
  collapsed     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_watchlist_sections_list ON watchlist_sections(watchlist_id);

-- Read-through cache of the brokers' bars (keys start `dhan:` / `zerodha:`), used only as an
-- offline fallback.
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

-- Bars kept for the Python research API (`store/research_bars.rs`). Unlike `bars_cache`
-- this is a store, not a fallback: it is never pruned, and `research_coverage` records
-- which span of each series is complete (an empty holiday and an unfetched day look
-- the same in the bars table).
CREATE TABLE IF NOT EXISTS research_bars (
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

CREATE TABLE IF NOT EXISTS research_coverage (
  symbol     TEXT NOT NULL,
  interval   TEXT NOT NULL,
  from_ts    INTEGER NOT NULL,
  to_ts      INTEGER NOT NULL,
  synced_at  INTEGER NOT NULL,
  PRIMARY KEY (symbol, interval)
) WITHOUT ROWID;

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

-- Saved Studies. `spec_json` is the Study Specification, owned by the frontend
-- (`src/studies/spec.ts`) and the Python engine (`protrade/study.py`): opaque to Rust.
CREATE TABLE IF NOT EXISTS studies (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  spec_json   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Completed Study runs, so a result reopens without running again. `study_id` is not a
-- foreign key: a Study that was never saved still keeps its runs. `result_json` holds
-- everything the run produced (its spec, metadata, events and statistics) and
-- `summary_json` the few figures a list shows; both are opaque to Rust.
CREATE TABLE IF NOT EXISTS study_results (
  id            TEXT PRIMARY KEY,
  study_id      TEXT NOT NULL,
  name          TEXT NOT NULL,
  summary_json  TEXT NOT NULL,
  result_json   TEXT NOT NULL,
  executed_at   TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_study_results_study ON study_results(study_id, executed_at);

-- Saved screens (the Screener tab). `spec_json` is owned by the frontend (`src/screener/spec.ts`)
-- and the Python engine (`protrade/screen.py`); `result_json` is the screen's last run, kept so it
-- reopens without running again (NULL until it has run). Both are opaque to Rust.
CREATE TABLE IF NOT EXISTS screeners (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  spec_json    TEXT NOT NULL,
  result_json  TEXT,
  ran_at       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Python scripts the user scheduled to run by themselves (`scheduler/`). `rule_json` is a `scheduler::plan::Rule`;
-- `next_run_at` (epoch ms) is when it next fires, NULL while it is switched off.
CREATE TABLE IF NOT EXISTS script_schedules (
  id           TEXT PRIMARY KEY,
  script       TEXT NOT NULL,
  rule_json    TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  next_run_at  INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What happened each time a schedule came due: a run (with the tail of its output), or a run missed
-- while the app was closed, or skipped because the last one was still going. The newest few are kept.
CREATE TABLE IF NOT EXISTS schedule_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id  TEXT NOT NULL REFERENCES script_schedules(id) ON DELETE CASCADE,
  run_id       TEXT,
  status       TEXT NOT NULL,
  due_at       INTEGER NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER,
  message      TEXT NOT NULL DEFAULT '',
  output       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule ON schedule_runs(schedule_id, id);

-- Colour flags, one per symbol (`store/watchlists.rs`): a flagged symbol shows its flag on every watchlist, and each
-- colour's list is the symbols flagged with it, newest first. (Flags used to live on `watchlist_items.flag`;
-- `watchlists::migrate` carries them over once.)
CREATE TABLE IF NOT EXISTS symbol_flags (
  symbol      TEXT PRIMARY KEY,
  flag        TEXT NOT NULL,
  flagged_at  INTEGER NOT NULL
);

-- Drawings, per symbol (`store/symbol_drawings.rs`): Vela's drawings document, opaque to Rust. Every chart of
-- the symbol shows them. An empty document means "all removed", which is not the same as no row.
CREATE TABLE IF NOT EXISTS symbol_drawings (
  symbol      TEXT PRIMARY KEY,
  doc_json    TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Research Notebooks: named collections of Studies and results with the user's notes. Items refer to a
-- Study or a run by id; one whose target has gone is still listed (as no longer available).
-- `position` is numbered from 1.
CREATE TABLE IF NOT EXISTS notebooks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notebook_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  notebook_id  TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('study', 'result')),
  ref_id       TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  position     INTEGER NOT NULL,
  UNIQUE (notebook_id, kind, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_notebook_items_ref ON notebook_items(kind, ref_id);
"#;
