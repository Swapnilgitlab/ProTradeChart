//! "Save prices on this computer": the file behind `store::bar_memory` (`prices.db`, beside the
//! app's database). Off unless the user switches it on; switching it off deletes it.
//!
//! A broker's terms restrict copies of its data, so this is the only place broker prices reach the
//! disk, and only through memory: [`BarMemory`] makes every change and queues it here, a writer
//! thread applies the queue in batched transactions (`store::price_store`), and memory reads a
//! series' bars back when it next needs them. The prices are broker-agnostic: a series is keyed by
//! its neutral symbol (`india:NSE:RELIANCE`) whichever broker supplied it, so one file serves
//! whichever broker is in use. Each series records which brokers supplied it, so one broker's
//! prices can still be deleted on their own.
//!
//! Never on the UI's `Database` connection: this is a separate file with its own connections, so a
//! whole market being written never holds up the window.

use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use crate::models::Bar;
use crate::store::bar_memory::{BarDisk, BarMemory, DiskOp, SavedSeries};
use crate::store::{preferences, price_store};
use crate::symbols::{Broker, INDIA};

/// Whether the user has switched saving on (`"true"`).
pub const PREF_SAVE: &str = "prices.saveOnDisk";

pub const FILE: &str = "prices.db";

/// How long the writer gathers changes before writing them in one transaction.
const BATCH_WINDOW: Duration = Duration::from_millis(200);
const BATCH_MAX: usize = 400;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// What a second copy of the app is told: the first one has the file.
pub const IN_USE: &str = "Another copy of ProTradeChart is using the saved prices, so this one keeps prices in \
                          memory only until it is closed.";

pub fn saving(conn: &Connection) -> bool {
    preferences::get(conn, PREF_SAVE).ok().flatten().as_deref() == Some("true")
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

enum Msg {
    Op(u64, DiskOp),
    #[cfg_attr(not(test), allow(dead_code))]
    Flush(Sender<()>),
}

/// The open file.
pub struct PriceFile {
    reader: Mutex<Option<Connection>>,
    tx: Mutex<Option<Sender<Msg>>>,
    sent: AtomicU64,
    written: Arc<AtomicU64>,
    failed: Arc<Mutex<Option<String>>>,
    writer: Mutex<Option<JoinHandle<()>>>,
    /// Held while the file is open, so a second copy of the app leaves it alone.
    held: Mutex<Option<File>>,
}

impl PriceFile {
    /// Opens (creating if needed) the file in `dir`, and reads its index.
    pub fn open(dir: &Path) -> Result<(Arc<PriceFile>, Vec<SavedSeries>), String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let path = dir.join(FILE);
        let held = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(lock_path(&path))
            .map_err(|e| e.to_string())?;
        match held.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => return Err(IN_USE.to_string()),
            Err(TryLockError::Error(e)) => return Err(e.to_string()),
        }

        let conn = Connection::open(&path).map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
            .map_err(|e| e.to_string())?;
        conn.busy_timeout(BUSY_TIMEOUT).map_err(|e| e.to_string())?;
        price_store::init(&conn)?;
        let index = price_store::index(&conn).map_err(|e| e.to_string())?;

        let reader = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| e.to_string())?;
        reader.busy_timeout(BUSY_TIMEOUT).map_err(|e| e.to_string())?;

        let (tx, rx) = mpsc::channel();
        let written = Arc::new(AtomicU64::new(0));
        let failed = Arc::new(Mutex::new(None));
        let writer = {
            let (written, failed) = (written.clone(), failed.clone());
            std::thread::Builder::new()
                .name("saved-prices".to_string())
                .spawn(move || write_loop(conn, rx, &written, &failed))
                .map_err(|e| e.to_string())?
        };
        let file = PriceFile {
            reader: Mutex::new(Some(reader)),
            tx: Mutex::new(Some(tx)),
            sent: AtomicU64::new(0),
            written,
            failed,
            writer: Mutex::new(Some(writer)),
            held: Mutex::new(Some(held)),
        };
        Ok((Arc::new(file), index))
    }

    /// Why writing stopped, if it did: memory then keeps what it holds, as if nothing were saved.
    pub fn failure(&self) -> Option<String> {
        lock(&self.failed).clone()
    }

    /// Waits (up to `wait`) until every change queued so far is in the file.
    #[cfg(test)]
    pub fn flush(&self, wait: Duration) -> bool {
        let (ack, done) = mpsc::channel();
        let queued = lock(&self.tx)
            .as_ref()
            .is_some_and(|tx| tx.send(Msg::Flush(ack)).is_ok());
        queued && done.recv_timeout(wait).is_ok()
    }

    /// Writes what is queued and lets the file go.
    pub fn close(&self) {
        drop(lock(&self.tx).take());
        if let Some(writer) = lock(&self.writer).take() {
            let _ = writer.join();
        }
        drop(lock(&self.reader).take());
        drop(lock(&self.held).take());
    }
}

