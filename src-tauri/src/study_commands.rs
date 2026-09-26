//! Tauri commands for Studies: the saved Studies and their runs (`store/studies.rs`), starting a
//! run (the Python engine, `python -m protrade.run_study`), and saving an export where the user
//! chooses. Thin, like the other `*_commands.rs` files.

use std::path::PathBuf;

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

use crate::db::Database;
use crate::models::{Study, StudyResult, StudyResultInfo};
use crate::pyapi::valid_run_id;
use crate::python::PythonState;
use crate::python_commands::{paths, start_python, StartRun};
use crate::store::studies;

/// A spec is a few kilobytes; anything near this is not one.
const MAX_SPEC_BYTES: usize = 1024 * 1024;
/// An export is built from a stored result, so it is no bigger than one — plus CSV's overhead.
const MAX_EXPORT_BYTES: usize = 64 * 1024 * 1024;
/// What an export may be saved as. The webview names the kind; it never names a path.
const EXPORT_KINDS: [(&str, &str); 4] = [("csv", "CSV"), ("json", "JSON"), ("py", "Python"), ("md", "Markdown")];

fn sql<T>(result: rusqlite::Result<T>) -> Result<T, String> {
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_studies(db: State<Database>) -> Result<Vec<Study>, String> {
    sql(studies::list(&*db.conn.lock().map_err(|e| e.to_string())?))
}

#[tauri::command]
pub fn save_study(study: Study, db: State<Database>) -> Result<(), String> {
    studies::save(&*db.conn.lock().map_err(|e| e.to_string())?, &study)
}

#[tauri::command]
pub fn delete_study(id: String, db: State<Database>) -> Result<(), String> {
    sql(studies::delete(&mut *db.conn.lock().map_err(|e| e.to_string())?, &id))
}

#[tauri::command]
pub fn list_study_results(study_id: Option<String>, db: State<Database>) -> Result<Vec<StudyResultInfo>, String> {
    sql(studies::list_results(
        &*db.conn.lock().map_err(|e| e.to_string())?,
        study_id.as_deref(),
    ))
}

#[tauri::command]
pub fn get_study_result(id: String, db: State<Database>) -> Result<Option<StudyResult>, String> {
    sql(studies::get_result(&*db.conn.lock().map_err(|e| e.to_string())?, &id))
}

#[tauri::command]
pub fn save_study_result(result: StudyResult, db: State<Database>) -> Result<(), String> {
    studies::save_result(&mut *db.conn.lock().map_err(|e| e.to_string())?, &result)
}

#[tauri::command]
pub fn delete_study_result(id: String, db: State<Database>) -> Result<(), String> {
    sql(studies::delete_result(
        &*db.conn.lock().map_err(|e| e.to_string())?,
        &id,
    ))
}

/// Where a run's spec is written for the engine to read: named by the run, which is checked
/// to be a safe file name first.
fn spec_file(studies_dir: &std::path::Path, run_id: &str) -> Result<PathBuf, String> {
    if !valid_run_id(run_id) {
        return Err("That isn't a valid run id.".into());
    }
    Ok(studies_dir.join(format!("{run_id}.json")))
}

/// Runs a Study: writes its spec to a file and starts `python -m protrade.run_study` on it. Output
/// and the result arrive as the same events a script's do (`python-output`, `python-result`,
/// `python-exit`), for `run_id`. Only ever called when the user presses Run Study.
#[tauri::command]
pub async fn study_run(
    spec_json: String,
    run_id: String,
    app: AppHandle,
    state: State<'_, PythonState>,
    db: State<'_, Database>,
) -> Result<(), String> {
    if spec_json.len() > MAX_SPEC_BYTES
        || !serde_json::from_str::<serde_json::Value>(&spec_json).is_ok_and(|v| v.is_object())
    {
        return Err("That isn't a Study Specification.".into());
    }
    let dir = paths(&app)?.root.join("studies");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't prepare the studies folder: {e}"))?;
    let file = spec_file(&dir, &run_id)?;
    std::fs::write(&file, &spec_json).map_err(|e| format!("Couldn't write the Study for Python: {e}"))?;
    let started = start_python(
        &app,
        &state,
        &db,
        StartRun {
            args: vec!["-m".into(), "protrade.run_study".into(), file.clone().into_os_string()],
            cwd: dir,
            run_id,
            remove_after: Some(file.clone()),
        },
    )
    .await;
    if started.is_err() {
        let _ = std::fs::remove_file(&file);
    }
    started
}

/// The file name offered in the save dialog: the webview's suggestion without anything that
/// could name a folder, and with the kind's extension.
pub fn export_file_name(suggested: &str, extension: &str) -> String {
    let stem: String = suggested
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '(' | ')' | '%') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let stem = stem.trim().trim_matches('_');
    let stem = if stem.is_empty() { "study" } else { stem };
    let stem: String = stem.chars().take(100).collect();
    format!("{stem}.{extension}")
}

/// Asks where to save an export and writes it there. The user picks the place in the system's
/// own dialog; the webview supplies only the contents, a name to suggest and the kind. `None`
/// when the dialog was cancelled.
#[tauri::command]
pub async fn export_study_file(
    suggested_name: String,
    kind: String,
    contents: String,
    app: AppHandle,
) -> Result<Option<String>, String> {
    let (extension, label) = EXPORT_KINDS
        .iter()
        .find(|(ext, _)| *ext == kind)
        .copied()
        .ok_or_else(|| format!("Can't export as {kind}."))?;
    if contents.len() > MAX_EXPORT_BYTES {
        return Err("That export is too large.".into());
    }
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(export_file_name(&suggested_name, extension))
        .add_filter(label, &[extension])
        .save_file(move |chosen| {
            let _ = tx.send(chosen);
        });
    let Some(chosen) = rx
        .await
        .map_err(|_| "The save dialog closed unexpectedly.".to_string())?
    else {
        return Ok(None);
    };
    let path = chosen.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, contents).map_err(|e| format!("Couldn't save {}: {e}", path.display()))?;
    Ok(Some(path.display().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_export_name_cannot_name_a_folder() {
        assert_eq!(export_file_name("100% Winners", "csv"), "100% Winners.csv");
        assert_eq!(export_file_name("../../etc/passwd", "json"), "etc_passwd.json");
        assert_eq!(export_file_name("a\\b:c", "py"), "a_b_c.py");
        assert_eq!(export_file_name("   ", "md"), "study.md");
        assert_eq!(export_file_name(&"x".repeat(500), "csv").len(), 104);
    }

    #[test]
    fn a_spec_file_is_named_by_a_checked_run_id() {
        let dir = std::path::Path::new("/data/python/studies");
        assert_eq!(spec_file(dir, "run-1").unwrap(), dir.join("run-1.json"));
        assert!(spec_file(dir, "../escape").is_err());
        assert!(spec_file(dir, "").is_err());
    }
}
