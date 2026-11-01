//! Tauri commands for the Screener: saved screens and their last run (`store/screeners.rs`), and
//! running one (the Python engine, `python -m protrade.run_screen`). Thin, like `study_commands.rs`,
//! whose estimate (`study_estimate`) the Screener also uses to price a run.

use tauri::{AppHandle, State};

use crate::db::Database;
use crate::models::Screener;
use crate::python::PythonState;
use crate::python_commands::{paths, start_python, StartRun};
use crate::store::screeners;
use crate::study_commands::spec_file;

/// A screen is a few kilobytes; anything near this is not one.
const MAX_SPEC_BYTES: usize = 1024 * 1024;

fn sql<T>(result: rusqlite::Result<T>) -> Result<T, String> {
    result.map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn list_screeners(db: State<Database>) -> Result<Vec<Screener>, String> {
    sql(screeners::list(&*db.conn.lock().map_err(|e| e.to_string())?))
}

#[tauri::command(async)]
pub fn save_screener(id: String, name: String, spec_json: String, db: State<Database>) -> Result<(), String> {
    screeners::save(&*db.conn.lock().map_err(|e| e.to_string())?, &id, &name, &spec_json)
}

#[tauri::command(async)]
pub fn delete_screener(id: String, db: State<Database>) -> Result<(), String> {
    sql(screeners::delete(&*db.conn.lock().map_err(|e| e.to_string())?, &id))
}

/// Keeps a run as the screen's last one; `false` when the screen isn't saved (the run is only shown).
#[tauri::command(async)]
pub fn save_screener_result(
    id: String,
    result_json: String,
    ran_at: String,
    db: State<Database>,
) -> Result<bool, String> {
    screeners::save_result(&*db.conn.lock().map_err(|e| e.to_string())?, &id, &result_json, &ran_at)
}

#[tauri::command(async)]
pub fn get_screener_result(id: String, db: State<Database>) -> Result<Option<String>, String> {
    sql(screeners::get_result(&*db.conn.lock().map_err(|e| e.to_string())?, &id))
}

/// Runs a screen: writes it to a file and starts `python -m protrade.run_screen` on it. Output and
/// the result arrive as a script's do (`python-output`, `python-result` of kind `screen`,
/// `python-exit`), for `run_id`. Only ever called when the user presses Run.
#[tauri::command]
pub async fn screen_run(
    spec_json: String,
    run_id: String,
    app: AppHandle,
    state: State<'_, PythonState>,
    db: State<'_, Database>,
) -> Result<(), String> {
    if spec_json.len() > MAX_SPEC_BYTES
        || !serde_json::from_str::<serde_json::Value>(&spec_json).is_ok_and(|v| v.is_object())
    {
        return Err("That isn't a screen.".into());
    }
    let dir = paths(&app)?.root.join("screens");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't prepare the screens folder: {e}"))?;
    let file = spec_file(&dir, &run_id)?;
    std::fs::write(&file, &spec_json).map_err(|e| format!("Couldn't write the screen for Python: {e}"))?;
    let started = start_python(
        &app,
        &state,
        &db,
        StartRun {
            args: vec!["-m".into(), "protrade.run_screen".into(), file.clone().into_os_string()],
            cwd: dir,
            run_id,
            remove_after: Some(file.clone()),
            on_exit: None,
            env: Vec::new(),
        },
    )
    .await;
    if started.is_err() {
        let _ = std::fs::remove_file(&file);
    }
    started
}
