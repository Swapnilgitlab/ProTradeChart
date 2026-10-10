//! Tauri commands for Studies: the saved Studies and their runs (`store/studies.rs`), starting a
//! run (the Python engine, `python -m protrade.run_study`), and saving an export where the user
//! chooses. Thin, like the other `*_commands.rs` files.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

use crate::db::Database;
use crate::models::{NotebookDetail, NotebookSummary, Study, StudyResult, StudyResultInfo};
use crate::pyapi::valid_run_id;
use crate::python::PythonState;
use crate::python_commands::{paths, start_python, StartRun};
use crate::store::instrument_list::{self, Filter, Source};
use crate::store::{notebooks, studies, study_universe};

/// A spec is a few kilobytes; anything near this is not one.
const MAX_SPEC_BYTES: usize = 1024 * 1024;
/// An export is built from a stored result, so it is no bigger than one — plus CSV's overhead.
const MAX_EXPORT_BYTES: usize = 64 * 1024 * 1024;
/// What an export may be saved as. The webview names the kind; it never names a path.
const EXPORT_KINDS: [(&str, &str); 4] = [("csv", "CSV"), ("json", "JSON"), ("py", "Python"), ("md", "Markdown")];

fn sql<T>(result: rusqlite::Result<T>) -> Result<T, String> {
    result.map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn list_studies(db: State<Database>) -> Result<Vec<Study>, String> {
    sql(studies::list(&*db.conn.lock().map_err(|e| e.to_string())?))
}

#[tauri::command(async)]
pub fn save_study(study: Study, db: State<Database>) -> Result<(), String> {
    studies::save(&*db.conn.lock().map_err(|e| e.to_string())?, &study)
}

#[tauri::command(async)]
pub fn delete_study(id: String, db: State<Database>) -> Result<(), String> {
    sql(studies::delete(&mut *db.conn.lock().map_err(|e| e.to_string())?, &id))
}

#[tauri::command(async)]
pub fn list_study_results(study_id: Option<String>, db: State<Database>) -> Result<Vec<StudyResultInfo>, String> {
    sql(studies::list_results(
        &*db.conn.lock().map_err(|e| e.to_string())?,
        study_id.as_deref(),
    ))
}

#[tauri::command(async)]
pub fn get_study_result(id: String, db: State<Database>) -> Result<Option<StudyResult>, String> {
    sql(studies::get_result(&*db.conn.lock().map_err(|e| e.to_string())?, &id))
}

#[tauri::command(async)]
pub fn save_study_result(result: StudyResult, db: State<Database>) -> Result<(), String> {
    studies::save_result(&mut *db.conn.lock().map_err(|e| e.to_string())?, &result)
}

#[tauri::command(async)]
pub fn delete_study_result(id: String, db: State<Database>) -> Result<(), String> {
    sql(studies::delete_result(
        &*db.conn.lock().map_err(|e| e.to_string())?,
        &id,
    ))
}

// ---- Research Notebooks ------------------------------------------------------

#[tauri::command(async)]
pub fn list_notebooks(db: State<Database>) -> Result<Vec<NotebookSummary>, String> {
    sql(notebooks::list(&*db.conn.lock().map_err(|e| e.to_string())?))
}

#[tauri::command(async)]
pub fn get_notebook(id: String, db: State<Database>) -> Result<Option<NotebookDetail>, String> {
    sql(notebooks::get(&*db.conn.lock().map_err(|e| e.to_string())?, &id))
}

#[tauri::command(async)]
pub fn save_notebook(id: String, name: String, notes: String, db: State<Database>) -> Result<(), String> {
    notebooks::save(&*db.conn.lock().map_err(|e| e.to_string())?, &id, &name, &notes)
}

#[tauri::command(async)]
pub fn delete_notebook(id: String, db: State<Database>) -> Result<(), String> {
    sql(notebooks::delete(&*db.conn.lock().map_err(|e| e.to_string())?, &id))
}

#[tauri::command(async)]
pub fn add_notebook_item(notebook_id: String, kind: String, ref_id: String, db: State<Database>) -> Result<(), String> {
    notebooks::add_item(
        &mut *db.conn.lock().map_err(|e| e.to_string())?,
        &notebook_id,
        &kind,
        &ref_id,
    )
}

#[tauri::command(async)]
pub fn remove_notebook_item(item_id: i64, db: State<Database>) -> Result<(), String> {
    sql(notebooks::remove_item(
        &*db.conn.lock().map_err(|e| e.to_string())?,
        item_id,
    ))
}

#[tauri::command(async)]
pub fn set_notebook_item_note(item_id: i64, note: String, db: State<Database>) -> Result<(), String> {
    notebooks::set_item_note(&*db.conn.lock().map_err(|e| e.to_string())?, item_id, &note)
}

#[tauri::command(async)]
pub fn set_notebook_order(notebook_id: String, item_ids: Vec<i64>, db: State<Database>) -> Result<(), String> {
    sql(notebooks::set_order(
        &mut *db.conn.lock().map_err(|e| e.to_string())?,
        &notebook_id,
        &item_ids,
    ))
}

/// The universe a Study would load, to price before it runs: a broker's instrument list, or symbols.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EstimateRequest {
    /// The instrument list to read, when `symbols` is absent.
    pub provider: String,
    pub exchanges: Vec<String>,
    pub series: Vec<String>,
    /// A watchlist's or a list's symbols, used as they are.
    pub symbols: Option<Vec<String>>,
    /// The first bar the Study loads, epoch ms.
    pub from_ms: i64,
    /// Study only the first N symbols.
    pub max_symbols: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyEstimate {
    pub symbols: usize,
    pub stored: usize,
    pub requests: usize,
    /// Batched quote calls the daily top-up needs for stored symbols that only need their newest
    /// bar — usually 0 or 1, never one per symbol (`store::day_topup`, `study_universe::estimate`).
    pub quote_requests: usize,
    pub seconds: f64,
    /// Listings left out as not stocks (bonds, SGBs, funds…) or as a second listing of a company.
    pub listings_skipped: usize,
}

/// How many symbols a Study would load, how many are already in memory, and roughly how long the rest
/// take at the broker's pace. Reads only the instrument list and memory; asks no broker.
#[tauri::command(async)]
pub fn study_estimate(
    request: EstimateRequest,
    db: State<Database>,
    memory: State<crate::store::bar_memory::BarMemory>,
) -> Result<StudyEstimate, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let (mut symbols, skipped) = match request.symbols {
        Some(list) => {
            let mut seen = std::collections::HashSet::new();
            (
                list.into_iter().filter(|s| seen.insert(s.clone())).collect::<Vec<_>>(),
                0,
            )
        }
        None => {
            let source = Source::parse(&request.provider).ok_or("Studies read Zerodha data only.")?;
            let mut rows = Vec::new();
            for exchange in &request.exchanges {
                let filter = Filter {
                    exchange: Some(exchange.clone()),
                    kind: Some("EQUITY".into()),
                    query: None,
                };
                for listed in instrument_list::list(&conn, source, &filter, 50_000).map_err(|e| e.to_string())? {
                    rows.push((format!("{}:{}", request.provider, listed.ticker), listed.name));
                }
            }
            let picked = study_universe::pick_listings(&rows, &request.series);
            let skipped = rows.len() - picked.len();
            (picked, skipped)
        }
    };
    if let Some(max) = request.max_symbols {
        symbols.truncate(max);
    }
    // Kite serves up to 2000 days of daily bars a call.
    let (window_days, gap, quote_batch, quote_gap) = (
        2_000,
        crate::zerodha::client::Pacing::default().data_gap,
        crate::zerodha::client::QUOTE_BATCH,
        crate::zerodha::client::Pacing::default().quote_gap,
    );
    let e = study_universe::estimate(
        &memory,
        &symbols,
        request.from_ms,
        crate::db::now_ms(),
        window_days,
        gap.as_millis() as u64,
        quote_batch,
        quote_gap.as_millis() as u64,
    );
    Ok(StudyEstimate {
        symbols: e.symbols,
        stored: e.stored,
        requests: e.requests,
        quote_requests: e.quote_requests,
        seconds: e.seconds,
        listings_skipped: skipped,
    })
}

/// Where a run's spec is written for the engine to read: named by the run, which is checked
/// to be a safe file name first.
pub(crate) fn spec_file(studies_dir: &std::path::Path, run_id: &str) -> Result<PathBuf, String> {
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
            on_exit: None,
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
