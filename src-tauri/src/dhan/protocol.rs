//! Pure Dhan protocol logic: no I/O, so all of it is unit-tested. Built from
//! Dhan's v2 docs (historical data, market quote, annexure).
//!
//! Where the docs are silent or ambiguous the code is defensive rather than
//! trusting: timestamps in particular are checked against the window that was
//! requested (see `detect_timestamp_shift`).

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Value};

use super::instruments::Instrument;
use super::Segment;
use crate::models::{Bar, Quote};

pub const BASE_URL: &str = "https://api.dhan.co/v2";
pub const FEED_URL: &str = "wss://api-feed.dhan.co";

/// India has no daylight saving, so a fixed offset is exact.
pub const IST_OFFSET_SECS: i64 = 19_800;

const DAY_MS: i64 = 86_400_000;
/// Dhan serves intraday bars for the last 5 years, at most 90 days per request.
const INTRADAY_MAX_AGE_MS: i64 = 1_826 * DAY_MS;
const INTRADAY_CHUNK_MS: i64 = 90 * DAY_MS;
/// One call never fans out to more than this many requests (~3 years): a chart
/// asks for a screenful of bars, not the whole archive.
const MAX_CHUNKS: usize = 12;
/// Seconds between the Unix epoch (1970) and 1 Jan 1980, the epoch some Dhan
/// timestamps are counted from.
const EPOCH_1980_OFFSET_SECS: i64 = 315_532_800;

// ---- Errors ---------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DhanErrorKind {
    /// Bad, expired or missing credentials.
    Auth,
    /// The account has no Data API access.
    NotSubscribed,
    RateLimited,
    /// Nothing to return for that request (not the same as an error).
    NoData,
    BadRequest,
    /// A server-side or network failure — worth retrying, or falling back.
    Server,
    Network,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DhanError {
    pub kind: DhanErrorKind,
    /// The server's own words, when it gave any.
    pub detail: String,
}

impl DhanError {
    pub fn new(kind: DhanErrorKind, detail: impl Into<String>) -> Self {
        DhanError {
            kind,
            detail: detail.into(),
        }
    }

    pub fn not_configured() -> Self {
        DhanError::new(DhanErrorKind::Auth, "Dhan isn't set up")
    }

    /// What to show the user, including what to do about it.
    pub fn message(&self) -> String {
        let detail = self.detail.trim();
        match self.kind {
            DhanErrorKind::Auth if detail == "Dhan isn't set up" => {
                "Dhan isn't set up. Open Data providers, enter your client ID and access token, and turn Dhan on."
                    .to_string()
            }
            DhanErrorKind::Auth => format!(
                "Dhan rejected your credentials ({detail}). Open Data providers and paste a fresh access token."
            ),
            DhanErrorKind::NotSubscribed => format!(
                "Your Dhan account doesn't have Data API access ({detail}). Subscribe to Dhan's Data API plan, then try again."
            ),
            DhanErrorKind::RateLimited => "Dhan is rate limiting requests — try again in a moment.".to_string(),
            DhanErrorKind::NoData if detail.is_empty() => "Dhan has no data for that request.".to_string(),
            DhanErrorKind::Network => format!("Couldn't reach Dhan: {detail}"),
            _ if detail.is_empty() => "Dhan returned an error.".to_string(),
            _ => format!("Dhan: {detail}"),
        }
    }
}

impl std::fmt::Display for DhanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

fn kind_for_code(code: &str) -> DhanErrorKind {
    match code {
        "DH-901" | "807" | "808" | "809" | "810" => DhanErrorKind::Auth,
        "DH-902" | "806" => DhanErrorKind::NotSubscribed,
        "DH-904" | "805" => DhanErrorKind::RateLimited,
        "DH-907" => DhanErrorKind::NoData,
        "DH-905" | "811" | "812" | "813" | "814" | "804" => DhanErrorKind::BadRequest,
        "DH-908" | "DH-909" | "800" => DhanErrorKind::Server,
        _ => DhanErrorKind::Other,
    }
}

