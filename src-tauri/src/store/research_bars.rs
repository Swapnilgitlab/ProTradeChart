//! The research store: bars kept for the Python API, so a screen over hundreds of
//! symbols pays the brokers' rate limits once and afterwards only for what is new.
//!
//! This is not `bars_cache`. That one is the charts' offline fallback and is pruned to
//! suit them. Here every series carries a *coverage*: the span of time whose bars are
//! complete. It has to be recorded, because "no bars" (a holiday, a stock not yet listed)
//! and "not fetched yet" look identical in the bars table.
//!
//! [`plan`] is the whole sync policy and is pure: given what is covered, what was asked
//! for and the time, it says which ranges to fetch from the broker.

use rusqlite::{params, Connection, OptionalExtension};

use crate::market;
use crate::models::Bar;

const MINUTE_MS: i64 = 60_000;
const DAY_MS: i64 = 24 * 60 * MINUTE_MS;
/// How long a daily bar that is still forming is trusted while the market is open.
const DAILY_TTL_MS: i64 = 5 * MINUTE_MS;

/// A span of time, in epoch milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Range {
    pub from_ms: i64,
    pub to_ms: i64,
}

/// The span of a series known to be complete, and when its newest end was last checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Coverage {
    pub from_ms: i64,
    pub to_ms: i64,
    pub synced_at: i64,
}

/// The store's spelling of an interval: `D`, or a minute count (`5`, `60`). Accepts the
/// chart's form and the brokers' (`day`, `1D`, `5minute`).
pub fn canonical_interval(text: &str) -> Option<String> {
    let t = text.trim().to_lowercase();
    if matches!(t.as_str(), "d" | "1d" | "day" | "daily") {
        return Some("D".to_string());
    }
    // Kite spells a one-minute bar `minute`; every other form needs its number, so
    // that the chart's `M` (a month) is never read as one minute.
    let (digits, bare_means_one) = match t.strip_suffix("minute") {
        Some(digits) => (digits, true),
        None => (
            t.strip_suffix("min")
                .or_else(|| t.strip_suffix('m'))
                .unwrap_or(t.as_str()),
            false,
        ),
    };
    let minutes: u32 = match (digits.is_empty(), bare_means_one) {
        (false, _) => digits.parse().ok()?,
        (true, true) => 1,
        (true, false) => return None,
    };
    (minutes > 0).then(|| minutes.to_string())
}

/// The length of one bar, when it is a fixed length (daily bars are treated as a day).
pub fn interval_ms(interval: &str) -> Option<i64> {
    if interval == "D" {
        return Some(DAY_MS);
    }
    interval.parse::<i64>().ok().filter(|m| *m > 0).map(|m| m * MINUTE_MS)
}

/// How the newest end of a series is judged: it is the only part that can still change.
struct Tail {
    /// The broker may hold newer or corrected bars than the store does.
    stale: bool,
    /// The last sync already reached the present, so a request "until now" is answered as it stands.
    current: bool,
    /// Where a refresh starts, so the bar that was still forming is replaced.
    refresh_from: i64,
}

fn tail(interval: &str, c: &Coverage, now_ms: i64) -> Tail {
    match interval_ms(interval) {
        Some(bar) if interval != "D" => {
            let stale = now_ms - c.synced_at >= bar.clamp(30_000, 5 * MINUTE_MS);
            Tail {
                stale,
                // A request "until now" always ends a moment after the stored end, so being
                // later isn't enough to refetch: if the last sync reached the present and is
                // still within its ttl, the series is as current as it is going to be.
                current: !stale && c.synced_at - c.to_ms <= MINUTE_MS,
                refresh_from: c.to_ms - 3 * bar,
            }
        }
        // A daily bar changes only while its session runs and is final once it has settled,
        // so the age of a sync is no reason to look again: only a session that settled after
        // the coverage's end is, or (during the session) a forming bar past its ttl. A screen
        // over hundreds of symbols is otherwise re-fetched in full on every run.
        _ => {
            let stale = market::last_settled_ms(now_ms) > c.to_ms
                || (market::is_open(now_ms) && now_ms - c.synced_at >= DAILY_TTL_MS);
            Tail {
                stale,
                current: !stale,
                // One day back is enough: the coverage's last day is the only one that can
                // have been read while it was forming.
                refresh_from: market::ist_day_start(c.to_ms),
            }
        }
    }
}

