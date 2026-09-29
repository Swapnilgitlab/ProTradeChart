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
    if let Some(flag) = watchlists::flag_of_list(id) {
        return sql(watchlists::flag_list(conn, flag));
    }
    sql(watchlists::get(conn, id))?.ok_or_else(|| format!("watchlist {id} not found"))
}

/// Refuses what only a real watchlist can do (be renamed, deleted, reordered, given sections) when `id`
/// is a colour's list, whose contents are simply the symbols flagged with it.
fn real_list(id: i64) -> Result<(), String> {
    match watchlists::flag_of_list(id) {
        Some(_) => Err(
            "A colour flag list holds whatever is flagged with its colour, newest first; it can't be changed that way."
                .into(),
        ),
        None => Ok(()),
    }
}

/// The six colour lists, with how many symbols each holds.
#[tauri::command]
pub fn list_flag_lists(db: State<Database>) -> Result<Vec<WatchlistSummary>, String> {
    sql(watchlists::flag_lists(&*lock(&db)?))
}

/// Flags a symbol with a colour (`red`, `orange`, `yellow`, `green`, `blue`, `purple`) — on every list it is
/// on — or clears its flag with `None`. Tells every window, so lists and colour lists follow.
#[tauri::command]
pub fn set_symbol_flag(
    symbol: String,
    flag: Option<String>,
    app: tauri::AppHandle,
    db: State<Database>,
) -> Result<(), String> {
    if let Some(flag) = &flag {
        if !watchlists::is_flag(flag) {
            return Err(format!("'{flag}' is not a flag colour"));
        }
    }
    sql(watchlists::set_symbol_flag(
        &*lock(&db)?,
        &symbol,
        flag.as_deref(),
        crate::db::now_ms(),
    ))?;
    use tauri::Emitter;
    let _ = app.emit(crate::pyapi::backend::WATCHLISTS_CHANGED, 0);
    Ok(())
}

#[tauri::command]
pub fn list_watchlists(db: State<Database>) -> Result<Vec<WatchlistSummary>, String> {
    sql(watchlists::list(&*lock(&db)?))
}

/// Which symbols every list holds, as `[watchlist id, symbol]` pairs.
#[tauri::command]
pub fn list_watchlist_members(db: State<Database>) -> Result<Vec<(i64, String)>, String> {
    sql(watchlists::members(&*lock(&db)?))
}

#[tauri::command]
pub fn get_watchlist(id: i64, db: State<Database>) -> Result<WatchlistDetail, String> {
    watchlist_detail(&*lock(&db)?, id)
}

/// Makes the Indices watchlist (the broad market, sectors and themes) from a broker's instrument list.
#[tauri::command]
pub fn create_indices_watchlist(provider: String, db: State<Database>) -> Result<WatchlistDetail, String> {
    let source = crate::store::instrument_list::Source::parse(&provider)
        .ok_or("Indices come from Zerodha's or Dhan's instrument list.")?;
    let mut conn = lock(&db)?;
    let made = crate::store::index_catalog::create(&mut conn, source)?;
    watchlist_detail(&conn, made.id)
}

/// A symbol's drawings document, or `None` when the app has never stored one for it.
#[tauri::command]
pub fn get_symbol_drawings(symbol: String, db: State<Database>) -> Result<Option<String>, String> {
    crate::store::symbol_drawings::get(&*lock(&db)?, &symbol)
}

/// Stores a symbol's drawings, and tells every window, so its other charts of the symbol follow.
#[tauri::command]
pub fn save_symbol_drawings(
    symbol: String,
    doc_json: String,
    source: String,
    app: tauri::AppHandle,
    db: State<Database>,
) -> Result<(), String> {
    crate::store::symbol_drawings::save(&*lock(&db)?, &symbol, &doc_json)?;
    use tauri::Emitter;
    let _ = app.emit(
        "symbol-drawings-changed",
        serde_json::json!({ "symbol": symbol, "source": source }),
    );
    Ok(())
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
    real_list(id)?;
    sql(watchlists::rename(&*lock(&db)?, id, name))
}

