//! HTTP client for Yahoo Finance's key-less endpoints. All parsing lives in
//! `yahoo.rs`; this file builds requests, moves bytes, and — because Yahoo
//! publishes no rate limits — keeps the app a polite client: every request is
//! paced and circuit-broken by the [`Gate`], quotes are batched, and repeat
//! lookups are answered from short-lived caches instead of Yahoo.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::header::RETRY_AFTER;
use reqwest::Url;
use serde_json::Value;

use crate::gate::{Gate, Limits, Refusal};
use crate::models::{Quote, SymbolMatch};
use crate::yahoo::{self, ChartData};

/// Yahoo rejects requests with no browser-like User-Agent.
const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/// A quote is reused this long, so a watchlist refresh, a window-focus refresh
/// and a second window all cost one request between them.
const QUOTE_TTL: Duration = Duration::from_secs(20);
/// Symbol search results change rarely; typing the same query again is free.
const SEARCH_TTL: Duration = Duration::from_secs(5 * 60);
const SEARCH_CACHE_ENTRIES: usize = 64;

type Cache<T> = Mutex<HashMap<String, (Instant, T)>>;

pub struct Market {
    client: reqwest::Client,
    host: String,
    gate: Gate,
    quotes: Cache<Quote>,
    searches: Cache<Vec<SymbolMatch>>,
}

fn chart_url(host: &str, symbol: &str) -> Url {
    let mut url = Url::parse(&format!("{host}/v8/finance/chart/")).expect("static base URL is valid");
    // push() percent-encodes the segment, so `^GSPC`, `BRK-B` and `EURUSD=X`
    // are all sent safely.
    url.path_segments_mut()
        .expect("base URL has a path")
        .pop_if_empty()
        .push(symbol);
    url
}

fn fresh<T: Clone>(cache: &Cache<T>, key: &str, ttl: Duration) -> Option<T> {
    let cache = cache.lock().unwrap_or_else(|e| e.into_inner());
    cache
        .get(key)
        .filter(|(at, _)| at.elapsed() < ttl)
        .map(|(_, value)| value.clone())
}

