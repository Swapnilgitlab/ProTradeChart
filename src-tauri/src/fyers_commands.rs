//! Tauri commands for FYERS, and the data calls `market_commands` and the Python API make while FYERS
//! serves `india:` symbols. Like `zerodha_commands.rs` they are thin: lock the database, call into
//! `providers` / `fyers`, and flatten errors to user-readable strings.
//!
//! Every data call goes through [`with_credentials`], which renews the day's token with the saved
//! refresh token and PIN when it is known to be stale, and once more when FYERS refuses it
//! (`fyers::session`). Nothing here logs a token or the PIN, and none of them is ever sent to the
//! webview.

use std::collections::HashMap;
use std::future::Future;
use std::sync::MutexGuard;

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::db::{now_ms, Database};
use crate::fyers::callback;
use crate::fyers::client::{Credentials, FyersClient};
use crate::fyers::instruments::{self, Instrument};
use crate::fyers::poller::{Poller, Status as PollStatus};
use crate::fyers::protocol::{
    extract_auth_code, login_url, plan_windows, token_expiry_estimate_secs, FyersError, FyersErrorKind, Interval, Plan,
};
use crate::fyers::session::{can_renew, should_renew, FyersSession};
use crate::market::ist_date;
use crate::models::{Bar, BarsResponse, DaySnapshot, Quote, SymbolMatch};
use crate::provider_commands::TestResult;
use crate::providers;
use crate::secrets::Secrets;
use crate::store::bar_memory::BarMemory;
use crate::store::provider_settings::{self as settings, Table};
use crate::store::research_bars::canonical_interval;
use crate::symbols::INDIA;

pub const FYERS: &str = "fyers";
const INSTRUMENTS_UPDATED_KEY: &str = "instrumentsUpdatedAt";
/// When the access token was last saved: FYERS gives it no expiry, so this is what "expires at
/// 6:30 AM" is worked out from.
pub const TOKEN_SAVED_KEY: &str = "accessTokenSavedAt";
/// When the refresh token was saved: it lasts about 15 days.
const REFRESH_SAVED_KEY: &str = "refreshTokenSavedAt";
/// `standard` or `prime`.
const PLAN_KEY: &str = "plan";
/// Secrets that aren't settings-form fields (the form's fields are all required): saved and deleted
/// through `Secrets` only.
const REFRESH_TOKEN: &str = "refreshToken";
const PIN: &str = "pin";
/// Refresh the symbol master when it's older than this (new listings, expiries).
pub(crate) const INSTRUMENTS_MAX_AGE_MS: i64 = 7 * 86_400_000;
/// Told to every window when the FYERS login changes (a login, a renewal, a refused renewal).
pub const SESSION_EVENT: &str = "fyers-session";
/// India Standard Time, the zone FYERS's market keeps.
const IST_OFFSET_SECS: i64 = 19_800;

fn lock(db: &Database) -> Result<MutexGuard<'_, Connection>, String> {
    db.conn.lock().map_err(|e| e.to_string())
}

fn sql<T>(result: rusqlite::Result<T>) -> Result<T, String> {
    result.map_err(|e| e.to_string())
}

fn other(e: impl ToString) -> FyersError {
    FyersError::new(FyersErrorKind::Other, e.to_string())
}

/// FYERS's credentials, or the "isn't set up" error if it is off or incomplete.
pub fn fyers_credentials(conn: &Connection, secrets: &Secrets) -> Result<Credentials, FyersError> {
    if !providers::is_usable(conn, secrets, FYERS).map_err(other)? {
        return Err(FyersError::not_configured());
    }
    credentials_ignoring_enabled(conn, secrets).ok_or_else(FyersError::not_configured)
}

/// The app ID and token as saved, whether or not FYERS is switched on — so the test button and the
/// login work before it is.
fn credentials_ignoring_enabled(conn: &Connection, secrets: &Secrets) -> Option<Credentials> {
    let get = |key: &str| {
        providers::credential(conn, secrets, FYERS, key)
            .ok()
            .flatten()
            .filter(|v| !v.is_empty())
    };
    Some(Credentials {
        app_id: get("appId")?.trim().to_string(),
        access_token: get("accessToken")?,
    })
}

