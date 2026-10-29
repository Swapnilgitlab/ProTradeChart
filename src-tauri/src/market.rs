//! The Indian exchanges' trading calendar, as pure functions of an instant: no clock and
//! no I/O, so whatever depends on it is tested by handing it the time.
//!
//! It knows weekdays and the equity session (09:15–15:30 IST) and nothing else. Holidays
//! are deliberately not listed, because a list in a binary goes stale: treating a holiday
//! as a session costs one check that returns no bars, after which coverage reaches past
//! it. MCX trades until 23:30, so a commodity's daily bar read between 15:30 and 23:30 is
//! taken as final until the next refresh re-reads that day and corrects it.

const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const DAY_MS: i64 = 24 * HOUR_MS;

/// Every broker here serves Indian exchanges; daily bars belong to an IST calendar date.
pub const IST_OFFSET_MS: i64 = 19_800_000;
/// An NSE session is 09:15–15:30.
pub const SESSION_MINUTES: i64 = 375;

const OPEN_MS: i64 = 9 * HOUR_MS + 15 * MINUTE_MS;
const CLOSE_MS: i64 = OPEN_MS + SESSION_MINUTES * MINUTE_MS;
/// The exchange settles its closing prices a little after the bell, so a daily bar read in
/// the first minutes after 15:30 may still move. Half an hour is comfortably past that.
const SETTLED_MS: i64 = CLOSE_MS + 30 * MINUTE_MS;
/// Kite shows special pre-open-session prices from 09:00; they are not a trustworthy stand-in
/// for the day's own bar, so a quote read in this short window is refused rather than trusted.
const PRE_OPEN_MS: i64 = 9 * HOUR_MS;

/// Midnight IST of the calendar date `ms` falls on.
pub fn ist_day_start(ms: i64) -> i64 {
    (ms + IST_OFFSET_MS).div_euclid(DAY_MS) * DAY_MS - IST_OFFSET_MS
}

/// The first instant after `ms` (or `ms` itself) at `minute` minutes past midnight IST: when a
/// broker's daily token reset that follows a save comes (Kite's 06:00, FYERS's 06:30).
pub fn next_ist_minute(ms: i64, minute: i64) -> i64 {
    let at = ist_day_start(ms) + minute * MINUTE_MS;
    if at >= ms {
        at
    } else {
        at + DAY_MS
    }
}

/// The latest instant up to `ms` at `minute` minutes past midnight IST: the most recent reset.
pub fn last_ist_minute(ms: i64, minute: i64) -> i64 {
    let at = ist_day_start(ms) + minute * MINUTE_MS;
    if at <= ms {
        at
    } else {
        at - DAY_MS
    }
}

fn is_weekday(ms: i64) -> bool {
    // 1970-01-01 was a Thursday; counting from Sunday = 0, that is 4.
    matches!(((ms + IST_OFFSET_MS).div_euclid(DAY_MS) + 4).rem_euclid(7), 1..=5)
}

/// Whether the equity session is running: a weekday, 09:15 up to 15:30 IST.
pub fn is_open(now_ms: i64) -> bool {
    is_weekday(now_ms) && (OPEN_MS..CLOSE_MS).contains(&(now_ms - ist_day_start(now_ms)))
}

/// Whether `exchange`'s session is running: MCX trades 09:00 to 23:30 IST, everything else follows
/// the equity session. Holidays aren't known (see the module's note).
pub fn is_trading(exchange: &str, now_ms: i64) -> bool {
    if exchange == "MCX" {
        let into = now_ms - ist_day_start(now_ms);
        is_weekday(now_ms) && (9 * HOUR_MS..23 * HOUR_MS + 30 * MINUTE_MS).contains(&into)
    } else {
        is_open(now_ms)
    }
}

/// When the most recent session that is certainly over became final: its close plus the
/// time the exchange takes to settle. A daily bar read from that moment on never changes.
pub fn last_settled_ms(now_ms: i64) -> i64 {
    let today = ist_day_start(now_ms);
    (0..7)
        .map(|back| today - back * DAY_MS)
        .filter(|day| is_weekday(*day))
        .map(|day| day + SETTLED_MS)
        .find(|settled| *settled <= now_ms)
        // A week always holds a settled weekday; this only keeps the function total.
        .unwrap_or(i64::MIN)
}

