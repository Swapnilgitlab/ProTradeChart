//! Tauri command layer: thin wrappers that lock the database, call into
//! `store` / `market`, and flatten errors to strings for the frontend.

use std::sync::MutexGuard;

use rusqlite::Connection;
use tauri::{AppHandle, Manager, State};

use crate::db::{now_ms, Database};
use crate::market::Market;
use crate::models::*;
use crate::store::{bars_cache, datasets, layouts, preferences, scripts, watchlists};
use crate::yahoo;

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

// ---- Market data (Yahoo Finance) -------------------------------------------

/// Bars for `symbol` at a Yahoo `interval` (`1m`…`1mo`). The requested window
/// is clamped to what Yahoo serves for that interval. If the network request
/// fails, whatever is in the local cache is returned instead (flagged
/// `from_cache`) so the chart still draws offline.
#[tauri::command]
pub async fn fetch_bars(
    symbol: String,
    interval: String,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
    db: State<'_, Database>,
    market: State<'_, Market>,
) -> Result<BarsResponse, String> {
    if yahoo::interval_limits(&interval).is_none() {
        return Err(format!("Yahoo Finance doesn't serve a '{interval}' interval"));
    }
    // A window entirely outside Yahoo's history for this interval is simply empty.
    let Some((period1, period2)) = yahoo::plan_window(&interval, from_ms, to_ms, now_ms()) else {
        return Ok(BarsResponse {
            bars: Vec::new(),
            gmt_offset: 0,
            timezone: None,
            from_cache: false,
        });
    };

    match market.fetch_chart(&symbol, &interval, period1, period2).await {
        Ok(data) => {
            log::debug!(
                "fetch_bars {symbol} {interval} requested {period1}..{period2} -> {} bars (first {:?}, last {:?})",
                data.bars.len(),
                data.bars.first().map(|b| b.time / 1000),
                data.bars.last().map(|b| b.time / 1000)
            );
            {
                let mut conn = lock(&db)?;
                if let Err(e) = bars_cache::put_meta(&conn, &symbol, data.gmt_offset, data.timezone.as_deref()) {
                    log::warn!("could not remember the timezone for {symbol}: {e}");
                }
                if let Err(e) = bars_cache::put(&mut conn, &symbol, &interval, &data.bars) {
                    log::warn!("could not cache bars for {symbol}: {e}");
                }
            }
            Ok(BarsResponse {
                bars: data.bars,
                gmt_offset: data.gmt_offset,
                timezone: data.timezone,
                from_cache: false,
            })
        }
        // Scrolling back past the start of a symbol's history asks for a window
        // with nothing in it. That's an answer (no older bars), not a failure to
        // report or to paper over with cached data.
        Err(fetch_error) if yahoo::is_window_without_data(&fetch_error) => Ok(BarsResponse {
            bars: Vec::new(),
            gmt_offset: 0,
            timezone: None,
            from_cache: false,
        }),
        Err(fetch_error) => {
            let conn = lock(&db)?;
            let cached = sql(bars_cache::get(&conn, &symbol, &interval, from_ms, to_ms, None))?;
            if cached.is_empty() {
                return Err(fetch_error);
            }
            let (gmt_offset, timezone) = sql(bars_cache::get_meta(&conn, &symbol))?.unwrap_or((0, None));
            log::info!(
                "serving {} cached {interval} bars for {symbol}: {fetch_error}",
                cached.len()
            );
            Ok(BarsResponse {
                bars: cached,
                gmt_offset,
                timezone,
                from_cache: true,
            })
        }
    }
}

#[tauri::command]
pub async fn search_symbols(
    query: String,
    limit: Option<u32>,
    market: State<'_, Market>,
) -> Result<Vec<SymbolMatch>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    market.search(query, limit.unwrap_or(8).clamp(1, 25)).await
}

#[tauri::command]
pub async fn fetch_quotes(symbols: Vec<String>, market: State<'_, Market>) -> Result<Vec<Quote>, String> {
    Ok(market.quotes(&symbols).await)
}
