//! Tauri commands for Zerodha. Like `provider_commands.rs` they are thin: lock the database, call
//! into `providers` / `zerodha`, and flatten errors to user-readable strings.

use std::collections::HashMap;
use std::sync::MutexGuard;

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::db::{now_ms, Database};
use crate::market::ist_date;
use crate::models::{BarsResponse, Quote, SymbolMatch};
use crate::provider_commands::TestResult;
use crate::providers;
use crate::secrets::Secrets;
use crate::store::bars_cache;
use crate::store::provider_settings::{self as settings, Table};
use crate::store::research_bars::canonical_interval;
use crate::zerodha::callback;
use crate::zerodha::client::{Credentials, ZerodhaClient};
use crate::zerodha::feed::{Feed, StatusEvent};
use crate::zerodha::instruments::{self, Instrument};
use crate::zerodha::protocol::{
    extract_request_token, login_url, token_expiry_estimate_secs, Interval, ZerodhaError, ZerodhaErrorKind,
    IST_OFFSET_SECS,
};

pub const ZERODHA: &str = "zerodha";
const INSTRUMENTS_UPDATED_KEY: &str = "instrumentsUpdatedAt";
/// When the access token was last saved: Kite gives it no expiry, so this is
/// what "expires around 6 AM" is worked out from.
pub const TOKEN_SAVED_KEY: &str = "accessTokenSavedAt";
/// Refresh the instrument list when it's older than this (new listings, expiries).
pub(crate) const INSTRUMENTS_MAX_AGE_MS: i64 = 7 * 86_400_000;

fn lock(db: &Database) -> Result<MutexGuard<'_, Connection>, String> {
    db.conn.lock().map_err(|e| e.to_string())
}

fn sql<T>(result: rusqlite::Result<T>) -> Result<T, String> {
    result.map_err(|e| e.to_string())
}

/// Zerodha's credentials, or the "isn't set up" error if it is off or incomplete.
pub fn zerodha_credentials(conn: &Connection, secrets: &Secrets) -> Result<Credentials, ZerodhaError> {
    let usable =
        providers::is_usable(conn, secrets, ZERODHA).map_err(|e| ZerodhaError::new(ZerodhaErrorKind::Other, e))?;
    if !usable {
        return Err(ZerodhaError::not_configured());
    }
    credentials_ignoring_enabled(conn, secrets).ok_or_else(ZerodhaError::not_configured)
}

/// The key and token as saved, whether or not Zerodha is switched on — so the
/// test button and the login work before it is.
fn credentials_ignoring_enabled(conn: &Connection, secrets: &Secrets) -> Option<Credentials> {
    let get = |key: &str| {
        providers::credential(conn, secrets, ZERODHA, key)
            .ok()
            .flatten()
            .filter(|v| !v.is_empty())
    };
    Some(Credentials {
        api_key: get("apiKey")?,
        access_token: get("accessToken")?,
    })
}

/// Records that a new access token was saved just now.
pub fn note_token_saved(conn: &Connection) -> rusqlite::Result<()> {
    settings::set(conn, Table::Settings, ZERODHA, TOKEN_SAVED_KEY, &now_ms().to_string())
}

fn token_saved_at(conn: &Connection) -> Option<i64> {
    settings::get(conn, Table::Settings, ZERODHA, TOKEN_SAVED_KEY)
        .ok()
        .flatten()
        .and_then(|v| v.parse().ok())
}

// ---- Status, login, instruments ---------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZerodhaStatus {
    pub instrument_count: i64,
    /// Epoch milliseconds of the last instrument-list download.
    pub instruments_updated_at: Option<i64>,
    /// Epoch milliseconds when the current access token was saved.
    pub token_saved_at: Option<i64>,
    /// Epoch seconds when it most likely stops working (the next 06:00 IST).
    pub token_expires_at: Option<i64>,
    pub feed: StatusEvent,
}

#[tauri::command(async)]
pub fn zerodha_status(
    db: State<Database>,
    secrets: State<Secrets>,
    feed: State<Feed>,
) -> Result<ZerodhaStatus, String> {
    let conn = lock(&db)?;
    let updated = sql(settings::get(&conn, Table::Settings, ZERODHA, INSTRUMENTS_UPDATED_KEY))?
        .and_then(|v| v.parse::<i64>().ok());
    let has_token = sql(providers::credential(&conn, &secrets, ZERODHA, "accessToken"))?.is_some_and(|t| !t.is_empty());
    let saved = has_token.then(|| token_saved_at(&conn)).flatten();
    Ok(ZerodhaStatus {
        instrument_count: sql(instruments::count(&conn))?,
        instruments_updated_at: updated,
        token_saved_at: saved,
        token_expires_at: saved.map(token_expiry_estimate_secs),
        feed: feed.status(),
    })
}

