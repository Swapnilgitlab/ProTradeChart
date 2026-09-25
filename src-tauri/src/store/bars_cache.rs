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

pub fn prune_intraday(conn: &Connection, now_ms: i64) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM bars_cache WHERE interval NOT IN ('1d', '5d', '1wk', '1mo', '3mo') AND ts < ?1",
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

    #[test]
    fn prune_drops_old_intraday_but_keeps_daily_history() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        put(&mut conn, "X", "5m", &[bar(1000, 1.0)]).unwrap();
        put(&mut conn, "X", "1d", &[bar(1000, 1.0)]).unwrap();

        prune_intraday(&conn, 1000 + INTRADAY_RETENTION_MS + 1).unwrap();

        assert!(get(&conn, "X", "5m", None, None, None).unwrap().is_empty());
        assert_eq!(get(&conn, "X", "1d", None, None, None).unwrap().len(), 1);
    }
}
