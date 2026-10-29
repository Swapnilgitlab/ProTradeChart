//! Drawings belong to a symbol: a trend line on RELIANCE shows on every chart of RELIANCE, in any
//! tab, window or layout, at any timeframe. The document is Vela's own (`chart.drawings.toJSON()`),
//! opaque here. A symbol whose drawings were all removed keeps an empty document rather than no
//! row: "no row" means the app has never managed that symbol's drawings, which is when a chart may
//! adopt the drawings an older layout carried for it (`chart/symbolDrawings.ts`).

use rusqlite::{params, Connection, OptionalExtension};

/// A symbol's drawings are a few kilobytes; far more than this is not a drawings document.
const MAX_DOC_BYTES: usize = 4 * 1024 * 1024;
const MAX_SYMBOL_CHARS: usize = 100;

fn check_symbol(symbol: &str) -> Result<(), String> {
    if symbol.is_empty() || symbol.chars().count() > MAX_SYMBOL_CHARS || !symbol.contains(':') {
        return Err("That isn't a symbol.".into());
    }
    Ok(())
}

/// The symbol's drawings document, or `None` if the app has never stored one.
pub fn get(conn: &Connection, symbol: &str) -> Result<Option<String>, String> {
    check_symbol(symbol)?;
    conn.query_row(
        "SELECT doc_json FROM symbol_drawings WHERE symbol = ?1",
        params![symbol],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Stores the symbol's drawings document (an empty one included).
pub fn save(conn: &Connection, symbol: &str, doc_json: &str) -> Result<(), String> {
    check_symbol(symbol)?;
    if doc_json.len() > MAX_DOC_BYTES {
        return Err("Those drawings are too large to keep.".into());
    }
    if !serde_json::from_str::<serde_json::Value>(doc_json).is_ok_and(|v| v.is_object()) {
        return Err("That isn't a drawings document.".into());
    }
    conn.execute(
        "INSERT INTO symbol_drawings (symbol, doc_json, updated_at) VALUES (?1, ?2, datetime('now'))
         ON CONFLICT(symbol) DO UPDATE SET doc_json = excluded.doc_json, updated_at = excluded.updated_at",
        params![symbol, doc_json],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    #[test]
    fn a_symbols_drawings_are_kept_replaced_and_read_back() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        assert_eq!(get(&conn, "india:NSE:TCS").unwrap(), None);
        save(&conn, "india:NSE:TCS", r#"{"version":1,"drawings":[{"id":"a"}]}"#).unwrap();
        save(&conn, "india:NSE:TCS", r#"{"version":1,"drawings":[]}"#).unwrap();
        // Cleared is not the same as never stored.
        assert_eq!(
            get(&conn, "india:NSE:TCS").unwrap().as_deref(),
            Some(r#"{"version":1,"drawings":[]}"#)
        );
        assert_eq!(get(&conn, "india:NSE:INFY").unwrap(), None);
    }

    #[test]
    fn only_a_symbol_and_a_json_object_are_accepted() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        assert!(save(&conn, "TCS", "{}").is_err());
        assert!(save(&conn, "", "{}").is_err());
        assert!(save(&conn, "india:NSE:TCS", "[1]").is_err());
        assert!(save(&conn, "india:NSE:TCS", "nope").is_err());
        assert!(get(&conn, "no colon").is_err());
    }
}
