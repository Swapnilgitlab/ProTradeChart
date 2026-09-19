//! The pure parts of the Kite Connect integration: request planning, response
//! parsing, error mapping, and the login handshake. No I/O lives here, so all
//! of it is unit-tested; `client.rs` and `feed.rs` do the talking.

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::instruments::Instrument;
use crate::dhan::protocol::ist_datetime;
use crate::models::{Bar, Quote};

pub const BASE_URL: &str = "https://api.kite.trade";
pub const FEED_URL: &str = "wss://ws.kite.trade";
pub const LOGIN_URL: &str = "https://kite.zerodha.com/connect/login";
/// India Standard Time, the zone Kite's candle timestamps and query dates use.
pub const IST_OFFSET_SECS: i64 = 19_800;

const DAY_MS: i64 = 86_400_000;
/// Kite tokens stop working at about this time each morning (IST).
const TOKEN_RESET_HOUR_IST: i64 = 6;
/// The most windows one history call fans out into; older ones are dropped.
const MAX_CHUNKS: usize = 12;

// ---- Errors ---------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZerodhaErrorKind {
    /// Not set up: missing key, secret or token.
    NotConfigured,
    /// A bad, expired or revoked access token (Kite's `TokenException`).
    Token,
    /// The app's plan doesn't include this call (`PermissionException`).
    Permission,
    RateLimited,
    /// The request was wrong (`InputException`); Kite's own message says how.
    BadRequest,
    /// A network failure — worth falling back to the cache for.
    Network,
    Server,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZerodhaError {
    pub kind: ZerodhaErrorKind,
    /// The server's own words, when it gave any.
    pub detail: String,
}

impl ZerodhaError {
    pub fn new(kind: ZerodhaErrorKind, detail: impl Into<String>) -> Self {
        ZerodhaError {
            kind,
            detail: detail.into(),
        }
    }

    pub fn not_configured() -> Self {
        ZerodhaError::new(ZerodhaErrorKind::NotConfigured, "")
    }

    /// What to show the user, including what to do about it.
    pub fn message(&self) -> String {
        let detail = self.detail.trim();
        match self.kind {
            ZerodhaErrorKind::NotConfigured => "Zerodha isn't set up. Open Data providers, enter your API key and \
                 secret, log in, and turn Zerodha on."
                .to_string(),
            ZerodhaErrorKind::Token => "Zerodha rejected your access token. Kite tokens expire every morning around \
                 6 AM — open Data providers and log in again."
                .to_string(),
            ZerodhaErrorKind::Permission if detail.is_empty() => {
                "Your Kite Connect plan doesn't include this data.".to_string()
            }
            ZerodhaErrorKind::Permission => format!(
                "Your Kite Connect plan doesn't include this data ({detail}). Historical data and quotes need \
                 Zerodha's paid Kite Connect subscription."
            ),
            ZerodhaErrorKind::RateLimited => "Zerodha is rate limiting requests — try again in a moment.".to_string(),
            ZerodhaErrorKind::Network => format!("Couldn't reach Zerodha: {detail}"),
            _ if detail.is_empty() => "Zerodha returned an error.".to_string(),
            _ => format!("Zerodha: {detail}"),
        }
    }
}

impl std::fmt::Display for ZerodhaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

/// Maps an error response to a `ZerodhaError`. Kite says what went wrong in
/// `error_type`; the HTTP status is the fallback.
pub fn classify_error(status: u16, body: &Value) -> ZerodhaError {
    let detail = body.get("message").and_then(Value::as_str).unwrap_or("").to_string();
    let kind = if status == 429 {
        ZerodhaErrorKind::RateLimited
    } else {
        match body.get("error_type").and_then(Value::as_str) {
            Some("TokenException") => ZerodhaErrorKind::Token,
            Some("PermissionException") => ZerodhaErrorKind::Permission,
            Some("InputException") => ZerodhaErrorKind::BadRequest,
            Some("NetworkException" | "DataException" | "GeneralException") => ZerodhaErrorKind::Server,
            _ => match status {
                401 | 403 => ZerodhaErrorKind::Token,
                400..=499 => ZerodhaErrorKind::BadRequest,
                500..=599 => ZerodhaErrorKind::Server,
                _ => ZerodhaErrorKind::Other,
            },
        }
    };
    ZerodhaError::new(kind, detail)
}

