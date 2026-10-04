//! Tauri commands for the market-data store (`marketdata/`). Thin: the jobs and their rules live there.

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::db::{Database, ResearchDb};
use crate::marketdata::{self, Holdings, MarketData, Running, Trigger};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketDataStatus {
    /// The broker the history comes from; `None` until the download has been started.
    pub provider: Option<String>,
    pub auto_update: bool,
    pub running: Option<Running>,
    pub last_update: Option<i64>,
    pub last_failure: Option<i64>,
    pub last_error: Option<String>,
    pub holdings: Holdings,
}

#[tauri::command(async)]
pub fn market_data_status(
    db: State<Database>,
    research: State<ResearchDb>,
    jobs: State<MarketData>,
) -> Result<MarketDataStatus, String> {
    let (provider, auto_update, record) = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        (
            marketdata::store_provider(&conn),
            marketdata::auto_enabled(&conn),
            marketdata::record(&conn),
        )
    };
    let holdings = {
        let conn = research.read.conn.lock().map_err(|e| e.to_string())?;
        marketdata::holdings(&conn).map_err(|e| e.to_string())?
    };
    Ok(MarketDataStatus {
        provider,
        auto_update,
        running: jobs.running(),
        last_update: record.last_update,
        last_failure: record.last_failure,
        last_error: record.last_error,
        holdings,
    })
}

/// Starts (or resumes) the five-year download. Only ever called from its button.
#[tauri::command(async)]
pub fn market_data_download(app: AppHandle) -> Result<(), String> {
    marketdata::start(&app, Trigger::Download)
}

#[tauri::command(async)]
pub fn market_data_update_now(app: AppHandle) -> Result<(), String> {
    marketdata::start(&app, Trigger::Update)
}

#[tauri::command]
pub fn market_data_stop(jobs: State<MarketData>) {
    jobs.stop();
}

#[tauri::command(async)]
pub fn market_data_set_auto(on: bool, db: State<Database>) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    marketdata::set_auto(&conn, on).map_err(|e| e.to_string())
}
