//! Parses a request, decides whether the caller may make it, and answers it.
//!
//! The listener is bound to the loopback interface, but that alone doesn't make it
//! private: any program on this machine can connect, and so can a web page open in the
//! user's browser (`fetch("http://127.0.0.1:<port>/…")`, or a DNS name that has been
//! pointed at 127.0.0.1). So every request has to prove it came from something the app
//! started:
//! - the `Host` header must name this listener — which a rebinding page can't arrange;
//! - a request with an `Origin` header is a browser's, and is refused outright;
//! - the `Authorization: Bearer` token must match. It is 256 random bits, made at launch
//!   and handed only to the scripts the app starts, and it is compared in constant time.
//!
//! Everything answered is read-only market data.

use std::collections::HashMap;
use std::sync::Arc;

use futures::future::BoxFuture;
use subtle::ConstantTimeEq;

use super::data::{BarsData, BarsRequest, MAX_LIMIT};
use super::valid_run_id;
use super::wire::{
    bars_body, error_json, InstrumentRow, ProviderStatus, ResultPost, WatchlistContent, WatchlistInfo, MAX_TITLE_CHARS,
    PNG_BASE64_PREFIX, RESULT_KINDS,
};
use super::ApiError;
use crate::store::instrument_list::Filter;
use crate::store::research_bars::canonical_interval;

/// The most instruments one listing returns.
const MAX_INSTRUMENTS: usize = 50_000;
const DEFAULT_INSTRUMENTS: usize = 5_000;
/// The largest request body: a big table or a figure, and no more. The server refuses anything
/// larger before reading it.
pub const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