/// The address of Zerodha's login page for the saved API key.
#[tauri::command(async)]
pub fn zerodha_login_url(db: State<Database>) -> Result<String, String> {
    let key = sql(settings::get(&*lock(&db)?, Table::Settings, ZERODHA, "apiKey"))?
        .filter(|k| !k.trim().is_empty())
        .ok_or("Enter and save your API key first.")?;
    Ok(login_url(key.trim()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    pub token_expires_at: i64,
}

/// The URL the user registers as their Kite app's redirect URL, so the app can
/// catch the login itself.
#[tauri::command]
pub fn zerodha_redirect_url() -> String {
    callback::redirect_url()
}

/// The whole login, without copy-and-paste: opens Zerodha's page in the
/// browser, catches the redirect it comes back to, and saves the access token.
/// Only works when the Kite app's redirect URL is [`callback::redirect_url`];
/// `zerodha_complete_login` remains for anyone whose is something else.
#[tauri::command]
pub async fn zerodha_login_in_browser(
    app: AppHandle,
    db: State<'_, Database>,
    secrets: State<'_, Secrets>,
    client: State<'_, ZerodhaClient>,
    feed: State<'_, Feed>,
) -> Result<LoginResult, String> {
    let (api_key, api_secret) = login_credentials(&db, &secrets)?;
    // Listening starts before the browser does, so a fast login can't arrive
    // before there is anything to catch it.
    let listener = callback::listen().await?;
    app.opener()
        .open_url(login_url(&api_key), None::<&str>)
        .map_err(|e| format!("Couldn't open your browser: {e}"))?;
    let request_token = callback::wait_for_request_token(listener, callback::WAIT).await?;
    save_access_token(&api_key, &api_secret, &request_token, &db, &secrets, &client, &feed).await
}

/// Finishes a login: trades the `request_token` Zerodha sent the browser to
/// (pasted as the whole address or bare) for an access token, and saves it.
#[tauri::command]
pub async fn zerodha_complete_login(
    pasted: String,
    db: State<'_, Database>,
    secrets: State<'_, Secrets>,
    client: State<'_, ZerodhaClient>,
    feed: State<'_, Feed>,
) -> Result<LoginResult, String> {
    let request_token = extract_request_token(&pasted)?;
    let (api_key, api_secret) = login_credentials(&db, &secrets)?;
    save_access_token(&api_key, &api_secret, &request_token, &db, &secrets, &client, &feed).await
}

/// The API key and secret a login needs. The secret never leaves Rust: it is
/// only ever used here, to sign the token exchange.
fn login_credentials(db: &Database, secrets: &Secrets) -> Result<(String, String), String> {
    let conn = lock(db)?;
    let get = |key: &str| sql(providers::credential(&conn, secrets, ZERODHA, key)).map(|v| v.filter(|s| !s.is_empty()));
    Ok((
        get("apiKey")?.ok_or("Enter and save your API key first.")?,
        get("apiSecret")?.ok_or("Enter and save your API secret first — it is needed to log in from here.")?,
    ))
}

/// Trades a one-time request token for the day's access token and saves it.
async fn save_access_token(
    api_key: &str,
    api_secret: &str,
    request_token: &str,
    db: &Database,
    secrets: &Secrets,
    client: &ZerodhaClient,
    feed: &Feed,
) -> Result<LoginResult, String> {
    let access_token = client
        .exchange_token(api_key, api_secret, request_token)
        .await
        .map_err(|e| login_error(&e))?;
    {
        let conn = lock(db)?;
        sql(secrets.set(&conn, ZERODHA, "accessToken", &access_token))?;
        sql(note_token_saved(&conn))?;
    }
    feed.reconnect();
    Ok(LoginResult {
        token_expires_at: token_expiry_estimate_secs(now_ms()),
    })
}

/// A failed token exchange usually means a wrong secret or a request token that
/// was already used or has expired (they last minutes, and work once).
fn login_error(e: &ZerodhaError) -> String {
    match e.kind {
        ZerodhaErrorKind::Token | ZerodhaErrorKind::BadRequest => format!(
            "Zerodha wouldn't accept that login ({}). Check the API secret, and log in again for a fresh request \
             token — each works once and only for a few minutes.",
            e.detail.trim().trim_end_matches('.')
        ),
        _ => e.message(),
    }
}

async fn update_instruments_inner(db: &Database, client: &ZerodhaClient) -> Result<i64, String> {
    let lists = client.download_instrument_master().await.map_err(|e| e.message())?;
    let today = ist_date(now_ms());
    // A few MB of CSV per exchange: parse off the async threads so the UI stays responsive.
    let items: Vec<Instrument> = tauri::async_runtime::spawn_blocking(move || {
        let mut all = Vec::new();
        for (exchange, bytes) in lists {
            match instruments::parse_master(bytes.as_slice(), &today) {
                Ok(mut items) => all.append(&mut items),
                // Losing one derivatives list shouldn't lose the rest.
                Err(e) if exchange != "NSE" => log::warn!("skipping Zerodha's {exchange} list: {e}"),
                Err(e) => return Err(e),
            }
        }
        Ok(all)
    })
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
        ZERODHA,
        INSTRUMENTS_UPDATED_KEY,
        &now_ms().to_string(),
    ))?;
    Ok(count)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentUpdate {
    pub count: i64,
    pub updated_at: i64,
}

#[tauri::command]
pub async fn zerodha_update_instruments(
    db: State<'_, Database>,
    client: State<'_, ZerodhaClient>,
) -> Result<InstrumentUpdate, String> {
    let count = update_instruments_inner(&db, &client).await?;
    Ok(InstrumentUpdate {
        count,
        updated_at: now_ms(),
    })
}

/// Refreshes the instrument list if it's missing or older than `max_age_ms`. Called when the app
/// starts and by the daily market-data update; failures are logged, not shown — the Data
/// providers dialog offers a manual update.
pub async fn refresh_instruments_if_stale(db: &Database, secrets: &Secrets, client: &ZerodhaClient, max_age_ms: i64) {
    let stale = {
        let Ok(conn) = db.conn.lock() else { return };
        if !providers::is_usable(&conn, secrets, ZERODHA).unwrap_or(false) {
            return;
        }
        let count = instruments::count(&conn).unwrap_or(0);
        let updated = settings::get(&conn, Table::Settings, ZERODHA, INSTRUMENTS_UPDATED_KEY)
            .ok()
            .flatten()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);
        count == 0 || now_ms() - updated > max_age_ms
    };
    if stale {
        match update_instruments_inner(db, client).await {
            Ok(n) => log::info!("Zerodha instrument list refreshed ({n} instruments)"),
            Err(e) => log::warn!("could not refresh the Zerodha instrument list: {e}"),
        }
    }
}

