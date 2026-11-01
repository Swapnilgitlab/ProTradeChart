//! Whether a daily series' missing tail can be filled from a single broker quote instead of a
//! rate-limited historical-data call — the fast lane `pyapi::data::sync_daily` uses ahead of the
//! ordinary per-symbol fetch (`research_bars::plan`), which remains the fallback for everything
//! this module turns down.
//!
//! A quote gives one instant's snapshot, never a backfill: it can only ever stand in for the one
//! day [`research_bars::plan`] says is missing, and only when there is no day this module can't
//! account for in between. Both functions here are pure — no clock, no I/O — so a wrong answer is
//! a test away from being caught.

use crate::market;
use crate::models::{Bar, DaySnapshot};
use crate::store::research_bars::{plan, Coverage};

/// A missing tail that a quote, dated correctly, could fill.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Candidate {
    /// The one calendar day (midnight IST) the quote must speak for.
    pub session_day: i64,
}

/// Why a fetched snapshot wasn't trusted as `candidate`'s day's bar — each one means "use the
/// historical endpoint instead", never "store something anyway".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reject {
    /// The broker didn't say when the quote last traded, or it isn't `candidate`'s own day.
    NotThisSession,
    /// A price was missing, non-finite, zero or negative, or O/H/L/close don't agree with each
    /// other (low above an open or close, high below one).
    BadPrices,
    /// The broker's previous-close doesn't match what's already stored for the day before —
    /// a corporate action, a missed session, or a stored close that wasn't final yet.
    PreviousCloseMismatch,
    /// The series already carries volume (it isn't an index) but this snapshot has none.
    NoVolume,
}

/// Whether `research_bars::plan`'s one missing range for a daily series is exactly today's (or
/// the last session's) bar, with nothing else unaccounted for since the store was last extended.
///
/// `None` whenever a quote can't help: a non-daily interval, a symbol with no coverage at all
/// (always fetched in full), a plan with no gap (nothing to do) or more than one, a gap that
/// isn't the tail (missing history further back), outside Kite's pre-open window (no quote to
/// trust yet), or a weekday sits between the store's last final session and now that this
/// snapshot can't account for (a holiday counts — conservative, but correct).
pub fn candidate(
    coverage: Option<Coverage>,
    interval: &str,
    from_ms: i64,
    to_ms: i64,
    now_ms: i64,
) -> Option<Candidate> {
    if interval != "D" {
        return None;
    }
    let c = coverage?;
    let ranges = plan(Some(c), interval, from_ms, to_ms, now_ms);
    let [r] = ranges.as_slice() else {
        return None;
    };
    if r.from_ms < c.from_ms {
        return None;
    }
    let session_day = market::quote_session_day(now_ms)?;
    let last_final = market::ist_day_start(market::last_settled_ms(c.to_ms));
    if market::weekdays_between(last_final, session_day) != 0 {
        return None;
    }
    Some(Candidate { session_day })
}

/// Whether two prices of one bar are the same as far as a broker's rounding goes: within a tick,
/// or a hundredth of a percent of the held one. A corporate action moves a price far more.
pub fn same_price(fetched: f64, held: f64) -> bool {
    (fetched - held).abs() <= (held * 1e-4).max(0.011)
}

