//! Tauri commands for "Keep the market loaded" (`marketdata/`). Thin: the jobs and their rules live there.

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::db::Database;
use crate::marketdata::{self, Holdings, MarketData, Running, Trigger};
use crate::store::bar_memory::BarMemory;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketDataStatus {
    pub keep_loaded: bool,
    pub running: Option<Running>,
    /// This session's last successful load; `None` after a launch until one finishes.
    pub last_update: Option<i64>,
    pub last_failure: Option<i64>,
    pub last_error: Option<String>,
    pub holdings: Holdings,
}

#[tauri::command(async)]
pub fn market_data_status(
    db: State<Database>,
    memory: State<BarMemory>,
    jobs: State<MarketData>,
) -> Result<MarketDataStatus, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let record = jobs.record();
    Ok(MarketDataStatus {
        keep_loaded: marketdata::keep_loaded(&conn),
        running: jobs.running(),
        last_update: record.last_update,
        last_failure: record.last_failure,
        last_error: record.last_error,
        holdings: marketdata::holdings(&conn, &memory).map_err(|e| e.to_string())?,
    })
}

/// Loads the market now (or brings it up to date). Only ever called from its button.
#[tauri::command(async)]
pub fn market_data_load_now(app: AppHandle) -> Result<(), String> {
    marketdata::start(&app, Trigger::Load)
}

#[tauri::command]
pub fn market_data_stop(jobs: State<MarketData>) {
    jobs.stop();
}

/// Switches "Keep the market loaded" on (and starts loading at once) or off (and stops a load in
/// progress). Whatever is already in memory stays until the app closes or memory is cleared.
#[tauri::command(async)]
pub fn market_data_set_keep_loaded(
    on: bool,
    app: AppHandle,
    db: State<Database>,
    jobs: State<MarketData>,
) -> Result<(), String> {
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        marketdata::set_keep_loaded(&conn, on).map_err(|e| e.to_string())?;
    }
    if !on {
        jobs.stop();
        return Ok(());
    }
    match marketdata::start(&app, Trigger::Load) {
        // Already loading is what was asked for.
        Err(e) if jobs.running().is_some() => {
            log::debug!("market data: {e}");
            Ok(())
        }
        other => other,
    }
}
