use rusqlite::{params, Connection, OptionalExtension};

use crate::models::{NewWatchlistItem, WatchlistDetail, WatchlistItem, WatchlistSummary};

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<WatchlistSummary>> {
    let mut stmt = conn.prepare(
        "SELECT w.id, w.name, w.created_at, COUNT(i.id)
         FROM watchlists w LEFT JOIN watchlist_items i ON i.watchlist_id = w.id
         GROUP BY w.id ORDER BY w.id ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(WatchlistSummary {
            id: r.get(0)?,
            name: r.get(1)?,
            created_at: r.get(2)?,
            item_count: r.get(3)?,
        })
    })?;
    rows.collect()
}

pub fn get(conn: &Connection, id: i64) -> rusqlite::Result<Option<WatchlistDetail>> {
    let head = conn
        .query_row(
            "SELECT id, name, created_at FROM watchlists WHERE id = ?1",
            params![id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)),
        )
        .optional()?;
    let Some((id, name, created_at)) = head else {
        return Ok(None);
    };

    // Insertion order (the autoincrement id) is the display order, so a user's
    // hand-built list keeps the sequence they added symbols in.
    let mut stmt =
        conn.prepare("SELECT id, symbol, name FROM watchlist_items WHERE watchlist_id = ?1 ORDER BY id ASC")?;
    let items = stmt
        .query_map(params![id], |r| {
            Ok(WatchlistItem {
                id: r.get(0)?,
                symbol: r.get(1)?,
                name: r.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Some(WatchlistDetail {
        id,
        name,
        created_at,
        items,
        added: None,
    }))
}

pub fn create(conn: &Connection, name: &str) -> rusqlite::Result<i64> {
    conn.execute("INSERT INTO watchlists (name) VALUES (?1)", params![name])?;
    Ok(conn.last_insert_rowid())
}

pub fn rename(conn: &Connection, id: i64, name: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE watchlists SET name = ?1 WHERE id = ?2", params![name, id])?;
    Ok(())
}

pub fn delete(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM watchlists WHERE id = ?1", params![id])?;
    Ok(())
}

/// Adds symbols, silently skipping any already on the list. Returns how many
/// were actually new.
pub fn add_items(conn: &mut Connection, watchlist_id: i64, items: &[NewWatchlistItem]) -> rusqlite::Result<i64> {
    let tx = conn.transaction()?;
    let mut added = 0;
    {
        let mut stmt =
            tx.prepare("INSERT OR IGNORE INTO watchlist_items (watchlist_id, symbol, name) VALUES (?1, ?2, ?3)")?;
        for item in items {
            added += stmt.execute(params![watchlist_id, item.symbol, item.name])? as i64;
        }
    }
    tx.commit()?;
    Ok(added)
}

pub fn remove_items(conn: &mut Connection, watchlist_id: i64, symbols: &[String]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("DELETE FROM watchlist_items WHERE watchlist_id = ?1 AND symbol = ?2")?;
        for symbol in symbols {
            stmt.execute(params![watchlist_id, symbol])?;
        }
    }
    tx.commit()
}

const SEEDED_PREF: &str = "watchlists_seeded";

/// The starter list shown on a fresh install — a spread of instruments across
/// every built-in data source, so a new user has something to click straight
/// away. Runs once per database: deleting the list later doesn't bring it back.
const STARTER_SYMBOLS: &[(&str, &str)] = &[
    ("yahoo:^GSPC", "S&P 500"),
    ("yahoo:AAPL", "Apple Inc."),
    ("yahoo:MSFT", "Microsoft Corporation"),
    ("yahoo:NVDA", "NVIDIA Corporation"),
    ("yahoo:^NSEI", "NIFTY 50"),
    ("yahoo:RELIANCE.NS", "Reliance Industries"),
    ("yahoo:EURUSD=X", "EUR/USD"),
    ("binance:BTCUSDT", "Bitcoin / TetherUS"),
    ("binance:ETHUSDT", "Ethereum / TetherUS"),
];

pub fn seed_starter_list_once(conn: &mut Connection) -> rusqlite::Result<()> {
    if super::preferences::get(conn, SEEDED_PREF)?.is_some() {
        return Ok(());
    }
    let id = create(conn, "Getting started")?;
    let items: Vec<NewWatchlistItem> = STARTER_SYMBOLS
        .iter()
        .map(|(symbol, name)| NewWatchlistItem {
            symbol: symbol.to_string(),
            name: Some(name.to_string()),
        })
        .collect();
    add_items(conn, id, &items)?;
    super::preferences::set(conn, SEEDED_PREF, "1")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn item(symbol: &str) -> NewWatchlistItem {
        NewWatchlistItem {
            symbol: symbol.into(),
            name: None,
        }
    }

    #[test]
    fn the_starter_list_is_seeded_exactly_once() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        seed_starter_list_once(&mut conn).unwrap();
        let lists = list(&conn).unwrap();
        assert_eq!(lists.len(), 1);
        assert_eq!(lists[0].item_count as usize, STARTER_SYMBOLS.len());

        // The user deletes it; a later launch must not resurrect it.
        delete(&conn, lists[0].id).unwrap();
        seed_starter_list_once(&mut conn).unwrap();
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn create_add_and_read_back_in_insertion_order() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let id = create(&conn, "Tech").unwrap();
        let added = add_items(&mut conn, id, &[item("yahoo:MSFT"), item("yahoo:AAPL")]).unwrap();
        assert_eq!(added, 2);

        let detail = get(&conn, id).unwrap().unwrap();
        assert_eq!(detail.name, "Tech");
        assert_eq!(
            detail.items.iter().map(|i| i.symbol.as_str()).collect::<Vec<_>>(),
            ["yahoo:MSFT", "yahoo:AAPL"]
        );
    }

    #[test]
    fn duplicates_are_skipped_and_not_counted() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let id = create(&conn, "Dupes").unwrap();
        add_items(&mut conn, id, &[item("yahoo:AAPL")]).unwrap();
        let added = add_items(&mut conn, id, &[item("yahoo:AAPL"), item("yahoo:TSLA")]).unwrap();
        assert_eq!(added, 1);
        assert_eq!(get(&conn, id).unwrap().unwrap().items.len(), 2);
    }

    #[test]
    fn the_same_symbol_can_live_on_two_lists() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let a = create(&conn, "A").unwrap();
        let b = create(&conn, "B").unwrap();
        assert_eq!(add_items(&mut conn, a, &[item("yahoo:AAPL")]).unwrap(), 1);
        assert_eq!(add_items(&mut conn, b, &[item("yahoo:AAPL")]).unwrap(), 1);
    }

    #[test]
    fn remove_items_and_summary_counts() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let id = create(&conn, "L").unwrap();
        add_items(&mut conn, id, &[item("a"), item("b"), item("c")]).unwrap();
        remove_items(&mut conn, id, &["b".to_string()]).unwrap();

        let summary = list(&conn).unwrap();
        assert_eq!(summary.len(), 1);
        assert_eq!(summary[0].item_count, 2);
    }

    #[test]
    fn deleting_a_watchlist_cascades_to_its_items() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let id = create(&conn, "L").unwrap();
        add_items(&mut conn, id, &[item("a")]).unwrap();
        delete(&conn, id).unwrap();

        assert!(get(&conn, id).unwrap().is_none());
        let orphans: i64 = conn
            .query_row("SELECT COUNT(*) FROM watchlist_items", [], |r| r.get(0))
            .unwrap();
        assert_eq!(orphans, 0);
    }

    #[test]
    fn rename_updates_the_name() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let id = create(&conn, "Old").unwrap();
        rename(&conn, id, "New").unwrap();
        assert_eq!(get(&conn, id).unwrap().unwrap().name, "New");
    }
}
