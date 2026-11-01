//! Broker bars, held in memory for as long as the app is open — and, when the user has switched
//! on "Save prices on this computer", backed by a file (`crate::prices`) so they outlive it.
//! Nothing else holds a broker's price history: this is what the Python API, the Screener, Studies,
//! the "Keep the market loaded" job and the charts read.
//!
//! The prices are broker-agnostic. A series is keyed by its neutral symbol (`india:NSE:RELIANCE`),
//! whichever broker served it, so a change of broker keeps everything held: the new broker only
//! fills in what is missing. What keeps a series consistent is `pyapi::data::load_bars`, which
//! checks one already-final bar against the broker's copy on every refresh (all of that bar, where
//! the broker in use didn't supply the series) and reads the series again whole when they differ.
//! Each series remembers which brokers supplied its bars (`sources`), so one broker's prices can
//! still be deleted when its login is forgotten.
//!
//! Every series carries a *coverage*, as the old disk store's did: the span whose bars are
//! complete. It has to be recorded, because "no bars" (a holiday, a stock not yet listed) and
//! "not fetched yet" look identical. `research_bars::plan` is the sync policy over it. The bars a
//! series holds always lie inside its coverage.
//!
//! With a file attached, memory stays the authority. It holds every saved series' coverage (the
//! file's index, read when it opens) and reads a series' bars from the file the first time they
//! are wanted. Every change is made here first and queued for the file inside the same write
//! lock, so the file sees changes in the order memory made them, and its coverage is always backed
//! by its bars. Only `india:` series are saved (the brokers' prices; nothing else in here is).
//!
//! The store has a budget. Over it, the series read least recently lose their bars: wholly
//! (coverage too) when they aren't saved, so they are simply fetched again; only their bars when
//! they are and the file holds every change, so they are read back from it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};

use super::research_bars::{Coverage, Range};
use crate::models::Bar;
use crate::symbols::{Broker, INDIA};

/// About 400 MB of bars: the whole NSE's five years of daily bars take roughly half of it.
pub const DEFAULT_BUDGET_BYTES: usize = 400 * 1024 * 1024;

const DAY_MS: i64 = 86_400_000;

type Key = (String, String);

/// A change for the file behind memory, in the order memory made it.
#[derive(Debug, Clone, PartialEq)]
pub enum DiskOp {
    /// Adds `bars` (a bar at a time the file has replaces it) and records the series' coverage, its
    /// bar count and when it was used. With `clip`, bars outside the coverage are dropped first.
    Put {
        symbol: String,
        interval: String,
        bars: Vec<Bar>,
        coverage: Coverage,
        clip: bool,
        count: usize,
        used_ms: i64,
        /// The brokers whose bars the series holds ([`Broker::bit`]s).
        sources: u8,
    },
    /// The series becomes exactly `bars`.
    Replace {
        symbol: String,
        interval: String,
        bars: Vec<Bar>,
        coverage: Coverage,
        used_ms: i64,
        sources: u8,
    },
    Delete {
        symbol: String,
        interval: String,
    },
    /// Every daily series covered through `before` is covered through `now` (a holiday).
    CarryDaily {
        before: i64,
        now: i64,
    },
    /// The series was read, for the file's own record of what is unused.
    Touch {
        symbol: String,
        interval: String,
        used_ms: i64,
    },
}

/// The file behind memory. `send` never blocks; `load` reads the file.
pub trait BarDisk: Send + Sync {
    /// A saved series' bars, oldest first.
    fn load(&self, symbol: &str, interval: &str) -> Result<Vec<Bar>, String>;
    /// Queues a change and returns its sequence number (1, 2, …).
    fn send(&self, op: DiskOp) -> u64;
    /// The sequence number of the last change the file holds. Never moves once writing has
    /// failed, so nothing is dropped from memory that the file might not have.
    fn written(&self) -> u64;
}

/// One series of a file's index.
#[derive(Debug, Clone, PartialEq)]
pub struct SavedSeries {
    pub symbol: String,
    pub interval: String,
    pub coverage: Coverage,
    pub count: usize,
    pub last_used_ms: i64,
    pub sources: u8,
}

/// A file and its index, as `attach` takes them.
pub type Saved = (Arc<dyn BarDisk>, Vec<SavedSeries>);

struct Series {
    /// Oldest first, one bar per timestamp, all inside `coverage`. Empty while not `loaded`.
    bars: Vec<Bar>,
    /// Whether `bars` holds the series; when not, its bars are in the file.
    loaded: bool,
    /// How many bars the series has, loaded or not.
    count: usize,
    coverage: Coverage,
    /// The store's clock at the last read or write, for eviction. Atomic so that a read under
    /// the shared lock can still record itself.
    used: AtomicU64,
    /// When it was last read or written, for the file's pruning.
    last_used_ms: i64,
    /// The sequence number of the last change queued for the file (0: none).
    queued: u64,
    /// Which brokers supplied its bars ([`Broker::bit`]s).
    sources: u8,
}

#[derive(Default)]
struct Inner {
    series: HashMap<Key, Series>,
    /// Bars held in memory (loaded series only).
    bars: usize,
    disk: Option<Arc<dyn BarDisk>>,
}

impl Inner {
    fn saved(&self, symbol: &str) -> bool {
        self.disk.is_some() && is_india(symbol)
    }

    fn queue(&mut self, k: &Key, op: DiskOp) {
        if !self.saved(&k.0) {
            return;
        }
        if let Some(disk) = &self.disk {
            let seq = disk.send(op);
            if let Some(series) = self.series.get_mut(k) {
                series.queued = seq;
            }
        }
    }
}

pub struct BarMemory {
    inner: RwLock<Inner>,
    clock: AtomicU64,
    budget_bars: usize,
}

impl Default for BarMemory {
    fn default() -> Self {
        BarMemory::with_budget(DEFAULT_BUDGET_BYTES)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stats {
    pub series: i64,
    /// Bars held in memory now.
    pub bars: i64,
}

/// What the store holds of some daily series: how many, and the span they reach together.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DailySpan {
    pub series: i64,
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
}

/// What the attached file holds, from memory's index of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SavedStats {
    pub series: i64,
    pub bars: i64,
    pub daily_series: i64,
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
}

/// How the file is kept from growing without end. Daily bars are kept; intraday ones are not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PrunePolicy {
    /// Intraday bars older than this are dropped.
    pub intraday_keep_ms: i64,
    /// An intraday series nobody read for this long is dropped.
    pub unused_ms: i64,
    /// Above this many bars in all, the series used least recently go, intraday first.
    pub max_bars: usize,
}

