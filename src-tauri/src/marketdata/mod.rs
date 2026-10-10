//! "Keep the market loaded": five years of daily bars for every NSE stock and index, read into
//! memory while the app is open and kept current by a daily update, so the Screener, Studies and
//! Python scripts read the whole market at once instead of a broker request per symbol.
//!
//! Nothing here is written to disk: broker price history lives in `store::bar_memory` and is gone
//! when the app closes (Kite Connect's terms restrict permanent copies of its data). The only
//! things kept are the user's choice to keep the market loaded and the list of symbols
//! (`market_symbols`, names, not prices).
//!
//! These are Rust jobs, not scripts: nothing here starts Python. Loading is opt-in. Once on, it
//! starts by itself a couple of minutes after launch (never during startup) and then once per
//! settled session while the app is open, always in the broker throttle's background lane, so a
//! chart is never kept waiting by it.

pub mod job;
pub mod plan;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{now_ms, Database};
use crate::pyapi::backend::AppBackend;
use crate::pyapi::ApiError;
use crate::secrets::Secrets;
use crate::store::bar_memory::BarMemory;
use crate::store::instrument_list::{self, Filter, Source};
use crate::store::{market_symbols, preferences, watchlists};
use crate::throttle::in_background;
use crate::zerodha::client::ZerodhaClient;
use crate::{providers, zerodha_commands};
use job::{Progress, Summary};

pub const PROGRESS_EVENT: &str = "market-data-progress";
pub const FINISHED_EVENT: &str = "market-data-finished";

/// "true" once the user has chosen to keep the market loaded.
pub const PREF_KEEP_LOADED: &str = "marketData.keepLoaded";

const FIRST_LOOK: Duration = Duration::from_secs(120);
const LOOK_EVERY: Duration = Duration::from_secs(300);
/// More than any exchange lists, so the whole list comes back.
const LIST_ALL: usize = 100_000;
/// The only broker the market is loaded from.
const PROVIDER: &str = "zerodha";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Trigger {
    /// The user pressed "Load now" or switched loading on.
    Load,
    /// The daily update (or the first load after launch), by itself.
    Automatic,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Running {
    pub trigger: Trigger,
    pub started_at: i64,
    pub progress: Option<Progress>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finished {
    pub trigger: Trigger,
    pub summary: Option<Summary>,
    pub error: Option<String>,
}

/// How this session's loads went. Kept in memory only, like the bars: after a relaunch nothing is
/// loaded, so the first look loads everything again.
#[derive(Debug, Clone, Default)]
pub struct Record {
    pub last_update: Option<i64>,
    pub last_failure: Option<i64>,
    pub last_error: Option<String>,
}

/// The one job that may be running, its stop switch, and this session's record.
#[derive(Default)]
pub struct MarketData {
    running: Mutex<Option<Running>>,
    cancel: AtomicBool,
    record: Mutex<Record>,
}

impl MarketData {
    pub fn running(&self) -> Option<Running> {
        self.running.lock().ok().and_then(|r| r.clone())
    }

    pub fn record(&self) -> Record {
        self.record.lock().map(|r| r.clone()).unwrap_or_default()
    }

    pub fn stop(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    fn set_progress(&self, progress: Progress) {
        if let Ok(mut running) = self.running.lock() {
            if let Some(r) = running.as_mut() {
                r.progress = Some(progress);
            }
        }
    }

    /// A stop is neither a success nor a failure: it leaves the record as it was.
    fn remember(&self, outcome: &Result<Summary, ApiError>, now: i64) {
        let Ok(mut record) = self.record.lock() else {
            return;
        };
        match outcome {
            Ok(_) => {
                record.last_update = Some(now);
                record.last_error = None;
            }
            Err(e) if e.code == "cancelled" => {}
            Err(e) => {
                record.last_failure = Some(now);
                record.last_error = Some(e.message.clone());
            }
        }
    }
}

pub fn keep_loaded(conn: &rusqlite::Connection) -> bool {
    preferences::get(conn, PREF_KEEP_LOADED).ok().flatten().as_deref() == Some("true")
}

pub fn set_keep_loaded(conn: &rusqlite::Connection, on: bool) -> rusqlite::Result<()> {
    preferences::set(conn, PREF_KEEP_LOADED, if on { "true" } else { "false" })
}

/// Starts a load unless one is running.
pub fn start(app: &AppHandle, trigger: Trigger) -> Result<(), String> {
    {
        let db = app.state::<Database>();
        let secrets = app.state::<Secrets>();
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        if !providers::is_usable(&conn, &secrets, PROVIDER).unwrap_or(false) {
            return Err("Connect Zerodha under Data providers first: the prices come from your broker.".to_string());
        }
    }

    let state = app.state::<MarketData>();
    {
        let mut running = state.running.lock().map_err(|e| e.to_string())?;
        if running.is_some() {
            return Err("The market is already being loaded.".to_string());
        }
        *running = Some(Running {
            trigger,
            started_at: now_ms(),
            progress: None,
        });
    }
    state.cancel.store(false, Ordering::SeqCst);

    let app = app.clone();
    tauri::async_runtime::spawn(in_background(async move {
        let outcome = run_once(&app).await;
        let state = app.state::<MarketData>();
        state.remember(&outcome, now_ms());
        match &outcome {
            Ok(s) => log::info!("market loaded: {s:?}"),
            Err(e) => log::warn!("market load stopped: {}", e.message),
        }
        if let Ok(mut running) = state.running.lock() {
            *running = None;
        }
        let (summary, error) = match outcome {
            Ok(s) => (Some(s), None),
            Err(e) => (None, Some(e.message)),
        };
        let _ = app.emit(
            FINISHED_EVENT,
            Finished {
                trigger,
                summary,
                error,
            },
        );
    }));
    Ok(())
}

async fn run_once(app: &AppHandle) -> Result<Summary, ApiError> {
    let db = app.state::<Database>();
    let secrets = app.state::<Secrets>();
    let client = app.state::<ZerodhaClient>();
    zerodha_commands::refresh_instruments_if_stale(&db, &secrets, &client, plan::INSTRUMENTS_MAX_AGE_MS).await;
    let (listed, first) = {
        let source = Source::parse(PROVIDER).ok_or_else(|| ApiError::bad_request("unknown provider"))?;
        let conn = db.conn.lock().map_err(|e| ApiError::internal(e.to_string()))?;
        let nse = |kind: &str| Filter {
            exchange: Some("NSE".to_string()),
            kind: Some(kind.to_string()),
            query: None,
        };
        let equities = instrument_list::list(&conn, source, &nse("EQUITY"), LIST_ALL)?;
        let indices = instrument_list::list(&conn, source, &nse("INDEX"), LIST_ALL)?;
        let first: Vec<String> = watchlists::members(&conn)?.into_iter().map(|(_, s)| s).collect();
        (plan::universe(PROVIDER, &equities, &indices), first)
    };
    if listed.is_empty() {
        return Err(ApiError::new(
            409,
            "not_configured",
            "The broker's instrument list is empty: update it under Data providers.",
        ));
    }

    let memory = app.state::<BarMemory>();
    let state = app.state::<MarketData>();
    let backend = AppBackend::new(app.clone());
    let emitter = app.clone();
    let progress = move |p: Progress| {
        emitter.state::<MarketData>().set_progress(p);
        let _ = emitter.emit(PROGRESS_EVENT, p);
    };
    job::run(
        &db,
        &memory,
        &backend,
        &listed,
        &first,
        now_ms(),
        &state.cancel,
        &progress,
    )
    .await
}

/// The daily update's loop. Only ever started once, in `lib.rs`.
pub fn start_engine(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_LOOK).await;
        loop {
            if due(&app) {
                if let Err(e) = start(&app, Trigger::Automatic) {
                    log::debug!("market data: automatic load not started: {e}");
                }
            }
            tokio::time::sleep(LOOK_EVERY).await;
        }
    });
}