// ---- The connection test ----------------------------------------------------

fn describe_expiry(expiry_secs: i64, now_secs: i64) -> String {
    let delta = expiry_secs - now_secs;
    let (h, m) = (delta.abs() / 3600, (delta.abs() % 3600) / 60);
    if delta >= 0 {
        format!("The access token should work for another {h}h {m}m (Kite tokens reset around 6 AM).")
    } else {
        format!("The access token expired {h}h {m}m ago — log in again.")
    }
}

/// Checks the saved credentials against the real service: the token's age, the
/// instrument list, and an actual history request.
pub async fn test(db: &Database, secrets: &Secrets, client: &ZerodhaClient) -> Result<TestResult, String> {
    let mut details = Vec::new();
    let fail = |message: &str, details: Vec<String>| {
        Ok(TestResult {
            ok: false,
            message: message.to_string(),
            details,
        })
    };
    let (creds, saved) = {
        let conn = lock(db)?;
        if sql(providers::credential(&conn, secrets, ZERODHA, "apiKey"))?.is_none_or(|k| k.is_empty()) {
            return fail("Enter your Zerodha API key first.", details);
        }
        match credentials_ignoring_enabled(&conn, secrets) {
            Some(c) => (c, token_saved_at(&conn)),
            None => return fail("Log in first: there is no access token yet.", details),
        }
    };

    match saved {
        Some(at) => details.push(describe_expiry(token_expiry_estimate_secs(at), now_ms() / 1000)),
        None => details.push("When this token was issued isn't known, so its expiry can't be estimated.".into()),
    }

    // Symbol lookups need the instrument list; fetch it now if it's missing.
    let have = sql(instruments::count(&*lock(db)?))?;
    if have == 0 {
        let count = update_instruments_inner(db, client).await?;
        details.push(format!("Downloaded the instrument list ({count} instruments)."));
    } else {
        details.push(format!("Instrument list: {have} instruments."));
    }

    let probe = sql(instruments::resolve(&*lock(db)?, "NSE:RELIANCE"))?
        .ok_or_else(|| "The instrument list has no NSE:RELIANCE — try updating it.".to_string())?;
    let now = now_ms();
    match client
        .fetch_history(
            &creds,
            &probe,
            Interval::Day,
            Some(now - 14 * 86_400_000),
            Some(now),
            now,
        )
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
                message: "Connected to Zerodha.".into(),
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

// ---- Market data ------------------------------------------------------------

#[tauri::command(async)]
pub fn zerodha_search_instruments(
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
            "Zerodha has no instrument called '{ticker}'. Search for it, or update the instrument list in Data providers."
        )
    })
}

