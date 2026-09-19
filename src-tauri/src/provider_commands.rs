//! Tauri commands for data-provider settings and for Dhan. Like `commands.rs`
//! these are thin: lock the database, call into `providers` / `dhan`, and
//! flatten errors to user-readable strings.

use std::collections::HashMap;
use std::sync::MutexGuard;

use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

use crate::db::{now_ms, Database};
use crate::dhan::client::{Credentials, DhanClient};
use crate::dhan::feed::{Feed, Key, StatusEvent};
use crate::dhan::instruments::{self, Instrument};
use crate::dhan::protocol::{ist_date, token_expiry_secs, DhanError, DhanErrorKind, Interval, IST_OFFSET_SECS};
use crate::models::{BarsResponse, ProviderInfo, Quote, SymbolMatch};
use crate::providers;
use crate::secrets::Secrets;
use crate::store::bars_cache;
use crate::store::provider_settings::{self as settings, Table};
use crate::zerodha::client::ZerodhaClient;
use crate::zerodha::feed::Feed as ZerodhaFeed;
use crate::zerodha_commands::{self, TOKEN_SAVED_KEY, ZERODHA};

const DHAN: &str = "dhan";
const INSTRUMENTS_UPDATED_KEY: &str = "instrumentsUpdatedAt";
/// Refresh the instrument list when it's older than this (new listings, expiries).
const INSTRUMENTS_MAX_AGE_MS: i64 = 7 * 86_400_000;

fn lock(db: &Database) -> Result<MutexGuard<'_, Connection>, String> {
    db.conn.lock().map_err(|e| e.to_string())
}

fn sql<T>(result: rusqlite::Result<T>) -> Result<T, String> {
    result.map_err(|e| e.to_string())
}

/// Dhan's credentials, or the "isn't set up" error if it is off or incomplete.
pub fn dhan_credentials(conn: &Connection, secrets: &Secrets) -> Result<Credentials, DhanError> {
    let usable = providers::is_usable(conn, secrets, DHAN).map_err(|e| DhanError::new(DhanErrorKind::Other, e))?;
    if !usable {
        return Err(DhanError::not_configured());
    }
    let get = |key: &str| {
        providers::credential(conn, secrets, DHAN, key)
            .ok()
            .flatten()
            .ok_or_else(DhanError::not_configured)
    };
    Ok(Credentials {
        client_id: get("clientId")?,
        access_token: get("accessToken")?,
    })
}

// ---- Provider settings -----------------------------------------------------

#[tauri::command]
pub fn list_providers(db: State<Database>, secrets: State<Secrets>) -> Result<Vec<ProviderInfo>, String> {
    sql(providers::describe(&*lock(&db)?, &secrets))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    /// Where a newly saved secret went: `keychain` or `database`.
    pub secret_storage: Option<String>,
}

#[tauri::command]
pub fn save_provider_config(
    provider: String,
    values: HashMap<String, String>,
    db: State<Database>,
    secrets: State<Secrets>,
    feed: State<Feed>,
    zerodha_feed: State<ZerodhaFeed>,
) -> Result<SaveResult, String> {
    let storage = providers::save_config(&*lock(&db)?, &secrets, &provider, &values)?;
    if provider == DHAN {
        feed.reconnect(); // a new token takes effect on the live connection too
    }
    if provider == ZERODHA {
        // Kite tokens carry no expiry, so remember when a pasted one arrived.
        if values.get("accessToken").is_some_and(|t| !t.trim().is_empty()) {
            sql(zerodha_commands::note_token_saved(&*lock(&db)?))?;
        }
        zerodha_feed.reconnect();
    }
    Ok(SaveResult {
        secret_storage: storage.map(|s| s.as_str().to_string()),
    })
}

#[tauri::command]
pub fn clear_provider_config(
    provider: String,
    db: State<Database>,
    secrets: State<Secrets>,
    feed: State<Feed>,
    zerodha_feed: State<ZerodhaFeed>,
) -> Result<(), String> {
    providers::clear_config(&*lock(&db)?, &secrets, &provider)?;
    if provider == DHAN {
        feed.reconnect();
    }
    if provider == ZERODHA {
        sql(settings::delete(
            &*lock(&db)?,
            Table::Settings,
            ZERODHA,
            TOKEN_SAVED_KEY,
        ))?;
        zerodha_feed.reconnect();
    }
    Ok(())
}

