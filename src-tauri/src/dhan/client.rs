//! Dhan's REST API over HTTP: history, quotes, token renewal, and the
//! instrument list download. Requests are paced (Dhan rate-limits per user)
//! and a rate-limit response is retried with backoff instead of surfacing.

use std::time::Duration;

use reqwest::Method;
use serde_json::Value;
use tokio::time::sleep;

use super::instruments::{Instrument, MASTER_CSV_URL};
use super::protocol::{
    classify_error, history_body, is_failure_body, parse_history, parse_quotes, parse_renewed_token, plan_windows,
    quote_body, series_to_bars, DhanError, DhanErrorKind, Interval, BASE_URL,
};
use crate::models::{Bar, Quote};
use crate::throttle::Throttle;

#[derive(Debug, Clone)]
pub struct Credentials {
    pub client_id: String,
    pub access_token: String,
}

/// Pacing knobs. Production values keep well inside Dhan's limits (the market
/// quote API allows one request a second); tests shrink them.
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
            data_gap: Duration::from_millis(250),
            quote_gap: Duration::from_millis(1100),
            retry_base: Duration::from_secs(1),
        }
    }
}

const MAX_RETRIES: u32 = 3;

pub struct DhanClient {
    http: reqwest::Client,
    base: String,
    pacing: Pacing,
    data: Throttle,
    quote: Throttle,
}

impl DhanClient {
    pub fn new(http: reqwest::Client) -> Self {
        Self::with_base(http, BASE_URL, Pacing::default())
    }

    pub fn with_base(http: reqwest::Client, base: &str, pacing: Pacing) -> Self {
        DhanClient {
            http,
            base: base.trim_end_matches('/').to_string(),
            data: Throttle::new(pacing.data_gap),
            quote: Throttle::new(pacing.quote_gap),
            pacing,
        }
    }

