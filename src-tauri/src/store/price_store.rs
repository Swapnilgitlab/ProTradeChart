//! The SQL of the saved-prices file (`prices.db`, opened by `crate::prices`): the brokers' bars,
//! keyed by their neutral symbols whichever broker supplied them, written only when the user has
//! switched on "Save prices on this computer". Each series records which brokers supplied it.
//!
//! The file follows memory (`store::bar_memory`), which makes every change first and sends it
//! here as a [`DiskOp`]; [`apply`] is the whole of what can happen to the file. A series' bars and
//! its coverage are always written in one transaction, so the coverage never claims bars the file
//! doesn't have. Nothing here knows about time or threads.

use rusqlite::{params, Connection, OptionalExtension};

use super::bar_memory::{DiskOp, SavedSeries};
use super::research_bars::Coverage;
use crate::models::Bar;

/// Raised when the file's layout changes; an older one is refused rather than misread.
pub const SCHEMA_VERSION: &str = "2";

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- One row per series: its coverage (the span whose bars are complete), how many bars it has, and
-- which brokers supplied them (`sources`, a set of `Broker::bit`s).
CREATE TABLE IF NOT EXISTS price_series (
  id INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL,
  interval TEXT NOT NULL,
  covered_from INTEGER NOT NULL,
  covered_to INTEGER NOT NULL,
  synced_at INTEGER NOT NULL,
  last_used INTEGER NOT NULL,
  bars INTEGER NOT NULL,
  sources INTEGER NOT NULL,
  UNIQUE (symbol, interval)
);

CREATE TABLE IF NOT EXISTS price_bars (
  series INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL,
  PRIMARY KEY (series, ts)
) WITHOUT ROWID;
"#;

/// Lays the file out, or checks one that already is: it must be this layout.
pub fn init(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    let have: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = 'schema'", [], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    match have {
        None => {
            conn.execute("INSERT INTO meta (key, value) VALUES ('schema', ?1)", [SCHEMA_VERSION])
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        Some(have) if have == SCHEMA_VERSION => Ok(()),
        Some(have) => Err(format!("the file's layout is version {have}, not {SCHEMA_VERSION}")),
    }
}

/// Every series the file holds, without their bars.
pub fn index(conn: &Connection) -> rusqlite::Result<Vec<SavedSeries>> {
    let mut stmt = conn.prepare(
        "SELECT symbol, interval, covered_from, covered_to, synced_at, bars, last_used, sources FROM price_series",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(SavedSeries {
            symbol: r.get(0)?,
            interval: r.get(1)?,
            coverage: Coverage {
                from_ms: r.get(2)?,
                to_ms: r.get(3)?,
                synced_at: r.get(4)?,
            },
            count: r.get::<_, i64>(5)?.max(0) as usize,
            last_used_ms: r.get(6)?,
            sources: r.get::<_, i64>(7)?.clamp(0, 255) as u8,
        })
    })?;
    rows.collect()
}

/// One series' bars, oldest first (none for a series the file doesn't have).
pub fn load_bars(conn: &Connection, symbol: &str, interval: &str) -> rusqlite::Result<Vec<Bar>> {
    let mut stmt = conn.prepare_cached(
        "SELECT b.ts, b.open, b.high, b.low, b.close, b.volume
         FROM price_bars b JOIN price_series s ON s.id = b.series
         WHERE s.symbol = ?1 AND s.interval = ?2
         ORDER BY b.ts",
    )?;
    let rows = stmt.query_map(params![symbol, interval], |r| {
        Ok(Bar {
            time: r.get(0)?,
            open: r.get(1)?,
            high: r.get(2)?,
            low: r.get(3)?,
            close: r.get(4)?,
            volume: r.get(5)?,
        })
    })?;
    rows.collect()
}

