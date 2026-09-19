//! Kite Connect over HTTP: history, quotes, the login token exchange, and the
//! instrument list download. Requests are paced (Kite allows 3 history and 1
//! quote request a second) and a rate-limit response is retried with backoff
//! instead of surfacing.

use std::time::Duration;

use serde_json::Value;
use tokio::time::sleep;

use super::instruments::{Instrument, EXCHANGES};
use super::protocol::{
    checksum, classify_error, history_path, history_query, is_failure_body, parse_candles, parse_quotes, parse_session,
    plan_windows, Interval, ZerodhaError, ZerodhaErrorKind, BASE_URL,
};
use crate::models::{Bar, Quote};
use crate::throttle::Throttle;

#[derive(Debug, Clone)]
pub struct Credentials {
    pub api_key: String,
    pub access_token: String,
}

/// Pacing knobs. Production values sit inside Kite's documented limits (3
/// requests a second for history, 1 for quotes); tests shrink them.
#[derive(Debug, Clone, Copy)]
pub struct Pacing {
    pub data_gap: Duration,
    pub quote_gap: Duration,
    /// First retry delay after a rate-limit response; doubles each retry.
    pub retry_base: Duration,
}

impl Default for Pacing {
    fn default() -> Self {
        Pacing {
            data_gap: Duration::from_millis(350),
            quote_gap: Duration::from_millis(1100),
            retry_base: Duration::from_secs(1),
        }
    }
}

const MAX_RETRIES: u32 = 3;
/// Instruments per `/quote/ohlc` request. Kite allows 1000; a shorter URL is safer.
const QUOTE_BATCH: usize = 200;
const VERSION_HEADER: (&str, &str) = ("X-Kite-Version", "3");

pub struct ZerodhaClient {
    http: reqwest::Client,
    base: String,
    pacing: Pacing,
    data: Throttle,
    quote: Throttle,
}

fn network(e: reqwest::Error) -> ZerodhaError {
    ZerodhaError::new(ZerodhaErrorKind::Network, e.to_string())
}

impl ZerodhaClient {
    pub fn new(http: reqwest::Client) -> Self {
        Self::with_base(http, BASE_URL, Pacing::default())
    }

    pub fn with_base(http: reqwest::Client, base: &str, pacing: Pacing) -> Self {
        ZerodhaClient {
            http,
            base: base.trim_end_matches('/').to_string(),
            data: Throttle::new(pacing.data_gap),
            quote: Throttle::new(pacing.quote_gap),
            pacing,
        }
    }