fn setting_ms(conn: &Connection, key: &str) -> Option<i64> {
    settings::get(conn, Table::Settings, FYERS, key)
        .ok()
        .flatten()
        .and_then(|v| v.parse().ok())
}

/// Records that a new access token was saved just now.
pub fn note_token_saved(conn: &Connection) -> rusqlite::Result<()> {
    settings::set(conn, Table::Settings, FYERS, TOKEN_SAVED_KEY, &now_ms().to_string())
}

/// The plan the user said their account is on; Standard until they say otherwise.
pub fn saved_plan(conn: &Connection) -> Plan {
    settings::get(conn, Table::Settings, FYERS, PLAN_KEY)
        .ok()
        .flatten()
        .as_deref()
        .and_then(Plan::parse)
        .unwrap_or(Plan::Standard)
}

/// Forgets what FYERS keeps beside its settings form: the refresh token, the PIN, and the times and
/// plan. `providers::clear_config` has already forgotten the form's own fields.
pub fn forget_extras(conn: &Connection, secrets: &Secrets) -> rusqlite::Result<()> {
    secrets.delete(conn, FYERS, REFRESH_TOKEN)?;
    secrets.delete(conn, FYERS, PIN)?;
    for key in [TOKEN_SAVED_KEY, REFRESH_SAVED_KEY, INSTRUMENTS_UPDATED_KEY, PLAN_KEY] {
        settings::delete(conn, Table::Settings, FYERS, key)?;
    }
    Ok(())
}

// ---- The day's token: renewal ------------------------------------------------

struct Renewal {
    app_id: String,
    secret: String,
    refresh_token: String,
    pin: String,
}

fn renewal_inputs(conn: &Connection, secrets: &Secrets) -> rusqlite::Result<Option<Renewal>> {
    let secret = |key| secrets.get(conn, FYERS, key).map(|v| v.filter(|s| !s.is_empty()));
    let app_id = settings::get(conn, Table::Settings, FYERS, "appId")?.filter(|s| !s.trim().is_empty());
    Ok(
        match (app_id, secret("appSecret")?, secret(REFRESH_TOKEN)?, secret(PIN)?) {
            (Some(app_id), Some(secret), Some(refresh_token), Some(pin)) => Some(Renewal {
                app_id: app_id.trim().to_string(),
                secret,
                refresh_token,
                pin,
            }),
            _ => None,
        },
    )
}

/// Renews the day's token with the refresh token and PIN, one renewal at a time. `Ok(true)` when a
/// fresh token is saved (by this call, or by one that ran while this waited); `Ok(false)` when there
/// is nothing to renew with, or FYERS refused — then the refresh token is forgotten and the user is
/// asked to log in. A network failure is an error: nothing is forgotten over it.
async fn renew(app: &AppHandle) -> Result<bool, FyersError> {
    let db = app.state::<Database>();
    let secrets = app.state::<Secrets>();
    let session = app.state::<FyersSession>();
    let before = {
        let conn = lock(&db).map_err(other)?;
        setting_ms(&conn, TOKEN_SAVED_KEY)
    };
    let _one_at_a_time = session.gate.lock().await;
    let (inputs, saved_now, refresh_saved, has_pin) = {
        let conn = lock(&db).map_err(other)?;
        (
            renewal_inputs(&conn, &secrets).map_err(other)?,
            setting_ms(&conn, TOKEN_SAVED_KEY),
            setting_ms(&conn, REFRESH_SAVED_KEY),
            secrets.has(&conn, FYERS, PIN).map_err(other)?,
        )
    };
    if saved_now != before {
        return Ok(true); // renewed while this waited
    }
    let Some(r) = inputs.filter(|_| can_renew(refresh_saved, has_pin, now_ms())) else {
        return Ok(false);
    };
    let client = app.state::<FyersClient>();
    match client.refresh(&r.app_id, &r.secret, &r.refresh_token, &r.pin).await {
        Ok(fresh) => {
            {
                let conn = lock(&db).map_err(other)?;
                secrets
                    .set(&conn, FYERS, "accessToken", &fresh.access_token)
                    .map_err(other)?;
                note_token_saved(&conn).map_err(other)?;
                if let Some(refresh) = fresh.refresh_token.as_deref() {
                    secrets.set(&conn, FYERS, REFRESH_TOKEN, refresh).map_err(other)?;
                    settings::set(&conn, Table::Settings, FYERS, REFRESH_SAVED_KEY, &now_ms().to_string())
                        .map_err(other)?;
                }
            }
            if let Ok(mut error) = session.renewal_error.lock() {
                *error = None;
            }
            log::info!("FYERS token renewed with the saved refresh token");
            let _ = app.emit(SESSION_EVENT, ());
            Ok(true)
        }
        Err(e) if e.kind == FyersErrorKind::Network => Err(e),
        Err(e) => {
            log::warn!("FYERS refused to renew the token: {}", e.detail);
            {
                let conn = lock(&db).map_err(other)?;
                secrets.delete(&conn, FYERS, REFRESH_TOKEN).map_err(other)?;
                settings::delete(&conn, Table::Settings, FYERS, REFRESH_SAVED_KEY).map_err(other)?;
            }
            if let Ok(mut error) = session.renewal_error.lock() {
                *error = Some(format!(
                    "FYERS refused to renew the login with your PIN ({}). Log in again; renewing starts over from \
                     that login.",
                    e.detail.trim().trim_end_matches('.')
                ));
            }
            let _ = app.emit(SESSION_EVENT, ());
            Ok(false)
        }
    }
}

