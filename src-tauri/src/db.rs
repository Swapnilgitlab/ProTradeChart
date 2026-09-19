use rusqlite::Connection;
use std::fs;
use std::path::Path;
use std::sync::Mutex;

use crate::schema::SCHEMA_SQL;

/// The one shared SQLite connection. Commands are short and synchronous, so a
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
        let conn = Connection::open(data_dir.join("charting.db"))?;
        // WAL keeps writes cheap and readers unblocked; it's a no-op on the
        // in-memory databases the tests use.
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")?;
        Self::init(conn)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        conn.execute_batch(SCHEMA_SQL)?;
        crate::store::bars_cache::prune_intraday(&conn, now_ms())?;
        Ok(Database { conn: Mutex::new(conn) })
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
