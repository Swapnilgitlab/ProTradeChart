//! Commands for Indian market data, whichever broker serves `india:` symbols (`symbols::india_broker`).
//! Thin like the rest: they find the broker and hand the call to its own module, so the webview never
//! needs to know which broker answered.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::Database;
use crate::models::{BarsResponse, Quote, SymbolMatch};
use crate::secrets::Secrets;
use crate::store::bar_memory::BarMemory;
use crate::store::preferences;
use crate::symbols::{chosen_broker, india_broker, Broker, INDIA, SOURCE_PREF};
use crate::{fyers_commands, zerodha_commands};

/// Told to every window when another broker starts serving `india:` symbols, so open charts reload.
pub const SOURCE_CHANGED_EVENT: &str = "market-source-changed";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSource {
    /// The broker serving `india:` symbols now.
    pub broker: &'static str,
    /// The one the user picked, if they did.
    pub chosen: Option<&'static str>,
}

fn source(db: &Database, secrets: &Secrets) -> Result<MarketSource, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    Ok(MarketSource {
        broker: india_broker(&conn, secrets).map_err(|e| e.to_string())?.id(),
        chosen: chosen_broker(&conn).map_err(|e| e.to_string())?.map(Broker::id),
    })
}

fn broker(app: &AppHandle) -> Result<Broker, String> {
    let db = app.state::<Database>();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    india_broker(&conn, &app.state::<Secrets>()).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn market_source(db: State<Database>, secrets: State<Secrets>) -> Result<MarketSource, String> {
    source(&db, &secrets)
}

/// Picks the broker that serves `india:` symbols. A different broker's bars are never stitched onto
/// the ones already held, so the session's memory of `india:` series is dropped.
#[tauri::command(async)]
pub fn set_market_source(
    broker: String,
    app: AppHandle,
    db: State<Database>,
    secrets: State<Secrets>,
    memory: State<BarMemory>,
) -> Result<MarketSource, String> {
    let picked = Broker::parse(&broker).ok_or_else(|| format!("'{broker}' isn't a broker the app can use."))?;
    let before = source(&db, &secrets)?.broker;
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        preferences::set(&conn, SOURCE_PREF, picked.id()).map_err(|e| e.to_string())?;
    }
    let now = source(&db, &secrets)?;
    if now.broker != before {
        // A load in progress reads from the old broker: stop it before dropping what it held.
        app.state::<crate::marketdata::MarketData>().stop();
        let dropped = memory.forget_provider(INDIA);
        app.state::<crate::fyers::quotes::QuoteCache>().clear();
        log::info!(
            "{} now serves Indian market data; {dropped} series from {before} dropped",
            now.broker
        );
        let _ = app.emit(SOURCE_CHANGED_EVENT, &now);
    }
    Ok(now)
}

/// The broker serving `india:` symbols now, by its id.
pub fn current_broker(app: &AppHandle) -> Option<&'static str> {
    source(&app.state::<Database>(), &app.state::<Secrets>())
        .ok()
        .map(|s| s.broker)
}

/// After anything that can change which broker serves `india:` without the user picking one (a
/// broker set up, switched on or off, or forgotten): if another broker serves it now, the session's
/// `india:` series are dropped and every window is told, as a pick does — two brokers' bars are
/// never mixed in one series.
pub fn after_broker_settings_changed(app: &AppHandle, before: Option<&'static str>) {
    let Ok(now) = source(&app.state::<Database>(), &app.state::<Secrets>()) else {
        return;
    };
    if before.is_some_and(|b| b != now.broker) {
        app.state::<crate::marketdata::MarketData>().stop();
        let dropped = app.state::<BarMemory>().forget_provider(INDIA);
        app.state::<crate::fyers::quotes::QuoteCache>().clear();
        log::info!(
            "{} now serves Indian market data; {dropped} held series dropped",
            now.broker
        );
        let _ = app.emit(SOURCE_CHANGED_EVENT, &now);
    }
}

/// `ticker` is the part after `india:`, as a chart holds it (`RELIANCE` reads as `NSE:RELIANCE`).
#[tauri::command]
pub async fn market_fetch_bars(
    ticker: String,
    interval: String,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
    app: AppHandle,
) -> Result<BarsResponse, String> {
    match broker(&app)? {
        Broker::Zerodha => zerodha_commands::fetch_bars(&app, &ticker, &interval, from_ms, to_ms).await,
        Broker::Fyers => fyers_commands::fetch_bars(&app, &ticker, &interval, from_ms, to_ms).await,
    }
}

/// One quote per ticker, in the order asked; a ticker the broker doesn't list says so.
#[tauri::command]
pub async fn market_quotes(tickers: Vec<String>, app: AppHandle) -> Result<Vec<Quote>, String> {
    match broker(&app)? {
        Broker::Zerodha => zerodha_commands::quotes(&app, &tickers).await,
        Broker::Fyers => fyers_commands::quotes(&app, &tickers).await,
    }
}

#[tauri::command(async)]
pub fn market_search_instruments(
    query: String,
    limit: Option<u32>,
    app: AppHandle,
) -> Result<Vec<SymbolMatch>, String> {
    let limit = limit.unwrap_or(8).clamp(1, 25) as usize;
    match broker(&app)? {
        Broker::Zerodha => zerodha_commands::search_instruments(&app.state::<Database>(), &query, limit),
        Broker::Fyers => fyers_commands::search_instruments(&app.state::<Database>(), &query, limit),
    }
}
