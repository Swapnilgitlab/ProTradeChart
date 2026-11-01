use rusqlite::{params, Connection};

use crate::models::PineScript;

const COLUMNS: &str = "id, name, kind, source, created_at, updated_at";

fn from_row(row: &rusqlite::Row) -> rusqlite::Result<PineScript> {
    Ok(PineScript {
        id: row.get(0)?,
        name: row.get(1)?,
        kind: row.get(2)?,
        source: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<PineScript>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM pine_scripts ORDER BY name COLLATE NOCASE ASC"
    ))?;
    let rows = stmt.query_map([], from_row)?;
    rows.collect()
}

/// Upserts a script by id. `created_at` is set once, on insert; the timestamps
/// on the incoming value are ignored.
pub fn save(conn: &Connection, script: &PineScript) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO pine_scripts (id, name, kind, source, updated_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, kind = excluded.kind,
           source = excluded.source, updated_at = datetime('now')",
        params![script.id, script.name, script.kind, script.source],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM pine_scripts WHERE id = ?1", params![id])?;
    Ok(())
}

/// Lets a database made before Pine libraries could be saved hold one. Its table refuses any
/// `kind` but indicator and strategy, and SQLite can't change a CHECK in place, so the table is
/// rebuilt with every row kept — once: a table that already allows libraries is left alone.
pub fn migrate(conn: &Connection) -> rusqlite::Result<bool> {
    let sql: String = conn.query_row(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pine_scripts'",
        [],
        |r| r.get(0),
    )?;
    if sql.contains("'library'") {
        return Ok(false);
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(
        "CREATE TABLE pine_scripts_new (
           id          TEXT PRIMARY KEY,
           name        TEXT NOT NULL,
           kind        TEXT NOT NULL CHECK (kind IN ('indicator', 'strategy', 'library')),
           source      TEXT NOT NULL,
           created_at  TEXT NOT NULL DEFAULT (datetime('now')),
           updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
         );
         INSERT INTO pine_scripts_new (id, name, kind, source, created_at, updated_at)
           SELECT id, name, kind, source, created_at, updated_at FROM pine_scripts;
         DROP TABLE pine_scripts;
         ALTER TABLE pine_scripts_new RENAME TO pine_scripts;",
    )?;
    tx.commit()?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn script(id: &str, name: &str, kind: &str) -> PineScript {
        PineScript {
            id: id.into(),
            name: name.into(),
            kind: kind.into(),
            source: format!("//@version=6\n{kind}(\"{name}\")"),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn save_upserts_and_lists_sorted_by_name() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        save(&conn, &script("b", "beta", "indicator")).unwrap();
        save(&conn, &script("a", "Alpha", "strategy")).unwrap();
        save(&conn, &script("b", "beta v2", "strategy")).unwrap();

        let all = list(&conn).unwrap();
        assert_eq!(
            all.iter()
                .map(|s| (s.name.as_str(), s.kind.as_str()))
                .collect::<Vec<_>>(),
            [("Alpha", "strategy"), ("beta v2", "strategy")]
        );
    }

    #[test]
    fn resaving_replaces_the_source_and_keeps_the_creation_time() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        save(&conn, &script("a", "A", "indicator")).unwrap();
        conn.execute("UPDATE pine_scripts SET created_at = '2020-01-01 00:00:00'", [])
            .unwrap();

        let mut edited = script("a", "A", "indicator");
        edited.source = "//@version=6\nindicator(\"A\")\nplot(close)".into();
        save(&conn, &edited).unwrap();

        let all = list(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].source, edited.source);
        assert_eq!(all[0].created_at, "2020-01-01 00:00:00");
    }

    #[test]
    fn indicators_strategies_and_libraries_are_accepted_and_nothing_else() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        save(&conn, &script("a", "A", "library")).unwrap();
        assert!(save(&conn, &script("b", "B", "screener")).is_err());
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn a_table_from_before_libraries_is_rebuilt_once_with_its_scripts() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE pine_scripts (
               id TEXT PRIMARY KEY, name TEXT NOT NULL,
               kind TEXT NOT NULL CHECK (kind IN ('indicator', 'strategy')),
               source TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT (datetime('now')),
               updated_at TEXT NOT NULL DEFAULT (datetime('now'))
             );
             INSERT INTO pine_scripts (id, name, kind, source, created_at, updated_at)
               VALUES ('a', 'Mine', 'strategy', 'strategy(\"Mine\")', '2020-01-01 00:00:00', '2021-01-01 00:00:00');",
        )
        .unwrap();
        assert!(save(&conn, &script("lib", "Lib", "library")).is_err());

        assert!(migrate(&conn).unwrap());
        let all = list(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(
            (
                all[0].name.as_str(),
                all[0].kind.as_str(),
                all[0].created_at.as_str(),
                all[0].updated_at.as_str()
            ),
            ("Mine", "strategy", "2020-01-01 00:00:00", "2021-01-01 00:00:00")
        );
        save(&conn, &script("lib", "Lib", "library")).unwrap();
        assert!(!migrate(&conn).unwrap(), "and only once");
        assert_eq!(list(&conn).unwrap().len(), 2);
    }

    #[test]
    fn delete_removes_the_row() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        save(&conn, &script("a", "A", "indicator")).unwrap();
        delete(&conn, "a").unwrap();
        assert!(list(&conn).unwrap().is_empty());
        // Deleting something that isn't there is not an error.
        delete(&conn, "a").unwrap();
    }
}