/// What the routes need from the app. The real one reads the app's state; tests use a fake.
pub trait Backend: Send + Sync {
    fn providers(&self) -> Result<Vec<ProviderStatus>, ApiError>;
    fn instruments(&self, query: &InstrumentQuery) -> Result<Vec<InstrumentRow>, ApiError>;
    fn watchlists(&self) -> Result<Vec<WatchlistInfo>, ApiError>;
    fn watchlist(&self, which: &WatchlistSel) -> Result<WatchlistContent, ApiError>;
    fn bars<'a>(&'a self, request: BarsRequest) -> BoxFuture<'a, Result<BarsData, ApiError>>;
    /// Shows a result a script posted, in the app. The one thing here that isn't a read, and it
    /// only ever reaches the app's own window.
    fn publish(&self, post: ResultPost) -> Result<(), ApiError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstrumentQuery {
    pub provider: String,
    pub filter: Filter,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchlistSel {
    Id(i64),
    Name(String),
}

/// The parts of a request the routes look at.
#[derive(Debug, Clone, Default)]
pub struct Req {
    pub method: String,
    /// The request target as sent: path and query string.
    pub target: String,
    pub host: Option<String>,
    pub origin: Option<String>,
    pub authorization: Option<String>,
    pub content_type: Option<String>,
    /// Empty for a `GET`. The server reads a body only after the caller has been authorised.
    pub body: Vec<u8>,
}

pub struct Resp {
    pub status: u16,
    /// Always JSON.
    pub body: Vec<u8>,
}

pub struct Ctx {
    pub backend: Arc<dyn Backend>,
    pub token: String,
    /// The port this listener is on, for checking `Host`.
    pub port: u16,
}

pub async fn dispatch(ctx: &Ctx, req: &Req) -> Resp {
    match route(ctx, req).await {
        Ok(body) => Resp { status: 200, body },
        Err(e) => Resp {
            status: e.status,
            body: error_json(&e),
        },
    }
}

/// Whether this request came from something the app started (see the module notes). The
/// server calls it before reading a body, so a caller that hasn't proved itself can't make the
/// app buffer megabytes.
pub fn authorize(ctx: &Ctx, req: &Req) -> Result<(), ApiError> {
    let host_ok = req.host.as_deref().is_some_and(|h| {
        let h = h.trim().to_ascii_lowercase();
        h == format!("127.0.0.1:{}", ctx.port) || h == format!("localhost:{}", ctx.port)
    });
    if !host_ok {
        return Err(ApiError::new(
            403,
            "forbidden_host",
            "This API answers only to 127.0.0.1 at its own port.",
        ));
    }
    if req.origin.is_some() {
        return Err(ApiError::new(
            403,
            "forbidden_origin",
            "Browsers may not use this API; it is for scripts started from ProTradeChart.",
        ));
    }
    let presented = req
        .authorization
        .as_deref()
        .and_then(|a| {
            a.trim()
                .strip_prefix("Bearer ")
                .or_else(|| a.trim().strip_prefix("bearer "))
        })
        .unwrap_or("")
        .trim();
    if !bool::from(presented.as_bytes().ct_eq(ctx.token.as_bytes())) {
        return Err(ApiError::new(
            401,
            "unauthorized",
            "Missing or wrong API token. A script started from ProTradeChart gets one automatically (PROTRADE_TOKEN).",
        ));
    }
    Ok(())
}

async fn route(ctx: &Ctx, req: &Req) -> Result<Vec<u8>, ApiError> {
    authorize(ctx, req)?;
    let (path, query) = split_target(&req.target);
    if path == "/v1/results" {
        if !req.method.eq_ignore_ascii_case("POST") {
            return Err(ApiError::new(
                405,
                "method_not_allowed",
                "Results are posted; this route only answers POST.",
            ));
        }
        return post_result(ctx, req);
    }
    if !req.method.eq_ignore_ascii_case("GET") {
        return Err(ApiError::new(
            405,
            "method_not_allowed",
            "This API answers GET requests (and POST for results).",
        ));
    }
    match path {
        "/v1/ping" => json(&serde_json::json!({ "ok": true, "api": 1, "app": env!("CARGO_PKG_VERSION") })),
        "/v1/providers" => json(&ctx.backend.providers()?),
        "/v1/instruments" => json(&ctx.backend.instruments(&instrument_query(&query)?)?),
        "/v1/watchlists" => json(&ctx.backend.watchlists()?),
        "/v1/watchlist" => json(&ctx.backend.watchlist(&watchlist_sel(&query)?)?),
        "/v1/bars" => {
            let request = bars_request(&query)?;
            let data = ctx.backend.bars(request.clone()).await?;
            let body = bars_body(&request.symbol, &request.interval, &data);
            json(&body)
        }
        _ => Err(ApiError::not_found(format!("No such route: {path}"))),
    }
}

/// A script showing something in the app. Checked only as far as forwarding it is safe: the
/// webview owns the shape of the content and validates it before drawing.
fn post_result(ctx: &Ctx, req: &Req) -> Result<Vec<u8>, ApiError> {
    let is_json = req
        .content_type
        .as_deref()
        .is_some_and(|t| t.trim().to_ascii_lowercase().starts_with("application/json"));
    if !is_json {
        return Err(ApiError::new(
            415,
            "unsupported_media_type",
            "Post results as application/json.",
        ));
    }
    if req.body.len() > MAX_BODY_BYTES {
        return Err(too_large());
    }
    let post: ResultPost = serde_json::from_slice(&req.body)
        .map_err(|e| ApiError::bad_request(format!("That isn't a result the app can show: {e}")))?;
    if !valid_run_id(&post.run_id) {
        return Err(ApiError::bad_request(
            "runId must be the id of the run the script was started with.",
        ));
    }
    if !RESULT_KINDS.contains(&post.kind.as_str()) {
        return Err(ApiError::bad_request(format!(
            "kind must be one of {}, not '{}'.",
            RESULT_KINDS.join(", "),
            post.kind
        )));
    }
    if post
        .title
        .as_deref()
        .is_some_and(|t| t.chars().count() > MAX_TITLE_CHARS)
    {
        return Err(ApiError::bad_request(format!(
            "A title can be at most {MAX_TITLE_CHARS} characters."
        )));
    }
    if post.kind == "figure" {
        let png = post.data.get("png").and_then(|p| p.as_str()).unwrap_or("");
        if !png.starts_with(PNG_BASE64_PREFIX) {
            return Err(ApiError::bad_request("A figure must carry a base64 PNG in data.png."));
        }
    }
    ctx.backend.publish(post)?;
    json(&serde_json::json!({ "ok": true }))
}

/// The answer for a body over [`MAX_BODY_BYTES`], shared with the server.
pub fn too_large() -> ApiError {
    ApiError::new(
        413,
        "too_large",
        format!(
            "That is over the {} MB the app accepts in one result; show fewer rows, or a smaller figure.",
            MAX_BODY_BYTES / (1024 * 1024)
        ),
    )
}

fn json<T: serde::Serialize>(value: &T) -> Result<Vec<u8>, ApiError> {
    serde_json::to_vec(value).map_err(|e| ApiError::internal(format!("could not encode the answer: {e}")))
}

// ---- Parameters ------------------------------------------------------------

fn bars_request(query: &HashMap<String, String>) -> Result<BarsRequest, ApiError> {
    let symbol = query
        .get("symbol")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad_request("symbol is required, like zerodha:NSE:RELIANCE"))?;
    if super::split_symbol(symbol).is_none() {
        return Err(ApiError::bad_request(format!(
            "'{symbol}' is not a symbol: write it as provider:TICKER, like zerodha:NSE:RELIANCE"
        )));
    }
    let interval = parse_interval(query.get("interval").map(String::as_str).unwrap_or("D"))?;
    let from_ms = millis(query, "from")?;
    let to_ms = millis(query, "to")?;
    if let (Some(from), Some(to)) = (from_ms, to_ms) {
        if from > to {
            return Err(ApiError::bad_request("from is after to"));
        }
    }
    let limit = match query.get("limit") {
        None => None,
        Some(text) => Some(
            text.trim()
                .parse::<usize>()
                .ok()
                .filter(|n| (1..=MAX_LIMIT).contains(n))
                .ok_or_else(|| ApiError::bad_request(format!("limit must be a whole number from 1 to {MAX_LIMIT}")))?,
        ),
    };
    Ok(BarsRequest {
        symbol: symbol.to_string(),
        interval,
        from_ms,
        to_ms,
        limit,
    })
}