/// The ranges to fetch from the broker so that `[from, to]` is covered and current.
///
/// Ranges always touch the existing coverage, so a series' coverage stays one span. That
/// means a request wholly before or after it fetches the gap too (a rare shape: requests
/// are normally "from some date until now").
pub fn plan(coverage: Option<Coverage>, interval: &str, from_ms: i64, to_ms: i64, now_ms: i64) -> Vec<Range> {
    let to = to_ms.min(now_ms);
    if from_ms >= to {
        return Vec::new();
    }
    let Some(c) = coverage else {
        return vec![Range { from_ms, to_ms: to }];
    };

    let t = tail(interval, &c, now_ms);
    let mut ranges = Vec::new();
    if from_ms < c.from_ms {
        ranges.push(Range {
            from_ms,
            to_ms: c.from_ms,
        });
    }
    let tail_start = t.refresh_from.max(c.from_ms);
    if to > c.to_ms {
        if !t.current {
            ranges.push(Range {
                from_ms: tail_start,
                to_ms: to,
            });
        }
    } else if t.stale && to > tail_start {
        // The request only reaches the recent past, but that is what may have changed:
        // bring the series up to date rather than up to what was asked.
        ranges.push(Range {
            from_ms: tail_start,
            to_ms: now_ms,
        });
    }
    ranges
}

pub fn coverage(conn: &Connection, symbol: &str, interval: &str) -> rusqlite::Result<Option<Coverage>> {
    conn.query_row(
        "SELECT from_ts, to_ts, synced_at FROM research_coverage WHERE symbol = ?1 AND interval = ?2",
        params![symbol, interval],
        |r| {
            Ok(Coverage {
                from_ms: r.get(0)?,
                to_ms: r.get(1)?,
                synced_at: r.get(2)?,
            })
        },
    )
    .optional()
}

/// Records that `range` was fetched successfully. A range that touches the existing
/// coverage extends it; one that doesn't (a broker limit cut the fetch short of it)
/// replaces it, so the coverage never claims a span with a hole in it. The stored time of
/// the last check moves only when the newest end was looked at.
pub fn extend_coverage(
    conn: &Connection,
    symbol: &str,
    interval: &str,
    range: Range,
    now_ms: i64,
) -> rusqlite::Result<Coverage> {
    let merged = match coverage(conn, symbol, interval)? {
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
    conn.execute(
        "INSERT INTO research_coverage (symbol, interval, from_ts, to_ts, synced_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(symbol, interval) DO UPDATE SET
           from_ts = excluded.from_ts, to_ts = excluded.to_ts, synced_at = excluded.synced_at",
        params![symbol, interval, merged.from_ms, merged.to_ms, merged.synced_at],
    )?;
    Ok(merged)
}

pub fn put(conn: &mut Connection, symbol: &str, interval: &str, bars: &[Bar]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO research_bars (symbol, interval, ts, open, high, low, close, volume)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(symbol, interval, ts) DO UPDATE SET
               open = excluded.open, high = excluded.high, low = excluded.low,
               close = excluded.close, volume = excluded.volume",
        )?;
        for b in bars {
            stmt.execute(params![
                symbol, interval, b.time, b.open, b.high, b.low, b.close, b.volume
            ])?;
        }
    }
    tx.commit()
}

