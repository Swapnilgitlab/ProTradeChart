//! One run of the market-data update: record the listing, download any history the store lacks
//! (the first run's five years, a new listing's), then bring every series up to the latest settled
//! session, fetching a series again in full when the broker's history no longer agrees with it.
//!
//! The broker sits behind the Python API's own [`Fetcher`] and [`Snapshots`], so a run reuses
//! `load_bars` (coverage-aware downloads) and `sync_daily` (the batched quote top-up), and is
//! tested here with a fake broker. The research lock is never held across an await.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use super::plan::{disagrees, history_from, needs_history, settled_session, was_holiday, TAIL_OVERLAP_MS};
use crate::db::Database;
use crate::market::last_settled_ms;
use crate::pyapi::data::{
    load_bars, normalise_daily, sync_daily, BarsRequest, Fetcher, Snapshots, SyncRequest, SyncStatus,
};
use crate::pyapi::ApiError;
use crate::store::market_symbols::{self, Listed};
use crate::store::research_bars::{self, Range};

const D: &str = "D";
const DAY_MS: i64 = 86_400_000;

pub trait Broker: Fetcher + Snapshots {}
impl<T: Fetcher + Snapshots> Broker for T {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// Downloading history the store lacks.
    History,
    /// The batched quote top-up of every series' latest bar.
    Prices,
    /// Series the quote couldn't update, read from the historical endpoint (and refetched in
    /// full after a corporate action).
    Corrections,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: Phase,
    pub done: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub listed: usize,
    pub new_listings: usize,
    pub downloaded: usize,
    pub updated: usize,
    pub refetched: usize,
    pub failed: usize,
    pub holiday: bool,
}

/// A failure every further request would meet too: a lapsed login, a plan without data access.
fn fatal(e: &ApiError) -> bool {
    matches!(e.code, "auth" | "not_configured" | "no_access" | "rate_limited")
}

pub fn cancelled() -> ApiError {
    ApiError::new(499, "cancelled", "Stopped.")
}

fn locked<T>(db: &Database, f: impl FnOnce(&mut rusqlite::Connection) -> rusqlite::Result<T>) -> Result<T, ApiError> {
    let mut conn = db.conn.lock().map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(f(&mut conn)?)
}

/// Runs one update over `listed` (the exchange's current listing, from `plan::universe`).
/// Returns early with the error when a failure is fatal, or with [`cancelled`] once `cancel` is set.
pub async fn run(
    research: &Database,
    broker: &dyn Broker,
    listed: &[Listed],
    now: i64,
    cancel: &AtomicBool,
    progress: &(dyn Fn(Progress) + Sync),
) -> Result<Summary, ApiError> {
    let from = history_from(now);
    let mut summary = Summary {
        listed: listed.len(),
        ..Summary::default()
    };
    summary.new_listings = locked(research, |c| market_symbols::record_listing(c, listed, now))?.len();

    // History the store lacks: everything on the first run, a new listing on a later one.
    let mut missing = Vec::new();
    for l in listed {
        if needs_history(locked(research, |c| research_bars::coverage(c, &l.symbol, D))?, from) {
            missing.push(l.symbol.as_str());
        }
    }
    for (i, symbol) in missing.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        progress(Progress {
            phase: Phase::History,
            done: i,
            total: missing.len(),
        });
        let request = BarsRequest {
            symbol: symbol.to_string(),
            interval: D.to_string(),
            from_ms: Some(from),
            to_ms: None,
            limit: Some(1),
        };
        match load_bars(research, broker, &request, now).await {
            Ok(_) => summary.downloaded += 1,
            Err(e) if fatal(&e) => return Err(e),
            Err(e) => {
                log::warn!("market data: couldn't download {symbol}: {}", e.message);
                summary.failed += 1;
            }
        }
    }
    if cancel.load(Ordering::SeqCst) {
        return Err(cancelled());
    }

    progress(Progress {
        phase: Phase::Prices,
        done: 0,
        total: listed.len(),
    });
    let report = sync_daily(
        research,
        broker,
        &SyncRequest {
            symbols: listed.iter().map(|l| l.symbol.clone()).collect(),
            interval: D.to_string(),
            from_ms: Some(from),
            to_ms: None,
            limit: None,
        },
        now,
    )
    .await;
    let mut corrections = Vec::new();
    let mut no_trade_today = false;
    for r in report.results {
        match r.status {
            SyncStatus::Updated => summary.updated += 1,
            SyncStatus::Fetch => {
                let reason = r.reason.as_deref();
                no_trade_today |= reason == Some("NotThisSession");
                corrections.push((r.symbol, reason == Some("PreviousCloseMismatch")));
            }
            SyncStatus::Current | SyncStatus::Skipped => {}
        }
    }

    // Quotes that last traded before the session may mean a weekday holiday, which has no bar to
    // fetch: check once, from one liquid symbol, rather than asking the broker for every symbol's
    // missing day.
    if no_trade_today {
        if let Some(probe) = probe_symbol(listed) {
            if holiday(research, broker, probe, now).await? {
                summary.holiday = true;
                return Ok(summary);
            }
        }
    }

    for (i, (symbol, split)) in corrections.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        progress(Progress {
            phase: Phase::Corrections,
            done: i,
            total: corrections.len(),
        });
        let outcome = if *split {
            refetch(research, broker, symbol, now).await.map(|_| true)
        } else {
            refresh_tail(research, broker, symbol, now).await
        };
        match outcome {
            Ok(true) => summary.refetched += 1,
            Ok(false) => summary.updated += 1,
            Err(e) if fatal(&e) => return Err(e),
            Err(e) => {
                log::warn!("market data: couldn't update {symbol}: {}", e.message);
                summary.failed += 1;
            }
        }
    }
    Ok(summary)
}

