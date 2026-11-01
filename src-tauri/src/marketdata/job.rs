//! One run of "Keep the market loaded": record the listing, read into memory the history it
//! doesn't hold yet (everything, the first time after launch unless the prices are saved; a new
//! listing's, later), then bring every series up to the latest settled session from the batched
//! quote. A series the quote can't update is read from its last final bar; if the broker's copy of
//! that bar has changed (a split), `load_bars` reads the whole series again, so prices from before
//! and after a split are never mixed.
//!
//! The broker sits behind the Python API's own [`Fetcher`] and [`Snapshots`], so a run reuses
//! `load_bars` (coverage-aware reads) and `sync_daily` (the quote top-up), and is tested here with
//! a fake broker. Bars go to memory (and the saved prices behind it, when the user keeps them); the
//! database lock is never held across an await.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use super::plan::{history_from, needs_history, settled_session, was_holiday};
use crate::db::Database;
use crate::market::last_settled_ms;
use crate::pyapi::data::{
    load_bars, normalise_daily, sync_daily, BarsRequest, Fetcher, Snapshots, SyncRequest, SyncStatus,
};
use crate::pyapi::ApiError;
use crate::store::bar_memory::BarMemory;
use crate::store::market_symbols::{self, Listed};

const D: &str = "D";
const DAY_MS: i64 = 86_400_000;

