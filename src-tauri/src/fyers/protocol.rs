//! The pure parts of the FYERS API v3 integration: request planning, response parsing, error
//! mapping, and the login handshake. No I/O lives here, so all of it is unit-tested; `client.rs`
//! does the talking.
//!
//! What FYERS's documentation (fyers.in/api-docs, v3) says, and what this relies on:
//! - every call is authorised by `Authorization: <app id>:<access token>`, no "Bearer";
//! - history is `GET /data/history` with `date_format=0` (epoch seconds), at most 100 days a
//!   request for minute bars and 366 for daily; candles are `[epoch, o, h, l, c, v]`;
//! - quotes are `GET /data/quotes?symbols=a,b`, at most 50 symbols a call on the Standard plan;
//! - access tokens expire every day at 06:30 IST; -8, -15, -16 and -17 mean the token is no good;
//! - going over a rate limit answers 429 (or code -429; -360 on the Standard plan).
//!
//! What it doesn't say, and is handled defensively: the timezone of a daily candle's stamp (it is put
//! on midnight IST of its date either way), the format of a quote's `tt`, the shape of a "no data"
//! answer, and the refresh-token endpoint, which is known only from FYERS's community forum.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::market::{ist_date, last_ist_minute, next_ist_minute};
use crate::models::{Bar, DaySnapshot, Quote};
use crate::store::instrument_list::Instrument;

pub const API_URL: &str = "https://api-t1.fyers.in/api/v3";
pub const DATA_URL: &str = "https://api-t1.fyers.in/data";
pub const SYMBOL_MASTER_URL: &str = "https://public.fyers.in/sym_details";

const DAY_MS: i64 = 86_400_000;
/// FYERS tokens stop working at 06:30 IST each morning.
pub const TOKEN_RESET_MINUTE_IST: i64 = 6 * 60 + 30;
/// The most windows one history call fans out into; older ones are dropped.
pub const MAX_CHUNKS: usize = 20;
/// The most symbols one quote request names (the Standard plan's limit; Prime allows more by POST).
pub const QUOTE_BATCH: usize = 50;

// ---- Plans ----------------------------------------------------------------------

/// Which FYERS API plan the user's account is on. It sets how fast and how often the app may ask:
/// the data limits are 5 a second, 50 a minute and 5,000 a day on Standard, and 10 a second, 500 a
/// minute and 500,000 a day on Prime. FYERS blocks an account for the rest of the day after it goes
/// over the per-minute limit more than three times, so the app keeps well under it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    Standard,
    Prime,
}

impl Plan {
    pub fn parse(text: &str) -> Option<Plan> {
        match text.trim().to_ascii_lowercase().as_str() {
            "standard" => Some(Plan::Standard),
            "prime" => Some(Plan::Prime),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Plan::Standard => "standard",
            Plan::Prime => "prime",
        }
    }

    /// Data requests a day.
    pub fn daily_limit(self) -> u32 {
        match self {
            Plan::Standard => 5_000,
            Plan::Prime => 500_000,
        }
    }

    /// The gap between data requests: about 46 a minute on Standard (its limit is 50) and about 460
    /// on Prime (500).
    pub fn data_gap_ms(self) -> u64 {
        match self {
            Plan::Standard => 1_300,
            Plan::Prime => 130,
        }
    }
}

// ---- Errors ---------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FyersErrorKind {
    /// Not set up: missing app ID, secret or token.
    NotConfigured,
    /// A bad or expired access token (codes -8, -15, -16, -17).
    Token,
    /// FYERS's limit, or the app's own daily budget, was reached.
    RateLimited,
    /// The request was wrong (an unknown symbol, a bad parameter); FYERS's own message says how.
    BadRequest,
    /// A network failure — worth falling back to memory for.
    Network,
    Server,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FyersError {
    pub kind: FyersErrorKind,
    /// The server's own words, when it gave any.
    pub detail: String,
}

impl FyersError {
    pub fn new(kind: FyersErrorKind, detail: impl Into<String>) -> Self {
        FyersError {
            kind,
            detail: detail.into(),
        }
    }

    pub fn not_configured() -> Self {
        FyersError::new(FyersErrorKind::NotConfigured, "")
    }