/// Kite reports failures as `{"status":"error", …}`, normally with a 4xx/5xx.
pub fn is_failure_body(body: &Value) -> bool {
    body.get("status").and_then(Value::as_str) == Some("error")
}

fn check(status: u16, body: &Value) -> Result<(), ZerodhaError> {
    if status >= 400 || is_failure_body(body) {
        return Err(classify_error(status, body));
    }
    Ok(())
}

// ---- Time ------------------------------------------------------------------

/// Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Epoch milliseconds of a Kite candle timestamp, `2017-12-15T09:15:00+0530`.
/// The offset may be written `+0530`, `+05:30` or `Z`.
pub fn parse_candle_time(text: &str) -> Option<i64> {
    let (date, rest) = text.trim().split_once(['T', ' '])?;
    let mut d = date.split('-');
    let (y, m, day): (i64, u32, u32) = (
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
    );
    if d.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&day) {
        return None;
    }
    let clock = rest.get(..8)?;
    let mut c = clock.split(':');
    let (h, min, s): (i64, i64, i64) = (
        c.next()?.parse().ok()?,
        c.next()?.parse().ok()?,
        c.next()?.parse().ok()?,
    );
    if h > 23 || min > 59 || s > 60 {
        return None;
    }
    let zone = rest.get(8..)?;
    let offset_secs = match zone {
        "" | "Z" => 0,
        _ => {
            let sign = match zone.as_bytes().first()? {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let digits: String = zone[1..].chars().filter(char::is_ascii_digit).collect();
            if digits.len() != 4 {
                return None;
            }
            sign * (digits[..2].parse::<i64>().ok()? * 3600 + digits[2..].parse::<i64>().ok()? * 60)
        }
    };
    Some((days_from_civil(y, m, day) * 86_400 + h * 3600 + min * 60 + s - offset_secs) * 1000)
}

/// When a token saved at `saved_at_ms` most likely stops working: the next
/// 06:00 IST. Kite gives no expiry with the token, so this is an estimate.
pub fn token_expiry_estimate_secs(saved_at_ms: i64) -> i64 {
    let ist = saved_at_ms.div_euclid(1000) + IST_OFFSET_SECS;
    let (day, into_day) = (ist.div_euclid(86_400), ist.rem_euclid(86_400));
    let expiry_day = if into_day < TOKEN_RESET_HOUR_IST * 3600 {
        day
    } else {
        day + 1
    };
    expiry_day * 86_400 + TOKEN_RESET_HOUR_IST * 3600 - IST_OFFSET_SECS
}

// ---- History requests ------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Interval {
    Minutes(u32),
    Day,
}

/// The minute bar sizes Kite serves natively.
pub const NATIVE_MINUTES: [u32; 7] = [1, 3, 5, 10, 15, 30, 60];

impl Interval {
    /// Accepts the frontend's spelling (`D`, `5`) and Kite's own (`day`, `5minute`).
    pub fn parse(text: &str) -> Option<Interval> {
        let t = text.trim().to_lowercase();
        if t.is_empty() {
            return None;
        }
        if matches!(t.as_str(), "d" | "day" | "1d" | "daily") {
            return Some(Interval::Day);
        }
        let digits = t.strip_suffix("minute").unwrap_or(&t);
        let minutes = if digits.is_empty() {
            1
        } else {
            digits.parse::<u32>().ok()?
        };
        NATIVE_MINUTES.contains(&minutes).then_some(Interval::Minutes(minutes))
    }

    /// The name used in the URL: `minute`, `3minute` … `60minute`, `day`.
    pub fn api_name(self) -> String {
        match self {
            Interval::Day => "day".to_string(),
            Interval::Minutes(1) => "minute".to_string(),
            Interval::Minutes(n) => format!("{n}minute"),
        }
    }

