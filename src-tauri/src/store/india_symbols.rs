//! Moves stored symbols from `zerodha:` to `india:`, the Indian market's namespace since a second
//! broker could serve it (`crate::symbols`).
//!
//! The first launch after the change rewrites every place a symbol is kept, after copying the
//! database aside (`charting.before-india.db`): an older version would read `india:` as a data
//! source it doesn't have and drop those symbols the next time a layout is saved, so the copy is the
//! way back. Each later launch repeats only the cheap part of the pass, which tidies up anything an
//! older version wrote in the meantime. Nothing else reads `zerodha:` from the database afterwards,
//! though every input still accepts it (`symbols::canonical_provider`).
//!
//! Left alone: what `zerodha` means as a *broker* (`provider_settings`, its credentials, its
//! instrument table), a run's `data_source` (which broker served it), Pine sources, notes and
//! script output.

use std::path::Path;

use rusqlite::{params, Connection};

use crate::store::preferences;
use crate::symbols::INDIA;

const OLD: &str = "zerodha";
/// Set once the first, full pass has run.
const MARKER: &str = "symbols.namespace";
/// The preference holding the namespace a bare ticker goes to.
const DEFAULT_PROVIDER: &str = "default_provider";

/// Tables keyed by a symbol column. Where the column is unique, a row already spelled `india:` wins
/// over its old twin.
const SYMBOL_COLUMNS: [(&str, bool); 5] = [
    ("watchlist_items", true),
    ("symbol_flags", true),
    ("symbol_drawings", true),
    ("market_symbols", true),
    ("price_alerts", false),
];

/// JSON documents that name symbols: `(table, key column, document column, every launch)`. A layout
/// or spec is small; a run's result can be megabytes, so it is only read on the first pass.
const DOCUMENTS: [(&str, &str, &str, bool); 6] = [
    ("chart_layouts", "id", "state_json", true),
    ("studies", "id", "spec_json", true),
    ("screeners", "id", "spec_json", true),
    ("study_results", "id", "result_json", false),
    ("study_results", "id", "summary_json", false),
    ("screeners", "id", "result_json", false),
];

