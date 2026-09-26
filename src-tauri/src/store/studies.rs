//! Saved Studies and their completed runs. The spec and the results are JSON documents the
//! frontend and the Python engine own; this only keeps them, and keeps the runs from piling up.

use rusqlite::{params, Connection, OptionalExtension};

use crate::models::{Study, StudyResult, StudyResultInfo};

/// Runs kept per Study; older ones are dropped when a new one is saved.
pub const KEEP_RESULTS: i64 = 20;
/// A result's JSON is capped at what the Python API accepts in one post, with room for the
/// frontend's wrapping.
pub const MAX_RESULT_BYTES: usize = 20 * 1024 * 1024;
const MAX_SPEC_BYTES: usize = 1024 * 1024;
const MAX_NAME_CHARS: usize = 200;

fn check_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("A Study needs a name.".into());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("A Study's name can be at most {MAX_NAME_CHARS} characters."));
    }
    Ok(())
}

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

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Study>> {
    let mut stmt = conn
        .prepare("SELECT id, name, spec_json, created_at, updated_at FROM studies ORDER BY name COLLATE NOCASE ASC")?;
    let rows = stmt.query_map([], |r| {
        Ok(Study {
            id: r.get(0)?,
            name: r.get(1)?,
            spec_json: r.get(2)?,
            created_at: r.get(3)?,
            updated_at: r.get(4)?,
        })
    })?;
    rows.collect()
}

