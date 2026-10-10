//! The one-time move off disk for broker price history. Older versions kept it in three tables
//! (`bars_cache` for charts, `research_bars` and `research_coverage` for the Python API and the
//! five-year market-data store). Kite Connect's terms restrict permanent copies of its data, so
//! those bars now live only in memory (`store::bar_memory`) and the tables are dropped.

use rusqlite::{params, Connection};

use super::preferences;

const OLD_TABLES: [&str; 3] = ["bars_cache", "research_bars", "research_coverage"];

/// The old disk store's preferences. Its record of past downloads means nothing once the bars are
/// gone; whether the user wanted the market at hand carries over as "Keep the market loaded".
const OLD_PROVIDER: &str = "marketData.provider";
const OLD_AUTO: &str = "marketData.auto";
const OLD_RECORD: [&str; 3] = [
    "marketData.lastUpdate",
    "marketData.lastFailure",
    "marketData.lastError",
];

/// Drops the old bar tables if they are still there, and moves the old store's preferences over.
/// Returns whether anything was dropped, so the caller can compact the file.
pub fn drop_disk_bars(conn: &Connection) -> rusqlite::Result<bool> {
    let present: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN (?1, ?2, ?3)",
        params![OLD_TABLES[0], OLD_TABLES[1], OLD_TABLES[2]],
        |r| r.get(0),
    )?;
    if present == 0 {
        return Ok(false);
    }
    let downloaded = preferences::get(conn, OLD_PROVIDER)?.is_some();
    let auto_off = preferences::get(conn, OLD_AUTO)?.as_deref() == Some("false");
    if downloaded && !auto_off && preferences::get(conn, crate::marketdata::PREF_KEEP_LOADED)?.is_none() {
        preferences::set(conn, crate::marketdata::PREF_KEEP_LOADED, "true")?;
    }
    let tx = conn.unchecked_transaction()?;
    for table in OLD_TABLES {
        tx.execute_batch(&format!("DROP TABLE IF EXISTS {table};"))?;
    }
    for key in [OLD_PROVIDER, OLD_AUTO].into_iter().chain(OLD_RECORD) {
        preferences::delete(&tx, key)?;
    }
    tx.commit()?;
    Ok(true)
}

/// The old tables, as an older version created them: for tests of the move.
#[cfg(test)]
pub const OLD_TABLES_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS bars_cache (
  symbol TEXT NOT NULL, interval TEXT NOT NULL, ts INTEGER NOT NULL,
  open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL,
  PRIMARY KEY (symbol, interval, ts)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS research_bars (
  symbol TEXT NOT NULL, interval TEXT NOT NULL, ts INTEGER NOT NULL,
  open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL,
  PRIMARY KEY (symbol, interval, ts)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS research_coverage (
  symbol TEXT NOT NULL, interval TEXT NOT NULL, from_ts INTEGER NOT NULL, to_ts INTEGER NOT NULL,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (symbol, interval)
) WITHOUT ROWID;
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::store::market_symbols::{self, Listed};

    fn tables(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('bars_cache', 'research_bars', 'research_coverage')",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn the_old_tables_go_once_and_the_users_own_data_stays() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        assert!(!drop_disk_bars(&conn).unwrap(), "a new database has nothing to drop");

        conn.execute_batch(OLD_TABLES_SQL).unwrap();
        conn.execute(
            "INSERT INTO research_bars VALUES ('zerodha:NSE:A', 'D', 1, 1, 1, 1, 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO datasets (ticker, description, base_tf) VALUES ('MINE', NULL, '1D')",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO dataset_bars VALUES ('MINE', 1, 1, 1, 1, 1, 1)", [])
            .unwrap();
        let listed = Listed {
            symbol: "zerodha:NSE:A".into(),
            kind: "EQ".into(),
            name: None,
        };
        market_symbols::record_listing(&mut conn, &[listed], 1).unwrap();

        assert!(drop_disk_bars(&conn).unwrap());
        assert_eq!(tables(&conn), 0);
        let dataset_bars: i64 = conn
            .query_row("SELECT COUNT(*) FROM dataset_bars", [], |r| r.get(0))
            .unwrap();
        assert_eq!(dataset_bars, 1, "imported data is the user's own, and stays");
        assert_eq!(
            market_symbols::list(&conn).unwrap().len(),
            1,
            "a list of names, not prices"
        );
        assert!(!drop_disk_bars(&conn).unwrap(), "and only once");
    }

    #[test]
    fn a_user_who_had_downloaded_the_market_keeps_it_loaded_and_the_old_record_goes() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        conn.execute_batch(OLD_TABLES_SQL).unwrap();
        preferences::set(&conn, OLD_PROVIDER, "zerodha").unwrap();
        preferences::set(&conn, "marketData.lastUpdate", "123").unwrap();
        drop_disk_bars(&conn).unwrap();
        assert_eq!(
            preferences::get(&conn, crate::marketdata::PREF_KEEP_LOADED)
                .unwrap()
                .as_deref(),
            Some("true")
        );
        assert_eq!(preferences::get(&conn, OLD_PROVIDER).unwrap(), None);
        assert_eq!(preferences::get(&conn, "marketData.lastUpdate").unwrap(), None);
    }

    #[test]
    fn a_user_who_never_downloaded_or_turned_the_update_off_is_not_opted_in() {
        for (provider, auto) in [(None, None), (Some("zerodha"), Some("false"))] {
            let db = Database::open_in_memory().unwrap();
            let conn = db.conn.lock().unwrap();
            conn.execute_batch(OLD_TABLES_SQL).unwrap();
            if let Some(p) = provider {
                preferences::set(&conn, OLD_PROVIDER, p).unwrap();
            }
            if let Some(a) = auto {
                preferences::set(&conn, OLD_AUTO, a).unwrap();
            }
            drop_disk_bars(&conn).unwrap();
            assert_eq!(
                preferences::get(&conn, crate::marketdata::PREF_KEEP_LOADED).unwrap(),
                None
            );
            assert_eq!(preferences::get(&conn, OLD_AUTO).unwrap(), None);
        }
    }
}