    /// What to show the user, including what to do about it.
    pub fn message(&self) -> String {
        let detail = self.detail.trim();
        match self.kind {
            FyersErrorKind::NotConfigured => "FYERS isn't set up. Open Data providers, enter your app ID and secret, \
                 log in, and turn FYERS on."
                .to_string(),
            FyersErrorKind::Token => {
                "FYERS rejected your access token. FYERS tokens expire every morning at 6:30 AM — \
                 open Data providers and log in again."
                    .to_string()
            }
            FyersErrorKind::RateLimited if detail.is_empty() => {
                "FYERS is rate limiting requests — try again in a minute.".to_string()
            }
            FyersErrorKind::RateLimited => detail.to_string(),
            FyersErrorKind::Network => format!("Couldn't reach FYERS: {detail}"),
            _ if detail.is_empty() => "FYERS returned an error.".to_string(),
            _ => format!("FYERS: {detail}"),
        }
    }
}

impl std::fmt::Display for FyersError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

/// FYERS's numeric error code: `code` in the body, as a number or a numeric string.
fn code_of(body: &Value) -> Option<i64> {
    match body.get("code")? {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// Maps an error response to a `FyersError`. FYERS says what went wrong in `code`; the HTTP status
/// is the fallback.
pub fn classify_error(status: u16, body: &Value) -> FyersError {
    let detail = body.get("message").and_then(Value::as_str).unwrap_or("").to_string();
    let kind = match (status, code_of(body)) {
        (429, _) | (_, Some(-429 | -360)) => FyersErrorKind::RateLimited,
        (_, Some(-8 | -15 | -16 | -17)) => FyersErrorKind::Token,
        (_, Some(-300 | -50 | -99)) => FyersErrorKind::BadRequest,
        (401 | 403, _) => FyersErrorKind::Token,
        (400..=499, _) => FyersErrorKind::BadRequest,
        (500..=599, _) => FyersErrorKind::Server,
        _ => FyersErrorKind::Other,
    };
    FyersError::new(kind, detail)
}

/// FYERS reports failures as `{"s":"error", "code": -16, …}`, often with a 200.
pub fn is_failure_body(body: &Value) -> bool {
    body.get("s").and_then(Value::as_str) == Some("error")
}

fn check(status: u16, body: &Value) -> Result<(), FyersError> {
    if status >= 400 || is_failure_body(body) {
        return Err(classify_error(status, body));
    }
    Ok(())
}

// ---- Time ------------------------------------------------------------------

/// When a token saved at `saved_at_ms` most likely stops working: the next 06:30 IST. FYERS gives no
/// expiry with the token, so this is an estimate.
pub fn token_expiry_estimate_secs(saved_at_ms: i64) -> i64 {
    next_ist_minute(saved_at_ms, TOKEN_RESET_MINUTE_IST).div_euclid(1000)
}

/// Whether a token saved at `saved_at_ms` has already been through a 06:30 reset by `now_ms`.
pub fn token_is_stale(saved_at_ms: i64, now_ms: i64) -> bool {
    saved_at_ms < last_ist_minute(now_ms, TOKEN_RESET_MINUTE_IST)
}

/// An epoch that may be in seconds or in milliseconds (a quote's `tt` is documented only as a
/// "timestamp"), as milliseconds. Anything implausible is refused.
fn epoch_ms(value: &Value) -> Option<i64> {
    let n = match value {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    if !n.is_finite() || n <= 0.0 {
        return None;
    }
    // Seconds until the year 5138; anything bigger is already milliseconds.
    Some(if n < 1e11 { (n * 1000.0) as i64 } else { n as i64 })
}

// ---- History requests ------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Interval {
    Minutes(u32),
    Day,
}

/// The minute bar sizes FYERS serves natively (its documented resolutions; seconds are left out).
pub const NATIVE_MINUTES: [u32; 11] = [1, 2, 3, 5, 10, 15, 20, 30, 60, 120, 240];

impl Interval {
    /// Accepts the frontend's spelling (`D`, `5`) and FYERS's (`1D`).
    pub fn parse(text: &str) -> Option<Interval> {
        let t = text.trim().to_lowercase();
        if matches!(t.as_str(), "d" | "1d" | "day" | "daily") {
            return Some(Interval::Day);
        }
        let minutes = t.strip_suffix("minute").unwrap_or(&t).parse::<u32>().ok()?;
        NATIVE_MINUTES.contains(&minutes).then_some(Interval::Minutes(minutes))
    }

    /// The `resolution` parameter: `D`, or the minutes.
    pub fn resolution(self) -> String {
        match self {
            Interval::Day => "D".to_string(),
            Interval::Minutes(n) => n.to_string(),
        }
    }

    /// The most calendar days one request may span (FYERS's documented limits).
    fn max_window_days(self) -> i64 {
        match self {
            Interval::Minutes(_) => 100,
            Interval::Day => 366,
        }
    }

    /// One window's length, a day short of the limit so a request never sits on it.
    fn window_ms(self) -> i64 {
        (self.max_window_days() - 1) * DAY_MS
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub from_ms: i64,
    pub to_ms: i64,
}

/// Splits `[from, to]` into requests FYERS will accept, oldest first. With no `from`, one full
/// window ending at `to` is asked for. A span too long to cover with `MAX_CHUNKS` windows keeps the
/// newest ones.
pub fn plan_windows(interval: Interval, from_ms: Option<i64>, to_ms: Option<i64>, now_ms: i64) -> Vec<Window> {
    let to = to_ms.unwrap_or(now_ms).min(now_ms);
    let span = interval.window_ms();
    let from = from_ms.unwrap_or(to - span).max(0);
    if from >= to {
        return Vec::new();
    }
    let mut windows = Vec::new();
    let mut start = from;
    while start < to {
        let end = (start + span).min(to);
        windows.push(Window {
            from_ms: start,
            to_ms: end,
        });
        start = end;
    }
    if windows.len() > MAX_CHUNKS {
        windows.drain(..windows.len() - MAX_CHUNKS);
    }
    windows
}

/// Futures contracts are listed one expiry at a time. For daily candles, `cont_flag=1` asks for the
/// continuous series, so a chart goes back years instead of to the current contract's listing (the
/// same choice as Kite's `continuous=1`).
fn wants_continuous(inst: &Instrument, interval: Interval) -> bool {
    interval == Interval::Day && inst.instrument == "FUT"
}

/// The query string for one history window.
pub fn history_query(inst: &Instrument, interval: Interval, window: Window) -> Vec<(&'static str, String)> {
    let mut query = vec![
        ("symbol", inst.symbol.clone()),
        ("resolution", interval.resolution()),
        ("date_format", "0".to_string()),
        ("range_from", window.from_ms.div_euclid(1000).to_string()),
        ("range_to", window.to_ms.div_euclid(1000).to_string()),
    ];
    if wants_continuous(inst, interval) {
        query.push(("cont_flag", "1".to_string()));
    }
    query
}

/// Parses a history response: `candles` is an array of `[epoch, open, high, low, close, volume]`. A
/// candle that can't be read is skipped rather than failing the chart. Zero volume (an index) is
/// reported as no volume, so the chart doesn't draw an empty volume pane. A "no data" answer is no
/// bars, not an error: before a listing, or past the depth the plan serves, there is nothing.
pub fn parse_candles(status: u16, body: &Value) -> Result<Vec<Bar>, FyersError> {
    if body.get("s").and_then(Value::as_str) == Some("no_data") {
        return Ok(Vec::new());
    }
    check(status, body)?;
    let Some(candles) = body.get("candles").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let mut bars: Vec<Bar> = candles
        .iter()
        .filter_map(|c| {
            let c = c.as_array()?;
            let time = epoch_ms(c.first()?)?;
            let n = |i: usize| c.get(i).and_then(Value::as_f64).filter(|v| v.is_finite());
            let (open, high, low, close) = (n(1)?, n(2)?, n(3)?, n(4)?);
            if close <= 0.0 && open <= 0.0 {
                return None;
            }
            Some(Bar {
                time,
                open,
                high,
                low,
                close,
                volume: n(5).filter(|v| *v > 0.0),
            })
        })
        .collect();
    bars.sort_by_key(|b| b.time);
    bars.dedup_by_key(|b| b.time);
    Ok(bars)
}

// ---- Quotes ----------------------------------------------------------------

/// The `symbols` parameter for one batch: FYERS symbols, comma-separated.
pub fn quotes_query(batch: &[Instrument]) -> Vec<(&'static str, String)> {
    let symbols: Vec<&str> = batch.iter().map(|i| i.symbol.as_str()).collect();
    vec![("symbols", symbols.join(","))]
}

/// A quotes response's entries that FYERS answered, by the symbol they were asked under.
fn quote_entries(body: &Value) -> std::collections::HashMap<&str, &Value> {
    body.get("d")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|e| e.get("s").and_then(Value::as_str) != Some("error"))
        .filter_map(|e| Some((e.get("n")?.as_str()?, e.get("v")?)))
        .collect()
}

fn price(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64).filter(|p| p.is_finite() && *p > 0.0)
}

/// One quote per requested instrument, in order, named by the app's ticker; one FYERS doesn't answer
/// for says so.
pub fn parse_quotes(status: u16, body: &Value, requested: &[Instrument]) -> Result<Vec<Quote>, FyersError> {
    check(status, body)?;
    let entries = quote_entries(body);
    Ok(requested
        .iter()
        .map(|inst| {
            let entry = entries.get(inst.symbol.as_str()).copied();
            let last = entry.and_then(|v| price(v, "lp"));
            let previous = entry.and_then(|v| price(v, "prev_close_price"));
            let error = match (entry, last) {
                (None, _) => Some("FYERS has no quote for it".to_string()),
                (Some(_), None) => Some("no price yet".to_string()),
                _ => None,
            };
            Quote {
                symbol: inst.ticker.clone(),
                price: last,
                previous_close: previous,
                change_percent: match (last, previous) {
                    (Some(p), Some(c)) => Some((p - c) / c * 100.0),
                    _ => None,
                },
                currency: Some("INR".to_string()),
                error,
            }
        })
        .collect())
}

/// One tick of a polled quote, for a live chart: the last price, when it traded and the day's totals.
#[derive(Debug, Clone, PartialEq)]
pub struct QuoteTick {
    pub ltp: f64,
    /// The quote's own `tt`, epoch seconds or milliseconds, as FYERS sent it.
    pub ltt: Option<f64>,
    /// The day's cumulative volume.
    pub volume: Option<f64>,
    pub open: Option<f64>,
    pub high: Option<f64>,
    pub low: Option<f64>,
}

/// One tick per requested instrument, `None` for one FYERS has no price for.
pub fn parse_ticks(status: u16, body: &Value, requested: &[Instrument]) -> Result<Vec<Option<QuoteTick>>, FyersError> {
    check(status, body)?;
    let entries = quote_entries(body);
    Ok(requested
        .iter()
        .map(|inst| {
            let v = entries.get(inst.symbol.as_str()).copied()?;
            Some(QuoteTick {
                ltp: price(v, "lp")?,
                ltt: v.get("tt").and_then(epoch_ms).map(|ms| ms as f64 / 1000.0),
                volume: v.get("volume").and_then(Value::as_f64).filter(|x| *x > 0.0),
                open: price(v, "open_price"),
                high: price(v, "high_price"),
                low: price(v, "low_price"),
            })
        })
        .collect())
}

/// A quote-based stand-in for today's (or the last session's) bar, per requested instrument;
/// `None` for one FYERS has no quote or no price for (`store::day_topup` then falls back to the
/// historical endpoint). A snapshot without a trade time can't be dated, so it is refused too.
pub fn parse_day_snapshots(
    status: u16,
    body: &Value,
    requested: &[Instrument],
) -> Result<Vec<Option<DaySnapshot>>, FyersError> {
    check(status, body)?;
    let entries = quote_entries(body);
    Ok(requested
        .iter()
        .map(|inst| {
            let v = entries.get(inst.symbol.as_str()).copied()?;
            Some(DaySnapshot {
                open: price(v, "open_price")?,
                high: price(v, "high_price")?,
                low: price(v, "low_price")?,
                last: price(v, "lp")?,
                previous_close: price(v, "prev_close_price"),
                volume: v.get("volume").and_then(Value::as_f64).filter(|x| *x > 0.0),
                traded_at_ms: Some(v.get("tt").and_then(epoch_ms)?),
            })
        })
        .collect())
}

// ---- Login -----------------------------------------------------------------

fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn hex(b: u8) -> Option<u8> {
    (b as char).to_digit(16).map(|d| d as u8)
}

/// Percent-decodes a query value; a `%` not followed by two hex digits is kept as it is.
fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let pair = (bytes[i] == b'%')
            .then(|| Some((hex(*bytes.get(i + 1)?)?, hex(*bytes.get(i + 2)?)?)))
            .flatten();
        match (pair, bytes[i]) {
            (Some((hi, lo)), _) => {
                out.push(hi << 4 | lo);
                i += 3;
            }
            (None, b'+') => {
                out.push(b' ');
                i += 1;
            }
            (None, b) => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The page where the user logs in to FYERS (`generate-authcode`). It redirects to `redirect` — which
/// must be exactly the redirect URL registered on the user's FYERS app — with a one-time `auth_code`
/// and `state` back unchanged.
pub fn login_url(app_id: &str, redirect: &str, state: &str) -> String {
    format!(
        "{API_URL}/generate-authcode?client_id={}&redirect_uri={}&response_type=code&state={}",
        encode(app_id.trim()),
        encode(redirect),
        encode(state)
    )
}

/// `appIdHash`: SHA-256 of `app_id:app_secret`, hex. FYERS asks for it instead of the secret itself.
pub fn app_id_hash(app_id: &str, secret: &str) -> String {
    let digest = Sha256::digest(format!("{}:{}", app_id.trim(), secret.trim()).as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// The query parameters of a redirect address (`http://127.0.0.1:47822/?s=ok&auth_code=…`), or of a
/// bare query or path.
fn query_params(text: &str) -> Vec<(String, String)> {
    let query = text.split_once('?').map(|(_, q)| q).unwrap_or(text);
    let query = query.split('#').next().unwrap_or("");
    query
        .split('&')
        .filter_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            Some((decode(k), decode(v)))
        })
        .collect()
}

/// The one-time `auth_code` from what the browser was sent to, or from what the user pasted: the
/// whole redirect address, or the code alone. When `expected_state` is given, a redirect that names a
/// different `state` is refused: it didn't come from this login.
pub fn extract_auth_code(text: &str, expected_state: Option<&str>) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Paste the address FYERS sent your browser to after the login.".to_string());
    }
    if !text.contains('=') {
        // The code on its own: a JWT-like run of characters, nothing to parse.
        if text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        {
            return Ok(text.to_string());
        }
        return Err("That doesn't look like FYERS's login address or an auth code.".to_string());
    }
    let params = query_params(text);
    let get = |key: &str| params.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
    if get("s") == Some("error") {
        let why = get("message").unwrap_or("the login didn't finish");
        return Err(format!("FYERS said the login failed: {why}."));
    }
    let code = get("auth_code")
        .or_else(|| get("code").filter(|c| c.len() > 20))
        .filter(|c| !c.is_empty())
        .ok_or_else(|| {
            "That address has no auth_code in it. Log in again and paste the address you land on.".to_string()
        })?;
    if let (Some(expected), Some(got)) = (expected_state, get("state")) {
        if expected != got {
            return Err(
                "That login was started somewhere else (its state doesn't match). Log in again from here.".to_string(),
            );
        }
    }
    Ok(code.to_string())
}

