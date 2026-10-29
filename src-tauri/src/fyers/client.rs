//! FYERS API v3 over HTTP: history, quotes, the login and renewal exchanges, the profile (the test
//! button) and the public symbol master.
//!
//! Every data call (history and quotes share FYERS's one data allowance) goes through one throttle,
//! paced for the account's plan, and is counted against the day's [`Budget`] first. FYERS blocks an
//! account for the rest of the day once it has gone over the per-minute limit more than three times,
//! so a rate-limit answer is not retried quickly, as Kite's is: the client waits for the next minute
//! and tries once more, then gives up.

use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;
use tokio::time::sleep;

use super::budget::{Budget, Usage};
use super::instruments::{Instrument, MASTERS};
use super::protocol::history_query;
use super::protocol::{
    app_id_hash, classify_error, is_failure_body, parse_candles, parse_day_snapshots, parse_profile, parse_quotes,
    parse_session, parse_ticks, plan_windows, quotes_query, refresh_body, validate_authcode_body, FyersError,
    FyersErrorKind, Interval, Plan, QuoteTick, Session, API_URL, DATA_URL, QUOTE_BATCH, SYMBOL_MASTER_URL,
};
use crate::db::now_ms;
use crate::models::{Bar, DaySnapshot, Quote};
use crate::throttle::{current_lane, Throttle};

#[derive(Debug, Clone)]
pub struct Credentials {
    pub app_id: String,
    pub access_token: String,
}

/// Where the client talks to, and how it waits: production values by default, tests shrink them.
#[derive(Debug, Clone)]
pub struct Endpoints {
    pub api: String,
    pub data: String,
    pub master: String,
    /// The wait after a rate-limit answer; `None` waits for the next minute, plus a margin.
    pub rate_limit_wait: Option<Duration>,
    /// Overrides the plan's pace (tests run with none).
    pub gap: Option<Duration>,
}

impl Default for Endpoints {
    fn default() -> Self {
        Endpoints {
            api: API_URL.to_string(),
            data: DATA_URL.to_string(),
            master: SYMBOL_MASTER_URL.to_string(),
            rate_limit_wait: None,
            gap: None,
        }
    }
}

pub struct FyersClient {
    http: reqwest::Client,
    endpoints: Endpoints,
    data: Throttle,
    plan: Mutex<Plan>,
    budget: Mutex<Budget>,
}

fn network(e: reqwest::Error) -> FyersError {
    FyersError::new(FyersErrorKind::Network, e.to_string())
}

/// How long until the next minute begins on FYERS's clock (taken to be ours), plus a margin.
fn until_next_minute(now_ms: i64) -> Duration {
    Duration::from_millis((60_000 - now_ms.rem_euclid(60_000) + 2_000) as u64)
}

impl FyersClient {
    pub fn new(http: reqwest::Client) -> Self {
        Self::with_endpoints(http, Endpoints::default())
    }

    pub fn with_endpoints(http: reqwest::Client, endpoints: Endpoints) -> Self {
        let plan = Plan::Standard;
        let gap = endpoints.gap.unwrap_or(Duration::from_millis(plan.data_gap_ms()));
        FyersClient {
            http,
            data: Throttle::new(gap),
            endpoints,
            plan: Mutex::new(plan),
            budget: Mutex::new(Budget::default()),
        }
    }

    /// The account's plan, which sets the pace and the day's budget.
    pub fn set_plan(&self, plan: Plan) {
        if let Ok(mut current) = self.plan.lock() {
            *current = plan;
        }
        if self.endpoints.gap.is_none() {
            self.data.set_gap(Duration::from_millis(plan.data_gap_ms()));
        }
    }

    pub fn plan(&self) -> Plan {
        self.plan.lock().map(|p| *p).unwrap_or(Plan::Standard)
    }