/// Inserts or updates a Study. The spec must be a JSON object; its contents are not judged here.
pub fn save(conn: &Connection, study: &Study) -> Result<(), String> {
    check_name(&study.name)?;
    check_json(&study.spec_json, "Study Specification", MAX_SPEC_BYTES)?;
    conn.execute(
        "INSERT INTO studies (id, name, spec_json, updated_at) VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, spec_json = excluded.spec_json,
           updated_at = datetime('now')",
        params![study.id, study.name.trim(), study.spec_json],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Runs a Research Notebook refers to: kept when their Study is deleted or they fall out of the
/// newest [`KEEP_RESULTS`], since someone chose to keep them.
const IN_A_NOTEBOOK: &str = "SELECT ref_id FROM notebook_items WHERE kind = 'result'";

/// Deletes a Study and every run of it that no notebook keeps.
pub fn delete(conn: &mut Connection, id: &str) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute(
        &format!("DELETE FROM study_results WHERE study_id = ?1 AND id NOT IN ({IN_A_NOTEBOOK})"),
        params![id],
    )?;
    tx.execute("DELETE FROM studies WHERE id = ?1", params![id])?;
    tx.commit()
}

/// Completed runs, newest first: of one Study, or of every Study.
pub fn list_results(conn: &Connection, study_id: Option<&str>) -> rusqlite::Result<Vec<StudyResultInfo>> {
    let mut stmt = conn.prepare(
        "SELECT id, study_id, name, summary_json, executed_at FROM study_results
         WHERE ?1 IS NULL OR study_id = ?1 ORDER BY executed_at DESC, created_at DESC",
    )?;
    let rows = stmt.query_map(params![study_id], |r| {
        Ok(StudyResultInfo {
            id: r.get(0)?,
            study_id: r.get(1)?,
            name: r.get(2)?,
            summary_json: r.get(3)?,
            executed_at: r.get(4)?,
        })
    })?;
    rows.collect()
}

pub fn get_result(conn: &Connection, id: &str) -> rusqlite::Result<Option<StudyResult>> {
    conn.query_row(
        "SELECT id, study_id, name, summary_json, result_json, executed_at FROM study_results WHERE id = ?1",
        params![id],
        |r| {
            Ok(StudyResult {
                id: r.get(0)?,
                study_id: r.get(1)?,
                name: r.get(2)?,
                summary_json: r.get(3)?,
                result_json: r.get(4)?,
                executed_at: r.get(5)?,
            })
        },
    )
    .optional()
}

/// Keeps a completed run, then drops the Study's oldest runs past [`KEEP_RESULTS`] (except those a
/// notebook keeps).
pub fn save_result(conn: &mut Connection, result: &StudyResult) -> Result<(), String> {
    check_name(&result.name)?;
    check_json(&result.summary_json, "result summary", MAX_SPEC_BYTES)?;
    check_json(&result.result_json, "Study result", MAX_RESULT_BYTES)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT OR REPLACE INTO study_results (id, study_id, name, summary_json, result_json, executed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            result.id,
            result.study_id,
            result.name.trim(),
            result.summary_json,
            result.result_json,
            result.executed_at
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        &format!(
            "DELETE FROM study_results WHERE study_id = ?1 AND id NOT IN ({IN_A_NOTEBOOK}) AND id NOT IN (
               SELECT id FROM study_results WHERE study_id = ?1
               ORDER BY executed_at DESC, created_at DESC LIMIT ?2)"
        ),
        params![result.study_id, KEEP_RESULTS],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn delete_result(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM study_results WHERE id = ?1", params![id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn study(id: &str, name: &str) -> Study {
        Study {
            id: id.into(),
            name: name.into(),
            spec_json: r#"{"version":1}"#.into(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn result(id: &str, study_id: &str, executed_at: &str) -> StudyResult {
        StudyResult {
            id: id.into(),
            study_id: study_id.into(),
            name: "Winners".into(),
            summary_json: r#"{"events":3}"#.into(),
            result_json: r#"{"format":1}"#.into(),
            executed_at: executed_at.into(),
        }
    }

    #[test]
    fn studies_are_saved_updated_listed_by_name_and_deleted() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        save(&conn, &study("b", "Breakouts")).unwrap();
        save(&conn, &study("a", "winners")).unwrap();
        let mut renamed = study("b", "  Zeta  ");
        renamed.spec_json = r#"{"version":1,"name":"Zeta"}"#.into();
        save(&conn, &renamed).unwrap();
        let all = list(&conn).unwrap();
        assert_eq!(
            all.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["winners", "Zeta"]
        );
        assert!(all[1].spec_json.contains("Zeta"));
        delete(&mut conn, "a").unwrap();
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn a_study_needs_a_name_and_a_json_object() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        assert!(save(&conn, &study("a", "  ")).is_err());
        let mut bad = study("a", "X");
        bad.spec_json = "[1,2]".into();
        assert!(save(&conn, &bad).is_err());
        bad.spec_json = "not json".into();
        assert!(save(&conn, &bad).is_err());
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn results_are_listed_newest_first_and_read_back_whole() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        save_result(&mut conn, &result("r1", "s1", "2026-01-01T10:00:00+00:00")).unwrap();
        save_result(&mut conn, &result("r2", "s1", "2026-02-01T10:00:00+00:00")).unwrap();
        save_result(&mut conn, &result("r3", "s2", "2026-03-01T10:00:00+00:00")).unwrap();
        let of_s1 = list_results(&conn, Some("s1")).unwrap();
        assert_eq!(of_s1.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["r2", "r1"]);
        assert_eq!(list_results(&conn, None).unwrap().len(), 3);
        assert_eq!(get_result(&conn, "r3").unwrap().unwrap().result_json, r#"{"format":1}"#);
        assert!(get_result(&conn, "nope").unwrap().is_none());
        delete_result(&conn, "r3").unwrap();
        assert_eq!(list_results(&conn, None).unwrap().len(), 2);
    }

    #[test]
    fn only_the_newest_runs_of_a_study_are_kept() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        for i in 0..(KEEP_RESULTS + 3) {
            save_result(
                &mut conn,
                &result(&format!("r{i}"), "s1", &format!("2026-01-01T10:{i:02}:00+00:00")),
            )
            .unwrap();
        }
        save_result(&mut conn, &result("other", "s2", "2020-01-01T00:00:00+00:00")).unwrap();
        let kept = list_results(&conn, Some("s1")).unwrap();
        assert_eq!(kept.len() as i64, KEEP_RESULTS);
        assert_eq!(kept.last().unwrap().id, "r3", "the three oldest went");
        assert_eq!(
            list_results(&conn, Some("s2")).unwrap().len(),
            1,
            "another study's runs are untouched"
        );
    }

    #[test]
    fn a_run_kept_in_a_notebook_survives_pruning_and_its_studys_deletion() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        save_result(&mut conn, &result("kept", "s1", "2020-01-01T00:00:00+00:00")).unwrap();
        crate::store::notebooks::save(&conn, "nb", "Research", "").unwrap();
        crate::store::notebooks::add_item(&mut conn, "nb", "result", "kept").unwrap();
        for i in 0..(KEEP_RESULTS + 2) {
            save_result(
                &mut conn,
                &result(&format!("r{i}"), "s1", &format!("2026-01-01T10:{i:02}:00+00:00")),
            )
            .unwrap();
        }
        let ids: Vec<String> = list_results(&conn, Some("s1"))
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert!(ids.contains(&"kept".to_string()), "the oldest run is in a notebook");
        assert_eq!(ids.len() as i64, KEEP_RESULTS + 1);
        delete(&mut conn, "s1").unwrap();
        let left: Vec<String> = list_results(&conn, None).unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(left, ["kept"]);
    }

    #[test]
    fn deleting_a_study_deletes_its_runs() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        save(&conn, &study("s1", "X")).unwrap();
        save_result(&mut conn, &result("r1", "s1", "2026-01-01")).unwrap();
        save_result(&mut conn, &result("r2", "s2", "2026-01-01")).unwrap();
        delete(&mut conn, "s1").unwrap();
        assert_eq!(
            list_results(&conn, None)
                .unwrap()
                .iter()
                .map(|r| r.id.as_str())
                .collect::<Vec<_>>(),
            ["r2"]
        );
    }
}