pub trait Broker: Fetcher + Snapshots {}
impl<T: Fetcher + Snapshots> Broker for T {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// Reading history memory doesn't hold.
    History,
    /// The batched quote top-up of every series' latest bar.
    Prices,
    /// Series the quote couldn't update, read from the broker.
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
    /// Series whose history was read into memory.
    pub loaded: usize,
    /// Series brought up to date from the quote.
    pub updated: usize,
    /// Series the quote couldn't update, read from the broker (a split or bonus among them, read
    /// again whole).
    pub reloaded: usize,
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

/// Runs one pass over `listed` (the exchange's current listing, from `plan::universe`). Symbols in
/// `first` (the user's watchlists, the last screens' matches) are read before the rest. Returns
/// early with the error when a failure is fatal, or with [`cancelled`] once `cancel` is set.
#[allow(clippy::too_many_arguments)]
pub async fn run(
    db: &Database,
    memory: &BarMemory,
    broker: &dyn Broker,
    listed: &[Listed],
    first: &[String],
    now: i64,
    cancel: &AtomicBool,
    progress: &(dyn Fn(Progress) + Sync),
) -> Result<Summary, ApiError> {
    let from = history_from(now);
    let mut summary = Summary {
        listed: listed.len(),
        ..Summary::default()
    };
    summary.new_listings = {
        let mut conn = db.conn.lock().map_err(|e| ApiError::internal(e.to_string()))?;
        market_symbols::record_listing(&mut conn, listed, now)?.len()
    };

    // History memory lacks: everything after launch, a new listing later. The user's own symbols first.
    let mut missing: Vec<&str> = listed
        .iter()
        .map(|l| l.symbol.as_str())
        .filter(|s| needs_history(memory.coverage(s, D), from))
        .collect();
    missing.sort_by_key(|s| !first.iter().any(|f| f == s));
    // A symbol the broker just refused isn't asked again in the same run, nor counted twice.
    let mut refused = std::collections::HashSet::new();
    for (i, symbol) in missing.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        progress(Progress {
            phase: Phase::History,
            done: i,
            total: missing.len(),
        });
        match load(memory, broker, symbol, from, now).await {
            Ok(()) => summary.loaded += 1,
            Err(e) if fatal(&e) => return Err(e),
            Err(e) => {
                log::warn!("market data: couldn't load {symbol}: {}", e.message);
                summary.failed += 1;
                refused.insert(symbol.to_string());
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
        memory,
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
    let mut stale = Vec::new();
    let mut no_trade_today = false;
    for r in report.results {
        match r.status {
            SyncStatus::Updated => summary.updated += 1,
            SyncStatus::Fetch if refused.contains(&r.symbol) => {}
            SyncStatus::Fetch => {
                no_trade_today |= r.reason.as_deref() == Some("NotThisSession");
                stale.push(r.symbol);
            }
            SyncStatus::Current | SyncStatus::Skipped => {}
        }
    }

    // Quotes that last traded before the session may mean a weekday holiday, which has no bar to
    // fetch: check once, from one liquid symbol, rather than reading every symbol again.
    if no_trade_today {
        if let Some(probe) = probe_symbol(listed) {
            if holiday(memory, broker, probe, now).await? {
                summary.holiday = true;
                return Ok(summary);
            }
        }
    }

    for (i, symbol) in stale.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        progress(Progress {
            phase: Phase::Corrections,
            done: i,
            total: stale.len(),
        });
        match load(memory, broker, symbol, from, now).await {
            Ok(()) => summary.reloaded += 1,
            Err(e) if fatal(&e) => return Err(e),
            Err(e) => {
                log::warn!("market data: couldn't update {symbol}: {}", e.message);
                summary.failed += 1;
            }
        }
    }
    Ok(summary)
}

/// Reads a symbol's daily history from `from` into memory.
async fn load(memory: &BarMemory, broker: &dyn Broker, symbol: &str, from: i64, now: i64) -> Result<(), ApiError> {
    let request = BarsRequest {
        symbol: symbol.to_string(),
        interval: D.to_string(),
        from_ms: Some(from),
        to_ms: None,
        limit: Some(1),
    };
    load_bars(memory, broker, &request, now).await.map(|_| ())
}

/// NIFTY 50 if it's listed (it trades every session), else the first stock.
fn probe_symbol(listed: &[Listed]) -> Option<&str> {
    listed
        .iter()
        .find(|l| l.symbol.ends_with(":NSE:NIFTY_50") || l.symbol.ends_with(":NSE:NIFTY 50"))
        .or_else(|| listed.iter().find(|l| l.kind == "EQ"))
        .map(|l| l.symbol.as_str())
}

/// Whether the latest settled session was a holiday. If it was, every series that was current up
/// to the session before is marked current through it, so the next session's quote top-up sees no gap.
async fn holiday(memory: &BarMemory, broker: &dyn Broker, probe: &str, now: i64) -> Result<bool, ApiError> {
    let session = settled_session(now);
    if memory
        .coverage(probe, D)
        .is_some_and(|c| c.to_ms >= last_settled_ms(now))
    {
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
    memory.carry_daily_through(last_settled_ms(session - 1), now);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::market::ist_day_start;
    use crate::models::{Bar, DaySnapshot};
    use crate::pyapi::data::{Fetched, Quoted};
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
        /// Symbols the broker refuses outright, with no quote either.
        refuse: HashSet<String>,
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
                refuse: HashSet::new(),
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
                if self.refuse.contains(symbol) {
                    return Err(ApiError::new(400, "bad_request", "invalid token"));
                }
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
                Ok(Fetched {
                    bars,
                    from_ms: from,
                    served_by: None,
                })
            })
        }
    }

    impl Snapshots for Fake {
        fn snapshots<'a>(
            &'a self,
            provider: &'a str,
            tickers: &'a [String],
        ) -> BoxFuture<'a, Result<Quoted, ApiError>> {
            Box::pin(async move {
                // On a holiday the quote is still the last session's.
                let last = *self.last_day.lock().unwrap();
                let traded = self.sessions(last - 10 * DAY_MS, last);
                let days = tickers
                    .iter()
                    .map(|t| {
                        let symbol = format!("{provider}:{t}");
                        if self.refuse.contains(&symbol) {
                            return None;
                        }
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
                    .collect();
                Ok(Quoted { served_by: None, days })
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

    struct World {
        db: Database,
        memory: BarMemory,
    }

    fn world() -> World {
        World {
            db: Database::open_in_memory().unwrap(),
            memory: BarMemory::default(),
        }
    }

    async fn update(w: &World, fake: &Fake, listed: &[Listed], now: i64) -> Result<Summary, ApiError> {
        run(
            &w.db,
            &w.memory,
            fake,
            listed,
            &[],
            now,
            &AtomicBool::new(false),
            &|_| {},
        )
        .await
    }

    fn close_on(w: &World, symbol: &str, day: i64) -> Option<f64> {
        w.memory.get(symbol, D, day, day, None).first().map(|b| b.close)
    }

    const A: &str = "india:NSE:AAA";
    const B: &str = "india:NSE:BBB";
    const NIFTY: &str = "india:NSE:NIFTY_50";

    #[tokio::test]
    async fn the_first_run_loads_five_years_into_memory_and_the_next_session_is_one_quote() {
        let w = world();
        let fake = Fake::new(&[(A, 100.0), (B, 50.0), (NIFTY, 20000.0)], at(0, 0));
        let listed = [eq(A), eq(B), index(NIFTY)];

        let first = update(&w, &fake, &listed, at(0, 17)).await.unwrap();
        assert_eq!((first.new_listings, first.loaded, first.failed), (3, 3, 0));
        assert!(w.memory.coverage(A, D).unwrap().from_ms <= history_from(at(0, 17)));
        assert_eq!(close_on(&w, A, at(0, 0)), Some(fake.price(A, at(0, 0))));
        fake.fetched();

        // Tuesday evening: no history call at all, every series topped up from the quote.
        *fake.last_day.lock().unwrap() = at(1, 0);
        let next = update(&w, &fake, &listed, at(1, 17)).await.unwrap();
        assert_eq!((next.loaded, next.updated, next.reloaded), (0, 3, 0));
        assert!(fake.fetched().is_empty(), "no probe and no per-symbol history read");
        assert_eq!(close_on(&w, B, at(1, 0)), Some(fake.price(B, at(1, 0))));
        assert!(
            w.memory.coverage(A, D).unwrap().from_ms <= history_from(at(0, 17)),
            "the next day's quote extends the history held, never replaces it"
        );
    }

    #[tokio::test]
    async fn the_users_own_symbols_are_read_first() {
        let w = world();
        let fake = Fake::new(&[(A, 100.0), (B, 50.0), (NIFTY, 20000.0)], at(0, 0));
        let listed = [eq(A), eq(B), index(NIFTY)];
        run(
            &w.db,
            &w.memory,
            &fake,
            &listed,
            &[NIFTY.to_string()],
            at(0, 17),
            &AtomicBool::new(false),
            &|_| {},
        )
        .await
        .unwrap();
        assert_eq!(fake.fetched(), [NIFTY, A, B]);
    }

    #[tokio::test]
    async fn after_a_relaunch_memory_is_empty_and_everything_is_read_again() {
        let w = world();
        let fake = Fake::new(&[(A, 100.0)], at(0, 0));
        update(&w, &fake, &[eq(A)], at(0, 17)).await.unwrap();

        // The app closed: memory goes, the symbol list (not prices) stays.
        let relaunched = World {
            db: w.db,
            memory: BarMemory::default(),
        };
        let again = update(&relaunched, &fake, &[eq(A)], at(0, 18)).await.unwrap();
        assert_eq!((again.new_listings, again.loaded), (0, 1));
    }

    #[tokio::test]
    async fn with_saved_prices_a_relaunch_reads_nothing_again() {
        use crate::prices::SavedPrices;
        let dir = std::env::temp_dir().join(format!("protrade-job-saved-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let w = world();
        let fake = Fake::new(&[(A, 100.0), (B, 50.0)], at(0, 0));
        {
            let saved = SavedPrices::new(dir.clone());
            saved.sync(&w.memory, true);
            update(&w, &fake, &[eq(A), eq(B)], at(0, 17)).await.unwrap();
            saved.close();
        }
        fake.fetched();

        let relaunched = World {
            db: w.db,
            memory: BarMemory::default(),
        };
        let saved = SavedPrices::new(dir.clone());
        saved.sync(&relaunched.memory, true);
        let again = update(&relaunched, &fake, &[eq(A), eq(B)], at(0, 18)).await.unwrap();
        assert_eq!((again.loaded, again.reloaded), (0, 0));
        assert!(fake.fetched().is_empty(), "nothing asked of the broker");
        assert_eq!(close_on(&relaunched, A, at(-28, 0)), Some(fake.price(A, at(-28, 0))));
        saved.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_new_listing_is_loaded_on_the_day_it_appears() {
        let w = world();
        let fake = Fake::new(&[(A, 100.0), (B, 50.0)], at(0, 0));
        update(&w, &fake, &[eq(A)], at(0, 17)).await.unwrap();
        fake.fetched();

        *fake.last_day.lock().unwrap() = at(1, 0);
        let next = update(&w, &fake, &[eq(A), eq(B)], at(1, 17)).await.unwrap();
        assert_eq!((next.new_listings, next.loaded), (1, 1));
        assert!(
            close_on(&w, B, at(-28, 0)).is_some(),
            "with its history, not just today"
        );
    }

    #[tokio::test]
    async fn a_split_reads_the_whole_series_again_instead_of_mixing_prices() {
        let w = world();
        let fake = Fake::new(&[(A, 100.0)], at(0, 0));
        update(&w, &fake, &[eq(A)], at(0, 17)).await.unwrap();

        // A 1:2 split: the broker's whole history is halved from Tuesday on.
        *fake.factor.lock().unwrap() = 0.5;
        *fake.last_day.lock().unwrap() = at(1, 0);
        let next = update(&w, &fake, &[eq(A)], at(1, 17)).await.unwrap();
        assert_eq!(next.reloaded, 1);
        assert_eq!(
            close_on(&w, A, at(-28, 0)),
            Some(fake.price(A, at(-28, 0))),
            "old prices adjusted too"
        );
    }

    #[tokio::test]
    async fn a_missed_week_is_read_from_the_last_bar_held() {
        let w = world();
        let fake = Fake::new(&[(A, 100.0)], at(0, 0));
        update(&w, &fake, &[eq(A)], at(0, 17)).await.unwrap();
        let from = w.memory.coverage(A, D).unwrap().from_ms;

        // A week left open without an update: the quote can't fill five sessions.
        *fake.last_day.lock().unwrap() = at(7, 0);
        let next = update(&w, &fake, &[eq(A)], at(7, 17)).await.unwrap();
        assert_eq!(next.reloaded, 1);
        assert_eq!(close_on(&w, A, at(3, 0)), Some(fake.price(A, at(3, 0))));
        assert_eq!(
            w.memory.coverage(A, D).unwrap().from_ms,
            from,
            "the history held is kept"
        );
    }

    #[tokio::test]
    async fn a_holiday_is_checked_once_and_every_series_is_marked_current_through_it() {
        let w = world();
        let mut fake = Fake::new(&[(A, 100.0), (B, 50.0), (NIFTY, 20000.0)], at(0, 0));
        let listed = [eq(A), eq(B), index(NIFTY)];
        update(&w, &fake, &listed, at(0, 17)).await.unwrap();

        fake.holidays.insert(at(1, 0));
        *fake.last_day.lock().unwrap() = at(1, 0);
        fake.fetched();
        let tuesday = update(&w, &fake, &listed, at(1, 17)).await.unwrap();
        assert!(tuesday.holiday);
        assert_eq!(fake.fetched(), [NIFTY], "one probe, no per-symbol reads");

        // Wednesday's quote top-up sees no gap over the holiday.
        *fake.last_day.lock().unwrap() = at(2, 0);
        let wednesday = update(&w, &fake, &listed, at(2, 17)).await.unwrap();
        assert_eq!(
            (wednesday.updated, wednesday.reloaded, wednesday.holiday),
            (3, 0, false)
        );
        assert!(fake.fetched().is_empty());
    }

    #[tokio::test]
    async fn a_symbol_the_broker_refuses_is_counted_once_and_not_asked_again() {
        let w = world();
        // Listed, but the broker refuses it (as Kite does an instrument it no longer serves).
        let mut fake = Fake::new(&[(A, 100.0)], at(0, 0));
        fake.refuse.insert("india:NSE:GONE".to_string());
        let s = update(&w, &fake, &[eq(A), eq("india:NSE:GONE")], at(0, 17))
            .await
            .unwrap();
        assert_eq!((s.loaded, s.failed, s.reloaded), (1, 1, 0));
        let asked = fake.fetched();
        assert_eq!(asked.iter().filter(|f| *f == "india:NSE:GONE").count(), 1);
    }

    #[tokio::test]
    async fn a_lapsed_login_stops_the_run_and_a_stop_is_honoured() {
        let w = world();
        let fake = Fake::new(&[(A, 100.0), (B, 50.0)], at(0, 0));
        fake.fail_auth.store(true, Ordering::SeqCst);
        let err = update(&w, &fake, &[eq(A), eq(B)], at(0, 17)).await.unwrap_err();
        assert_eq!(err.code, "auth");

        fake.fail_auth.store(false, Ordering::SeqCst);
        let stop = AtomicBool::new(true);
        let err = run(&w.db, &w.memory, &fake, &[eq(A)], &[], at(0, 17), &stop, &|_| {})
            .await
            .unwrap_err();
        assert_eq!(err.code, "cancelled");
        assert!(fake.fetched().is_empty());
    }
}