    /// The most calendar days one request may span (Kite's documented limits).
    fn max_window_days(self) -> i64 {
        match self {
            Interval::Minutes(1) => 60,
            Interval::Minutes(3 | 5 | 10) => 100,
            Interval::Minutes(15 | 30) => 200,
            Interval::Minutes(_) => 400,
            Interval::Day => 2000,
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

/// Splits `[from, to]` into requests Kite will accept, oldest first. With no
/// `from`, one full window ending at `to` is asked for. A span too long to
/// cover with `MAX_CHUNKS` windows keeps the newest ones.
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

pub fn history_path(inst: &Instrument, interval: Interval) -> String {
    format!("/instruments/historical/{}/{}", inst.token, interval.api_name())
}

/// Futures contracts get a new token every expiry. For daily candles on NFO and
/// MCX futures, `continuous=1` stitches the expired contracts on, so a chart
/// goes back years instead of to the current contract's listing.
fn wants_continuous(inst: &Instrument, interval: Interval) -> bool {
    interval == Interval::Day && inst.instrument == "FUT" && matches!(inst.exchange.as_str(), "NFO" | "MCX")
}

/// The query string for one history window; dates are exchange time (IST).
pub fn history_query(inst: &Instrument, interval: Interval, window: Window) -> Vec<(&'static str, String)> {
    let mut query = vec![
        ("from", ist_datetime(window.from_ms)),
        ("to", ist_datetime(window.to_ms)),
    ];
    if wants_continuous(inst, interval) {
        query.push(("continuous", "1".to_string()));
    }
    query
}

/// Parses a history response: `data.candles` is an array of
/// `[timestamp, open, high, low, close, volume(, oi)]`. A candle that can't be
/// read is skipped rather than failing the chart. Zero volume (an index) is
/// reported as no volume, so the chart doesn't draw an empty volume pane.
pub fn parse_candles(status: u16, body: &Value) -> Result<Vec<Bar>, ZerodhaError> {
    check(status, body)?;
    let candles = body
        .pointer("/data/candles")
        .and_then(Value::as_array)
        .ok_or_else(|| ZerodhaError::new(ZerodhaErrorKind::Other, "the history response had no candles"))?;

    let mut bars: Vec<Bar> = candles
        .iter()
        .filter_map(|c| {
            let c = c.as_array()?;
            let time = parse_candle_time(c.first()?.as_str()?)?;
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

/// Builds quotes from a `/quote/ohlc` response: `data` is keyed by the
/// `EXCHANGE:SYMBOL` names that were asked for, each with `last_price` and an
/// `ohlc` block whose `close` is the previous session's close. One quote per
/// requested instrument, in order; one Kite doesn't answer for says so.
pub fn parse_quotes(status: u16, body: &Value, requested: &[Instrument]) -> Result<Vec<Quote>, ZerodhaError> {
    check(status, body)?;
    let data = body.get("data").and_then(Value::as_object);
    Ok(requested
        .iter()
        .map(|inst| {
            let entry = data.and_then(|d| d.get(&inst.quote_key()));
            let price = entry
                .and_then(|e| e.get("last_price"))
                .and_then(Value::as_f64)
                .filter(|p| *p > 0.0);
            let previous = entry
                .and_then(|e| e.pointer("/ohlc/close"))
                .and_then(Value::as_f64)
                .filter(|p| *p > 0.0);
            let error = match (entry, price) {
                (None, _) => Some("Zerodha has no quote for it".to_string()),
                (Some(_), None) => Some("no price yet".to_string()),
                _ => None,
            };
            Quote {
                symbol: inst.ticker.clone(),
                price,
                previous_close: previous,
                change_percent: match (price, previous) {
                    (Some(p), Some(c)) => Some((p - c) / c * 100.0),
                    _ => None,
                },
                currency: Some("INR".to_string()),
                error,
            }
        })
        .collect())
}

// ---- Login -----------------------------------------------------------------

/// The page where the user logs in to Zerodha; it redirects to the app's
/// registered redirect URL with a one-time `request_token`.
pub fn login_url(api_key: &str) -> String {
    let mut url = reqwest::Url::parse(LOGIN_URL).expect("static URL is valid");
    url.query_pairs_mut()
        .append_pair("v", "3")
        .append_pair("api_key", api_key);
    url.to_string()
}

/// The checksum Kite wants with a token exchange: `SHA-256(api_key +
/// request_token + api_secret)`, in hex.
pub fn checksum(api_key: &str, request_token: &str, api_secret: &str) -> String {
    let digest = Sha256::digest(format!("{api_key}{request_token}{api_secret}").as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Pulls the `request_token` out of whatever the user pasted: the whole address
/// Zerodha redirected to (`http://…/?request_token=…&action=login&status=success`)
/// or just the token.
pub fn extract_request_token(text: &str) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Paste the address Zerodha sent you to after logging in, or just its request_token.".into());
    }
    let token = match text.find("request_token=") {
        Some(at) => {
            if text.contains("status=error") {
                return Err("Zerodha reported that the login failed. Try logging in again.".into());
            }
            text[at + "request_token=".len()..]
                .split(['&', '#', ' ', '\n'])
                .next()
                .unwrap_or("")
        }
        None => text,
    };
    // Real request tokens are 32 alphanumeric characters; be lenient on length
    // but strict about what a token can contain, so a stray URL is refused.
    if token.len() < 10 || !token.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(
            "That doesn't look like a request token. After logging in, copy the whole address from your browser's \
             address bar — it contains request_token=…"
                .into(),
        );
    }
    Ok(token.to_string())
}

/// Reads the access token out of a `/session/token` response.
pub fn parse_session(status: u16, body: &Value) -> Result<String, ZerodhaError> {
    check(status, body)?;
    body.pointer("/data/access_token")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .ok_or_else(|| ZerodhaError::new(ZerodhaErrorKind::Other, "the login response had no access token"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_800_000_000_000;

    fn inst(exchange: &str, kind: &str, symbol: &str) -> Instrument {
        Instrument {
            ticker: format!("{exchange}:{}", symbol.replace(' ', "_")),
            exchange: exchange.into(),
            token: 738561,
            instrument: kind.into(),
            symbol: symbol.into(),
            name: None,
            expiry: None,
        }
    }

    // ---- errors ----

    #[test]
    fn real_error_bodies_are_classified_by_their_error_type() {
        // Captured from the live service with a made-up key.
        let token = json!({"status":"error","message":"Incorrect `api_key` or `access_token`.","data":null,"error_type":"TokenException"});
        let e = classify_error(403, &token);
        assert_eq!(e.kind, ZerodhaErrorKind::Token);
        assert!(e.message().contains("log in again"), "{}", e.message());

        let input = json!({"status":"error","message":"`request_token` should be minimum 10 characters in length.","data":null,"error_type":"InputException"});
        let e = classify_error(400, &input);
        assert_eq!(e.kind, ZerodhaErrorKind::BadRequest);
        assert!(e.message().contains("minimum 10 characters"), "{}", e.message());

        let perm = json!({"status":"error","message":"Insufficient permission for that call.","error_type":"PermissionException"});
        let e = classify_error(403, &perm);
        assert_eq!(e.kind, ZerodhaErrorKind::Permission);
        assert!(e.message().contains("paid Kite Connect"), "{}", e.message());
    }

    #[test]
    fn rate_limits_server_errors_and_bare_statuses_are_recognised() {
        let limited = json!({"status":"error","message":"Too many requests","error_type":"NetworkException"});
        assert_eq!(classify_error(429, &limited).kind, ZerodhaErrorKind::RateLimited);
        let general = json!({"status":"error","message":"Something went wrong","error_type":"GeneralException"});
        assert_eq!(classify_error(500, &general).kind, ZerodhaErrorKind::Server);
        assert_eq!(classify_error(403, &Value::Null).kind, ZerodhaErrorKind::Token);
        assert_eq!(classify_error(404, &Value::Null).kind, ZerodhaErrorKind::BadRequest);
        assert_eq!(classify_error(503, &Value::Null).kind, ZerodhaErrorKind::Server);
    }

    #[test]
    fn a_failure_body_is_an_error_even_on_a_200() {
        assert!(is_failure_body(&json!({"status":"error","message":"x"})));
        assert!(!is_failure_body(&json!({"status":"success","data":{}})));
        assert!(parse_candles(
            200,
            &json!({"status":"error","message":"nope","error_type":"InputException"})
        )
        .is_err());
    }

    // ---- time ----

    #[test]
    fn candle_timestamps_are_read_with_their_offset() {
        // 09:15 IST on 15 Dec 2017 is 03:45 UTC.
        let expect = Date::utc(2017, 12, 15, 3, 45);
        assert_eq!(parse_candle_time("2017-12-15T09:15:00+0530"), Some(expect));
        assert_eq!(parse_candle_time("2017-12-15T09:15:00+05:30"), Some(expect));
        assert_eq!(parse_candle_time("2017-12-15T03:45:00Z"), Some(expect));
        assert_eq!(parse_candle_time("2017-12-15 09:15:00+0530"), Some(expect));
        // A daily candle is stamped at IST midnight, which is the previous evening in UTC.
        assert_eq!(
            parse_candle_time("2024-01-02T00:00:00+0530"),
            Some(Date::utc(2024, 1, 1, 18, 30))
        );
        assert_eq!(
            parse_candle_time("2024-03-10T09:15:00-0500"),
            Some(Date::utc(2024, 3, 10, 14, 15))
        );
    }

    #[test]
    fn nonsense_timestamps_are_rejected() {
        for bad in [
            "",
            "2017-12-15",
            "yesterday",
            "2017-13-15T09:15:00+0530",
            "2017-12-15T25:15:00+0530",
            "2017-12-15T09:15:00+05",
        ] {
            assert_eq!(parse_candle_time(bad), None, "{bad:?}");
        }
    }

    /// A tiny civil-time helper so the expected values read as dates.
    struct Date;
    impl Date {
        fn utc(y: i64, m: u32, d: u32, h: i64, min: i64) -> i64 {
            (days_from_civil(y, m, d) * 86_400 + h * 3600 + min * 60) * 1000
        }
    }

    #[test]
    fn a_token_is_estimated_to_last_until_the_next_six_am_ist() {
        // Saved 10:00 IST on 19 Sep: expires 06:00 IST on the 20th (00:30 UTC).
        let saved = Date::utc(2026, 9, 19, 4, 30);
        assert_eq!(token_expiry_estimate_secs(saved) * 1000, Date::utc(2026, 9, 20, 0, 30));
        // Saved 03:00 IST, before the reset: that very morning.
        let early = Date::utc(2026, 9, 18, 21, 30);
        assert_eq!(token_expiry_estimate_secs(early) * 1000, Date::utc(2026, 9, 19, 0, 30));
        // Saved 23:00 IST: the following morning.
        let late = Date::utc(2026, 9, 19, 17, 30);
        assert_eq!(token_expiry_estimate_secs(late) * 1000, Date::utc(2026, 9, 20, 0, 30));
    }

    // ---- intervals and windows ----

    #[test]
    fn intervals_parse_from_both_spellings() {
        assert_eq!(Interval::parse("D"), Some(Interval::Day));
        assert_eq!(Interval::parse("day"), Some(Interval::Day));
        assert_eq!(Interval::parse("5"), Some(Interval::Minutes(5)));
        assert_eq!(Interval::parse("minute"), Some(Interval::Minutes(1)));
        assert_eq!(Interval::parse("15minute"), Some(Interval::Minutes(15)));
        assert_eq!(Interval::parse("60"), Some(Interval::Minutes(60)));
        for bad in ["", "2", "25", "120", "week", "minutes", "x"] {
            assert_eq!(Interval::parse(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn interval_names_match_kites_urls() {
        assert_eq!(Interval::Minutes(1).api_name(), "minute");
        assert_eq!(Interval::Minutes(3).api_name(), "3minute");
        assert_eq!(Interval::Minutes(60).api_name(), "60minute");
        assert_eq!(Interval::Day.api_name(), "day");
        for n in NATIVE_MINUTES {
            assert_eq!(
                Interval::parse(&Interval::Minutes(n).api_name()),
                Some(Interval::Minutes(n))
            );
        }
    }

    #[test]
    fn a_short_range_is_one_window() {
        let w = plan_windows(Interval::Minutes(5), Some(NOW - 10 * DAY_MS), Some(NOW), NOW);
        assert_eq!(
            w,
            vec![Window {
                from_ms: NOW - 10 * DAY_MS,
                to_ms: NOW
            }]
        );
    }

    #[test]
    fn a_long_range_is_split_to_the_documented_limits_and_covers_it_exactly() {
        // 400 days of 1-minute data: limit 60 days -> 7 windows of at most 59.
        let (from, to) = (NOW - 400 * DAY_MS, NOW);
        let w = plan_windows(Interval::Minutes(1), Some(from), Some(to), NOW);
        assert_eq!(w.len(), 7);
        assert_eq!(w.first().unwrap().from_ms, from);
        assert_eq!(w.last().unwrap().to_ms, to);
        assert!(w.iter().all(|x| x.to_ms - x.from_ms <= 59 * DAY_MS));
        assert!(w.windows(2).all(|p| p[0].to_ms == p[1].from_ms), "no gaps");
    }

    #[test]
    fn each_interval_uses_its_own_limit() {
        let one_year = Some(NOW - 365 * DAY_MS);
        let n = |i| plan_windows(i, one_year, Some(NOW), NOW).len();
        assert_eq!(n(Interval::Minutes(1)), 7); // 59-day windows
        assert_eq!(n(Interval::Minutes(5)), 4); // 99
        assert_eq!(n(Interval::Minutes(30)), 2); // 199
        assert_eq!(n(Interval::Minutes(60)), 1); // 399
        assert_eq!(n(Interval::Day), 1); // 1999
    }

    #[test]
    fn without_a_start_one_full_window_ending_at_to_is_asked_for() {
        let w = plan_windows(Interval::Day, None, Some(NOW), NOW);
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].to_ms, NOW);
        assert_eq!(w[0].to_ms - w[0].from_ms, 1999 * DAY_MS);
    }

    #[test]
    fn the_future_and_empty_ranges_are_handled() {
        // `to` in the future is clamped to now.
        let w = plan_windows(Interval::Day, Some(NOW - DAY_MS), Some(NOW + 10 * DAY_MS), NOW);
        assert_eq!(w[0].to_ms, NOW);
        assert!(plan_windows(Interval::Day, Some(NOW), Some(NOW), NOW).is_empty());
        assert!(plan_windows(Interval::Day, Some(NOW + 1), None, NOW).is_empty());
    }

    #[test]
    fn a_huge_range_keeps_only_the_newest_windows() {
        let w = plan_windows(Interval::Minutes(1), Some(1), Some(NOW), NOW);
        assert_eq!(w.len(), MAX_CHUNKS);
        assert_eq!(w.last().unwrap().to_ms, NOW);
    }

    #[test]
    fn history_requests_use_the_instrument_token_and_ist_dates() {
        let i = inst("NSE", "EQUITY", "RELIANCE");
        assert_eq!(
            history_path(&i, Interval::Minutes(5)),
            "/instruments/historical/738561/5minute"
        );
        assert_eq!(history_path(&i, Interval::Day), "/instruments/historical/738561/day");
        // 2023-11-14 22:13:20 UTC is 03:43:20 IST on the 15th.
        let q = history_query(
            &i,
            Interval::Day,
            Window {
                from_ms: 1_700_000_000_000,
                to_ms: 1_700_100_000_000,
            },
        );
        assert_eq!(q[0], ("from", "2023-11-15 03:43:20".to_string()));
        assert_eq!(q[1].0, "to");
        assert_eq!(q.len(), 2, "no continuous flag for a stock");
    }

    #[test]
    fn daily_futures_on_nfo_and_mcx_ask_for_continuous_data() {
        let w = Window { from_ms: 0, to_ms: NOW };
        let flag = |i: &Instrument, iv| history_query(i, iv, w).contains(&("continuous", "1".to_string()));
        assert!(flag(&inst("NFO", "FUT", "NIFTY26SEPFUT"), Interval::Day));
        assert!(flag(&inst("MCX", "FUT", "GOLD26OCTFUT"), Interval::Day));
        assert!(
            !flag(&inst("NFO", "FUT", "NIFTY26SEPFUT"), Interval::Minutes(5)),
            "continuous is a daily feature"
        );
        assert!(
            !flag(&inst("CDS", "FUT", "USDINR26SEPFUT"), Interval::Day),
            "only NFO and MCX are documented"
        );
        assert!(!flag(&inst("NSE", "EQUITY", "RELIANCE"), Interval::Day));
    }

    // ---- candles ----

    fn candles_body() -> Value {
        // The example from Kite's documentation.
        json!({"status":"success","data":{"candles":[
            ["2017-12-15T09:15:00+0530",1704.5,1705,1699.25,1702.8,2499],
            ["2017-12-15T09:16:00+0530",1702,1702,1698.15,1698.15,1271],
            ["2017-12-15T09:17:00+0530",1698.15,1700.25,1698,1699.25,831]
        ]}})
    }

    #[test]
    fn the_documented_example_parses_into_bars() {
        let bars = parse_candles(200, &candles_body()).unwrap();
        assert_eq!(bars.len(), 3);
        assert_eq!(bars[0].time, Date::utc(2017, 12, 15, 3, 45));
        assert_eq!(bars[1].time - bars[0].time, 60_000);
        assert_eq!(
            (bars[0].open, bars[0].high, bars[0].low, bars[0].close),
            (1704.5, 1705.0, 1699.25, 1702.8)
        );
        assert_eq!(bars[0].volume, Some(2499.0));
    }

    #[test]
    fn oi_candles_with_a_seventh_column_still_parse() {
        let body = json!({"status":"success","data":{"candles":[
            ["2019-12-04T09:15:00+0530",12009.9,12019.35,12001.25,12001.5,163275,13667775]]}});
        let bars = parse_candles(200, &body).unwrap();
        assert_eq!((bars[0].close, bars[0].volume), (12001.5, Some(163275.0)));
    }

    #[test]
    fn candles_are_sorted_deduplicated_and_unreadable_ones_skipped() {
        let body = json!({"status":"success","data":{"candles":[
            ["2024-01-03T00:00:00+0530",2,3,1,2.5,10],
            ["2024-01-02T00:00:00+0530",1,2,0.5,1.5,20],
            ["2024-01-02T00:00:00+0530",1,2,0.5,1.6,21],
            ["not a time",1,1,1,1,1],
            ["2024-01-04T00:00:00+0530",null,2,1,1.5,5],
            "junk"
        ]}});
        let bars = parse_candles(200, &body).unwrap();
        assert_eq!(bars.len(), 2);
        assert!(bars[0].time < bars[1].time);
    }

    #[test]
    fn zero_volume_means_no_volume() {
        let body =
            json!({"status":"success","data":{"candles":[["2024-01-02T09:15:00+0530",21000,21050,20990,21010,0]]}});
        assert_eq!(parse_candles(200, &body).unwrap()[0].volume, None);
    }

    #[test]
    fn an_empty_window_is_an_empty_result_not_an_error() {
        let body = json!({"status":"success","data":{"candles":[]}});
        assert!(parse_candles(200, &body).unwrap().is_empty());
    }

    #[test]
    fn a_response_with_no_candles_field_or_a_token_error_is_an_error() {
        assert!(parse_candles(200, &json!({"status":"success","data":{}})).is_err());
        let token = json!({"status":"error","message":"x","error_type":"TokenException"});
        assert_eq!(parse_candles(403, &token).unwrap_err().kind, ZerodhaErrorKind::Token);
    }

    // ---- quotes ----

    #[test]
    fn quotes_compute_the_day_change_from_the_previous_close() {
        let requested = [inst("NSE", "EQUITY", "INFY"), inst("NSE", "INDEX", "NIFTY 50")];
        let body = json!({"status":"success","data":{
            "NSE:INFY":{"instrument_token":408065,"last_price":1075,"ohlc":{"open":1000,"high":1080,"low":990,"close":1050}},
            "NSE:NIFTY 50":{"instrument_token":256265,"last_price":25000,"ohlc":{"open":24900,"high":25100,"low":24850,"close":25100}}
        }});
        let q = parse_quotes(200, &body, &requested).unwrap();
        assert_eq!(q[0].symbol, "NSE:INFY");
        assert_eq!((q[0].price, q[0].previous_close), (Some(1075.0), Some(1050.0)));
        assert!((q[0].change_percent.unwrap() - 2.380952).abs() < 1e-4);
        assert_eq!(
            q[1].symbol, "NSE:NIFTY_50",
            "answered under the trading symbol's spelling, reported under the ticker"
        );
        assert!((q[1].change_percent.unwrap() - (-0.398406)).abs() < 1e-4);
        assert!(q
            .iter()
            .all(|x| x.error.is_none() && x.currency.as_deref() == Some("INR")));
    }

    #[test]
    fn an_instrument_kite_does_not_answer_for_says_so_and_the_rest_are_unaffected() {
        let requested = [inst("NSE", "EQUITY", "INFY"), inst("NSE", "EQUITY", "GONE")];
        let body = json!({"status":"success","data":{"NSE:INFY":{"last_price":1075,"ohlc":{"close":1050}}}});
        let q = parse_quotes(200, &body, &requested).unwrap();
        assert!(q[0].error.is_none());
        assert_eq!(q[1].error.as_deref(), Some("Zerodha has no quote for it"));
        assert_eq!(q[1].price, None);
    }

    #[test]
    fn a_quote_with_no_trades_yet_has_no_price() {
        let requested = [inst("NSE", "EQUITY", "INFY")];
        let body = json!({"status":"success","data":{"NSE:INFY":{"last_price":0,"ohlc":{"close":1050}}}});
        let q = &parse_quotes(200, &body, &requested).unwrap()[0];
        assert_eq!((q.price, q.change_percent), (None, None));
        assert_eq!(q.error.as_deref(), Some("no price yet"));
    }

    #[test]
    fn a_rejected_quote_request_is_an_error_for_the_whole_call() {
        let requested = [inst("NSE", "EQUITY", "INFY")];
        let body =
            json!({"status":"error","message":"Incorrect `api_key` or `access_token`.","error_type":"TokenException"});
        assert_eq!(
            parse_quotes(403, &body, &requested).unwrap_err().kind,
            ZerodhaErrorKind::Token
        );
    }

    // ---- login ----

    #[test]
    fn the_login_url_carries_the_api_key() {
        let url = login_url("my key&1");
        assert!(url.starts_with("https://kite.zerodha.com/connect/login?"), "{url}");
        assert!(url.contains("v=3"), "{url}");
        assert!(
            url.contains("api_key=my+key%261"),
            "the key is encoded, not spliced in: {url}"
        );
    }

    #[test]
    fn the_checksum_is_the_sha256_of_key_token_and_secret() {
        // Known SHA-256 of "abc".
        assert_eq!(
            checksum("a", "b", "c"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(checksum("k", "t", "s").len(), 64);
        assert_ne!(checksum("k", "t", "s"), checksum("k", "t", "S"));
    }

    #[test]
    fn a_request_token_is_found_in_the_redirect_address_or_pasted_bare() {
        let token = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
        let full = format!("http://127.0.0.1:5000/callback?request_token={token}&action=login&status=success");
        assert_eq!(extract_request_token(&full).unwrap(), token);
        assert_eq!(extract_request_token(&format!("  {token}\n")).unwrap(), token);
        assert_eq!(extract_request_token(&format!("request_token={token}")).unwrap(), token);
        assert_eq!(
            extract_request_token(&format!(
                "https://example.com/?status=success&request_token={token}#top"
            ))
            .unwrap(),
            token
        );
    }

    #[test]
    fn junk_and_failed_logins_are_refused_with_an_explanation() {
        assert!(extract_request_token("").is_err());
        assert!(extract_request_token("http://127.0.0.1/?action=login")
            .unwrap_err()
            .contains("request token"));
        assert!(extract_request_token("short").is_err());
        assert!(extract_request_token("has spaces in it and more").is_err());
        let failed = "http://127.0.0.1/?request_token=A1b2C3d4E5f6G7h8&status=error";
        assert!(extract_request_token(failed).unwrap_err().contains("failed"));
    }

    #[test]
    fn a_session_response_yields_the_access_token() {
        let ok = json!({"status":"success","data":{"user_id":"AB1234","access_token":"tok_123","public_token":"x"}});
        assert_eq!(parse_session(200, &ok).unwrap(), "tok_123");
        let bad = json!({"status":"error","message":"Token is invalid or has expired.","error_type":"TokenException"});
        assert_eq!(parse_session(403, &bad).unwrap_err().kind, ZerodhaErrorKind::Token);
        assert!(parse_session(200, &json!({"status":"success","data":{}})).is_err());
    }
}