impl Drop for PriceFile {
    fn drop(&mut self) {
        self.close();
    }
}

impl BarDisk for PriceFile {
    fn load(&self, symbol: &str, interval: &str) -> Result<Vec<Bar>, String> {
        let reader = lock(&self.reader);
        let conn = reader.as_ref().ok_or("the saved prices are closed")?;
        price_store::load_bars(conn, symbol, interval).map_err(|e| e.to_string())
    }

    fn send(&self, op: DiskOp) -> u64 {
        // Numbered and queued under one lock, so the numbers are the order the writer sees.
        let tx = lock(&self.tx);
        let seq = self.sent.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(tx) = tx.as_ref() {
            let _ = tx.send(Msg::Op(seq, op));
        }
        seq
    }

    fn written(&self) -> u64 {
        self.written.load(Ordering::SeqCst)
    }
}

fn lock_path(db: &Path) -> PathBuf {
    db.with_extension("lock")
}

fn write_loop(mut conn: Connection, rx: Receiver<Msg>, written: &AtomicU64, failed: &Mutex<Option<String>>) {
    while let Ok(first) = rx.recv() {
        let mut batch = vec![first];
        let deadline = Instant::now() + BATCH_WINDOW;
        while batch.len() < BATCH_MAX {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(msg) => batch.push(msg),
                Err(_) => break,
            }
        }
        // Once a write has failed nothing more is written: what the file holds stays exactly what
        // it held at its last good write, which is all memory will ever read back from it.
        if lock(failed).is_none() {
            match write_batch(&mut conn, &batch) {
                Ok(Some(last)) => written.store(last, Ordering::SeqCst),
                Ok(None) => {}
                Err(e) => {
                    log::warn!("saved prices: writing stopped: {e}");
                    *lock(failed) = Some(e);
                }
            }
        }
        for msg in batch {
            if let Msg::Flush(ack) = msg {
                let _ = ack.send(());
            }
        }
    }
}

