//! Research Notebooks: named collections of Studies and stored runs, with the user's notes. An entry
//! refers to its target by id and outlives it — a deleted Study shows as no longer available rather
//! than vanishing from the notebook it was written about.

use rusqlite::{params, Connection, OptionalExtension};

use crate::models::{NotebookDetail, NotebookItem, NotebookSummary};

const MAX_NAME_CHARS: usize = 200;
const MAX_NOTES_CHARS: usize = 100_000;
const MAX_NOTE_CHARS: usize = 10_000;
const KINDS: [&str; 2] = ["study", "result"];

fn too_long(text: &str, max: usize, what: &str) -> Result<(), String> {
    if text.chars().count() > max {
        return Err(format!("The {what} can be at most {max} characters."));
    }
    Ok(())
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<NotebookSummary>> {
    let mut stmt = conn.prepare(
        "SELECT n.id, n.name, n.updated_at, (SELECT COUNT(*) FROM notebook_items i WHERE i.notebook_id = n.id)
         FROM notebooks n ORDER BY n.name COLLATE NOCASE ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(NotebookSummary {
            id: r.get(0)?,
            name: r.get(1)?,
            updated_at: r.get(2)?,
            item_count: r.get(3)?,
        })
    })?;
    rows.collect()
}

/// A notebook with its entries in order, each with the name and date of what it refers to.
pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<NotebookDetail>> {
    let Some((name, notes, updated_at)) = conn
        .query_row(
            "SELECT name, notes, updated_at FROM notebooks WHERE id = ?1",
            params![id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)),
        )
        .optional()?
    else {
        return Ok(None);
    };
    let mut stmt = conn.prepare(
        "SELECT i.id, i.kind, i.ref_id, i.note, i.position,
                CASE i.kind WHEN 'study' THEN s.name ELSE r.name END,
                CASE i.kind WHEN 'study' THEN s.updated_at ELSE r.executed_at END
         FROM notebook_items i
         LEFT JOIN studies s ON i.kind = 'study' AND s.id = i.ref_id
         LEFT JOIN study_results r ON i.kind = 'result' AND r.id = i.ref_id
         WHERE i.notebook_id = ?1 ORDER BY i.position, i.id",
    )?;
    let items = stmt
        .query_map(params![id], |r| {
            Ok(NotebookItem {
                id: r.get(0)?,
                kind: r.get(1)?,
                ref_id: r.get(2)?,
                note: r.get(3)?,
                position: r.get(4)?,
                title: r.get(5)?,
                detail: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(NotebookDetail {
        id: id.to_string(),
        name,
        notes,
        updated_at,
        items,
    }))
}

/// Creates or renames a notebook and sets its notes.
pub fn save(conn: &Connection, id: &str, name: &str, notes: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("A notebook needs a name.".into());
    }
    too_long(name, MAX_NAME_CHARS, "name")?;
    too_long(notes, MAX_NOTES_CHARS, "notes")?;
    conn.execute(
        "INSERT INTO notebooks (id, name, notes, updated_at) VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, notes = excluded.notes, updated_at = datetime('now')",
        params![id, name.trim(), notes],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Deletes a notebook and its entries (never what they refer to).
pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM notebooks WHERE id = ?1", params![id])?;
    Ok(())
}

fn touch(conn: &Connection, notebook_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE notebooks SET updated_at = datetime('now') WHERE id = ?1",
        params![notebook_id],
    )?;
    Ok(())
}

/// Adds a Study or a run to the end of a notebook. Adding one that is already there changes nothing.
pub fn add_item(conn: &mut Connection, notebook_id: &str, kind: &str, ref_id: &str) -> Result<(), String> {
    if !KINDS.contains(&kind) {
        return Err(format!("A notebook holds Studies and results, not '{kind}'."));
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notebooks WHERE id = ?1)",
            params![notebook_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("That notebook no longer exists.".into());
    }
    tx.execute(
        "INSERT OR IGNORE INTO notebook_items (notebook_id, kind, ref_id, position)
         VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(position), 0) + 1 FROM notebook_items WHERE notebook_id = ?1))",
        params![notebook_id, kind, ref_id],
    )
    .map_err(|e| e.to_string())?;
    touch(&tx, notebook_id).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn remove_item(conn: &Connection, item_id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM notebook_items WHERE id = ?1", params![item_id])?;
    Ok(())
}

