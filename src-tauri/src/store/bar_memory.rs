//! Broker bars, held in memory for as long as the app is open and never written to disk.
//!
//! This is what the Python API, the Screener, Studies, the "Keep the market loaded" job and the
//! charts' offline fallback read. Broker price history must not be stored on the user's computer
//! (Kite Connect's terms restrict permanent copies of its data), so it lives here and is gone
//! when the app closes; only the user's own imported datasets are persisted.
//!
//! Every series carries a *coverage*, as the old disk store's did: the span whose bars are
//! complete. It has to be recorded, because "no bars" (a holiday, a stock not yet listed) and
//! "not fetched yet" look identical. `research_bars::plan` is the sync policy over it.
//!
//! The store has a budget. Once it holds more bars than that, the series read least recently
//! are dropped whole (bars and coverage together, so a dropped series is simply fetched again).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

use super::research_bars::{Coverage, Range};
use crate::models::Bar;

/// About 400 MB of bars: the whole NSE's five years of daily bars take roughly half of it.
pub const DEFAULT_BUDGET_BYTES: usize = 400 * 1024 * 1024;

type Key = (String, String);

struct Series {
    /// Oldest first, one bar per timestamp.
    bars: Vec<Bar>,
    coverage: Option<Coverage>,
    /// The store's clock at the last read or write, for eviction. Atomic so that a read under
    /// the shared lock can still record itself.
    used: AtomicU64,
}

#[derive(Default)]
struct Inner {
    series: HashMap<Key, Series>,
    bars: usize,
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
    pub bars: i64,
}

/// What the store holds of some daily series: how many, and the span they reach together.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DailySpan {
    pub series: i64,
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
}

