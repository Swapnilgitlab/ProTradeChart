//! "Bars for this symbol and range", answered from the research store and topped up
//! from the broker only where the store is missing or out of date.
//!
//! No HTTP and no Tauri here: the broker sits behind [`Fetcher`], so the whole policy is
//! tested with a fake one. The database lock is only ever held between awaits.

use std::collections::HashMap;

use futures::future::BoxFuture;

use super::{split_symbol, ApiError};
use crate::db::Database;
use crate::market::{ist_day_start, SESSION_MINUTES};
use crate::models::{Bar, DaySnapshot};
use crate::store::day_topup::{candidate, snapshot_bar, Candidate};
use crate::store::research_bars::{self as store, interval_ms, Range};

const MINUTE_MS: i64 = 60_000;
const DAY_MS: i64 = 86_400_000;

/// How many bars a request gets when it names neither a start nor a limit.
pub const DEFAULT_LIMIT: usize = 500;
/// The most bars one response carries.
pub const MAX_LIMIT: usize = 500_000;

/// What a broker gave back for one range.
pub struct Fetched {
    pub bars: Vec<Bar>,
    /// Where the fetch really started. A broker caps how much one call may span, and the
    /// clients answer an over-long range with only its newest part, so this can be later
    /// than the start that was asked for. The store records what it got, not what it hoped.
    pub from_ms: i64,
}

/// Asks a broker for bars. Errors are already in the client's terms.
pub trait Fetcher: Send + Sync {
    fn fetch<'a>(
        &'a self,
        symbol: &'a str,
        interval: &'a str,
        from_ms: i64,
        to_ms: i64,
    ) -> BoxFuture<'a, Result<Fetched, ApiError>>;
}

/// Asks a broker for a batch of quote-based day snapshots, one per `tickers` entry, in order —
/// `None` for one it had nothing for. `tickers` are the broker's own form (`split_symbol`'s
/// second half), not the full `provider:TICKER` symbol.
pub trait Snapshots: Send + Sync {
    fn snapshots<'a>(
        &'a self,
        provider: &'a str,
        tickers: &'a [String],
    ) -> BoxFuture<'a, Result<Vec<Option<DaySnapshot>>, ApiError>>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BarsRequest {
    /// `zerodha:NSE:RELIANCE`.
    pub symbol: String,
    /// The store's spelling: `D`, `1`, `5`, …
    pub interval: String,
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
    /// The newest this many bars.
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BarsData {
    pub bars: Vec<Bar>,
    pub timezone: String,
    /// The span of this series that is known to be complete.
    pub covered_from_ms: i64,
    pub covered_to_ms: i64,
    /// Set when the broker would not serve as far back as was asked: the date the data
    /// really starts at. (A stock that listed later than the start is not "limited".)
    pub limited_from_ms: Option<i64>,
}

/// Puts daily bars on IST midnight of their date, whichever instant of that day the broker
/// stamped them with, so a date range selects the same bars for every broker.
pub fn normalise_daily(bars: &mut Vec<Bar>) {
    for b in bars.iter_mut() {
        b.time = ist_day_start(b.time);
    }
    bars.sort_by_key(|b| b.time);
    bars.dedup_by_key(|b| b.time);
}

/// Daily spans are rounded up to whole blocks of this length. Two screens that ask for
/// 250 and 257 bars would otherwise begin ten days apart, and the second would spend a
/// whole broker request per symbol on the few days the first fell short of.
const DAILY_LOOKBACK_STEP_MS: i64 = 90 * DAY_MS;

/// A span long enough to hold `limit` bars ending now, allowing for nights, weekends and
/// holidays. Generous on purpose: the newest `limit` bars are kept afterwards.
pub fn lookback_ms(interval: &str, limit: usize) -> i64 {
    let limit = limit.max(1) as i64;
    match interval_ms(interval) {
        // Not rounded: a longer intraday span means more requests, not fewer.
        Some(bar) if interval != "D" => {
            let per_session = (SESSION_MINUTES * MINUTE_MS / bar).max(1);
            let sessions = (limit + per_session - 1) / per_session;
            (sessions * 3 / 2 + 10) * DAY_MS
        }
        _ => {
            let span = (limit * 3 / 2 + 10) * DAY_MS;
            (span + DAILY_LOOKBACK_STEP_MS - 1) / DAILY_LOOKBACK_STEP_MS * DAILY_LOOKBACK_STEP_MS
        }
    }
}

fn locked<T>(db: &Database, f: impl FnOnce(&mut rusqlite::Connection) -> rusqlite::Result<T>) -> Result<T, ApiError> {
    let mut conn = db.conn.lock().map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(f(&mut conn)?)
}