/// The body of `POST /api/v3/validate-authcode`.
pub fn validate_authcode_body(app_id_hash: &str, code: &str) -> Value {
    json!({ "grant_type": "authorization_code", "appIdHash": app_id_hash, "code": code })
}

/// The body of `POST /api/v3/validate-refresh-token`. FYERS's current documentation doesn't describe
/// this call; its community forum does. A refusal of any kind means "log in again".
pub fn refresh_body(app_id_hash: &str, refresh_token: &str, pin: &str) -> Value {
    json!({ "grant_type": "refresh_token", "appIdHash": app_id_hash, "refresh_token": refresh_token, "pin": pin })
}

/// What a login or a renewal gave back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub access_token: String,
    /// Only a login gives one (about 15 days long, by FYERS's forum); a renewal may not.
    pub refresh_token: Option<String>,
}

pub fn parse_session(status: u16, body: &Value) -> Result<Session, FyersError> {
    check(status, body)?;
    let access_token = body
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| FyersError::new(FyersErrorKind::Other, "the reply had no access token"))?;
    Ok(Session {
        access_token: access_token.to_string(),
        refresh_token: body
            .get("refresh_token")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .map(str::to_string),
    })
}

/// The account holder's name from `GET /api/v3/profile`, for the test button.
pub fn parse_profile(status: u16, body: &Value) -> Result<Option<String>, FyersError> {
    check(status, body)?;
    Ok(body.pointer("/data/name").and_then(Value::as_str).map(str::to_string))
}

