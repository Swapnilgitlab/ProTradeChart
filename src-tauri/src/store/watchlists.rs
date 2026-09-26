use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};

use crate::models::{
    NewWatchlistItem, RowKind, RowRef, WatchlistDetail, WatchlistItem, WatchlistSection, WatchlistSummary,
};

/// The colours a symbol can be flagged with.
pub const FLAGS: &[&str] = &["red", "orange", "yellow", "green", "blue", "purple"];

pub fn is_flag(name: &str) -> bool {
    FLAGS.contains(&name)
}

fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
        params![table, column],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
}

/// Brings a database made before rows had a position and a flag up to date. `CREATE TABLE IF NOT EXISTS`
/// leaves an old table as it was, so these two columns have to be added by hand — once: a database that
/// has them is left alone.
pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    if !has_column(conn, "watchlist_items", "position")? {
        // Lists used to be shown in insertion order, which is the autoincrement id, so that becomes the position.
        conn.execute_batch(
            "ALTER TABLE watchlist_items ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
             UPDATE watchlist_items SET position = id;",
        )?;
    }
    if !has_column(conn, "watchlist_items", "flag")? {
        conn.execute_batch("ALTER TABLE watchlist_items ADD COLUMN flag TEXT;")?;
    }
    Ok(())
}

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

    // `position` is the display order, so a hand-built (or hand-reordered) list keeps its sequence; the id
    // breaks a tie.
    let mut stmt = conn.prepare(
        "SELECT id, symbol, name, position, flag FROM watchlist_items
         WHERE watchlist_id = ?1 ORDER BY position ASC, id ASC",
    )?;
    let items = stmt
        .query_map(params![id], |r| {
            Ok(WatchlistItem {
                id: r.get(0)?,
                symbol: r.get(1)?,
                name: r.get(2)?,
                position: r.get(3)?,
                flag: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut stmt = conn.prepare(
        "SELECT id, name, position, collapsed FROM watchlist_sections
         WHERE watchlist_id = ?1 ORDER BY position ASC, id ASC",
    )?;
    let sections = stmt
        .query_map(params![id], |r| {
            Ok(WatchlistSection {
                id: r.get(0)?,
                name: r.get(1)?,
                position: r.get(2)?,
                collapsed: r.get::<_, i64>(3)? != 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Some(WatchlistDetail {
        id,
        name,
        created_at,
        items,
        sections,
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

/// The position after the last row of a list, symbols and section headings together.
fn next_position(conn: &Connection, watchlist_id: i64) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(position), 0) + 1 FROM (
             SELECT position FROM watchlist_items WHERE watchlist_id = ?1
             UNION ALL
             SELECT position FROM watchlist_sections WHERE watchlist_id = ?1
         )",
        params![watchlist_id],
        |r| r.get(0),
    )
}

/// Adds symbols to the end of the list, silently skipping any already on it. Returns how many
/// were actually new.
pub fn add_items(conn: &mut Connection, watchlist_id: i64, items: &[NewWatchlistItem]) -> rusqlite::Result<i64> {
    let tx = conn.transaction()?;
    let mut added = 0;
    {
        let mut position = next_position(&tx, watchlist_id)?;
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO watchlist_items (watchlist_id, symbol, name, position) VALUES (?1, ?2, ?3, ?4)",
        )?;
        for item in items {
            if stmt.execute(params![watchlist_id, item.symbol, item.name, position])? == 1 {
                position += 1;
                added += 1;
            }
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

/// Marks a symbol with a colour, or clears the mark. The caller checks the name with `is_flag`.
pub fn set_flag(conn: &Connection, watchlist_id: i64, symbol: &str, flag: Option<&str>) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE watchlist_items SET flag = ?1 WHERE watchlist_id = ?2 AND symbol = ?3",
        params![flag, watchlist_id, symbol],
    )?;
    Ok(())
}

/// Every row of a list — symbols and section headings together — in the order shown. A heading comes
/// before a symbol that shares its position, so a symbol never slips under the wrong one.
fn order(conn: &Connection, watchlist_id: i64) -> rusqlite::Result<Vec<RowRef>> {
    let mut stmt = conn.prepare(
        "SELECT 0 AS rank, id, position FROM watchlist_sections WHERE watchlist_id = ?1
         UNION ALL
         SELECT 1, id, position FROM watchlist_items WHERE watchlist_id = ?1
         ORDER BY position, rank, id",
    )?;
    let rows = stmt.query_map(params![watchlist_id], |r| {
        Ok(RowRef {
            kind: if r.get::<_, i64>(0)? == 0 {
                RowKind::Section
            } else {
                RowKind::Item
            },
            id: r.get(1)?,
        })
    })?;
    rows.collect()
}

/// Renumbers a list's rows so they read `wanted` first, in that order, and any row it leaves out follows in
/// its current order. A row that isn't on the list any more (deleted since the caller looked) is skipped, so
/// a stale order can neither fail nor scramble what is there.
fn write_order(conn: &Connection, watchlist_id: i64, wanted: &[RowRef]) -> rusqlite::Result<()> {
    let current = order(conn, watchlist_id)?;
    let known: HashSet<RowRef> = current.iter().copied().collect();
    let mut placed: HashSet<RowRef> = HashSet::new();
    let mut rows: Vec<RowRef> = Vec::with_capacity(current.len());
    for row in wanted.iter().chain(current.iter()) {
        if known.contains(row) && placed.insert(*row) {
            rows.push(*row);
        }
    }

    let mut item = conn.prepare("UPDATE watchlist_items SET position = ?1 WHERE id = ?2")?;
    let mut section = conn.prepare("UPDATE watchlist_sections SET position = ?1 WHERE id = ?2")?;
    for (i, row) in rows.iter().enumerate() {
        let position = i as i64 + 1;
        match row.kind {
            RowKind::Item => item.execute(params![position, row.id])?,
            RowKind::Section => section.execute(params![position, row.id])?,
        };
    }
    Ok(())
}

/// Puts the list's rows in the given order (see `write_order` for what is left out or unknown).
pub fn set_order(conn: &mut Connection, watchlist_id: i64, wanted: &[RowRef]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    write_order(&tx, watchlist_id, wanted)?;
    tx.commit()
}

/// Adds a section heading — before `before` when that row is on the list, otherwise at the end.
pub fn add_section(
    conn: &mut Connection,
    watchlist_id: i64,
    name: &str,
    before: Option<RowRef>,
) -> rusqlite::Result<i64> {
    let tx = conn.transaction()?;
    let position = next_position(&tx, watchlist_id)?;
    tx.execute(
        "INSERT INTO watchlist_sections (watchlist_id, name, position) VALUES (?1, ?2, ?3)",
        params![watchlist_id, name, position],
    )?;
    let id = tx.last_insert_rowid();
    if let Some(before) = before {
        let new = RowRef {
            kind: RowKind::Section,
            id,
        };
        let mut rows = order(&tx, watchlist_id)?;
        rows.retain(|row| *row != new);
        if let Some(at) = rows.iter().position(|row| *row == before) {
            rows.insert(at, new);
            write_order(&tx, watchlist_id, &rows)?;
        }
    }
    tx.commit()?;
    Ok(id)
}

pub fn rename_section(conn: &Connection, id: i64, name: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE watchlist_sections SET name = ?1 WHERE id = ?2",
        params![name, id],
    )?;
    Ok(())
}

/// Removes a heading. The symbols under it stay, and now belong to the heading above.
pub fn delete_section(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM watchlist_sections WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn set_section_collapsed(conn: &Connection, id: i64, collapsed: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE watchlist_sections SET collapsed = ?1 WHERE id = ?2",
        params![collapsed as i64, id],
    )?;
    Ok(())
}

const SEEDED_PREF: &str = "watchlists_seeded";

/// The starter list shown on a fresh install — a spread across the crypto sources
/// that need no account, so a new user has something to click straight away. Runs once per database: deleting the list later doesn't bring it back.
const STARTER_SYMBOLS: &[(&str, &str)] = &[
    ("binance:BTCUSDT", "Bitcoin / TetherUS"),
    ("binance:ETHUSDT", "Ethereum / TetherUS"),
    ("binance:SOLUSDT", "Solana / TetherUS"),
    ("binance:BNBUSDT", "BNB / TetherUS"),
    ("coinbase:BTC-USD", "Bitcoin / US Dollar"),
    ("coinbase:ETH-USD", "Ethereum / US Dollar"),
    ("hyperliquid:BTC", "Bitcoin perpetual"),
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
    use crate::schema::SCHEMA_SQL;

    fn item(symbol: &str) -> NewWatchlistItem {
        NewWatchlistItem {
            symbol: symbol.into(),
            name: None,
        }
    }

    fn symbols(conn: &Connection, id: i64) -> Vec<String> {
        get(conn, id)
            .unwrap()
            .unwrap()
            .items
            .into_iter()
            .map(|i| i.symbol)
            .collect()
    }

    /// The list as shown: `#name` for a section heading, the symbol otherwise.
    fn rows(conn: &Connection, id: i64) -> Vec<String> {
        let d = get(conn, id).unwrap().unwrap();
        let mut all: Vec<(i64, u8, String)> = d
            .sections
            .iter()
            .map(|s| (s.position, 0, format!("#{}", s.name)))
            .chain(d.items.iter().map(|i| (i.position, 1, i.symbol.clone())))
            .collect();
        all.sort();
        all.into_iter().map(|(_, _, label)| label).collect()
    }

    fn item_ref(conn: &Connection, id: i64, symbol: &str) -> RowRef {
        let found = get(conn, id)
            .unwrap()
            .unwrap()
            .items
            .into_iter()
            .find(|i| i.symbol == symbol)
            .unwrap();
        RowRef {
            kind: RowKind::Item,
            id: found.id,
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
        let added = add_items(&mut conn, id, &[item("binance:ETHUSDT"), item("binance:BTCUSDT")]).unwrap();
        assert_eq!(added, 2);

        let detail = get(&conn, id).unwrap().unwrap();
        assert_eq!(detail.name, "Tech");
        assert_eq!(
            detail.items.iter().map(|i| i.symbol.as_str()).collect::<Vec<_>>(),
            ["binance:ETHUSDT", "binance:BTCUSDT"]
        );
    }

    #[test]
    fn duplicates_are_skipped_and_not_counted() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let id = create(&conn, "Dupes").unwrap();
        add_items(&mut conn, id, &[item("binance:BTCUSDT")]).unwrap();
        let added = add_items(&mut conn, id, &[item("binance:BTCUSDT"), item("binance:SOLUSDT")]).unwrap();
        assert_eq!(added, 1);
        assert_eq!(get(&conn, id).unwrap().unwrap().items.len(), 2);
    }

    #[test]
    fn the_same_symbol_can_live_on_two_lists() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let a = create(&conn, "A").unwrap();
        let b = create(&conn, "B").unwrap();
        assert_eq!(add_items(&mut conn, a, &[item("binance:BTCUSDT")]).unwrap(), 1);
        assert_eq!(add_items(&mut conn, b, &[item("binance:BTCUSDT")]).unwrap(), 1);
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
    fn deleting_a_watchlist_cascades_to_its_items_and_sections() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let id = create(&conn, "L").unwrap();
        add_items(&mut conn, id, &[item("a")]).unwrap();
        add_section(&mut conn, id, "S", None).unwrap();
        delete(&conn, id).unwrap();

        assert!(get(&conn, id).unwrap().is_none());
        let orphans: i64 = conn
            .query_row("SELECT COUNT(*) FROM watchlist_items", [], |r| r.get(0))
            .unwrap();
        assert_eq!(orphans, 0);
        let orphan_sections: i64 = conn
            .query_row("SELECT COUNT(*) FROM watchlist_sections", [], |r| r.get(0))
            .unwrap();
        assert_eq!(orphan_sections, 0);
    }

    #[test]
    fn rename_updates_the_name() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let id = create(&conn, "Old").unwrap();
        rename(&conn, id, "New").unwrap();
        assert_eq!(get(&conn, id).unwrap().unwrap().name, "New");
    }

    #[test]
    fn a_list_made_before_positions_and_flags_keeps_its_order_when_upgraded() {
        // What an existing install has on disk: the old two tables, rows in insertion order (with the ids
        // of two lists interleaved), then the new binary's schema and migration run over it.
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE watchlists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT (datetime('now')));
             CREATE TABLE watchlist_items (id INTEGER PRIMARY KEY AUTOINCREMENT,
               watchlist_id INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
               symbol TEXT NOT NULL, name TEXT, UNIQUE (watchlist_id, symbol));
             INSERT INTO watchlists (name) VALUES ('A'), ('B');
             INSERT INTO watchlist_items (watchlist_id, symbol) VALUES
               (1, 'a1'), (2, 'b1'), (1, 'a2'), (2, 'b2'), (1, 'a3');",
        )
        .unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        migrate(&conn).unwrap();

        assert_eq!(symbols(&conn, 1), ["a1", "a2", "a3"]);
        assert_eq!(symbols(&conn, 2), ["b1", "b2"]);
        assert!(get(&conn, 1).unwrap().unwrap().items.iter().all(|i| i.flag.is_none()));

        // A symbol added afterwards goes to the end, and a second run of the migration changes nothing.
        add_items(&mut conn, 1, &[item("a4")]).unwrap();
        migrate(&conn).unwrap();
        assert_eq!(symbols(&conn, 1), ["a1", "a2", "a3", "a4"]);
    }

    #[test]
    fn a_fresh_database_needs_no_migration() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        assert!(has_column(&conn, "watchlist_items", "position").unwrap());
        assert!(has_column(&conn, "watchlist_items", "flag").unwrap());
        migrate(&conn).unwrap();
    }

    #[test]
    fn reordering_puts_the_rows_where_they_were_dropped() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let id = create(&conn, "L").unwrap();
        add_items(&mut conn, id, &[item("a"), item("b"), item("c")]).unwrap();

        let (a, b, c) = (
            item_ref(&conn, id, "a"),
            item_ref(&conn, id, "b"),
            item_ref(&conn, id, "c"),
        );
        set_order(&mut conn, id, &[c, a, b]).unwrap();
        assert_eq!(symbols(&conn, id), ["c", "a", "b"]);

        // New symbols still go to the end of whatever order the list is in now.
        add_items(&mut conn, id, &[item("d")]).unwrap();
        assert_eq!(symbols(&conn, id), ["c", "a", "b", "d"]);
    }

    #[test]
    fn an_order_that_leaves_rows_out_or_names_unknown_ones_is_tolerated() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let id = create(&conn, "L").unwrap();
        let other = create(&conn, "Other").unwrap();
        add_items(&mut conn, id, &[item("a"), item("b"), item("c")]).unwrap();
        add_items(&mut conn, other, &[item("x")]).unwrap();

        let c = item_ref(&conn, id, "c");
        let foreign = item_ref(&conn, other, "x");
        let ghost = RowRef {
            kind: RowKind::Item,
            id: 9999,
        };
        // Only "c" is mentioned (the rest were added by someone else meanwhile), plus a row of another
        // list and one that no longer exists.
        set_order(&mut conn, id, &[ghost, c, foreign, c]).unwrap();

        assert_eq!(symbols(&conn, id), ["c", "a", "b"]);
        assert_eq!(symbols(&conn, other), ["x"], "another list's rows are never touched");
    }

    #[test]
    fn sections_sit_among_the_symbols_and_can_be_inserted_before_a_row() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let id = create(&conn, "L").unwrap();
        add_items(&mut conn, id, &[item("a"), item("b"), item("c")]).unwrap();

        // At the end by default…
        add_section(&mut conn, id, "End", None).unwrap();
        assert_eq!(rows(&conn, id), ["a", "b", "c", "#End"]);

        // …or before a given row, symbol or section.
        let b = item_ref(&conn, id, "b");
        add_section(&mut conn, id, "Mid", Some(b)).unwrap();
        assert_eq!(rows(&conn, id), ["a", "#Mid", "b", "c", "#End"]);

        let first = item_ref(&conn, id, "a");
        add_section(&mut conn, id, "Top", Some(first)).unwrap();
        assert_eq!(rows(&conn, id), ["#Top", "a", "#Mid", "b", "c", "#End"]);

        // A symbol added now lands at the very end, under the last section.
        add_items(&mut conn, id, &[item("d")]).unwrap();
        assert_eq!(rows(&conn, id), ["#Top", "a", "#Mid", "b", "c", "#End", "d"]);
    }

    #[test]
    fn a_section_before_a_row_that_is_not_there_goes_to_the_end() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let id = create(&conn, "L").unwrap();
        add_items(&mut conn, id, &[item("a")]).unwrap();
        let ghost = RowRef {
            kind: RowKind::Item,
            id: 9999,
        };
        add_section(&mut conn, id, "S", Some(ghost)).unwrap();
        assert_eq!(rows(&conn, id), ["a", "#S"]);
    }

    #[test]
    fn a_reorder_can_move_a_section_and_the_symbols_beside_it() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let id = create(&conn, "L").unwrap();
        add_items(&mut conn, id, &[item("a"), item("b")]).unwrap();
        let s = add_section(&mut conn, id, "S", None).unwrap();
        add_items(&mut conn, id, &[item("c")]).unwrap();
        assert_eq!(rows(&conn, id), ["a", "b", "#S", "c"]);

        let section = RowRef {
            kind: RowKind::Section,
            id: s,
        };
        let (a, b, c) = (
            item_ref(&conn, id, "a"),
            item_ref(&conn, id, "b"),
            item_ref(&conn, id, "c"),
        );
        set_order(&mut conn, id, &[section, c, a, b]).unwrap();
        assert_eq!(rows(&conn, id), ["#S", "c", "a", "b"]);
    }

    #[test]
    fn renaming_collapsing_and_deleting_a_section() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let id = create(&conn, "L").unwrap();
        add_items(&mut conn, id, &[item("a")]).unwrap();
        let s = add_section(&mut conn, id, "Old", None).unwrap();
        add_items(&mut conn, id, &[item("b")]).unwrap();

        rename_section(&conn, s, "New").unwrap();
        set_section_collapsed(&conn, s, true).unwrap();
        let detail = get(&conn, id).unwrap().unwrap();
        assert_eq!(detail.sections.len(), 1);
        assert_eq!(detail.sections[0].name, "New");
        assert!(detail.sections[0].collapsed);

        set_section_collapsed(&conn, s, false).unwrap();
        assert!(!get(&conn, id).unwrap().unwrap().sections[0].collapsed);

        // Deleting the heading keeps every symbol, in place.
        delete_section(&conn, s).unwrap();
        assert_eq!(rows(&conn, id), ["a", "b"]);
    }

    #[test]
    fn flags_are_set_cleared_and_only_on_that_list() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let a = create(&conn, "A").unwrap();
        let b = create(&conn, "B").unwrap();
        add_items(&mut conn, a, &[item("x"), item("y")]).unwrap();
        add_items(&mut conn, b, &[item("x")]).unwrap();

        set_flag(&conn, a, "x", Some("red")).unwrap();
        let flags = |list: i64| -> Vec<Option<String>> {
            get(&conn, list)
                .unwrap()
                .unwrap()
                .items
                .into_iter()
                .map(|i| i.flag)
                .collect()
        };
        assert_eq!(flags(a), [Some("red".to_string()), None]);
        assert_eq!(flags(b), [None], "the same symbol on another list keeps its own flag");

        set_flag(&conn, a, "x", None).unwrap();
        assert_eq!(flags(a), [None, None]);
    }

    #[test]
    fn only_the_known_colours_are_flags() {
        assert!(FLAGS.iter().all(|f| is_flag(f)));
        assert!(!is_flag("pink"));
        assert!(!is_flag(""));
        assert!(!is_flag("Red"));
    }
}
