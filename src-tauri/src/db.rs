use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use crate::schema::SCHEMA_SQL;
use crate::store::bar_tables;

const FILE: &str = "charting.db";
/// How long a statement waits for another connection's transaction before failing.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// The UI's shared SQLite connection. Commands are short and synchronous, so a
/// plain mutex is plenty — nothing holds it across an `.await`.
pub struct Database {
    pub conn: Mutex<Connection>,
}

impl Database {
    /// Opens (creating if needed) the database file inside `data_dir`.
    pub fn open(data_dir: &Path) -> rusqlite::Result<Self> {
        fs::create_dir_all(data_dir).map_err(|e| {
            rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CANTOPEN),
                Some(format!("cannot create data directory: {e}")),
            )
        })?;
        let conn = Connection::open(path(data_dir))?;
        // WAL keeps writes cheap and readers unblocked; it's a no-op on the
        // in-memory databases the tests use.
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")?;
        conn.busy_timeout(BUSY_TIMEOUT)?;
        Self::init(conn)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        conn.execute_batch(SCHEMA_SQL)?;
        // Columns added to a table that may already exist on disk (`CREATE TABLE IF NOT EXISTS` won't add them).
        crate::store::watchlists::migrate(&conn)?;
        // Broker price history is no longer kept on disk. Once, on the first launch after that
        // change, the old tables go and the file is compacted to hand their space back.
        if bar_tables::drop_disk_bars(&conn)? {
            conn.execute_batch("VACUUM;")?;
        }
        Ok(Database { conn: Mutex::new(conn) })
    }
}

fn path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opening_a_database_from_before_drops_its_bar_tables_and_shrinks_the_file() {
        let dir = std::env::temp_dir().join(format!("protrade-db-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        {
            // A database as an older version left it: a full research store, and the user's own data.
            let conn = Connection::open(path(&dir)).unwrap();
            conn.execute_batch(SCHEMA_SQL).unwrap();
            conn.execute_batch(bar_tables::OLD_TABLES_SQL).unwrap();
            let tx = conn.unchecked_transaction().unwrap();
            for i in 0..50_000i64 {
                tx.execute(
                    "INSERT INTO research_bars VALUES ('zerodha:NSE:X', 'D', ?1, 1, 1, 1, 1, 1)",
                    [i],
                )
                .unwrap();
            }
            tx.execute(
                "INSERT INTO datasets (ticker, description, base_tf) VALUES ('MINE', NULL, '1D')",
                [],
            )
            .unwrap();
            tx.commit().unwrap();
        }
        let before = fs::metadata(path(&dir)).unwrap().len();

        let db = Database::open(&dir).unwrap();
        let conn = db.conn.lock().unwrap();
        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('bars_cache', 'research_bars', 'research_coverage')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 0);
        let mine: i64 = conn
            .query_row("SELECT COUNT(*) FROM datasets", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mine, 1, "the user's imported data is kept");
        drop(conn);
        drop(db);
        assert!(
            fs::metadata(path(&dir)).unwrap().len() < before / 4,
            "the space was handed back"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