#[tauri::command]
pub fn set_provider_enabled(
    provider: String,
    enabled: bool,
    db: State<Database>,
    feed: State<Feed>,
    zerodha_feed: State<ZerodhaFeed>,
) -> Result<(), String> {
    providers::set_enabled(&*lock(&db)?, &provider, enabled)?;
    if provider == DHAN {
        feed.reconnect();
    }
    if provider == ZERODHA {
        zerodha_feed.reconnect();
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub message: String,
    pub details: Vec<String>,
}

fn describe_expiry(expiry_secs: i64, now_secs: i64) -> String {
    let delta = expiry_secs - now_secs;
    let (h, m) = (delta.abs() / 3600, (delta.abs() % 3600) / 60);
    if delta >= 0 {
        format!("The access token is valid for another {h}h {m}m.")
    } else {
        format!("The access token expired {h}h {m}m ago.")
    }
}

#[tauri::command]
pub async fn test_provider(
    provider: String,
    db: State<'_, Database>,
    secrets: State<'_, Secrets>,
    client: State<'_, DhanClient>,
    zerodha_client: State<'_, ZerodhaClient>,
) -> Result<TestResult, String> {
    if providers::spec(&provider).is_none() {
        return Err(format!("unknown data provider '{provider}'"));
    }
    if provider == ZERODHA {
        return zerodha_commands::test(&db, &secrets, &zerodha_client).await;
    }
    if provider != DHAN {
        return Ok(TestResult {
            ok: true,
            message: "Nothing to test — this provider needs no setup.".into(),
            details: vec![],
        });
    }

    let mut details = Vec::new();
    let creds = {
        let conn = lock(&db)?;
        match providers::credential(&conn, &secrets, DHAN, "clientId").map_err(|e| e.to_string())? {
            Some(_) => {}
            None => {
                return Ok(TestResult {
                    ok: false,
                    message: "Enter your Dhan client ID first.".into(),
                    details,
                })
            }
        }
        match dhan_credentials_ignoring_enabled(&conn, &secrets) {
            Some(c) => c,
            None => {
                return Ok(TestResult {
                    ok: false,
                    message: "Enter your Dhan access token first.".into(),
                    details,
                })
            }
        }
    };

    let now = now_ms();
    match token_expiry_secs(&creds.access_token) {
        Some(exp) => details.push(describe_expiry(exp, now / 1000)),
        None => details.push("The token's expiry couldn't be read (it may not be a standard token).".into()),
    }

    // Symbol lookups need the instrument list; fetch it now if it's missing.
    let have = sql(instruments::count(&*lock(&db)?))?;
    if have == 0 {
        let count = update_instruments_inner(&db, &client).await?;
        details.push(format!("Downloaded the instrument list ({count} instruments)."));
    } else {
        details.push(format!("Instrument list: {have} instruments."));
    }

    let probe = sql(instruments::resolve(&*lock(&db)?, "NSE:RELIANCE"))?
        .ok_or_else(|| "The instrument list has no NSE:RELIANCE — try updating it.".to_string())?;
    let from = now - 14 * 86_400_000;
    match client
        .fetch_history(&creds, &probe, Interval::Daily, Some(from), Some(now), now)
        .await
    {
        Ok(bars) => {
            let latest = bars.last().map(|b| ist_date(b.time)).unwrap_or_else(|| "none".into());
            details.push(format!(
                "Daily history works: {} bars for RELIANCE, latest {latest}.",
                bars.len()
            ));
            Ok(TestResult {
                ok: true,
                message: "Connected to Dhan.".into(),
                details,
            })
        }
        Err(e) => Ok(TestResult {
            ok: false,
            message: e.message(),
            details,
        }),
    }
}

/// The test button should work before the provider is switched on.
fn dhan_credentials_ignoring_enabled(conn: &Connection, secrets: &Secrets) -> Option<Credentials> {
    let get = |key: &str| {
        providers::credential(conn, secrets, DHAN, key)
            .ok()
            .flatten()
            .filter(|v| !v.is_empty())
    };
    Some(Credentials {
        client_id: get("clientId")?,
        access_token: get("accessToken")?,
    })
}

// ---- Dhan: status, instruments, token --------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DhanStatus {
    pub instrument_count: i64,
    /// Epoch milliseconds of the last instrument-list download.
    pub instruments_updated_at: Option<i64>,
    /// Epoch seconds from the token's own `exp` claim.
    pub token_expires_at: Option<i64>,
    pub feed: StatusEvent,
}

