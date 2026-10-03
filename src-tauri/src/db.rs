use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use crate::schema::SCHEMA_SQL;

const FILE: &str = "charting.db";
/// How long a write waits for another connection's transaction before failing. The research
/// connections commit one symbol at a time, so a wait is a few milliseconds.
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
        crate::store::bars_cache::prune_intraday(&conn, now_ms())?;
        Ok(Database { conn: Mutex::new(conn) })
    }
}

fn path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE)
}

/// The research store's own connections to the same file, so a bulk download or a whole-market
/// read never waits on (or holds up) the UI's [`Database`] lock. WAL lets `read` run alongside a
/// write; `write` takes SQLite's write lock one symbol at a time.
pub struct ResearchDb {
    pub write: Database,
    pub read: Database,
}

impl ResearchDb {
    /// Opens after [`Database::open`], which created the schema.
    pub fn open(data_dir: &Path) -> rusqlite::Result<Self> {
        let file = path(data_dir);
        Ok(ResearchDb {
            write: extra_connection(Connection::open(&file)?, false)?,
            read: extra_connection(Connection::open(&file)?, true)?,
        })
    }

    /// Two connections to one private in-memory database, for tests.
    #[cfg(test)]
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let uri = format!(
            "file:research-{}?mode=memory&cache=shared",
            NEXT.fetch_add(1, Ordering::SeqCst)
        );
        use rusqlite::OpenFlags;
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_URI;
        let write = Connection::open_with_flags(&uri, flags)?;
        write.execute_batch(SCHEMA_SQL)?;
        Ok(ResearchDb {
            write: extra_connection(write, false)?,
            read: extra_connection(Connection::open_with_flags(&uri, flags)?, true)?,
        })
    }
}

fn extra_connection(conn: Connection, read_only: bool) -> rusqlite::Result<Database> {
    conn.busy_timeout(BUSY_TIMEOUT)?;
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;")?;
    if read_only {
        conn.execute_batch("PRAGMA query_only = ON;")?;
    }
    Ok(Database { conn: Mutex::new(conn) })
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
    fn the_research_connections_share_one_store_and_the_reader_cannot_write() {
        let research = ResearchDb::open_in_memory().unwrap();
        research
            .write
            .conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO research_coverage (symbol, interval, from_ts, to_ts, synced_at) VALUES ('a', 'D', 1, 2, 3)",
                [],
            )
            .unwrap();
        let reader = research.read.conn.lock().unwrap();
        let n: i64 = reader
            .query_row("SELECT COUNT(*) FROM research_coverage", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        assert!(reader.execute("DELETE FROM research_coverage", []).is_err());
    }

    #[test]
    fn a_file_store_opens_its_research_connections_alongside_the_ui_one() {
        let dir = std::env::temp_dir().join(format!("protrade-db-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let ui = Database::open(&dir).unwrap();
        let research = ResearchDb::open(&dir).unwrap();
        // A write held open on the research side doesn't stop the UI from reading.
        let mut writer = research.write.conn.lock().unwrap();
        let tx = writer.transaction().unwrap();
        tx.execute(
            "INSERT INTO research_coverage (symbol, interval, from_ts, to_ts, synced_at) VALUES ('a', 'D', 1, 2, 3)",
            [],
        )
        .unwrap();
        let seen: i64 = ui
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM research_coverage", [], |r| r.get(0))
            .unwrap();
        assert_eq!(seen, 0, "the UI reads the last committed state");
        tx.commit().unwrap();
        drop(writer);
        drop(research);
        drop(ui);
        let _ = fs::remove_dir_all(&dir);
    }
}
