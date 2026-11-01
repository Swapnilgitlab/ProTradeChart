//! Commands for Indian market data, whichever broker serves `india:` symbols (`symbols::india_broker`).
//! Thin like the rest: they find the broker and hand the call to its own module, so the webview never
//! needs to know which broker answered. [`sync_market`] is the one place a change of broker (or of
//! the "Save prices on this computer" switch) is acted on.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::{now_ms, Database};
use crate::models::{BarsResponse, Quote, SymbolMatch};
use crate::prices::{self, SavedPrices};
use crate::pyapi::backend::{unreachable, AppBackend};
use crate::pyapi::data::{load_chart_bars, BarsRequest};
use crate::secrets::Secrets;
use crate::store::bar_memory::BarMemory;
use crate::store::preferences;
use crate::store::research_bars::canonical_interval;
use crate::symbols::{chosen_broker, india_broker, Broker, INDIA, SOURCE_PREF};
use crate::{fyers_commands, market, zerodha_commands};

/// Told to every window when another broker starts serving `india:` symbols, so open charts reload.
pub const SOURCE_CHANGED_EVENT: &str = "market-source-changed";

/// The broker serving `india:` when [`sync_market`] last looked, so a change is noticed.
#[derive(Default)]
pub struct Serving(Mutex<Option<Broker>>);

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

/// Picks the broker that serves `india:` symbols.
#[tauri::command(async)]
pub fn set_market_source(broker: String, app: AppHandle, db: State<Database>) -> Result<MarketSource, String> {
    let picked = Broker::parse(&broker).ok_or_else(|| format!("'{broker}' isn't a broker the app can use."))?;
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        preferences::set(&conn, SOURCE_PREF, picked.id()).map_err(|e| e.to_string())?;
    }
    sync_market(&app);
    source(&db, &app.state::<Secrets>())
}

/// Makes the saved prices and every window agree with which broker serves `india:` now and whether
/// prices are saved. Called after anything that can change either: a broker picked, set up,
/// switched on or off, forgotten or logged in to; saving switched on or off; and once at launch.
/// The prices held stay whichever broker serves: they are the market's, keyed by neutral symbols,
/// and `pyapi::data::load_bars` checks the new broker's copy against them as it fills in what is
/// new. A change of broker stops a market load (it paces itself for the old one), clears the old
/// one's quotes and tells every window, whose charts reload through the new one.
pub fn sync_market(app: &AppHandle) {
    let (broker, on) = {
        let db = app.state::<Database>();
        let Ok(conn) = db.conn.lock() else {
            return;
        };
        let Ok(broker) = india_broker(&conn, &app.state::<Secrets>()) else {
            return;
        };
        (broker, prices::saving(&conn))
    };
    let before = app
        .state::<Serving>()
        .0
        .lock()
        .ok()
        .and_then(|mut serving| serving.replace(broker));
    app.state::<SavedPrices>().sync(&app.state::<BarMemory>(), on);
    if before.is_some_and(|b| b != broker) {
        app.state::<crate::marketdata::MarketData>().stop();
        app.state::<crate::fyers::quotes::QuoteCache>().clear();
        log::info!("{} now serves Indian market data", broker.id());
        if let Ok(now) = source(&app.state::<Database>(), &app.state::<Secrets>()) {
            let _ = app.emit(SOURCE_CHANGED_EVENT, &now);
        }
    }
}

/// A chart's bars. `ticker` is the part after `india:`, as a chart holds it (`RELIANCE` reads as
/// `NSE:RELIANCE`). They come through the same coverage-aware reads the Python API uses
/// (`pyapi::data`), so what is held — in memory, or saved on this computer — is drawn and only what
/// it lacks is read from the broker. The newest bars of a running session are always read again, so
/// a live bar never builds on a stale one. When the broker can't be reached, what is held is drawn
/// instead (`fromCache`); a refused login is never papered over that way.
#[tauri::command]
pub async fn market_fetch_bars(
    ticker: String,
    interval: String,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
    app: AppHandle,
) -> Result<BarsResponse, String> {
    let broker = broker(&app)?;
    let interval = canonical_interval(&interval)
        .ok_or_else(|| format!("{} doesn't serve a '{interval}' interval", broker.label()))?;
    let symbol = {
        let db = app.state::<Database>();
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let ticker = match broker {
            Broker::Zerodha => zerodha_commands::resolve_or_explain(&conn, &ticker)?.ticker,
            Broker::Fyers => fyers_commands::resolve_or_explain(&conn, &ticker)?.ticker,
        };
        format!("{INDIA}:{ticker}")
    };
    let now = now_ms();
    let exchange = symbol.split(':').nth(1).unwrap_or("NSE");
    let fresh = to_ms.is_none() && market::is_trading(exchange, now);
    let request = BarsRequest {
        symbol: symbol.clone(),
        interval: interval.clone(),
        from_ms,
        to_ms,
        limit: None,
    };
    let memory = app.state::<BarMemory>();
    let response = |bars, from_cache| BarsResponse {
        bars,
        gmt_offset: market::IST_OFFSET_MS / 1000,
        timezone: Some("Asia/Kolkata".into()),
        from_cache,
    };
    match load_chart_bars(&memory, &AppBackend::new(app.clone()), &request, now, fresh).await {
        // The chart reads an empty answer as the start of history, so one that only stopped short
        // of what was asked (a broker answers an over-long span with its newest part) mustn't be one.
        Ok(data) if data.bars.is_empty() && data.limited_from_ms.is_some() => Err(format!(
            "{} didn't send that much history at once; scroll back again for more.",
            broker.label()
        )),
        Ok(data) => Ok(response(data.bars, false)),
        Err(e) if unreachable(&e) => {
            let held = memory.get(
                &symbol,
                &interval,
                from_ms.unwrap_or(i64::MIN),
                to_ms.unwrap_or(i64::MAX),
                None,
            );
            if held.is_empty() {
                Err(e.message)
            } else {
                Ok(response(held, true))
            }
        }
        Err(e) => Err(e.message),
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
