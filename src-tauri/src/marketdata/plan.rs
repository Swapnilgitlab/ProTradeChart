//! The market-data store's rules, with no I/O and no clock: what the store holds, when the
//! daily update is due, and how a corporate action or a holiday is recognised. Times are IST
//! through `market.rs`; there is no holiday list.

use crate::market::{ist_day_start, last_settled_ms};
use crate::models::Bar;
use crate::store::instrument_list;
use crate::store::market_symbols::Listed;
use crate::store::research_bars::Coverage;
use crate::store::study_universe::pick_listings;

const DAY_MS: i64 = 86_400_000;
const HOUR_MS: i64 = 3_600_000;

/// How far back the store keeps daily history.
pub const HISTORY_DAYS: i64 = 5 * 365 + 2;
/// A coverage that starts this close after [`history_from`] is complete: the target moves forward
/// a day at a time, and a broker's window can start a little late.
const HISTORY_SLACK_MS: i64 = 7 * DAY_MS;
/// After a failed update (a lapsed login, the broker down), the automatic one waits this long
/// before trying again. "Update now" doesn't wait.
pub const RETRY_AFTER_FAILURE_MS: i64 = HOUR_MS;
/// A tail refresh reads this far back, so it overlaps days that have certainly settled: a
/// stored close that disagrees with the broker's there is a corporate action, not a bar that
/// was still forming when it was stored.
pub const TAIL_OVERLAP_MS: i64 = 7 * DAY_MS;
/// The daily update refreshes the instrument list when it is older than this, so a new listing
/// is found the day after it appears (startup alone refreshes it weekly).
pub const INSTRUMENTS_MAX_AGE_MS: i64 = 20 * HOUR_MS;

/// The start of the stored history, as of `now`.
pub fn history_from(now: i64) -> i64 {
    ist_day_start(now - HISTORY_DAYS * DAY_MS)
}

/// Whether a series still needs its history downloaded.
pub fn needs_history(coverage: Option<Coverage>, from: i64) -> bool {
    coverage.is_none_or(|c| c.from_ms > from + HISTORY_SLACK_MS)
}

/// What the store keeps for `provider`: one listing per company among its NSE EQ-series stocks
/// (the Studies' rule, `study_universe::pick_listings`), then every NSE index.
pub fn universe(
    provider: &str,
    equities: &[instrument_list::Listed],
    indices: &[instrument_list::Listed],
) -> Vec<Listed> {
    let rows: Vec<(String, Option<String>)> = equities
        .iter()
        .map(|i| (format!("{provider}:{}", i.ticker), i.name.clone()))
        .collect();
    let picked = pick_listings(&rows, &["EQ".to_string()]);
    let name_of = |symbol: &str| rows.iter().find(|(s, _)| s == symbol).and_then(|(_, n)| n.clone());
    let stocks = picked.iter().map(|symbol| Listed {
        symbol: symbol.clone(),
        kind: "EQ".to_string(),
        name: name_of(symbol),
    });
    let indices = indices.iter().map(|i| Listed {
        symbol: format!("{provider}:{}", i.ticker),
        kind: "INDEX".to_string(),
        name: i.name.clone(),
    });
    stocks.chain(indices).collect()
}

/// Whether the automatic daily update should run now: a session has settled since the last one,
/// and the last failure (if newer than the last success) is at least [`RETRY_AFTER_FAILURE_MS`] old.
pub fn due(now: i64, last_update: Option<i64>, last_failure: Option<i64>) -> bool {
    let last_ok = last_update.unwrap_or(i64::MIN);
    if let Some(failed) = last_failure {
        if failed > last_ok && now - failed < RETRY_AFTER_FAILURE_MS {
            return false;
        }
    }
    last_ok < last_settled_ms(now)
}

/// The tolerance a stored close may differ from the broker's by and still be the same price:
/// a tick, or a basis point of the price, whichever is larger (as `day_topup` judges it).
fn same_price(a: f64, b: f64) -> bool {
    (a - b).abs() <= (a.abs() * 1e-4).max(0.011)
}

/// Whether the broker's bars disagree with the stored ones on a day both have, other than the
/// newest stored day (which may have been stored while it was still forming). A disagreement
/// means the broker has adjusted its history (a split, a bonus) and the stored series must be
/// fetched again in full: mixing the two would put an artificial jump in it.
pub fn disagrees(stored: &[Bar], fetched: &[Bar]) -> bool {
    let Some(newest) = stored.last().map(|b| b.time) else {
        return false;
    };
    stored.iter().filter(|s| s.time < newest).any(|s| {
        fetched
            .iter()
            .any(|f| f.time == s.time && !same_price(f.close, s.close))
    })
}

/// The session the last settlement before `now` belongs to (midnight IST of that day).
pub fn settled_session(now: i64) -> i64 {
    ist_day_start(last_settled_ms(now))
}