impl Default for PrunePolicy {
    fn default() -> Self {
        PrunePolicy {
            intraday_keep_ms: 365 * DAY_MS,
            unused_ms: 90 * DAY_MS,
            // About 2 GB of file, at some 56 bytes a bar.
            max_bars: 36_000_000,
        }
    }
}

fn key(symbol: &str, interval: &str) -> Key {
    (symbol.to_string(), interval.to_string())
}

fn is_india(symbol: &str) -> bool {
    symbol.strip_prefix(INDIA).is_some_and(|rest| rest.starts_with(':'))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// Sorted by time, one bar per time: of two at one time, the later in `bars` wins, as a second
/// upsert would.
fn sorted_unique(bars: &[Bar]) -> Vec<Bar> {
    let mut sorted = bars.to_vec();
    sorted.sort_by_key(|b| b.time);
    sorted.reverse();
    sorted.dedup_by_key(|b| b.time);
    sorted.reverse();
    sorted
}

/// `new` (sorted by time) merged over `old`: a bar at a time both have is the new one.
fn merge(old: &mut Vec<Bar>, new: &[Bar]) {
    if new.is_empty() {
        return;
    }
    if old.last().is_none_or(|last| last.time < new[0].time) {
        old.extend_from_slice(new);
        return;
    }
    let mut merged = Vec::with_capacity(old.len() + new.len());
    let (mut i, mut j) = (0, 0);
    while i < old.len() && j < new.len() {
        if old[i].time < new[j].time {
            merged.push(old[i].clone());
            i += 1;
        } else {
            if old[i].time == new[j].time {
                i += 1;
            }
            merged.push(new[j].clone());
            j += 1;
        }
    }
    merged.extend_from_slice(&old[i..]);
    merged.extend_from_slice(&new[j..]);
    *old = merged;
}

/// `range` recorded over `old`: a range that touches the coverage extends it; one that doesn't
/// (a broker limit cut the fetch short of it) replaces it, so the coverage never claims a span
/// with a hole in it. The time of the last check moves only when the newest end was looked at.
/// The flag says whether it replaced.
fn extended(old: Option<Coverage>, range: Range, now_ms: i64) -> (Coverage, bool) {
    match old {
        Some(c) if range.from_ms <= c.to_ms && range.to_ms >= c.from_ms => (
            Coverage {
                from_ms: c.from_ms.min(range.from_ms),
                to_ms: c.to_ms.max(range.to_ms),
                synced_at: if range.to_ms >= c.to_ms { now_ms } else { c.synced_at },
            },
            false,
        ),
        _ => (
            Coverage {
                from_ms: range.from_ms,
                to_ms: range.to_ms,
                synced_at: now_ms,
            },
            old.is_some(),
        ),
    }
}

impl BarMemory {
    pub fn with_budget(bytes: usize) -> Self {
        BarMemory {
            inner: RwLock::new(Inner::default()),
            clock: AtomicU64::new(0),
            budget_bars: (bytes / std::mem::size_of::<Bar>()).max(1),
        }
    }

    // A panic while the lock was held can't leave a half-written series that matters more than
    // losing the session's bars would, so a poisoned lock is simply used as it stands.
    fn read(&self) -> RwLockReadGuard<'_, Inner> {
        self.inner.read().unwrap_or_else(|e| e.into_inner())
    }

    fn write(&self) -> RwLockWriteGuard<'_, Inner> {
        self.inner.write().unwrap_or_else(|e| e.into_inner())
    }

    fn tick(&self) -> u64 {
        self.clock.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Makes `saved` the file behind memory (`None`: nothing is saved). A file let go of takes the
    /// series only it held with it; a file taken on gets memory's own `india:` series as they
    /// stand, and its index for the rest. Returns how many series went with a file let go of.
    pub fn attach(&self, saved: Option<Saved>) -> usize {
        let mut inner = self.write();
        let mut dropped = 0;
        if inner.disk.take().is_some() {
            inner.series.retain(|(symbol, _), s| {
                let keep = s.loaded || !is_india(symbol);
                dropped += usize::from(!keep);
                keep
            });
        }
        if let Some((disk, index)) = saved {
            inner.disk = Some(disk);
            let held: Vec<Key> = inner.series.keys().filter(|(s, _)| is_india(s)).cloned().collect();
            for k in held {
                let s = &inner.series[&k];
                let op = DiskOp::Replace {
                    symbol: k.0.clone(),
                    interval: k.1.clone(),
                    bars: s.bars.clone(),
                    coverage: s.coverage,
                    used_ms: s.last_used_ms,
                    sources: s.sources,
                };
                inner.queue(&k, op);
            }
            for entry in index {
                let k = key(&entry.symbol, &entry.interval);
                inner.series.entry(k).or_insert_with(|| Series {
                    bars: Vec::new(),
                    loaded: false,
                    count: entry.count,
                    coverage: entry.coverage,
                    used: AtomicU64::new(0),
                    last_used_ms: entry.last_used_ms,
                    queued: 0,
                    sources: entry.sources,
                });
            }
        }
        dropped
    }

    pub fn coverage(&self, symbol: &str, interval: &str) -> Option<Coverage> {
        self.read().series.get(&key(symbol, interval)).map(|s| s.coverage)
    }

    /// Which brokers supplied a series' bars ([`Broker::bit`]s; 0 for one memory doesn't hold).
    pub fn sources(&self, symbol: &str, interval: &str) -> u8 {
        self.read().series.get(&key(symbol, interval)).map_or(0, |s| s.sources)
    }

    /// Reads a saved series' bars from the file when memory doesn't hold them. One the file can't
    /// give back is dropped, so it is fetched again rather than answered with a hole.
    fn load(&self, inner: &mut Inner, k: &Key) {
        let Some(series) = inner.series.get(k) else {
            return;
        };
        if series.loaded {
            return;
        }
        let Some(disk) = inner.disk.clone() else {
            return;
        };
        match disk.load(&k.0, &k.1) {
            Ok(bars) => {
                let used_ms = now_ms();
                let series = inner.series.get_mut(k).expect("looked up above");
                series.count = bars.len();
                series.bars = bars;
                series.loaded = true;
                series.last_used_ms = used_ms;
                inner.bars += inner.series[k].bars.len();
                inner.queue(
                    k,
                    DiskOp::Touch {
                        symbol: k.0.clone(),
                        interval: k.1.clone(),
                        used_ms,
                    },
                );
            }
            Err(e) => {
                log::warn!("couldn't read the saved {} {}: {e}", k.0, k.1);
                inner.series.remove(k);
                inner.queue(
                    k,
                    DiskOp::Delete {
                        symbol: k.0.clone(),
                        interval: k.1.clone(),
                    },
                );
            }
        }
    }

    /// Records that `range` was fetched, without bars: see [`put_covered`](Self::put_covered).
    #[cfg(test)]
    pub fn extend_coverage(&self, symbol: &str, interval: &str, range: Range, now_ms: i64) -> Coverage {
        self.store(symbol, interval, &[], range, now_ms, None, false);
        self.coverage(symbol, interval).expect("just recorded")
    }

    /// Adds `bars` to a series (replacing any it holds at the same times) and records that
    /// `range` was fetched, and by whom.
    pub fn put_covered(
        &self,
        symbol: &str,
        interval: &str,
        bars: &[Bar],
        range: Range,
        now_ms: i64,
        served_by: Option<Broker>,
    ) {
        self.store(symbol, interval, bars, range, now_ms, served_by, false);
    }

    /// Makes a series exactly `bars`, covered by `range`: after a corporate action, or when what
    /// another broker supplied doesn't agree with what this one serves.
    pub fn replace_covered(
        &self,
        symbol: &str,
        interval: &str,
        bars: &[Bar],
        range: Range,
        now_ms: i64,
        served_by: Option<Broker>,
    ) {
        self.store(symbol, interval, bars, range, now_ms, served_by, true);
    }

    #[allow(clippy::too_many_arguments)]
    fn store(
        &self,
        symbol: &str,
        interval: &str,
        bars: &[Bar],
        range: Range,
        now_ms: i64,
        served_by: Option<Broker>,
        replace: bool,
    ) {
        let new = sorted_unique(bars);
        let k = key(symbol, interval);
        let served = served_by.map_or(0, Broker::bit);
        let mut inner = self.write();
        if !replace {
            self.load(&mut inner, &k);
        }
        let used = self.tick();
        let old = inner.series.get(&k).map(|s| s.coverage);
        let (coverage, replaced) = if replace {
            (
                Coverage {
                    from_ms: range.from_ms,
                    to_ms: range.to_ms,
                    synced_at: now_ms,
                },
                false,
            )
        } else {
            extended(old, range, now_ms)
        };
        let series = inner.series.entry(k.clone()).or_insert_with(|| Series {
            bars: Vec::new(),
            loaded: true,
            count: 0,
            coverage,
            used: AtomicU64::new(used),
            last_used_ms: now_ms,
            queued: 0,
            sources: 0,
        });
        let before = series.bars.len();
        if replace {
            series.bars = new.clone();
        } else {
            merge(&mut series.bars, &new);
            if replaced {
                series
                    .bars
                    .retain(|b| b.time >= coverage.from_ms && b.time <= coverage.to_ms);
            }
        }
        series.loaded = true;
        series.coverage = coverage;
        series.count = series.bars.len();
        series.used.store(used, Ordering::Relaxed);
        series.last_used_ms = now_ms;
        series.sources = if replace { served } else { series.sources | served };
        let (after, count, sources) = (series.bars.len(), series.count, series.sources);
        inner.bars = inner.bars + after - before;
        let op = if replace {
            DiskOp::Replace {
                symbol: k.0.clone(),
                interval: k.1.clone(),
                bars: new,
                coverage,
                used_ms: now_ms,
                sources,
            }
        } else {
            DiskOp::Put {
                symbol: k.0.clone(),
                interval: k.1.clone(),
                bars: new,
                coverage,
                clip: replaced,
                count,
                used_ms: now_ms,
                sources,
            }
        };
        inner.queue(&k, op);
        self.evict(&mut inner, &k);
    }

    /// Frees the least recently used series, other than `keep`, until the store is within budget.
    /// A saved series keeps its coverage and goes back to the file, but only once the file holds
    /// every change to it; anything else goes whole.
    fn evict(&self, inner: &mut Inner, keep: &Key) {
        let written = inner.disk.as_ref().map(|d| d.written());
        while inner.bars > self.budget_bars {
            let oldest = inner
                .series
                .iter()
                .filter(|(k, s)| *k != keep && s.loaded && !s.bars.is_empty())
                .filter(|(k, s)| match written {
                    Some(w) if is_india(&k.0) => s.queued <= w,
                    _ => true,
                })
                .min_by_key(|(_, s)| s.used.load(Ordering::Relaxed))
                .map(|(k, _)| k.clone());
            let Some(oldest) = oldest else { break };
            if inner.saved(&oldest.0) {
                let series = inner.series.get_mut(&oldest).expect("found above");
                let freed = series.bars.len();
                series.bars = Vec::new();
                series.loaded = false;
                inner.bars -= freed;
            } else if let Some(gone) = inner.series.remove(&oldest) {
                inner.bars -= gone.bars.len();
            }
        }
    }

    /// The newest `limit` bars in `[from, to]` (all of them without a limit), oldest first.
    pub fn get(&self, symbol: &str, interval: &str, from_ms: i64, to_ms: i64, limit: Option<usize>) -> Vec<Bar> {
        let k = key(symbol, interval);
        {
            let inner = self.read();
            match inner.series.get(&k) {
                None => return Vec::new(),
                Some(series) if series.loaded => {
                    series.used.store(self.tick(), Ordering::Relaxed);
                    return slice(&series.bars, from_ms, to_ms, limit);
                }
                Some(_) => {}
            }
        }
        let mut inner = self.write();
        self.load(&mut inner, &k);
        let out = match inner.series.get(&k) {
            Some(series) => {
                series.used.store(self.tick(), Ordering::Relaxed);
                slice(&series.bars, from_ms, to_ms, limit)
            }
            None => Vec::new(),
        };
        self.evict(&mut inner, &k);
        out
    }

    /// Drops one series, bars and coverage, so the next read fetches it whole.
    #[cfg(test)]
    pub fn forget(&self, symbol: &str, interval: &str) {
        let k = key(symbol, interval);
        let mut inner = self.write();
        if let Some(gone) = inner.series.remove(&k) {
            inner.bars -= gone.bars.len();
            inner.queue(
                &k,
                DiskOp::Delete {
                    symbol: k.0.clone(),
                    interval: k.1.clone(),
                },
            );
        }
    }

    /// Drops every series of one namespace (`india`), here and in the file. Returns how many went.
    pub fn forget_provider(&self, provider: &str) -> usize {
        let prefix = format!("{provider}:");
        let mut inner = self.write();
        let gone: Vec<Key> = inner
            .series
            .keys()
            .filter(|(symbol, _)| symbol.starts_with(&prefix))
            .cloned()
            .collect();
        for k in &gone {
            if let Some(series) = inner.series.remove(k) {
                inner.bars -= series.bars.len();
            }
            inner.queue(
                k,
                DiskOp::Delete {
                    symbol: k.0.clone(),
                    interval: k.1.clone(),
                },
            );
        }
        gone.len()
    }

    /// Drops every `india:` series `broker` supplied bars to, here and in the file: what forgetting
    /// a broker's login offers, since its terms ask for its data to go once you stop using it.
    /// Returns how many went.
    pub fn forget_source(&self, broker: Broker) -> usize {
        let mut inner = self.write();
        let gone: Vec<Key> = inner
            .series
            .iter()
            .filter(|(k, s)| is_india(&k.0) && s.sources & broker.bit() != 0)
            .map(|(k, _)| k.clone())
            .collect();
        for k in &gone {
            self.drop_saved(&mut inner, k);
        }
        gone.len()
    }

    /// How many `india:` series hold bars `broker` supplied.
    pub fn supplied_by(&self, broker: Broker) -> i64 {
        self.read()
            .series
            .iter()
            .filter(|(k, s)| is_india(&k.0) && s.sources & broker.bit() != 0)
            .count() as i64
    }

    /// Marks every daily series that was current up to `before` as current through `now`: after a
    /// holiday, which has no bar to fetch. Returns how many it marked.
    pub fn carry_daily_through(&self, before: i64, now: i64) -> usize {
        let mut inner = self.write();
        let mut carried = Vec::new();
        for (k, series) in inner.series.iter_mut() {
            let c = &mut series.coverage;
            if k.1 == "D" && c.to_ms >= before {
                c.to_ms = c.to_ms.max(now);
                c.synced_at = now;
                carried.push(k.clone());
            }
        }
        if carried.iter().any(|k| inner.saved(&k.0)) {
            if let Some(disk) = inner.disk.clone() {
                let seq = disk.send(DiskOp::CarryDaily { before, now });
                for k in &carried {
                    if let Some(series) = inner.series.get_mut(k) {
                        series.queued = seq;
                    }
                }
            }
        }
        carried.len()
    }

    /// How many of `symbols`' daily series the store covers, and the span they reach.
    pub fn daily_span<'a>(&self, symbols: impl IntoIterator<Item = &'a str>) -> DailySpan {
        let inner = self.read();
        let mut span = DailySpan::default();
        for symbol in symbols {
            if let Some(c) = inner.series.get(&key(symbol, "D")).map(|s| s.coverage) {
                span.series += 1;
                span.from_ms = Some(span.from_ms.map_or(c.from_ms, |f| f.min(c.from_ms)));
                span.to_ms = Some(span.to_ms.map_or(c.to_ms, |t| t.max(c.to_ms)));
            }
        }
        span
    }

    pub fn stats(&self) -> Stats {
        let inner = self.read();
        Stats {
            series: inner.series.len() as i64,
            bars: inner.bars as i64,
        }
    }

    /// What the attached file holds; `None` with no file.
    pub fn saved_stats(&self) -> Option<SavedStats> {
        let inner = self.read();
        inner.disk.as_ref()?;
        let mut stats = SavedStats::default();
        for ((symbol, interval), s) in &inner.series {
            if !is_india(symbol) {
                continue;
            }
            stats.series += 1;
            stats.bars += s.count as i64;
            if interval == "D" {
                stats.daily_series += 1;
                let c = s.coverage;
                stats.from_ms = Some(stats.from_ms.map_or(c.from_ms, |f| f.min(c.from_ms)));
                stats.to_ms = Some(stats.to_ms.map_or(c.to_ms, |t| t.max(c.to_ms)));
            }
        }
        Some(stats)
    }

    /// Frees memory. With no file, everything goes; with one, saved series keep their coverage and
    /// are read back from the file when next wanted (those it doesn't hold every change to yet
    /// stay). Returns how many bars were freed.
    pub fn clear(&self) -> usize {
        let mut inner = self.write();
        let Some(disk) = inner.disk.clone() else {
            let bars = inner.bars;
            inner.series.clear();
            inner.bars = 0;
            return bars;
        };
        let written = disk.written();
        let mut freed = 0;
        inner.series.retain(|(symbol, _), s| {
            if !is_india(symbol) {
                freed += s.bars.len();
                return false;
            }
            if s.loaded && s.queued <= written {
                freed += s.bars.len();
                s.bars = Vec::new();
                s.loaded = false;
            }
            true
        });
        inner.bars -= freed;
        freed
    }

    /// Keeps the file from growing without end (see [`PrunePolicy`]); nothing happens with no
    /// file. Every cut is made in memory first and then queued, like any other change. Returns
    /// how many series were dropped or trimmed.
    pub fn prune(&self, now_ms: i64, policy: &PrunePolicy) -> usize {
        let mut inner = self.write();
        if inner.disk.is_none() {
            return 0;
        }
        let cutoff = now_ms - policy.intraday_keep_ms;
        let intraday: Vec<Key> = inner
            .series
            .keys()
            .filter(|(symbol, interval)| is_india(symbol) && interval != "D")
            .cloned()
            .collect();
        let mut changed = 0;
        for k in intraday {
            let (last_used, coverage) = {
                let s = &inner.series[&k];
                (s.last_used_ms, s.coverage)
            };
            if now_ms - last_used > policy.unused_ms || coverage.to_ms < cutoff {
                self.drop_saved(&mut inner, &k);
                changed += 1;
            } else if coverage.from_ms < cutoff {
                self.load(&mut inner, &k);
                let Some(series) = inner.series.get_mut(&k) else {
                    continue;
                };
                let before = series.bars.len();
                series.bars.retain(|b| b.time >= cutoff);
                series.coverage.from_ms = cutoff;
                series.count = series.bars.len();
                let (freed, coverage, count, used_ms, sources) = (
                    before - series.bars.len(),
                    series.coverage,
                    series.count,
                    series.last_used_ms,
                    series.sources,
                );
                inner.bars -= freed;
                inner.queue(
                    &k,
                    DiskOp::Put {
                        symbol: k.0.clone(),
                        interval: k.1.clone(),
                        bars: Vec::new(),
                        coverage,
                        clip: true,
                        count,
                        used_ms,
                        sources,
                    },
                );
                changed += 1;
            }
        }
        let mut total: usize = inner
            .series
            .iter()
            .filter(|(k, _)| is_india(&k.0))
            .map(|(_, s)| s.count)
            .sum();
        if total > policy.max_bars {
            let mut by_age: Vec<(bool, i64, Key)> = inner
                .series
                .iter()
                .filter(|(k, _)| is_india(&k.0))
                .map(|(k, s)| (k.1 == "D", s.last_used_ms, k.clone()))
                .collect();
            // Intraday first, then the longest unused.
            by_age.sort();
            for (_, _, k) in by_age {
                if total <= policy.max_bars {
                    break;
                }
                total -= inner.series[&k].count;
                self.drop_saved(&mut inner, &k);
                changed += 1;
            }
        }
        changed
    }

    fn drop_saved(&self, inner: &mut Inner, k: &Key) {
        if let Some(gone) = inner.series.remove(k) {
            inner.bars -= gone.bars.len();
        }
        inner.queue(
            k,
            DiskOp::Delete {
                symbol: k.0.clone(),
                interval: k.1.clone(),
            },
        );
    }
}