#[tauri::command]
pub async fn zerodha_fetch_bars(
    ticker: String,
    interval: String,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
    app: AppHandle,
    db: State<'_, Database>,
    client: State<'_, ZerodhaClient>,
) -> Result<BarsResponse, String> {
    let secrets = app.state::<Secrets>();
    let interval_kind =
        Interval::parse(&interval).ok_or_else(|| format!("Zerodha doesn't serve a '{interval}' interval"))?;
    let (creds, inst) = {
        let conn = lock(&db)?;
        let creds = zerodha_credentials(&conn, &secrets).map_err(|e| e.message())?;
        (creds, resolve_or_explain(&conn, &ticker)?)
    };

    let cache_key = format!("zerodha:{}", inst.ticker);
    let cache_interval = interval.to_uppercase();
    let response = |bars, from_cache| BarsResponse {
        bars,
        gmt_offset: IST_OFFSET_SECS,
        timezone: Some("Asia/Kolkata".into()),
        from_cache,
    };
    // Daily (and the weekly and monthly charts made from it) comes from the market-data store
    // when it holds the symbol; only what the store lacks is read from Kite.
    if let (true, Some(from)) = (canonical_interval(&interval).as_deref() == Some("D"), from_ms) {
        match crate::marketdata::chart_daily(&app, &cache_key, from, to_ms).await {
            Some(Ok(bars)) => return Ok(response(bars, false)),
            Some(Err((_, stored))) if !stored.is_empty() => return Ok(response(stored, true)),
            Some(Err((message, _))) => return Err(message),
            None => {}
        }
    }
    match client
        .fetch_history(&creds, &inst, interval_kind, from_ms, to_ms, now_ms())
        .await
    {
        Ok(bars) => {
            if !bars.is_empty() {
                if let Err(e) = bars_cache::put(&mut *lock(&db)?, &cache_key, &cache_interval, &bars) {
                    log::warn!("could not cache Zerodha bars for {}: {e}", inst.ticker);
                }
            }
            Ok(response(bars, false))
        }
        // Only a network failure falls back to the cache: a rejected token must
        // be fixed, not papered over with stale data.
        Err(e) if e.kind == ZerodhaErrorKind::Network => {
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
            Ok(response(cached, true))
        }
        Err(e) => Err(e.message()),
    }
}

#[tauri::command]
pub async fn zerodha_quotes(
    tickers: Vec<String>,
    db: State<'_, Database>,
    secrets: State<'_, Secrets>,
    client: State<'_, ZerodhaClient>,
) -> Result<Vec<Quote>, String> {
    let (creds, resolved) = {
        let conn = lock(&db)?;
        let creds = zerodha_credentials(&conn, &secrets).map_err(|e| e.message())?;
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
                    error: Some("unknown Zerodha instrument".into()),
                })
        })
        .collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZerodhaSubscription {
    pub token: i64,
    /// `NSE`, `MCX`, … — the frontend needs it to know when the session opens.
    pub exchange: String,
}

#[tauri::command(async)]
pub fn zerodha_subscribe(
    ticker: String,
    db: State<Database>,
    feed: State<Feed>,
) -> Result<ZerodhaSubscription, String> {
    let inst = resolve_or_explain(&*lock(&db)?, &ticker)?;
    feed.subscribe(inst.token);
    Ok(ZerodhaSubscription {
        token: inst.token,
        exchange: inst.exchange,
    })
}

#[tauri::command(async)]
pub fn zerodha_unsubscribe(ticker: String, db: State<Database>, feed: State<Feed>) -> Result<(), String> {
    if let Some(inst) = sql(instruments::resolve(&*lock(&db)?, &ticker))? {
        feed.unsubscribe(inst.token);
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
            "The access token should work for another 3h 5m (Kite tokens reset around 6 AM)."
        );
        assert_eq!(
            describe_expiry(1_000_000 - 2 * 3600, 1_000_000),
            "The access token expired 2h 0m ago — log in again."
        );
    }

    #[test]
    fn a_failed_login_exchange_tells_the_user_what_to_check() {
        let e = ZerodhaError::new(ZerodhaErrorKind::Token, "Token is invalid or has expired.");
        let message = login_error(&e);
        assert!(message.contains("Token is invalid or has expired"), "{message}");
        assert!(
            message.contains("API secret") && message.contains("fresh request token"),
            "{message}"
        );
        // Other failures keep their own wording.
        let net = ZerodhaError::new(ZerodhaErrorKind::Network, "timed out");
        assert_eq!(login_error(&net), "Couldn't reach Zerodha: timed out");
    }
}