impl Market {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(15))
            .build()
            .expect("failed to build HTTP client");
        Self::with_host(client, yahoo::HOST, Limits::default())
    }

    fn with_host(client: reqwest::Client, host: &str, limits: Limits) -> Self {
        Market {
            client,
            host: host.trim_end_matches('/').to_string(),
            gate: Gate::new(limits),
            quotes: Mutex::default(),
            searches: Mutex::default(),
        }
    }

    /// Waits for this request's turn. Fails fast, without touching the
    /// network, while Yahoo has told us to back off.
    async fn wait_for_turn(&self) -> Result<(), String> {
        let delay = self.gate.admit(Instant::now()).map_err(|r| r.to_string())?;
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
            // A 429 may have landed while this request queued.
            if let Some(left) = self.gate.paused_for(Instant::now()) {
                return Err(Refusal::Paused(left).to_string());
            }
        }
        Ok(())
    }

    async fn get_json(&self, url: Url) -> Result<Value, String> {
        self.wait_for_turn().await?;
        log::debug!("yahoo request: {}", url.path());
        let resp = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("network error: {e}"))?;
        let status = resp.status();

        if status.as_u16() == 429 {
            let retry_after = resp
                .headers()
                .get(RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse::<u64>().ok())
                .map(Duration::from_secs);
            let pause = self.gate.rate_limited(Instant::now(), retry_after);
            log::warn!("Yahoo Finance answered 429; pausing all requests for {pause:?}");
            return Err(Refusal::Paused(pause).to_string());
        }
        // Anything but a 429 (even a 404 for an unknown symbol) means Yahoo is answering.
        self.gate.succeeded(Instant::now());

        // Yahoo answers an unknown symbol with a 404 that still carries a
        // JSON error body worth showing, so parse before judging the status.
        resp.json::<Value>()
            .await
            .map_err(|_| format!("Yahoo Finance returned HTTP {status}"))
    }

    pub async fn fetch_chart(
        &self,
        symbol: &str,
        interval: &str,
        period1: i64,
        period2: i64,
    ) -> Result<ChartData, String> {
        let mut url = chart_url(&self.host, symbol);
        url.query_pairs_mut()
            .append_pair("period1", &period1.to_string())
            .append_pair("period2", &period2.to_string())
            .append_pair("interval", interval)
            .append_pair("includePrePost", "false");
        let body = self.get_json(url).await?;
        yahoo::parse_chart(&body).map_err(|e| format!("{symbol}: {e}"))
    }

    pub async fn search(&self, query: &str, limit: u32) -> Result<Vec<SymbolMatch>, String> {
        let key = format!("{limit}:{}", query.trim().to_lowercase());
        if let Some(hit) = fresh(&self.searches, &key, SEARCH_TTL) {
            return Ok(hit);
        }

        let mut url = Url::parse(&format!("{}/v1/finance/search", self.host)).expect("static URL is valid");
        url.query_pairs_mut()
            .append_pair("q", query)
            .append_pair("quotesCount", &limit.to_string())
            .append_pair("newsCount", "0")
            .append_pair("listsCount", "0");
        let matches = yahoo::parse_search(&self.get_json(url).await?);

        let mut cache = self.searches.lock().unwrap_or_else(|e| e.into_inner());
        if cache.len() >= SEARCH_CACHE_ENTRIES {
            cache.retain(|_, (at, _)| at.elapsed() < SEARCH_TTL);
            if cache.len() >= SEARCH_CACHE_ENTRIES {
                cache.clear();
            }
        }
        cache.insert(key, (Instant::now(), matches.clone()));
        Ok(matches)
    }

    /// One quote per entry of `symbols`, in order. Never fails as a whole: a
    /// symbol that can't be quoted comes back with `error` set, so one bad
    /// ticker doesn't blank the rest of a list. Symbols quoted within
    /// [`QUOTE_TTL`] are served from memory; the rest go to Yahoo in batches
    /// of [`yahoo::SPARK_MAX_SYMBOLS`], so a 100-symbol watchlist costs 5
    /// requests, not 100.
    pub async fn quotes(&self, symbols: &[String]) -> Vec<Quote> {
        let mut found: HashMap<&str, Quote> = HashMap::new();
        let mut missing: Vec<String> = Vec::new();
        let mut seen: HashSet<&str> = HashSet::new();
        for symbol in symbols {
            if !seen.insert(symbol.as_str()) {
                continue;
            }
            match fresh(&self.quotes, symbol, QUOTE_TTL) {
                Some(quote) => {
                    found.insert(symbol.as_str(), quote);
                }
                None => missing.push(symbol.clone()),
            }
        }

        let mut fetched: HashMap<String, Quote> = HashMap::new();
        for batch in missing.chunks(yahoo::SPARK_MAX_SYMBOLS) {
            for quote in self.spark(batch).await {
                if quote.error.is_none() {
                    let mut cache = self.quotes.lock().unwrap_or_else(|e| e.into_inner());
                    cache.insert(quote.symbol.clone(), (Instant::now(), quote.clone()));
                }
                fetched.insert(quote.symbol.clone(), quote);
            }
        }

        symbols
            .iter()
            .map(|symbol| {
                found
                    .get(symbol.as_str())
                    .or_else(|| fetched.get(symbol))
                    .cloned()
                    .unwrap_or_else(|| yahoo::quote_error(symbol, "no data returned"))
            })
            .collect()
    }

    /// One request for up to [`yahoo::SPARK_MAX_SYMBOLS`] symbols.
    async fn spark(&self, symbols: &[String]) -> Vec<Quote> {
        let mut url = Url::parse(&format!("{}/v8/finance/spark", self.host)).expect("static URL is valid");
        url.query_pairs_mut()
            .append_pair("symbols", &symbols.join(","))
            .append_pair("range", "5d")
            .append_pair("interval", "1d");
        match self.get_json(url).await {
            Ok(body) => yahoo::parse_spark(&body, symbols),
            Err(error) => symbols.iter().map(|s| yahoo::quote_error(s, &error)).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    struct Reply {
        status: u16,
        headers: Vec<(&'static str, &'static str)>,
        body: String,
    }

    impl Reply {
        fn json(status: u16, body: &str) -> Self {
            Reply {
                status,
                headers: Vec::new(),
                body: body.to_string(),
            }
        }
    }

    /// A local HTTP server that answers every request via `handler` (given the
    /// path and query) and records each one, so tests can count what was sent.
    async fn mock(handler: impl Fn(&str) -> Reply + Send + Sync + 'static) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let handler = Arc::new(handler);
        let log = requests.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let (handler, log) = (handler.clone(), log.clone());
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        let mut chunk = [0u8; 4096];
                        match sock.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        }
                    }
                    let head = String::from_utf8_lossy(&buf).to_string();
                    let target = head.split(' ').nth(1).unwrap_or("/").to_string();
                    log.lock().unwrap().push(target.clone());
                    let reply = handler(&target);
                    let extra: String = reply.headers.iter().map(|(k, v)| format!("{k}: {v}\r\n")).collect();
                    let response = format!(
                        "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{}",
                        reply.status,
                        reply.body.len(),
                        reply.body
                    );
                    let _ = sock.write_all(response.as_bytes()).await;
                });
            }
        });
        (host, requests)
    }

    fn fast() -> Limits {
        Limits {
            min_gap: Duration::from_millis(1),
            ..Limits::default()
        }
    }

    fn market(host: &str) -> Market {
        Market::with_host(reqwest::Client::new(), host, fast())
    }

    fn syms(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("S{i}")).collect()
    }

    /// A spark answer covering exactly the symbols asked for.
    fn spark_reply(target: &str) -> Reply {
        let url = Url::parse(&format!("http://x{target}")).unwrap();
        let symbols = url
            .query_pairs()
            .find(|(k, _)| k == "symbols")
            .map(|(_, v)| v.to_string())
            .unwrap_or_default();
        let entries: Vec<String> = symbols
            .split(',')
            .map(|s| format!(r#""{s}":{{"close":[1.0,2.0],"fulldayPrice":2.0}}"#))
            .collect();
        Reply::json(200, &format!("{{{}}}", entries.join(",")))
    }

    #[test]
    fn chart_url_encodes_special_symbols_as_a_single_path_segment() {
        for symbol in ["^GSPC", "EURUSD=X", "BRK-B", "RELIANCE.NS"] {
            let url = chart_url(yahoo::HOST, symbol);
            let segments: Vec<_> = url.path_segments().unwrap().collect();
            assert_eq!(segments.len(), 4, "{symbol}: {url}");
            assert_eq!(&segments[..3], ["v8", "finance", "chart"]);
        }
    }

    #[test]
    fn a_symbol_containing_a_slash_cannot_escape_its_segment() {
        let url = chart_url(yahoo::HOST, "../../etc");
        assert_eq!(url.path_segments().unwrap().count(), 4);
    }

    #[tokio::test]
    async fn a_429_stops_every_further_request_without_touching_the_network() {
        let (host, requests) = mock(|_| Reply {
            status: 429,
            headers: vec![("Retry-After", "45")],
            body: "Too Many Requests".to_string(),
        })
        .await;
        let market = market(&host);

        let first = market.fetch_chart("AAPL", "1d", 0, 100).await.err().unwrap();
        assert!(first.contains("rate limiting"), "{first}");
        assert!(first.contains("45s"), "the server's Retry-After is honoured: {first}");

        // Every kind of request is refused locally while paused.
        let chart = market.fetch_chart("MSFT", "1d", 0, 100).await.err().unwrap();
        let search = market.search("apple", 5).await.err().unwrap();
        let quotes = market.quotes(&syms(3)).await;
        assert!(chart.contains("paused"), "{chart}");
        assert!(search.contains("paused"), "{search}");
        assert!(quotes
            .iter()
            .all(|q| q.error.as_deref().is_some_and(|e| e.contains("paused"))));

        assert_eq!(
            requests.lock().unwrap().len(),
            1,
            "only the request that got the 429 was sent"
        );
    }

    #[tokio::test]
    async fn requests_queued_behind_a_429_are_dropped_when_it_lands() {
        let (host, requests) = mock(|_| Reply::json(429, "Too Many Requests")).await;
        let market = Market::with_host(
            reqwest::Client::new(),
            &host,
            Limits {
                min_gap: Duration::from_millis(150),
                ..Limits::default()
            },
        );
        // Four charts requested at once: the first answer is a 429, and the
        // three still waiting for their slots must not be sent.
        let results = futures::future::join_all((0..4).map(|i| market.fetch_chart("X", "1d", 0, i))).await;
        assert!(results.iter().all(Result::is_err));
        assert_eq!(requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn an_unknown_symbol_is_a_normal_answer_not_a_rate_limit() {
        let (host, requests) = mock(|_| {
            Reply::json(
                404,
                r#"{"chart":{"result":null,"error":{"code":"Not Found","description":"No data found, symbol may be delisted"}}}"#,
            )
        })
        .await;
        let market = market(&host);
        for _ in 0..3 {
            let err = market.fetch_chart("ZZZQQQ", "1d", 0, 100).await.err().unwrap();
            assert!(err.contains("No data found"), "{err}");
        }
        assert_eq!(requests.lock().unwrap().len(), 3, "the gate stayed open");
    }

    #[tokio::test]
    async fn quotes_go_out_in_batches_of_twenty() {
        let (host, requests) = mock(spark_reply).await;
        let market = market(&host);
        let quotes = market.quotes(&syms(45)).await;

        assert_eq!(quotes.len(), 45);
        assert!(quotes.iter().all(|q| q.error.is_none() && q.price == Some(2.0)));
        assert_eq!(
            quotes.iter().map(|q| q.symbol.clone()).collect::<Vec<_>>(),
            syms(45),
            "answers stay in request order"
        );
        let sent = requests.lock().unwrap();
        assert_eq!(sent.len(), 3, "20 + 20 + 5 symbols");
        assert!(sent.iter().all(|t| t.starts_with("/v8/finance/spark?")));
    }

    #[tokio::test]
    async fn quotes_are_cached_so_a_repeat_refresh_costs_nothing() {
        let (host, requests) = mock(spark_reply).await;
        let market = market(&host);
        market.quotes(&syms(10)).await;
        market.quotes(&syms(10)).await;
        assert_eq!(requests.lock().unwrap().len(), 1);

        // Only the symbol that isn't cached is requested.
        let mut more = syms(10);
        more.push("NEW".to_string());
        let quotes = market.quotes(&more).await;
        assert_eq!(quotes.len(), 11);
        let sent = requests.lock().unwrap();
        assert_eq!(sent.len(), 2);
        assert!(sent[1].contains("symbols=NEW&"), "{}", sent[1]);
    }

    #[tokio::test]
    async fn duplicate_symbols_in_one_call_are_requested_once() {
        let (host, requests) = mock(spark_reply).await;
        let market = market(&host);
        let symbols = vec!["A".to_string(), "B".to_string(), "A".to_string()];
        let quotes = market.quotes(&symbols).await;
        assert_eq!(
            quotes.iter().map(|q| q.symbol.as_str()).collect::<Vec<_>>(),
            ["A", "B", "A"]
        );
        assert!(requests.lock().unwrap()[0].contains("symbols=A%2CB&"));
    }

    #[tokio::test]
    async fn failed_quotes_are_not_cached() {
        let (host, requests) = mock(|_| Reply::json(500, "not json")).await;
        let market = market(&host);
        let first = market.quotes(&syms(2)).await;
        assert!(first.iter().all(|q| q.error.is_some()));
        market.quotes(&syms(2)).await;
        assert_eq!(requests.lock().unwrap().len(), 2, "the second call tried again");
    }

    #[tokio::test]
    async fn special_symbols_survive_the_batch_request() {
        let (host, requests) = mock(spark_reply).await;
        let market = market(&host);
        let symbols: Vec<String> = ["^GSPC", "EURUSD=X", "RELIANCE.NS", "BTC-USD"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let quotes = market.quotes(&symbols).await;
        assert!(quotes.iter().all(|q| q.error.is_none()), "{quotes:?}");
        assert_eq!(requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn repeated_searches_are_answered_from_the_cache() {
        let (host, requests) = mock(|_| {
            Reply::json(
                200,
                r#"{"quotes":[{"symbol":"AAPL","shortname":"Apple","exchDisp":"NASDAQ","quoteType":"EQUITY"}]}"#,
            )
        })
        .await;
        let market = market(&host);
        let first = market.search("Apple", 8).await.unwrap();
        let again = market.search("  apple ", 8).await.unwrap();
        assert_eq!(first, again);
        assert_eq!(
            requests.lock().unwrap().len(),
            1,
            "case and padding don't make a new query"
        );

        market.search("apple", 3).await.unwrap();
        assert_eq!(
            requests.lock().unwrap().len(),
            2,
            "a different limit is a different query"
        );
    }
}