/// The day's credentials for a data call, renewed first when the token has been through a 06:30 reset
/// and a renewal can be tried.
async fn credentials(app: &AppHandle) -> Result<Credentials, FyersError> {
    let renew_first = {
        let db = app.state::<Database>();
        let secrets = app.state::<Secrets>();
        let conn = lock(&db).map_err(other)?;
        let has_pin = secrets.has(&conn, FYERS, PIN).map_err(other)?;
        should_renew(
            setting_ms(&conn, TOKEN_SAVED_KEY),
            setting_ms(&conn, REFRESH_SAVED_KEY),
            has_pin,
            now_ms(),
        )
    };
    if renew_first {
        // A renewal that fails leaves the old token, which FYERS then refuses with a clear message.
        if let Err(e) = renew(app).await {
            log::warn!("couldn't renew the FYERS token: {}", e.message());
        }
    }
    let db = app.state::<Database>();
    let conn = lock(&db).map_err(other)?;
    fyers_credentials(&conn, &app.state::<Secrets>())
}

/// Runs a data call with the day's credentials. A call refused for its token renews (when it can) and
/// is tried once more.
pub async fn with_credentials<T, F, Fut>(app: &AppHandle, call: F) -> Result<T, FyersError>
where
    F: Fn(Credentials) -> Fut,
    Fut: Future<Output = Result<T, FyersError>>,
{
    let creds = credentials(app).await?;
    match call(creds).await {
        Err(e) if e.kind == FyersErrorKind::Token => {
            if renew(app).await.unwrap_or(false) {
                let creds = {
                    let db = app.state::<Database>();
                    let conn = lock(&db).map_err(other)?;
                    fyers_credentials(&conn, &app.state::<Secrets>())?
                };
                call(creds).await
            } else {
                Err(e)
            }
        }
        other => other,
    }
}

// ---- Status, login, instruments -----------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FyersStatus {
    pub instrument_count: i64,
    /// Epoch milliseconds of the last symbol-master download.
    pub instruments_updated_at: Option<i64>,
    /// Epoch milliseconds when the current access token was saved.
    pub token_saved_at: Option<i64>,
    /// Epoch seconds when it most likely stops working (the next 06:30 IST).
    pub token_expires_at: Option<i64>,
    /// `standard` or `prime`.
    pub plan: &'static str,
    pub requests_today: u32,
    pub daily_limit: u32,
    /// Whether a PIN is saved for renewing the login (never the PIN itself).
    pub pin_saved: bool,
    /// When the refresh token was saved, if one is.
    pub refresh_saved_at: Option<i64>,
    /// Why the last renewal failed, if it did.
    pub renewal_error: Option<String>,
    /// What to register as the FYERS app's redirect URL.
    pub redirect_url: String,
    /// The live-chart poller's state.
    pub feed: PollStatus,
}