#[tauri::command]
pub fn delete_watchlist(id: i64, db: State<Database>) -> Result<(), String> {
    real_list(id)?;
    sql(watchlists::delete(&*lock(&db)?, id))
}

/// Adds symbols to a list. Adding to a colour's list flags them with that colour.
#[tauri::command]
pub fn add_watchlist_items(
    watchlist_id: i64,
    items: Vec<NewWatchlistItem>,
    db: State<Database>,
) -> Result<WatchlistDetail, String> {
    let mut conn = lock(&db)?;
    let added = match watchlists::flag_of_list(watchlist_id) {
        Some(flag) => {
            let before = sql(watchlists::flag_list(&conn, flag))?;
            let now = crate::db::now_ms();
            let mut added = 0;
            for item in &items {
                if !before.items.iter().any(|i| i.symbol == item.symbol) {
                    sql(watchlists::set_symbol_flag(&conn, &item.symbol, Some(flag), now))?;
                    added += 1;
                }
            }
            added
        }
        None => sql(watchlists::add_items(&mut conn, watchlist_id, &items))?,
    };
    let mut detail = watchlist_detail(&conn, watchlist_id)?;
    detail.added = Some(added);
    Ok(detail)
}

/// Removes symbols from a list. Removing from a colour's list clears their flag.
#[tauri::command]
pub fn remove_watchlist_items(watchlist_id: i64, symbols: Vec<String>, db: State<Database>) -> Result<(), String> {
    let mut conn = lock(&db)?;
    if let Some(flag) = watchlists::flag_of_list(watchlist_id) {
        let listed = sql(watchlists::flag_list(&conn, flag))?;
        for symbol in symbols.iter().filter(|s| listed.items.iter().any(|i| &i.symbol == *s)) {
            sql(watchlists::set_symbol_flag(&conn, symbol, None, 0))?;
        }
        return Ok(());
    }
    sql(watchlists::remove_items(&mut conn, watchlist_id, &symbols))
}

/// Puts a list's rows (symbols and section headings) in the given order; see `watchlists::write_order`
/// for what a partial or stale order does. Returns the list as it now stands.
#[tauri::command]
pub fn set_watchlist_order(
    watchlist_id: i64,
    order: Vec<RowRef>,
    db: State<Database>,
) -> Result<WatchlistDetail, String> {
    real_list(watchlist_id)?;
    let mut conn = lock(&db)?;
    sql(watchlists::set_order(&mut conn, watchlist_id, &order))?;
    watchlist_detail(&conn, watchlist_id)
}

/// Adds a section heading before `before`, or at the end of the list when that is `None`.
#[tauri::command]
pub fn add_watchlist_section(
    watchlist_id: i64,
    name: String,
    before: Option<RowRef>,
    db: State<Database>,
) -> Result<WatchlistDetail, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a section needs a name".to_string());
    }
    real_list(watchlist_id)?;
    let mut conn = lock(&db)?;
    sql(watchlists::add_section(&mut conn, watchlist_id, name, before))?;
    watchlist_detail(&conn, watchlist_id)
}

#[tauri::command]
pub fn rename_watchlist_section(id: i64, name: String, db: State<Database>) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a section needs a name".to_string());
    }
    sql(watchlists::rename_section(&*lock(&db)?, id, name))
}

/// Removes a section heading; its symbols stay on the list.
#[tauri::command]
pub fn delete_watchlist_section(id: i64, db: State<Database>) -> Result<(), String> {
    sql(watchlists::delete_section(&*lock(&db)?, id))
}

#[tauri::command]
pub fn set_watchlist_section_collapsed(id: i64, collapsed: bool, db: State<Database>) -> Result<(), String> {
    sql(watchlists::set_section_collapsed(&*lock(&db)?, id, collapsed))
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