/// The store's spelling of an interval. `W` and `M` (the chart's week and month) pass
/// through so that a provider can say plainly that it doesn't serve them.
fn parse_interval(text: &str) -> Result<String, ApiError> {
    if let Some(known) = canonical_interval(text) {
        return Ok(known);
    }
    match text.trim().to_uppercase().as_str() {
        w @ ("W" | "M") => Ok(w.to_string()),
        _ => Err(ApiError::bad_request(format!(
            "'{text}' is not an interval. Use D for daily, or a number of minutes: 1, 5, 15, 60."
        ))),
    }
}

fn millis(query: &HashMap<String, String>, key: &str) -> Result<Option<i64>, ApiError> {
    match query.get(key).map(|s| s.trim()).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(text) => text
            .parse::<i64>()
            .map(Some)
            .map_err(|_| ApiError::bad_request(format!("{key} must be epoch milliseconds, not '{text}'"))),
    }
}

fn instrument_query(query: &HashMap<String, String>) -> Result<InstrumentQuery, ApiError> {
    let provider = query
        .get("provider")
        .map(|p| p.trim().to_lowercase())
        .filter(|p| !p.is_empty())
        .ok_or_else(|| ApiError::bad_request("provider is required: zerodha or dhan"))?;
    let limit = match query.get("limit") {
        None => DEFAULT_INSTRUMENTS,
        Some(text) => text
            .trim()
            .parse::<usize>()
            .ok()
            .filter(|n| *n >= 1)
            .ok_or_else(|| ApiError::bad_request("limit must be a whole number, 1 or more"))?
            .min(MAX_INSTRUMENTS),
    };
    Ok(InstrumentQuery {
        provider,
        filter: Filter {
            exchange: query.get("exchange").cloned(),
            kind: query.get("kind").cloned(),
            query: query.get("q").cloned(),
        },
        limit,
    })
}

fn watchlist_sel(query: &HashMap<String, String>) -> Result<WatchlistSel, ApiError> {
    if let Some(id) = query.get("id").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        return id
            .parse()
            .map(WatchlistSel::Id)
            .map_err(|_| ApiError::bad_request("id must be a whole number"));
    }
    match query.get("name").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(name) => Ok(WatchlistSel::Name(name.to_string())),
        None => Err(ApiError::bad_request("name or id is required")),
    }
}

// ---- The request target ----------------------------------------------------

/// Splits `/path?a=1&b=two%20words` into the path and its decoded query parameters. A
/// repeated key keeps its last value.
pub fn split_target(target: &str) -> (&str, HashMap<String, String>) {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let params = query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (percent_decode(key), percent_decode(value))
        })
        .collect();
    (path, params)
}

/// Decodes `%XX` escapes and `+` as a space. Malformed escapes are kept as written.
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' => {
                let hex = bytes.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok());
                match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    Some(byte) => {
                        out.push(byte);
                        i += 2;
                    }
                    None => out.push(b'%'),
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
pub mod testing {
    //! A canned backend, shared by this module's tests and the server's.

    use std::sync::Mutex;

    use super::*;
    use crate::models::Bar;

    #[derive(Default)]
    pub struct FakeBackend {
        pub last_bars: Mutex<Option<BarsRequest>>,
        pub last_instruments: Mutex<Option<InstrumentQuery>>,
        pub last_watchlist: Mutex<Option<WatchlistSel>>,
        pub fail_bars_with: Mutex<Option<ApiError>>,
        /// A user who has made no watchlists: none listed, and any name is not found.
        pub no_watchlists: Mutex<bool>,
        /// Every result a script posted, in order.
        pub results: Mutex<Vec<ResultPost>>,
        /// How many daily bars a request gets back: one, unless a test wants a history to work on.
        pub bar_count: Mutex<usize>,
    }

