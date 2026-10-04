use std::collections::{HashMap, HashSet};

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
    // Flags used to belong to a list's row; they belong to the symbol now. Each flagged symbol keeps the
    // flag of the first list it was flagged on, and the rows' own flags are cleared, so this does nothing
    // the second time.
    conn.execute_batch(
        "INSERT OR IGNORE INTO symbol_flags (symbol, flag, flagged_at)
           SELECT symbol, flag, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM watchlist_items
           WHERE flag IS NOT NULL ORDER BY watchlist_id, position;
         UPDATE watchlist_items SET flag = NULL WHERE flag IS NOT NULL;",
    )?;
    Ok(())
}

// ---- Colour flags ----------------------------------------------------------------------------------

/// The id a colour's list goes by: negative, so it can never be a real watchlist's. Red is -1, purple -6.
pub fn flag_list_id(flag: &str) -> Option<i64> {
    FLAGS.iter().position(|f| *f == flag).map(|i| -(i as i64) - 1)
}

/// The colour whose list `id` is, if it is one.
pub fn flag_of_list(id: i64) -> Option<&'static str> {
    if id >= 0 {
        return None;
    }
    FLAGS.get((-id - 1) as usize).copied()
}

fn flag_list_name(flag: &str) -> String {
    let mut chars = flag.chars();
    let first = chars
        .next()
        .map(|c| c.to_uppercase().collect::<String>())
        .unwrap_or_default();
    format!("{first}{} flag", chars.as_str())
}

/// Flags a symbol with a colour, or clears its flag. Changing the colour counts as flagging it anew;
/// setting the colour it already has changes nothing. The caller checks the name with `is_flag`.
pub fn set_symbol_flag(conn: &Connection, symbol: &str, flag: Option<&str>, now: i64) -> rusqlite::Result<()> {
    match flag {
        None => conn.execute("DELETE FROM symbol_flags WHERE symbol = ?1", params![symbol])?,
        Some(flag) => conn.execute(
            "INSERT INTO symbol_flags (symbol, flag, flagged_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(symbol) DO UPDATE SET flag = excluded.flag,
               flagged_at = CASE WHEN symbol_flags.flag = excluded.flag THEN symbol_flags.flagged_at ELSE excluded.flagged_at END",
            params![symbol, flag, now],
        )?,
    };
    Ok(())
}

/// The flags of those of `symbols` that have one, for a view of symbols that aren't a list (the
/// Screener's results). A symbol with no flag is left out.
pub fn flags_of(conn: &Connection, symbols: &[String]) -> rusqlite::Result<HashMap<String, String>> {
    let mut stmt = conn.prepare_cached("SELECT flag FROM symbol_flags WHERE symbol = ?1")?;
    let mut flags = HashMap::new();
    for symbol in symbols {
        if let Some(flag) = stmt.query_row(params![symbol], |r| r.get::<_, String>(0)).optional()? {
            flags.insert(symbol.clone(), flag);
        }
    }
    Ok(flags)
}

/// The six colour lists as a list selector shows them, with how many symbols each holds.
pub fn flag_lists(conn: &Connection) -> rusqlite::Result<Vec<WatchlistSummary>> {
    FLAGS
        .iter()
        .map(|flag| {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM symbol_flags WHERE flag = ?1",
                params![flag],
                |r| r.get(0),
            )?;
            Ok(WatchlistSummary {
                id: flag_list_id(flag).expect("a known flag"),
                name: flag_list_name(flag),
                created_at: String::new(),
                item_count: count,
            })
        })
        .collect()
}

