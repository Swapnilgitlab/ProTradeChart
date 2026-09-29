//! Saved screens and the last run of each. The spec and the result are JSON documents the frontend
//! and the Python engine own; this only keeps them. One result per screen: a screen answers "what
//! qualifies now", so an older run is only ever replaced, never compared.

use rusqlite::{params, Connection, OptionalExtension};

use crate::models::Screener;

/// A result's JSON is capped at what the Python API accepts in one post.
pub const MAX_RESULT_BYTES: usize = 20 * 1024 * 1024;
const MAX_SPEC_BYTES: usize = 1024 * 1024;
const MAX_NAME_CHARS: usize = 200;
const MAX_RAN_AT_CHARS: usize = 40;

fn check_json(text: &str, what: &str, max: usize) -> Result<(), String> {
    if text.len() > max {
        return Err(format!("The {what} is over {} MB.", max / (1024 * 1024)));
    }
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .filter(|v| v.is_object())
        .map(|_| ())
        .ok_or_else(|| format!("The {what} isn't a JSON object."))
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Screener>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, spec_json, ran_at, created_at, updated_at FROM screeners ORDER BY name COLLATE NOCASE ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Screener {
            id: r.get(0)?,
            name: r.get(1)?,
            spec_json: r.get(2)?,
            ran_at: r.get(3)?,
            created_at: r.get(4)?,
            updated_at: r.get(5)?,
        })
    })?;
    rows.collect()
}

/// Inserts or updates a screen's name and spec, keeping its last result. The spec must be a JSON
/// object; its contents are not judged here.
pub fn save(conn: &Connection, id: &str, name: &str, spec_json: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("A screen needs a name.".into());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("A screen's name can be at most {MAX_NAME_CHARS} characters."));
    }
    check_json(spec_json, "screen", MAX_SPEC_BYTES)?;
    conn.execute(
        "INSERT INTO screeners (id, name, spec_json, updated_at) VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, spec_json = excluded.spec_json,
           updated_at = datetime('now')",
        params![id, name.trim(), spec_json],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM screeners WHERE id = ?1", params![id])?;
    Ok(())
}

/// Keeps a run as the screen's last one. `false` when there is no saved screen of that id: a run of
/// a screen that was never saved is shown, not kept.
pub fn save_result(conn: &Connection, id: &str, result_json: &str, ran_at: &str) -> Result<bool, String> {
    check_json(result_json, "screen result", MAX_RESULT_BYTES)?;
    if ran_at.is_empty() || ran_at.chars().count() > MAX_RAN_AT_CHARS {
        return Err("That isn't a time a screen ran.".into());
    }
    let changed = conn
        .execute(
            "UPDATE screeners SET result_json = ?2, ran_at = ?3 WHERE id = ?1",
            params![id, result_json, ran_at],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed > 0)
}

pub fn get_result(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT result_json FROM screeners WHERE id = ?1", params![id], |r| {
        r.get::<_, Option<String>>(0)
    })
    .optional()
    .map(Option::flatten)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    #[test]
    fn screens_are_saved_renamed_listed_by_name_and_deleted() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        save(&conn, "b", "Breakouts", r#"{"version":1}"#).unwrap();
        save(&conn, "a", "near highs", r#"{"version":1}"#).unwrap();
        save(&conn, "b", "  Zeta  ", r#"{"version":1,"name":"Zeta"}"#).unwrap();
        let all = list(&conn).unwrap();
        assert_eq!(
            all.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["near highs", "Zeta"]
        );
        assert!(all[1].spec_json.contains("Zeta"));
        assert_eq!(all[1].ran_at, None);
        delete(&conn, "a").unwrap();
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn a_screen_needs_a_name_and_a_json_object() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        assert!(save(&conn, "a", "  ", "{}").is_err());
        assert!(save(&conn, "a", "X", "[1,2]").is_err());
        assert!(save(&conn, "a", "X", "not json").is_err());
        assert!(save(&conn, "a", &"x".repeat(201), "{}").is_err());
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn the_last_run_is_kept_replaced_and_survives_an_edit() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        save(&conn, "s", "Screen", "{}").unwrap();
        assert_eq!(get_result(&conn, "s").unwrap(), None);
        assert!(save_result(&conn, "s", r#"{"rows":[1]}"#, "2026-09-28T10:00:00Z").unwrap());
        assert!(save_result(&conn, "s", r#"{"rows":[2]}"#, "2026-09-28T11:00:00Z").unwrap());
        save(&conn, "s", "Renamed", r#"{"version":1}"#).unwrap();
        assert_eq!(get_result(&conn, "s").unwrap().as_deref(), Some(r#"{"rows":[2]}"#));
        assert_eq!(list(&conn).unwrap()[0].ran_at.as_deref(), Some("2026-09-28T11:00:00Z"));
        // Deleting the screen takes its result with it.
        delete(&conn, "s").unwrap();
        assert_eq!(get_result(&conn, "s").unwrap(), None);
    }

    #[test]
    fn a_run_of_an_unsaved_screen_is_not_kept() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        assert!(!save_result(&conn, "never-saved", "{}", "2026-09-28T10:00:00Z").unwrap());
        assert!(list(&conn).unwrap().is_empty());
        save(&conn, "s", "Screen", "{}").unwrap();
        assert!(save_result(&conn, "s", "[]", "2026-09-28T10:00:00Z").is_err());
        assert!(save_result(&conn, "s", "{}", "").is_err());
    }
}
