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
    fn only_indicators_and_strategies_are_accepted() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        assert!(save(&conn, &script("a", "A", "library")).is_err());
        assert!(list(&conn).unwrap().is_empty());
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