    /// One paced request, retried while Dhan says "too many requests". Returns
    /// the HTTP status and the JSON body (`null` if it wasn't JSON).
    async fn send(
        &self,
        throttle: &Throttle,
        method: Method,
        path: &str,
        creds: &Credentials,
        body: Option<&Value>,
    ) -> Result<(u16, Value), DhanError> {
        for attempt in 0..=MAX_RETRIES {
            throttle.wait().await;
            let mut req = self
                .http
                .request(method.clone(), format!("{}{}", self.base, path))
                // The docs name the header `client-id` for market data and
                // `dhanClientId` for auth endpoints; sending both is harmless.
                .header("access-token", &creds.access_token)
                .header("client-id", &creds.client_id)
                .header("dhanClientId", &creds.client_id)
                .header("Accept", "application/json");
            if let Some(b) = body {
                req = req.json(b);
            }
            let resp = req
                .send()
                .await
                .map_err(|e| DhanError::new(DhanErrorKind::Network, e.to_string()))?;
            let status = resp.status().as_u16();
            let text = resp
                .text()
                .await
                .map_err(|e| DhanError::new(DhanErrorKind::Network, e.to_string()))?;
            let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);

            let failed = status >= 400 || is_failure_body(&value);
            if failed && classify_error(status, &value).kind == DhanErrorKind::RateLimited && attempt < MAX_RETRIES {
                sleep(self.pacing.retry_base * 2u32.pow(attempt)).await;
                continue;
            }
            return Ok((status, value));
        }
        unreachable!("the loop always returns on its last attempt")
    }

    /// Bars for `[from, to]`. Intraday requests are split to fit Dhan's 90-day
    /// limit and stitched back together; an empty window contributes nothing.
    pub async fn fetch_history(
        &self,
        creds: &Credentials,
        inst: &Instrument,
        interval: Interval,
        from_ms: Option<i64>,
        to_ms: Option<i64>,
        now_ms: i64,
    ) -> Result<Vec<Bar>, DhanError> {
        let path = match interval {
            Interval::Daily => "/charts/historical",
            Interval::Minutes(_) => "/charts/intraday",
        };
        let intraday_segment = matches!(interval, Interval::Minutes(_)).then_some(inst.segment);

        let mut bars: Vec<Bar> = Vec::new();
        // Which spelling of the intraday `interval` the server accepts; found
        // on the first request and reused for the rest.
        let mut minutes_as_number = false;

        for window in plan_windows(interval, from_ms, to_ms, now_ms) {
            let mut attempt = self
                .send(
                    &self.data,
                    Method::POST,
                    path,
                    creds,
                    Some(&history_body(inst, interval, window, minutes_as_number)),
                )
                .await
                .and_then(|(status, body)| parse_history(status, &body));

            if matches!(interval, Interval::Minutes(_))
                && !minutes_as_number
                && attempt
                    .as_ref()
                    .err()
                    .is_some_and(|e| e.kind == DhanErrorKind::BadRequest)
            {
                minutes_as_number = true;
                attempt = self
                    .send(
                        &self.data,
                        Method::POST,
                        path,
                        creds,
                        Some(&history_body(inst, interval, window, true)),
                    )
                    .await
                    .and_then(|(status, body)| parse_history(status, &body));
            }

            match attempt {
                Ok(series) => {
                    let (chunk, shift) = series_to_bars(&series, window, now_ms, intraday_segment);
                    if shift != 0 {
                        log::info!("Dhan timestamps for {} needed a {shift}s correction", inst.ticker);
                    }
                    bars.extend(chunk);
                }
                Err(e) if e.kind == DhanErrorKind::NoData => continue,
                Err(e) => return Err(e),
            }
        }
        bars.sort_by_key(|b| b.time);
        bars.dedup_by_key(|b| b.time);
        Ok(bars)
    }

    /// Last price and day change for up to a few thousand instruments, batched
    /// at Dhan's 1000-per-request limit.
    pub async fn quotes(&self, creds: &Credentials, instruments: &[Instrument]) -> Result<Vec<Quote>, DhanError> {
        let mut out = Vec::with_capacity(instruments.len());
        for batch in instruments.chunks(1000) {
            let (status, body) = self
                .send(
                    &self.quote,
                    Method::POST,
                    "/marketfeed/quote",
                    creds,
                    Some(&quote_body(batch)),
                )
                .await?;
            out.extend(parse_quotes(status, &body, batch)?);
        }
        Ok(out)
    }

    /// Asks Dhan to extend the current token by another 24 hours.
    pub async fn renew_token(&self, creds: &Credentials) -> Result<String, DhanError> {
        let (status, body) = self.send(&self.data, Method::GET, "/RenewToken", creds, None).await?;
        parse_renewed_token(status, &body)
    }

    /// Downloads the public instrument master (no credentials needed).
    pub async fn download_instrument_master(&self) -> Result<Vec<u8>, DhanError> {
        let resp = self
            .http
            .get(MASTER_CSV_URL)
            .timeout(Duration::from_secs(180))
            .send()
            .await
            .map_err(|e| DhanError::new(DhanErrorKind::Network, e.to_string()))?;
        if !resp.status().is_success() {
            return Err(DhanError::new(
                DhanErrorKind::Server,
                format!("the instrument list download returned HTTP {}", resp.status()),
            ));
        }
        resp.bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| DhanError::new(DhanErrorKind::Network, e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dhan::Segment;
    use serde_json::json;
    use std::sync::{Arc, Mutex as StdMutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[derive(Debug, Clone)]
    struct Recorded {
        method: String,
        path: String,
        headers: Vec<(String, String)>,
        body: Value,
    }

    impl Recorded {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.as_str())
        }
    }

    /// A one-connection-per-request HTTP server that replays canned responses
    /// in order and records what it was sent.
    async fn mock(responses: Vec<(u16, Value)>) -> (String, Arc<StdMutex<Vec<Recorded>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let log = Arc::new(StdMutex::new(Vec::new()));
        let recorded = log.clone();
        tokio::spawn(async move {
            for (status, body) in responses {
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
                let (method, path) = (
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
                let body_json = serde_json::from_slice(&buf[head_end..head_end + length]).unwrap_or(Value::Null);
                recorded.lock().unwrap().push(Recorded {
                    method,
                    path,
                    headers,
                    body: body_json,
                });

                let payload = body.to_string();
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

    fn creds() -> Credentials {
        Credentials {
            client_id: "1000000001".into(),
            access_token: "tok.en.sig".into(),
        }
    }

    fn inst() -> Instrument {
        Instrument {
            ticker: "NSE:RELIANCE".into(),
            exchange: "NSE".into(),
            segment: Segment::NseEq,
            security_id: 2885,
            instrument: "EQUITY".into(),
            symbol: "RELIANCE".into(),
            name: None,
            expiry: None,
        }
    }

    const NOW: i64 = 1_800_000_000_000;

    fn daily_response() -> Value {
        json!({"open":[100.0,102.0],"high":[105.0,106.0],"low":[99.0,101.0],"close":[104.0,105.0],"volume":[1000,2000],
               "timestamp":[1_799_800_000, 1_799_886_400]})
    }

    #[tokio::test]
    async fn a_daily_request_hits_the_right_endpoint_with_credentials_and_a_correct_body() {
        let (base, log) = mock(vec![(200, daily_response())]).await;
        let client = DhanClient::with_base(reqwest::Client::new(), &base, fast());
        let bars = client
            .fetch_history(
                &creds(),
                &inst(),
                Interval::Daily,
                Some(NOW - 30 * 86_400_000),
                Some(NOW),
                NOW,
            )
            .await
            .unwrap();

        assert_eq!(bars.len(), 2);
        assert_eq!(bars[0].close, 104.0);
        let req = &log.lock().unwrap()[0];
        assert_eq!((req.method.as_str(), req.path.as_str()), ("POST", "/charts/historical"));
        assert_eq!(req.header("access-token"), Some("tok.en.sig"));
        assert_eq!(req.header("client-id"), Some("1000000001"));
        assert_eq!(req.header("dhanClientId"), Some("1000000001"));
        assert_eq!(req.body["securityId"], "2885");
        assert_eq!(req.body["exchangeSegment"], "NSE_EQ");
        assert_eq!(req.body["instrument"], "EQUITY");
        assert!(req.body["fromDate"].as_str().unwrap().len() == 10);
    }

    #[tokio::test]
    async fn a_rate_limit_response_is_retried_transparently() {
        let limited = json!({"errorType":"Rate_Limit","errorCode":"DH-904","errorMessage":"Too many requests"});
        let (base, log) = mock(vec![(429, limited), (200, daily_response())]).await;
        let client = DhanClient::with_base(reqwest::Client::new(), &base, fast());
        let bars = client
            .fetch_history(&creds(), &inst(), Interval::Daily, None, Some(NOW), NOW)
            .await
            .unwrap();
        assert_eq!(bars.len(), 2);
        assert_eq!(log.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn persistent_rate_limiting_eventually_gives_up_with_a_clear_error() {
        let limited = json!({"data":{"805":"Too many requests"},"status":"failed"});
        let (base, log) = mock(vec![(200, limited.clone()); 4]).await;
        let client = DhanClient::with_base(reqwest::Client::new(), &base, fast());
        let err = client
            .fetch_history(&creds(), &inst(), Interval::Daily, None, Some(NOW), NOW)
            .await
            .unwrap_err();
        assert_eq!(err.kind, DhanErrorKind::RateLimited);
        assert_eq!(log.lock().unwrap().len(), 4, "the first attempt plus three retries");
    }

    #[tokio::test]
    async fn an_auth_failure_is_reported_at_once_and_not_retried() {
        let expired = json!({"status":"failed","data":{"807":"Access token is expired"}});
        let (base, log) = mock(vec![(200, expired)]).await;
        let client = DhanClient::with_base(reqwest::Client::new(), &base, fast());
        let err = client
            .fetch_history(&creds(), &inst(), Interval::Daily, None, Some(NOW), NOW)
            .await
            .unwrap_err();
        assert_eq!(err.kind, DhanErrorKind::Auth);
        assert!(err.message().contains("expired"));
        assert_eq!(log.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn intraday_requests_fall_back_to_a_numeric_interval_if_the_string_is_refused() {
        let refused =
            json!({"errorType":"Input_Exception","errorCode":"DH-905","errorMessage":"interval must be a number"});
        let ok = json!({"open":[100.0],"high":[101.0],"low":[99.0],"close":[100.5],"volume":[10],"timestamp":[1_799_900_100]});
        let (base, log) = mock(vec![(400, refused), (200, ok)]).await;
        let client = DhanClient::with_base(reqwest::Client::new(), &base, fast());
        let from = NOW - 2 * 86_400_000;
        let bars = client
            .fetch_history(&creds(), &inst(), Interval::Minutes(5), Some(from), Some(NOW), NOW)
            .await
            .unwrap();
        assert_eq!(bars.len(), 1);
        let requests = log.lock().unwrap();
        assert_eq!(requests[0].path, "/charts/intraday");
        assert_eq!(requests[0].body["interval"], "5");
        assert_eq!(requests[1].body["interval"], 5, "second attempt uses a number");
    }

    #[tokio::test]
    async fn a_long_intraday_span_becomes_several_requests_that_are_stitched_together() {
        let chunk =
            |t: i64| json!({"open":[100.0],"high":[101.0],"low":[99.0],"close":[100.5],"volume":[10],"timestamp":[t]});
        // Bars in 3 consecutive 90-day windows, returned by the server in order.
        let (base, log) = mock(vec![
            (200, chunk(1_790_000_000)),
            (200, chunk(1_795_000_000)),
            (200, chunk(1_799_000_000)),
        ])
        .await;
        let client = DhanClient::with_base(reqwest::Client::new(), &base, fast());
        let from = NOW - 200 * 86_400_000;
        let bars = client
            .fetch_history(&creds(), &inst(), Interval::Minutes(15), Some(from), Some(NOW), NOW)
            .await
            .unwrap();
        assert_eq!(log.lock().unwrap().len(), 3);
        assert_eq!(bars.len(), 3);
        assert!(bars.windows(2).all(|w| w[0].time < w[1].time), "sorted oldest first");
    }

    #[tokio::test]
    async fn quotes_post_one_body_grouped_by_segment_and_parse_the_reply() {
        let reply = json!({"status":"success","data":{"NSE_EQ":{"2885":{"last_price":1226.4,"net_change":-17.5}}}});
        let (base, log) = mock(vec![(200, reply)]).await;
        let client = DhanClient::with_base(reqwest::Client::new(), &base, fast());
        let quotes = client.quotes(&creds(), &[inst()]).await.unwrap();
        assert_eq!(quotes[0].symbol, "NSE:RELIANCE");
        assert_eq!(quotes[0].price, Some(1226.4));
        let req = &log.lock().unwrap()[0];
        assert_eq!(req.path, "/marketfeed/quote");
        assert_eq!(req.body["NSE_EQ"], json!([2885]));
    }

    #[tokio::test]
    async fn renewing_a_token_uses_get_and_returns_the_new_token() {
        let (base, log) = mock(vec![(200, json!({"accessToken":"fresh.token.sig"}))]).await;
        let client = DhanClient::with_base(reqwest::Client::new(), &base, fast());
        assert_eq!(client.renew_token(&creds()).await.unwrap(), "fresh.token.sig");
        let req = &log.lock().unwrap()[0];
        assert_eq!((req.method.as_str(), req.path.as_str()), ("GET", "/RenewToken"));
        assert_eq!(req.header("access-token"), Some("tok.en.sig"));
    }

    #[tokio::test]
    async fn an_unreachable_server_is_a_network_error() {
        // Nothing is listening on this port.
        let client = DhanClient::with_base(reqwest::Client::new(), "http://127.0.0.1:1", fast());
        let err = client
            .fetch_history(&creds(), &inst(), Interval::Daily, None, Some(NOW), NOW)
            .await
            .unwrap_err();
        assert_eq!(err.kind, DhanErrorKind::Network);
    }
}