/// The `[from, to]` a request resolves to: `to` is `now` (or the requested end, clamped to it;
/// daily rounds up to the end of its calendar day), `from` is the requested start or a lookback
/// long enough for `limit` bars (daily rounds down to midnight). Shared by [`load_bars`] and
/// [`sync_daily`] so a sync plans exactly what the per-symbol read that follows it will plan.
pub fn span(interval: &str, from_ms: Option<i64>, to_ms: Option<i64>, limit: Option<usize>, now_ms: i64) -> (i64, i64) {
    let daily = interval == "D";
    let mut to = to_ms.unwrap_or(now_ms);
    if daily {
        to = ist_day_start(to) + DAY_MS - 1;
    }
    let to = to.min(now_ms);
    let mut from = from_ms.unwrap_or_else(|| to - lookback_ms(interval, limit.unwrap_or(DEFAULT_LIMIT)));
    if daily {
        from = ist_day_start(from);
    }
    (from, to)
}

/// Bars for a request. Reads the store, asks `fetcher` for the ranges the store lacks,
/// records what it got, and answers from the store.
pub async fn load_bars(
    db: &Database,
    fetcher: &dyn Fetcher,
    req: &BarsRequest,
    now_ms: i64,
) -> Result<BarsData, ApiError> {
    let daily = req.interval == "D";
    let (from, to) = span(&req.interval, req.from_ms, req.to_ms, req.limit, now_ms);

    let coverage = locked(db, |c| store::coverage(c, &req.symbol, &req.interval))?;
    for range in store::plan(coverage, &req.interval, from, to, now_ms) {
        let fetched = fetcher
            .fetch(&req.symbol, &req.interval, range.from_ms, range.to_ms)
            .await?;
        let mut bars = fetched.bars;
        if daily {
            normalise_daily(&mut bars);
        }
        let done = Range {
            from_ms: fetched.from_ms.max(range.from_ms),
            to_ms: range.to_ms,
        };
        locked(db, |c| {
            store::put(c, &req.symbol, &req.interval, &bars)?;
            store::extend_coverage(c, &req.symbol, &req.interval, done, now_ms)?;
            Ok(())
        })?;
    }

    let coverage = locked(db, |c| store::coverage(c, &req.symbol, &req.interval))?;
    // Never answer with bars from outside the span known to be complete.
    let (start, end) = match coverage {
        Some(c) => (from.max(c.from_ms), to.min(c.to_ms)),
        None => (from, to),
    };
    let newest = match (req.limit, req.from_ms) {
        (Some(n), _) => n,
        (None, None) => DEFAULT_LIMIT,
        (None, Some(_)) => MAX_LIMIT,
    }
    .min(MAX_LIMIT);
    let bars = if start > end {
        Vec::new()
    } else {
        locked(db, |c| {
            store::get(c, &req.symbol, &req.interval, start, end, Some(newest))
        })?
    };

    Ok(BarsData {
        bars,
        timezone: "Asia/Kolkata".to_string(),
        covered_from_ms: coverage.map_or(from, |c| c.from_ms),
        covered_to_ms: coverage.map_or(to, |c| c.to_ms),
        limited_from_ms: coverage.filter(|c| c.from_ms > from).map(|c| c.from_ms),
    })
}

// ---- The panel: many symbols' stored bars in one read -----------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PanelRequest {
    pub symbols: Vec<String>,
    pub interval: String,
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
    /// The newest this many bars per symbol.
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PanelSeries {
    pub symbol: String,
    pub bars: Vec<Bar>,
    pub coverage: Option<store::Coverage>,
    /// The store already holds everything this request covers, up to the latest settled session:
    /// a `/v1/bars` read of the same span would fetch nothing from the broker.
    pub current: bool,
}

/// Each symbol's stored bars for the request, from the store alone — the broker is never asked.
/// A series that isn't `current` is the caller's to read through `/v1/bars`, which tops it up.
pub fn read_panel(conn: &rusqlite::Connection, req: &PanelRequest, now_ms: i64) -> Result<Vec<PanelSeries>, ApiError> {
    let (from, to) = span(&req.interval, req.from_ms, req.to_ms, req.limit, now_ms);
    let newest = req.limit.unwrap_or(MAX_LIMIT).min(MAX_LIMIT);
    let mut out = Vec::with_capacity(req.symbols.len());
    for symbol in &req.symbols {
        let coverage = store::coverage(conn, symbol, &req.interval)?;
        let current = coverage.is_some() && store::plan(coverage, &req.interval, from, to, now_ms).is_empty();
        let bars = match coverage {
            Some(c) if from.max(c.from_ms) <= to.min(c.to_ms) => store::get(
                conn,
                symbol,
                &req.interval,
                from.max(c.from_ms),
                to.min(c.to_ms),
                Some(newest),
            )?,
            _ => Vec::new(),
        };
        out.push(PanelSeries {
            symbol: symbol.clone(),
            bars,
            coverage,
            current,
        });
    }
    Ok(out)
}