#[tauri::command(async)]
pub fn fyers_status(
    db: State<Database>,
    secrets: State<Secrets>,
    client: State<FyersClient>,
    session: State<FyersSession>,
    poller: State<Poller>,
) -> Result<FyersStatus, String> {
    let conn = lock(&db)?;
    let has_token = sql(providers::credential(&conn, &secrets, FYERS, "accessToken"))?.is_some_and(|t| !t.is_empty());
    let saved = has_token.then(|| setting_ms(&conn, TOKEN_SAVED_KEY)).flatten();
    let refresh_saved = sql(secrets.has(&conn, FYERS, REFRESH_TOKEN))?
        .then(|| setting_ms(&conn, REFRESH_SAVED_KEY))
        .flatten();
    let usage = client.usage(now_ms());
    Ok(FyersStatus {
        instrument_count: sql(instruments::count(&conn))?,
        instruments_updated_at: setting_ms(&conn, INSTRUMENTS_UPDATED_KEY),
        token_saved_at: saved,
        token_expires_at: saved.map(token_expiry_estimate_secs),
        plan: client.plan().id(),
        requests_today: usage.used,
        daily_limit: usage.limit,
        pin_saved: sql(secrets.has(&conn, FYERS, PIN))?,
        refresh_saved_at: refresh_saved,
        renewal_error: session.renewal_error.lock().ok().and_then(|e| e.clone()),
        redirect_url: callback::redirect_url(),
        feed: poller.status(),
    })
}

/// A fresh `state` for a login: 128 random bits, hex. The redirect must bring it back unchanged.
fn new_state() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| format!("the system has no secure random numbers: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn saved_app_id(db: &Database) -> Result<String, String> {
    sql(settings::get(&*lock(db)?, Table::Settings, FYERS, "appId"))?
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "Enter and save your FYERS app ID first.".to_string())
}

/// The address of FYERS's login page for the saved app ID, remembering its `state` so the address
/// the user pastes back can be checked against it.
#[tauri::command(async)]
pub fn fyers_login_url(db: State<Database>, session: State<FyersSession>) -> Result<String, String> {
    let app_id = saved_app_id(&db)?;
    let state = new_state()?;
    let url = login_url(&app_id, &callback::redirect_url(), &state);
    if let Ok(mut pending) = session.pending_state.lock() {
        *pending = Some(state);
    }
    Ok(url)
}

/// The URL the user registers as their FYERS app's redirect URL, so the app can catch the login itself.
#[tauri::command]
pub fn fyers_redirect_url() -> String {
    callback::redirect_url()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    pub token_expires_at: i64,
}

/// The whole login, without copy-and-paste: opens FYERS's page in the browser, catches the redirect
/// it comes back to, and saves the day's token (and the refresh token). Only works when the FYERS
/// app's redirect URL is [`callback::redirect_url`]; `fyers_complete_login` remains for anyone whose
/// is something else.
#[tauri::command]
pub async fn fyers_login_in_browser(app: AppHandle, session: State<'_, FyersSession>) -> Result<LoginResult, String> {
    let db = app.state::<Database>();
    let app_id = saved_app_id(&db)?;
    let state = new_state()?;
    if let Ok(mut pending) = session.pending_state.lock() {
        *pending = Some(state.clone());
    }
    // Listening starts before the browser does, so a fast login can't arrive before there is
    // anything to catch it.
    let listener = callback::listen().await?;
    app.opener()
        .open_url(login_url(&app_id, &callback::redirect_url(), &state), None::<&str>)
        .map_err(|e| format!("Couldn't open your browser: {e}"))?;
    let code = callback::wait_for_auth_code(listener, callback::WAIT, &state).await?;
    save_login(&app, &code).await
}

