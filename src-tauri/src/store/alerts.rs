//! Price alerts: what to watch, the level, and what has fired. Plain functions
//! over a `&Connection`, like the rest of `store`. The alert *engine* (which
//! decides when a price has crossed a level) lives in the frontend; this file
//! only remembers the alerts, so every window sees the same list.

use rusqlite::{params, Connection};

use crate::models::PriceAlert;

const COLUMNS: &str = "id, symbol, condition, price, base_price, message, mode, status, created_at, \
                       triggered_at, trigger_price, trigger_count";

fn from_row(row: &rusqlite::Row) -> rusqlite::Result<PriceAlert> {
    Ok(PriceAlert {
        id: row.get(0)?,
        symbol: row.get(1)?,
        condition: row.get(2)?,
        price: row.get(3)?,
        base_price: row.get(4)?,
        message: row.get(5)?,
        mode: row.get(6)?,
        status: row.get(7)?,
        created_at: row.get(8)?,
        triggered_at: row.get(9)?,
        trigger_price: row.get(10)?,
        trigger_count: row.get(11)?,
    })
}

/// Newest first.
pub fn list(conn: &Connection) -> rusqlite::Result<Vec<PriceAlert>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM price_alerts ORDER BY created_at DESC, id ASC"
    ))?;
    let rows = stmt.query_map([], from_row)?;
    rows.collect()
}

/// Inserts an alert, or replaces the one with the same id.
pub fn save(conn: &Connection, a: &PriceAlert) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO price_alerts (id, symbol, condition, price, base_price, message, mode, status, created_at,
                                   triggered_at, trigger_price, trigger_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET
           symbol = excluded.symbol, condition = excluded.condition, price = excluded.price,
           base_price = excluded.base_price, message = excluded.message, mode = excluded.mode,
           status = excluded.status, triggered_at = excluded.triggered_at,
           trigger_price = excluded.trigger_price, trigger_count = excluded.trigger_count",
        params![
            a.id,
            a.symbol,
            a.condition,
            a.price,
            a.base_price,
            a.message,
            a.mode,
            a.status,
            a.created_at,
            a.triggered_at,
            a.trigger_price,
            a.trigger_count
        ],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM price_alerts WHERE id = ?1", params![id])?;
    Ok(())
}

/// Removes every alert that has already fired and won't fire again. Returns how many.
pub fn delete_triggered(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM price_alerts WHERE status = 'triggered'", [])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn alert(id: &str, symbol: &str, price: f64, created_at: i64) -> PriceAlert {
        PriceAlert {
            id: id.into(),
            symbol: symbol.into(),
            condition: "crossing_up".into(),
            price,
            base_price: Some(price - 5.0),
            message: String::new(),
            mode: "once".into(),
            status: "active".into(),
            created_at,
            triggered_at: None,
            trigger_price: None,
            trigger_count: 0,
        }
    }

    #[test]
    fn a_saved_alert_reads_back_exactly() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let mut a = alert("a1", "yahoo:AAPL", 250.5, 100);
        a.message = "earnings tomorrow".into();
        a.mode = "every".into();
        save(&conn, &a).unwrap();
        assert_eq!(list(&conn).unwrap(), vec![a]);
    }

    #[test]
    fn alerts_are_listed_newest_first() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        save(&conn, &alert("old", "yahoo:A", 1.0, 100)).unwrap();
        save(&conn, &alert("new", "yahoo:B", 2.0, 300)).unwrap();
        save(&conn, &alert("mid", "yahoo:C", 3.0, 200)).unwrap();
        let ids: Vec<_> = list(&conn).unwrap().into_iter().map(|a| a.id).collect();
        assert_eq!(ids, ["new", "mid", "old"]);
    }

    #[test]
    fn saving_again_updates_in_place_and_keeps_the_creation_time() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        save(&conn, &alert("a1", "yahoo:AAPL", 250.0, 100)).unwrap();

        let mut fired = alert("a1", "yahoo:AAPL", 260.0, 999);
        fired.status = "triggered".into();
        fired.triggered_at = Some(500);
        fired.trigger_price = Some(260.4);
        fired.trigger_count = 1;
        save(&conn, &fired).unwrap();

        let all = list(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].price, 260.0);
        assert_eq!((all[0].status.as_str(), all[0].trigger_count), ("triggered", 1));
        assert_eq!(all[0].trigger_price, Some(260.4));
        assert_eq!(all[0].created_at, 100, "the original creation time survives an update");
    }

    #[test]
    fn a_missing_base_price_and_trigger_time_are_stored_as_null() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let mut a = alert("a1", "yahoo:AAPL", 250.0, 1);
        a.base_price = None;
        save(&conn, &a).unwrap();
        let back = &list(&conn).unwrap()[0];
        assert_eq!(
            (back.base_price, back.triggered_at, back.trigger_price),
            (None, None, None)
        );
    }

    #[test]
    fn delete_removes_one_alert_and_ignores_an_unknown_id() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        save(&conn, &alert("a", "yahoo:A", 1.0, 1)).unwrap();
        save(&conn, &alert("b", "yahoo:B", 2.0, 2)).unwrap();
        delete(&conn, "a").unwrap();
        delete(&conn, "nope").unwrap();
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn clearing_triggered_alerts_leaves_the_active_and_paused_ones() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        for (id, status) in [("a", "active"), ("b", "triggered"), ("c", "paused"), ("d", "triggered")] {
            let mut a = alert(id, "yahoo:X", 1.0, 1);
            a.status = status.into();
            save(&conn, &a).unwrap();
        }
        assert_eq!(delete_triggered(&conn).unwrap(), 2);
        let mut left: Vec<_> = list(&conn).unwrap().into_iter().map(|a| a.id).collect();
        left.sort();
        assert_eq!(left, ["a", "c"]);
    }
}