    /// `n` consecutive daily bars from 2022-01-03 (IST midnight) for `symbol`.
    ///
    /// The shape depends on the symbol, so a screen run over several finds something: one in
    /// three rises steadily to its high (above its moving average, near its 52-week high), one in
    /// three rises and then falls hard for a month (oversold), and the rest drift down in waves
    /// (crossing their moving averages, so a crossover backtest has trades). Deterministic.
    pub fn history(n: usize, symbol: &str) -> Vec<Bar> {
        const START_MS: i64 = 1_641_148_200_000;
        const CRASH_DAYS: usize = 25;
        let seed = symbol
            .bytes()
            .fold(0u32, |acc, b| acc.wrapping_mul(31).wrapping_add(u32::from(b)));
        let crash_from = n.saturating_sub(CRASH_DAYS);
        (0..n)
            .map(|i| {
                let x = i as f64;
                let close = match seed % 3 {
                    0 => 100.0 + 0.25 * x + 3.0 * (x / 15.0).sin(),
                    1 if i >= crash_from => {
                        (100.0 + 0.25 * (crash_from as f64 - 1.0)) * 0.98_f64.powi((i - crash_from + 1) as i32)
                    }
                    1 => 100.0 + 0.25 * x,
                    _ => 300.0 - 0.15 * x + 20.0 * (x / 15.0).sin(),
                };
                Bar {
                    time: START_MS + (i as i64) * 86_400_000,
                    open: close - 0.4,
                    high: close + 1.0,
                    low: close - 1.0,
                    close,
                    volume: Some(1_000.0 + x),
                }
            })
            .collect()
    }

    impl Backend for FakeBackend {
        fn providers(&self) -> Result<Vec<ProviderStatus>, ApiError> {
            Ok(vec![ProviderStatus {
                id: "zerodha",
                label: "Zerodha",
                usable: true,
            }])
        }

        fn instruments(&self, query: &InstrumentQuery) -> Result<Vec<InstrumentRow>, ApiError> {
            *self.last_instruments.lock().unwrap() = Some(query.clone());
            Ok(vec![InstrumentRow {
                symbol: "zerodha:NSE:RELIANCE".into(),
                name: Some("Reliance Industries".into()),
                exchange: "NSE".into(),
                kind: "EQUITY".into(),
                expiry: None,
            }])
        }

        fn watchlists(&self) -> Result<Vec<WatchlistInfo>, ApiError> {
            if *self.no_watchlists.lock().unwrap() {
                return Ok(vec![]);
            }
            Ok(vec![WatchlistInfo {
                id: 1,
                name: "Nifty 50".into(),
                count: 2,
            }])
        }

        fn watchlist(&self, which: &WatchlistSel) -> Result<WatchlistContent, ApiError> {
            *self.last_watchlist.lock().unwrap() = Some(which.clone());
            if *self.no_watchlists.lock().unwrap() {
                return Err(ApiError::not_found(
                    "There is no watchlist called 'Nifty 50'. You have no watchlists yet; make one in the app.",
                ));
            }
            Ok(WatchlistContent {
                id: 1,
                name: "Nifty 50".into(),
                symbols: vec![],
            })
        }