/// Finishes a login from what the user pasted: the address FYERS sent the browser to, or the auth
/// code alone. An address from a login started elsewhere (another `state`) is refused.
#[tauri::command]
pub async fn fyers_complete_login(
    pasted: String,
    app: AppHandle,
    session: State<'_, FyersSession>,
) -> Result<LoginResult, String> {
    let expected = session.pending_state.lock().ok().and_then(|s| s.clone());
    let code = extract_auth_code(&pasted, expected.as_deref())?;
    save_login(&app, &code).await
}

/// Trades a one-time auth code for the day's access token and a refresh token, and saves both.
async fn save_login(app: &AppHandle, code: &str) -> Result<LoginResult, String> {
    let db = app.state::<Database>();
    let secrets = app.state::<Secrets>();
    let (app_id, secret) = {
        let conn = lock(&db)?;
        let get =
            |key: &str| sql(providers::credential(&conn, &secrets, FYERS, key)).map(|v| v.filter(|s| !s.is_empty()));
        (
            get("appId")?.ok_or("Enter and save your FYERS app ID first.")?,
            get("appSecret")?.ok_or("Enter and save your FYERS secret ID first — it is needed to log in from here.")?,
        )
    };
    let session = app
        .state::<FyersClient>()
        .validate_authcode(&app_id, &secret, code)
        .await
        .map_err(|e| match e.kind {
            FyersErrorKind::Token | FyersErrorKind::BadRequest | FyersErrorKind::Other => format!(
                "FYERS wouldn't accept that login ({}). Check the app ID and secret ID, and log in again for a fresh \
                 auth code — each works once and only for a few minutes.",
                e.detail.trim().trim_end_matches('.')
            ),
            _ => e.message(),
        })?;
    {
        let conn = lock(&db)?;
        sql(secrets.set(&conn, FYERS, "accessToken", &session.access_token))?;
        sql(note_token_saved(&conn))?;
        if let Some(refresh) = session.refresh_token.as_deref() {
            sql(secrets.set(&conn, FYERS, REFRESH_TOKEN, refresh))?;
            sql(settings::set(
                &conn,
                Table::Settings,
                FYERS,
                REFRESH_SAVED_KEY,
                &now_ms().to_string(),
            ))?;
        }
    }
    let state = app.state::<FyersSession>();
    if let Ok(mut pending) = state.pending_state.lock() {
        *pending = None;
    }
    if let Ok(mut error) = state.renewal_error.lock() {
        *error = None;
    }
    let _ = app.emit(SESSION_EVENT, ());
    Ok(LoginResult {
        token_expires_at: token_expiry_estimate_secs(now_ms()),
    })
}

/// Saves the PIN used to renew the login (`""` forgets it). Write-only: it is never read back to the
/// webview, and only ever sent to FYERS's renewal call.
#[tauri::command(async)]
pub fn fyers_set_pin(pin: String, db: State<Database>, secrets: State<Secrets>) -> Result<(), String> {
    let pin = pin.trim();
    let conn = lock(&db)?;
    if pin.is_empty() {
        return sql(secrets.delete(&conn, FYERS, PIN));
    }
    if pin.len() != 4 || !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err("A FYERS PIN is four digits.".into());
    }
    sql(secrets.set(&conn, FYERS, PIN, pin)).map(|_| ())
}

/// Says which FYERS plan the account is on: it sets the pace of requests and the day's budget.
#[tauri::command(async)]
pub fn fyers_set_plan(plan: String, db: State<Database>, client: State<FyersClient>) -> Result<(), String> {
    let plan = Plan::parse(&plan).ok_or_else(|| format!("'{plan}' isn't a FYERS plan: standard or prime."))?;
    sql(settings::set(&*lock(&db)?, Table::Settings, FYERS, PLAN_KEY, plan.id()))?;
    client.set_plan(plan);
    Ok(())
}

