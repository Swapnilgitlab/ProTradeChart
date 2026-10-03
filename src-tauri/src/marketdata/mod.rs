//! The market-data store: five years of daily bars for every NSE stock and index, downloaded once
//! when the user asks and kept current by a daily update, so the Screener, Studies and Python
//! scripts read the whole market from disk instead of the broker.
//!
//! These are Rust jobs, not scripts: nothing here starts Python. The update runs by itself (once
//! per settled session, while the app is open) only after the user has started the download, and
//! always in the broker throttle's background lane, so a chart is never kept waiting by it. Its
//! first look is a couple of minutes after launch, never during startup.

pub mod job;
pub mod plan;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{now_ms, Database, ResearchDb};
use crate::pyapi::backend::AppBackend;
use crate::pyapi::ApiError;
use crate::secrets::Secrets;
use crate::store::instrument_list::{self, Filter, Source};
use crate::store::{market_symbols, preferences};
use crate::throttle::in_background;
use crate::zerodha::client::ZerodhaClient;
use crate::{providers, zerodha_commands};
use job::{Progress, Summary};

pub const PROGRESS_EVENT: &str = "market-data-progress";
pub const FINISHED_EVENT: &str = "market-data-finished";

const PREF_PROVIDER: &str = "marketData.provider";
const PREF_AUTO: &str = "marketData.auto";
const PREF_LAST_UPDATE: &str = "marketData.lastUpdate";
const PREF_LAST_FAILURE: &str = "marketData.lastFailure";
const PREF_LAST_ERROR: &str = "marketData.lastError";