/// Maps a failed response to an error. Dhan reports failures two ways: a
/// trading-API body (`errorCode`: `DH-9xx`, `errorMessage`) and a data-API body
/// (`{"status":"failed","data":{"807":"Access token is expired"}}`); either can
/// arrive with a 4xx/5xx status, or occasionally a 200.
pub fn classify_error(status: u16, body: &Value) -> DhanError {
    if let Some(code) = body.get("errorCode").and_then(Value::as_str) {
        let message = body.get("errorMessage").and_then(Value::as_str).unwrap_or(code);
        return DhanError::new(kind_for_code(code), message);
    }
    if let Some(data) = body.get("data").and_then(Value::as_object) {
        if let Some((code, message)) = data.iter().find(|(k, _)| k.chars().all(|c| c.is_ascii_digit())) {
            let message = message.as_str().unwrap_or(code);
            return DhanError::new(kind_for_code(code), message);
        }
    }
    let kind = match status {
        401 | 403 => DhanErrorKind::Auth,
        429 => DhanErrorKind::RateLimited,
        400 => DhanErrorKind::BadRequest,
        500..=599 => DhanErrorKind::Server,
        _ => DhanErrorKind::Other,
    };
    DhanError::new(kind, format!("HTTP {status}"))
}

/// True when the body is one of Dhan's failure shapes even though the HTTP
/// status was 200: an `errorCode`, an explicit `"status":"failed"`, or a `data`
/// object keyed by a data-API error code (800–814) rather than by segment.
pub fn is_failure_body(body: &Value) -> bool {
    if body.get("errorCode").is_some() || body.get("status").and_then(Value::as_str) == Some("failed") {
        return true;
    }
    body.get("data").and_then(Value::as_object).is_some_and(|data| {
        data.keys()
            .any(|k| k.parse::<u16>().is_ok_and(|code| (800..=814).contains(&code)))
    })
}