async fn update_instruments_inner(db: &Database, client: &FyersClient) -> Result<i64, String> {
    let lists = client.download_symbol_master().await.map_err(|e| e.message())?;
    let today = ist_date(now_ms());
    // Tens of MB of CSV: parse off the async threads so the UI stays responsive.
    let items: Vec<Instrument> = tauri::async_runtime::spawn_blocking(move || {
        let mut all = Vec::new();
        for (name, bytes) in lists {
            match instruments::parse_master(bytes.as_slice(), &today) {
                Ok(mut items) => all.append(&mut items),
                // Losing one derivatives list shouldn't lose the rest.
                Err(e) if name != "NSE_CM" => log::warn!("skipping FYERS's {name} list: {e}"),
                Err(e) => return Err(e),
            }
        }
        Ok(all)
    })
    .await
    .map_err(|e| e.to_string())??;
    if items.is_empty() {
        return Err("The downloaded symbol master had no usable rows.".into());
    }
    let mut conn = lock(db)?;
    let count = sql(instruments::replace_all(&mut conn, &items))? as i64;
    sql(settings::set(
        &conn,
        Table::Settings,
        FYERS,
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
pub async fn fyers_update_instruments(
    db: State<'_, Database>,
    client: State<'_, FyersClient>,
) -> Result<InstrumentUpdate, String> {
    let count = update_instruments_inner(&db, &client).await?;
    Ok(InstrumentUpdate {
        count,
        updated_at: now_ms(),
    })
}

/// Refreshes the symbol master if it's missing or older than `max_age_ms`. Called when the app starts
/// and by the daily market-data update, only while FYERS is set up; failures are logged, not shown —
/// the Data providers dialog offers a manual update.
pub async fn refresh_instruments_if_stale(db: &Database, secrets: &Secrets, client: &FyersClient, max_age_ms: i64) {
    let stale = {
        let Ok(conn) = db.conn.lock() else { return };
        if !providers::is_usable(&conn, secrets, FYERS).unwrap_or(false) {
            return;
        }
        let count = instruments::count(&conn).unwrap_or(0);
        let updated = setting_ms(&conn, INSTRUMENTS_UPDATED_KEY).unwrap_or(0);
        count == 0 || now_ms() - updated > max_age_ms
    };
    if stale {
        match update_instruments_inner(db, client).await {
            Ok(n) => log::info!("FYERS symbol master refreshed ({n} instruments)"),
            Err(e) => log::warn!("could not refresh the FYERS symbol master: {e}"),
        }
    }
}

// ---- Market data (for `market_commands` and the Python API) ---------------------

fn resolve_or_explain(conn: &Connection, ticker: &str) -> Result<Instrument, String> {
    sql(instruments::resolve(conn, ticker))?.ok_or_else(|| {
        format!("FYERS has no instrument called '{ticker}'. Search for it, or update the instrument list in Data providers.")
    })
}

pub fn search_instruments(db: &Database, query: &str, limit: usize) -> Result<Vec<SymbolMatch>, String> {
    sql(instruments::search(&*lock(db)?, query, limit))
}

/// History for one instrument, and where it really began: a span longer than [`plan_windows`] covers
/// is answered with only its newest part.
pub async fn fetch_history(
    app: &AppHandle,
    inst: &Instrument,
    interval: Interval,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
) -> Result<(Vec<Bar>, i64), FyersError> {
    let client = app.state::<FyersClient>();
    let client = client.inner();
    let now = now_ms();
    let began = plan_windows(interval, from_ms, to_ms, now)
        .first()
        .map_or(from_ms.unwrap_or(now), |w| w.from_ms.max(from_ms.unwrap_or(i64::MIN)));
    let bars = with_credentials(app, |creds| async move {
        client.fetch_history(&creds, inst, interval, from_ms, to_ms, now).await
    })
    .await?;
    Ok((bars, began))
}

/// A chart's bars, as `market_fetch_bars` answers while FYERS serves `india:` symbols — the same way
/// Zerodha's are: daily from memory when the market is loaded, the rest from FYERS, and memory again
/// (never the disk) when the network drops.
pub async fn fetch_bars(
    app: &AppHandle,
    ticker: &str,
    interval: &str,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
) -> Result<BarsResponse, String> {
    let interval_kind =
        Interval::parse(interval).ok_or_else(|| format!("FYERS doesn't serve a '{interval}' interval"))?;
    let inst = resolve_or_explain(&*lock(&app.state::<Database>())?, ticker)?;
    let cache_key = format!("{INDIA}:{}", inst.ticker);
    let cache_interval = canonical_interval(interval);
    let memory = app.state::<BarMemory>();
    let response = |bars, from_cache| BarsResponse {
        bars,
        gmt_offset: IST_OFFSET_SECS,
        timezone: Some("Asia/Kolkata".into()),
        from_cache,
    };
    if let (true, Some(from)) = (cache_interval.as_deref() == Some("D"), from_ms) {
        match crate::marketdata::chart_daily(app, &cache_key, from, to_ms).await {
            Some(Ok(bars)) => return Ok(response(bars, false)),
            Some(Err((_, stored))) if !stored.is_empty() => return Ok(response(stored, true)),
            Some(Err((message, _))) => return Err(message),
            None => {}
        }
    }
    match fetch_history(app, &inst, interval_kind, from_ms, to_ms).await {
        Ok((bars, _)) => {
            if let Some(interval) = cache_interval.as_deref().filter(|_| !bars.is_empty()) {
                // Daily bars sit on IST midnight in memory, as the Python API stores them.
                let mut kept = bars.clone();
                if interval == "D" {
                    crate::pyapi::data::normalise_daily(&mut kept);
                }
                memory.put(&cache_key, interval, &kept);
            }
            Ok(response(bars, false))
        }
        Err(e) if e.kind == FyersErrorKind::Network => {
            let cached = cache_interval.as_deref().map_or_else(Vec::new, |interval| {
                memory.get(
                    &cache_key,
                    interval,
                    from_ms.unwrap_or(i64::MIN),
                    to_ms.unwrap_or(i64::MAX),
                    None,
                )
            });
            if cached.is_empty() {
                return Err(e.message());
            }
            Ok(response(cached, true))
        }
        Err(e) => Err(e.message()),
    }
}

/// The instruments behind `tickers`, in order; `None` for one FYERS doesn't list.
fn resolve_all(db: &Database, tickers: &[String]) -> Result<Vec<Option<Instrument>>, FyersError> {
    let conn = lock(db).map_err(other)?;
    tickers
        .iter()
        .map(|t| instruments::resolve(&conn, t).map_err(other))
        .collect()
}

/// One quote per ticker, in order; an unknown ticker says so.
pub async fn quotes(app: &AppHandle, tickers: &[String]) -> Result<Vec<Quote>, String> {
    let resolved = resolve_all(&app.state::<Database>(), tickers).map_err(|e| e.message())?;
    let known: Vec<Instrument> = resolved.iter().flatten().cloned().collect();
    let mut by_ticker: HashMap<String, Quote> = if known.is_empty() {
        HashMap::new()
    } else {
        crate::fyers::quotes::cached_quotes(app, &known)
            .await
            .map_err(|e| e.message())?
            .into_iter()
            .map(|q| (q.symbol.clone(), q))
            .collect()
    };
    Ok(tickers
        .iter()
        .zip(resolved)
        .map(|(asked, inst)| {
            inst.and_then(|i| by_ticker.remove(&i.ticker))
                .map(|mut q| {
                    q.symbol = asked.clone();
                    q
                })
                .unwrap_or(Quote {
                    symbol: asked.clone(),
                    price: None,
                    previous_close: None,
                    change_percent: None,
                    currency: None,
                    error: Some("unknown FYERS instrument".into()),
                })
        })
        .collect())
}

/// Day snapshots for the quote top-up and the Screener's pre-filter, in order; `None` for a ticker
/// FYERS doesn't list or had nothing for.
pub async fn day_snapshots(app: &AppHandle, tickers: &[String]) -> Result<Vec<Option<DaySnapshot>>, FyersError> {
    let resolved = resolve_all(&app.state::<Database>(), tickers)?;
    let (idx, known): (Vec<usize>, Vec<Instrument>) = resolved
        .into_iter()
        .enumerate()
        .filter_map(|(i, inst)| inst.map(|inst| (i, inst)))
        .unzip();
    let mut out = vec![None; tickers.len()];
    if known.is_empty() {
        return Ok(out);
    }
    let client = app.state::<FyersClient>();
    let client = client.inner();
    let known = &known;
    let snaps = with_credentials(app, |creds| async move { client.day_snapshots(&creds, known).await }).await?;
    for (i, snap) in idx.into_iter().zip(snaps) {
        out[i] = snap;
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FyersSubscription {
    /// The app's ticker, which the webview keys this chart's ticks by.
    pub ticker: String,
    /// `NSE`, `MCX`, … — the webview needs it to know when the session opens.
    pub exchange: String,
}

/// Starts (or joins) polling `ticker`'s quote for a live chart.
#[tauri::command(async)]
pub fn fyers_subscribe(
    ticker: String,
    db: State<Database>,
    poller: State<Poller>,
) -> Result<FyersSubscription, String> {
    let inst = resolve_or_explain(&*lock(&db)?, &ticker)?;
    let subscription = FyersSubscription {
        ticker: inst.ticker.clone(),
        exchange: inst.exchange.clone(),
    };
    poller.subscribe(inst);
    Ok(subscription)
}

#[tauri::command(async)]
pub fn fyers_unsubscribe(ticker: String, db: State<Database>, poller: State<Poller>) -> Result<(), String> {
    if let Some(inst) = sql(instruments::resolve(&*lock(&db)?, &ticker))? {
        poller.unsubscribe(&inst.ticker);
    }
    Ok(())
}

// ---- The connection test --------------------------------------------------------

fn describe_expiry(expiry_secs: i64, now_secs: i64) -> String {
    let delta = expiry_secs - now_secs;
    let (h, m) = (delta.abs() / 3600, (delta.abs() % 3600) / 60);
    if delta >= 0 {
        format!("The access token should work for another {h}h {m}m (FYERS tokens reset at 6:30 AM).")
    } else {
        format!("The access token expired {h}h {m}m ago — log in again.")
    }
}

/// Checks the saved credentials against the real service: the token's age, the profile (which costs
/// none of the day's data allowance), the symbol master, and one history request.
pub async fn test(app: &AppHandle) -> Result<TestResult, String> {
    let db = app.state::<Database>();
    let secrets = app.state::<Secrets>();
    let client = app.state::<FyersClient>();
    let mut details = Vec::new();
    let fail = |message: String, details: Vec<String>| {
        Ok(TestResult {
            ok: false,
            message,
            details,
        })
    };
    let (creds, saved) = {
        let conn = lock(&db)?;
        if sql(providers::credential(&conn, &secrets, FYERS, "appId"))?.is_none_or(|k| k.is_empty()) {
            return fail("Enter your FYERS app ID first.".into(), details);
        }
        match credentials_ignoring_enabled(&conn, &secrets) {
            Some(c) => (c, setting_ms(&conn, TOKEN_SAVED_KEY)),
            None => return fail("Log in first: there is no access token yet.".into(), details),
        }
    };
    match saved {
        Some(at) => details.push(describe_expiry(token_expiry_estimate_secs(at), now_ms() / 1000)),
        None => details.push("When this token was issued isn't known, so its expiry can't be estimated.".into()),
    }
    match client.profile(&creds).await {
        Ok(name) => details.push(match name {
            Some(n) => format!("Logged in as {n}."),
            None => "The login works.".into(),
        }),
        Err(e) => return fail(e.message(), details),
    }
    let have = sql(instruments::count(&*lock(&db)?))?;
    if have == 0 {
        let count = update_instruments_inner(&db, &client).await?;
        details.push(format!("Downloaded the symbol master ({count} instruments)."));
    } else {
        details.push(format!("Symbol master: {have} instruments."));
    }
    let probe = sql(instruments::resolve(&*lock(&db)?, "NSE:RELIANCE"))?
        .ok_or_else(|| "The symbol master has no NSE:RELIANCE — try updating it.".to_string())?;
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
            let usage = client.usage(now_ms());
            details.push(format!(
                "Plan: {} — {} of {} data requests used today.",
                if client.plan() == Plan::Prime {
                    "Prime"
                } else {
                    "Standard"
                },
                usage.used,
                usage.limit
            ));
            Ok(TestResult {
                ok: true,
                message: "Connected to FYERS.".into(),
                details,
            })
        }
        Err(e) => fail(e.message(), details),
    }
}
