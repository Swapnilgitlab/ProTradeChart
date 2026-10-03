//! Key/value settings per data provider, plus the unencrypted fallback table
//! for credentials when no OS credential store is available.

use rusqlite::{params, Connection, OptionalExtension};

/// Both tables share one shape. Naming them through an enum keeps the table
/// name out of any caller-supplied string, so SQL is never built from input.
#[derive(Clone, Copy)]
pub enum Table {
    Settings,
    FallbackSecrets,
}

impl Table {
    fn name(self) -> &'static str {
        match self {
            Table::Settings => "provider_settings",
            Table::FallbackSecrets => "provider_secrets_fallback",
        }
    }
}

pub fn get(conn: &Connection, table: Table, provider: &str, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        &format!("SELECT value FROM {} WHERE provider = ?1 AND key = ?2", table.name()),
        params![provider, key],
        |r| r.get(0),
    )
    .optional()
}

pub fn set(conn: &Connection, table: Table, provider: &str, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        &format!(
            "INSERT INTO {} (provider, key, value) VALUES (?1, ?2, ?3)
             ON CONFLICT(provider, key) DO UPDATE SET value = excluded.value",
            table.name()
        ),
        params![provider, key, value],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, table: Table, provider: &str, key: &str) -> rusqlite::Result<()> {
    conn.execute(
        &format!("DELETE FROM {} WHERE provider = ?1 AND key = ?2", table.name()),
        params![provider, key],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    #[test]
    fn set_get_overwrite_and_delete() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        assert_eq!(get(&conn, Table::Settings, "zerodha", "apiKey").unwrap(), None);
        set(&conn, Table::Settings, "zerodha", "apiKey", "100").unwrap();
        set(&conn, Table::Settings, "zerodha", "apiKey", "200").unwrap();
        assert_eq!(
            get(&conn, Table::Settings, "zerodha", "apiKey").unwrap().as_deref(),
            Some("200")
        );
        delete(&conn, Table::Settings, "zerodha", "apiKey").unwrap();
        assert_eq!(get(&conn, Table::Settings, "zerodha", "apiKey").unwrap(), None);
    }

    #[test]
    fn tables_and_providers_are_independent() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        set(&conn, Table::Settings, "zerodha", "k", "settings").unwrap();
        set(&conn, Table::FallbackSecrets, "zerodha", "k", "secret").unwrap();
        set(&conn, Table::Settings, "kite", "k", "other").unwrap();

        assert_eq!(
            get(&conn, Table::Settings, "zerodha", "k").unwrap().as_deref(),
            Some("settings")
        );
        assert_eq!(
            get(&conn, Table::FallbackSecrets, "zerodha", "k").unwrap().as_deref(),
            Some("secret")
        );
        assert_eq!(
            get(&conn, Table::Settings, "kite", "k").unwrap().as_deref(),
            Some("other")
        );
    }
}