pub fn set_item_note(conn: &Connection, item_id: i64, note: &str) -> Result<(), String> {
    too_long(note, MAX_NOTE_CHARS, "note")?;
    conn.execute(
        "UPDATE notebook_items SET note = ?2 WHERE id = ?1",
        params![item_id, note],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Puts a notebook's entries in the given order, numbering them from 1. Entries left out keep their
/// order after the ones named; ids of other notebooks are ignored.
pub fn set_order(conn: &mut Connection, notebook_id: &str, item_ids: &[i64]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    let current: Vec<i64> = {
        let mut stmt = tx.prepare("SELECT id FROM notebook_items WHERE notebook_id = ?1 ORDER BY position, id")?;
        let ids = stmt
            .query_map(params![notebook_id], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<i64>>>()?;
        ids
    };
    let mut order: Vec<i64> = Vec::with_capacity(current.len());
    for id in item_ids.iter().chain(current.iter()) {
        if current.contains(id) && !order.contains(id) {
            order.push(*id);
        }
    }
    for (i, id) in order.iter().enumerate() {
        tx.execute(
            "UPDATE notebook_items SET position = ?2 WHERE id = ?1",
            params![id, i as i64 + 1],
        )?;
    }
    touch(&tx, notebook_id)?;
    tx.commit()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::models::{Study, StudyResult};
    use crate::store::studies;

    fn setup() -> Database {
        let db = Database::open_in_memory().unwrap();
        {
            let mut conn = db.conn.lock().unwrap();
            studies::save(
                &conn,
                &Study {
                    id: "s1".into(),
                    name: "100% Winners".into(),
                    spec_json: "{}".into(),
                    created_at: String::new(),
                    updated_at: String::new(),
                },
            )
            .unwrap();
            studies::save_result(
                &mut conn,
                &StudyResult {
                    id: "r1".into(),
                    study_id: "s1".into(),
                    name: "100% Winners".into(),
                    summary_json: "{}".into(),
                    result_json: "{}".into(),
                    executed_at: "2026-09-26T10:00:00+00:00".into(),
                },
            )
            .unwrap();
        }
        db
    }

    #[test]
    fn a_notebook_holds_studies_and_results_in_order_with_notes() {
        let db = setup();
        let mut conn = db.conn.lock().unwrap();
        save(&conn, "nb", "Winners research", "Why do stocks double?").unwrap();
        add_item(&mut conn, "nb", "result", "r1").unwrap();
        add_item(&mut conn, "nb", "study", "s1").unwrap();
        add_item(&mut conn, "nb", "study", "s1").unwrap(); // already there
        let nb = get(&conn, "nb").unwrap().unwrap();
        assert_eq!(nb.notes, "Why do stocks double?");
        assert_eq!(
            nb.items
                .iter()
                .map(|i| (i.kind.as_str(), i.position))
                .collect::<Vec<_>>(),
            [("result", 1), ("study", 2)]
        );
        assert_eq!(nb.items[0].title.as_deref(), Some("100% Winners"));
        assert_eq!(nb.items[0].detail.as_deref(), Some("2026-09-26T10:00:00+00:00"));

        set_item_note(&conn, nb.items[1].id, "the spec behind it").unwrap();
        set_order(&mut conn, "nb", &[nb.items[1].id, 999]).unwrap();
        let nb = get(&conn, "nb").unwrap().unwrap();
        assert_eq!(
            nb.items.iter().map(|i| i.kind.as_str()).collect::<Vec<_>>(),
            ["study", "result"]
        );
        assert_eq!(nb.items[0].note, "the spec behind it");
        assert_eq!(nb.items.iter().map(|i| i.position).collect::<Vec<_>>(), [1, 2]);
        assert_eq!(list(&conn).unwrap()[0].item_count, 2);
    }

    #[test]
    fn an_entry_outlives_what_it_refers_to() {
        let db = setup();
        let mut conn = db.conn.lock().unwrap();
        save(&conn, "nb", "N", "").unwrap();
        add_item(&mut conn, "nb", "study", "s1").unwrap();
        studies::delete(&mut conn, "s1").unwrap();
        let nb = get(&conn, "nb").unwrap().unwrap();
        assert_eq!(nb.items.len(), 1);
        assert_eq!(nb.items[0].title, None);
    }

    #[test]
    fn deleting_a_notebook_deletes_its_entries_not_their_targets() {
        let db = setup();
        let mut conn = db.conn.lock().unwrap();
        save(&conn, "nb", "N", "").unwrap();
        add_item(&mut conn, "nb", "result", "r1").unwrap();
        delete(&conn, "nb").unwrap();
        assert!(get(&conn, "nb").unwrap().is_none());
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM notebook_items", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
        assert!(studies::get_result(&conn, "r1").unwrap().is_some());
    }

    #[test]
    fn bad_input_is_refused() {
        let db = setup();
        let mut conn = db.conn.lock().unwrap();
        assert!(save(&conn, "nb", "  ", "").is_err());
        assert!(save(&conn, "nb", &"x".repeat(201), "").is_err());
        save(&conn, "nb", "N", "").unwrap();
        assert!(add_item(&mut conn, "nb", "html", "x").is_err());
        assert!(add_item(&mut conn, "gone", "study", "s1").is_err());
        assert!(set_item_note(&conn, 1, &"x".repeat(10_001)).is_err());
    }
}
