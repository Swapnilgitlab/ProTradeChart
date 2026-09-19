use rusqlite::{params, Connection, OptionalExtension};

pub fn get(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM ui_preferences WHERE key = ?1", params![key], |r| {
        r.get(0)
    })
    .optional()
}

pub fn set(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO ui_preferences (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    #[test]
    fn missing_key_is_none_and_set_overwrites() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        assert_eq!(get(&conn, "theme").unwrap(), None);
        set(&conn, "theme", "midnight").unwrap();
        set(&conn, "theme", "daylight").unwrap();
        assert_eq!(get(&conn, "theme").unwrap().as_deref(), Some("daylight"));
    }
}