    /// Today's data requests so far, against the plan's allowance.
    pub fn usage(&self, now_ms: i64) -> Usage {
        let limit = self.plan().daily_limit();
        self.budget
            .lock()
            .map(|mut b| b.usage(limit, now_ms))
            .unwrap_or(Usage { used: 0, limit })
    }

    fn admit(&self) -> Result<(), FyersError> {
        let limit = self.plan().daily_limit();
        let mut budget = self
            .budget
            .lock()
            .map_err(|e| FyersError::new(FyersErrorKind::Other, e.to_string()))?;
        budget
            .admit(current_lane(), limit, now_ms())
            .map_err(|why| FyersError::new(FyersErrorKind::RateLimited, why))
    }

    /// One paced, counted data GET. A rate-limit answer is retried once, after the next minute has
    /// begun. Returns the HTTP status and the JSON body (`null` if it wasn't JSON).
    async fn get_data(
        &self,
        path: &str,
        query: &[(&str, String)],
        creds: &Credentials,
    ) -> Result<(u16, Value), FyersError> {
        for attempt in 0..2 {
            self.admit()?;
            self.data.wait().await;
            let resp = self
                .http
                .get(format!("{}{path}", self.endpoints.data))
                .query(query)
                .header("Authorization", format!("{}:{}", creds.app_id, creds.access_token))
                .send()
                .await
                .map_err(network)?;
            let status = resp.status().as_u16();
            let text = resp.text().await.map_err(network)?;
            let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            let failed = status >= 400 || is_failure_body(&value);
            if failed && classify_error(status, &value).kind == FyersErrorKind::RateLimited && attempt == 0 {
                let wait = self
                    .endpoints
                    .rate_limit_wait
                    .unwrap_or_else(|| until_next_minute(now_ms()));
                log::warn!(
                    "FYERS is rate limiting; waiting {}s before one more try",
                    wait.as_secs()
                );
                sleep(wait).await;
                continue;
            }
            return Ok((status, value));
        }
        unreachable!("the loop always returns on its last attempt")
    }

    /// Bars for `[from, to]`. A range longer than FYERS allows in one request is split into windows
    /// and stitched back together.
    pub async fn fetch_history(
        &self,
        creds: &Credentials,
        inst: &Instrument,
        interval: Interval,
        from_ms: Option<i64>,
        to_ms: Option<i64>,
        now_ms: i64,
    ) -> Result<Vec<Bar>, FyersError> {
        let mut bars: Vec<Bar> = Vec::new();
        for window in plan_windows(interval, from_ms, to_ms, now_ms) {
            let query = history_query(inst, interval, window);
            let (status, body) = self.get_data("/history", &query, creds).await?;
            bars.extend(parse_candles(status, &body)?);
        }
        bars.sort_by_key(|b| b.time);
        bars.dedup_by_key(|b| b.time);
        Ok(bars)
    }

    async fn quote_batches(&self, creds: &Credentials, batch: &[Instrument]) -> Result<(u16, Value), FyersError> {
        self.get_data("/quotes", &quotes_query(batch), creds).await
    }

    /// A quote-based stand-in for today's bar, batched (`store::day_topup`).
    pub async fn day_snapshots(
        &self,
        creds: &Credentials,
        instruments: &[Instrument],
    ) -> Result<Vec<Option<DaySnapshot>>, FyersError> {
        let mut out = Vec::with_capacity(instruments.len());
        for batch in instruments.chunks(QUOTE_BATCH) {
            let (status, body) = self.quote_batches(creds, batch).await?;
            out.extend(parse_day_snapshots(status, &body, batch)?);
        }
        Ok(out)
    }

    /// Each instrument's quote and last trade from one batched read, for the shared quote cache.
    pub async fn quotes_and_ticks(
        &self,
        creds: &Credentials,
        instruments: &[Instrument],
    ) -> Result<Vec<(Quote, Option<QuoteTick>)>, FyersError> {
        let mut out = Vec::with_capacity(instruments.len());
        for batch in instruments.chunks(QUOTE_BATCH) {
            let (status, body) = self.quote_batches(creds, batch).await?;
            let quotes = parse_quotes(status, &body, batch)?;
            let ticks = parse_ticks(status, &body, batch)?;
            out.extend(quotes.into_iter().zip(ticks));
        }
        Ok(out)
    }