        fn bars<'a>(&'a self, request: BarsRequest) -> BoxFuture<'a, Result<BarsData, ApiError>> {
            Box::pin(async move {
                // This symbol's own, not whatever `last_bars` holds: `bars_many` asks for several
                // at once, so a shared field is another request's by the time it is read.
                let symbol = request.symbol.clone();
                *self.last_bars.lock().unwrap() = Some(request);
                if let Some(e) = self.fail_bars_with.lock().unwrap().clone() {
                    return Err(e);
                }
                let n = *self.bar_count.lock().unwrap();
                if n > 0 {
                    let bars = history(n, &symbol);
                    return Ok(BarsData {
                        covered_from_ms: bars[0].time,
                        covered_to_ms: bars[n - 1].time,
                        bars,
                        timezone: "Asia/Kolkata".into(),
                        limited_from_ms: None,
                    });
                }
                Ok(BarsData {
                    bars: vec![Bar {
                        time: 1_000,
                        open: 1.0,
                        high: 2.0,
                        low: 0.5,
                        close: 1.5,
                        volume: Some(9.0),
                    }],
                    timezone: "Asia/Kolkata".into(),
                    covered_from_ms: 0,
                    covered_to_ms: 2_000,
                    limited_from_ms: None,
                })
            })
        }

        fn publish(&self, post: ResultPost) -> Result<(), ApiError> {
            self.results.lock().unwrap().push(post);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::FakeBackend;
    use super::*;
    use serde_json::Value;

    const TOKEN: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const PORT: u16 = 45871;

    fn ctx() -> (Ctx, Arc<FakeBackend>) {
        let backend = Arc::new(FakeBackend::default());
        (
            Ctx {
                backend: backend.clone(),
                token: TOKEN.into(),
                port: PORT,
            },
            backend,
        )
    }

    /// A request that passes every check; tests break one thing at a time.
    fn get(target: &str) -> Req {
        Req {
            method: "GET".into(),
            target: target.into(),
            host: Some(format!("127.0.0.1:{PORT}")),
            origin: None,
            authorization: Some(format!("Bearer {TOKEN}")),
            content_type: None,
            body: Vec::new(),
        }
    }

    /// A results post that passes every check.
    fn post(body: &Value) -> Req {
        Req {
            method: "POST".into(),
            content_type: Some("application/json".into()),
            body: serde_json::to_vec(body).unwrap(),
            ..get("/v1/results")
        }
    }

    fn table(run: &str) -> Value {
        serde_json::json!({
            "runId": run, "kind": "table", "title": "Above 200-DMA",
            "data": { "columns": ["symbol", "close"], "rows": [["zerodha:NSE:TCS", 4000.5]] }
        })
    }

    async fn ask(ctx: &Ctx, req: &Req) -> (u16, Value) {
        let resp = dispatch(ctx, req).await;
        (resp.status, serde_json::from_slice(&resp.body).unwrap())
    }

    fn code(body: &Value) -> &str {
        body["error"]["code"].as_str().unwrap_or("")
    }

    // ---- Who may ask -------------------------------------------------------

    #[tokio::test]
    async fn a_request_with_the_token_is_answered() {
        let (ctx, _) = ctx();
        let (status, body) = ask(&ctx, &get("/v1/ping")).await;
        assert_eq!(status, 200);
        assert_eq!(body["ok"], true);
    }

    #[tokio::test]
    async fn no_token_and_a_wrong_token_are_both_unauthorized() {
        let (ctx, _) = ctx();
        for authorization in [
            None,
            Some("".to_string()),
            Some("Bearer ".to_string()),
            Some("Bearer wrong".to_string()),
            Some(TOKEN.to_string()), // right token, but not as a Bearer credential
            Some(format!("Bearer {}x", TOKEN)),
            Some(format!("Bearer {}", &TOKEN[..TOKEN.len() - 1])),
        ] {
            let mut req = get("/v1/ping");
            req.authorization = authorization.clone();
            let (status, body) = ask(&ctx, &req).await;
            assert_eq!((status, code(&body)), (401, "unauthorized"), "{authorization:?}");
        }
    }

    #[tokio::test]
    async fn the_bearer_scheme_is_not_case_sensitive() {
        let (ctx, _) = ctx();
        let mut req = get("/v1/ping");
        req.authorization = Some(format!("bearer {TOKEN}"));
        assert_eq!(ask(&ctx, &req).await.0, 200);
    }

    #[tokio::test]
    async fn a_host_that_is_not_this_listener_is_refused_even_with_the_token() {
        let (ctx, _) = ctx();
        for host in [
            None,
            Some("evil.example".to_string()),
            Some("evil.example:45871".to_string()),
            Some("127.0.0.1".to_string()),
            Some("127.0.0.1:9".to_string()),
            Some("127.0.0.1:45871.evil.example".to_string()),
        ] {
            let mut req = get("/v1/ping");
            req.host = host.clone();
            let (status, body) = ask(&ctx, &req).await;
            assert_eq!((status, code(&body)), (403, "forbidden_host"), "{host:?}");
        }
        let mut req = get("/v1/ping");
        req.host = Some(format!("LocalHost:{PORT}"));
        assert_eq!(ask(&ctx, &req).await.0, 200, "localhost is this machine too");
    }

    #[tokio::test]
    async fn a_browser_request_is_refused_even_with_the_token() {
        let (ctx, _) = ctx();
        let mut req = get("/v1/ping");
        req.origin = Some("https://evil.example".into());
        let (status, body) = ask(&ctx, &req).await;
        assert_eq!((status, code(&body)), (403, "forbidden_origin"));
    }

    #[tokio::test]
    async fn only_get_is_answered_and_unknown_routes_are_not_found() {
        let (ctx, _) = ctx();
        for method in ["POST", "PUT", "DELETE", "PATCH"] {
            let mut req = get("/v1/bars?symbol=zerodha:NSE:X");
            req.method = method.into();
            let (status, body) = ask(&ctx, &req).await;
            assert_eq!((status, code(&body)), (405, "method_not_allowed"), "{method}");
        }
        let (status, body) = ask(&ctx, &get("/v1/orders")).await;
        assert_eq!((status, code(&body)), (404, "not_found"));
        assert_eq!(ask(&ctx, &get("/")).await.0, 404);
    }

    #[tokio::test]
    async fn nothing_is_read_from_the_backend_for_a_refused_request() {
        let (ctx, backend) = ctx();
        let mut req = get("/v1/bars?symbol=zerodha:NSE:X");
        req.authorization = None;
        ask(&ctx, &req).await;
        assert!(backend.last_bars.lock().unwrap().is_none());
    }

    // ---- Results -----------------------------------------------------------

    #[tokio::test]
    async fn a_result_with_the_token_is_forwarded_to_the_app_as_posted() {
        let (ctx, backend) = ctx();
        let (status, body) = ask(&ctx, &post(&table("run-1"))).await;
        assert_eq!((status, body["ok"].as_bool()), (200, Some(true)));

        let posted = backend.results.lock().unwrap().clone();
        assert_eq!(posted.len(), 1);
        assert_eq!((posted[0].run_id.as_str(), posted[0].kind.as_str()), ("run-1", "table"));
        assert_eq!(posted[0].title.as_deref(), Some("Above 200-DMA"));
        assert_eq!(posted[0].data["rows"][0][0], "zerodha:NSE:TCS");
    }

    #[tokio::test]
    async fn a_result_is_refused_without_the_token_a_matching_host_or_with_an_origin() {
        let (ctx, backend) = ctx();
        let mut no_token = post(&table("run-1"));
        no_token.authorization = None;
        assert_eq!(ask(&ctx, &no_token).await.0, 401);

        let mut wrong_host = post(&table("run-1"));
        wrong_host.host = Some("evil.example".into());
        assert_eq!(ask(&ctx, &wrong_host).await.0, 403);

        let mut browser = post(&table("run-1"));
        browser.origin = Some("https://evil.example".into());
        assert_eq!(ask(&ctx, &browser).await.0, 403);

        assert!(backend.results.lock().unwrap().is_empty(), "nothing reached the app");
    }

    #[tokio::test]
    async fn results_are_posted_not_read() {
        let (ctx, backend) = ctx();
        for method in ["GET", "PUT", "DELETE"] {
            let mut req = post(&table("run-1"));
            req.method = method.into();
            let (status, body) = ask(&ctx, &req).await;
            assert_eq!((status, code(&body)), (405, "method_not_allowed"), "{method}");
        }
        assert!(backend.results.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn only_json_is_accepted() {
        let (ctx, backend) = ctx();
        for content_type in [
            None,
            Some("text/plain"),
            Some("application/x-www-form-urlencoded"),
            Some("multipart/form-data"),
        ] {
            let mut req = post(&table("run-1"));
            req.content_type = content_type.map(str::to_string);
            let (status, body) = ask(&ctx, &req).await;
            assert_eq!(
                (status, code(&body)),
                (415, "unsupported_media_type"),
                "{content_type:?}"
            );
        }
        assert!(backend.results.lock().unwrap().is_empty());

        let mut with_charset = post(&table("run-1"));
        with_charset.content_type = Some("Application/JSON; charset=utf-8".into());
        assert_eq!(ask(&ctx, &with_charset).await.0, 200);
    }

    #[tokio::test]
    async fn a_body_that_is_not_a_result_is_refused_with_a_reason() {
        let (ctx, backend) = ctx();
        let mut garbage = post(&table("run-1"));
        garbage.body = b"not json at all".to_vec();
        for body in [
            garbage,
            post(&serde_json::json!({})),
            post(&serde_json::json!({ "runId": "run-1", "kind": "table" })),
            post(&serde_json::json!({ "runId": 7, "kind": "table", "data": {} })),
            post(&serde_json::json!([1, 2, 3])),
        ] {
            let (status, resp) = ask(&ctx, &body).await;
            assert_eq!((status, code(&resp)), (400, "bad_request"));
            assert!(!resp["error"]["message"].as_str().unwrap().is_empty());
        }
        assert!(backend.results.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_run_the_kind_and_the_title_are_checked() {
        let (ctx, backend) = ctx();
        for run in ["", "has space", "../x", &"x".repeat(65)] {
            assert_eq!(ask(&ctx, &post(&table(run))).await.0, 400, "run id {run:?}");
        }
        let mut html = table("run-1");
        html["kind"] = "html".into();
        let (status, resp) = ask(&ctx, &post(&html)).await;
        assert_eq!(status, 400);
        assert!(resp["error"]["message"]
            .as_str()
            .unwrap()
            .contains("table, report, figure"));

        let mut long = table("run-1");
        long["title"] = "t".repeat(201).into();
        assert_eq!(ask(&ctx, &post(&long)).await.0, 400);
        long["title"] = "t".repeat(200).into();
        assert_eq!(ask(&ctx, &post(&long)).await.0, 200);
        assert_eq!(backend.results.lock().unwrap().len(), 1, "only the last was valid");
    }

    #[tokio::test]
    async fn a_result_may_have_no_title() {
        let (ctx, backend) = ctx();
        let mut untitled = table("run-1");
        untitled.as_object_mut().unwrap().remove("title");
        assert_eq!(ask(&ctx, &post(&untitled)).await.0, 200);
        assert_eq!(backend.results.lock().unwrap()[0].title, None);
    }

    #[tokio::test]
    async fn a_figure_must_be_a_png() {
        let (ctx, backend) = ctx();
        let figure = |data: Value| serde_json::json!({ "runId": "run-1", "kind": "figure", "data": data });
        for data in [
            serde_json::json!({}),
            serde_json::json!({ "png": 5 }),
            serde_json::json!({ "png": "" }),
            // An SVG and a JPEG are not PNGs, whatever they claim to be.
            serde_json::json!({ "png": "PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+" }),
            serde_json::json!({ "png": "/9j/4AAQSkZJRg==" }),
        ] {
            assert_eq!(ask(&ctx, &post(&figure(data.clone()))).await.0, 400, "{data}");
        }
        assert!(backend.results.lock().unwrap().is_empty());

        let png = serde_json::json!({ "png": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" });
        assert_eq!(ask(&ctx, &post(&figure(png))).await.0, 200);
    }

    #[tokio::test]
    async fn a_body_over_the_cap_is_refused_by_the_router_as_well_as_the_server() {
        let (ctx, backend) = ctx();
        let mut huge = post(&table("run-1"));
        huge.body = vec![b' '; MAX_BODY_BYTES + 1];
        let (status, body) = ask(&ctx, &huge).await;
        assert_eq!((status, code(&body)), (413, "too_large"));
        assert!(backend.results.lock().unwrap().is_empty());
    }

    // ---- Bars --------------------------------------------------------------

    #[tokio::test]
    async fn bars_pass_their_parameters_on_in_the_stores_spelling() {
        let (ctx, backend) = ctx();
        let (status, body) = ask(
            &ctx,
            &get("/v1/bars?symbol=zerodha%3ANSE%3ARELIANCE&interval=day&from=1000&to=2000&limit=50"),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["t"], serde_json::json!([1000]));
        assert_eq!(body["symbol"], "zerodha:NSE:RELIANCE");
        assert_eq!(body["interval"], "D");

        let seen = backend.last_bars.lock().unwrap().clone().unwrap();
        assert_eq!(
            seen,
            BarsRequest {
                symbol: "zerodha:NSE:RELIANCE".into(),
                interval: "D".into(),
                from_ms: Some(1000),
                to_ms: Some(2000),
                limit: Some(50),
            }
        );
    }

    #[tokio::test]
    async fn the_interval_defaults_to_daily_and_minutes_are_normalised() {
        let (ctx, backend) = ctx();
        ask(&ctx, &get("/v1/bars?symbol=dhan:NSE:TCS")).await;
        assert_eq!(backend.last_bars.lock().unwrap().clone().unwrap().interval, "D");
        ask(&ctx, &get("/v1/bars?symbol=dhan:NSE:TCS&interval=15minute")).await;
        assert_eq!(backend.last_bars.lock().unwrap().clone().unwrap().interval, "15");
        ask(&ctx, &get("/v1/bars?symbol=csv:X&interval=W")).await;
        assert_eq!(backend.last_bars.lock().unwrap().clone().unwrap().interval, "W");
    }

    #[tokio::test]
    async fn bad_bar_parameters_are_named_and_never_reach_the_backend() {
        let (ctx, backend) = ctx();
        for target in [
            "/v1/bars",
            "/v1/bars?symbol=",
            "/v1/bars?symbol=RELIANCE",
            "/v1/bars?symbol=zerodha:",
            "/v1/bars?symbol=zerodha:NSE:X&interval=hourly",
            "/v1/bars?symbol=zerodha:NSE:X&from=yesterday",
            "/v1/bars?symbol=zerodha:NSE:X&from=2000&to=1000",
            "/v1/bars?symbol=zerodha:NSE:X&limit=0",
            "/v1/bars?symbol=zerodha:NSE:X&limit=-3",
            "/v1/bars?symbol=zerodha:NSE:X&limit=99999999",
        ] {
            let (status, body) = ask(&ctx, &get(target)).await;
            assert_eq!((status, code(&body)), (400, "bad_request"), "{target}");
            assert!(!body["error"]["message"].as_str().unwrap().is_empty(), "{target}");
        }
        assert!(backend.last_bars.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn a_backend_failure_reaches_the_client_with_its_own_status_and_code() {
        let (ctx, backend) = ctx();
        *backend.fail_bars_with.lock().unwrap() =
            Some(ApiError::new(401, "auth", "Zerodha rejected your access token."));
        let (status, body) = ask(&ctx, &get("/v1/bars?symbol=zerodha:NSE:X")).await;
        assert_eq!((status, code(&body)), (401, "auth"));
        assert_eq!(body["error"]["message"], "Zerodha rejected your access token.");
    }

    // ---- The other routes ---------------------------------------------------

    #[tokio::test]
    async fn instruments_need_a_provider_and_carry_their_filters() {
        let (ctx, backend) = ctx();
        assert_eq!(ask(&ctx, &get("/v1/instruments")).await.0, 400);

        let (status, body) = ask(
            &ctx,
            &get("/v1/instruments?provider=Zerodha&exchange=NSE&kind=EQUITY&q=tata%20steel&limit=25"),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body[0]["symbol"], "zerodha:NSE:RELIANCE");
        let seen = backend.last_instruments.lock().unwrap().clone().unwrap();
        assert_eq!(seen.provider, "zerodha");
        assert_eq!(seen.limit, 25);
        assert_eq!(seen.filter.exchange.as_deref(), Some("NSE"));
        assert_eq!(seen.filter.kind.as_deref(), Some("EQUITY"));
        assert_eq!(seen.filter.query.as_deref(), Some("tata steel"));
    }

    #[tokio::test]
    async fn an_instrument_listing_has_a_default_and_a_ceiling() {
        let (ctx, backend) = ctx();
        ask(&ctx, &get("/v1/instruments?provider=dhan")).await;
        assert_eq!(
            backend.last_instruments.lock().unwrap().clone().unwrap().limit,
            DEFAULT_INSTRUMENTS
        );
        ask(&ctx, &get("/v1/instruments?provider=dhan&limit=9999999")).await;
        assert_eq!(
            backend.last_instruments.lock().unwrap().clone().unwrap().limit,
            MAX_INSTRUMENTS
        );
        assert_eq!(ask(&ctx, &get("/v1/instruments?provider=dhan&limit=0")).await.0, 400);
    }

    #[tokio::test]
    async fn a_watchlist_is_found_by_name_or_id() {
        let (ctx, backend) = ctx();
        assert_eq!(ask(&ctx, &get("/v1/watchlist")).await.0, 400);
        assert_eq!(ask(&ctx, &get("/v1/watchlist?id=x")).await.0, 400);

        assert_eq!(ask(&ctx, &get("/v1/watchlist?name=Nifty%2050")).await.0, 200);
        assert_eq!(
            backend.last_watchlist.lock().unwrap().clone().unwrap(),
            WatchlistSel::Name("Nifty 50".into())
        );
        assert_eq!(ask(&ctx, &get("/v1/watchlist?id=7")).await.0, 200);
        assert_eq!(
            backend.last_watchlist.lock().unwrap().clone().unwrap(),
            WatchlistSel::Id(7)
        );

        let (status, body) = ask(&ctx, &get("/v1/watchlists")).await;
        assert_eq!((status, body[0]["name"].as_str()), (200, Some("Nifty 50")));
    }

    #[tokio::test]
    async fn providers_are_listed() {
        let (ctx, _) = ctx();
        let (status, body) = ask(&ctx, &get("/v1/providers")).await;
        assert_eq!(status, 200);
        assert_eq!(body[0]["id"], "zerodha");
        assert_eq!(body[0]["usable"], true);
    }

    // ---- The target --------------------------------------------------------

    #[test]
    fn a_target_splits_into_a_path_and_decoded_parameters() {
        let (path, q) = split_target("/v1/bars?symbol=zerodha%3ANSE%3AM%26M&name=a+b%20c&flag&empty=");
        assert_eq!(path, "/v1/bars");
        assert_eq!(q["symbol"], "zerodha:NSE:M&M");
        assert_eq!(q["name"], "a b c");
        assert_eq!(q["flag"], "");
        assert_eq!(q["empty"], "");
    }

    #[test]
    fn a_target_without_a_query_has_no_parameters_and_the_last_repeat_wins() {
        let (path, q) = split_target("/v1/ping");
        assert_eq!(path, "/v1/ping");
        assert!(q.is_empty());
        assert_eq!(split_target("/x?a=1&a=2").1["a"], "2");
    }

    #[test]
    fn malformed_escapes_are_kept_and_utf8_is_decoded() {
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz%4"), "%zz%4");
        assert_eq!(percent_decode("%E2%82%B9"), "₹");
        assert_eq!(percent_decode("%2B"), "+", "an escaped plus stays a plus");
    }
}