fn due(app: &AppHandle) -> bool {
    let state = app.state::<MarketData>();
    if state.running().is_some() {
        return false;
    }
    let db = app.state::<Database>();
    let Ok(conn) = db.conn.lock() else {
        return false;
    };
    if !keep_loaded(&conn) {
        return false;
    }
    let r = state.record();
    plan::due(now_ms(), r.last_update, r.last_failure)
}

/// A daily chart's bars, when memory holds the symbol: what it has, plus any stretch it lacks
/// (older history the chart scrolled back to, or the latest session) read from the broker and kept
/// for the session. `None` for a symbol memory doesn't hold, which the chart fetches as it always
/// has; `Some(Err)` with the held bars when the broker couldn't be reached, so the chart still draws.
pub async fn chart_daily(
    app: &AppHandle,
    symbol: &str,
    from_ms: i64,
    to_ms: Option<i64>,
) -> Option<Result<Vec<crate::models::Bar>, (String, Vec<crate::models::Bar>)>> {
    use crate::pyapi::data::{load_bars, BarsRequest};

    let memory = app.state::<BarMemory>();
    memory.coverage(symbol, "D")?;
    let request = BarsRequest {
        symbol: symbol.to_string(),
        interval: "D".to_string(),
        from_ms: Some(from_ms),
        to_ms,
        limit: None,
    };
    match load_bars(&memory, &AppBackend::new(app.clone()), &request, now_ms()).await {
        Ok(data) => Some(Ok(data.bars)),
        Err(e) => Some(Err((
            e.message,
            memory.get(symbol, "D", from_ms, to_ms.unwrap_or(i64::MAX), None),
        ))),
    }
}

/// What is loaded, for the status line.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Holdings {
    /// The symbols the market is (as of its last listing).
    pub symbols: i64,
    /// How many of them are loaded.
    pub series: i64,
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
}

pub fn holdings(conn: &rusqlite::Connection, memory: &BarMemory) -> rusqlite::Result<Holdings> {
    let listed = market_symbols::list(conn)?;
    let span = memory.daily_span(listed.iter().map(|s| s.symbol.as_str()));
    Ok(Holdings {
        symbols: listed.len() as i64,
        series: span.series,
        from_ms: span.from_ms,
        to_ms: span.to_ms,
    })
}