/// Checks a fetched snapshot before trusting it as `candidate`'s day's bar. `prior` is the bar
/// strictly before that day, already in the store — absent only if the series has no history at
/// all yet, which `candidate` already rules out, so that case is rejected rather than guessed at.
pub fn snapshot_bar(candidate: &Candidate, snapshot: &DaySnapshot, prior: Option<&Bar>) -> Result<Bar, Reject> {
    let traded_at = snapshot.traded_at_ms.ok_or(Reject::NotThisSession)?;
    if market::ist_day_start(traded_at) != candidate.session_day {
        return Err(Reject::NotThisSession);
    }

    let (open, high, low, close) = (snapshot.open, snapshot.high, snapshot.low, snapshot.last);
    let finite_and_positive = [open, high, low, close].iter().all(|v| v.is_finite() && *v > 0.0);
    if !finite_and_positive || low > open.min(close) || high < open.max(close) {
        return Err(Reject::BadPrices);
    }

    let prior = prior.ok_or(Reject::PreviousCloseMismatch)?;
    let previous_close = snapshot.previous_close.ok_or(Reject::PreviousCloseMismatch)?;
    if !same_price(previous_close, prior.close) {
        return Err(Reject::PreviousCloseMismatch);
    }
    if snapshot.volume.is_none() && prior.volume.is_some() {
        return Err(Reject::NoVolume);
    }

    Ok(Bar {
        time: candidate.session_day,
        open,
        high,
        low,
        close,
        volume: snapshot.volume,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE_MS: i64 = 60_000;
    const HOUR_MS: i64 = 60 * MINUTE_MS;
    const DAY_MS: i64 = 24 * HOUR_MS;
    /// Monday 5 January 2026, 00:00 IST — the same anchor `market.rs` and `research_bars.rs`
    /// use, so a day offset here means the same weekday there.
    const MON: i64 = 1_767_551_400_000;

    fn at(day: i64, hour: i64, minute: i64) -> i64 {
        MON + day * DAY_MS + hour * HOUR_MS + minute * MINUTE_MS
    }

    fn cov(from_ms: i64, to_ms: i64, synced_at: i64) -> Coverage {
        Coverage {
            from_ms,
            to_ms,
            synced_at,
        }
    }

    fn bar(time: i64, close: f64, volume: Option<f64>) -> Bar {
        Bar {
            time,
            open: close,
            high: close + 1.0,
            low: close - 1.0,
            close,
            volume,
        }
    }

    // ---- candidate ------------------------------------------------------------------------

    #[test]
    fn nothing_without_daily_coverage() {
        assert_eq!(
            candidate(None, "D", at(-300, 0, 0), at(0, 16, 0), at(0, 16, 0)),
            None,
            "never fetched"
        );
        let c = cov(at(-300, 0, 0), at(0, 16, 0), at(0, 16, 0));
        assert_eq!(
            candidate(Some(c), "5", at(-300, 0, 0), at(1, 9, 20), at(1, 9, 20)),
            None,
            "not daily"
        );
    }

    #[test]
    fn nothing_when_the_series_is_already_current() {
        // Already synced past today's settlement: plan() has nothing to do.
        let c = cov(at(-300, 0, 0), at(0, 16, 0), at(0, 16, 0));
        assert_eq!(
            candidate(Some(c), "D", at(-300, 0, 0), at(0, 20, 0), at(0, 20, 0)),
            None
        );
    }

    #[test]
    fn nothing_when_more_than_the_tail_is_missing() {
        // A gap at the START of history too (an older `from` than the coverage holds).
        let c = cov(at(-200, 0, 0), at(0, 16, 0), at(0, 16, 0));
        assert_eq!(
            candidate(Some(c), "D", at(-300, 0, 0), at(1, 16, 0), at(1, 16, 0)),
            None
        );
    }

    #[test]
    fn todays_bar_read_while_forming_and_reread_after_it_settles_is_a_candidate() {
        // Coverage's end (Monday 14:00) is still inside Monday's session: that bar was forming,
        // not final. Asked again after the close, it needs a fresh (now-final) read.
        let c = cov(at(-300, 0, 0), at(0, 14, 0), at(0, 14, 0));
        let got = candidate(Some(c), "D", at(-300, 0, 0), at(0, 20, 0), at(0, 20, 0));
        assert_eq!(
            got,
            Some(Candidate {
                session_day: at(0, 0, 0)
            })
        );
    }

    #[test]
    fn nothing_once_todays_settled_bar_is_already_synced() {
        // Coverage already reaches the moment Monday settled: nothing has changed since.
        let c = cov(at(-300, 0, 0), at(0, 16, 0), at(0, 16, 0));
        assert_eq!(
            candidate(Some(c), "D", at(-300, 0, 0), at(0, 20, 0), at(0, 20, 0)),
            None
        );
    }

    #[test]
    fn todays_still_forming_bar_is_a_candidate_intraday() {
        // Coverage reaches yesterday's settled close; today (Monday) is open and un-synced.
        let c = cov(at(-300, 0, 0), at(-1, 16, 0), at(-1, 16, 0));
        let got = candidate(Some(c), "D", at(-300, 0, 0), at(0, 12, 0), at(0, 12, 0));
        assert_eq!(
            got,
            Some(Candidate {
                session_day: at(0, 0, 0)
            })
        );
    }

    #[test]
    fn final_friday_then_monday_is_a_candidate() {
        let friday_settled = at(-3, 16, 0);
        let c = cov(at(-300, 0, 0), friday_settled, friday_settled);
        let got = candidate(Some(c), "D", at(-300, 0, 0), at(0, 10, 0), at(0, 10, 0));
        assert_eq!(
            got,
            Some(Candidate {
                session_day: at(0, 0, 0)
            })
        );
    }

    #[test]
    fn friday_read_while_still_forming_then_monday_is_not_a_candidate() {
        // Coverage's end is Friday midday: Friday's own bar was never settled when it was read.
        let c = cov(at(-300, 0, 0), at(-3, 12, 0), at(-3, 12, 0));
        assert_eq!(
            candidate(Some(c), "D", at(-300, 0, 0), at(0, 10, 0), at(0, 10, 0)),
            None
        );
    }

    #[test]
    fn thursday_then_monday_is_not_a_candidate() {
        // Friday's bar is missing outright, not just today's.
        let thursday_settled = at(-4, 16, 0);
        let c = cov(at(-300, 0, 0), thursday_settled, thursday_settled);
        assert_eq!(
            candidate(Some(c), "D", at(-300, 0, 0), at(0, 10, 0), at(0, 10, 0)),
            None
        );
    }

    #[test]
    fn a_weekday_holiday_gap_is_not_a_candidate() {
        // Settled Monday, now Wednesday: Tuesday (a weekday, even if it was a holiday) is
        // unaccounted for. Conservative — the next read falls back to the historical endpoint.
        let monday_settled = at(0, 16, 0);
        let c = cov(at(-300, 0, 0), monday_settled, monday_settled);
        assert_eq!(
            candidate(Some(c), "D", at(-300, 0, 0), at(2, 10, 0), at(2, 10, 0)),
            None
        );
    }

    #[test]
    fn the_pre_open_window_is_never_a_candidate() {
        let c = cov(at(-300, 0, 0), at(-1, 16, 0), at(-1, 16, 0));
        assert_eq!(candidate(Some(c), "D", at(-300, 0, 0), at(0, 9, 5), at(0, 9, 5)), None);
    }

    #[test]
    fn a_saturday_read_speaks_for_friday() {
        let thursday_settled = at(-4, 16, 0);
        let c = cov(at(-300, 0, 0), thursday_settled, thursday_settled);
        let got = candidate(Some(c), "D", at(-300, 0, 0), at(-2, 12, 0), at(-2, 12, 0));
        assert_eq!(
            got,
            Some(Candidate {
                session_day: at(-3, 0, 0)
            }),
            "Friday"
        );
    }

    // ---- snapshot_bar -----------------------------------------------------------------------

    fn today() -> Candidate {
        Candidate {
            session_day: at(0, 0, 0),
        }
    }

    fn good_snapshot() -> DaySnapshot {
        DaySnapshot {
            open: 100.0,
            high: 105.0,
            low: 99.0,
            last: 103.0,
            previous_close: Some(100.0),
            volume: Some(50_000.0),
            traded_at_ms: Some(at(0, 15, 40)),
        }
    }

    fn yesterday_bar() -> Bar {
        bar(at(-1, 0, 0), 100.0, Some(40_000.0))
    }

    #[test]
    fn a_good_snapshot_becomes_the_days_bar() {
        let got = snapshot_bar(&today(), &good_snapshot(), Some(&yesterday_bar())).unwrap();
        assert_eq!(
            got,
            Bar {
                time: at(0, 0, 0),
                open: 100.0,
                high: 105.0,
                low: 99.0,
                close: 103.0,
                volume: Some(50_000.0)
            }
        );
    }

    #[test]
    fn no_trade_time_is_rejected() {
        let snap = DaySnapshot {
            traded_at_ms: None,
            ..good_snapshot()
        };
        assert_eq!(
            snapshot_bar(&today(), &snap, Some(&yesterday_bar())),
            Err(Reject::NotThisSession)
        );
    }

    #[test]
    fn a_trade_time_on_the_wrong_day_is_rejected() {
        let snap = DaySnapshot {
            traded_at_ms: Some(at(-1, 15, 40)),
            ..good_snapshot()
        };
        assert_eq!(
            snapshot_bar(&today(), &snap, Some(&yesterday_bar())),
            Err(Reject::NotThisSession)
        );
    }

    #[test]
    fn prices_out_of_order_are_rejected() {
        let too_low = DaySnapshot {
            low: 101.0,
            ..good_snapshot()
        }; // above the open
        assert_eq!(
            snapshot_bar(&today(), &too_low, Some(&yesterday_bar())),
            Err(Reject::BadPrices)
        );
        let too_high = DaySnapshot {
            high: 102.0,
            ..good_snapshot()
        }; // below the last
        assert_eq!(
            snapshot_bar(&today(), &too_high, Some(&yesterday_bar())),
            Err(Reject::BadPrices)
        );
        let zero = DaySnapshot {
            open: 0.0,
            ..good_snapshot()
        };
        assert_eq!(
            snapshot_bar(&today(), &zero, Some(&yesterday_bar())),
            Err(Reject::BadPrices)
        );
        let nan = DaySnapshot {
            last: f64::NAN,
            ..good_snapshot()
        };
        assert_eq!(
            snapshot_bar(&today(), &nan, Some(&yesterday_bar())),
            Err(Reject::BadPrices)
        );
    }

    #[test]
    fn a_previous_close_within_a_tick_is_accepted() {
        let snap = DaySnapshot {
            previous_close: Some(100.005),
            ..good_snapshot()
        };
        assert!(snapshot_bar(&today(), &snap, Some(&yesterday_bar())).is_ok());
    }

    #[test]
    fn a_previous_close_a_percent_off_is_rejected() {
        let snap = DaySnapshot {
            previous_close: Some(101.5),
            ..good_snapshot()
        };
        assert_eq!(
            snapshot_bar(&today(), &snap, Some(&yesterday_bar())),
            Err(Reject::PreviousCloseMismatch)
        );
    }

    #[test]
    fn no_previous_close_at_all_is_rejected() {
        let snap = DaySnapshot {
            previous_close: None,
            ..good_snapshot()
        };
        assert_eq!(
            snapshot_bar(&today(), &snap, Some(&yesterday_bar())),
            Err(Reject::PreviousCloseMismatch)
        );
    }

    #[test]
    fn missing_volume_on_a_series_that_has_it_is_rejected() {
        let snap = DaySnapshot {
            volume: None,
            ..good_snapshot()
        };
        assert_eq!(
            snapshot_bar(&today(), &snap, Some(&yesterday_bar())),
            Err(Reject::NoVolume)
        );
    }

    #[test]
    fn missing_volume_on_an_index_is_fine() {
        let snap = DaySnapshot {
            volume: None,
            ..good_snapshot()
        };
        let index_history = bar(at(-1, 0, 0), 100.0, None);
        let got = snapshot_bar(&today(), &snap, Some(&index_history)).unwrap();
        assert_eq!(got.volume, None);
    }

    #[test]
    fn no_prior_bar_at_all_is_rejected() {
        assert_eq!(
            snapshot_bar(&today(), &good_snapshot(), None),
            Err(Reject::PreviousCloseMismatch)
        );
    }
}