    /// One paced GET, retried while Kite says "too many requests". Returns the
    /// HTTP status and the JSON body (`null` if it wasn't JSON).
    async fn get(
        &self,
        throttle: &Throttle,
        path: &str,
        query: &[(&str, String)],
        creds: &Credentials,
    ) -> Result<(u16, Value), ZerodhaError> {
        for attempt in 0..=MAX_RETRIES {
            throttle.wait().await;
            let resp = self
                .http
                .get(format!("{}{}", self.base, path))
                .query(query)
                .header(VERSION_HEADER.0, VERSION_HEADER.1)
                .header(
                    "Authorization",
                    format!("token {}:{}", creds.api_key, creds.access_token),
                )
                .send()
                .await
                .map_err(network)?;
            let status = resp.status().as_u16();
            let text = resp.text().await.map_err(network)?;
            let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);

            let failed = status >= 400 || is_failure_body(&value);
            if failed && classify_error(status, &value).kind == ZerodhaErrorKind::RateLimited && attempt < MAX_RETRIES {
                sleep(self.pacing.retry_base * 2u32.pow(attempt)).await;
                continue;
            }
            return Ok((status, value));
        }
        unreachable!("the loop always returns on its last attempt")
    }

    /// Bars for `[from, to]`. A range longer than Kite allows in one request is
    /// split into windows and stitched back together.
    pub async fn fetch_history(
        &self,
        creds: &Credentials,
        inst: &Instrument,
        interval: Interval,
        from_ms: Option<i64>,
        to_ms: Option<i64>,
        now_ms: i64,
    ) -> Result<Vec<Bar>, ZerodhaError> {
        let path = history_path(inst, interval);
        let mut bars: Vec<Bar> = Vec::new();
        for window in plan_windows(interval, from_ms, to_ms, now_ms) {
            let query = history_query(inst, interval, window);
            let (status, body) = self.get(&self.data, &path, &query, creds).await?;
            bars.extend(parse_candles(status, &body)?);
        }
        bars.sort_by_key(|b| b.time);
        bars.dedup_by_key(|b| b.time);
        Ok(bars)
    }

    /// Last price and day change, batched.
    pub async fn quotes(&self, creds: &Credentials, instruments: &[Instrument]) -> Result<Vec<Quote>, ZerodhaError> {
        let mut out = Vec::with_capacity(instruments.len());
        for batch in instruments.chunks(QUOTE_BATCH) {
            let query: Vec<(&str, String)> = batch.iter().map(|i| ("i", i.quote_key())).collect();
            let (status, body) = self.get(&self.quote, "/quote/ohlc", &query, creds).await?;
            out.extend(parse_quotes(status, &body, batch)?);
        }
        Ok(out)
    }

    /// Trades the one-time `request_token` from a login for an access token.
    pub async fn exchange_token(
        &self,
        api_key: &str,
        api_secret: &str,
        request_token: &str,
    ) -> Result<String, ZerodhaError> {
        let resp = self
            .http
            .post(format!("{}/session/token", self.base))
            .header(VERSION_HEADER.0, VERSION_HEADER.1)
            .form(&[
                ("api_key", api_key),
                ("request_token", request_token),
                ("checksum", &checksum(api_key, request_token, api_secret)),
            ])
            .send()
            .await
            .map_err(network)?;
        let status = resp.status().as_u16();
        let value: Value = serde_json::from_str(&resp.text().await.map_err(network)?).unwrap_or(Value::Null);
        parse_session(status, &value)
    }

    /// Downloads each exchange's public instrument list (no credentials
    /// needed), as `(exchange, csv bytes)`. A derivatives exchange that fails
    /// is skipped; without the NSE list there is nothing worth keeping.
    pub async fn download_instrument_master(&self) -> Result<Vec<(String, Vec<u8>)>, ZerodhaError> {
        let mut lists = Vec::new();
        let mut first_error: Option<ZerodhaError> = None;
        for exchange in EXCHANGES {
            match self.download_one(exchange).await {
                Ok(bytes) => lists.push((exchange.to_string(), bytes)),
                Err(e) => {
                    log::warn!("could not download Zerodha's {exchange} instrument list: {e}");
                    first_error.get_or_insert(e);
                }
            }
        }
        if lists.iter().any(|(exchange, _)| exchange == "NSE") {
            Ok(lists)
        } else {
            Err(first_error.unwrap_or_else(|| ZerodhaError::new(ZerodhaErrorKind::Other, "no instrument lists")))
        }
    }

    async fn download_one(&self, exchange: &str) -> Result<Vec<u8>, ZerodhaError> {
        let resp = self
            .http
            .get(format!("{}/instruments/{exchange}", self.base))
            .header(VERSION_HEADER.0, VERSION_HEADER.1)
            .timeout(Duration::from_secs(120))
            .send()
            .await
            .map_err(network)?;
        if !resp.status().is_success() {
            return Err(ZerodhaError::new(
                ZerodhaErrorKind::Server,
                format!(
                    "the {exchange} instrument list download returned HTTP {}",
                    resp.status()
                ),
            ));
        }
        resp.bytes().await.map(|b| b.to_vec()).map_err(network)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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

        /// The decoded query parameters.
        fn query(&self) -> Vec<(String, String)> {
            reqwest::Url::parse(&format!("http://x{}", self.target))
                .unwrap()
                .query_pairs()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        }
    }

    /// A one-connection-per-request HTTP server that replays canned responses
    /// in order and records what it was sent.
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

    fn fast() -> Pacing {
        Pacing {
            data_gap: Duration::ZERO,
            quote_gap: Duration::ZERO,
            retry_base: Duration::from_millis(1),
        }
    }

    fn client(base: &str) -> ZerodhaClient {
        ZerodhaClient::with_base(reqwest::Client::new(), base, fast())
    }

    fn creds() -> Credentials {
        Credentials {
            api_key: "mykey".into(),
            access_token: "mytoken".into(),
        }
    }

    fn inst(symbol: &str) -> Instrument {
        Instrument {
            ticker: format!("NSE:{}", symbol.replace(' ', "_")),
            exchange: "NSE".into(),
            token: 738561,
            instrument: "EQUITY".into(),
            symbol: symbol.into(),
            name: None,
            expiry: None,
        }
    }

    const NOW: i64 = 1_800_000_000_000;
    const DAY: i64 = 86_400_000;

    fn ok(body: Value) -> (u16, String) {
        (200, body.to_string())
    }

    fn daily(days: &[&str]) -> Value {
        let candles: Vec<Value> = days
            .iter()
            .enumerate()
            .map(|(i, d)| json!([format!("{d}T00:00:00+0530"), 100 + i, 105, 99, 104 + i, 1000]))
            .collect();
        json!({"status":"success","data":{"candles":candles}})
    }

    #[tokio::test]
    async fn a_history_request_hits_the_right_endpoint_with_kites_headers() {
        let (base, log) = mock(vec![ok(daily(&["2026-09-16", "2026-09-17"]))]).await;
        let bars = client(&base)
            .fetch_history(
                &creds(),
                &inst("RELIANCE"),
                Interval::Day,
                Some(NOW - 30 * DAY),
                Some(NOW),
                NOW,
            )
            .await
            .unwrap();

        assert_eq!(bars.len(), 2);
        assert_eq!(bars[0].close, 104.0);
        let req = &log.lock().unwrap()[0];
        assert_eq!(
            (req.method.as_str(), req.path()),
            ("GET", "/instruments/historical/738561/day")
        );
        assert_eq!(req.header("X-Kite-Version"), Some("3"));
        assert_eq!(req.header("Authorization"), Some("token mykey:mytoken"));
        let q = req.query();
        assert!(q.iter().any(|(k, v)| k == "from" && v.len() == 19), "{q:?}");
        assert!(q.iter().any(|(k, _)| k == "to"));
    }

    #[tokio::test]
    async fn a_range_longer_than_kites_limit_is_fetched_in_windows_and_stitched() {
        // 1-minute data is limited to 60 days a request; 130 days needs three.
        let w1 = ok(json!({"status":"success","data":{"candles":[["2026-05-01T09:15:00+0530",1,2,0.5,1.5,10]]}}));
        let w2 = ok(json!({"status":"success","data":{"candles":[["2026-06-20T09:15:00+0530",2,3,1.5,2.5,20]]}}));
        // The last window repeats the previous window's final bar at its boundary.
        let w3 = ok(json!({"status":"success","data":{"candles":[
            ["2026-06-20T09:15:00+0530",2,3,1.5,2.5,20],["2026-08-30T09:15:00+0530",3,4,2.5,3.5,30]]}}));
        let (base, log) = mock(vec![w1, w2, w3]).await;
        let bars = client(&base)
            .fetch_history(
                &creds(),
                &inst("RELIANCE"),
                Interval::Minutes(1),
                Some(NOW - 130 * DAY),
                Some(NOW),
                NOW,
            )
            .await
            .unwrap();

        assert_eq!(log.lock().unwrap().len(), 3);
        assert_eq!(bars.len(), 3, "the repeated boundary bar is kept once");
        assert!(bars.windows(2).all(|p| p[0].time < p[1].time));
        assert!(log.lock().unwrap().iter().all(|r| r.path().ends_with("/minute")));
    }

    #[tokio::test]
    async fn a_rate_limit_response_is_retried_transparently() {
        let limited = (
            429,
            json!({"status":"error","message":"Too many requests","error_type":"NetworkException"}).to_string(),
        );
        let (base, log) = mock(vec![limited, ok(daily(&["2026-09-17"]))]).await;
        let bars = client(&base)
            .fetch_history(&creds(), &inst("RELIANCE"), Interval::Day, None, Some(NOW), NOW)
            .await
            .unwrap();
        assert_eq!(bars.len(), 1);
        assert_eq!(log.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn persistent_rate_limiting_gives_up_with_a_clear_error() {
        let limited = || {
            (
                429,
                json!({"status":"error","message":"Too many requests","error_type":"NetworkException"}).to_string(),
            )
        };
        let (base, log) = mock((0..=MAX_RETRIES).map(|_| limited()).collect()).await;
        let err = client(&base)
            .fetch_history(&creds(), &inst("RELIANCE"), Interval::Day, None, Some(NOW), NOW)
            .await
            .unwrap_err();
        assert_eq!(err.kind, ZerodhaErrorKind::RateLimited);
        assert_eq!(log.lock().unwrap().len(), MAX_RETRIES as usize + 1);
    }

    #[tokio::test]
    async fn an_expired_token_is_reported_at_once_without_retrying() {
        // The real body, captured from the live service.
        let body = r#"{"status":"error","message":"Incorrect `api_key` or `access_token`.","data":null,"error_type":"TokenException"}"#;
        let (base, log) = mock(vec![(403, body.to_string())]).await;
        let err = client(&base)
            .fetch_history(&creds(), &inst("RELIANCE"), Interval::Day, None, Some(NOW), NOW)
            .await
            .unwrap_err();
        assert_eq!(err.kind, ZerodhaErrorKind::Token);
        assert!(err.message().contains("log in again"));
        assert_eq!(log.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_plan_without_history_access_says_so() {
        let body = json!({"status":"error","message":"Insufficient permission for that call.","error_type":"PermissionException"});
        let (base, _log) = mock(vec![(403, body.to_string())]).await;
        let err = client(&base)
            .fetch_history(&creds(), &inst("RELIANCE"), Interval::Day, None, Some(NOW), NOW)
            .await
            .unwrap_err();
        assert_eq!(err.kind, ZerodhaErrorKind::Permission);
    }

    #[tokio::test]
    async fn an_unreachable_server_is_a_network_error() {
        let err = client("http://127.0.0.1:1")
            .fetch_history(&creds(), &inst("RELIANCE"), Interval::Day, None, Some(NOW), NOW)
            .await
            .unwrap_err();
        assert_eq!(err.kind, ZerodhaErrorKind::Network);
    }

    #[tokio::test]
    async fn quotes_name_each_instrument_as_exchange_and_symbol_in_repeated_parameters() {
        let body = json!({"status":"success","data":{
            "NSE:NIFTY 50":{"last_price":25000,"ohlc":{"close":25100}},
            "NSE:M&M":{"last_price":3000,"ohlc":{"close":2950}}}});
        let (base, log) = mock(vec![ok(body)]).await;
        let q = client(&base)
            .quotes(&creds(), &[inst("NIFTY 50"), inst("M&M")])
            .await
            .unwrap();

        assert_eq!(q.len(), 2);
        assert_eq!(q[0].price, Some(25000.0));
        let req = &log.lock().unwrap()[0];
        assert_eq!(req.path(), "/quote/ohlc");
        let asked: Vec<_> = req
            .query()
            .into_iter()
            .filter(|(k, _)| k == "i")
            .map(|(_, v)| v)
            .collect();
        assert_eq!(
            asked,
            ["NSE:NIFTY 50", "NSE:M&M"],
            "decoded exactly as Kite spells them"
        );
    }

    #[tokio::test]
    async fn a_long_list_of_quotes_is_split_into_batches() {
        let empty = || ok(json!({"status":"success","data":{}}));
        let (base, log) = mock(vec![empty(), empty()]).await;
        let many: Vec<Instrument> = (0..250).map(|i| inst(&format!("S{i}"))).collect();
        let q = client(&base).quotes(&creds(), &many).await.unwrap();
        assert_eq!(q.len(), 250, "every instrument gets an answer, even if only an error");
        let log = log.lock().unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].query().len(), QUOTE_BATCH);
        assert_eq!(log[1].query().len(), 50);
    }

    #[tokio::test]
    async fn the_login_exchange_posts_a_checksum_and_returns_the_access_token() {
        let (base, log) = mock(vec![ok(
            json!({"status":"success","data":{"access_token":"the_token","user_id":"AB1234"}}),
        )])
        .await;
        let token = client(&base)
            .exchange_token("mykey", "mysecret", "requesttoken123")
            .await
            .unwrap();
        assert_eq!(token, "the_token");

        let req = &log.lock().unwrap()[0];
        assert_eq!((req.method.as_str(), req.path()), ("POST", "/session/token"));
        assert_eq!(req.header("X-Kite-Version"), Some("3"));
        assert!(req.header("Authorization").is_none(), "no credentials exist yet");
        let form: Vec<(String, String)> = reqwest::Url::parse(&format!("http://x/?{}", req.body))
            .unwrap()
            .query_pairs()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let get = |k: &str| form.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone()).unwrap();
        assert_eq!(get("api_key"), "mykey");
        assert_eq!(get("request_token"), "requesttoken123");
        assert_eq!(get("checksum"), checksum("mykey", "requesttoken123", "mysecret"));
        assert!(!req.body.contains("mysecret"), "the secret itself is never sent");
    }

    #[tokio::test]
    async fn a_failed_login_exchange_explains_itself() {
        let body = json!({"status":"error","message":"Token is invalid or has expired.","error_type":"TokenException"});
        let (base, _log) = mock(vec![(403, body.to_string())]).await;
        let err = client(&base)
            .exchange_token("k", "s", "expiredtoken1")
            .await
            .unwrap_err();
        assert_eq!(err.kind, ZerodhaErrorKind::Token);
    }

    #[tokio::test]
    async fn the_instrument_lists_are_downloaded_per_exchange_and_a_missing_derivatives_list_is_tolerated() {
        // NSE and BSE succeed, NFO fails, the rest succeed.
        let csv = |name: &str| (200, format!("instrument_token,tradingsymbol\n1,{name}\n"));
        let mut replies = vec![csv("A"), csv("B"), (500, "oops".to_string())];
        replies.extend((0..4).map(|i| csv(&format!("X{i}"))));
        let (base, log) = mock(replies).await;
        let lists = client(&base).download_instrument_master().await.unwrap();

        let names: Vec<_> = lists.iter().map(|(e, _)| e.as_str()).collect();
        assert_eq!(names, ["NSE", "BSE", "BFO", "MCX", "CDS", "BCD"]);
        let log = log.lock().unwrap();
        assert_eq!(log.len(), 7);
        assert_eq!(log[0].path(), "/instruments/NSE");
        assert!(
            log.iter().all(|r| r.header("Authorization").is_none()),
            "the lists are public"
        );
    }

    #[tokio::test]
    async fn without_the_nse_list_the_download_fails() {
        let mut replies = vec![(500, "oops".to_string())];
        replies.extend((0..6).map(|_| (200, "instrument_token,tradingsymbol\n".to_string())));
        let (base, _log) = mock(replies).await;
        let err = client(&base).download_instrument_master().await.unwrap_err();
        assert_eq!(err.kind, ZerodhaErrorKind::Server);
    }
}