#[tauri::command]
pub fn dhan_status(db: State<Database>, secrets: State<Secrets>, feed: State<Feed>) -> Result<DhanStatus, String> {
    let conn = lock(&db)?;
    let updated =
        sql(settings::get(&conn, Table::Settings, DHAN, INSTRUMENTS_UPDATED_KEY))?.and_then(|v| v.parse::<i64>().ok());
    let token = sql(providers::credential(&conn, &secrets, DHAN, "accessToken"))?;
    Ok(DhanStatus {
        instrument_count: sql(instruments::count(&conn))?,
        instruments_updated_at: updated,
        token_expires_at: token.as_deref().and_then(token_expiry_secs),
        feed: feed.status(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentUpdate {
    pub count: i64,
    pub updated_at: i64,
}

async fn update_instruments_inner(db: &Database, client: &DhanClient) -> Result<i64, String> {
    let bytes = client.download_instrument_master().await.map_err(|e| e.message())?;
    let today = ist_date(now_ms());
    // ~26 MB of CSV: parse off the async threads so the UI stays responsive.
    let items: Vec<Instrument> =
        tauri::async_runtime::spawn_blocking(move || instruments::parse_master(bytes.as_slice(), &today))
            .await
            .map_err(|e| e.to_string())??;
    if items.is_empty() {
        return Err("The downloaded instrument list had no usable rows.".into());
    }
    let mut conn = lock(db)?;
    let count = sql(instruments::replace_all(&mut conn, &items))? as i64;
    sql(settings::set(
        &conn,
        Table::Settings,
        DHAN,
        INSTRUMENTS_UPDATED_KEY,
        &now_ms().to_string(),
    ))?;
    Ok(count)
}

#[tauri::command]
pub async fn dhan_update_instruments(
    db: State<'_, Database>,
    client: State<'_, DhanClient>,
) -> Result<InstrumentUpdate, String> {
    let count = update_instruments_inner(&db, &client).await?;
    Ok(InstrumentUpdate {
        count,
        updated_at: now_ms(),
    })
}

/// Refreshes the instrument list if it's missing or stale. Called when the
/// app starts and when Dhan is switched on; failures are logged, not shown —
/// the Data providers dialog offers a manual update.
pub async fn refresh_instruments_if_stale(db: &Database, secrets: &Secrets, client: &DhanClient) {
    let stale = {
        let Ok(conn) = db.conn.lock() else { return };
        if !providers::is_usable(&conn, secrets, DHAN).unwrap_or(false) {
            return;
        }
        let count = instruments::count(&conn).unwrap_or(0);
        let updated = settings::get(&conn, Table::Settings, DHAN, INSTRUMENTS_UPDATED_KEY)
            .ok()
            .flatten()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);
        count == 0 || now_ms() - updated > INSTRUMENTS_MAX_AGE_MS
    };
    if stale {
        match update_instruments_inner(db, client).await {
            Ok(n) => log::info!("Dhan instrument list refreshed ({n} instruments)"),
            Err(e) => log::warn!("could not refresh the Dhan instrument list: {e}"),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenewResult {
    pub token_expires_at: Option<i64>,
}

#[tauri::command]
pub async fn dhan_renew_token(
    db: State<'_, Database>,
    secrets: State<'_, Secrets>,
    client: State<'_, DhanClient>,
    feed: State<'_, Feed>,
) -> Result<RenewResult, String> {
    let creds = {
        let conn = lock(&db)?;
        dhan_credentials_ignoring_enabled(&conn, &secrets).ok_or("Enter your Dhan client ID and access token first.")?
    };
    let token = client.renew_token(&creds).await.map_err(|e| e.message())?;
    {
        let conn = lock(&db)?;
        sql(secrets.set(&conn, DHAN, "accessToken", &token))?;
    }
    feed.reconnect();
    Ok(RenewResult {
        token_expires_at: token_expiry_secs(&token),
    })
}

// ---- Dhan: market data ------------------------------------------------------

#[tauri::command]
pub fn dhan_search_instruments(
    query: String,
    limit: Option<u32>,
    db: State<Database>,
) -> Result<Vec<SymbolMatch>, String> {
    sql(instruments::search(
        &*lock(&db)?,
        &query,
        limit.unwrap_or(8).clamp(1, 25) as usize,
    ))
}

fn resolve_or_explain(conn: &Connection, ticker: &str) -> Result<Instrument, String> {
    sql(instruments::resolve(conn, ticker))?.ok_or_else(|| {
        format!(
            "Dhan has no instrument called '{ticker}'. Search for it, or update the instrument list in Data providers."
        )
    })
}

#[tauri::command]
pub async fn dhan_fetch_bars(
    ticker: String,
    interval: String,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
    db: State<'_, Database>,
    secrets: State<'_, Secrets>,
    client: State<'_, DhanClient>,
) -> Result<BarsResponse, String> {
    let interval_kind =
        Interval::parse(&interval).ok_or_else(|| format!("Dhan doesn't serve a '{interval}' interval"))?;
    let (creds, inst) = {
        let conn = lock(&db)?;
        let creds = dhan_credentials(&conn, &secrets).map_err(|e| e.message())?;
        (creds, resolve_or_explain(&conn, &ticker)?)
    };

    let cache_key = format!("dhan:{}", inst.ticker);
    let cache_interval = interval.to_uppercase();
    match client
        .fetch_history(&creds, &inst, interval_kind, from_ms, to_ms, now_ms())
        .await
    {
        Ok(bars) => {
            if !bars.is_empty() {
                if let Err(e) = bars_cache::put(&mut *lock(&db)?, &cache_key, &cache_interval, &bars) {
                    log::warn!("could not cache Dhan bars for {}: {e}", inst.ticker);
                }
            }
            Ok(BarsResponse {
                bars,
                gmt_offset: IST_OFFSET_SECS,
                timezone: Some("Asia/Kolkata".into()),
                from_cache: false,
            })
        }
        // Only a network failure falls back to the cache: a rejected token must
        // be fixed, not papered over with stale data.
        Err(e) if e.kind == DhanErrorKind::Network => {
            let cached = sql(bars_cache::get(
                &*lock(&db)?,
                &cache_key,
                &cache_interval,
                from_ms,
                to_ms,
                None,
            ))?;
            if cached.is_empty() {
                return Err(e.message());
            }
            Ok(BarsResponse {
                bars: cached,
                gmt_offset: IST_OFFSET_SECS,
                timezone: Some("Asia/Kolkata".into()),
                from_cache: true,
            })
        }
        Err(e) => Err(e.message()),
    }
}

#[tauri::command]
pub async fn dhan_quotes(
    tickers: Vec<String>,
    db: State<'_, Database>,
    secrets: State<'_, Secrets>,
    client: State<'_, DhanClient>,
) -> Result<Vec<Quote>, String> {
    let (creds, resolved) = {
        let conn = lock(&db)?;
        let creds = dhan_credentials(&conn, &secrets).map_err(|e| e.message())?;
        let resolved: Vec<(String, Option<Instrument>)> = tickers
            .iter()
            .map(|t| (t.clone(), instruments::resolve(&conn, t).ok().flatten()))
            .collect();
        (creds, resolved)
    };
    let known: Vec<Instrument> = resolved.iter().filter_map(|(_, i)| i.clone()).collect();
    let mut by_ticker: HashMap<String, Quote> = if known.is_empty() {
        HashMap::new()
    } else {
        client
            .quotes(&creds, &known)
            .await
            .map_err(|e| e.message())?
            .into_iter()
            .map(|q| (q.symbol.clone(), q))
            .collect()
    };
    // One quote per requested ticker, in order; an unknown ticker says so.
    Ok(resolved
        .into_iter()
        .map(|(asked, inst)| {
            inst.and_then(|i| by_ticker.remove(&i.ticker))
                .map(|mut q| {
                    q.symbol = asked.clone();
                    q
                })
                .unwrap_or(Quote {
                    symbol: asked,
                    price: None,
                    previous_close: None,
                    change_percent: None,
                    currency: None,
                    error: Some("unknown Dhan instrument".into()),
                })
        })
        .collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DhanSubscription {
    pub segment: u8,
    pub security_id: i64,
}

#[tauri::command]
pub fn dhan_subscribe(ticker: String, db: State<Database>, feed: State<Feed>) -> Result<DhanSubscription, String> {
    let inst = resolve_or_explain(&*lock(&db)?, &ticker)?;
    feed.subscribe(Key {
        segment: inst.segment,
        security_id: inst.security_id,
    });
    Ok(DhanSubscription {
        segment: inst.segment.code(),
        security_id: inst.security_id,
    })
}

#[tauri::command]
pub fn dhan_unsubscribe(ticker: String, db: State<Database>, feed: State<Feed>) -> Result<(), String> {
    if let Some(inst) = sql(instruments::resolve(&*lock(&db)?, &ticker))? {
        feed.unsubscribe(Key {
            segment: inst.segment,
            security_id: inst.security_id,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_expiry_is_described_in_hours_and_minutes() {
        assert_eq!(
            describe_expiry(1_000_000 + 3 * 3600 + 5 * 60, 1_000_000),
            "The access token is valid for another 3h 5m."
        );
        assert_eq!(
            describe_expiry(1_000_000 - 2 * 3600, 1_000_000),
            "The access token expired 2h 0m ago."
        );
    }
}
