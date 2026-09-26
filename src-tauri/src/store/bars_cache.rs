//! Read-through cache of the brokers' bars (`dhan:…`, `zerodha:…`). It is only
//! consulted when the network request fails, so the chart still draws something
//! offline.

use rusqlite::{params, Connection};

use crate::models::Bar;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Intraday history is bulky and goes stale fast, so it's trimmed on launch.
const INTRADAY_RETENTION_MS: i64 = 45 * DAY_MS;

pub fn put(conn: &mut Connection, symbol: &str, interval: &str, bars: &[Bar]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO bars_cache (symbol, interval, ts, open, high, low, close, volume)
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

/// The most recent `limit` cached bars in `[from, to]`, oldest first.
pub fn get(
    conn: &Connection,
    symbol: &str,
    interval: &str,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
    limit: Option<usize>,
) -> rusqlite::Result<Vec<Bar>> {
    let mut stmt = conn.prepare(
        "SELECT ts, open, high, low, close, volume FROM bars_cache
         WHERE symbol = ?1 AND interval = ?2 AND ts >= ?3 AND ts <= ?4
         ORDER BY ts DESC LIMIT ?5",
    )?;
    let rows = stmt.query_map(
        params![
            symbol,
            interval,
            from_ms.unwrap_or(i64::MIN),
            to_ms.unwrap_or(i64::MAX),
            limit.map_or(-1, |l| l as i64)
        ],
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

/// Drops minute bars older than the retention window. The brokers cache minute bars under the
/// bare minute count (`5`, `60`) and everything coarser under a word or letter (`D`), so a
/// digits-only interval is intraday and nothing else is ever pruned.
pub fn prune_intraday(conn: &Connection, now_ms: i64) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM bars_cache
         WHERE interval GLOB '[0-9]*' AND interval NOT GLOB '*[^0-9]*' AND ts < ?1",
        params![now_ms - INTRADAY_RETENTION_MS],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

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

    #[test]
    fn put_then_get_returns_bars_oldest_first_and_upserts() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        put(
            &mut conn,
            "dhan:NSE:RELIANCE",
            "1D",
            &[bar(1000, 1.0), bar(2000, 2.0), bar(3000, 3.0)],
        )
        .unwrap();
        put(&mut conn, "dhan:NSE:RELIANCE", "1D", &[bar(3000, 9.0)]).unwrap();

        let bars = get(&conn, "dhan:NSE:RELIANCE", "1D", None, None, None).unwrap();
        assert_eq!(bars.iter().map(|b| b.time).collect::<Vec<_>>(), [1000, 2000, 3000]);
        assert_eq!(bars[2].close, 9.0);
    }

    #[test]
    fn get_respects_range_and_keeps_the_newest_bars_under_a_limit() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let bars: Vec<_> = (1..=10).map(|i| bar(i * 1000, i as f64)).collect();
        put(&mut conn, "X", "1d", &bars).unwrap();

        let ranged = get(&conn, "X", "1d", Some(3000), Some(8000), None).unwrap();
        assert_eq!(ranged.len(), 6);

        let limited = get(&conn, "X", "1d", None, None, Some(3)).unwrap();
        assert_eq!(limited.iter().map(|b| b.time).collect::<Vec<_>>(), [8000, 9000, 10000]);
    }

    #[test]
    fn cache_is_keyed_by_symbol_and_interval() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        put(&mut conn, "X", "1d", &[bar(1000, 1.0)]).unwrap();
        assert!(get(&conn, "X", "5m", None, None, None).unwrap().is_empty());
        assert!(get(&conn, "Y", "1d", None, None, None).unwrap().is_empty());
    }

    /// The brokers cache under the upper-cased interval the chart asked for: `D` for daily
    /// (and for week and month, which are built from daily) and a minute count for the rest.
    /// Pruning once compared against Yahoo's lower-case spellings (`1d`), so it deleted every
    /// broker daily bar older than 45 days on each launch.
    #[test]
    fn prune_drops_old_minute_bars_but_keeps_a_brokers_daily_history() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let old = 1000;
        for interval in ["1", "5", "15", "60"] {
            put(&mut conn, "zerodha:NSE:RELIANCE", interval, &[bar(old, 1.0)]).unwrap();
        }
        // `D` is what the chart asks for; `DAY` is how Kite spells it, upper-cased.
        for interval in ["D", "DAY"] {
            put(&mut conn, "zerodha:NSE:RELIANCE", interval, &[bar(old, 1.0)]).unwrap();
        }

        prune_intraday(&conn, old + INTRADAY_RETENTION_MS + 1).unwrap();

        for interval in ["1", "5", "15", "60"] {
            let left = get(&conn, "zerodha:NSE:RELIANCE", interval, None, None, None).unwrap();
            assert!(left.is_empty(), "old {interval}-minute bars should have been pruned");
        }
        for interval in ["D", "DAY"] {
            let left = get(&conn, "zerodha:NSE:RELIANCE", interval, None, None, None).unwrap();
            assert_eq!(left.len(), 1, "daily bars ({interval}) must survive pruning");
        }
    }

    #[test]
    fn prune_keeps_recent_minute_bars() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let now = 100 * DAY_MS;
        put(
            &mut conn,
            "dhan:NSE:TCS",
            "5",
            &[bar(now - 10 * DAY_MS, 1.0), bar(now - 50 * DAY_MS, 1.0)],
        )
        .unwrap();

        prune_intraday(&conn, now).unwrap();

        let left = get(&conn, "dhan:NSE:TCS", "5", None, None, None).unwrap();
        assert_eq!(left.iter().map(|b| b.time).collect::<Vec<_>>(), [now - 10 * DAY_MS]);
    }
}