fn key(symbol: &str, interval: &str) -> Key {
    (symbol.to_string(), interval.to_string())
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

    fn entry<'a>(&self, inner: &'a mut Inner, symbol: &str, interval: &str) -> &'a mut Series {
        let used = self.tick();
        let series = inner.series.entry(key(symbol, interval)).or_insert_with(|| Series {
            bars: Vec::new(),
            coverage: None,
            used: AtomicU64::new(used),
        });
        series.used.store(used, Ordering::Relaxed);
        series
    }

    pub fn coverage(&self, symbol: &str, interval: &str) -> Option<Coverage> {
        self.read().series.get(&key(symbol, interval)).and_then(|s| s.coverage)
    }

    /// Records that `range` was fetched successfully. A range that touches the existing coverage
    /// extends it; one that doesn't (a broker limit cut the fetch short of it) replaces it, so the
    /// coverage never claims a span with a hole in it. The time of the last check moves only when
    /// the newest end was looked at.
    pub fn extend_coverage(&self, symbol: &str, interval: &str, range: Range, now_ms: i64) -> Coverage {
        let mut inner = self.write();
        let series = self.entry(&mut inner, symbol, interval);
        let merged = match series.coverage {
            Some(c) if range.from_ms <= c.to_ms && range.to_ms >= c.from_ms => Coverage {
                from_ms: c.from_ms.min(range.from_ms),
                to_ms: c.to_ms.max(range.to_ms),
                synced_at: if range.to_ms >= c.to_ms { now_ms } else { c.synced_at },
            },
            _ => Coverage {
                from_ms: range.from_ms,
                to_ms: range.to_ms,
                synced_at: now_ms,
            },
        };
        series.coverage = Some(merged);
        merged
    }

    /// Adds `bars` to a series, replacing any it already holds at the same times. Adds no
    /// coverage: bars outside a series' coverage are never answered as complete.
    pub fn put(&self, symbol: &str, interval: &str, bars: &[Bar]) {
        self.store(symbol, interval, bars, None);
    }

    /// [`put`](Self::put) and [`extend_coverage`](Self::extend_coverage) at once, so no reader
    /// sees the coverage without the bars it covers.
    pub fn put_covered(&self, symbol: &str, interval: &str, bars: &[Bar], range: Range, now_ms: i64) {
        self.store(symbol, interval, bars, Some((range, now_ms)));
    }

    fn store(&self, symbol: &str, interval: &str, bars: &[Bar], covered: Option<(Range, i64)>) {
        let mut sorted = bars.to_vec();
        sorted.sort_by_key(|b| b.time);
        // Of two bars at one time, the later in `bars` wins, as a second upsert would.
        sorted.reverse();
        sorted.dedup_by_key(|b| b.time);
        sorted.reverse();
        {
            let mut inner = self.write();
            let series = self.entry(&mut inner, symbol, interval);
            let before = series.bars.len();
            merge(&mut series.bars, &sorted);
            let added = series.bars.len() - before;
            inner.bars += added;
        }
        if let Some((range, now_ms)) = covered {
            self.extend_coverage(symbol, interval, range, now_ms);
        }
        self.evict(&key(symbol, interval));
    }

    /// Drops the least recently used series, other than `keep`, until the store is within budget.
    fn evict(&self, keep: &Key) {
        let mut inner = self.write();
        while inner.bars > self.budget_bars {
            let oldest = inner
                .series
                .iter()
                .filter(|(k, _)| *k != keep)
                .min_by_key(|(_, s)| s.used.load(Ordering::Relaxed))
                .map(|(k, _)| k.clone());
            let Some(oldest) = oldest else { break };
            if let Some(gone) = inner.series.remove(&oldest) {
                inner.bars -= gone.bars.len();
            }
        }
    }

    /// The newest `limit` bars in `[from, to]` (all of them without a limit), oldest first.
    pub fn get(&self, symbol: &str, interval: &str, from_ms: i64, to_ms: i64, limit: Option<usize>) -> Vec<Bar> {
        let inner = self.read();
        let Some(series) = inner.series.get(&key(symbol, interval)) else {
            return Vec::new();
        };
        series.used.store(self.tick(), Ordering::Relaxed);
        let start = series.bars.partition_point(|b| b.time < from_ms);
        let end = series.bars.partition_point(|b| b.time <= to_ms);
        if start >= end {
            return Vec::new();
        }
        let start = limit.map_or(start, |n| start.max(end.saturating_sub(n)));
        series.bars[start..end].to_vec()
    }

    /// Drops one series, bars and coverage, so the next read fetches it whole.
    pub fn forget(&self, symbol: &str, interval: &str) {
        let mut inner = self.write();
        if let Some(gone) = inner.series.remove(&key(symbol, interval)) {
            inner.bars -= gone.bars.len();
        }
    }

    /// Marks every daily series that was current up to `before` as current through `now`: after a
    /// holiday, which has no bar to fetch. Returns how many it marked.
    pub fn carry_daily_through(&self, before: i64, now: i64) -> usize {
        let mut inner = self.write();
        let mut carried = 0;
        for ((_, interval), series) in inner.series.iter_mut() {
            if let Some(c) = series
                .coverage
                .as_mut()
                .filter(|c| interval == "D" && c.to_ms >= before)
            {
                c.to_ms = c.to_ms.max(now);
                c.synced_at = now;
                carried += 1;
            }
        }
        carried
    }

    /// How many of `symbols`' daily series the store covers, and the span they reach.
    pub fn daily_span<'a>(&self, symbols: impl IntoIterator<Item = &'a str>) -> DailySpan {
        let inner = self.read();
        let mut span = DailySpan::default();
        for symbol in symbols {
            if let Some(c) = inner.series.get(&key(symbol, "D")).and_then(|s| s.coverage) {
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

    /// Forgets everything. Returns how many bars went.
    pub fn clear(&self) -> usize {
        let mut inner = self.write();
        let bars = inner.bars;
        *inner = Inner::default();
        bars
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SYM: &str = "zerodha:NSE:RELIANCE";

    fn bar(time: i64, close: f64) -> Bar {
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
    fn coverage_is_kept_per_symbol_and_interval() {
        let m = BarMemory::default();
        m.extend_coverage(SYM, "D", range(1, 2), 3);
        assert_eq!(m.coverage(SYM, "5"), None);
        assert_eq!(m.coverage("zerodha:NSE:INFY", "D"), None);
    }

    #[test]
    fn put_upserts_and_get_returns_oldest_first_within_the_range() {
        let m = BarMemory::default();
        m.put(SYM, "D", &(1..=10).map(|i| bar(i * 1000, i as f64)).collect::<Vec<_>>());
        m.put(SYM, "D", &[bar(10_000, 99.0)]);

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
        m.put(SYM, "D", &[bar(3000, 3.0), bar(1000, 1.0), bar(5000, 5.0)]);
        // An older stretch, overlapping the middle, with a duplicate whose later copy wins.
        m.put(
            SYM,
            "D",
            &[bar(2000, 2.0), bar(3000, 30.0), bar(4000, 4.0), bar(4000, 40.0)],
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
        m.put_covered(SYM, "D", &[bar(1000, 1.0)], range(0, 2000), 7);
        assert_eq!(m.coverage(SYM, "D"), Some(cov(0, 2000, 7)));
        assert_eq!(m.get(SYM, "D", 0, 2000, None).len(), 1);
    }

    #[test]
    fn over_budget_the_least_recently_read_series_go_whole() {
        // Room for four bars.
        let m = BarMemory::with_budget(4 * std::mem::size_of::<Bar>());
        m.put_covered("A", "D", &[bar(1, 1.0), bar(2, 1.0)], range(0, 2), 1);
        m.put_covered("B", "D", &[bar(1, 1.0), bar(2, 1.0)], range(0, 2), 1);
        // Reading A makes B the oldest.
        m.get("A", "D", 0, 2, None);
        m.put_covered("C", "D", &[bar(1, 1.0)], range(0, 1), 1);
        assert_eq!(m.coverage("B", "D"), None, "B went, coverage and all");
        assert!(m.get("B", "D", i64::MIN, i64::MAX, None).is_empty());
        assert!(m.coverage("A", "D").is_some() && m.coverage("C", "D").is_some());
        assert_eq!(m.stats(), Stats { series: 2, bars: 3 });
    }

    #[test]
    fn a_series_larger_than_the_budget_is_kept_rather_than_evicting_itself() {
        let m = BarMemory::with_budget(2 * std::mem::size_of::<Bar>());
        m.put("A", "D", &[bar(1, 1.0)]);
        m.put("B", "D", &[bar(1, 1.0), bar(2, 1.0), bar(3, 1.0)]);
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
        m.put_covered(SYM, "D", &[bar(1000, 1.0)], range(0, 2000), 1);
        m.put_covered("OTHER", "D", &[bar(1000, 1.0)], range(0, 2000), 1);
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
        m.put_covered(SYM, "D", &[bar(1000, 1.0)], range(0, 2000), 1);
        assert_eq!(m.stats(), Stats { series: 1, bars: 1 });
        assert_eq!(m.clear(), 1);
        assert_eq!(m.stats(), Stats { series: 0, bars: 0 });
        assert_eq!(m.coverage(SYM, "D"), None);
    }
}