fn upsert_series(
    conn: &Connection,
    symbol: &str,
    interval: &str,
    coverage: &Coverage,
    count: usize,
    used_ms: i64,
    sources: u8,
) -> rusqlite::Result<i64> {
    conn.prepare_cached(
        "INSERT INTO price_series (symbol, interval, covered_from, covered_to, synced_at, last_used, bars, sources)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (symbol, interval) DO UPDATE SET
           covered_from = excluded.covered_from, covered_to = excluded.covered_to,
           synced_at = excluded.synced_at, last_used = excluded.last_used, bars = excluded.bars,
           sources = excluded.sources
         RETURNING id",
    )?
    .query_row(
        params![
            symbol,
            interval,
            coverage.from_ms,
            coverage.to_ms,
            coverage.synced_at,
            used_ms,
            count as i64,
            sources
        ],
        |r| r.get(0),
    )
}

fn insert_bars(conn: &Connection, series: i64, bars: &[Bar]) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare_cached(
        "INSERT OR REPLACE INTO price_bars (series, ts, open, high, low, close, volume)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;
    for b in bars {
        stmt.execute(params![series, b.time, b.open, b.high, b.low, b.close, b.volume])?;
    }
    Ok(())
}

/// Makes one change. Call it inside a transaction: a series' bars and coverage go together.
pub fn apply(conn: &Connection, op: &DiskOp) -> rusqlite::Result<()> {
    match op {
        DiskOp::Put {
            symbol,
            interval,
            bars,
            coverage,
            clip,
            count,
            used_ms,
            sources,
        } => {
            let id = upsert_series(conn, symbol, interval, coverage, *count, *used_ms, *sources)?;
            if *clip {
                conn.prepare_cached("DELETE FROM price_bars WHERE series = ?1 AND (ts < ?2 OR ts > ?3)")?
                    .execute(params![id, coverage.from_ms, coverage.to_ms])?;
            }
            insert_bars(conn, id, bars)
        }
        DiskOp::Replace {
            symbol,
            interval,
            bars,
            coverage,
            used_ms,
            sources,
        } => {
            let id = upsert_series(conn, symbol, interval, coverage, bars.len(), *used_ms, *sources)?;
            conn.prepare_cached("DELETE FROM price_bars WHERE series = ?1")?
                .execute([id])?;
            insert_bars(conn, id, bars)
        }
        DiskOp::Delete { symbol, interval } => {
            conn.prepare_cached(
                "DELETE FROM price_bars WHERE series = (SELECT id FROM price_series WHERE symbol = ?1 AND interval = ?2)",
            )?
            .execute(params![symbol, interval])?;
            conn.prepare_cached("DELETE FROM price_series WHERE symbol = ?1 AND interval = ?2")?
                .execute(params![symbol, interval])?;
            Ok(())
        }
        DiskOp::CarryDaily { before, now } => {
            conn.prepare_cached(
                "UPDATE price_series SET covered_to = MAX(covered_to, ?2), synced_at = ?2
                 WHERE interval = 'D' AND covered_to >= ?1",
            )?
            .execute(params![before, now])?;
            Ok(())
        }
        DiskOp::Touch {
            symbol,
            interval,
            used_ms,
        } => {
            conn.prepare_cached("UPDATE price_series SET last_used = ?3 WHERE symbol = ?1 AND interval = ?2")?
                .execute(params![symbol, interval, used_ms])?;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::bar_memory::tests::bar;

    fn file() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        conn
    }

    fn cov(from_ms: i64, to_ms: i64, synced_at: i64) -> Coverage {
        Coverage {
            from_ms,
            to_ms,
            synced_at,
        }
    }

    fn put(symbol: &str, bars: Vec<Bar>, coverage: Coverage, clip: bool, count: usize) -> DiskOp {
        DiskOp::Put {
            symbol: symbol.to_string(),
            interval: "D".to_string(),
            bars,
            coverage,
            clip,
            count,
            used_ms: 7,
            sources: 1,
        }
    }

    fn times(conn: &Connection, symbol: &str) -> Vec<i64> {
        load_bars(conn, symbol, "D").unwrap().iter().map(|b| b.time).collect()
    }

    #[test]
    fn a_file_is_laid_out_once_and_refuses_another_layout() {
        let conn = file();
        init(&conn).unwrap();
        conn.execute("UPDATE meta SET value = '1' WHERE key = 'schema'", [])
            .unwrap();
        assert!(init(&conn).unwrap_err().contains("version 1"));
    }

    #[test]
    fn puts_add_bars_record_coverage_and_show_in_the_index() {
        let conn = file();
        apply(&conn, &put("A", vec![bar(1, 1.0), bar(2, 2.0)], cov(0, 2, 5), false, 2)).unwrap();
        apply(
            &conn,
            &put("A", vec![bar(2, 20.0), bar(3, 3.0)], cov(0, 3, 6), false, 3),
        )
        .unwrap();
        let bars = load_bars(&conn, "A", "D").unwrap();
        assert_eq!(
            bars.iter().map(|b| (b.time, b.close)).collect::<Vec<_>>(),
            [(1, 1.0), (2, 20.0), (3, 3.0)]
        );
        assert_eq!(
            index(&conn).unwrap(),
            [SavedSeries {
                symbol: "A".to_string(),
                interval: "D".to_string(),
                coverage: cov(0, 3, 6),
                count: 3,
                last_used_ms: 7,
                sources: 1,
            }]
        );
        assert!(load_bars(&conn, "A", "5").unwrap().is_empty());
    }

    #[test]
    fn a_clipped_put_drops_bars_outside_its_coverage() {
        let conn = file();
        apply(
            &conn,
            &put("A", vec![bar(1, 1.0), bar(5, 5.0), bar(9, 9.0)], cov(0, 9, 1), false, 3),
        )
        .unwrap();
        apply(&conn, &put("A", vec![], cov(4, 9, 1), true, 2)).unwrap();
        assert_eq!(times(&conn, "A"), [5, 9]);
    }

    #[test]
    fn replace_and_delete_touch_one_series_only() {
        let conn = file();
        apply(&conn, &put("A", vec![bar(1, 1.0), bar(2, 2.0)], cov(0, 2, 1), false, 2)).unwrap();
        apply(&conn, &put("B", vec![bar(1, 1.0)], cov(0, 1, 1), false, 1)).unwrap();
        apply(
            &conn,
            &DiskOp::Replace {
                symbol: "A".to_string(),
                interval: "D".to_string(),
                bars: vec![bar(2, 9.0)],
                coverage: cov(2, 2, 3),
                used_ms: 3,
                sources: 2,
            },
        )
        .unwrap();
        assert_eq!(times(&conn, "A"), [2]);
        assert_eq!(index(&conn).unwrap().iter().find(|s| s.symbol == "A").unwrap().count, 1);
        apply(
            &conn,
            &DiskOp::Delete {
                symbol: "A".to_string(),
                interval: "D".to_string(),
            },
        )
        .unwrap();
        assert!(times(&conn, "A").is_empty());
        assert_eq!(times(&conn, "B"), [1]);
        assert_eq!(index(&conn).unwrap().len(), 1);
    }

    #[test]
    fn a_holiday_carries_only_the_daily_series_that_were_current() {
        let conn = file();
        apply(&conn, &put("CURRENT", vec![], cov(0, 500, 1), false, 0)).unwrap();
        apply(&conn, &put("BEHIND", vec![], cov(0, 300, 1), false, 0)).unwrap();
        apply(&conn, &DiskOp::CarryDaily { before: 400, now: 900 }).unwrap();
        let idx = index(&conn).unwrap();
        let of = |s: &str| idx.iter().find(|e| e.symbol == s).unwrap().coverage;
        assert_eq!(of("CURRENT"), cov(0, 900, 900));
        assert_eq!(of("BEHIND"), cov(0, 300, 1));
    }

    #[test]
    fn a_missing_volume_is_kept_missing() {
        let conn = file();
        let mut b = bar(1, 1.0);
        b.volume = None;
        apply(&conn, &put("NIFTY", vec![b], cov(0, 1, 1), false, 1)).unwrap();
        assert_eq!(load_bars(&conn, "NIFTY", "D").unwrap()[0].volume, None);
    }
}
