//! Tauri command layer: thin wrappers that lock the database, call into
//! `store` / `market`, and flatten errors to strings for the frontend.

use std::collections::HashMap;
use std::sync::MutexGuard;

use rusqlite::Connection;
use tauri::{AppHandle, Manager, State};

use crate::db::Database;
use crate::models::*;
use crate::store::{datasets, layouts, preferences, scripts, symbol_names, watchlists};

fn lock(db: &Database) -> Result<MutexGuard<'_, Connection>, String> {
    db.conn.lock().map_err(|e| e.to_string())
}

fn sql<T>(result: rusqlite::Result<T>) -> Result<T, String> {
    result.map_err(|e| e.to_string())
}

// ---- App -------------------------------------------------------------------

#[tauri::command]
pub fn get_app_info(app: AppHandle) -> Result<AppInfo, String> {
    let data_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        data_dir: data_dir.display().to_string(),
    })
}

#[tauri::command]
pub fn get_ui_preference(key: String, db: State<Database>) -> Result<Option<String>, String> {
    sql(preferences::get(&*lock(&db)?, &key))
}

#[tauri::command]
pub fn set_ui_preference(key: String, value: String, db: State<Database>) -> Result<(), String> {
    sql(preferences::set(&*lock(&db)?, &key, &value))
}

// ---- Layouts ---------------------------------------------------------------

#[tauri::command]
pub fn get_chart_layouts(db: State<Database>) -> Result<Vec<ChartLayout>, String> {
    sql(layouts::list(&*lock(&db)?))
}

#[tauri::command]
pub fn save_chart_layout(layout: ChartLayout, db: State<Database>) -> Result<(), String> {
    sql(layouts::save(&mut *lock(&db)?, &layout))
}

#[tauri::command]
pub fn delete_chart_layout(id: String, db: State<Database>) -> Result<(), String> {
    sql(layouts::delete(&*lock(&db)?, &id))
}

// ---- Pine scripts ----------------------------------------------------------

#[tauri::command]
pub fn list_pine_scripts(db: State<Database>) -> Result<Vec<PineScript>, String> {
    sql(scripts::list(&*lock(&db)?))
}

#[tauri::command]
pub fn save_pine_script(script: PineScript, db: State<Database>) -> Result<(), String> {
    sql(scripts::save(&*lock(&db)?, &script))
}

#[tauri::command]
pub fn delete_pine_script(id: String, db: State<Database>) -> Result<(), String> {
    sql(scripts::delete(&*lock(&db)?, &id))
}

// ---- Watchlists ------------------------------------------------------------

fn watchlist_detail(conn: &Connection, id: i64) -> Result<WatchlistDetail, String> {
    sql(watchlists::get(conn, id))?.ok_or_else(|| format!("watchlist {id} not found"))
}

#[tauri::command]
pub fn list_watchlists(db: State<Database>) -> Result<Vec<WatchlistSummary>, String> {
    sql(watchlists::list(&*lock(&db)?))
}

#[tauri::command]
pub fn get_watchlist(id: i64, db: State<Database>) -> Result<WatchlistDetail, String> {
    watchlist_detail(&*lock(&db)?, id)
}

#[tauri::command]
pub fn create_watchlist(name: String, db: State<Database>) -> Result<WatchlistDetail, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a watchlist needs a name".to_string());
    }
    let conn = lock(&db)?;
    let id = sql(watchlists::create(&conn, name))?;
    watchlist_detail(&conn, id)
}

#[tauri::command]
pub fn rename_watchlist(id: i64, name: String, db: State<Database>) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a watchlist needs a name".to_string());
    }
    sql(watchlists::rename(&*lock(&db)?, id, name))
}

#[tauri::command]
pub fn delete_watchlist(id: i64, db: State<Database>) -> Result<(), String> {
    sql(watchlists::delete(&*lock(&db)?, id))
}

#[tauri::command]
pub fn add_watchlist_items(
    watchlist_id: i64,
    items: Vec<NewWatchlistItem>,
    db: State<Database>,
) -> Result<WatchlistDetail, String> {
    let mut conn = lock(&db)?;
    let added = sql(watchlists::add_items(&mut conn, watchlist_id, &items))?;
    let mut detail = watchlist_detail(&conn, watchlist_id)?;
    detail.added = Some(added);
    Ok(detail)
}

#[tauri::command]
pub fn remove_watchlist_items(watchlist_id: i64, symbols: Vec<String>, db: State<Database>) -> Result<(), String> {
    sql(watchlists::remove_items(&mut *lock(&db)?, watchlist_id, &symbols))
}

// ---- Imported datasets -----------------------------------------------------

#[tauri::command]
pub fn list_datasets(db: State<Database>) -> Result<Vec<DatasetInfo>, String> {
    sql(datasets::list(&*lock(&db)?))
}

#[tauri::command]
pub fn save_dataset(input: DatasetInput, db: State<Database>) -> Result<DatasetInfo, String> {
    if input.ticker.trim().is_empty() {
        return Err("a dataset needs a ticker".to_string());
    }
    if input.bars.is_empty() {
        return Err("a dataset needs at least one bar".to_string());
    }
    sql(datasets::save(&mut *lock(&db)?, &input))
}

#[tauri::command]
pub fn delete_dataset(ticker: String, db: State<Database>) -> Result<(), String> {
    sql(datasets::delete(&*lock(&db)?, &ticker))
}

#[tauri::command]
pub fn get_dataset_bars(
    ticker: String,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
    limit: Option<usize>,
    db: State<Database>,
) -> Result<Option<DatasetBars>, String> {
    sql(datasets::bars(&*lock(&db)?, &ticker, from_ms, to_ms, limit))
}

// ---- Symbol names ----------------------------------------------------------

/// Company names already known for `symbols` (`provider:TICKER`): the brokers'
/// instrument lists carry them. A symbol with no known name is simply absent.
#[tauri::command]
pub fn symbol_names(symbols: Vec<String>, db: State<Database>) -> Result<HashMap<String, String>, String> {
    sql(symbol_names::known(&*lock(&db)?, &symbols))
}