    /// The account holder's name, which proves the token works. A user-information call, so it costs
    /// none of the day's data allowance.
    pub async fn profile(&self, creds: &Credentials) -> Result<Option<String>, FyersError> {
        let resp = self
            .http
            .get(format!("{}/profile", self.endpoints.api))
            .header("Authorization", format!("{}:{}", creds.app_id, creds.access_token))
            .send()
            .await
            .map_err(network)?;
        let status = resp.status().as_u16();
        let value: Value = serde_json::from_str(&resp.text().await.map_err(network)?).unwrap_or(Value::Null);
        parse_profile(status, &value)
    }

    async fn post_session(&self, path: &str, body: &Value) -> Result<Session, FyersError> {
        let resp = self
            .http
            .post(format!("{}{path}", self.endpoints.api))
            .json(body)
            .send()
            .await
            .map_err(network)?;
        let status = resp.status().as_u16();
        let value: Value = serde_json::from_str(&resp.text().await.map_err(network)?).unwrap_or(Value::Null);
        parse_session(status, &value)
    }

    /// Trades the one-time `auth_code` from a login for the day's access token (and a refresh token).
    pub async fn validate_authcode(&self, app_id: &str, secret: &str, code: &str) -> Result<Session, FyersError> {
        self.post_session(
            "/validate-authcode",
            &validate_authcode_body(&app_id_hash(app_id, secret), code),
        )
        .await
    }

    /// Renews the access token with the refresh token and the user's PIN. Not in FYERS's current
    /// documentation (its forum describes it); any refusal means the user logs in again.
    pub async fn refresh(
        &self,
        app_id: &str,
        secret: &str,
        refresh_token: &str,
        pin: &str,
    ) -> Result<Session, FyersError> {
        self.post_session(
            "/validate-refresh-token",
            &refresh_body(&app_id_hash(app_id, secret), refresh_token, pin),
        )
        .await
    }

    /// Downloads each public master list (no credentials needed), as `(name, csv bytes)`. A list that
    /// fails is skipped; without NSE's cash list there is nothing worth keeping.
    pub async fn download_symbol_master(&self) -> Result<Vec<(String, Vec<u8>)>, FyersError> {
        let mut lists = Vec::new();
        let mut first_error: Option<FyersError> = None;
        for name in MASTERS {
            match self.download_one(name).await {
                Ok(bytes) => lists.push((name.to_string(), bytes)),
                Err(e) => {
                    log::warn!("could not download FYERS's {name} symbol master: {e}");
                    first_error.get_or_insert(e);
                }
            }
        }
        if lists.iter().any(|(name, _)| name == "NSE_CM") {
            Ok(lists)
        } else {
            Err(first_error.unwrap_or_else(|| FyersError::new(FyersErrorKind::Other, "no symbol master lists")))
        }
    }

    async fn download_one(&self, name: &str) -> Result<Vec<u8>, FyersError> {
        let resp = self
            .http
            .get(format!("{}/{name}.csv", self.endpoints.master))
            .timeout(Duration::from_secs(120))
            .send()
            .await
            .map_err(network)?;
        if !resp.status().is_success() {
            return Err(FyersError::new(
                FyersErrorKind::Server,
                format!("the {name} symbol master download returned HTTP {}", resp.status()),
            ));
        }
        resp.bytes().await.map(|b| b.to_vec()).map_err(network)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::throttle::in_background;
    use serde_json::json;
    use std::sync::{Arc, Mutex as StdMutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[derive(Debug, Clone)]
    struct Recorded {
        method: String,
        /// Path and query string, exactly as sent.
        target: String,
        headers: Vec<(String, String)>,
        body: String,
    }

    impl Recorded {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.as_str())
        }

        fn path(&self) -> &str {
            self.target.split('?').next().unwrap()
        }

        fn query(&self) -> Vec<(String, String)> {
            reqwest::Url::parse(&format!("http://x{}", self.target))
                .unwrap()
                .query_pairs()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        }

        fn param(&self, key: &str) -> Option<String> {
            self.query().into_iter().find(|(k, _)| k == key).map(|(_, v)| v)
        }
    }