/// The newest `limit` bars in `[from, to]` (all of them without a limit), oldest first.
pub fn get(
    conn: &Connection,
    symbol: &str,
    interval: &str,
    from_ms: i64,
    to_ms: i64,
    limit: Option<usize>,
) -> rusqlite::Result<Vec<Bar>> {
    let mut stmt = conn.prepare(
        "SELECT ts, open, high, low, close, volume FROM research_bars
         WHERE symbol = ?1 AND interval = ?2 AND ts >= ?3 AND ts <= ?4
         ORDER BY ts DESC LIMIT ?5",
    )?;
    let rows = stmt.query_map(
        params![symbol, interval, from_ms, to_ms, limit.map_or(-1, |l| l as i64)],
        |r| {
            Ok(Bar {
                time: r.get(0)?,
                open: r.get(1)?,
                high: r.get(2)?,
                low: r.get(3)?,
                close: r.get(4)?,
                volume: r.get(5)?,
            })
        },
    )?;
    let mut bars = rows.collect::<Result<Vec<_>, _>>()?;
    bars.reverse();
    Ok(bars)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stats {
    pub series: i64,
    pub bars: i64,
}

pub fn stats(conn: &Connection) -> rusqlite::Result<Stats> {
    Ok(Stats {
        series: conn.query_row("SELECT COUNT(*) FROM research_coverage", [], |r| r.get(0))?,
        bars: conn.query_row("SELECT COUNT(*) FROM research_bars", [], |r| r.get(0))?,
    })
}

/// Forgets everything held for the research API. Returns how many bars went.
pub fn clear(conn: &mut Connection) -> rusqlite::Result<usize> {
    let tx = conn.transaction()?;
    let bars = tx.execute("DELETE FROM research_bars", [])?;
    tx.execute("DELETE FROM research_coverage", [])?;
    tx.commit()?;
    Ok(bars)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

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

    /// Monday 5 January 2026, 00:00 IST. Daily bars are IST dates and the planner reads the
    /// exchange's calendar, so its tests need real weekdays, not round multiples of a day.
    const MON: i64 = 1_767_551_400_000;
    const HOUR_MS: i64 = 60 * MINUTE_MS;

    /// `day` days after that Monday (before it, if negative), at `hour:minute` IST.
    fn at(day: i64, hour: i64, minute: i64) -> i64 {
        MON + day * DAY_MS + hour * HOUR_MS + minute * MINUTE_MS
    }

    #[test]
    fn interval_names_are_normalised() {
        for text in ["D", "d", "1D", "day", " Daily "] {
            assert_eq!(canonical_interval(text).as_deref(), Some("D"), "{text}");
        }
        for (text, minutes) in [
            ("5", "5"),
            ("minute", "1"),
            ("15minute", "15"),
            ("60m", "60"),
            ("30min", "30"),
        ] {
            assert_eq!(canonical_interval(text).as_deref(), Some(minutes), "{text}");
        }
        // `M` and `W` are the chart's month and week, never minutes.
        for text in ["", "0", "-5", "week", "W", "M", "m", "min", "abc", "1.5"] {
            assert_eq!(canonical_interval(text), None, "{text}");
        }
    }

    #[test]
    fn an_interval_knows_its_length() {
        assert_eq!(interval_ms("D"), Some(DAY_MS));
        assert_eq!(interval_ms("5"), Some(5 * MINUTE_MS));
        assert_eq!(interval_ms("nonsense"), None);
    }

    #[test]
    fn with_nothing_stored_the_whole_request_is_fetched() {
        let now = 100 * DAY_MS;
        assert_eq!(
            plan(None, "D", 10 * DAY_MS, 90 * DAY_MS, now),
            [range(10 * DAY_MS, 90 * DAY_MS)]
        );
    }

    #[test]
    fn the_end_of_a_request_is_never_later_than_now() {
        let now = 100 * DAY_MS;
        assert_eq!(
            plan(None, "D", 10 * DAY_MS, 500 * DAY_MS, now),
            [range(10 * DAY_MS, now)]
        );
        assert!(
            plan(None, "D", now, now + DAY_MS, now).is_empty(),
            "nothing lies between now and now"
        );
        assert!(plan(None, "D", 50, 50, now).is_empty());
    }

    #[test]
    fn a_covered_request_fetches_nothing() {
        // Saturday: the market is shut, and Friday's session has settled and been read.
        let now = at(5, 12, 0);
        let c = cov(at(-60, 0, 0), at(4, 18, 0), at(4, 18, 0));
        assert!(plan(Some(c), "D", at(-30, 0, 0), at(2, 0, 0), now).is_empty());
        assert!(plan(Some(c), "D", at(-60, 0, 0), at(4, 18, 0), now).is_empty());
        assert!(
            plan(Some(c), "D", at(-60, 0, 0), now, now).is_empty(),
            "nor does \"until now\""
        );
    }

    #[test]
    fn history_older_than_the_coverage_is_fetched_up_to_it() {
        let now = at(5, 12, 0);
        let c = cov(at(-30, 0, 0), at(4, 18, 0), at(4, 18, 0));
        assert_eq!(
            plan(Some(c), "D", at(-60, 0, 0), now, now),
            [range(at(-60, 0, 0), at(-30, 0, 0))]
        );
    }

    #[test]
    fn a_settled_series_is_not_fetched_again_however_old_the_sync_is() {
        // The measured bug: every symbol read at 19:26 was read again at 19:38, twelve
        // minutes for a bar that had not changed since 15:30.
        let read = at(4, 19, 26);
        let c = cov(at(-60, 0, 0), read, read);
        for now in [at(4, 19, 38), at(4, 23, 59), at(5, 12, 0), at(6, 20, 0), at(7, 9, 14)] {
            assert!(plan(Some(c), "D", at(-60, 0, 0), now, now).is_empty(), "{now}");
        }
    }

    #[test]
    fn during_the_session_a_forming_bar_is_trusted_for_five_minutes_and_then_read_again() {
        let read = at(0, 10, 0);
        let c = cov(at(-60, 0, 0), read, read);
        let asked = |now| plan(Some(c), "D", at(-60, 0, 0), now, now);
        assert!(asked(at(0, 10, 4)).is_empty());
        // One day back is enough: today's is the only bar that was forming.
        assert_eq!(asked(at(0, 10, 5)), [range(at(0, 0, 0), at(0, 10, 5))]);
    }

    #[test]
    fn the_first_look_after_the_open_starts_from_the_last_day_read() {
        let c = cov(at(-60, 0, 0), at(4, 18, 0), at(4, 18, 0));
        let now = at(7, 9, 16);
        assert_eq!(plan(Some(c), "D", at(-60, 0, 0), now, now), [range(at(4, 0, 0), now)]);
    }

    #[test]
    fn a_session_read_while_forming_is_read_once_more_after_it_settles_and_then_left_alone() {
        let from = at(-60, 0, 0);
        let c = cov(from, at(0, 12, 0), at(0, 12, 0));
        // Between the bell and the settlement nothing new is known to exist...
        assert!(plan(Some(c), "D", from, at(0, 15, 45), at(0, 15, 45)).is_empty());
        // ...and afterwards the day's final bar is fetched.
        let settled = at(0, 16, 1);
        assert_eq!(
            plan(Some(c), "D", from, settled, settled),
            [range(at(0, 0, 0), settled)]
        );
        // That read reached past the settlement, so the day is done until the next open.
        let c = cov(from, settled, settled);
        for now in [at(0, 20, 0), at(1, 8, 0), at(1, 9, 14)] {
            assert!(plan(Some(c), "D", from, now, now).is_empty(), "{now}");
        }
    }

    #[test]
    fn a_holiday_costs_one_check_and_then_nothing() {
        // Nobody told the planner Monday was a holiday, so it looks once...
        let from = at(-60, 0, 0);
        let c = cov(from, at(4, 18, 0), at(4, 18, 0));
        let now = at(7, 17, 0);
        assert_eq!(plan(Some(c), "D", from, now, now), [range(at(4, 0, 0), now)]);
        // ...and once that look is recorded, whatever the broker returned, coverage reaches past it.
        let c = cov(from, now, now);
        let later = now + 3 * HOUR_MS;
        assert!(plan(Some(c), "D", from, later, later).is_empty());
    }

    #[test]
    fn a_series_whose_last_sync_stopped_short_of_the_present_is_extended_at_once() {
        // Synced a minute ago, but only up to a date well in the past (a backtest window).
        let now = at(5, 12, 0);
        let c = cov(at(-60, 0, 0), at(-20, 0, 0) + DAY_MS - 1, now - MINUTE_MS);
        assert_eq!(plan(Some(c), "D", at(-60, 0, 0), now, now), [range(at(-20, 0, 0), now)]);
    }

    #[test]
    fn a_request_ending_before_the_coverages_last_day_costs_nothing_however_old_the_sync() {
        let now = at(5, 12, 0);
        let c = cov(at(-60, 0, 0), at(2, 12, 0), at(2, 12, 0));
        assert!(plan(Some(c), "D", at(-30, 0, 0), at(1, 12, 0), now).is_empty());
        // One that reaches that last day brings the series up to date rather than up to
        // what was asked, since a session has settled since it was read.
        assert_eq!(
            plan(Some(c), "D", at(-30, 0, 0), at(2, 12, 0), now),
            [range(at(2, 0, 0), now)]
        );
    }

    #[test]
    fn a_request_before_and_after_the_coverage_fetches_both_edges() {
        let now = at(5, 12, 0);
        let c = cov(at(-40, 0, 0), at(-20, 12, 0), at(-20, 12, 0));
        assert_eq!(
            plan(Some(c), "D", at(-60, 0, 0), now, now),
            [range(at(-60, 0, 0), at(-40, 0, 0)), range(at(-20, 0, 0), now)]
        );
    }

    #[test]
    fn a_request_wholly_after_the_coverage_fetches_the_gap_too_so_coverage_stays_whole() {
        let now = at(5, 12, 0);
        let c = cov(at(-60, 0, 0), at(-50, 12, 0), at(-50, 12, 0));
        assert_eq!(plan(Some(c), "D", at(-20, 0, 0), now, now), [range(at(-50, 0, 0), now)]);
    }

    #[test]
    fn intraday_follows_the_clock_not_the_calendar() {
        // A Saturday: the market is shut, yet a five-minute series still ages by its own
        // ttl, and a refresh starts three bars back.
        let five = 5 * MINUTE_MS;
        let read = at(5, 12, 0);
        let c = cov(at(5, 9, 0), read, read);
        assert!(plan(Some(c), "5", c.from_ms, at(5, 12, 4), at(5, 12, 4)).is_empty());
        let now = at(5, 12, 10);
        assert_eq!(plan(Some(c), "5", c.from_ms, now, now), [range(read - 3 * five, now)]);
    }

    #[test]
    fn coverage_starts_from_the_first_fetch_and_grows_on_touching_ranges() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        assert_eq!(coverage(&conn, SYM, "D").unwrap(), None);

        assert_eq!(
            extend_coverage(&conn, SYM, "D", range(100, 200), 1_000).unwrap(),
            cov(100, 200, 1_000)
        );
        // Older history: the span grows, but the newest end was not looked at again.
        assert_eq!(
            extend_coverage(&conn, SYM, "D", range(50, 100), 2_000).unwrap(),
            cov(50, 200, 1_000)
        );
        // Newer data: the check time moves.
        assert_eq!(
            extend_coverage(&conn, SYM, "D", range(190, 300), 3_000).unwrap(),
            cov(50, 300, 3_000)
        );
        assert_eq!(coverage(&conn, SYM, "D").unwrap(), Some(cov(50, 300, 3_000)));
    }

    #[test]
    fn a_range_that_does_not_touch_the_coverage_replaces_it_rather_than_hiding_a_gap() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        extend_coverage(&conn, SYM, "D", range(100, 200), 1_000).unwrap();
        // A broker limit cut a long fetch short: it starts well after the old end.
        let merged = extend_coverage(&conn, SYM, "D", range(500, 600), 2_000).unwrap();
        assert_eq!(merged, cov(500, 600, 2_000));
    }

    #[test]
    fn coverage_is_kept_per_symbol_and_interval() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        extend_coverage(&conn, SYM, "D", range(1, 2), 3).unwrap();
        assert_eq!(coverage(&conn, SYM, "5").unwrap(), None);
        assert_eq!(coverage(&conn, "dhan:NSE:RELIANCE", "D").unwrap(), None);
    }

    #[test]
    fn put_upserts_and_get_returns_oldest_first_within_the_range() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        put(
            &mut conn,
            SYM,
            "D",
            &(1..=10).map(|i| bar(i * 1000, i as f64)).collect::<Vec<_>>(),
        )
        .unwrap();
        put(&mut conn, SYM, "D", &[bar(10_000, 99.0)]).unwrap();

        let ranged = get(&conn, SYM, "D", 3_000, 8_000, None).unwrap();
        assert_eq!(
            ranged.iter().map(|b| b.time).collect::<Vec<_>>(),
            [3000, 4000, 5000, 6000, 7000, 8000]
        );

        let newest = get(&conn, SYM, "D", i64::MIN, i64::MAX, Some(3)).unwrap();
        assert_eq!(newest.iter().map(|b| b.time).collect::<Vec<_>>(), [8000, 9000, 10_000]);
        assert_eq!(newest[2].close, 99.0, "the newer write won");

        assert!(get(&conn, SYM, "5", i64::MIN, i64::MAX, None).unwrap().is_empty());
    }

    #[test]
    fn nothing_prunes_the_store_but_clear_empties_it() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        // Daily bars far older than any retention window survive a relaunch's housekeeping.
        put(&mut conn, SYM, "D", &[bar(1000, 1.0)]).unwrap();
        extend_coverage(&conn, SYM, "D", range(0, 2000), 1).unwrap();
        crate::store::bars_cache::prune_intraday(&conn, i64::MAX / 2).unwrap();
        assert_eq!(stats(&conn).unwrap(), Stats { series: 1, bars: 1 });

        assert_eq!(clear(&mut conn).unwrap(), 1);
        assert_eq!(stats(&conn).unwrap(), Stats { series: 0, bars: 0 });
    }
}