/// The calendar day a quote taken *right now* speaks for, as a daily bar: today's own session
/// while it is running, else the last settled session's day. `None` during Kite's pre-open
/// window (09:00–09:15), when a quote is a special indicative price, not the day's own bar —
/// a symbol read then should wait, or fall back to the historical endpoint.
pub fn quote_session_day(now_ms: i64) -> Option<i64> {
    let today = ist_day_start(now_ms);
    if is_weekday(now_ms) {
        let since_midnight = now_ms - today;
        if (PRE_OPEN_MS..OPEN_MS).contains(&since_midnight) {
            return None;
        }
        if is_open(now_ms) {
            return Some(today);
        }
    }
    Some(ist_day_start(last_settled_ms(now_ms)))
}

/// How many weekdays fall strictly between two midnight-IST days (in either order) — a holiday
/// counts (there is no holiday calendar here), so this is a conservative "is there any day I
/// might have missed" check, not an exact trading-day count.
pub fn weekdays_between(a_day_start: i64, b_day_start: i64) -> i64 {
    let (lo, hi) = if a_day_start <= b_day_start {
        (a_day_start, b_day_start)
    } else {
        (b_day_start, a_day_start)
    };
    let mut day = lo + DAY_MS;
    let mut count = 0;
    while day < hi {
        if is_weekday(day) {
            count += 1;
        }
        day += DAY_MS;
    }
    count
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    // Howard Hinnant's days-to-civil algorithm.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `YYYY-MM-DD` of an instant, in IST.
pub fn ist_date(ms: i64) -> String {
    let secs = (ms + IST_OFFSET_MS).div_euclid(1000);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

/// `YYYY-MM-DD HH:MM:SS` of an instant, in IST.
pub fn ist_datetime(ms: i64) -> String {
    let rem = (ms + IST_OFFSET_MS).div_euclid(1000).rem_euclid(86_400);
    format!(
        "{} {:02}:{:02}:{:02}",
        ist_date(ms),
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Monday 5 January 2026, 00:00 IST.
    const MON: i64 = 1_767_551_400_000;

    /// `day` days after that Monday (negative for before it), at `hour:minute` IST.
    fn at(day: i64, hour: i64, minute: i64) -> i64 {
        MON + day * DAY_MS + hour * HOUR_MS + minute * MINUTE_MS
    }

    #[test]
    fn a_day_starts_at_midnight_ist() {
        assert_eq!(ist_day_start(at(0, 0, 0)), at(0, 0, 0));
        assert_eq!(ist_day_start(at(0, 12, 34)), at(0, 0, 0));
        assert_eq!(ist_day_start(at(0, 23, 59) + 59_999), at(0, 0, 0));
        assert_eq!(ist_day_start(at(1, 0, 0)), at(1, 0, 0));
        // UTC's midnight is 05:30 into the IST day.
        assert_eq!(ist_day_start(0), -IST_OFFSET_MS);
    }

    #[test]
    fn a_day_starts_at_midnight_ist_before_1970_too() {
        assert_eq!(ist_day_start(-1), -IST_OFFSET_MS);
        assert_eq!(ist_day_start(-IST_OFFSET_MS - 1), -IST_OFFSET_MS - DAY_MS);
    }

    #[test]
    fn the_market_is_open_only_between_the_bells_on_a_weekday() {
        assert!(!is_open(at(0, 9, 14) + 59_999));
        assert!(is_open(at(0, 9, 15)));
        assert!(is_open(at(0, 12, 0)));
        assert!(is_open(at(0, 15, 29) + 59_999));
        assert!(!is_open(at(0, 15, 30)));
        assert!(!is_open(at(0, 20, 0)));
        assert!(is_open(at(4, 12, 0)), "Friday");
        assert!(!is_open(at(5, 12, 0)), "Saturday");
        assert!(!is_open(at(6, 12, 0)), "Sunday");
        assert!(is_open(at(7, 12, 0)), "the next Monday");
    }

    #[test]
    fn a_session_is_settled_half_an_hour_after_the_close() {
        assert_eq!(
            last_settled_ms(at(0, 15, 59)),
            at(-3, 16, 0),
            "Friday's, until Monday's settles"
        );
        assert_eq!(last_settled_ms(at(0, 16, 0)), at(0, 16, 0));
        assert_eq!(last_settled_ms(at(0, 23, 0)), at(0, 16, 0));
    }

    #[test]
    fn friday_is_the_last_settled_session_all_weekend_and_until_monday_settles() {
        let friday = at(-3, 16, 0);
        for now in [
            at(-3, 16, 0),
            at(-3, 23, 59),
            at(-2, 12, 0),
            at(-1, 12, 0),
            at(0, 0, 0),
            at(0, 9, 0),
        ] {
            assert_eq!(last_settled_ms(now), friday, "{now}");
        }
        // The morning after a weekday is that weekday's.
        assert_eq!(last_settled_ms(at(2, 8, 0)), at(1, 16, 0));
    }

    #[test]
    fn the_last_settled_time_never_runs_backwards_or_ahead_of_now() {
        let mut previous = i64::MIN;
        // Hourly across a fortnight, a few minutes past each hour.
        for step in 0..(14 * 24) {
            let now = at(-7, 0, 5) + step * HOUR_MS;
            let settled = last_settled_ms(now);
            assert!(settled <= now, "{now}");
            assert!(settled >= previous, "{now}");
            assert!(now - settled < 4 * DAY_MS, "always within a long weekend of now: {now}");
            previous = settled;
        }
    }

    #[test]
    fn a_quote_speaks_for_todays_session_while_it_is_open() {
        assert_eq!(quote_session_day(at(0, 9, 15)), Some(at(0, 0, 0)));
        assert_eq!(quote_session_day(at(0, 12, 0)), Some(at(0, 0, 0)));
        assert_eq!(quote_session_day(at(0, 15, 29) + 59_999), Some(at(0, 0, 0)));
    }

    #[test]
    fn a_quote_in_the_pre_open_window_speaks_for_nothing() {
        assert_eq!(quote_session_day(at(0, 9, 0)), None);
        assert_eq!(quote_session_day(at(0, 9, 14) + 59_999), None);
    }

    #[test]
    fn outside_the_session_a_quote_speaks_for_the_last_settled_day() {
        // Before the pre-open window, the session hasn't started: yesterday's (Friday's, over a
        // weekend) settled day still stands.
        assert_eq!(
            quote_session_day(at(0, 8, 59)),
            Some(at(-3, 0, 0)),
            "Monday before the open"
        );
        assert_eq!(
            quote_session_day(at(0, 16, 0)),
            Some(at(0, 0, 0)),
            "after today settles"
        );
        assert_eq!(
            quote_session_day(at(0, 15, 30)),
            Some(at(-3, 0, 0)),
            "right at the bell, not yet settled"
        );
        assert_eq!(
            quote_session_day(at(5, 12, 0)),
            Some(at(4, 0, 0)),
            "Saturday speaks for Friday"
        );
    }

    #[test]
    fn weekdays_between_is_zero_for_the_same_day_or_an_ordinary_weekend() {
        assert_eq!(weekdays_between(at(0, 0, 0), at(0, 0, 0)), 0);
        assert_eq!(
            weekdays_between(at(4, 0, 0), at(7, 0, 0)),
            0,
            "Friday to the next Monday"
        );
        assert_eq!(weekdays_between(at(7, 0, 0), at(4, 0, 0)), 0, "order doesn't matter");
    }

    #[test]
    fn weekdays_between_counts_every_weekday_in_a_gap() {
        assert_eq!(
            weekdays_between(at(0, 0, 0), at(2, 0, 0)),
            1,
            "Monday to Wednesday: Tuesday"
        );
        assert_eq!(
            weekdays_between(at(3, 0, 0), at(7, 0, 0)),
            1,
            "Thursday to Monday: Friday"
        );
        assert_eq!(
            weekdays_between(at(0, 0, 0), at(7, 0, 0)),
            4,
            "a whole week of weekdays between"
        );
    }

    #[test]
    fn instants_are_written_as_ist_dates_and_times() {
        // 2026-01-05 00:00 IST is 2026-01-04 18:30 UTC.
        let monday = 1_767_551_400_000;
        assert_eq!(ist_date(monday), "2026-01-05");
        assert_eq!(ist_date(monday - 1), "2026-01-04");
        assert_eq!(
            ist_datetime(monday + 9 * 3_600_000 + 15 * 60_000 + 7_000),
            "2026-01-05 09:15:07"
        );
        assert_eq!(ist_date(0), "1970-01-01");
    }
}