/// A colour's list: every symbol flagged with it, most recently flagged first. It has no sections and
/// no order of its own; its rows' ids are only positions.
pub fn flag_list(conn: &Connection, flag: &str) -> rusqlite::Result<WatchlistDetail> {
    let mut stmt =
        conn.prepare("SELECT symbol FROM symbol_flags WHERE flag = ?1 ORDER BY flagged_at DESC, symbol ASC")?;
    let symbols = stmt
        .query_map(params![flag], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let names = crate::store::symbol_names::known(conn, &symbols)?;
    let items = symbols
        .into_iter()
        .enumerate()
        .map(|(i, symbol)| WatchlistItem {
            id: i as i64 + 1,
            position: i as i64 + 1,
            name: names.get(&symbol).cloned(),
            flag: Some(flag.to_string()),
            symbol,
        })
        .collect();
    Ok(WatchlistDetail {
        id: flag_list_id(flag).expect("a known flag"),
        name: flag_list_name(flag),
        created_at: String::new(),
        items,
        sections: Vec::new(),
        added: None,
    })
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
    // A symbol's flag is its own (`symbol_flags`), the same on every list.
    let mut stmt = conn.prepare(
        "SELECT i.id, i.symbol, i.name, i.position, f.flag FROM watchlist_items i
         LEFT JOIN symbol_flags f ON f.symbol = i.symbol
         WHERE i.watchlist_id = ?1 ORDER BY i.position ASC, i.id ASC",
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

/// What [`sync_named`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Synced {
    pub id: i64,
    pub created: bool,
    pub added: usize,
    pub removed: usize,
    pub total: usize,
}

/// Creates or refreshes the watchlist called `name` (matched ignoring case; the oldest if two share
/// it) from a script's list. `replace` makes it hold exactly `symbols`: symbols it no longer has are
/// removed, and those it keeps stay where they were, with their flags; new ones go at the end, in the
/// order given. Otherwise the new ones are only added. Section headings are left alone. One
/// transaction, so a list is never seen half-refreshed.
pub fn sync_named(conn: &mut Connection, name: &str, symbols: &[String], replace: bool) -> rusqlite::Result<Synced> {
    let names = crate::store::symbol_names::known(conn, symbols)?;
    let tx = conn.transaction()?;
    let existing: Option<i64> = tx
        .query_row(
            "SELECT id FROM watchlists WHERE name = ?1 COLLATE NOCASE ORDER BY id LIMIT 1",
            params![name],
            |r| r.get(0),
        )
        .optional()?;
    let id = match existing {
        Some(id) => id,
        None => {
            tx.execute("INSERT INTO watchlists (name) VALUES (?1)", params![name])?;
            tx.last_insert_rowid()
        }
    };
    let mut removed = 0;
    if replace {
        let wanted: HashSet<&str> = symbols.iter().map(String::as_str).collect();
        let mut stmt = tx.prepare("SELECT symbol FROM watchlist_items WHERE watchlist_id = ?1")?;
        let current = stmt
            .query_map(params![id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        for symbol in current.iter().filter(|s| !wanted.contains(s.as_str())) {
            removed += tx.execute(
                "DELETE FROM watchlist_items WHERE watchlist_id = ?1 AND symbol = ?2",
                params![id, symbol],
            )?;
        }
    }
    let mut added = 0;
    {
        let mut position = next_position(&tx, id)?;
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO watchlist_items (watchlist_id, symbol, name, position) VALUES (?1, ?2, ?3, ?4)",
        )?;
        for symbol in symbols {
            if stmt.execute(params![id, symbol, names.get(symbol), position])? == 1 {
                position += 1;
                added += 1;
            }
        }
    }
    let total: i64 = tx.query_row(
        "SELECT COUNT(*) FROM watchlist_items WHERE watchlist_id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    tx.commit()?;
    Ok(Synced {
        id,
        created: existing.is_none(),
        added,
        removed,
        total: total as usize,
    })
}

/// Every list's symbols as `(watchlist id, symbol)`, for showing which lists hold a symbol (the chart's
/// "Add to watchlist" check marks) without reading each list.
pub fn members(conn: &Connection) -> rusqlite::Result<Vec<(i64, String)>> {
    let mut stmt = conn.prepare("SELECT watchlist_id, symbol FROM watchlist_items ORDER BY watchlist_id, position")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
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

/// The starter list shown on a fresh install — well-known NSE names through Zerodha, so a
/// new user has something to click straight away once their account is connected. Runs once
/// per database: deleting the list later doesn't bring it back.
const STARTER_SYMBOLS: &[(&str, &str)] = &[
    ("zerodha:NSE:RELIANCE", "Reliance Industries"),
    ("zerodha:NSE:TCS", "Tata Consultancy Services"),
    ("zerodha:NSE:HDFCBANK", "HDFC Bank"),
    ("zerodha:NSE:INFY", "Infosys"),
    ("zerodha:NSE:NIFTY_50", "Nifty 50"),
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
    fn the_flags_of_symbols_on_no_list_are_read_by_symbol() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        set_symbol_flag(&conn, "zerodha:NSE:TCS", Some("green"), 1).unwrap();
        set_symbol_flag(&conn, "zerodha:NSE:INFY", Some("red"), 1).unwrap();
        set_symbol_flag(&conn, "zerodha:NSE:INFY", None, 2).unwrap();
        let asked = ["zerodha:NSE:TCS", "zerodha:NSE:INFY", "zerodha:NSE:SBIN"].map(String::from);
        let flags = flags_of(&conn, &asked).unwrap();
        assert_eq!(flags.len(), 1, "a cleared or never-set flag is absent");
        assert_eq!(flags["zerodha:NSE:TCS"], "green");
    }

    #[test]
    fn a_flag_belongs_to_the_symbol_on_every_list() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let a = create(&conn, "A").unwrap();
        let b = create(&conn, "B").unwrap();
        add_items(&mut conn, a, &[item("x"), item("y")]).unwrap();
        add_items(&mut conn, b, &[item("x")]).unwrap();

        set_symbol_flag(&conn, "x", Some("red"), 1).unwrap();
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
        assert_eq!(
            flags(b),
            [Some("red".to_string())],
            "the same symbol on another list shows the same flag"
        );

        set_symbol_flag(&conn, "x", None, 2).unwrap();
        assert_eq!(flags(a), [None, None]);
        assert_eq!(flags(b), [None]);
    }

    #[test]
    fn each_colour_has_a_list_of_its_symbols_newest_first() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        set_symbol_flag(&conn, "p:OLD", Some("red"), 1).unwrap();
        set_symbol_flag(&conn, "p:NEW", Some("red"), 3).unwrap();
        set_symbol_flag(&conn, "p:BLUE", Some("blue"), 2).unwrap();
        // Setting the colour it already has doesn't make it newer; a new colour does.
        set_symbol_flag(&conn, "p:OLD", Some("red"), 9).unwrap();

        let red = flag_list(&conn, "red").unwrap();
        assert_eq!((red.id, red.name.as_str()), (-1, "Red flag"));
        assert_eq!(
            red.items.iter().map(|i| i.symbol.as_str()).collect::<Vec<_>>(),
            ["p:NEW", "p:OLD"]
        );
        assert!(red.items.iter().all(|i| i.flag.as_deref() == Some("red")) && red.sections.is_empty());

        set_symbol_flag(&conn, "p:BLUE", Some("red"), 10).unwrap();
        assert_eq!(flag_list(&conn, "red").unwrap().items[0].symbol, "p:BLUE");
        let counts: Vec<(String, i64)> = flag_lists(&conn)
            .unwrap()
            .into_iter()
            .map(|s| (s.name, s.item_count))
            .collect();
        assert_eq!(counts[0], ("Red flag".to_string(), 3));
        assert_eq!(counts[4], ("Blue flag".to_string(), 0));
        assert_eq!(counts.len(), FLAGS.len());
    }

    #[test]
    fn colour_list_ids_are_negative_and_round_trip() {
        for (i, flag) in FLAGS.iter().enumerate() {
            let id = flag_list_id(flag).unwrap();
            assert_eq!(id, -(i as i64) - 1);
            assert_eq!(flag_of_list(id), Some(*flag));
        }
        assert_eq!(flag_of_list(0), None);
        assert_eq!(flag_of_list(5), None);
        assert_eq!(flag_of_list(-7), None);
        assert_eq!(flag_list_id("pink"), None);
    }

    #[test]
    fn flags_on_rows_are_carried_over_to_their_symbols_once() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let a = create(&conn, "A").unwrap();
        let b = create(&conn, "B").unwrap();
        add_items(&mut conn, a, &[item("x"), item("y")]).unwrap();
        add_items(&mut conn, b, &[item("x")]).unwrap();
        // As an older version left them: on the rows, the same symbol flagged differently on two lists.
        conn.execute_batch(&format!(
            "UPDATE watchlist_items SET flag = 'green' WHERE watchlist_id = {a} AND symbol = 'x';
                 UPDATE watchlist_items SET flag = 'red' WHERE watchlist_id = {b} AND symbol = 'x';"
        ))
        .unwrap();
        migrate(&conn).unwrap();
        assert_eq!(
            get(&conn, b).unwrap().unwrap().items[0].flag.as_deref(),
            Some("green"),
            "the first list's flag wins"
        );
        // Cleared afterwards and removed: a second run brings nothing back.
        set_symbol_flag(&conn, "x", None, 5).unwrap();
        migrate(&conn).unwrap();
        assert_eq!(get(&conn, a).unwrap().unwrap().items[0].flag, None);
    }

    #[test]
    fn only_the_known_colours_are_flags() {
        assert!(FLAGS.iter().all(|f| is_flag(f)));
        assert!(!is_flag("pink"));
        assert!(!is_flag(""));
        assert!(!is_flag("Red"));
    }

    #[test]
    fn members_lists_every_lists_symbols() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let a = create(&conn, "A").unwrap();
        let b = create(&conn, "B").unwrap();
        add_items(&mut conn, a, &[item("x:1"), item("x:2")]).unwrap();
        add_items(&mut conn, b, &[item("x:2")]).unwrap();
        assert_eq!(
            members(&conn).unwrap(),
            vec![(a, "x:1".to_string()), (a, "x:2".to_string()), (b, "x:2".to_string())]
        );
    }

    #[test]
    fn a_script_creates_a_list_by_name_and_refreshes_it_in_place() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let list = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let first = sync_named(&mut conn, "Momentum", &list(&["z:A", "z:B", "z:C"]), true).unwrap();
        assert_eq!(
            (first.created, first.added, first.removed, first.total),
            (true, 3, 0, 3)
        );
        set_symbol_flag(&conn, "z:B", Some("red"), 1).unwrap();
        add_section(&mut conn, first.id, "Keep me", None).unwrap();
        // Refreshed under another spelling of its name: B stays where it was with its flag, A and C
        // go, D and E are added at the end in the script's order, and the heading is untouched.
        let again = sync_named(&mut conn, "momentum", &list(&["z:E", "z:B", "z:D"]), true).unwrap();
        assert_eq!(
            (again.id, again.created, again.added, again.removed, again.total),
            (first.id, false, 2, 2, 3)
        );
        assert_eq!(symbols(&conn, first.id), ["z:B", "z:E", "z:D"]);
        let detail = get(&conn, first.id).unwrap().unwrap();
        assert_eq!(detail.items[0].flag.as_deref(), Some("red"));
        assert_eq!(detail.sections.len(), 1);
        // Appending adds only what is new; an empty replace empties it.
        let more = sync_named(&mut conn, "Momentum", &list(&["z:B", "z:F"]), false).unwrap();
        assert_eq!((more.added, more.removed, more.total), (1, 0, 4));
        let cleared = sync_named(&mut conn, "Momentum", &[], true).unwrap();
        assert_eq!((cleared.removed, cleared.total), (4, 0));
        assert_eq!(list_names(&conn), ["Momentum"]);
    }

    fn list_names(conn: &Connection) -> Vec<String> {
        list(conn).unwrap().into_iter().map(|w| w.name).collect()
    }
}