/// Runs the pass. `backup` is where to copy the database first (`None` for one in memory). Returns
/// whether anything was rewritten.
pub fn migrate(conn: &Connection, backup: Option<&Path>) -> rusqlite::Result<bool> {
    let first = preferences::get(conn, MARKER)?.is_none();
    if first && needs_rewrite(conn)? {
        if let Some(path) = backup.filter(|p| !p.exists()) {
            // Outside any transaction, as VACUUM requires. A failed copy is no reason to keep the old
            // names: the rest of the app no longer reads them.
            if let Err(e) = conn.execute("VACUUM INTO ?1", params![path.to_string_lossy()]) {
                log::warn!("couldn't copy the database aside before renaming its symbols: {e}");
            }
        }
    }

    let tx = conn.unchecked_transaction()?;
    let mut changed = 0usize;
    let like = format!("{OLD}:%");
    for (table, unique) in SYMBOL_COLUMNS {
        // `substr(symbol, 9)` is everything after `zerodha:`.
        let update = if unique { "UPDATE OR IGNORE" } else { "UPDATE" };
        changed += tx.execute(
            &format!(
                "{update} {table} SET symbol = '{INDIA}:' || substr(symbol, {}) WHERE symbol LIKE ?1",
                OLD.len() + 2
            ),
            params![like],
        )?;
        if unique {
            // What's left had an `india:` twin already.
            changed += tx.execute(&format!("DELETE FROM {table} WHERE symbol LIKE ?1"), params![like])?;
        }
    }
    for (table, key, column, every_launch) in DOCUMENTS {
        if !first && !every_launch {
            continue;
        }
        let rows: Vec<(String, String)> = {
            let mut stmt = tx.prepare(&format!(
                "SELECT {key}, {column} FROM {table} WHERE {column} IS NOT NULL AND instr(lower({column}), ?1) > 0"
            ))?;
            let found = stmt
                .query_map(params![OLD], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            found
        };
        for (id, text) in rows {
            if let Some(rewritten) = rewrite_document(&text) {
                tx.execute(
                    &format!("UPDATE {table} SET {column} = ?1 WHERE {key} = ?2"),
                    params![rewritten, id],
                )?;
                changed += 1;
            }
        }
    }
    if preferences::get(&tx, DEFAULT_PROVIDER)?.as_deref() == Some(OLD) {
        preferences::set(&tx, DEFAULT_PROVIDER, INDIA)?;
        changed += 1;
    }
    if first {
        preferences::set(&tx, MARKER, INDIA)?;
    }
    tx.commit()?;
    if changed > 0 {
        log::info!("moved {changed} stored symbols and documents from {OLD}: to {INDIA}:");
    }
    Ok(changed > 0)
}

/// Whether anything still says `zerodha:`, so a database that never held one isn't copied for nothing.
fn needs_rewrite(conn: &Connection) -> rusqlite::Result<bool> {
    let like = format!("{OLD}:%");
    for (table, _) in SYMBOL_COLUMNS {
        let found: bool = conn.query_row(
            &format!("SELECT EXISTS (SELECT 1 FROM {table} WHERE symbol LIKE ?1)"),
            params![like],
            |r| r.get(0),
        )?;
        if found {
            return Ok(true);
        }
    }
    for (table, _, column, _) in DOCUMENTS {
        let found: bool = conn.query_row(
            &format!("SELECT EXISTS (SELECT 1 FROM {table} WHERE instr(lower({column}), ?1) > 0)"),
            params![OLD],
            |r| r.get(0),
        )?;
        if found {
            return Ok(true);
        }
    }
    Ok(preferences::get(conn, DEFAULT_PROVIDER)?.as_deref() == Some(OLD))
}

/// A JSON document with its symbols moved to the new namespace, or `None` if it names none.
///
/// It works on the text, string by string, rather than parsing and writing the document again,
/// which would reorder keys and could respell numbers: every byte outside a changed string is kept.
/// A string token (key or value) that starts with `zerodha:` gets the prefix `india:`, and the value
/// `"zerodha"` of a `"provider"` key (a Study's, a screen's, or a chart's own provider field) becomes
/// `"india"`. Text that merely contains `zerodha:` — embedded Pine source, a note — stays as it was.
pub fn rewrite_document(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len() + 64);
    let mut changed = false;
    let mut copied = 0; // `text[copied..i]` is still to be copied out
    let mut provider_value_next = false;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                // A string that never closes: the document is corrupt, and left as it is from here.
                let Some(end) = string_end(bytes, i) else { break };
                let raw = &text[i + 1..end]; // without the quotes, escapes as written
                let is_key = bytes[skip_space(bytes, end + 1)..].first() == Some(&b':');
                let replacement = if !is_key && provider_value_next && raw == OLD {
                    Some(INDIA.to_string())
                } else if raw.len() > OLD.len() + 1
                    && raw.as_bytes()[OLD.len()] == b':'
                    && raw[..OLD.len()].eq_ignore_ascii_case(OLD)
                {
                    Some(format!("{INDIA}{}", &raw[OLD.len()..]))
                } else {
                    None
                };
                if let Some(new) = replacement {
                    out.push_str(&text[copied..i + 1]);
                    out.push_str(&new);
                    copied = end;
                    changed = true;
                }
                provider_value_next = is_key && raw == "provider";
                i = end + 1;
            }
            b':' | b' ' | b'\t' | b'\n' | b'\r' => i += 1,
            _ => {
                // Anything else after a key (a number, an object, null) means its value wasn't a string.
                provider_value_next = false;
                i += 1;
            }
        }
    }
    if !changed {
        return None;
    }
    out.push_str(&text[copied..]);
    Some(out)
}

/// The index of the quote closing the string that opens at `start`, if it closes.
fn string_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut i = start + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'"' => return Some(i),
            _ => i += 1,
        }
    }
    None
}