/// `YYYY-MM-DD` of an expiry FYERS gives as epoch seconds.
pub fn expiry_date(epoch_secs: &str) -> Option<String> {
    let secs: i64 = epoch_secs.trim().parse().ok().filter(|s: &i64| *s > 0)?;
    Some(ist_date(secs * 1000))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inst(ticker: &str, symbol: &str, kind: &str) -> Instrument {
        Instrument {
            ticker: ticker.into(),
            exchange: ticker.split(':').next().unwrap().into(),
            token: 1,
            instrument: kind.into(),
            symbol: symbol.into(),
            name: None,
            expiry: None,
        }
    }

    #[test]
    fn errors_are_classified_by_fyers_codes_and_then_the_status() {
        let kind = |status, body: Value| classify_error(status, &body).kind;
        assert_eq!(
            kind(200, json!({"s":"error","code":-16,"message":"Could not authenticate"})),
            FyersErrorKind::Token
        );
        for code in [-8, -15, -17] {
            assert_eq!(
                kind(200, json!({"s":"error","code":code})),
                FyersErrorKind::Token,
                "{code}"
            );
        }
        assert_eq!(kind(429, json!({})), FyersErrorKind::RateLimited);
        assert_eq!(kind(200, json!({"s":"error","code":-429})), FyersErrorKind::RateLimited);
        assert_eq!(
            kind(200, json!({"s":"error","code":"-360"})),
            FyersErrorKind::RateLimited,
            "a code as text"
        );
        assert_eq!(
            kind(200, json!({"s":"error","code":-300,"message":"Invalid symbol"})),
            FyersErrorKind::BadRequest
        );
        assert_eq!(kind(401, json!({})), FyersErrorKind::Token);
        assert_eq!(kind(503, json!({})), FyersErrorKind::Server);
        let e = classify_error(200, &json!({"s":"error","code":-300,"message":"Invalid symbol"}));
        assert_eq!(e.message(), "FYERS: Invalid symbol");
    }

    #[test]
    fn a_tokens_expiry_is_the_next_half_past_six_in_india() {
        // 1793095800 is 2026-10-27 15:40 IST; the token lasts until 06:30 the next morning.
        let saved = 1_793_095_800_000;
        let expiry = token_expiry_estimate_secs(saved);
        assert_eq!(expiry, 1_793_095_800 + 14 * 3600 + 50 * 60);
        assert_eq!(crate::market::ist_datetime(expiry * 1000), "2026-10-28 06:30:00");
        assert!(!token_is_stale(saved, saved + 3_600_000));
        assert!(token_is_stale(saved, expiry * 1000 + 1));
        assert!(
            !token_is_stale(expiry * 1000 + 1, expiry * 1000 + 5_000),
            "a token saved after the reset"
        );
        // Saved just before the reset, it lasts only until then.
        assert_eq!(token_expiry_estimate_secs(expiry * 1000 - 60_000), expiry);
    }

    #[test]
    fn plans_set_the_pace_and_the_daily_budget() {
        assert_eq!(Plan::parse(" Prime "), Some(Plan::Prime));
        assert_eq!(Plan::parse("standard"), Some(Plan::Standard));
        assert_eq!(Plan::parse("gold"), None);
        // Under 50 a minute on Standard, and under 500 on Prime.
        assert!(60_000 / Plan::Standard.data_gap_ms() < 50);
        assert!(60_000 / Plan::Prime.data_gap_ms() < 500);
        assert_eq!(Plan::Standard.daily_limit(), 5_000);
    }

    #[test]
    fn intervals_are_fyerss_resolutions() {
        assert_eq!(Interval::parse("D"), Some(Interval::Day));
        assert_eq!(Interval::parse("1D"), Some(Interval::Day));
        assert_eq!(Interval::parse("240"), Some(Interval::Minutes(240)));
        assert_eq!(Interval::parse("2"), Some(Interval::Minutes(2)));
        assert_eq!(Interval::parse("7"), None);
        assert_eq!(Interval::parse("45"), None, "45 minutes isn't in the documented list");
        assert_eq!(Interval::Minutes(5).resolution(), "5");
        assert_eq!(Interval::Day.resolution(), "D");
    }

    #[test]
    fn a_long_span_is_split_into_windows_fyers_accepts_newest_kept() {
        let now = 2_000_000_000_000;
        let windows = plan_windows(Interval::Day, Some(now - 5 * 365 * DAY_MS), None, now);
        assert_eq!(windows.len(), 5, "five years of daily bars is five requests");
        assert!(windows.iter().all(|w| w.to_ms - w.from_ms <= 365 * DAY_MS));
        assert_eq!(windows.last().unwrap().to_ms, now);
        let intraday = plan_windows(Interval::Minutes(5), Some(now - 300 * DAY_MS), Some(now), now);
        assert_eq!(intraday.len(), 4);
        assert!(intraday.iter().all(|w| w.to_ms - w.from_ms <= 99 * DAY_MS));
        let capped = plan_windows(Interval::Minutes(1), Some(0), Some(now), now);
        assert_eq!(capped.len(), MAX_CHUNKS);
        assert_eq!(capped.last().unwrap().to_ms, now, "the newest are kept");
        assert!(plan_windows(Interval::Day, Some(now), Some(now - 1), now).is_empty());
    }

    #[test]
    fn a_history_query_names_the_fyers_symbol_in_epoch_seconds() {
        let sbin = inst("NSE:SBIN", "NSE:SBIN-EQ", "EQUITY");
        let q = history_query(
            &sbin,
            Interval::Minutes(5),
            Window {
                from_ms: 1_000_500,
                to_ms: 2_000_999,
            },
        );
        assert_eq!(
            q,
            vec![
                ("symbol", "NSE:SBIN-EQ".to_string()),
                ("resolution", "5".to_string()),
                ("date_format", "0".to_string()),
                ("range_from", "1000".to_string()),
                ("range_to", "2000".to_string()),
            ]
        );
        let fut = inst("NFO:NIFTY26OCTFUT", "NSE:NIFTY26OCTFUT", "FUT");
        assert!(history_query(&fut, Interval::Day, Window { from_ms: 0, to_ms: 1 })
            .contains(&("cont_flag", "1".to_string())));
        assert!(
            !history_query(&fut, Interval::Minutes(5), Window { from_ms: 0, to_ms: 1 })
                .iter()
                .any(|(k, _)| *k == "cont_flag")
        );
    }

    #[test]
    fn candles_are_read_sorted_deduplicated_and_indices_lose_their_zero_volume() {
        // As in FYERS's own documentation: epoch seconds, then o h l c v.
        let body = json!({"s":"ok","code":200,"message":"","candles":[
            [1690934400, 609.85, 610.5, 594.1, 598.45, 14977497],
            [1690848000, 600.0, 612.0, 599.0, 609.0, 0],
            [1690934400, 609.85, 610.5, 594.1, 598.45, 14977497],
            ["bad"],
        ]});
        let bars = parse_candles(200, &body).unwrap();
        assert_eq!(bars.len(), 2);
        assert_eq!(bars[0].time, 1_690_848_000_000);
        assert_eq!(bars[0].volume, None);
        assert_eq!(bars[1].volume, Some(14_977_497.0));
    }

    #[test]
    fn no_data_is_no_bars_and_an_error_is_an_error() {
        assert!(parse_candles(200, &json!({"s":"no_data","candles":[]}))
            .unwrap()
            .is_empty());
        assert!(parse_candles(200, &json!({"s":"ok"})).unwrap().is_empty());
        let e = parse_candles(200, &json!({"s":"error","code":-16,"message":"x"})).unwrap_err();
        assert_eq!(e.kind, FyersErrorKind::Token);
    }

    fn quote_body() -> Value {
        json!({"s":"ok","code":200,"d":[
            {"n":"NSE:SBIN-EQ","s":"ok","v":{"lp":800.5,"prev_close_price":790.0,"open_price":792.0,"high_price":805.0,
             "low_price":789.0,"volume":1234567,"tt":"1792125000","symbol":"NSE:SBIN-EQ"}},
            {"n":"NSE:NIFTY50-INDEX","s":"ok","v":{"lp":25000.0,"prev_close_price":24900.0,"open_price":24950.0,
             "high_price":25010.0,"low_price":24940.0,"volume":0,"tt":1792125000}},
            {"n":"NSE:NOPE-EQ","s":"error","v":{"errmsg":"invalid symbol"}}
        ]})
    }

    #[test]
    fn quotes_come_back_one_per_instrument_in_order_named_by_the_apps_ticker() {
        let asked = [
            inst("NSE:NIFTY_50", "NSE:NIFTY50-INDEX", "INDEX"),
            inst("NSE:SBIN", "NSE:SBIN-EQ", "EQUITY"),
            inst("NSE:NOPE", "NSE:NOPE-EQ", "EQUITY"),
        ];
        let q = parse_quotes(200, &quote_body(), &asked).unwrap();
        assert_eq!(q[0].symbol, "NSE:NIFTY_50");
        assert_eq!(q[1].price, Some(800.5));
        assert_eq!(q[1].previous_close, Some(790.0));
        assert!((q[1].change_percent.unwrap() - 1.329).abs() < 0.01);
        assert!(q[2].price.is_none() && q[2].error.is_some());
        assert_eq!(
            quotes_query(&asked[..2]),
            vec![("symbols", "NSE:NIFTY50-INDEX,NSE:SBIN-EQ".to_string())]
        );
    }

    #[test]
    fn a_day_snapshot_needs_prices_and_a_trade_time_and_reads_tt_in_either_unit() {
        let asked = [
            inst("NSE:SBIN", "NSE:SBIN-EQ", "EQUITY"),
            inst("NSE:NIFTY_50", "NSE:NIFTY50-INDEX", "INDEX"),
        ];
        let snaps = parse_day_snapshots(200, &quote_body(), &asked).unwrap();
        let sbin = snaps[0].unwrap();
        assert_eq!(
            (sbin.open, sbin.high, sbin.low, sbin.last),
            (792.0, 805.0, 789.0, 800.5)
        );
        assert_eq!(sbin.traded_at_ms, Some(1_792_125_000_000), "seconds, as text");
        let nifty = snaps[1].unwrap();
        assert_eq!(nifty.volume, None, "an index has no volume");
        let mut no_time = quote_body();
        no_time["d"][0]["v"].as_object_mut().unwrap().remove("tt");
        assert!(
            parse_day_snapshots(200, &no_time, &asked[..1]).unwrap()[0].is_none(),
            "an undated quote can't stand in for a day"
        );
        assert_eq!(
            epoch_ms(&json!(1_792_125_000_000i64)),
            Some(1_792_125_000_000),
            "milliseconds stay"
        );
    }

    #[test]
    fn a_tick_carries_the_last_price_and_the_days_range() {
        let asked = [inst("NSE:SBIN", "NSE:SBIN-EQ", "EQUITY")];
        let tick = parse_ticks(200, &quote_body(), &asked).unwrap()[0].clone().unwrap();
        assert_eq!(tick.ltp, 800.5);
        assert_eq!(tick.ltt, Some(1_792_125_000.0));
        assert_eq!(
            (tick.open, tick.high, tick.low),
            (Some(792.0), Some(805.0), Some(789.0))
        );
    }

    #[test]
    fn the_login_url_names_the_app_the_redirect_and_the_state() {
        let url = login_url("ABCD1234-100", "http://127.0.0.1:47822/", "s1");
        assert_eq!(
            url,
            "https://api-t1.fyers.in/api/v3/generate-authcode?client_id=ABCD1234-100&redirect_uri=http%3A%2F%2F127.0.0.1%3A47822%2F&response_type=code&state=s1"
        );
    }

    #[test]
    fn the_app_id_hash_is_sha256_of_id_colon_secret() {
        let hash = app_id_hash("a", "b");
        assert_eq!(hash.len(), 64);
        assert_eq!(hash, format!("{:x}", Sha256::digest(b"a:b")));
        assert_eq!(app_id_hash(" a ", "b\n"), hash, "pasted whitespace is trimmed");
    }

    #[test]
    fn query_values_are_percent_decoded_and_a_stray_percent_survives() {
        assert_eq!(decode("user%20cancelled"), "user cancelled");
        assert_eq!(decode("a+b"), "a b");
        assert_eq!(decode("100%"), "100%");
        assert_eq!(decode("%zz%41"), "%zzA");
        assert_eq!(decode("caf%C3%A9"), "café");
    }

    #[test]
    fn an_auth_code_is_taken_from_a_redirect_or_pasted_alone() {
        let addr = "http://127.0.0.1:47822/?s=ok&code=200&auth_code=eyJ0eXAi.abc-def_1&state=s1";
        assert_eq!(extract_auth_code(addr, Some("s1")).unwrap(), "eyJ0eXAi.abc-def_1");
        assert_eq!(extract_auth_code(addr, None).unwrap(), "eyJ0eXAi.abc-def_1");
        assert_eq!(extract_auth_code(" eyJ0eXAi.abc ", None).unwrap(), "eyJ0eXAi.abc");
        assert!(extract_auth_code(addr, Some("other")).unwrap_err().contains("state"));
        assert!(
            extract_auth_code("http://127.0.0.1:47822/?s=error&code=-1&message=user%20cancelled", None)
                .unwrap_err()
                .contains("user cancelled")
        );
        assert!(extract_auth_code("http://127.0.0.1:47822/?s=ok", None).is_err());
        assert!(extract_auth_code("", None).is_err());
        assert!(extract_auth_code("not a code!", None).is_err());
    }

    #[test]
    fn a_session_needs_an_access_token_and_may_carry_a_refresh_token() {
        let s = parse_session(
            200,
            &json!({"s":"ok","code":200,"access_token":"A","refresh_token":"R"}),
        )
        .unwrap();
        assert_eq!(
            s,
            Session {
                access_token: "A".into(),
                refresh_token: Some("R".into())
            }
        );
        let renewed = parse_session(200, &json!({"s":"ok","access_token":"B"})).unwrap();
        assert_eq!(renewed.refresh_token, None);
        assert!(parse_session(200, &json!({"s":"ok"})).is_err());
        assert_eq!(
            parse_session(200, &json!({"s":"error","code":-16})).unwrap_err().kind,
            FyersErrorKind::Token
        );
        assert_eq!(
            validate_authcode_body("h", "c"),
            json!({"grant_type":"authorization_code","appIdHash":"h","code":"c"})
        );
        assert_eq!(refresh_body("h", "r", "1234")["grant_type"], "refresh_token");
    }

    #[test]
    fn an_expiry_in_epoch_seconds_is_an_ist_date() {
        // 1793095800 is 2026-10-27 15:40 IST, a monthly expiry in FYERS's master.
        assert_eq!(expiry_date("1793095800").as_deref(), Some("2026-10-27"));
        assert_eq!(expiry_date(""), None);
        assert_eq!(expiry_date("-1"), None);
    }
}