/// Whether the latest settled session was a holiday, judged from a liquid symbol's freshly fetched
/// bars: they reach the days before it but have none for it.
pub fn was_holiday(probe: &[Bar], session_day: i64) -> bool {
    let has_session = probe.iter().any(|b| b.time == session_day);
    let has_before = probe.iter().any(|b| b.time < session_day);
    has_before && !has_session
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Monday 5 January 2026, 00:00 IST.
    const MON: i64 = 1_767_551_400_000;

    fn at(day: i64, hour: i64, minute: i64) -> i64 {
        MON + day * DAY_MS + hour * HOUR_MS + minute * 60_000
    }

    fn bar(time: i64, close: f64) -> Bar {
        Bar {
            time,
            open: close,
            high: close,
            low: close,
            close,
            volume: Some(1.0),
        }
    }

    fn listed(ticker: &str, name: &str, instrument: &str) -> instrument_list::Listed {
        instrument_list::Listed {
            ticker: ticker.to_string(),
            exchange: "NSE".to_string(),
            instrument: instrument.to_string(),
            name: Some(name.to_string()),
            expiry: None,
        }
    }

    #[test]
    fn history_reaches_back_five_years_from_midnight() {
        let from = history_from(at(0, 17, 0));
        assert_eq!(from, ist_day_start(from));
        let years = (at(0, 17, 0) - from) as f64 / (365.25 * DAY_MS as f64);
        assert!((4.99..5.01).contains(&years), "{years}");
    }

    #[test]
    fn a_series_needs_history_until_it_reaches_back_to_the_target() {
        let from = history_from(at(0, 17, 0));
        let cov = |from_ms| Coverage {
            from_ms,
            to_ms: at(0, 16, 30),
            synced_at: at(0, 16, 30),
        };
        assert!(needs_history(None, from));
        assert!(
            needs_history(Some(cov(from + 30 * DAY_MS)), from),
            "a screen's two years"
        );
        assert!(!needs_history(Some(cov(from)), from));
        assert!(
            !needs_history(Some(cov(from + DAY_MS)), from),
            "a window that began a day late"
        );
        // A day later the target has moved on, and the same coverage is still complete.
        assert!(!needs_history(Some(cov(from)), history_from(at(1, 17, 0))));
    }

    #[test]
    fn the_universe_is_one_eq_listing_per_company_then_the_indices() {
        let equities = [
            listed("NSE:RELIANCE", "Reliance Industries", "EQUITY"),
            listed("NSE:RELIANCE-BE", "Reliance Industries", "EQUITY"),
            listed("NSE:NIFTYBEES", "Nippon India ETF Nifty BeES", "EQUITY"),
            listed("NSE:737GS2031", "GOI loan", "EQUITY"),
            listed("NSE:TCS", "Tata Consultancy Services", "EQUITY"),
        ];
        let indices = [listed("NSE:NIFTY_50", "Nifty 50", "INDEX")];
        let got = universe("zerodha", &equities, &indices);
        assert_eq!(
            got.iter()
                .map(|l| (l.symbol.as_str(), l.kind.as_str()))
                .collect::<Vec<_>>(),
            [
                ("zerodha:NSE:RELIANCE", "EQ"),
                ("zerodha:NSE:TCS", "EQ"),
                ("zerodha:NSE:NIFTY_50", "INDEX")
            ]
        );
        assert_eq!(got[1].name.as_deref(), Some("Tata Consultancy Services"));
    }

    #[test]
    fn the_update_is_due_once_per_settled_session() {
        // Never run: due straight away, whatever the hour.
        assert!(due(at(0, 10, 0), None, None));
        // Ran Friday evening: not due over the weekend or on Monday before the settlement...
        let friday = at(-3, 17, 0);
        for now in [at(-2, 12, 0), at(-1, 23, 0), at(0, 9, 30), at(0, 15, 59)] {
            assert!(!due(now, Some(friday), None), "{now}");
        }
        // ...and due once Monday's session has settled.
        assert!(due(at(0, 16, 1), Some(friday), None));
        assert!(!due(at(0, 18, 0), Some(at(0, 16, 5)), None));
    }

    #[test]
    fn a_failure_holds_the_automatic_update_back_for_an_hour() {
        let friday = at(-3, 17, 0);
        let failed = at(0, 16, 5);
        assert!(!due(at(0, 16, 30), Some(friday), Some(failed)));
        assert!(due(at(0, 17, 6), Some(friday), Some(failed)));
        // An old failure, followed by a success, doesn't hold anything back.
        assert!(due(at(0, 16, 1), Some(friday), Some(at(-4, 17, 0))));
    }

    #[test]
    fn a_split_shows_as_a_disagreement_on_an_older_day() {
        let stored = [
            bar(at(-3, 0, 0), 200.0),
            bar(at(-2, 0, 0), 202.0),
            bar(at(-1, 0, 0), 204.0),
        ];
        let same = [
            bar(at(-3, 0, 0), 200.0),
            bar(at(-2, 0, 0), 202.005),
            bar(at(-1, 0, 0), 204.0),
        ];
        assert!(!disagrees(&stored, &same), "within a tick");
        let halved = [
            bar(at(-3, 0, 0), 100.0),
            bar(at(-2, 0, 0), 101.0),
            bar(at(-1, 0, 0), 102.0),
            bar(at(0, 0, 0), 103.0),
        ];
        assert!(disagrees(&stored, &halved));
    }

    #[test]
    fn the_newest_stored_day_may_change_without_being_a_corporate_action() {
        // Stored at noon while forming; the settled close is different.
        let stored = [bar(at(-1, 0, 0), 100.0), bar(at(0, 0, 0), 101.0)];
        let fetched = [bar(at(-1, 0, 0), 100.0), bar(at(0, 0, 0), 105.0)];
        assert!(!disagrees(&stored, &fetched));
        assert!(!disagrees(&[], &fetched));
    }

    #[test]
    fn a_holiday_is_a_weekday_the_probe_has_no_bar_for() {
        let session = settled_session(at(0, 17, 0));
        assert_eq!(session, at(0, 0, 0));
        let friday = bar(at(-3, 0, 0), 1.0);
        assert!(was_holiday(std::slice::from_ref(&friday), session));
        assert!(!was_holiday(&[friday, bar(session, 1.0)], session));
        assert!(
            !was_holiday(&[], session),
            "no bars at all is a failed probe, not a holiday"
        );
    }
}