const FIRST_LOOK: Duration = Duration::from_secs(120);
const LOOK_EVERY: Duration = Duration::from_secs(300);
/// More than any exchange lists, so the whole list comes back.
const LIST_ALL: usize = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Trigger {
    /// The user started (or resumed) the download.
    Download,
    /// "Update now".
    Update,
    /// The daily update, by itself.
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

/// The one job that may be running, and its stop switch.
#[derive(Default)]
pub struct MarketData {
    running: Mutex<Option<Running>>,
    cancel: AtomicBool,
}

impl MarketData {
    pub fn running(&self) -> Option<Running> {
        self.running.lock().ok().and_then(|r| r.clone())
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
}

fn pref(conn: &rusqlite::Connection, key: &str) -> Option<String> {
    preferences::get(conn, key).ok().flatten()
}

fn pref_ms(conn: &rusqlite::Connection, key: &str) -> Option<i64> {
    pref(conn, key).and_then(|v| v.parse().ok())
}

/// The provider whose history the store holds, once the download has been started.
pub fn store_provider(conn: &rusqlite::Connection) -> Option<String> {
    pref(conn, PREF_PROVIDER)
}

pub fn auto_enabled(conn: &rusqlite::Connection) -> bool {
    pref(conn, PREF_AUTO).as_deref() != Some("false")
}

pub fn set_auto(conn: &rusqlite::Connection, on: bool) -> rusqlite::Result<()> {
    preferences::set(conn, PREF_AUTO, if on { "true" } else { "false" })
}

pub struct Record {
    pub last_update: Option<i64>,
    pub last_failure: Option<i64>,
    pub last_error: Option<String>,
}

pub fn record(conn: &rusqlite::Connection) -> Record {
    Record {
        last_update: pref_ms(conn, PREF_LAST_UPDATE),
        last_failure: pref_ms(conn, PREF_LAST_FAILURE),
        last_error: pref(conn, PREF_LAST_ERROR).filter(|e| !e.is_empty()),
    }
}

/// The broker the history comes from: Zerodha, when it is set up.
fn pick_provider(conn: &rusqlite::Connection, secrets: &Secrets) -> Option<&'static str> {
    providers::is_usable(conn, secrets, "zerodha")
        .unwrap_or(false)
        .then_some("zerodha")
}

/// Starts a job unless one is running. The download picks (and remembers) the provider; the
/// updates use the remembered one.
pub fn start(app: &AppHandle, trigger: Trigger) -> Result<(), String> {
    let provider = {
        let db = app.state::<Database>();
        let secrets = app.state::<Secrets>();
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        match (trigger, store_provider(&conn)) {
            (Trigger::Download, None) => {
                let p = pick_provider(&conn, &secrets)
                    .ok_or("Connect Zerodha under Data providers first: the history comes from your broker.")?;
                preferences::set(&conn, PREF_PROVIDER, p).map_err(|e| e.to_string())?;
                p.to_string()
            }
            (_, Some(p)) => p,
            (_, None) => return Err("Download the market history first.".to_string()),
        }
    };

    let state = app.state::<MarketData>();
    {
        let mut running = state.running.lock().map_err(|e| e.to_string())?;
        if running.is_some() {
            return Err("The market data is already being updated.".to_string());
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
        let outcome = run_once(&app, &provider).await;
        remember(&app, &outcome, now_ms());
        match &outcome {
            Ok(s) => log::info!("market data updated: {s:?}"),
            Err(e) => log::warn!("market data update stopped: {}", e.message),
        }
        let state = app.state::<MarketData>();
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

/// A stop is neither a success nor a failure: it leaves the record as it was.
fn remember(app: &AppHandle, outcome: &Result<Summary, ApiError>, now: i64) {
    let db = app.state::<Database>();
    let Ok(conn) = db.conn.lock() else {
        return;
    };
    let written = match outcome {
        Ok(_) => preferences::set(&conn, PREF_LAST_UPDATE, &now.to_string())
            .and_then(|_| preferences::set(&conn, PREF_LAST_ERROR, "")),
        Err(e) if e.code == "cancelled" => Ok(()),
        Err(e) => preferences::set(&conn, PREF_LAST_FAILURE, &now.to_string())
            .and_then(|_| preferences::set(&conn, PREF_LAST_ERROR, &e.message)),
    };
    if let Err(e) = written {
        log::warn!("market data: couldn't record the update: {e}");
    }
}

async fn run_once(app: &AppHandle, provider: &str) -> Result<Summary, ApiError> {
    let db = app.state::<Database>();
    let secrets = app.state::<Secrets>();
    let client = app.state::<ZerodhaClient>();
    zerodha_commands::refresh_instruments_if_stale(&db, &secrets, &client, plan::INSTRUMENTS_MAX_AGE_MS).await;
    let listed = {
        let source = Source::parse(provider).ok_or_else(|| ApiError::bad_request("unknown provider"))?;
        let conn = db.conn.lock().map_err(|e| ApiError::internal(e.to_string()))?;
        let nse = |kind: &str| Filter {
            exchange: Some("NSE".to_string()),
            kind: Some(kind.to_string()),
            query: None,
        };
        let equities = instrument_list::list(&conn, source, &nse("EQUITY"), LIST_ALL)?;
        let indices = instrument_list::list(&conn, source, &nse("INDEX"), LIST_ALL)?;
        plan::universe(provider, &equities, &indices)
    };
    if listed.is_empty() {
        return Err(ApiError::new(
            409,
            "not_configured",
            "The broker's instrument list is empty: update it under Data providers.",
        ));
    }

    let research = app.state::<ResearchDb>();
    let state = app.state::<MarketData>();
    let backend = AppBackend::new(app.clone());
    let emitter = app.clone();
    let progress = move |p: Progress| {
        emitter.state::<MarketData>().set_progress(p);
        let _ = emitter.emit(PROGRESS_EVENT, p);
    };
    job::run(&research.write, &backend, &listed, now_ms(), &state.cancel, &progress).await
}

/// The daily update's loop. Only ever started once, in `lib.rs`.
pub fn start_engine(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_LOOK).await;
        loop {
            if due(&app) {
                if let Err(e) = start(&app, Trigger::Automatic) {
                    log::debug!("market data: automatic update not started: {e}");
                }
            }
            tokio::time::sleep(LOOK_EVERY).await;
        }
    });
}

fn due(app: &AppHandle) -> bool {
    if app.state::<MarketData>().running().is_some() {
        return false;
    }
    let db = app.state::<Database>();
    let Ok(conn) = db.conn.lock() else {
        return false;
    };
    if store_provider(&conn).is_none() || !auto_enabled(&conn) {
        return false;
    }
    let r = record(&conn);
    plan::due(now_ms(), r.last_update, r.last_failure)
}

/// A daily chart's bars, when the store holds the symbol: what it has, plus any stretch it lacks
/// (older history the chart scrolled back to, or the latest session) read from the broker and kept.
/// `None` for a symbol the store doesn't hold, which the chart fetches as it always has; `Some(Err)`
/// with the stored bars when the broker couldn't be reached, so the chart still draws (offline).
pub async fn chart_daily(
    app: &AppHandle,
    symbol: &str,
    from_ms: i64,
    to_ms: Option<i64>,
) -> Option<Result<Vec<crate::models::Bar>, (String, Vec<crate::models::Bar>)>> {
    use crate::pyapi::data::{load_bars, BarsRequest};
    use crate::store::research_bars;

    let research = app.state::<ResearchDb>();
    {
        let conn = research.write.conn.lock().ok()?;
        research_bars::coverage(&conn, symbol, "D").ok().flatten()?;
    }
    let request = BarsRequest {
        symbol: symbol.to_string(),
        interval: "D".to_string(),
        from_ms: Some(from_ms),
        to_ms,
        limit: None,
    };
    match load_bars(&research.write, &AppBackend::new(app.clone()), &request, now_ms()).await {
        Ok(data) => Some(Ok(data.bars)),
        Err(e) => {
            let stored =
                research.read.conn.lock().ok().and_then(|conn| {
                    research_bars::get(&conn, symbol, "D", from_ms, to_ms.unwrap_or(i64::MAX), None).ok()
                });
            Some(Err((e.message, stored.unwrap_or_default())))
        }
    }
}

/// What the store holds, for the status line.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Holdings {
    pub symbols: i64,
    pub series: i64,
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
}

pub fn holdings(conn: &rusqlite::Connection) -> rusqlite::Result<Holdings> {
    let symbols = market_symbols::list(conn)?.len() as i64;
    conn.query_row(
        "SELECT COUNT(*), MIN(c.from_ts), MAX(c.to_ts) FROM research_coverage c
         JOIN market_symbols m ON m.symbol = c.symbol WHERE c.interval = 'D'",
        [],
        |r| {
            Ok(Holdings {
                symbols,
                series: r.get(0)?,
                from_ms: r.get(1)?,
                to_ms: r.get(2)?,
            })
        },
    )
}