/// NIFTY 50 if it's listed (it trades every session), else the first symbol.
fn probe_symbol(listed: &[Listed]) -> Option<&str> {
    listed
        .iter()
        .find(|l| l.symbol.ends_with(":NSE:NIFTY_50") || l.symbol.ends_with(":NSE:NIFTY 50"))
        .or_else(|| listed.iter().find(|l| l.kind == "EQ"))
        .map(|l| l.symbol.as_str())
}

/// Whether the latest settled session was a holiday. If it was, every series that was current
/// up to the session before is marked current through it, so the next session's quote top-up
/// sees no gap.
async fn holiday(research: &Database, broker: &dyn Broker, probe: &str, now: i64) -> Result<bool, ApiError> {
    let session = settled_session(now);
    let coverage = locked(research, |c| research_bars::coverage(c, probe, D))?;
    if coverage.is_some_and(|c| c.to_ms >= last_settled_ms(now)) {
        return Ok(false);
    }
    let fetched = match broker.fetch(probe, D, session - 10 * DAY_MS, now).await {
        Ok(f) => f,
        Err(e) if fatal(&e) => return Err(e),
        // Not knowing is not a holiday: the ordinary update goes ahead.
        Err(_) => return Ok(false),
    };
    let mut bars = fetched.bars;
    normalise_daily(&mut bars);
    if !was_holiday(&bars, session) {
        return Ok(false);
    }
    let before = last_settled_ms(session - 1);
    locked(research, |c| {
        let tx = c.transaction()?;
        let current: Vec<(String, i64)> = {
            let mut stmt =
                tx.prepare("SELECT symbol, to_ts FROM research_coverage WHERE interval = 'D' AND to_ts >= ?1")?;
            let rows = stmt.query_map([before], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        for (symbol, to) in current {
            research_bars::extend_coverage(
                &tx,
                &symbol,
                D,
                Range {
                    from_ms: to,
                    to_ms: now,
                },
                now,
            )?;
        }
        tx.commit()
    })?;
    Ok(true)
}

/// Reads a series' missing tail, starting far enough back to overlap settled days. Returns `true`
/// when those days disagreed with the store and the series was fetched again in full instead.
async fn refresh_tail(research: &Database, broker: &dyn Broker, symbol: &str, now: i64) -> Result<bool, ApiError> {
    let from = history_from(now);
    let Some(coverage) = locked(research, |c| research_bars::coverage(c, symbol, D))? else {
        refetch(research, broker, symbol, now).await?;
        return Ok(false);
    };
    for range in research_bars::plan(Some(coverage), D, from, now, now) {
        let start = (range.from_ms - TAIL_OVERLAP_MS).max(coverage.from_ms);
        let fetched = broker.fetch(symbol, D, start, range.to_ms).await?;
        let mut bars = fetched.bars;
        normalise_daily(&mut bars);
        let stored = locked(research, |c| research_bars::get(c, symbol, D, start, range.to_ms, None))?;
        if disagrees(&stored, &bars) {
            refetch(research, broker, symbol, now).await?;
            return Ok(true);
        }
        locked(research, |c| {
            research_bars::put(c, symbol, D, &bars)?;
            research_bars::extend_coverage(
                c,
                symbol,
                D,
                Range {
                    from_ms: fetched.from_ms.max(start),
                    to_ms: range.to_ms,
                },
                now,
            )?;
            Ok(())
        })?;
    }
    Ok(false)
}

/// Fetches a series' whole stored span again and swaps it in. An empty answer is refused rather
/// than allowed to wipe the history it would replace.
async fn refetch(research: &Database, broker: &dyn Broker, symbol: &str, now: i64) -> Result<(), ApiError> {
    let from = history_from(now);
    let fetched = broker.fetch(symbol, D, from, now).await?;
    let mut bars = fetched.bars;
    normalise_daily(&mut bars);
    if bars.is_empty() {
        return Err(ApiError::new(
            502,
            "upstream",
            format!("the broker returned no history for {symbol}"),
        ));
    }
    let covered = Range {
        from_ms: fetched.from_ms.max(from),
        to_ms: now,
    };
    locked(research, |c| {
        research_bars::replace(c, symbol, D, &bars, covered, now)?;
        market_symbols::mark_refetched(c, symbol, now)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::ResearchDb;
    use crate::market::ist_day_start;
    use crate::models::{Bar, DaySnapshot};
    use crate::pyapi::data::Fetched;
    use futures::future::BoxFuture;
    use std::collections::{HashMap, HashSet};
    use std::sync::Mutex;

    /// Monday 5 January 2026, 00:00 IST.
    const MON: i64 = 1_767_551_400_000;
    const HOUR_MS: i64 = 3_600_000;

    fn at(day: i64, hour: i64) -> i64 {
        MON + day * DAY_MS + hour * HOUR_MS
    }

    fn weekday(day_start: i64) -> bool {
        // MON is a Monday; days are counted from it.
        ((day_start - MON) / DAY_MS).rem_euclid(7) < 5
    }

    /// A broker with a daily bar for every weekday (except `holidays`) up to `last_day`, priced
    /// `base + day`, scaled by `factor` (a split adjusts every past price).
    struct Fake {
        base: HashMap<String, f64>,
        factor: Mutex<f64>,
        last_day: Mutex<i64>,
        holidays: HashSet<i64>,
        fetches: Mutex<Vec<String>>,
        fail_auth: AtomicBool,
    }

    impl Fake {
        fn new(symbols: &[(&str, f64)], last_day: i64) -> Fake {
            Fake {
                base: symbols.iter().map(|(s, b)| (s.to_string(), *b)).collect(),
                factor: Mutex::new(1.0),
                last_day: Mutex::new(last_day),
                holidays: HashSet::new(),
                fetches: Mutex::new(Vec::new()),
                fail_auth: AtomicBool::new(false),
            }
        }

        fn price(&self, symbol: &str, day: i64) -> f64 {
            (self.base[symbol] + ((day - MON) / DAY_MS) as f64 + 2000.0) * *self.factor.lock().unwrap()
        }

        fn sessions(&self, from: i64, to: i64) -> Vec<i64> {
            let last = *self.last_day.lock().unwrap();
            let mut day = ist_day_start(from);
            let mut out = Vec::new();
            while day <= to.min(last) {
                if weekday(day) && !self.holidays.contains(&day) {
                    out.push(day);
                }
                day += DAY_MS;
            }
            out
        }

        fn fetched(&self) -> Vec<String> {
            std::mem::take(&mut self.fetches.lock().unwrap())
        }
    }

    impl Fetcher for Fake {
        fn fetch<'a>(
            &'a self,
            symbol: &'a str,
            _: &'a str,
            from: i64,
            to: i64,
        ) -> BoxFuture<'a, Result<Fetched, ApiError>> {
            Box::pin(async move {
                if self.fail_auth.load(Ordering::SeqCst) {
                    return Err(ApiError::new(401, "auth", "token expired"));
                }
                self.fetches.lock().unwrap().push(symbol.to_string());
                let bars = self
                    .sessions(from, to)
                    .into_iter()
                    .map(|day| {
                        let p = self.price(symbol, day);
                        Bar {
                            time: day + 9 * HOUR_MS,
                            open: p,
                            high: p + 1.0,
                            low: p - 1.0,
                            close: p,
                            volume: Some(100.0),
                        }
                    })
                    .collect();
                Ok(Fetched { bars, from_ms: from })
            })
        }
    }

    impl Snapshots for Fake {
        fn snapshots<'a>(
            &'a self,
            provider: &'a str,
            tickers: &'a [String],
        ) -> BoxFuture<'a, Result<Vec<Option<DaySnapshot>>, ApiError>> {
            Box::pin(async move {
                // On a holiday the quote is still the last session's.
                let last = *self.last_day.lock().unwrap();
                let traded = self.sessions(last - 10 * DAY_MS, last);
                Ok(tickers
                    .iter()
                    .map(|t| {
                        let symbol = format!("{provider}:{t}");
                        let [.., prev, session] = traded.as_slice() else {
                            return None;
                        };
                        let p = self.price(&symbol, *session);
                        Some(DaySnapshot {
                            open: p,
                            high: p + 1.0,
                            low: p - 1.0,
                            last: p,
                            previous_close: Some(self.price(&symbol, *prev)),
                            volume: Some(100.0),
                            traded_at_ms: Some(session + 15 * HOUR_MS),
                        })
                    })
                    .collect())
            })
        }
    }

    fn eq(symbol: &str) -> Listed {
        Listed {
            symbol: symbol.to_string(),
            kind: "EQ".to_string(),
            name: None,
        }
    }

    fn index(symbol: &str) -> Listed {
        Listed {
            kind: "INDEX".to_string(),
            ..eq(symbol)
        }
    }

    async fn update(research: &ResearchDb, fake: &Fake, listed: &[Listed], now: i64) -> Result<Summary, ApiError> {
        run(&research.write, fake, listed, now, &AtomicBool::new(false), &|_| {}).await
    }

    fn close_on(research: &ResearchDb, symbol: &str, day: i64) -> Option<f64> {
        let conn = research.read.conn.lock().unwrap();
        research_bars::get(&conn, symbol, D, day, day, None)
            .unwrap()
            .first()
            .map(|b| b.close)
    }

    const A: &str = "zerodha:NSE:AAA";
    const B: &str = "zerodha:NSE:BBB";
    const NIFTY: &str = "zerodha:NSE:NIFTY_50";

    #[tokio::test]
    async fn the_first_run_downloads_five_years_and_the_next_session_is_one_quote() {
        let research = ResearchDb::open_in_memory().unwrap();
        let fake = Fake::new(&[(A, 100.0), (B, 50.0), (NIFTY, 20000.0)], at(0, 0));
        let listed = [eq(A), eq(B), index(NIFTY)];

        let first = update(&research, &fake, &listed, at(0, 17)).await.unwrap();
        assert_eq!((first.new_listings, first.downloaded, first.failed), (3, 3, 0));
        let c = research_bars::coverage(&research.read.conn.lock().unwrap(), A, D)
            .unwrap()
            .unwrap();
        assert!(c.from_ms <= history_from(at(0, 17)));
        assert_eq!(close_on(&research, A, at(0, 0)), Some(fake.price(A, at(0, 0))));
        fake.fetched();

        // Tuesday evening: no history call at all, every series topped up from the quote.
        *fake.last_day.lock().unwrap() = at(1, 0);
        let next = update(&research, &fake, &listed, at(1, 17)).await.unwrap();
        assert_eq!((next.downloaded, next.updated, next.refetched), (0, 3, 0));
        assert!(fake.fetched().is_empty(), "no probe and no per-symbol history read");
        assert_eq!(close_on(&research, B, at(1, 0)), Some(fake.price(B, at(1, 0))));
    }

    #[tokio::test]
    async fn a_new_listing_is_downloaded_on_the_day_it_appears() {
        let research = ResearchDb::open_in_memory().unwrap();
        let fake = Fake::new(&[(A, 100.0), (B, 50.0)], at(0, 0));
        update(&research, &fake, &[eq(A)], at(0, 17)).await.unwrap();
        fake.fetched();

        *fake.last_day.lock().unwrap() = at(1, 0);
        let next = update(&research, &fake, &[eq(A), eq(B)], at(1, 17)).await.unwrap();
        assert_eq!((next.new_listings, next.downloaded), (1, 1));
        assert!(
            close_on(&research, B, at(-28, 0)).is_some(),
            "with its history, not just today"
        );
    }

    #[tokio::test]
    async fn a_split_refetches_the_whole_series_instead_of_mixing_prices() {
        let research = ResearchDb::open_in_memory().unwrap();
        let fake = Fake::new(&[(A, 100.0)], at(0, 0));
        update(&research, &fake, &[eq(A)], at(0, 17)).await.unwrap();

        // A 1:2 split: the broker's whole history is halved from Tuesday on.
        *fake.factor.lock().unwrap() = 0.5;
        *fake.last_day.lock().unwrap() = at(1, 0);
        let next = update(&research, &fake, &[eq(A)], at(1, 17)).await.unwrap();
        assert_eq!(next.refetched, 1);
        assert_eq!(
            close_on(&research, A, at(-28, 0)),
            Some(fake.price(A, at(-28, 0))),
            "old prices adjusted too"
        );
        let conn = research.read.conn.lock().unwrap();
        assert!(market_symbols::list(&conn).unwrap()[0].refetched_at.is_some());
    }

    #[tokio::test]
    async fn a_missed_week_is_read_from_history_and_checked_against_what_is_stored() {
        let research = ResearchDb::open_in_memory().unwrap();
        let fake = Fake::new(&[(A, 100.0)], at(0, 0));
        update(&research, &fake, &[eq(A)], at(0, 17)).await.unwrap();

        // A week away: the quote can't fill five sessions, so the tail is read.
        *fake.last_day.lock().unwrap() = at(7, 0);
        let next = update(&research, &fake, &[eq(A)], at(7, 17)).await.unwrap();
        assert_eq!((next.updated, next.refetched), (1, 0));
        assert_eq!(close_on(&research, A, at(3, 0)), Some(fake.price(A, at(3, 0))));

        // The same, after a split during the week: the overlap disagrees, so it's refetched.
        *fake.factor.lock().unwrap() = 0.5;
        *fake.last_day.lock().unwrap() = at(14, 0);
        let later = update(&research, &fake, &[eq(A)], at(14, 17)).await.unwrap();
        assert_eq!(later.refetched, 1);
        assert_eq!(close_on(&research, A, at(3, 0)), Some(fake.price(A, at(3, 0))));
    }

    #[tokio::test]
    async fn a_holiday_is_checked_once_and_every_series_is_marked_current_through_it() {
        let research = ResearchDb::open_in_memory().unwrap();
        let mut fake = Fake::new(&[(A, 100.0), (B, 50.0), (NIFTY, 20000.0)], at(0, 0));
        let listed = [eq(A), eq(B), index(NIFTY)];
        update(&research, &fake, &listed, at(0, 17)).await.unwrap();

        fake.holidays.insert(at(1, 0));
        *fake.last_day.lock().unwrap() = at(1, 0);
        fake.fetched();
        let tuesday = update(&research, &fake, &listed, at(1, 17)).await.unwrap();
        assert!(tuesday.holiday);
        assert_eq!(fake.fetched(), [NIFTY], "one probe, no per-symbol reads");

        // Wednesday's quote top-up sees no gap over the holiday.
        *fake.last_day.lock().unwrap() = at(2, 0);
        let wednesday = update(&research, &fake, &listed, at(2, 17)).await.unwrap();
        assert_eq!(
            (wednesday.updated, wednesday.refetched, wednesday.holiday),
            (3, 0, false)
        );
        assert!(fake.fetched().is_empty());
    }

    #[tokio::test]
    async fn a_lapsed_login_stops_the_run_and_a_stop_is_honoured() {
        let research = ResearchDb::open_in_memory().unwrap();
        let fake = Fake::new(&[(A, 100.0), (B, 50.0)], at(0, 0));
        fake.fail_auth.store(true, Ordering::SeqCst);
        let err = update(&research, &fake, &[eq(A), eq(B)], at(0, 17)).await.unwrap_err();
        assert_eq!(err.code, "auth");

        fake.fail_auth.store(false, Ordering::SeqCst);
        let stop = AtomicBool::new(true);
        let err = run(&research.write, &fake, &[eq(A)], at(0, 17), &stop, &|_| {})
            .await
            .unwrap_err();
        assert_eq!(err.code, "cancelled");
        assert!(fake.fetched().is_empty());
    }
}
