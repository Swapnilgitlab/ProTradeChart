use rusqlite::{params, Connection};

use crate::models::ChartLayout;

const COLUMNS: &str = "id, name, state_json, is_default, created_at, updated_at";

fn from_row(row: &rusqlite::Row) -> rusqlite::Result<ChartLayout> {
    Ok(ChartLayout {
        id: row.get(0)?,
        name: row.get(1)?,
        state_json: row.get(2)?,
        is_default: row.get::<_, i64>(3)? != 0,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<ChartLayout>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM chart_layouts ORDER BY name COLLATE NOCASE ASC"
    ))?;
    let rows = stmt.query_map([], from_row)?;
    rows.collect()
}

/// Upserts a layout. Marking one as default clears the flag on every other
/// layout, so there is never more than one default.
pub fn save(conn: &mut Connection, layout: &ChartLayout) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    if layout.is_default {
        tx.execute(
            "UPDATE chart_layouts SET is_default = 0 WHERE id != ?1",
            params![layout.id],
        )?;
    }
    tx.execute(
        "INSERT INTO chart_layouts (id, name, state_json, is_default, updated_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, state_json = excluded.state_json,
           is_default = excluded.is_default, updated_at = datetime('now')",
        params![layout.id, layout.name, layout.state_json, layout.is_default as i64],
    )?;
    tx.commit()
}

pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM chart_layouts WHERE id = ?1", params![id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn layout(id: &str, name: &str, is_default: bool) -> ChartLayout {
        ChartLayout {
            id: id.into(),
            name: name.into(),
            state_json: "{}".into(),
            is_default,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn save_upserts_and_lists_sorted_by_name() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        save(&mut conn, &layout("b", "beta", false)).unwrap();
        save(&mut conn, &layout("a", "Alpha", false)).unwrap();
        save(&mut conn, &layout("b", "beta v2", false)).unwrap();

        let all = list(&conn).unwrap();
        assert_eq!(
            all.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(),
            ["Alpha", "beta v2"]
        );
    }

    #[test]
    fn only_one_layout_can_be_default() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        save(&mut conn, &layout("a", "A", true)).unwrap();
        save(&mut conn, &layout("b", "B", true)).unwrap();

        let defaults: Vec<_> = list(&conn).unwrap().into_iter().filter(|l| l.is_default).collect();
        assert_eq!(defaults.len(), 1);
        assert_eq!(defaults[0].id, "b");
    }

    #[test]
    fn delete_removes_the_row() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        save(&mut conn, &layout("a", "A", false)).unwrap();
        delete(&conn, "a").unwrap();
        assert!(list(&conn).unwrap().is_empty());
    }
}