fn slice(bars: &[Bar], from_ms: i64, to_ms: i64, limit: Option<usize>) -> Vec<Bar> {
    let start = bars.partition_point(|b| b.time < from_ms);
    let end = bars.partition_point(|b| b.time <= to_ms);
    if start >= end {
        return Vec::new();
    }
    let start = limit.map_or(start, |n| start.max(end.saturating_sub(n)));
    bars[start..end].to_vec()
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::sync::Mutex;

    const SYM: &str = "india:NSE:RELIANCE";

    pub fn bar(time: i64, close: f64) -> Bar {
        Bar {
            time,
            open: close,
            high: close + 1.0,
            low: close - 1.0,
            close,
            volume: Some(10.0),
        }
    }

    fn cov(from_ms: i64, to_ms: i64, synced_at: i64) -> Coverage {
        Coverage {
            from_ms,
            to_ms,
            synced_at,
        }
    }

    fn range(from_ms: i64, to_ms: i64) -> Range {
        Range { from_ms, to_ms }
    }

    fn times(bars: &[Bar]) -> Vec<i64> {
        bars.iter().map(|b| b.time).collect()
    }

    fn put(m: &BarMemory, symbol: &str, interval: &str, bars: &[Bar]) {
        let from = bars.iter().map(|b| b.time).min().unwrap_or(0);
        let to = bars.iter().map(|b| b.time).max().unwrap_or(0);
        m.put_covered(symbol, interval, bars, range(from, to), 1, None);
    }

    /// A file that applies every change at once (or, with `hold`, keeps them waiting).
    #[derive(Default)]
    pub struct FakeDisk {
        pub ops: Mutex<Vec<DiskOp>>,
        pub series: Mutex<HashMap<Key, Vec<Bar>>>,
        pub loads: Mutex<Vec<Key>>,
        pub hold: std::sync::atomic::AtomicBool,
        sent: AtomicU64,
        written: AtomicU64,
    }

    impl FakeDisk {
        pub fn with(series: &[(&str, &str, Vec<Bar>)]) -> Arc<FakeDisk> {
            let disk = FakeDisk::default();
            for (symbol, interval, bars) in series {
                disk.series.lock().unwrap().insert(key(symbol, interval), bars.clone());
            }
            Arc::new(disk)
        }

        pub fn catch_up(&self) {
            self.hold.store(false, Ordering::SeqCst);
            self.written.store(self.sent.load(Ordering::SeqCst), Ordering::SeqCst);
        }

        pub fn ops(&self) -> Vec<DiskOp> {
            self.ops.lock().unwrap().clone()
        }
    }

    impl BarDisk for FakeDisk {
        fn load(&self, symbol: &str, interval: &str) -> Result<Vec<Bar>, String> {
            self.loads.lock().unwrap().push(key(symbol, interval));
            self.series
                .lock()
                .unwrap()
                .get(&key(symbol, interval))
                .cloned()
                .ok_or_else(|| "no such series".to_string())
        }

        fn send(&self, op: DiskOp) -> u64 {
            self.ops.lock().unwrap().push(op);
            let seq = self.sent.fetch_add(1, Ordering::SeqCst) + 1;
            if !self.hold.load(Ordering::SeqCst) {
                self.written.store(seq, Ordering::SeqCst);
            }
            seq
        }

        fn written(&self) -> u64 {
            self.written.load(Ordering::SeqCst)
        }
    }

    fn saved_entry(symbol: &str, interval: &str, c: Coverage, count: usize) -> SavedSeries {
        SavedSeries {
            symbol: symbol.to_string(),
            interval: interval.to_string(),
            coverage: c,
            count,
            last_used_ms: 1,
            sources: Broker::Zerodha.bit(),
        }
    }

    /// A memory with `disk` attached and its index of `index`.
    fn attached(m: &BarMemory, disk: &Arc<FakeDisk>, index: Vec<SavedSeries>) {
        let as_disk: Arc<dyn BarDisk> = disk.clone();
        m.attach(Some((as_disk, index)));
    }

    #[test]
    fn forgetting_a_namespace_drops_its_series_and_keeps_the_rest() {
        let m = BarMemory::default();
        put(&m, SYM, "D", &[bar(1, 10.0), bar(2, 11.0)]);
        put(&m, "india:NSE:TCS", "5", &[bar(1, 10.0)]);
        put(&m, "csv:MINE", "D", &[bar(1, 10.0)]);
        assert_eq!(m.forget_provider("india"), 2);
        assert_eq!(m.stats(), Stats { series: 1, bars: 1 });
        assert_eq!(m.get("csv:MINE", "D", i64::MIN, i64::MAX, None).len(), 1);
    }

    #[test]
    fn coverage_starts_from_the_first_fetch_and_grows_on_touching_ranges() {
        let m = BarMemory::default();
        assert_eq!(m.coverage(SYM, "D"), None);
        assert_eq!(
            m.extend_coverage(SYM, "D", range(100, 200), 1_000),
            cov(100, 200, 1_000)
        );
        // Older history: the span grows, but the newest end was not looked at again.
        assert_eq!(m.extend_coverage(SYM, "D", range(50, 100), 2_000), cov(50, 200, 1_000));
        // Newer data: the check time moves.
        assert_eq!(m.extend_coverage(SYM, "D", range(190, 300), 3_000), cov(50, 300, 3_000));
        assert_eq!(m.coverage(SYM, "D"), Some(cov(50, 300, 3_000)));
    }

    #[test]
    fn a_range_that_does_not_touch_the_coverage_replaces_it_rather_than_hiding_a_gap() {
        let m = BarMemory::default();
        m.extend_coverage(SYM, "D", range(100, 200), 1_000);
        // A broker limit cut a long fetch short: it starts well after the old end.
        assert_eq!(
            m.extend_coverage(SYM, "D", range(500, 600), 2_000),
            cov(500, 600, 2_000)
        );
    }

    #[test]
    fn bars_outside_a_replaced_coverage_go_with_it() {
        let m = BarMemory::default();
        m.put_covered(SYM, "D", &[bar(100, 1.0), bar(200, 2.0)], range(100, 200), 1, None);
        m.put_covered(SYM, "D", &[bar(500, 5.0)], range(500, 600), 2, None);
        assert_eq!(times(&m.get(SYM, "D", i64::MIN, i64::MAX, None)), [500]);
        assert_eq!(m.stats().bars, 1);
    }

    #[test]
    fn coverage_is_kept_per_symbol_and_interval() {
        let m = BarMemory::default();
        m.extend_coverage(SYM, "D", range(1, 2), 3);
        assert_eq!(m.coverage(SYM, "5"), None);
        assert_eq!(m.coverage("india:NSE:INFY", "D"), None);
    }

    #[test]
    fn put_upserts_and_get_returns_oldest_first_within_the_range() {
        let m = BarMemory::default();
        put(
            &m,
            SYM,
            "D",
            &(1..=10).map(|i| bar(i * 1000, i as f64)).collect::<Vec<_>>(),
        );
        put(&m, SYM, "D", &[bar(10_000, 99.0)]);

        assert_eq!(
            times(&m.get(SYM, "D", 3_000, 8_000, None)),
            [3000, 4000, 5000, 6000, 7000, 8000]
        );
        let newest = m.get(SYM, "D", i64::MIN, i64::MAX, Some(3));
        assert_eq!(times(&newest), [8000, 9000, 10_000]);
        assert_eq!(newest[2].close, 99.0, "the newer write won");
        assert!(m.get(SYM, "5", i64::MIN, i64::MAX, None).is_empty());
        assert_eq!(m.stats(), Stats { series: 1, bars: 10 });
    }

    #[test]
    fn bars_written_out_of_order_or_overlapping_end_up_sorted_once_each() {
        let m = BarMemory::default();
        m.put_covered(
            SYM,
            "D",
            &[bar(3000, 3.0), bar(1000, 1.0), bar(5000, 5.0)],
            range(1000, 5000),
            1,
            None,
        );
        // An older stretch, overlapping the middle, with a duplicate whose later copy wins.
        m.put_covered(
            SYM,
            "D",
            &[bar(2000, 2.0), bar(3000, 30.0), bar(4000, 4.0), bar(4000, 40.0)],
            range(2000, 4000),
            1,
            None,
        );
        let all = m.get(SYM, "D", i64::MIN, i64::MAX, None);
        assert_eq!(
            all.iter().map(|b| (b.time, b.close)).collect::<Vec<_>>(),
            [(1000, 1.0), (2000, 2.0), (3000, 30.0), (4000, 40.0), (5000, 5.0)]
        );
        assert_eq!(m.stats().bars, 5);
    }

    #[test]
    fn put_covered_records_the_bars_and_their_span_together() {
        let m = BarMemory::default();
        m.put_covered(SYM, "D", &[bar(1000, 1.0)], range(0, 2000), 7, None);
        assert_eq!(m.coverage(SYM, "D"), Some(cov(0, 2000, 7)));
        assert_eq!(m.get(SYM, "D", 0, 2000, None).len(), 1);
    }

    #[test]
    fn replacing_a_series_keeps_only_the_new_bars_and_span() {
        let m = BarMemory::default();
        m.put_covered(SYM, "D", &[bar(1000, 1.0), bar(2000, 2.0)], range(0, 2000), 1, None);
        m.replace_covered(SYM, "D", &[bar(2000, 1.0)], range(1500, 2500), 5, None);
        assert_eq!(m.coverage(SYM, "D"), Some(cov(1500, 2500, 5)));
        let all = m.get(SYM, "D", i64::MIN, i64::MAX, None);
        assert_eq!(all.iter().map(|b| (b.time, b.close)).collect::<Vec<_>>(), [(2000, 1.0)]);
        assert_eq!(m.stats().bars, 1);
    }

    #[test]
    fn a_series_takes_either_brokers_bars_and_remembers_who_supplied_them() {
        let m = BarMemory::default();
        m.put_covered(SYM, "D", &[bar(1, 1.0)], range(0, 1), 1, Some(Broker::Zerodha));
        m.put_covered(SYM, "D", &[bar(2, 2.0)], range(1, 2), 2, Some(Broker::Fyers));
        assert_eq!(times(&m.get(SYM, "D", i64::MIN, i64::MAX, None)), [1, 2]);
        assert_eq!(m.sources(SYM, "D"), Broker::Zerodha.bit() | Broker::Fyers.bit());
        // Read again whole from one broker, it is that broker's alone.
        m.replace_covered(SYM, "D", &[bar(2, 2.0)], range(0, 2), 3, Some(Broker::Fyers));
        assert_eq!(m.sources(SYM, "D"), Broker::Fyers.bit());
        assert_eq!(m.sources("india:NSE:TCS", "D"), 0);
    }

    #[test]
    fn forgetting_a_broker_drops_only_the_series_it_supplied() {
        let m = BarMemory::default();
        let disk = FakeDisk::with(&[]);
        attached(&m, &disk, vec![]);
        m.put_covered(SYM, "D", &[bar(1, 1.0)], range(0, 1), 1, Some(Broker::Zerodha));
        m.put_covered(
            "india:NSE:TCS",
            "D",
            &[bar(1, 1.0)],
            range(0, 1),
            1,
            Some(Broker::Fyers),
        );
        m.put_covered(
            "india:NSE:INFY",
            "D",
            &[bar(1, 1.0)],
            range(0, 1),
            1,
            Some(Broker::Zerodha),
        );
        m.put_covered(
            "india:NSE:INFY",
            "D",
            &[bar(2, 1.0)],
            range(1, 2),
            2,
            Some(Broker::Fyers),
        );
        assert_eq!((m.supplied_by(Broker::Zerodha), m.supplied_by(Broker::Fyers)), (2, 2));

        assert_eq!(m.forget_source(Broker::Zerodha), 2);
        assert_eq!(m.coverage(SYM, "D"), None);
        assert_eq!(
            m.coverage("india:NSE:INFY", "D"),
            None,
            "it held some of Zerodha's bars"
        );
        assert!(m.coverage("india:NSE:TCS", "D").is_some());
        let deleted = disk
            .ops()
            .into_iter()
            .filter(|op| matches!(op, DiskOp::Delete { .. }))
            .count();
        assert_eq!(deleted, 2, "and from the file");
    }

    #[test]
    fn over_budget_the_least_recently_read_series_go_whole() {
        // Room for four bars.
        let m = BarMemory::with_budget(4 * std::mem::size_of::<Bar>());
        m.put_covered("A", "D", &[bar(1, 1.0), bar(2, 1.0)], range(0, 2), 1, None);
        m.put_covered("B", "D", &[bar(1, 1.0), bar(2, 1.0)], range(0, 2), 1, None);
        // Reading A makes B the oldest.
        m.get("A", "D", 0, 2, None);
        m.put_covered("C", "D", &[bar(1, 1.0)], range(0, 1), 1, None);
        assert_eq!(m.coverage("B", "D"), None, "B went, coverage and all");
        assert!(m.get("B", "D", i64::MIN, i64::MAX, None).is_empty());
        assert!(m.coverage("A", "D").is_some() && m.coverage("C", "D").is_some());
        assert_eq!(m.stats(), Stats { series: 2, bars: 3 });
    }

    #[test]
    fn a_series_larger_than_the_budget_is_kept_rather_than_evicting_itself() {
        let m = BarMemory::with_budget(2 * std::mem::size_of::<Bar>());
        put(&m, "A", "D", &[bar(1, 1.0)]);
        put(&m, "B", "D", &[bar(1, 1.0), bar(2, 1.0), bar(3, 1.0)]);
        assert_eq!(m.stats(), Stats { series: 1, bars: 3 });
        assert_eq!(m.get("B", "D", i64::MIN, i64::MAX, None).len(), 3);
    }

    #[test]
    fn the_daily_span_counts_only_covered_daily_series_of_the_symbols_asked_about() {
        let m = BarMemory::default();
        m.extend_coverage("A", "D", range(100, 500), 1);
        m.extend_coverage("B", "D", range(50, 400), 1);
        m.extend_coverage("A", "5", range(0, 900), 1);
        m.extend_coverage("OTHER", "D", range(0, 999), 1);
        assert_eq!(
            m.daily_span(["A", "B", "MISSING"]),
            DailySpan {
                series: 2,
                from_ms: Some(50),
                to_ms: Some(500)
            }
        );
        assert_eq!(m.daily_span([]), DailySpan::default());
    }

    #[test]
    fn a_forgotten_series_goes_whole_and_others_stay() {
        let m = BarMemory::default();
        m.put_covered(SYM, "D", &[bar(1000, 1.0)], range(0, 2000), 1, None);
        m.put_covered("OTHER", "D", &[bar(1000, 1.0)], range(0, 2000), 1, None);
        m.forget(SYM, "D");
        assert_eq!(m.coverage(SYM, "D"), None);
        assert_eq!(m.stats(), Stats { series: 1, bars: 1 });
    }

    #[test]
    fn only_daily_series_current_before_the_holiday_are_carried_through_it() {
        let m = BarMemory::default();
        m.extend_coverage("CURRENT", "D", range(0, 500), 1);
        m.extend_coverage("BEHIND", "D", range(0, 300), 1);
        m.extend_coverage("INTRADAY", "5", range(0, 500), 1);
        assert_eq!(m.carry_daily_through(400, 900), 1);
        assert_eq!(m.coverage("CURRENT", "D"), Some(cov(0, 900, 900)));
        assert_eq!(m.coverage("BEHIND", "D"), Some(cov(0, 300, 1)));
        assert_eq!(m.coverage("INTRADAY", "5"), Some(cov(0, 500, 1)));
    }

    #[test]
    fn clear_empties_it() {
        let m = BarMemory::default();
        m.put_covered(SYM, "D", &[bar(1000, 1.0)], range(0, 2000), 1, None);
        assert_eq!(m.stats(), Stats { series: 1, bars: 1 });
        assert_eq!(m.clear(), 1);
        assert_eq!(m.stats(), Stats { series: 0, bars: 0 });
        assert_eq!(m.coverage(SYM, "D"), None);
    }

    // ---- With a file behind it -------------------------------------------------------------

    #[test]
    fn a_files_index_is_known_at_once_and_its_bars_are_read_on_first_use() {
        let m = BarMemory::default();
        let disk = FakeDisk::with(&[(SYM, "D", vec![bar(1000, 1.0), bar(2000, 2.0)])]);
        attached(&m, &disk, vec![saved_entry(SYM, "D", cov(0, 2000, 5), 2)]);

        assert_eq!(m.coverage(SYM, "D"), Some(cov(0, 2000, 5)));
        assert!(disk.loads.lock().unwrap().is_empty(), "coverage never reads the file");
        assert_eq!(m.stats(), Stats { series: 1, bars: 0 });

        assert_eq!(times(&m.get(SYM, "D", i64::MIN, i64::MAX, None)), [1000, 2000]);
        m.get(SYM, "D", i64::MIN, i64::MAX, None);
        assert_eq!(disk.loads.lock().unwrap().len(), 1, "read once, then held");
        assert!(matches!(disk.ops().last(), Some(DiskOp::Touch { .. })));
    }

    #[test]
    fn a_write_to_a_saved_series_merges_with_its_bars_on_file_and_goes_to_the_file() {
        let m = BarMemory::default();
        let disk = FakeDisk::with(&[(SYM, "D", vec![bar(1000, 1.0), bar(2000, 2.0)])]);
        attached(&m, &disk, vec![saved_entry(SYM, "D", cov(0, 2000, 5), 2)]);

        m.put_covered(SYM, "D", &[bar(3000, 3.0)], range(2000, 3000), 9, None);
        assert_eq!(times(&m.get(SYM, "D", i64::MIN, i64::MAX, None)), [1000, 2000, 3000]);
        assert_eq!(m.coverage(SYM, "D"), Some(cov(0, 3000, 9)));
        assert_eq!(
            disk.ops().last(),
            Some(&DiskOp::Put {
                symbol: SYM.to_string(),
                interval: "D".to_string(),
                bars: vec![bar(3000, 3.0)],
                coverage: cov(0, 3000, 9),
                clip: false,
                count: 3,
                used_ms: 9,
                sources: Broker::Zerodha.bit(),
            })
        );
    }

    #[test]
    fn only_indian_series_are_saved() {
        let m = BarMemory::default();
        let disk = FakeDisk::with(&[]);
        attached(&m, &disk, vec![]);
        m.put_covered("csv:MINE", "D", &[bar(1, 1.0)], range(0, 1), 1, None);
        assert!(disk.ops().is_empty());
        m.put_covered(SYM, "D", &[bar(1, 1.0)], range(0, 1), 1, None);
        assert_eq!(disk.ops().len(), 1);
    }

    #[test]
    fn a_saved_series_is_evicted_to_the_file_only_once_the_file_holds_it() {
        let m = BarMemory::with_budget(2 * std::mem::size_of::<Bar>());
        let disk = FakeDisk::with(&[]);
        attached(&m, &disk, vec![]);
        disk.hold.store(true, Ordering::SeqCst);
        m.put_covered(SYM, "D", &[bar(1, 1.0), bar(2, 2.0)], range(0, 2), 1, None);
        m.put_covered("india:NSE:TCS", "D", &[bar(1, 1.0)], range(0, 1), 1, None);
        assert_eq!(m.stats().bars, 3, "nothing goes while the file is behind");

        disk.catch_up();
        disk.series
            .lock()
            .unwrap()
            .insert(key(SYM, "D"), vec![bar(1, 1.0), bar(2, 2.0)]);
        m.put_covered("india:NSE:TCS", "D", &[bar(2, 1.0)], range(1, 2), 2, None);
        assert_eq!(m.stats().bars, 2, "the older one went back to the file");
        assert_eq!(m.coverage(SYM, "D"), Some(cov(0, 2, 1)), "keeping its coverage");
        assert_eq!(m.get(SYM, "D", i64::MIN, i64::MAX, None).len(), 2, "and is read back");
    }

    #[test]
    fn a_forgotten_saved_series_is_deleted_from_the_file_and_never_read_back() {
        let m = BarMemory::default();
        let disk = FakeDisk::with(&[(SYM, "D", vec![bar(1000, 1.0)])]);
        attached(&m, &disk, vec![saved_entry(SYM, "D", cov(0, 2000, 5), 1)]);
        disk.hold.store(true, Ordering::SeqCst);
        m.forget(SYM, "D");
        assert_eq!(m.coverage(SYM, "D"), None);
        assert!(m.get(SYM, "D", i64::MIN, i64::MAX, None).is_empty());
        assert!(disk.loads.lock().unwrap().is_empty());
        assert!(matches!(disk.ops().last(), Some(DiskOp::Delete { .. })));
    }

    #[test]
    fn a_saved_series_the_file_cannot_give_back_is_dropped_rather_than_answered_with_a_hole() {
        let m = BarMemory::default();
        let disk = FakeDisk::with(&[]);
        attached(&m, &disk, vec![saved_entry(SYM, "D", cov(0, 2000, 5), 3)]);
        assert!(m.get(SYM, "D", i64::MIN, i64::MAX, None).is_empty());
        assert_eq!(m.coverage(SYM, "D"), None);
    }

    #[test]
    fn taking_on_a_file_saves_what_memory_holds_and_letting_it_go_keeps_only_what_is_loaded() {
        let m = BarMemory::default();
        put(&m, SYM, "D", &[bar(1, 1.0)]);
        let disk = FakeDisk::with(&[]);
        attached(&m, &disk, vec![saved_entry("india:NSE:TCS", "D", cov(0, 9, 1), 4)]);
        assert!(matches!(&disk.ops()[..], [DiskOp::Replace { symbol, .. }] if symbol == SYM));
        assert!(m.coverage("india:NSE:TCS", "D").is_some());

        m.attach(None);
        assert!(m.coverage(SYM, "D").is_some(), "held in memory, so kept");
        assert_eq!(m.coverage("india:NSE:TCS", "D"), None, "only in the file, so gone");
        assert_eq!(m.saved_stats(), None);
    }

    #[test]
    fn a_holiday_carried_over_saved_series_goes_to_the_file_once() {
        let m = BarMemory::default();
        let disk = FakeDisk::with(&[]);
        attached(
            &m,
            &disk,
            vec![
                saved_entry(SYM, "D", cov(0, 500, 1), 1),
                saved_entry("india:NSE:TCS", "D", cov(0, 500, 1), 1),
            ],
        );
        assert_eq!(m.carry_daily_through(400, 900), 2);
        assert_eq!(disk.ops(), [DiskOp::CarryDaily { before: 400, now: 900 }]);
    }

    #[test]
    fn clearing_with_a_file_frees_the_bars_and_keeps_what_is_saved() {
        let m = BarMemory::default();
        let disk = FakeDisk::with(&[(SYM, "D", vec![bar(1000, 1.0)])]);
        attached(&m, &disk, vec![]);
        m.put_covered(SYM, "D", &[bar(1000, 1.0)], range(0, 2000), 1, None);
        m.put_covered("csv:MINE", "D", &[bar(1000, 1.0)], range(0, 2000), 1, None);
        assert_eq!(m.clear(), 2);
        assert_eq!(m.coverage("csv:MINE", "D"), None);
        assert_eq!(m.coverage(SYM, "D"), Some(cov(0, 2000, 1)));
        assert_eq!(m.get(SYM, "D", i64::MIN, i64::MAX, None).len(), 1);
    }

    #[test]
    fn pruning_trims_old_intraday_bars_drops_unused_series_and_keeps_daily() {
        let now = 1_000 * DAY_MS;
        let m = BarMemory::default();
        let disk = FakeDisk::with(&[]);
        attached(&m, &disk, vec![]);
        let old = now - 400 * DAY_MS;
        let recent = now - 10 * DAY_MS;
        m.put_covered(
            SYM,
            "5",
            &[bar(old, 1.0), bar(recent, 2.0)],
            range(old, recent),
            now,
            None,
        );
        m.put_covered(
            "india:NSE:TCS",
            "5",
            &[bar(recent, 1.0)],
            range(recent, recent),
            now - 100 * DAY_MS,
            None,
        );
        m.put_covered(
            "india:NSE:INFY",
            "D",
            &[bar(old, 1.0)],
            range(old, old),
            now - 900 * DAY_MS,
            None,
        );

        assert_eq!(m.prune(now, &PrunePolicy::default()), 2);
        let trimmed = m.coverage(SYM, "5").unwrap();
        assert_eq!(trimmed.from_ms, now - 365 * DAY_MS);
        assert_eq!(times(&m.get(SYM, "5", i64::MIN, i64::MAX, None)), [recent]);
        assert_eq!(m.coverage("india:NSE:TCS", "5"), None, "unused for 100 days");
        assert!(m.coverage("india:NSE:INFY", "D").is_some(), "daily bars are kept");
    }

    #[test]
    fn over_the_cap_the_least_recently_used_series_go_intraday_first() {
        let m = BarMemory::default();
        let disk = FakeDisk::with(&[]);
        attached(&m, &disk, vec![]);
        let now = 100 * DAY_MS;
        m.put_covered(
            "india:NSE:A",
            "D",
            &[bar(1, 1.0), bar(2, 1.0)],
            range(1, 2),
            now - 50,
            None,
        );
        m.put_covered(
            "india:NSE:B",
            "5",
            &[bar(now - 9, 1.0)],
            range(now - 9, now - 9),
            now - 5,
            None,
        );
        m.put_covered("india:NSE:C", "D", &[bar(1, 1.0)], range(1, 1), now - 10, None);
        let policy = PrunePolicy {
            max_bars: 2,
            ..PrunePolicy::default()
        };
        assert_eq!(m.prune(now, &policy), 2);
        assert_eq!(m.coverage("india:NSE:B", "5"), None, "intraday went first");
        assert_eq!(
            m.coverage("india:NSE:A", "D"),
            None,
            "then the daily series unused longest"
        );
        assert!(m.coverage("india:NSE:C", "D").is_some());
    }

    #[test]
    fn with_no_file_nothing_is_pruned() {
        let m = BarMemory::default();
        m.put_covered(SYM, "5", &[bar(1, 1.0)], range(1, 1), 1, None);
        assert_eq!(m.prune(1_000 * DAY_MS, &PrunePolicy::default()), 0);
        assert!(m.coverage(SYM, "5").is_some());
    }
}
