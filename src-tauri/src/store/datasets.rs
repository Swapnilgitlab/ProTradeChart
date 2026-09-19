//! User-imported OHLCV datasets, stored locally and chartable as
//! `csv:<TICKER>`. They work fully offline.

use rusqlite::{params, Connection, OptionalExtension};

use crate::models::{Bar, DatasetBars, DatasetInfo, DatasetInput};

const INFO_SQL: &str = "SELECT d.ticker, d.description, d.base_tf, d.created_at,
        (SELECT COUNT(*) FROM dataset_bars b WHERE b.ticker = d.ticker),
        (SELECT MIN(ts) FROM dataset_bars b WHERE b.ticker = d.ticker),
        (SELECT MAX(ts) FROM dataset_bars b WHERE b.ticker = d.ticker)
     FROM datasets d";

fn info_from_row(r: &rusqlite::Row) -> rusqlite::Result<DatasetInfo> {
    Ok(DatasetInfo {
        ticker: r.get(0)?,
        description: r.get(1)?,
        base_tf: r.get(2)?,
        created_at: r.get(3)?,
        bar_count: r.get(4)?,
        first_time: r.get(5)?,
        last_time: r.get(6)?,
    })
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<DatasetInfo>> {
    let mut stmt = conn.prepare(&format!("{INFO_SQL} ORDER BY d.ticker ASC"))?;
    let rows = stmt.query_map([], info_from_row)?;
    rows.collect()
}

fn get_info(conn: &Connection, ticker: &str) -> rusqlite::Result<Option<DatasetInfo>> {
    conn.query_row(
        &format!("{INFO_SQL} WHERE d.ticker = ?1"),
        params![ticker],
        info_from_row,
    )
    .optional()
}

/// Sorted ascending with one bar per timestamp (the last occurrence wins), so
/// a CSV that arrives newest-first or with repeated rows still charts cleanly.
fn normalize(bars: &[Bar]) -> Vec<Bar> {
    let mut sorted: Vec<Bar> = bars.to_vec();
    sorted.sort_by_key(|b| b.time);
    let mut out: Vec<Bar> = Vec::with_capacity(sorted.len());
    for bar in sorted {
        match out.last_mut() {
            Some(last) if last.time == bar.time => *last = bar,
            _ => out.push(bar),
        }
    }
    out
}

/// Creates or fully replaces the dataset for `input.ticker`.
pub fn save(conn: &mut Connection, input: &DatasetInput) -> rusqlite::Result<DatasetInfo> {
    let ticker = input.ticker.trim().to_uppercase();
    let bars = normalize(&input.bars);

    let tx = conn.transaction()?;
    tx.execute("DELETE FROM datasets WHERE ticker = ?1", params![ticker])?; // cascades to its bars
    tx.execute(
        "INSERT INTO datasets (ticker, description, base_tf) VALUES (?1, ?2, ?3)",
        params![ticker, input.description, input.base_tf],
    )?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO dataset_bars (ticker, ts, open, high, low, close, volume) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        for b in &bars {
            stmt.execute(params![ticker, b.time, b.open, b.high, b.low, b.close, b.volume])?;
        }
    }
    tx.commit()?;

    Ok(get_info(conn, &ticker)?.expect("dataset was just inserted"))
}

pub fn delete(conn: &Connection, ticker: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM datasets WHERE ticker = ?1",
        params![ticker.trim().to_uppercase()],
    )?;
    Ok(())
}

/// The most recent `limit` bars within `[from, to]`, oldest first.
pub fn bars(
    conn: &Connection,
    ticker: &str,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
    limit: Option<usize>,
) -> rusqlite::Result<Option<DatasetBars>> {
    let ticker = ticker.trim().to_uppercase();
    let base_tf: Option<String> = conn
        .query_row("SELECT base_tf FROM datasets WHERE ticker = ?1", params![ticker], |r| {
            r.get(0)
        })
        .optional()?;
    let Some(base_tf) = base_tf else {
        return Ok(None);
    };

    let mut stmt = conn.prepare(
        "SELECT ts, open, high, low, close, volume FROM dataset_bars
         WHERE ticker = ?1 AND ts >= ?2 AND ts <= ?3 ORDER BY ts DESC LIMIT ?4",
    )?;
    let rows = stmt.query_map(
        params![
            ticker,
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
    let mut out = rows.collect::<Result<Vec<_>, _>>()?;
    out.reverse();
    Ok(Some(DatasetBars { base_tf, bars: out }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn bar(time: i64, close: f64) -> Bar {
        Bar {
            time,
            open: close,
            high: close,
            low: close,
            close,
            volume: None,
        }
    }

    fn input(ticker: &str, bars: Vec<Bar>) -> DatasetInput {
        DatasetInput {
            ticker: ticker.into(),
            description: Some("test".into()),
            base_tf: "D".into(),
            bars,
        }
    }

    #[test]
    fn save_normalizes_ticker_sorts_and_dedupes_bars() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let info = save(
            &mut conn,
            &input(" mydata ", vec![bar(3, 3.0), bar(1, 1.0), bar(3, 33.0), bar(2, 2.0)]),
        )
        .unwrap();

        assert_eq!(info.ticker, "MYDATA");
        assert_eq!(info.bar_count, 3);
        assert_eq!(info.first_time, Some(1));
        assert_eq!(info.last_time, Some(3));

        let stored = bars(&conn, "mydata", None, None, None).unwrap().unwrap();
        assert_eq!(stored.bars.iter().map(|b| b.time).collect::<Vec<_>>(), [1, 2, 3]);
        assert_eq!(stored.bars[2].close, 33.0);
    }

    #[test]
    fn saving_the_same_ticker_replaces_the_previous_bars() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        save(&mut conn, &input("X", vec![bar(1, 1.0), bar(2, 2.0)])).unwrap();
        let info = save(&mut conn, &input("X", vec![bar(10, 5.0)])).unwrap();

        assert_eq!(info.bar_count, 1);
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn bars_honours_range_and_limit_and_reports_unknown_tickers() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        save(&mut conn, &input("X", (1..=10).map(|i| bar(i, i as f64)).collect())).unwrap();

        let limited = bars(&conn, "X", None, Some(8), Some(3)).unwrap().unwrap();
        assert_eq!(limited.bars.iter().map(|b| b.time).collect::<Vec<_>>(), [6, 7, 8]);
        assert_eq!(limited.base_tf, "D");
        assert!(bars(&conn, "NOPE", None, None, None).unwrap().is_none());
    }

    #[test]
    fn delete_removes_dataset_and_bars() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        save(&mut conn, &input("X", vec![bar(1, 1.0)])).unwrap();
        delete(&conn, "x").unwrap();

        assert!(list(&conn).unwrap().is_empty());
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM dataset_bars", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }
}