fn skip_space(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() && matches!(bytes[i], b' ' | b'\t' | b'\n' | b'\r') {
        i += 1;
    }
    i.min(bytes.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    #[test]
    fn a_document_has_its_symbols_and_provider_moved_and_nothing_else() {
        let layout = r#"{"version":1,"tabs":[{"symbol":"zerodha:NSE:HFCL","state":{"charts":[{"symbol":"zerodha:HFCL","provider":"zerodha","price":101.50000000000001,"ext":{"pine":"x = request.security(\"zerodha:NSE:X\", \"D\", close)"}}]}}],"activeTabIndex":0}"#;
        let got = rewrite_document(layout).unwrap();
        assert_eq!(
            got,
            r#"{"version":1,"tabs":[{"symbol":"india:NSE:HFCL","state":{"charts":[{"symbol":"india:HFCL","provider":"india","price":101.50000000000001,"ext":{"pine":"x = request.security(\"zerodha:NSE:X\", \"D\", close)"}}]}}],"activeTabIndex":0}"#
        );
    }

    #[test]
    fn python_spacing_and_other_keys_are_handled() {
        let spec = r#"{"universe": {"provider": "zerodha", "symbols": ["zerodha:NSE:A", "csv:ZERODHA"]}, "meta": {"data_source": "zerodha"}, "benchmark" : "ZERODHA:NSE:NIFTY_500"}"#;
        assert_eq!(
            rewrite_document(spec).unwrap(),
            r#"{"universe": {"provider": "india", "symbols": ["india:NSE:A", "csv:ZERODHA"]}, "meta": {"data_source": "zerodha"}, "benchmark" : "india:NSE:NIFTY_500"}"#,
            "a run's data_source names the broker that served it, and stays"
        );
    }

    #[test]
    fn a_document_with_nothing_to_move_is_left_alone() {
        for text in [
            r#"{"a":1}"#,
            r#"{"note":"see zerodha: notes"}"#,
            r#"{"provider":1,"x":"zerodha"}"#,
            r#"{"zerodha":"provider"}"#,
            "",
            r#"{"broken":"zerodha:NSE"#,
        ] {
            assert_eq!(rewrite_document(text), None, "{text}");
        }
        assert_eq!(
            rewrite_document(r#"["zerodha:"]"#),
            None,
            "a bare prefix isn't a symbol"
        );
        // An escaped quote inside a string doesn't end it.
        assert_eq!(
            rewrite_document(r#"["say \"hi\"", "zerodha:NSE:B"]"#).unwrap(),
            r#"["say \"hi\"", "india:NSE:B"]"#
        );
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn text(conn: &Connection, sql: &str) -> String {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn old_database() -> Database {
        let db = Database::open_in_memory().unwrap();
        {
            let conn = db.conn.lock().unwrap();
            // A fresh in-memory database has already been through `init`; make it look like an old one.
            conn.execute_batch(
                r#"
                DELETE FROM ui_preferences WHERE key = 'symbols.namespace';
                DELETE FROM watchlist_items;
                INSERT INTO watchlists (id, name) VALUES (90, 'Old');
                INSERT INTO watchlist_items (watchlist_id, symbol, position) VALUES
                  (90, 'zerodha:NSE:A', 1), (90, 'india:NSE:A', 2), (90, 'zerodha:BSE:B', 3), (90, 'csv:ZERODHA', 4);
                INSERT INTO symbol_flags (symbol, flag, flagged_at) VALUES ('zerodha:NSE:A', 'red', 1);
                INSERT INTO symbol_drawings (symbol, doc_json) VALUES ('zerodha:NSE:A', '{"drawings":[]}');
                INSERT INTO market_symbols (symbol, kind, first_seen, last_seen) VALUES ('zerodha:NSE:A', 'EQ', 1, 2);
                INSERT INTO price_alerts (id, symbol, condition, price, mode, status, created_at)
                  VALUES ('a1', 'zerodha:NSE:A', 'crossing', 10, 'once', 'active', 1);
                INSERT INTO chart_layouts (id, name, state_json) VALUES
                  ('l1', 'Main', '{"tabs":[{"symbol":"zerodha:NSE:A","state":{"charts":[{"symbol":"zerodha:A","provider":"zerodha"}]}}]}');
                INSERT INTO studies (id, name, spec_json) VALUES ('s1', 'S', '{"universe":{"provider":"zerodha"}}');
                INSERT INTO study_results (id, study_id, name, summary_json, result_json, executed_at) VALUES
                  ('r1', 's1', 'S', '{}', '{"events":[["zerodha:NSE:WIN",1]],"meta":{"data_source":"zerodha"}}', 'now');
                INSERT INTO screeners (id, name, spec_json, result_json) VALUES
                  ('x1', 'X', '{"universe":{"provider":"zerodha"}}', '{"rows":[{"symbol":"zerodha:NSE:A"}]}');
                INSERT INTO provider_settings (provider, key, value) VALUES ('zerodha', 'apiKey', 'k');
                INSERT INTO notebooks (id, name, notes) VALUES ('n1', 'N', 'zerodha:NSE:A did well');
                INSERT OR REPLACE INTO ui_preferences (key, value) VALUES ('default_provider', 'zerodha');
                "#,
            )
            .unwrap();
        }
        db
    }

    #[test]
    fn the_first_launch_moves_every_stored_symbol_and_leaves_the_broker_alone() {
        let db = old_database();
        let conn = db.conn.lock().unwrap();
        assert!(migrate(&conn, None).unwrap());

        let items: Vec<String> = conn
            .prepare("SELECT symbol FROM watchlist_items WHERE watchlist_id = 90 ORDER BY position")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            items,
            ["india:NSE:A", "india:BSE:B", "csv:ZERODHA"],
            "the india: twin wins"
        );
        for table in ["symbol_flags", "symbol_drawings", "market_symbols", "price_alerts"] {
            assert_eq!(
                text(&conn, &format!("SELECT symbol FROM {table}")),
                "india:NSE:A",
                "{table}"
            );
        }
        assert_eq!(
            text(&conn, "SELECT state_json FROM chart_layouts"),
            r#"{"tabs":[{"symbol":"india:NSE:A","state":{"charts":[{"symbol":"india:A","provider":"india"}]}}]}"#
        );
        assert_eq!(
            text(&conn, "SELECT spec_json FROM studies"),
            r#"{"universe":{"provider":"india"}}"#
        );
        assert_eq!(
            text(&conn, "SELECT result_json FROM study_results"),
            r#"{"events":[["india:NSE:WIN",1]],"meta":{"data_source":"zerodha"}}"#
        );
        assert_eq!(
            text(&conn, "SELECT result_json FROM screeners"),
            r#"{"rows":[{"symbol":"india:NSE:A"}]}"#
        );
        assert_eq!(
            text(&conn, "SELECT value FROM ui_preferences WHERE key = 'default_provider'"),
            "india"
        );
        // What `zerodha` means as a broker, and the user's own words, are untouched.
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM provider_settings WHERE provider = 'zerodha'"
            ),
            1
        );
        assert_eq!(text(&conn, "SELECT notes FROM notebooks"), "zerodha:NSE:A did well");
    }

    #[test]
    fn a_second_launch_changes_nothing_and_a_later_stray_is_tidied() {
        let db = old_database();
        let conn = db.conn.lock().unwrap();
        assert!(migrate(&conn, None).unwrap());
        assert!(!migrate(&conn, None).unwrap(), "nothing left to do");

        // An older version, run again, saved a symbol the old way.
        conn.execute(
            "INSERT INTO watchlist_items (watchlist_id, symbol, position) VALUES (90, 'zerodha:NSE:NEW', 9)",
            [],
        )
        .unwrap();
        assert!(migrate(&conn, None).unwrap());
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM watchlist_items WHERE symbol = 'india:NSE:NEW'"
            ),
            1
        );
    }

    #[test]
    fn a_new_database_has_nothing_to_move() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        conn.execute("DELETE FROM ui_preferences WHERE key = ?1", params![MARKER])
            .unwrap();
        assert!(!needs_rewrite(&conn).unwrap());
    }
}