    /// A one-connection-per-request HTTP server that replays canned responses in order and records
    /// what it was sent.
    async fn mock(responses: Vec<(u16, String)>) -> (String, Arc<StdMutex<Vec<Recorded>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let log = Arc::new(StdMutex::new(Vec::new()));
        let recorded = log.clone();
        tokio::spawn(async move {
            for (status, payload) in responses {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = Vec::new();
                let head_end = loop {
                    let mut chunk = [0u8; 4096];
                    let n = sock.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break p + 4;
                    }
                    assert!(n > 0, "client closed before finishing its headers");
                };
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let mut lines = head.split("\r\n");
                let mut request_line = lines.next().unwrap().split(' ');
                let (method, target) = (
                    request_line.next().unwrap().to_string(),
                    request_line.next().unwrap().to_string(),
                );
                let headers: Vec<(String, String)> = lines
                    .filter_map(|l| {
                        l.split_once(':')
                            .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
                    })
                    .collect();
                let length: usize = headers
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                    .and_then(|(_, v)| v.parse().ok())
                    .unwrap_or(0);
                while buf.len() < head_end + length {
                    let mut chunk = [0u8; 4096];
                    let n = sock.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                }
                recorded.lock().unwrap().push(Recorded {
                    method,
                    target,
                    headers,
                    body: String::from_utf8_lossy(&buf[head_end..head_end + length]).to_string(),
                });
                let response = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                sock.write_all(response.as_bytes()).await.unwrap();
                sock.shutdown().await.ok();
            }
        });
        (base, log)
    }

    fn client(base: &str) -> FyersClient {
        FyersClient::with_endpoints(
            reqwest::Client::new(),
            Endpoints {
                api: format!("{base}/api/v3"),
                data: format!("{base}/data"),
                master: format!("{base}/sym_details"),
                rate_limit_wait: Some(Duration::from_millis(1)),
                gap: Some(Duration::ZERO),
            },
        )
    }

    fn creds() -> Credentials {
        Credentials {
            app_id: "APPID-100".into(),
            access_token: "tok".into(),
        }
    }

    fn sbin() -> Instrument {
        Instrument {
            ticker: "NSE:SBIN".into(),
            exchange: "NSE".into(),
            token: 101_000_000_003_045,
            instrument: "EQUITY".into(),
            symbol: "NSE:SBIN-EQ".into(),
            name: None,
            expiry: None,
        }
    }

    const DAY: i64 = 86_400_000;

    #[tokio::test]
    async fn history_is_asked_window_by_window_with_the_app_id_and_token() {
        let candles = |t: i64| json!({"s":"ok","candles":[[t, 1.0, 2.0, 0.5, 1.5, 100]]}).to_string();
        let (base, log) = mock(vec![(200, candles(1_000)), (200, candles(2_000))]).await;
        let now = 2_000_000_000_000;
        let bars = client(&base)
            .fetch_history(&creds(), &sbin(), Interval::Day, Some(now - 500 * DAY), None, now)
            .await
            .unwrap();
        assert_eq!(bars.len(), 2);
        let sent = log.lock().unwrap().clone();
        assert_eq!(
            sent.len(),
            2,
            "500 days of daily bars is two requests of up to 365 days"
        );
        assert_eq!(sent[0].method, "GET");
        assert_eq!(sent[0].path(), "/data/history");
        assert_eq!(sent[0].header("authorization"), Some("APPID-100:tok"), "no Bearer");
        assert_eq!(sent[0].param("symbol").as_deref(), Some("NSE:SBIN-EQ"));
        assert_eq!(sent[0].param("resolution").as_deref(), Some("D"));
        assert_eq!(sent[0].param("date_format").as_deref(), Some("0"));
    }

    #[tokio::test]
    async fn a_rate_limit_is_tried_once_more_and_then_reported() {
        let limited = json!({"s":"error","code":-429,"message":"request limit reached"}).to_string();
        let ok = json!({"s":"ok","candles":[]}).to_string();
        let (base, log) = mock(vec![(429, limited.clone()), (200, ok)]).await;
        let now = 2_000_000_000_000;
        let c = client(&base);
        assert!(c
            .fetch_history(&creds(), &sbin(), Interval::Day, Some(now - DAY), None, now)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(log.lock().unwrap().len(), 2);

        let (base, log) = mock(vec![(429, limited.clone()), (429, limited)]).await;
        let e = client(&base)
            .fetch_history(&creds(), &sbin(), Interval::Day, Some(now - DAY), None, now)
            .await
            .unwrap_err();
        assert_eq!(e.kind, FyersErrorKind::RateLimited);
        assert_eq!(log.lock().unwrap().len(), 2, "never more than one retry");
    }

    #[tokio::test]
    async fn a_bad_token_is_a_token_error() {
        let body = json!({"s":"error","code":-16,"message":"Could not authenticate the user"}).to_string();
        let (base, _) = mock(vec![(401, body)]).await;
        let now = 2_000_000_000_000;
        let e = client(&base)
            .fetch_history(&creds(), &sbin(), Interval::Day, Some(now - DAY), None, now)
            .await
            .unwrap_err();
        assert_eq!(e.kind, FyersErrorKind::Token);
    }

    #[tokio::test]
    async fn quotes_are_asked_fifty_symbols_at_a_time() {
        let many: Vec<Instrument> = (0..60)
            .map(|i| Instrument {
                ticker: format!("NSE:S{i}"),
                symbol: format!("NSE:S{i}-EQ"),
                ..sbin()
            })
            .collect();
        let answer = |from: usize, to: usize| {
            let d: Vec<Value> = (from..to)
                .map(|i| json!({"n": format!("NSE:S{i}-EQ"), "s":"ok", "v": {"lp": 10.0 + i as f64, "prev_close_price": 10.0}}))
                .collect();
            json!({"s":"ok","d":d}).to_string()
        };
        let (base, log) = mock(vec![(200, answer(0, 50)), (200, answer(50, 60))]).await;
        let answers = client(&base).quotes_and_ticks(&creds(), &many).await.unwrap();
        assert_eq!(answers.len(), 60);
        assert_eq!(answers[59].0.symbol, "NSE:S59");
        assert_eq!(answers[59].0.price, Some(69.0));
        assert_eq!(answers[59].1.as_ref().map(|t| t.ltp), Some(69.0));
        let sent = log.lock().unwrap().clone();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0].path(), "/data/quotes");
        assert_eq!(sent[0].param("symbols").unwrap().split(',').count(), 50);
    }

    #[tokio::test]
    async fn the_login_exchange_sends_the_hash_never_the_secret() {
        let (base, log) = mock(vec![(
            200,
            json!({"s":"ok","access_token":"A","refresh_token":"R"}).to_string(),
        )])
        .await;
        let session = client(&base)
            .validate_authcode("APPID-100", "s3cret", "CODE")
            .await
            .unwrap();
        assert_eq!(session.access_token, "A");
        let sent = log.lock().unwrap()[0].clone();
        assert_eq!(
            (sent.method.as_str(), sent.path()),
            ("POST", "/api/v3/validate-authcode")
        );
        let body: Value = serde_json::from_str(&sent.body).unwrap();
        assert_eq!(body["grant_type"], "authorization_code");
        assert_eq!(body["code"], "CODE");
        assert_eq!(body["appIdHash"], app_id_hash("APPID-100", "s3cret"));
        assert!(
            !sent.body.contains("s3cret"),
            "the secret itself never leaves this computer"
        );
    }

    #[tokio::test]
    async fn a_renewal_sends_the_refresh_token_and_pin_to_its_own_endpoint() {
        let (base, log) = mock(vec![(200, json!({"s":"ok","access_token":"B"}).to_string())]).await;
        let session = client(&base).refresh("APPID-100", "s3cret", "R", "1234").await.unwrap();
        assert_eq!(
            session,
            Session {
                access_token: "B".into(),
                refresh_token: None
            }
        );
        let sent = log.lock().unwrap()[0].clone();
        assert_eq!(sent.path(), "/api/v3/validate-refresh-token");
        let body: Value = serde_json::from_str(&sent.body).unwrap();
        assert_eq!(
            (body["refresh_token"].as_str(), body["pin"].as_str()),
            (Some("R"), Some("1234"))
        );
    }

    #[tokio::test]
    async fn the_profile_proves_a_token_without_spending_the_data_allowance() {
        let (base, log) = mock(vec![(200, json!({"s":"ok","data":{"name":"A TRADER"}}).to_string())]).await;
        let c = client(&base);
        assert_eq!(c.profile(&creds()).await.unwrap().as_deref(), Some("A TRADER"));
        assert_eq!(log.lock().unwrap()[0].path(), "/api/v3/profile");
        assert_eq!(c.usage(now_ms()).used, 0);
    }

    #[tokio::test]
    async fn the_day_budget_stops_background_work_before_fyers_does() {
        let ok = json!({"s":"ok","candles":[]}).to_string();
        let (base, log) = mock(vec![(200, ok); 3]).await;
        let c = client(&base);
        c.set_plan(Plan::Standard);
        // Use up the background share of today's allowance.
        {
            let mut b = c.budget.lock().unwrap();
            for _ in 0..4_000 {
                b.admit(crate::throttle::Lane::Background, 5_000, now_ms()).unwrap();
            }
        }
        let now = now_ms();
        let refused = in_background(c.fetch_history(&creds(), &sbin(), Interval::Day, Some(now - DAY), None, now))
            .await
            .unwrap_err();
        assert_eq!(refused.kind, FyersErrorKind::RateLimited);
        assert!(log.lock().unwrap().is_empty(), "refused before anything was sent");
        // A chart still gets through.
        c.fetch_history(&creds(), &sbin(), Interval::Day, Some(now - DAY), None, now)
            .await
            .unwrap();
        assert_eq!(c.usage(now_ms()).used, 4_001);
    }

    #[tokio::test]
    async fn the_symbol_master_is_downloaded_list_by_list_and_needs_the_nse_one() {
        let (base, log) = mock(vec![
            (200, "nse".into()),
            (404, "".into()),
            (200, "fo".into()),
            (200, "bfo".into()),
            (200, "mcx".into()),
        ])
        .await;
        let lists = client(&base).download_symbol_master().await.unwrap();
        assert_eq!(lists.len(), 4, "a list that fails is skipped");
        assert_eq!(lists[0], ("NSE_CM".to_string(), b"nse".to_vec()));
        assert_eq!(log.lock().unwrap()[0].path(), "/sym_details/NSE_CM.csv");
        assert!(
            log.lock().unwrap()[0].header("authorization").is_none(),
            "public: no credentials"
        );
    }

    #[test]
    fn the_wait_after_a_rate_limit_runs_into_the_next_minute() {
        assert_eq!(until_next_minute(60_000 * 5 + 59_000), Duration::from_millis(3_000));
        assert_eq!(until_next_minute(60_000 * 5), Duration::from_millis(62_000));
    }
}