fn write_batch(conn: &mut Connection, batch: &[Msg]) -> Result<Option<u64>, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut last = None;
    for msg in batch {
        if let Msg::Op(seq, op) = msg {
            price_store::apply(&tx, op).map_err(|e| e.to_string())?;
            last = Some(*seq);
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(last)
}

fn sibling(db: &Path, suffix: &str) -> PathBuf {
    let mut name = db.to_path_buf().into_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

/// Removes the file. Windows refuses to delete a file something still has open, and a connection's
/// handle can take a moment to go, so it tries a few times.
pub fn delete_files(dir: &Path) -> Result<(), String> {
    let db = dir.join(FILE);
    let paths = [sibling(&db, "-wal"), sibling(&db, "-shm"), lock_path(&db), db];
    for path in paths {
        let mut tries = 0;
        loop {
            match std::fs::remove_file(&path) {
                Ok(()) => break,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                Err(e) if tries < 20 => {
                    tries += 1;
                    log::debug!("saved prices: {} not removed yet: {e}", path.display());
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => return Err(format!("couldn't delete {}: {e}", path.display())),
            }
        }
    }
    Ok(())
}

fn file_bytes(dir: &Path) -> u64 {
    let db = dir.join(FILE);
    [sibling(&db, "-wal"), db]
        .iter()
        .filter_map(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
        .sum()
}

/// How many saved series hold one broker's bars.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Supplied {
    pub broker: &'static str,
    pub label: &'static str,
    pub series: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedPricesStatus {
    pub on: bool,
    /// Why prices aren't being saved although saving is on.
    pub problem: Option<String>,
    /// The file's size on disk.
    pub bytes: u64,
    /// Whether the file is in use (saving is on, and this copy of the app has it).
    pub open: bool,
    /// From memory's index of the file; unknown while it isn't open.
    pub series: Option<i64>,
    pub daily_series: Option<i64>,
    pub bars: Option<i64>,
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
    /// Which brokers supplied them (a series can hold both's bars).
    pub supplied: Vec<Supplied>,
}

/// The open file, as Tauri state.
pub struct SavedPrices {
    dir: PathBuf,
    open: Mutex<Option<Arc<PriceFile>>>,
    problem: Mutex<Option<String>>,
}

impl SavedPrices {
    pub fn new(dir: PathBuf) -> Self {
        SavedPrices {
            dir,
            open: Mutex::new(None),
            problem: Mutex::new(None),
        }
    }

    /// Makes the open file agree with `on`: the file open and behind memory when saving is on, none
    /// when it is off. Which broker serves `india:` has nothing to do with it.
    pub fn sync(&self, memory: &BarMemory, on: bool) {
        let mut open = lock(&self.open);
        if on == open.is_some() {
            return;
        }
        *lock(&self.problem) = None;
        if !on {
            memory.attach(None);
            if let Some(file) = open.take() {
                file.close();
            }
            return;
        }
        match PriceFile::open(&self.dir) {
            Ok((file, index)) => {
                let disk: Arc<dyn BarDisk> = file.clone();
                memory.attach(Some((disk, index)));
                *open = Some(file);
            }
            Err(e) => {
                log::warn!("saved prices: couldn't open {FILE}: {e}");
                *lock(&self.problem) = Some(e);
            }
        }
    }

    /// Deletes every saved price. Memory's `india:` series go too (a delete leaves nothing of them
    /// saved), and while saving is on an empty file takes the old one's place.
    pub fn delete(&self, memory: &BarMemory) -> Result<(), String> {
        let mut open = lock(&self.open);
        let Some(file) = open.take() else {
            return delete_files(&self.dir);
        };
        memory.attach(None);
        memory.forget_provider(INDIA);
        file.close();
        drop(file);
        delete_files(&self.dir)?;
        match PriceFile::open(&self.dir) {
            Ok((file, index)) => {
                let disk: Arc<dyn BarDisk> = file.clone();
                memory.attach(Some((disk, index)));
                *open = Some(file);
            }
            Err(e) => *lock(&self.problem) = Some(e),
        }
        Ok(())
    }

    /// Deletes the prices `broker` supplied (every series holding any of its bars), in memory and
    /// the file: what forgetting a broker's login offers. Returns how many series went.
    pub fn forget_broker(&self, memory: &BarMemory, broker: Broker) -> usize {
        memory.forget_source(broker)
    }

    /// Saving switched off: the file is let go and deleted.
    pub fn switch_off(&self, memory: &BarMemory) -> Result<(), String> {
        self.sync(memory, false);
        *lock(&self.problem) = None;
        delete_files(&self.dir)
    }

    pub fn status(&self, memory: &BarMemory, on: bool) -> SavedPricesStatus {
        let open = lock(&self.open);
        let problem = lock(&self.problem)
            .clone()
            .or_else(|| open.as_ref().and_then(|f| f.failure()));
        let held = open.as_ref().and(memory.saved_stats());
        SavedPricesStatus {
            on,
            problem,
            bytes: file_bytes(&self.dir),
            open: open.is_some(),
            series: held.map(|s| s.series),
            daily_series: held.map(|s| s.daily_series),
            bars: held.map(|s| s.bars),
            from_ms: held.and_then(|s| s.from_ms),
            to_ms: held.and_then(|s| s.to_ms),
            supplied: if held.is_some() {
                Broker::ALL
                    .iter()
                    .map(|&b| Supplied {
                        broker: b.id(),
                        label: b.label(),
                        series: memory.supplied_by(b),
                    })
                    .collect()
            } else {
                Vec::new()
            },
        }
    }

    /// At exit: what is queued is written before the app goes.
    pub fn close(&self) {
        if let Some(file) = lock(&self.open).as_ref() {
            file.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::bar_memory::tests::bar;
    use crate::store::research_bars::Range;

    const SYM: &str = "india:NSE:RELIANCE";
    const TCS: &str = "india:NSE:TCS";

    fn dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("protrade-prices-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn range(from_ms: i64, to_ms: i64) -> Range {
        Range { from_ms, to_ms }
    }

    fn flush(saved: &SavedPrices) {
        assert!(lock(&saved.open).as_ref().unwrap().flush(Duration::from_secs(10)));
    }

    #[test]
    fn saved_bars_are_there_after_a_relaunch_whichever_broker_serves_then() {
        let dir = dir("relaunch");
        {
            let saved = SavedPrices::new(dir.clone());
            let memory = BarMemory::default();
            saved.sync(&memory, true);
            memory.put_covered(
                SYM,
                "D",
                &[bar(1000, 1.0), bar(2000, 2.0)],
                range(0, 2000),
                5,
                Some(Broker::Zerodha),
            );
            flush(&saved);
            saved.close();
        }
        let saved = SavedPrices::new(dir.clone());
        let memory = BarMemory::default();
        saved.sync(&memory, true);
        assert_eq!(memory.coverage(SYM, "D").map(|c| c.to_ms), Some(2000));
        assert_eq!(memory.get(SYM, "D", i64::MIN, i64::MAX, None).len(), 2);
        assert_eq!(memory.sources(SYM, "D"), Broker::Zerodha.bit());

        // FYERS serving now: it fills in what is new onto the same series.
        memory.put_covered(SYM, "D", &[bar(3000, 3.0)], range(2000, 3000), 6, Some(Broker::Fyers));
        assert_eq!(memory.get(SYM, "D", i64::MIN, i64::MAX, None).len(), 3);
        saved.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_second_copy_of_the_app_is_refused_the_file() {
        let dir = dir("second");
        let (first, _) = PriceFile::open(&dir).unwrap();
        assert_eq!(PriceFile::open(&dir).err().as_deref(), Some(IN_USE));
        first.close();
        assert!(PriceFile::open(&dir).is_ok(), "free once closed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn switching_off_deletes_the_file_and_keeps_what_memory_holds() {
        let dir = dir("off");
        let saved = SavedPrices::new(dir.clone());
        let memory = BarMemory::default();
        saved.sync(&memory, true);
        memory.put_covered(SYM, "D", &[bar(1000, 1.0)], range(0, 2000), 5, None);
        flush(&saved);
        assert!(dir.join(FILE).exists());

        saved.switch_off(&memory).unwrap();
        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().collect();
        assert!(left.is_empty(), "{left:?}");
        assert_eq!(memory.get(SYM, "D", i64::MIN, i64::MAX, None).len(), 1);
        assert_eq!(memory.saved_stats(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deleting_starts_an_empty_file() {
        let dir = dir("delete");
        let saved = SavedPrices::new(dir.clone());
        let memory = BarMemory::default();
        saved.sync(&memory, true);
        memory.put_covered(SYM, "D", &[bar(1000, 1.0)], range(0, 2000), 5, None);
        flush(&saved);

        saved.delete(&memory).unwrap();
        assert_eq!(memory.coverage(SYM, "D"), None);
        let status = saved.status(&memory, true);
        assert!(status.open);
        assert_eq!(status.series, Some(0));
        saved.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn forgetting_a_broker_deletes_only_what_it_supplied_from_the_file() {
        let dir = dir("forget");
        {
            let saved = SavedPrices::new(dir.clone());
            let memory = BarMemory::default();
            saved.sync(&memory, true);
            memory.put_covered(SYM, "D", &[bar(1000, 1.0)], range(0, 2000), 5, Some(Broker::Zerodha));
            memory.put_covered(TCS, "D", &[bar(1000, 1.0)], range(0, 2000), 5, Some(Broker::Fyers));
            assert_eq!(saved.forget_broker(&memory, Broker::Zerodha), 1);
            flush(&saved);
            saved.close();
        }
        let saved = SavedPrices::new(dir.clone());
        let memory = BarMemory::default();
        saved.sync(&memory, true);
        assert_eq!(memory.coverage(SYM, "D"), None, "Zerodha's is gone from the file");
        assert!(memory.coverage(TCS, "D").is_some());
        saved.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_status_reports_what_the_file_holds_and_who_supplied_it() {
        let dir = dir("status");
        let saved = SavedPrices::new(dir.clone());
        let memory = BarMemory::default();
        let off = saved.status(&memory, false);
        assert!(!off.open && off.supplied.is_empty() && off.series.is_none());
        saved.sync(&memory, true);
        memory.put_covered(
            SYM,
            "D",
            &[bar(1000, 1.0), bar(2000, 1.0)],
            range(0, 2000),
            5,
            Some(Broker::Zerodha),
        );
        memory.put_covered(SYM, "5", &[bar(1000, 1.0)], range(1000, 1000), 5, Some(Broker::Fyers));
        flush(&saved);
        let status = saved.status(&memory, true);
        assert_eq!(
            (status.series, status.daily_series, status.bars),
            (Some(2), Some(1), Some(3))
        );
        assert_eq!(
            status.supplied.iter().map(|s| (s.broker, s.series)).collect::<Vec<_>>(),
            [("zerodha", 1), ("fyers", 1)]
        );
        assert!(status.bytes > 0);
        assert_eq!(status.problem, None);
        saved.close();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