// ---- The daily quote top-up (the Screener's speed fix) --------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncRequest {
    pub symbols: Vec<String>,
    pub interval: String,
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SyncStatus {
    /// Already covers what was asked for: nothing needed doing.
    #[default]
    Current,
    /// A quote topped up today's (or the last settled session's) bar.
    Updated,
    /// A quote top-up wasn't possible, or the quote it got wasn't trusted: the caller's ordinary
    /// per-symbol read will fetch it from the historical endpoint instead, as it always has.
    Fetch,
    /// Not a symbol this sync even tries a quote for (not `provider:ticker`, or a provider with
    /// no quote top-up) — the ordinary per-symbol read still handles it.
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncResult {
    pub symbol: String,
    pub status: SyncStatus,
    /// Why, for `Fetch` and `Skipped` — never required, only ever informational.
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SyncReport {
    pub results: Vec<SyncResult>,
}

const TOPUP_PROVIDERS: [&str; 1] = ["zerodha"];

/// Brings as many of `req.symbols`' daily coverage up to date as a batched broker quote safely
/// can, instead of the historical endpoint's one-rate-limited-call-per-symbol. Only
/// [`crate::store::day_topup::candidate`]-eligible symbols (daily, deep history already cached,
/// only the latest session missing) are even tried; everything else is reported `Current`,
/// `Fetch` or `Skipped` and left for the caller's unchanged per-symbol `load_bars` loop — this
/// never replaces that path, only short-circuits it where it is safe to. A provider's quote call
/// failing marks only that provider's symbols `Fetch`; the other provider is unaffected.
pub async fn sync_daily(db: &Database, snaps: &dyn Snapshots, req: &SyncRequest, now_ms: i64) -> SyncReport {
    let (from, to) = span(&req.interval, req.from_ms, req.to_ms, req.limit, now_ms);

    let mut results = Vec::with_capacity(req.symbols.len());
    // provider -> [(symbol, ticker, candidate)], built while every symbol not eligible for a
    // quote top-up is resolved straight away.
    let mut by_provider: HashMap<&'static str, Vec<(String, String, Candidate)>> = HashMap::new();

    for symbol in &req.symbols {
        let resolved =
            split_symbol(symbol).and_then(|(p, t)| TOPUP_PROVIDERS.iter().find(|&&tp| tp == p).map(|&tp| (tp, t)));
        let Some((provider, ticker)) = resolved else {
            results.push(SyncResult {
                symbol: symbol.clone(),
                status: SyncStatus::Skipped,
                reason: Some("not a symbol a quote top-up covers".to_string()),
            });
            continue;
        };
        let coverage = match locked(db, |c| store::coverage(c, symbol, &req.interval)) {
            Ok(c) => c,
            Err(e) => {
                results.push(SyncResult {
                    symbol: symbol.clone(),
                    status: SyncStatus::Fetch,
                    reason: Some(e.message),
                });
                continue;
            }
        };
        match candidate(coverage, &req.interval, from, to, now_ms) {
            Some(cand) => by_provider
                .entry(provider)
                .or_default()
                .push((symbol.clone(), ticker.to_string(), cand)),
            None => {
                let current = store::plan(coverage, &req.interval, from, to, now_ms).is_empty();
                results.push(SyncResult {
                    symbol: symbol.clone(),
                    status: if current {
                        SyncStatus::Current
                    } else {
                        SyncStatus::Fetch
                    },
                    reason: None,
                });
            }
        }
    }

    for (provider, group) in by_provider {
        let tickers: Vec<String> = group.iter().map(|(_, ticker, _)| ticker.clone()).collect();
        match snaps.snapshots(provider, &tickers).await {
            Ok(snapshots) => {
                for ((symbol, _ticker, cand), snapshot) in group.into_iter().zip(snapshots) {
                    results.push(apply_snapshot(db, &symbol, &req.interval, &cand, snapshot, now_ms));
                }
            }
            Err(e) => {
                for (symbol, _, _) in group {
                    results.push(SyncResult {
                        symbol,
                        status: SyncStatus::Fetch,
                        reason: Some(e.message.clone()),
                    });
                }
            }
        }
    }
    SyncReport { results }
}

/// Checks and, if it passes, stores one symbol's snapshot as `candidate`'s day's bar. Any failure
/// — no snapshot, a rejected one, or a store error — reports `Fetch`: the store is left exactly
/// as it was unless the bar is actually written.
fn apply_snapshot(
    db: &Database,
    symbol: &str,
    interval: &str,
    candidate: &Candidate,
    snapshot: Option<DaySnapshot>,
    now_ms: i64,
) -> SyncResult {
    let fetch = |reason: String| SyncResult {
        symbol: symbol.to_string(),
        status: SyncStatus::Fetch,
        reason: Some(reason),
    };
    let Some(snapshot) = snapshot else {
        return fetch("no quote for it".to_string());
    };
    let prior = match locked(db, |c| {
        store::get(c, symbol, interval, i64::MIN, candidate.session_day - 1, Some(1))
    }) {
        Ok(bars) => bars.into_iter().next(),
        Err(e) => return fetch(e.message),
    };
    let bar = match snapshot_bar(candidate, &snapshot, prior.as_ref()) {
        Ok(bar) => bar,
        Err(reject) => return fetch(format!("{reject:?}")),
    };
    let written = locked(db, |c| {
        store::put(c, symbol, interval, std::slice::from_ref(&bar))?;
        store::extend_coverage(
            c,
            symbol,
            interval,
            Range {
                from_ms: candidate.session_day,
                to_ms: now_ms,
            },
            now_ms,
        )?;
        Ok(())
    });
    match written {
        Ok(()) => SyncResult {
            symbol: symbol.to_string(),
            status: SyncStatus::Updated,
            reason: None,
        },
        Err(e) => fetch(e.message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::market::IST_OFFSET_MS;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    /// 2027-01-15 13:30 IST, a Friday afternoon.
    const NOW: i64 = 1_800_000_000_000;
    const SYM: &str = "zerodha:NSE:RELIANCE";

    /// A broker holding one bar per calendar day (stamped at midday IST, not midnight, to
    /// prove daily bars are normalised) for the 100 days before `NOW`.
    struct Fake {
        bars: Vec<Bar>,
        calls: Mutex<Vec<(i64, i64)>>,
        fail: AtomicBool,
        /// Simulates a broker cap: no fetch reaches back further than this.
        earliest: Option<i64>,
    }

    fn day_bar(day: i64) -> Bar {
        Bar {
            time: ist_day_start(NOW) + (day - 100) * DAY_MS + 12 * 3_600_000,
            open: 100.0 + day as f64,
            high: 110.0,
            low: 90.0,
            close: 100.0 + day as f64,
            volume: Some(1000.0),
        }
    }

    fn fake() -> Fake {
        Fake {
            bars: (0..100).map(day_bar).collect(),
            calls: Mutex::new(Vec::new()),
            fail: AtomicBool::new(false),
            earliest: None,
        }
    }

    impl Fake {
        fn calls(&self) -> Vec<(i64, i64)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Fetcher for Fake {
        fn fetch<'a>(
            &'a self,
            _symbol: &'a str,
            _interval: &'a str,
            from_ms: i64,
            to_ms: i64,
        ) -> BoxFuture<'a, Result<Fetched, ApiError>> {
            Box::pin(async move {
                self.calls.lock().unwrap().push((from_ms, to_ms));
                if self.fail.load(Ordering::SeqCst) {
                    return Err(ApiError::new(401, "auth", "token expired"));
                }
                let from = self.earliest.map_or(from_ms, |e| e.max(from_ms));
                let bars = self
                    .bars
                    .iter()
                    .filter(|b| b.time >= from && b.time <= to_ms)
                    .cloned()
                    .collect();
                Ok(Fetched { bars, from_ms: from })
            })
        }
    }

    fn request(from_days_ago: Option<i64>, limit: Option<usize>) -> BarsRequest {
        BarsRequest {
            symbol: SYM.to_string(),
            interval: "D".to_string(),
            from_ms: from_days_ago.map(|d| NOW - d * DAY_MS),
            to_ms: None,
            limit,
        }
    }

    async fn load(db: &Database, f: &Fake, req: &BarsRequest, now: i64) -> Result<BarsData, ApiError> {
        load_bars(db, f, req, now).await
    }

    #[test]
    fn a_lookback_is_long_enough_for_the_bars_asked_for() {
        // 250 trading days is about 350 calendar days; the estimate must not fall short.
        assert!(lookback_ms("D", 250) >= 350 * DAY_MS);
        // A five-minute bar: 75 to a session, so 750 bars is ten sessions (two weeks).
        assert!(lookback_ms("5", 750) >= 14 * DAY_MS);
        assert!(lookback_ms("D", 1) >= DAY_MS);
    }

    #[test]
    fn screens_asking_for_slightly_different_depths_start_on_the_same_date() {
        // The measured case: 250 bars (a 200-day average) and 257 (a 52-week high).
        assert_eq!(lookback_ms("D", 250), lookback_ms("D", 257));
        assert_eq!(lookback_ms("D", 250), 450 * DAY_MS);
        // Rounding only ever lengthens a span.
        for limit in [1, 20, 90, 250, 257, 1_000, 5_000] {
            let exact = (limit as i64 * 3 / 2 + 10) * DAY_MS;
            let rounded = lookback_ms("D", limit);
            assert!(rounded >= exact && rounded - exact < 90 * DAY_MS, "{limit}");
        }
    }

    #[test]
    fn an_intraday_span_is_not_inflated() {
        // 750 five-minute bars: ten sessions, so 25 days.
        assert_eq!(lookback_ms("5", 750), 25 * DAY_MS);
    }

    #[test]
    fn daily_bars_land_on_ist_midnight_whatever_the_broker_stamped() {
        let midnight = ist_day_start(NOW);
        let mut bars = vec![
            Bar {
                time: midnight + 12 * 3_600_000,
                ..day_bar(50)
            },
            Bar {
                time: midnight + 5 * 3_600_000 + 30 * 60_000,
                ..day_bar(51)
            },
            Bar {
                time: midnight - DAY_MS + 3_600_000,
                ..day_bar(49)
            },
        ];
        normalise_daily(&mut bars);
        assert_eq!(
            bars.iter().map(|b| b.time).collect::<Vec<_>>(),
            [midnight - DAY_MS, midnight]
        );
        assert_eq!((midnight + IST_OFFSET_MS) % DAY_MS, 0);
    }

    #[tokio::test]
    async fn a_first_request_fetches_stores_and_answers() {
        let db = Database::open_in_memory().unwrap();
        let f = fake();
        let out = load(&db, &f, &request(Some(30), None), NOW).await.unwrap();

        assert_eq!(f.calls().len(), 1);
        assert_eq!(out.bars.len(), 30, "one bar per day for the last 30 days");
        assert!(out.bars.windows(2).all(|w| w[0].time < w[1].time));
        assert!(
            out.bars.iter().all(|b| (b.time + IST_OFFSET_MS) % DAY_MS == 0),
            "on IST midnight"
        );
        assert_eq!(out.timezone, "Asia/Kolkata");
        assert_eq!(out.limited_from_ms, None);
    }

    #[tokio::test]
    async fn asking_again_within_the_ttl_does_not_touch_the_broker() {
        let db = Database::open_in_memory().unwrap();
        let f = fake();
        let first = load(&db, &f, &request(Some(30), None), NOW).await.unwrap();
        let again = load(&db, &f, &request(Some(30), None), NOW + 60_000).await.unwrap();

        assert_eq!(f.calls().len(), 1, "the second request came from the store");
        assert_eq!(again.bars, first.bars);
    }

    #[tokio::test]
    async fn after_the_ttl_only_the_recent_tail_is_fetched_again() {
        let db = Database::open_in_memory().unwrap();
        let f = fake();
        load(&db, &f, &request(Some(30), None), NOW).await.unwrap();
        let later = NOW + 10 * MINUTE_MS;
        load(&db, &f, &request(Some(30), None), later).await.unwrap();

        let calls = f.calls();
        assert_eq!(calls.len(), 2);
        assert!(
            calls[1].0 > calls[0].0,
            "the refresh starts near the end, not at the start again"
        );
        assert_eq!(calls[1].1, later);
    }

    #[tokio::test]
    async fn the_evening_after_a_session_costs_one_refresh_and_then_the_broker_is_left_alone() {
        let db = Database::open_in_memory().unwrap();
        let f = fake();
        // Read mid-session on a Friday, so today's bar was still forming.
        load(&db, &f, &request(Some(30), None), NOW).await.unwrap();

        let evening = NOW + 4 * 60 * MINUTE_MS;
        load(&db, &f, &request(Some(30), None), evening).await.unwrap();
        assert_eq!(f.calls().len(), 2, "the settled bar is fetched once");

        // A run an hour later, on Saturday and on Sunday: nothing new can exist.
        for now in [evening + 60 * MINUTE_MS, NOW + DAY_MS, NOW + 2 * DAY_MS] {
            load(&db, &f, &request(Some(30), None), now).await.unwrap();
        }
        assert_eq!(f.calls().len(), 2, "no further broker calls until Monday");
    }

    #[tokio::test]
    async fn a_screen_asking_for_a_slightly_deeper_history_reuses_what_the_first_fetched() {
        // The measured case: 250 bars (a 200-day average), then 257 (a 52-week high). Each
        // symbol used to need a second broker request for the few days between them.
        let db = Database::open_in_memory().unwrap();
        let f = fake();
        load(&db, &f, &request(None, Some(250)), NOW).await.unwrap();
        load(&db, &f, &request(None, Some(257)), NOW + 1_000).await.unwrap();
        assert_eq!(f.calls().len(), 1);
    }

    #[tokio::test]
    async fn older_history_is_fetched_only_for_the_part_not_held() {
        let db = Database::open_in_memory().unwrap();
        let f = fake();
        load(&db, &f, &request(Some(30), None), NOW).await.unwrap();
        let out = load(&db, &f, &request(Some(60), None), NOW + 1_000).await.unwrap();

        let calls = f.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(
            calls[1].1,
            ist_day_start(NOW - 30 * DAY_MS),
            "up to what was already held"
        );
        assert_eq!(out.bars.len(), 60);
    }

    #[tokio::test]
    async fn a_limit_keeps_the_newest_bars() {
        let db = Database::open_in_memory().unwrap();
        let f = fake();
        let out = load(&db, &f, &request(None, Some(10)), NOW).await.unwrap();
        assert_eq!(out.bars.len(), 10);
        assert_eq!(out.bars.last().unwrap().close, 100.0 + 99.0, "ends at the latest bar");
    }

    #[tokio::test]
    async fn a_broker_that_will_not_go_back_far_enough_is_reported_and_not_pretended_about() {
        let db = Database::open_in_memory().unwrap();
        let mut f = fake();
        f.earliest = Some(ist_day_start(NOW) - 20 * DAY_MS);
        let out = load(&db, &f, &request(Some(60), None), NOW).await.unwrap();

        assert_eq!(out.bars.len(), 20, "only what the broker served");
        assert_eq!(out.limited_from_ms, Some(ist_day_start(NOW) - 20 * DAY_MS));
        assert_eq!(out.covered_from_ms, ist_day_start(NOW) - 20 * DAY_MS);
    }

    #[tokio::test]
    async fn a_failed_fetch_is_reported_and_leaves_the_store_as_it_was() {
        let db = Database::open_in_memory().unwrap();
        let f = fake();
        f.fail.store(true, Ordering::SeqCst);
        let err = load(&db, &f, &request(Some(30), None), NOW).await.unwrap_err();
        assert_eq!((err.status, err.code), (401, "auth"));

        let conn = db.conn.lock().unwrap();
        assert_eq!(
            store::coverage(&conn, SYM, "D").unwrap(),
            None,
            "nothing was claimed as covered"
        );
        assert_eq!(store::stats(&conn).unwrap().bars, 0);
    }

    #[tokio::test]
    async fn a_symbol_the_broker_has_nothing_for_is_an_empty_answer_not_an_error() {
        let db = Database::open_in_memory().unwrap();
        let mut f = fake();
        f.bars.clear();
        let out = load(&db, &f, &request(Some(30), None), NOW).await.unwrap();
        assert!(out.bars.is_empty());
        // Asking again must not go back to the broker for a span already known to be empty.
        load(&db, &f, &request(Some(30), None), NOW + 1_000).await.unwrap();
        assert_eq!(f.calls().len(), 1);
    }

    #[tokio::test]
    async fn a_daily_range_is_by_calendar_date_so_the_boundary_bar_is_included() {
        let db = Database::open_in_memory().unwrap();
        let f = fake();
        // `from` a few hours into a date and `to` a few hours into a later one: both dates count.
        let from = ist_day_start(NOW) - 10 * DAY_MS + 9 * 3_600_000;
        let to = ist_day_start(NOW) - 5 * DAY_MS + 9 * 3_600_000;
        let req = BarsRequest {
            symbol: SYM.to_string(),
            interval: "D".to_string(),
            from_ms: Some(from),
            to_ms: Some(to),
            limit: None,
        };
        let out = load(&db, &f, &req, NOW).await.unwrap();
        assert_eq!(out.bars.len(), 6, "days -10 through -5 inclusive");
        assert_eq!(out.bars[0].time, ist_day_start(NOW) - 10 * DAY_MS);
    }

    // ---- sync_daily (the quote top-up) -----------------------------------------------------

    #[derive(Default)]
    struct FakeSnapshots {
        by_ticker: Mutex<HashMap<(String, String), DaySnapshot>>,
        fail: Mutex<HashMap<String, ApiError>>,
        calls: Mutex<Vec<(String, Vec<String>)>>,
    }

    impl FakeSnapshots {
        fn set(&self, provider: &str, ticker: &str, snap: DaySnapshot) {
            self.by_ticker
                .lock()
                .unwrap()
                .insert((provider.to_string(), ticker.to_string()), snap);
        }

        fn fail_provider(&self, provider: &str, e: ApiError) {
            self.fail.lock().unwrap().insert(provider.to_string(), e);
        }

        fn calls(&self) -> Vec<(String, Vec<String>)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Snapshots for FakeSnapshots {
        fn snapshots<'a>(
            &'a self,
            provider: &'a str,
            tickers: &'a [String],
        ) -> BoxFuture<'a, Result<Vec<Option<DaySnapshot>>, ApiError>> {
            Box::pin(async move {
                self.calls
                    .lock()
                    .unwrap()
                    .push((provider.to_string(), tickers.to_vec()));
                if let Some(e) = self.fail.lock().unwrap().get(provider) {
                    return Err(e.clone());
                }
                let map = self.by_ticker.lock().unwrap();
                Ok(tickers
                    .iter()
                    .map(|t| map.get(&(provider.to_string(), t.clone())).copied())
                    .collect())
            })
        }
    }

    /// A good quote for the day `fake()`'s history leaves missing: previous close matches
    /// `day_bar(99)` (the stored bar for the day before), traded on `candidate`'s own day.
    fn good_quote(traded_at_ms: i64) -> DaySnapshot {
        DaySnapshot {
            open: 200.0,
            high: 205.0,
            low: 198.0,
            last: 203.0,
            previous_close: Some(199.0),
            volume: Some(5_000.0),
            traded_at_ms: Some(traded_at_ms),
        }
    }

    /// Past Friday's settlement, same calendar day as `NOW`: the moment a re-read after close
    /// asks for a trustworthy quote (mirrors `the_evening_after_a_session_...` above).
    fn evening() -> i64 {
        NOW + 4 * 60 * MINUTE_MS
    }

    /// The one request shape every `sync_daily` test below uses: the same span `fake()`'s
    /// 30-day history was loaded with, so `candidate()` sees exactly the tail gap.
    fn sync_request(symbols: Vec<String>) -> SyncRequest {
        SyncRequest {
            symbols,
            interval: "D".to_string(),
            from_ms: Some(ist_day_start(NOW - 30 * DAY_MS)),
            to_ms: None,
            limit: None,
        }
    }

    #[tokio::test]
    async fn a_candidate_symbol_is_topped_up_from_a_quote_and_needs_no_further_historical_fetch() {
        let db = Database::open_in_memory().unwrap();
        let f = fake();
        load(&db, &f, &request(Some(30), None), NOW).await.unwrap();
        assert_eq!(f.calls().len(), 1);

        let snaps = FakeSnapshots::default();
        snaps.set("zerodha", "NSE:RELIANCE", good_quote(evening() - 1_000));

        let report = sync_daily(&db, &snaps, &sync_request(vec![SYM.to_string()]), evening()).await;
        assert_eq!(report.results.len(), 1);
        assert_eq!(report.results[0].status, SyncStatus::Updated);
        assert_eq!(
            snaps.calls(),
            vec![("zerodha".to_string(), vec!["NSE:RELIANCE".to_string()])]
        );

        // The quote already wrote today's bar: re-reading the same span touches no broker.
        let out = load(&db, &f, &request(Some(30), None), evening()).await.unwrap();
        assert_eq!(f.calls().len(), 1, "the historical fetcher was never asked again");
        assert_eq!(out.bars.last().unwrap().time, ist_day_start(NOW));
        assert_eq!(out.bars.last().unwrap().close, 203.0, "today's bar came from the quote");
    }

    #[tokio::test]
    async fn an_already_current_symbol_needs_no_quote_at_all() {
        let db = Database::open_in_memory().unwrap();
        let f = fake();
        load(&db, &f, &request(Some(30), None), NOW).await.unwrap();

        let snaps = FakeSnapshots::default();
        // A minute later, still mid-session and well inside the daily TTL: nothing changed.
        let report = sync_daily(&db, &snaps, &sync_request(vec![SYM.to_string()]), NOW + 60_000).await;
        assert_eq!(report.results[0].status, SyncStatus::Current);
        assert!(snaps.calls().is_empty());
    }

    #[tokio::test]
    async fn a_never_fetched_symbol_is_left_for_the_historical_endpoint() {
        let db = Database::open_in_memory().unwrap();
        let snaps = FakeSnapshots::default();
        let report = sync_daily(&db, &snaps, &sync_request(vec![SYM.to_string()]), NOW).await;
        assert_eq!(report.results[0].status, SyncStatus::Fetch);
        assert!(
            snaps.calls().is_empty(),
            "never tries a quote for a symbol with no coverage yet"
        );
    }

    #[tokio::test]
    async fn a_symbol_with_no_quote_top_up_is_skipped_not_fetched() {
        let db = Database::open_in_memory().unwrap();
        let snaps = FakeSnapshots::default();
        let req = sync_request(vec!["binance:BTCUSDT".to_string()]);
        let report = sync_daily(&db, &snaps, &req, NOW).await;
        assert_eq!(report.results[0].status, SyncStatus::Skipped);
        assert!(snaps.calls().is_empty());
    }

    #[tokio::test]
    async fn no_quote_for_a_candidate_falls_back_to_fetch() {
        let db = Database::open_in_memory().unwrap();
        let f = fake();
        load(&db, &f, &request(Some(30), None), NOW).await.unwrap();

        let snaps = FakeSnapshots::default(); // nothing set for SYM
        let report = sync_daily(&db, &snaps, &sync_request(vec![SYM.to_string()]), evening()).await;
        assert_eq!(report.results[0].status, SyncStatus::Fetch);
        assert_eq!(report.results[0].reason.as_deref(), Some("no quote for it"));
    }

    #[tokio::test]
    async fn a_rejected_snapshot_falls_back_to_fetch_with_the_reason() {
        let db = Database::open_in_memory().unwrap();
        let f = fake();
        load(&db, &f, &request(Some(30), None), NOW).await.unwrap();

        let snaps = FakeSnapshots::default();
        let bad = DaySnapshot {
            previous_close: Some(50.0), // nowhere near day_bar(99)'s close of 199.0
            ..good_quote(evening() - 1_000)
        };
        snaps.set("zerodha", "NSE:RELIANCE", bad);

        let report = sync_daily(&db, &snaps, &sync_request(vec![SYM.to_string()]), evening()).await;
        assert_eq!(report.results[0].status, SyncStatus::Fetch);
        assert!(
            report.results[0]
                .reason
                .as_deref()
                .unwrap()
                .contains("PreviousCloseMismatch"),
            "{:?}",
            report.results[0].reason
        );

        // Rejected, not written: the stored bar is unchanged.
        let conn = db.conn.lock().unwrap();
        let stored = store::get(&conn, SYM, "D", ist_day_start(NOW), ist_day_start(NOW) + DAY_MS, None).unwrap();
        assert!(stored.is_empty());
    }

    #[tokio::test]
    async fn a_quote_failure_marks_its_symbols_fetch_and_other_sources_are_skipped() {
        let db = Database::open_in_memory().unwrap();
        let f = fake();
        load(&db, &f, &request(Some(30), None), NOW).await.unwrap();

        let snaps = FakeSnapshots::default();
        snaps.fail_provider("zerodha", ApiError::new(401, "auth", "token expired"));

        let req = sync_request(vec![SYM.to_string(), "csv:MY_DATA".to_string()]);
        let report = sync_daily(&db, &snaps, &req, evening()).await;
        let by_symbol: HashMap<_, _> = report.results.into_iter().map(|r| (r.symbol.clone(), r)).collect();

        assert_eq!(by_symbol[SYM].status, SyncStatus::Fetch);
        assert_eq!(by_symbol[SYM].reason.as_deref(), Some("token expired"));
        assert_eq!(
            by_symbol["csv:MY_DATA"].status,
            SyncStatus::Skipped,
            "only the broker's quotes top a series up"
        );
    }

    #[tokio::test]
    async fn a_panel_reads_the_store_alone_and_says_which_series_are_current() {
        let db = Database::open_in_memory().unwrap();
        let f = fake();
        // A short request's span is rounded up to 90 days, so hold more than that.
        load(&db, &f, &request(Some(100), None), NOW).await.unwrap();
        let calls = f.calls().len();

        let req = PanelRequest {
            symbols: vec![SYM.to_string(), "zerodha:NSE:UNHELD".to_string()],
            interval: "D".to_string(),
            from_ms: None,
            to_ms: None,
            limit: Some(5),
        };
        let conn = db.conn.lock().unwrap();
        let series = read_panel(&conn, &req, NOW).unwrap();
        assert_eq!(f.calls().len(), calls, "no broker call");

        assert!(series[0].current);
        assert_eq!(series[0].bars.len(), 5, "the newest five");
        assert!(series[0].bars.windows(2).all(|w| w[0].time < w[1].time), "oldest first");
        assert_eq!(series[0].bars[4].close, f.bars[99].close);

        assert!(!series[1].current);
        assert!(series[1].bars.is_empty() && series[1].coverage.is_none());

        // A request reaching further back than the store holds isn't current either.
        let deeper = PanelRequest {
            limit: Some(400),
            ..req.clone()
        };
        assert!(!read_panel(&conn, &deeper, NOW).unwrap()[0].current);
        // Nor is it after a session has settled that the store hasn't read.
        assert!(!read_panel(&conn, &req, NOW + 3 * DAY_MS).unwrap()[0].current);
    }
}