// ---- Time helpers ----------------------------------------------------------

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    // Howard Hinnant's days-to-civil algorithm.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `YYYY-MM-DD` of an instant, in IST.
pub fn ist_date(ms: i64) -> String {
    let secs = ms.div_euclid(1000) + IST_OFFSET_SECS;
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

/// `YYYY-MM-DD HH:MM:SS` of an instant, in IST — the format the intraday
/// endpoint takes.
pub fn ist_datetime(ms: i64) -> String {
    let secs = ms.div_euclid(1000) + IST_OFFSET_SECS;
    let rem = secs.rem_euclid(86_400);
    format!(
        "{} {:02}:{:02}:{:02}",
        ist_date(ms),
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

// ---- History requests ------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Interval {
    Daily,
    Minutes(u32),
}

/// The intraday intervals Dhan serves natively.
pub const NATIVE_MINUTES: [u32; 5] = [1, 5, 15, 25, 60];

impl Interval {
    /// `"D"` (or `"1D"`) or one of Dhan's minute intervals.
    pub fn parse(text: &str) -> Option<Interval> {
        let t = text.trim();
        if t.eq_ignore_ascii_case("d") || t.eq_ignore_ascii_case("1d") {
            return Some(Interval::Daily);
        }
        let minutes: u32 = t.parse().ok()?;
        NATIVE_MINUTES.contains(&minutes).then_some(Interval::Minutes(minutes))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub from_ms: i64,
    pub to_ms: i64,
}

/// The requests needed to cover `[from, to]`. Daily is one request. Intraday is
/// clamped to the 5-year archive and split into 90-day pieces, oldest first;
/// if that would be more than `MAX_CHUNKS` pieces, the most recent are kept.
pub fn plan_windows(interval: Interval, from_ms: Option<i64>, to_ms: Option<i64>, now_ms: i64) -> Vec<Window> {
    let to = to_ms.unwrap_or(now_ms).min(now_ms);
    match interval {
        Interval::Daily => {
            // Daily history reaches back to the instrument's listing.
            let from = from_ms.unwrap_or(0).max(0);
            if from >= to {
                return Vec::new();
            }
            vec![Window {
                from_ms: from,
                to_ms: to,
            }]
        }
        Interval::Minutes(_) => {
            let earliest = now_ms - INTRADAY_MAX_AGE_MS;
            let from = from_ms.unwrap_or(earliest).max(earliest);
            if from >= to {
                return Vec::new();
            }
            let mut windows = Vec::new();
            let mut start = from;
            while start < to {
                let end = (start + INTRADAY_CHUNK_MS).min(to);
                windows.push(Window {
                    from_ms: start,
                    to_ms: end,
                });
                start = end;
            }
            let excess = windows.len().saturating_sub(MAX_CHUNKS);
            windows.split_off(excess)
        }
    }
}

/// The JSON body for one history request.
pub fn history_body(inst: &Instrument, interval: Interval, window: Window, minutes_as_number: bool) -> Value {
    let mut body = json!({
        "securityId": inst.security_id.to_string(),
        "exchangeSegment": inst.segment.api_name(),
        "instrument": inst.instrument,
        "expiryCode": 0,
        "oi": false,
    });
    let obj = body.as_object_mut().expect("object literal");
    match interval {
        Interval::Daily => {
            // `toDate` is exclusive for daily bars, so ask for the day after.
            obj.insert("fromDate".into(), json!(ist_date(window.from_ms)));
            obj.insert("toDate".into(), json!(ist_date(window.to_ms + DAY_MS)));
        }
        Interval::Minutes(m) => {
            // The docs' example sends the interval as a string while the field
            // table calls it an integer; `minutes_as_number` lets the caller try
            // the other spelling if the server objects to the first.
            obj.insert(
                "interval".into(),
                if minutes_as_number {
                    json!(m)
                } else {
                    json!(m.to_string())
                },
            );
            obj.insert("fromDate".into(), json!(ist_datetime(window.from_ms)));
            obj.insert("toDate".into(), json!(ist_datetime(window.to_ms)));
        }
    }
    body
}

// ---- History responses -----------------------------------------------------

#[derive(Debug, Default, PartialEq)]
pub struct Series {
    pub timestamp: Vec<f64>,
    pub open: Vec<f64>,
    pub high: Vec<f64>,
    pub low: Vec<f64>,
    pub close: Vec<f64>,
    pub volume: Vec<f64>,
}

fn numbers(body: &Value, key: &str) -> Vec<f64> {
    body.get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|v| v.as_f64().unwrap_or(f64::NAN)).collect())
        .unwrap_or_default()
}

/// Parses the parallel-array response. Failure bodies become errors.
pub fn parse_history(status: u16, body: &Value) -> Result<Series, DhanError> {
    if status >= 400 || is_failure_body(body) {
        return Err(classify_error(status, body));
    }
    Ok(Series {
        timestamp: numbers(body, "timestamp"),
        open: numbers(body, "open"),
        high: numbers(body, "high"),
        low: numbers(body, "low"),
        close: numbers(body, "close"),
        volume: numbers(body, "volume"),
    })
}

/// Minutes-after-midnight IST between which a segment trades. Deliberately
/// generous — it's only used to tell a correct clock from one shifted by 5½ h.
fn session_minutes(segment: Segment) -> (i64, i64) {
    match segment {
        Segment::McxComm => (9 * 60, 24 * 60),
        Segment::NseCurrency | Segment::BseCurrency => (9 * 60, 17 * 60),
        _ => (9 * 60, 15 * 60 + 40),
    }
}

/// Works out how far Dhan's timestamps are from true Unix seconds, without
/// assuming — the docs say "epoch" without naming the base.
///
/// Two independent problems are checked, in order:
/// 1. **Epoch base.** Some Dhan values are seconds since 1 Jan 1980. Choose the
///    base for which the timestamps fall inside the requested window and not in
///    the future.
/// 2. **IST-as-UTC.** For intraday data, bars are checked against the segment's
///    trading hours under a 0 / −5½h / +5½h shift.
///
/// Returns the number of seconds to *add* to each raw timestamp.
pub fn detect_timestamp_shift(
    timestamps: &[f64],
    window: Window,
    now_ms: i64,
    intraday_segment: Option<Segment>,
) -> i64 {
    let ts: Vec<i64> = timestamps.iter().filter(|t| t.is_finite()).map(|t| *t as i64).collect();
    if ts.is_empty() {
        return 0;
    }
    let lo = window.from_ms.div_euclid(1000) - 2 * 86_400;
    let hi = window.to_ms.min(now_ms).div_euclid(1000) + 2 * 86_400;
    let inside = |shift: i64| ts.iter().filter(|t| (**t + shift) >= lo && (**t + shift) <= hi).count();

    // Prefer no shift on a tie: only move off the plain Unix epoch when another
    // base is strictly better supported by the request window.
    let base = [0, EPOCH_1980_OFFSET_SECS]
        .into_iter()
        .max_by_key(|s| (inside(*s), (*s == 0) as usize))
        .unwrap_or(0);

    let Some(segment) = intraday_segment else { return base };
    let (open, close) = session_minutes(segment);
    let in_session = |shift: i64| {
        ts.iter()
            .filter(|t| {
                let minute = ((**t + base + shift + IST_OFFSET_SECS).rem_euclid(86_400)) / 60;
                minute >= open && minute <= close
            })
            .count()
    };
    let clock = [0, -IST_OFFSET_SECS, IST_OFFSET_SECS]
        .into_iter()
        .max_by_key(|s| (in_session(*s), (*s == 0) as usize))
        .unwrap_or(0);
    base + clock
}

/// Turns a parsed series into bars, applying the detected timestamp shift.
/// Rows with a missing or non-positive price are dropped (one bad bar would
/// stretch the chart's scale), and the result is sorted and de-duplicated.
pub fn series_to_bars(
    series: &Series,
    window: Window,
    now_ms: i64,
    intraday_segment: Option<Segment>,
) -> (Vec<Bar>, i64) {
    let shift = detect_timestamp_shift(&series.timestamp, window, now_ms, intraday_segment);
    let n = [
        series.timestamp.len(),
        series.open.len(),
        series.high.len(),
        series.low.len(),
        series.close.len(),
    ]
    .into_iter()
    .min()
    .unwrap_or(0);

    let mut bars: Vec<Bar> = Vec::with_capacity(n);
    for i in 0..n {
        let (t, o, h, l, c) = (
            series.timestamp[i],
            series.open[i],
            series.high[i],
            series.low[i],
            series.close[i],
        );
        if !t.is_finite() || ![o, h, l, c].iter().all(|v| v.is_finite() && *v > 0.0) {
            continue;
        }
        let volume = series.volume.get(i).copied().filter(|v| v.is_finite() && *v > 0.0);
        bars.push(Bar {
            time: (t as i64 + shift) * 1000,
            open: o,
            high: h,
            low: l,
            close: c,
            volume,
        });
    }
    bars.sort_by_key(|b| b.time);
    bars.dedup_by_key(|b| b.time);
    (bars, shift)
}

// ---- Quotes ----------------------------------------------------------------

/// The body for `/marketfeed/quote`: `{ "NSE_EQ": [2885, …], … }`.
pub fn quote_body(instruments: &[Instrument]) -> Value {
    let mut by_segment: std::collections::BTreeMap<&str, Vec<i64>> = std::collections::BTreeMap::new();
    for i in instruments {
        by_segment.entry(i.segment.api_name()).or_default().push(i.security_id);
    }
    json!(by_segment)
}

/// Reads `/marketfeed/quote` into quotes, one per requested instrument. The
/// day change comes from `net_change` (the move against the previous close).
pub fn parse_quotes(status: u16, body: &Value, requested: &[Instrument]) -> Result<Vec<Quote>, DhanError> {
    if status >= 400 || is_failure_body(body) {
        return Err(classify_error(status, body));
    }
    Ok(requested
        .iter()
        .map(|inst| {
            let entry = body.pointer(&format!("/data/{}/{}", inst.segment.api_name(), inst.security_id));
            let price = entry.and_then(|e| e.get("last_price")).and_then(Value::as_f64);
            let net_change = entry.and_then(|e| e.get("net_change")).and_then(Value::as_f64);
            let previous_close = price.zip(net_change).map(|(p, n)| p - n);
            let change_percent = match (net_change, previous_close) {
                (Some(n), Some(prev)) if prev != 0.0 => Some(n / prev * 100.0),
                _ => None,
            };
            Quote {
                symbol: inst.ticker.clone(),
                price,
                previous_close,
                change_percent,
                currency: None,
                error: if price.is_none() {
                    Some("no quote returned".to_string())
                } else {
                    None
                },
            }
        })
        .collect())
}

// ---- Tokens ----------------------------------------------------------------

/// The `exp` (Unix seconds) inside a JWT access token, if it has one. The
/// signature isn't checked — this only tells the user when to expect a
/// rejection.
pub fn token_expiry_secs(token: &str) -> Option<i64> {
    let payload = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    claims.get("exp").and_then(Value::as_i64)
}

/// Pulls the new token out of a `RenewToken` response, whichever key holds it.
pub fn parse_renewed_token(status: u16, body: &Value) -> Result<String, DhanError> {
    if status >= 400 || is_failure_body(body) {
        return Err(classify_error(status, body));
    }
    ["accessToken", "access_token", "token"]
        .iter()
        .find_map(|k| body.get(*k).and_then(Value::as_str))
        .map(str::to_string)
        .ok_or_else(|| DhanError::new(DhanErrorKind::Other, "the renew response had no token"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000; // ms — 2027-01-15, comfortably in the future of every fixture

    fn inst() -> Instrument {
        Instrument {
            ticker: "NSE:RELIANCE".into(),
            exchange: "NSE".into(),
            segment: Segment::NseEq,
            security_id: 2885,
            instrument: "EQUITY".into(),
            symbol: "RELIANCE".into(),
            name: Some("RELIANCE INDUSTRIES LTD".into()),
            expiry: None,
        }
    }

    // ---- time ----

    #[test]
    fn ist_formatting_crosses_the_utc_date_line() {
        // 2024-01-02 03:45:00 UTC is 09:15:00 IST the same day...
        let ms = 1_704_167_100_000;
        assert_eq!(ist_datetime(ms), "2024-01-02 09:15:00");
        // ...while 20:00 UTC is already the next day in India.
        assert_eq!(ist_date(1_704_225_600_000), "2024-01-03");
        assert_eq!(ist_date(0), "1970-01-01");
        assert_eq!(ist_datetime(-1000), "1970-01-01 05:29:59");
    }

    // ---- planning ----

    #[test]
    fn interval_parsing_accepts_only_what_dhan_serves() {
        assert_eq!(Interval::parse("D"), Some(Interval::Daily));
        assert_eq!(Interval::parse("1d"), Some(Interval::Daily));
        assert_eq!(Interval::parse("25"), Some(Interval::Minutes(25)));
        assert_eq!(Interval::parse("60"), Some(Interval::Minutes(60)));
        assert_eq!(Interval::parse("30"), None);
        assert_eq!(Interval::parse("W"), None);
    }

    #[test]
    fn daily_is_one_request_reaching_back_to_listing() {
        let w = plan_windows(Interval::Daily, None, None, NOW);
        assert_eq!(w, vec![Window { from_ms: 0, to_ms: NOW }]);
        assert!(plan_windows(Interval::Daily, Some(NOW), Some(NOW), NOW).is_empty());
    }

    #[test]
    fn intraday_is_split_into_ninety_day_pieces_oldest_first() {
        let from = NOW - 200 * DAY_MS;
        let w = plan_windows(Interval::Minutes(5), Some(from), Some(NOW), NOW);
        assert_eq!(w.len(), 3);
        assert_eq!(w[0].from_ms, from);
        assert_eq!(w[0].to_ms - w[0].from_ms, 90 * DAY_MS);
        assert_eq!(w[1].from_ms, w[0].to_ms, "pieces are contiguous");
        assert_eq!(w[2].to_ms, NOW);
        assert!(w.iter().all(|x| x.to_ms - x.from_ms <= 90 * DAY_MS));
    }

    #[test]
    fn intraday_is_clamped_to_five_years_and_capped_in_requests() {
        let w = plan_windows(Interval::Minutes(1), Some(0), Some(NOW), NOW);
        assert_eq!(w.len(), MAX_CHUNKS, "an open-ended ask keeps only the newest pieces");
        assert_eq!(w.last().unwrap().to_ms, NOW);
        assert!(w[0].from_ms > NOW - INTRADAY_MAX_AGE_MS);
    }

    #[test]
    fn a_window_in_the_future_or_empty_needs_no_request() {
        assert!(plan_windows(Interval::Minutes(5), Some(NOW + DAY_MS), Some(NOW + 2 * DAY_MS), NOW).is_empty());
    }

    // ---- request bodies ----

    #[test]
    fn daily_body_uses_an_exclusive_end_date() {
        let w = Window {
            from_ms: 1_704_167_100_000,
            to_ms: 1_704_500_000_000,
        }; // 2 Jan .. 6 Jan 2024
        let body = history_body(&inst(), Interval::Daily, w, false);
        assert_eq!(body["securityId"], "2885");
        assert_eq!(body["exchangeSegment"], "NSE_EQ");
        assert_eq!(body["instrument"], "EQUITY");
        assert_eq!(body["fromDate"], "2024-01-02");
        assert_eq!(body["toDate"], "2024-01-07", "the day after the last day wanted");
        assert!(body.get("interval").is_none());
    }

    #[test]
    fn intraday_body_carries_ist_datetimes_and_either_interval_spelling() {
        let w = Window {
            from_ms: 1_704_167_100_000,
            to_ms: 1_704_190_200_000,
        };
        let as_string = history_body(&inst(), Interval::Minutes(5), w, false);
        assert_eq!(as_string["interval"], "5");
        assert_eq!(as_string["fromDate"], "2024-01-02 09:15:00");
        assert_eq!(as_string["toDate"], "2024-01-02 15:40:00");
        assert_eq!(history_body(&inst(), Interval::Minutes(5), w, true)["interval"], 5);
    }

    // ---- errors ----

    #[test]
    fn trading_api_errors_are_classified_by_code() {
        let body = json!({"errorType":"Invalid_Authentication","errorCode":"DH-901","errorMessage":"Client ID or user generated access token is invalid or expired."});
        let e = classify_error(401, &body);
        assert_eq!(e.kind, DhanErrorKind::Auth);
        assert!(e.message().contains("fresh access token"));
        assert_eq!(
            classify_error(400, &json!({"errorCode":"DH-902","errorMessage":"no data plan"})).kind,
            DhanErrorKind::NotSubscribed
        );
        assert_eq!(
            classify_error(429, &json!({"errorCode":"DH-904"})).kind,
            DhanErrorKind::RateLimited
        );
        assert_eq!(
            classify_error(400, &json!({"errorCode":"DH-905"})).kind,
            DhanErrorKind::BadRequest
        );
        assert_eq!(
            classify_error(400, &json!({"errorCode":"DH-907","errorMessage":"no data"})).kind,
            DhanErrorKind::NoData
        );
    }

    #[test]
    fn data_api_errors_are_classified_by_numeric_key() {
        let expired = json!({"status":"failed","data":{"807":"Access token is expired"}});
        let e = classify_error(200, &expired);
        assert_eq!(e.kind, DhanErrorKind::Auth);
        assert_eq!(e.detail, "Access token is expired");
        assert_eq!(
            classify_error(200, &json!({"data":{"806":"Data APIs not subscribed"}})).kind,
            DhanErrorKind::NotSubscribed
        );
        assert_eq!(
            classify_error(200, &json!({"data":{"805":"Too many requests"}})).kind,
            DhanErrorKind::RateLimited
        );
        assert_eq!(
            classify_error(200, &json!({"data":{"813":"Invalid SecurityId"}})).kind,
            DhanErrorKind::BadRequest
        );
    }

    #[test]
    fn a_bare_http_status_still_gets_a_sensible_kind() {
        assert_eq!(classify_error(401, &json!({})).kind, DhanErrorKind::Auth);
        assert_eq!(classify_error(429, &json!(null)).kind, DhanErrorKind::RateLimited);
        assert_eq!(classify_error(503, &json!({})).kind, DhanErrorKind::Server);
        assert_eq!(classify_error(418, &json!({})).kind, DhanErrorKind::Other);
    }

    #[test]
    fn error_messages_tell_the_user_what_to_do() {
        assert!(DhanError::not_configured().message().contains("Data providers"));
        assert!(DhanError::new(DhanErrorKind::NotSubscribed, "x")
            .message()
            .contains("Data API"));
        assert!(DhanError::new(DhanErrorKind::Network, "timed out")
            .message()
            .contains("timed out"));
    }

    #[test]
    fn failure_bodies_are_recognised_even_with_a_200() {
        assert!(is_failure_body(&json!({"status":"failed","data":{"807":"x"}})));
        assert!(is_failure_body(&json!({"errorCode":"DH-901"})));
        assert!(!is_failure_body(&json!({"open":[1.0],"close":[1.0]})));
        assert!(
            is_failure_body(&json!({"data":{"807":"Access token is expired"}})),
            "no explicit status needed"
        );
        assert!(!is_failure_body(
            &json!({"status":"success","data":{"NSE_EQ":{"2885":{"last_price":1.0}}}})
        ));
    }

    // ---- history parsing ----

    fn series(timestamps: &[f64], prices: f64) -> Series {
        let n = timestamps.len();
        Series {
            timestamp: timestamps.to_vec(),
            open: vec![prices; n],
            high: vec![prices + 1.0; n],
            low: vec![prices - 1.0; n],
            close: vec![prices; n],
            volume: vec![1000.0; n],
        }
    }

    #[test]
    fn a_history_response_parses_into_parallel_arrays() {
        let body = json!({"open":[1.0,2.0],"high":[2.0,3.0],"low":[0.5,1.5],"close":[1.5,2.5],"volume":[10,20],"timestamp":[1704167100,1704253500]});
        let s = parse_history(200, &body).unwrap();
        assert_eq!(s.timestamp.len(), 2);
        assert_eq!(s.close, vec![1.5, 2.5]);
        assert_eq!(s.volume, vec![10.0, 20.0]);
    }

    #[test]
    fn a_failed_history_response_is_an_error_not_an_empty_chart() {
        let e = parse_history(
            200,
            &json!({"status":"failed","data":{"807":"Access token is expired"}}),
        )
        .unwrap_err();
        assert_eq!(e.kind, DhanErrorKind::Auth);
        assert_eq!(parse_history(401, &json!({})).unwrap_err().kind, DhanErrorKind::Auth);
    }

    // ---- timestamp shift detection ----

    #[test]
    fn plain_unix_timestamps_are_left_alone() {
        // Three daily bars in Jan 2024 inside a matching window.
        let ts = [1_704_133_800.0, 1_704_220_200.0, 1_704_306_600.0];
        let w = Window {
            from_ms: 1_704_000_000_000,
            to_ms: 1_705_000_000_000,
        };
        assert_eq!(detect_timestamp_shift(&ts, w, NOW, None), 0);
    }

    #[test]
    fn a_1980_based_epoch_is_detected_and_corrected() {
        // The same instants expressed as seconds since 1980.
        let real = [1_704_133_800.0_f64, 1_704_220_200.0, 1_704_306_600.0];
        let raw: Vec<f64> = real.iter().map(|t| t - EPOCH_1980_OFFSET_SECS as f64).collect();
        let w = Window {
            from_ms: 1_704_000_000_000,
            to_ms: 1_705_000_000_000,
        };
        assert_eq!(detect_timestamp_shift(&raw, w, NOW, None), EPOCH_1980_OFFSET_SECS);

        let (bars, shift) = series_to_bars(&series(&raw, 100.0), w, NOW, None);
        assert_eq!(shift, EPOCH_1980_OFFSET_SECS);
        assert_eq!(bars[0].time, 1_704_133_800_000);
    }

    #[test]
    fn a_long_daily_window_does_not_fool_the_1980_check_when_it_reaches_today() {
        // A history from 2005 to now contains BOTH readings of an old timestamp;
        // the newest bar decides, because under the wrong base it lands in the future.
        let now_s = NOW / 1000;
        let raw = [now_s as f64 - 86_400.0 * 30.0, now_s as f64 - 86_400.0];
        let w = Window {
            from_ms: 1_104_537_600_000,
            to_ms: NOW,
        };
        assert_eq!(detect_timestamp_shift(&raw, w, NOW, None), 0);
    }

    #[test]
    fn an_ist_as_utc_intraday_clock_is_detected_from_trading_hours() {
        // A full NSE session of 5-minute bars, 09:15..15:25 IST on 2 Jan 2024
        // (03:45..09:55 UTC)...
        let real: Vec<f64> = (0..75).map(|i| 1_704_167_100.0 + i as f64 * 300.0).collect();
        let w = Window {
            from_ms: 1_704_100_000_000,
            to_ms: 1_704_300_000_000,
        };
        assert_eq!(detect_timestamp_shift(&real, w, NOW, Some(Segment::NseEq)), 0);
        // ...and the same bars when the IST wall clock has been written as if it were UTC:
        // most of them then read as after-hours, which a −5½h shift puts right.
        let shifted: Vec<f64> = real.iter().map(|t| t + IST_OFFSET_SECS as f64).collect();
        assert_eq!(
            detect_timestamp_shift(&shifted, w, NOW, Some(Segment::NseEq)),
            -IST_OFFSET_SECS
        );
    }

    #[test]
    fn empty_input_needs_no_shift() {
        let w = Window { from_ms: 0, to_ms: NOW };
        assert_eq!(detect_timestamp_shift(&[], w, NOW, Some(Segment::NseEq)), 0);
    }

    #[test]
    fn bad_rows_are_dropped_and_the_result_is_sorted_and_unique() {
        let mut s = series(
            &[1_704_306_600.0, 1_704_133_800.0, 1_704_133_800.0, 1_704_220_200.0],
            100.0,
        );
        s.open[3] = 0.0; // a zero price would wreck the chart's scale
        s.volume[0] = 0.0; // zero volume means "none"
        let w = Window {
            from_ms: 1_704_000_000_000,
            to_ms: 1_705_000_000_000,
        };
        let (bars, _) = series_to_bars(&s, w, NOW, None);
        assert_eq!(
            bars.iter().map(|b| b.time).collect::<Vec<_>>(),
            [1_704_133_800_000, 1_704_306_600_000]
        );
        assert_eq!(bars[1].volume, None);
        assert_eq!(bars[0].volume, Some(1000.0));
    }

    #[test]
    fn ragged_arrays_use_the_shortest() {
        let mut s = series(&[1_704_133_800.0, 1_704_220_200.0], 100.0);
        s.close.pop();
        let w = Window {
            from_ms: 1_704_000_000_000,
            to_ms: 1_705_000_000_000,
        };
        assert_eq!(series_to_bars(&s, w, NOW, None).0.len(), 1);
    }

    // ---- quotes ----

    #[test]
    fn the_quote_body_groups_security_ids_by_segment() {
        let mut idx = inst();
        idx.segment = Segment::IdxI;
        idx.security_id = 13;
        let body = quote_body(&[inst(), idx]);
        assert_eq!(body["NSE_EQ"], json!([2885]));
        assert_eq!(body["IDX_I"], json!([13]));
    }

    #[test]
    fn quotes_derive_the_day_change_from_net_change() {
        let body = json!({"status":"success","data":{"NSE_EQ":{"2885":{"last_price":1226.4,"net_change":-17.5}}}});
        let q = &parse_quotes(200, &body, &[inst()]).unwrap()[0];
        assert_eq!(q.symbol, "NSE:RELIANCE");
        assert_eq!(q.price, Some(1226.4));
        assert!((q.previous_close.unwrap() - 1243.9).abs() < 1e-9);
        assert!((q.change_percent.unwrap() - (-17.5 / 1243.9 * 100.0)).abs() < 1e-9);
        assert!(q.error.is_none());
    }

    #[test]
    fn a_missing_quote_is_reported_per_symbol_not_as_a_failure() {
        let body = json!({"status":"success","data":{"NSE_EQ":{}}});
        let q = &parse_quotes(200, &body, &[inst()]).unwrap()[0];
        assert!(q.price.is_none() && q.error.is_some());
        assert!(parse_quotes(200, &json!({"data":{"807":"expired"}}), &[inst()]).is_err());
    }

    // ---- tokens ----

    fn jwt(claims: &Value) -> String {
        let enc = |v: &[u8]| URL_SAFE_NO_PAD.encode(v);
        format!(
            "{}.{}.sig",
            enc(b"{\"alg\":\"HS512\"}"),
            enc(claims.to_string().as_bytes())
        )
    }

    #[test]
    fn a_jwt_expiry_is_read_from_its_payload() {
        assert_eq!(
            token_expiry_secs(&jwt(&json!({"exp": 1_800_000_000, "dhanClientId":"1"}))),
            Some(1_800_000_000)
        );
        assert_eq!(token_expiry_secs(&jwt(&json!({"iss":"dhan"}))), None);
        assert_eq!(token_expiry_secs("not-a-jwt"), None);
        assert_eq!(token_expiry_secs("a.@@@.c"), None);
    }

    #[test]
    fn a_renewed_token_is_found_under_any_of_its_names() {
        assert_eq!(parse_renewed_token(200, &json!({"accessToken":"new"})).unwrap(), "new");
        assert_eq!(parse_renewed_token(200, &json!({"token":"new2"})).unwrap(), "new2");
        assert!(parse_renewed_token(200, &json!({"status":"ok"})).is_err());
        assert_eq!(
            parse_renewed_token(401, &json!({"errorCode":"DH-901"}))
                .unwrap_err()
                .kind,
            DhanErrorKind::Auth
        );
    }
}
