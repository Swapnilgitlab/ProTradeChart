//! Zerodha's live market feed (the Kite WebSocket).
//!
//! One connection is shared by every chart, tab and window: a Kite API key may
//! open only 3 connections, so letting each webview open its own would use them
//! up at once. The Rust side owns the socket, counts how many charts want each
//! instrument, connects when the first one arrives, disconnects when the last
//! one leaves, and reconnects with backoff when the link drops. Ticks and
//! status changes go out through callbacks, which `lib.rs` turns into events.
//!
//! Requests are JSON; market data is binary, big-endian, and a single message
//! carries several packets: a 2-byte packet count, then for each packet a
//! 2-byte length and its bytes. The packet layouts are from Kite's docs.
//!
//! Unlike Dhan's feed, this one refuses a bad key or token during the HTTP
//! handshake (status 400, with a JSON message), so a credential problem is
//! reported precisely instead of being inferred from repeated hang-ups.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::{self, Message};

use super::client::Credentials;
use super::protocol::{ZerodhaError, FEED_URL};

/// An instrument token.
pub type Token = i64;

/// Full mode adds the last-trade time (and depth we don't chart) to the price
/// and day volume; the time is what lets a tick land in the right candle.
const MODE: &str = "full";
/// Instruments per subscribe message (Kite allows 3000 per connection).
const MAX_PER_MESSAGE: usize = 500;
/// After this many quick drops in a row, stop retrying and tell the user.
const MAX_QUICK_DROPS: u32 = 3;

/// One price update, as delivered to the webview.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TickEvent {
    pub token: Token,
    pub ltp: f64,
    /// Last-trade time in epoch seconds, when the packet carries one.
    pub ltt: Option<i64>,
    /// Total volume traded so far today (tradable instruments only).
    pub volume: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StatusEvent {
    /// `idle`, `connecting`, `live`, `reconnecting` or `error`.
    pub state: String,
    pub message: Option<String>,
}

impl StatusEvent {
    fn new(state: &str, message: Option<String>) -> Self {
        StatusEvent {
            state: state.to_string(),
            message,
        }
    }
}

// ---- Packets ---------------------------------------------------------------

fn slice<const N: usize>(data: &[u8], at: usize) -> Option<[u8; N]> {
    data.get(at..at + N)?.try_into().ok()
}

fn i32_at(data: &[u8], at: usize) -> Option<i64> {
    slice::<4>(data, at).map(|b| i32::from_be_bytes(b) as i64)
}

fn u16_at(data: &[u8], at: usize) -> Option<usize> {
    slice::<2>(data, at).map(|b| u16::from_be_bytes(b) as usize)
}

/// Prices arrive as integers in the smallest unit: paise for most instruments,
/// but ten-millionths for currencies and ten-thousandths for BSE currencies.
/// The exchange segment is the token's low byte.
fn price_divisor(token: Token) -> f64 {
    match token & 0xff {
        3 => 10_000_000.0,
        6 => 10_000.0,
        _ => 100.0,
    }
}

/// Parses one quote packet. Its length says what it is: 8 bytes is a bare
/// last price; 28 or 32 an index (the longer with an exchange timestamp);
/// 44 or 184 a tradable instrument in quote or full mode. Anything else, or a
/// packet with no usable price, is `None` — dropped, never guessed at.
pub fn parse_packet(packet: &[u8]) -> Option<TickEvent> {
    let token = i32_at(packet, 0)?;
    let ltp = i32_at(packet, 4)? as f64 / price_divisor(token);
    if !ltp.is_finite() || ltp <= 0.0 {
        return None;
    }
    let positive = |v: Option<i64>| v.filter(|t| *t > 0);
    let (ltt, volume) = match packet.len() {
        8 | 28 => (None, None),
        32 => (positive(i32_at(packet, 28)), None),
        44 => (None, i32_at(packet, 16)),
        // Last-trade time at 44, and the exchange's own timestamp at 60 as a fallback.
        184 => (
            positive(i32_at(packet, 44)).or_else(|| positive(i32_at(packet, 60))),
            i32_at(packet, 16),
        ),
        _ => return None,
    };
    Some(TickEvent {
        token,
        ltp,
        ltt,
        volume,
    })
}

/// Parses one binary message into its ticks. A 1-byte message is Kite's
/// heartbeat; a message cut short yields whatever came before the cut.
pub fn parse_message(data: &[u8]) -> Vec<TickEvent> {
    let Some(count) = u16_at(data, 0) else {
        return Vec::new();
    };
    let mut ticks = Vec::with_capacity(count);
    let mut at = 2;
    for _ in 0..count {
        let Some(len) = u16_at(data, at) else { break };
        let Some(packet) = data.get(at + 2..at + 2 + len) else {
            break;
        };
        ticks.extend(parse_packet(packet));
        at += 2 + len;
    }
    ticks
}

// ---- Requests --------------------------------------------------------------

pub fn subscribe_message(tokens: &[Token]) -> String {
    json!({"a": "subscribe", "v": tokens}).to_string()
}

pub fn unsubscribe_message(tokens: &[Token]) -> String {
    json!({"a": "unsubscribe", "v": tokens}).to_string()
}

pub fn mode_message(mode: &str, tokens: &[Token]) -> String {
    json!({"a": "mode", "v": [mode, tokens]}).to_string()
}

const REJECTED_MESSAGE: &str = "Zerodha rejected your API key or access token. Kite tokens expire every morning — \
open Data providers and log in again.";

const QUICK_DROP_MESSAGE: &str = "Zerodha keeps closing the live feed the moment it opens. Check your API key and \
log in again in Data providers.";

/// A text message from the feed. Order updates and broker messages are of no
/// use to a chart; an error that mentions the token means it needs replacing.
fn fatal_text_message(text: &str) -> Option<String> {
    let v: Value = serde_json::from_str(text).ok()?;
    if v.get("type").and_then(Value::as_str) != Some("error") {
        return None;
    }
    let detail = v.get("data").and_then(Value::as_str).unwrap_or("").to_lowercase();
    (detail.contains("token") || detail.contains("api_key")).then(|| REJECTED_MESSAGE.to_string())
}

// ---- The shared connection -------------------------------------------------

pub struct FeedConfig {
    /// Where to connect, e.g. `wss://ws.kite.trade` (tests point this at a local server).
    pub base_url: String,
    /// Read fresh at every connect, so a new token takes effect on reconnect.
    pub credentials: Arc<dyn Fn() -> Option<Credentials> + Send + Sync>,
    pub on_tick: Arc<dyn Fn(TickEvent) + Send + Sync>,
    pub on_status: Arc<dyn Fn(StatusEvent) + Send + Sync>,
    pub backoff_start: Duration,
    pub backoff_max: Duration,
    /// No message at all (Kite sends a heartbeat every couple of seconds) for
    /// this long means the link is dead.
    pub idle_timeout: Duration,
    /// A connection that ends within this long of opening, having delivered no
    /// data, counts as a "quick drop".
    pub quick_drop_window: Duration,
}

impl FeedConfig {
    pub fn production(
        credentials: Arc<dyn Fn() -> Option<Credentials> + Send + Sync>,
        on_tick: Arc<dyn Fn(TickEvent) + Send + Sync>,
        on_status: Arc<dyn Fn(StatusEvent) + Send + Sync>,
    ) -> Self {
        FeedConfig {
            base_url: FEED_URL.to_string(),
            credentials,
            on_tick,
            on_status,
            backoff_start: Duration::from_secs(1),
            backoff_max: Duration::from_secs(30),
            idle_timeout: Duration::from_secs(30),
            quick_drop_window: Duration::from_secs(5),
        }
    }
}

enum Cmd {
    Subscribe(Token),
    Unsubscribe(Token),
    /// Credentials or the token changed: drop the connection and start over.
    Reconnect,
}

#[derive(Clone)]
pub struct Feed {
    tx: mpsc::UnboundedSender<Cmd>,
    status: Arc<Mutex<StatusEvent>>,
}

impl Feed {
    pub fn start(cfg: FeedConfig) -> Feed {
        let (tx, rx) = mpsc::unbounded_channel();
        let status = Arc::new(Mutex::new(StatusEvent::new("idle", None)));
        let cfg = Arc::new(cfg);
        tauri::async_runtime::spawn(run(cfg, rx, status.clone()));
        Feed { tx, status }
    }

    pub fn subscribe(&self, token: Token) {
        let _ = self.tx.send(Cmd::Subscribe(token));
    }

    pub fn unsubscribe(&self, token: Token) {
        let _ = self.tx.send(Cmd::Unsubscribe(token));
    }

    pub fn reconnect(&self) {
        let _ = self.tx.send(Cmd::Reconnect);
    }

    pub fn status(&self) -> StatusEvent {
        self.status
            .lock()
            .map(|s| s.clone())
            .unwrap_or_else(|_| StatusEvent::new("idle", None))
    }
}

type Subs = HashMap<Token, usize>;

fn apply(subs: &mut Subs, cmd: &Cmd) -> bool {
    match cmd {
        Cmd::Subscribe(t) => {
            *subs.entry(*t).or_insert(0) += 1;
            true
        }
        Cmd::Unsubscribe(t) => {
            if let Some(n) = subs.get_mut(t) {
                *n -= 1;
                if *n == 0 {
                    subs.remove(t);
                }
            }
            true
        }
        Cmd::Reconnect => false,
    }
}

enum SessionEnd {
    /// Nobody is subscribed any more.
    Idle,
    /// A command asked for a fresh connection.
    Reconnect,
    /// Something the user must fix; don't retry.
    Fatal(String),
    /// The link dropped; retry with backoff. The flag says whether any market
    /// data had arrived before it did.
    Lost(String, bool),
    /// The app is shutting down.
    Shutdown,
}

fn set_status(cfg: &FeedConfig, shared: &Mutex<StatusEvent>, state: &str, message: Option<String>) {
    let event = StatusEvent::new(state, message);
    if let Ok(mut s) = shared.lock() {
        if *s == event {
            return;
        }
        *s = event.clone();
    }
    (cfg.on_status)(event);
}

fn feed_url(base: &str, creds: &Credentials) -> Result<String, String> {
    let mut url = reqwest::Url::parse(base).map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("api_key", &creds.api_key)
        .append_pair("access_token", &creds.access_token);
    Ok(url.to_string())
}

async fn run(cfg: Arc<FeedConfig>, mut rx: mpsc::UnboundedReceiver<Cmd>, shared: Arc<Mutex<StatusEvent>>) {
    let mut subs: Subs = HashMap::new();
    let mut backoff = cfg.backoff_start;
    let mut quick_drops = 0u32;
    // After a fatal error the feed stays quiet until the user changes
    // something (a Reconnect, or a new subscription request).
    let mut blocked = false;

    loop {
        // Nothing wanted: stay disconnected.
        while subs.is_empty() || blocked {
            let Some(cmd) = rx.recv().await else { return };
            let reconnect = !apply(&mut subs, &cmd);
            if reconnect || matches!(cmd, Cmd::Subscribe(_)) {
                blocked = false;
            }
            if subs.is_empty() {
                set_status(&cfg, &shared, "idle", None);
            }
        }

        let Some(creds) = (cfg.credentials)() else {
            set_status(&cfg, &shared, "error", Some(ZerodhaError::not_configured().message()));
            blocked = true;
            continue;
        };
        let url = match feed_url(&cfg.base_url, &creds) {
            Ok(u) => u,
            Err(e) => {
                set_status(&cfg, &shared, "error", Some(format!("bad feed address: {e}")));
                blocked = true;
                continue;
            }
        };

        set_status(
            &cfg,
            &shared,
            if backoff == cfg.backoff_start {
                "connecting"
            } else {
                "reconnecting"
            },
            None,
        );
        match tokio_tungstenite::connect_async(url.as_str()).await {
            Ok((ws, _)) => {
                backoff = cfg.backoff_start;
                let opened = tokio::time::Instant::now();
                match session(ws, &cfg, &shared, &mut subs, &mut rx).await {
                    SessionEnd::Idle => {
                        quick_drops = 0;
                        set_status(&cfg, &shared, "idle", None)
                    }
                    SessionEnd::Reconnect => quick_drops = 0,
                    SessionEnd::Fatal(message) => {
                        quick_drops = 0;
                        set_status(&cfg, &shared, "error", Some(message));
                        blocked = true;
                    }
                    SessionEnd::Lost(reason, got_data) => {
                        quick_drops = if !got_data && opened.elapsed() < cfg.quick_drop_window {
                            quick_drops + 1
                        } else {
                            0
                        };
                        if quick_drops >= MAX_QUICK_DROPS {
                            quick_drops = 0;
                            set_status(&cfg, &shared, "error", Some(QUICK_DROP_MESSAGE.to_string()));
                            blocked = true;
                        } else {
                            set_status(&cfg, &shared, "reconnecting", Some(reason));
                            if wait_or_command(&mut rx, &mut subs, backoff).await {
                                return;
                            }
                            backoff = (backoff * 2).min(cfg.backoff_max);
                        }
                    }
                    SessionEnd::Shutdown => return,
                }
            }
            // Kite refuses a bad key or token during the handshake.
            Err(tungstenite::Error::Http(resp)) if matches!(resp.status().as_u16(), 400 | 401 | 403) => {
                let body = resp
                    .body()
                    .as_deref()
                    .and_then(|b| std::str::from_utf8(b).ok())
                    .unwrap_or("");
                log::warn!("Zerodha refused the live feed ({}): {body}", resp.status());
                set_status(&cfg, &shared, "error", Some(REJECTED_MESSAGE.to_string()));
                blocked = true;
            }
            Err(e) => {
                set_status(&cfg, &shared, "reconnecting", Some(e.to_string()));
                if wait_or_command(&mut rx, &mut subs, backoff).await {
                    return;
                }
                backoff = (backoff * 2).min(cfg.backoff_max);
            }
        }
    }
}

/// Sleeps for `delay`, applying any commands that arrive meanwhile. Returns
/// true if the command channel closed (the app is exiting).
async fn wait_or_command(rx: &mut mpsc::UnboundedReceiver<Cmd>, subs: &mut Subs, delay: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + delay;
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => return false,
            cmd = rx.recv() => match cmd {
                Some(c) => { apply(subs, &c); }
                None => return true,
            },
        }
    }
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Subscribes to `tokens` and puts them in the mode that carries trade times.
async fn subscribe_all(ws: &mut Socket, tokens: &[Token]) -> Result<(), tungstenite::Error> {
    for batch in tokens.chunks(MAX_PER_MESSAGE) {
        ws.send(Message::text(subscribe_message(batch))).await?;
        ws.send(Message::text(mode_message(MODE, batch))).await?;
    }
    Ok(())
}

async fn session(
    mut ws: Socket,
    cfg: &FeedConfig,
    shared: &Mutex<StatusEvent>,
    subs: &mut Subs,
    rx: &mut mpsc::UnboundedReceiver<Cmd>,
) -> SessionEnd {
    let wanted: Vec<Token> = subs.keys().copied().collect();
    let mut got_data = false;
    if let Err(e) = subscribe_all(&mut ws, &wanted).await {
        return SessionEnd::Lost(e.to_string(), got_data);
    }
    set_status(cfg, shared, "live", None);

    loop {
        tokio::select! {
            incoming = timeout(cfg.idle_timeout, ws.next()) => match incoming {
                Err(_) => return SessionEnd::Lost("the feed went silent".into(), got_data),
                Ok(None) => return SessionEnd::Lost("the connection closed".into(), got_data),
                Ok(Some(Err(e))) => return SessionEnd::Lost(e.to_string(), got_data),
                Ok(Some(Ok(Message::Binary(data)))) => {
                    for tick in parse_message(&data) {
                        got_data = true;
                        (cfg.on_tick)(tick);
                    }
                }
                Ok(Some(Ok(Message::Text(text)))) => {
                    if let Some(message) = fatal_text_message(&text) {
                        return SessionEnd::Fatal(message);
                    }
                }
                Ok(Some(Ok(Message::Close(_)))) => return SessionEnd::Lost("the server closed the connection".into(), got_data),
                // Pings are answered by the library as we keep reading.
                Ok(Some(Ok(_))) => {}
            },
            cmd = rx.recv() => {
                let Some(cmd) = cmd else { return SessionEnd::Shutdown };
                match cmd {
                    Cmd::Reconnect => { let _ = ws.close(None).await; return SessionEnd::Reconnect }
                    Cmd::Subscribe(token) => {
                        let is_new = !subs.contains_key(&token);
                        apply(subs, &Cmd::Subscribe(token));
                        if is_new {
                            if let Err(e) = subscribe_all(&mut ws, &[token]).await {
                                return SessionEnd::Lost(e.to_string(), got_data);
                            }
                        }
                    }
                    Cmd::Unsubscribe(token) => {
                        apply(subs, &Cmd::Unsubscribe(token));
                        if !subs.contains_key(&token) {
                            let _ = ws.send(Message::text(unsubscribe_message(&[token]))).await;
                        }
                        if subs.is_empty() {
                            let _ = ws.close(None).await;
                            return SessionEnd::Idle;
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::time::sleep;

    // ---- building packets the way Kite lays them out (big-endian) ----

    fn ltp_packet(token: i32, paise: i32) -> Vec<u8> {
        let mut p = token.to_be_bytes().to_vec();
        p.extend_from_slice(&paise.to_be_bytes());
        p
    }

    /// A 44-byte quote packet: price, last qty, average, volume, buy/sell qty, OHLC.
    fn quote_packet(token: i32, paise: i32, volume: i32) -> Vec<u8> {
        let mut p = ltp_packet(token, paise);
        for field in [5, 123_456, volume, 1000, 2000, 100, 110, 90, 105] {
            p.extend_from_slice(&field.to_be_bytes());
        }
        assert_eq!(p.len(), 44);
        p
    }

    /// A 184-byte full packet: the quote fields, then times, open interest and depth.
    fn full_packet(token: i32, paise: i32, volume: i32, ltt: i32, exchange_ts: i32) -> Vec<u8> {
        let mut p = quote_packet(token, paise, volume);
        p.extend_from_slice(&ltt.to_be_bytes()); // 44: last trade time
        p.extend_from_slice(&0i32.to_be_bytes()); // 48: open interest
        p.extend_from_slice(&0i32.to_be_bytes()); // 52: OI day high
        p.extend_from_slice(&0i32.to_be_bytes()); // 56: OI day low
        p.extend_from_slice(&exchange_ts.to_be_bytes()); // 60: exchange timestamp
        p.resize(184, 0); // 64..184: market depth
        p
    }

    fn index_packet(token: i32, points_x100: i32, exchange_ts: Option<i32>) -> Vec<u8> {
        let mut p = ltp_packet(token, points_x100);
        for field in [2_600_000i32, 2_490_000, 2_500_000, 2_510_000, -10_000] {
            p.extend_from_slice(&field.to_be_bytes()); // high, low, open, close, change
        }
        if let Some(ts) = exchange_ts {
            p.extend_from_slice(&ts.to_be_bytes());
        }
        p
    }

    /// One binary message carrying `packets`.
    fn message(packets: &[Vec<u8>]) -> Vec<u8> {
        let mut m = (packets.len() as u16).to_be_bytes().to_vec();
        for p in packets {
            m.extend_from_slice(&(p.len() as u16).to_be_bytes());
            m.extend_from_slice(p);
        }
        m
    }

    // ---- packet parsing ----

    #[test]
    fn an_ltp_packet_yields_only_a_price_in_rupees() {
        let t = parse_packet(&ltp_packet(408065, 107_550)).unwrap();
        assert_eq!(t.token, 408065);
        assert!((t.ltp - 1075.5).abs() < 1e-9);
        assert_eq!((t.ltt, t.volume), (None, None));
    }

    #[test]
    fn a_quote_packet_adds_the_days_volume() {
        let t = parse_packet(&quote_packet(738561, 122_640, 5_432_100)).unwrap();
        assert!((t.ltp - 1226.4).abs() < 1e-9);
        assert_eq!(t.volume, Some(5_432_100));
        assert_eq!(t.ltt, None, "quote mode carries no timestamps");
    }

    #[test]
    fn a_full_packet_adds_the_last_trade_time() {
        let t = parse_packet(&full_packet(738561, 122_640, 5_432_100, 1_800_000_123, 1_800_000_100)).unwrap();
        assert_eq!((t.ltt, t.volume), (Some(1_800_000_123), Some(5_432_100)));
    }

    #[test]
    fn a_full_packet_without_a_trade_time_falls_back_to_the_exchange_timestamp() {
        let t = parse_packet(&full_packet(738561, 122_640, 10, 0, 1_800_000_100)).unwrap();
        assert_eq!(t.ltt, Some(1_800_000_100));
    }

    #[test]
    fn index_packets_are_recognised_by_their_shorter_length() {
        let quote = parse_packet(&index_packet(256265, 2_500_050, None)).unwrap();
        assert_eq!(quote.token, 256265);
        assert!((quote.ltp - 25000.5).abs() < 1e-9);
        assert_eq!((quote.ltt, quote.volume), (None, None), "indices have no volume");

        let full = parse_packet(&index_packet(256265, 2_500_050, Some(1_800_000_050))).unwrap();
        assert_eq!(full.ltt, Some(1_800_000_050));
    }

    #[test]
    fn currency_prices_use_a_different_divisor() {
        // Token low byte 3 is the currency segment: ten-millionths, not paise.
        let usdinr = 0x0000_0403; // an arbitrary token in that segment
        assert_eq!(usdinr & 0xff, 3);
        let t = parse_packet(&ltp_packet(usdinr, 836_250_000)).unwrap();
        assert!((t.ltp - 83.625).abs() < 1e-9, "{}", t.ltp);
        // BSE currency (segment 6) uses ten-thousandths.
        let bcd = 0x0000_0406;
        let t = parse_packet(&ltp_packet(bcd, 836_250)).unwrap();
        assert!((t.ltp - 83.625).abs() < 1e-9, "{}", t.ltp);
    }

    #[test]
    fn a_packet_with_no_price_or_an_unknown_shape_is_dropped() {
        assert!(parse_packet(&ltp_packet(1, 0)).is_none(), "zero price");
        assert!(parse_packet(&ltp_packet(1, -5)).is_none(), "negative price");
        assert!(parse_packet(&[0u8; 12]).is_none(), "12 bytes is no known layout");
        assert!(parse_packet(&[0u8; 4]).is_none(), "too short");
        assert!(parse_packet(&[]).is_none());
    }

    #[test]
    fn a_message_can_carry_several_packets_of_different_kinds() {
        let m = message(&[
            ltp_packet(408065, 107_550),
            index_packet(256265, 2_500_050, Some(1_800_000_050)),
            full_packet(738561, 122_640, 99, 1_800_000_001, 0),
        ]);
        let ticks = parse_message(&m);
        assert_eq!(
            ticks.iter().map(|t| t.token).collect::<Vec<_>>(),
            [408065, 256265, 738561]
        );
    }

    #[test]
    fn heartbeats_and_truncated_messages_are_survivable() {
        assert!(parse_message(&[0]).is_empty(), "the 1-byte heartbeat");
        assert!(parse_message(&[]).is_empty());
        assert!(parse_message(&message(&[])).is_empty());
        // The second packet is cut short: the first still comes through.
        let mut m = message(&[ltp_packet(1, 100), ltp_packet(2, 200)]);
        m.truncate(m.len() - 3);
        assert_eq!(parse_message(&m).len(), 1);
        // A count larger than what follows doesn't loop or panic.
        assert!(parse_message(&[0xff, 0xff, 0, 8]).is_empty());
    }

    #[test]
    fn one_unreadable_packet_does_not_lose_its_neighbours() {
        let m = message(&[ltp_packet(1, 100), vec![1, 2, 3], ltp_packet(3, 300)]);
        assert_eq!(parse_message(&m).iter().map(|t| t.token).collect::<Vec<_>>(), [1, 3]);
    }

    // ---- requests ----

    #[test]
    fn requests_are_the_json_kite_documents() {
        let sub: Value = serde_json::from_str(&subscribe_message(&[408065, 884737])).unwrap();
        assert_eq!(sub, json!({"a": "subscribe", "v": [408065, 884737]}));
        let unsub: Value = serde_json::from_str(&unsubscribe_message(&[408065])).unwrap();
        assert_eq!(unsub, json!({"a": "unsubscribe", "v": [408065]}));
        let mode: Value = serde_json::from_str(&mode_message("full", &[408065])).unwrap();
        assert_eq!(mode, json!({"a": "mode", "v": ["full", [408065]]}));
    }

    #[test]
    fn the_url_carries_the_key_and_token() {
        let url = feed_url(
            "wss://ws.kite.trade",
            &Credentials {
                api_key: "my key".into(),
                access_token: "t&k".into(),
            },
        )
        .unwrap();
        assert!(url.starts_with("wss://ws.kite.trade/?"), "{url}");
        assert!(
            url.contains("api_key=my+key") && url.contains("access_token=t%26k"),
            "{url}"
        );
    }

    #[test]
    fn only_token_errors_in_the_text_stream_are_fatal() {
        let fatal = fatal_text_message(r#"{"type":"error","data":"Invalid access_token"}"#).unwrap();
        assert!(fatal.contains("log in again"));
        assert!(fatal_text_message(r#"{"type":"error","data":"Too many instruments"}"#).is_none());
        assert!(fatal_text_message(r#"{"type":"order","data":{"status":"COMPLETE"}}"#).is_none());
        assert!(fatal_text_message(r#"{"type":"message","data":"market opens soon"}"#).is_none());
        assert!(fatal_text_message("not json").is_none());
    }

    #[test]
    fn subscriptions_are_counted_per_instrument() {
        let mut subs = Subs::new();
        apply(&mut subs, &Cmd::Subscribe(5));
        apply(&mut subs, &Cmd::Subscribe(5));
        apply(&mut subs, &Cmd::Unsubscribe(5));
        assert!(subs.contains_key(&5), "still wanted by the other chart");
        apply(&mut subs, &Cmd::Unsubscribe(5));
        assert!(subs.is_empty());
        apply(&mut subs, &Cmd::Unsubscribe(5)); // an extra unsubscribe must not underflow
        assert!(subs.is_empty());
    }

    // ---- the connection, against a local server ----

    type Ticks = Arc<Mutex<Vec<TickEvent>>>;
    type Statuses = Arc<Mutex<Vec<StatusEvent>>>;

    fn config(port: u16, creds: bool) -> (FeedConfig, Ticks, Statuses) {
        let ticks: Ticks = Arc::default();
        let statuses: Statuses = Arc::default();
        let (t, s) = (ticks.clone(), statuses.clone());
        let cfg = FeedConfig {
            base_url: format!("ws://127.0.0.1:{port}"),
            credentials: Arc::new(move || {
                creds.then(|| Credentials {
                    api_key: "mykey".into(),
                    access_token: "tok".into(),
                })
            }),
            on_tick: Arc::new(move |e| t.lock().unwrap().push(e)),
            on_status: Arc::new(move |e| s.lock().unwrap().push(e)),
            backoff_start: Duration::from_millis(20),
            backoff_max: Duration::from_millis(80),
            idle_timeout: Duration::from_secs(5),
            quick_drop_window: Duration::from_secs(2),
        };
        (cfg, ticks, statuses)
    }

    async fn eventually(what: &str, mut check: impl FnMut() -> bool) {
        for _ in 0..200 {
            if check() {
                return;
            }
            sleep(Duration::from_millis(25)).await;
        }
        panic!("timed out waiting for {what}");
    }

    async fn accept(listener: &TcpListener) -> tokio_tungstenite::WebSocketStream<tokio::net::TcpStream> {
        let (sock, _) = listener.accept().await.unwrap();
        tokio_tungstenite::accept_async(sock).await.unwrap()
    }

    // tungstenite's handshake callback returns a large `Response` in its error type.
    #[allow(clippy::result_large_err)]
    #[tokio::test(flavor = "multi_thread")]
    async fn it_subscribes_and_sets_full_mode_on_connect_then_delivers_ticks() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (seen_tx, mut seen_rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let (sock, req_path) = {
                let (sock, _) = listener.accept().await.unwrap();
                let mut path = String::new();
                let ws =
                    tokio_tungstenite::accept_hdr_async(sock, |req: &tungstenite::handshake::server::Request, resp| {
                        path = req.uri().to_string();
                        Ok(resp)
                    })
                    .await
                    .unwrap();
                (ws, path)
            };
            let mut ws = sock;
            seen_tx.send(json!({"path": req_path})).unwrap();
            for m in read_texts_from(&mut ws, 2).await {
                seen_tx.send(m).unwrap();
            }
            ws.send(Message::binary(message(&[
                full_packet(738561, 122_640, 5000, 1_800_000_000, 0),
                index_packet(256265, 2_500_050, Some(1_800_000_001)),
            ])))
            .await
            .unwrap();
            // Keep the socket open so the client stays connected.
            while ws.next().await.is_some() {}
        });

        let (cfg, ticks, statuses) = config(port, true);
        let feed = Feed::start(cfg);
        feed.subscribe(738561);

        let first = timeout(Duration::from_secs(5), seen_rx.recv()).await.unwrap().unwrap();
        let path = first["path"].as_str().unwrap();
        assert!(
            path.contains("api_key=mykey") && path.contains("access_token=tok"),
            "{path}"
        );
        let subscribe = seen_rx.recv().await.unwrap();
        assert_eq!(subscribe, json!({"a": "subscribe", "v": [738561]}));
        let mode = seen_rx.recv().await.unwrap();
        assert_eq!(mode, json!({"a": "mode", "v": ["full", [738561]]}));

        eventually("both ticks", || ticks.lock().unwrap().len() == 2).await;
        let t = ticks.lock().unwrap().clone();
        assert_eq!(
            (t[0].token, t[0].volume, t[0].ltt),
            (738561, Some(5000), Some(1_800_000_000))
        );
        assert_eq!(t[1].token, 256265);
        assert!(statuses.lock().unwrap().iter().any(|s| s.state == "live"));
        assert_eq!(feed.status().state, "live");
    }

    /// The next `n` text messages a client sends, from the server side.
    async fn read_texts_from(
        ws: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
        n: usize,
    ) -> Vec<Value> {
        let mut out = Vec::new();
        while out.len() < n {
            match timeout(Duration::from_secs(5), ws.next()).await {
                Ok(Some(Ok(Message::Text(t)))) => out.push(serde_json::from_str(&t).unwrap()),
                Ok(Some(Ok(_))) => {}
                other => panic!("expected {n} messages, got {out:?} then {other:?}"),
            }
        }
        out
    }

    /// A server that answers the WebSocket upgrade the way the real one answers
    /// bad credentials: HTTP 400 and a JSON body. Counts the attempts.
    async fn rejecting_server(status_line: &str, body: &str) -> (u16, Arc<Mutex<u32>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let attempts = Arc::new(Mutex::new(0u32));
        let counter = attempts.clone();
        let (status_line, body) = (status_line.to_string(), body.to_string());
        tokio::spawn(async move {
            loop {
                let (mut sock, _) = listener.accept().await.unwrap();
                *counter.lock().unwrap() += 1;
                let mut buf = vec![0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let reply = format!(
                    "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(reply.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        (port, attempts)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bad_credentials_are_refused_at_the_handshake_and_reported_without_a_retry_loop() {
        // The body is what the real service sends, captured with a made-up token.
        let (port, attempts) = rejecting_server(
            "400 Bad Request",
            r#"{"status":"error","message":"Invalid `access_token` or `api_key`."}"#,
        )
        .await;
        let (cfg, ticks, statuses) = config(port, true);
        let feed = Feed::start(cfg);
        feed.subscribe(1);

        eventually("an error status", || feed.status().state == "error").await;
        let message = feed.status().message.unwrap();
        assert!(message.contains("log in again"), "{message}");
        assert!(message.contains("token"), "{message}");

        sleep(Duration::from_millis(400)).await;
        assert_eq!(*attempts.lock().unwrap(), 1, "no reconnect loop after a rejected login");
        assert!(ticks.lock().unwrap().is_empty());
        assert!(statuses.lock().unwrap().iter().any(|s| s.state == "error"));

        // The user acting again (a reconnect, e.g. after logging in) tries once more.
        feed.reconnect();
        eventually("another attempt", || *attempts.lock().unwrap() == 2).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_server_error_at_the_handshake_is_retried_not_blamed_on_the_user() {
        let (port, attempts) = rejecting_server("503 Service Unavailable", r#"{"status":"error"}"#).await;
        let (cfg, _ticks, _statuses) = config(port, true);
        let feed = Feed::start(cfg);
        feed.subscribe(1);
        eventually("repeated attempts", || *attempts.lock().unwrap() >= 3).await;
        assert_ne!(feed.status().state, "error", "an outage is not a credential problem");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_error_naming_the_token_in_the_stream_stops_the_feed() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let accepted = Arc::new(Mutex::new(0));
        let counter = accepted.clone();
        tokio::spawn(async move {
            loop {
                let mut ws = accept(&listener).await;
                *counter.lock().unwrap() += 1;
                let _ = ws.next().await;
                ws.send(Message::text(r#"{"type":"error","data":"access_token has expired"}"#))
                    .await
                    .unwrap();
                while ws.next().await.is_some() {}
            }
        });

        let (cfg, _ticks, _statuses) = config(port, true);
        let feed = Feed::start(cfg);
        feed.subscribe(1);
        eventually("an error status", || feed.status().state == "error").await;
        sleep(Duration::from_millis(300)).await;
        assert_eq!(*accepted.lock().unwrap(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_dropped_connection_is_retried_and_subscriptions_are_restored() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (seen_tx, mut seen_rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            // First connection: take the subscribe request, then hang up.
            let mut ws = accept(&listener).await;
            let _ = ws.next().await;
            drop(ws);
            // Second connection: the subscription must be sent again.
            let mut ws = accept(&listener).await;
            let again = read_texts_from(&mut ws, 2).await;
            seen_tx.send(again).unwrap();
            while ws.next().await.is_some() {}
        });

        let (cfg, _ticks, _statuses) = config(port, true);
        let feed = Feed::start(cfg);
        feed.subscribe(738561);
        let resub = timeout(Duration::from_secs(5), seen_rx.recv()).await.unwrap().unwrap();
        assert_eq!(resub[0], json!({"a": "subscribe", "v": [738561]}));
        assert_eq!(resub[1]["a"], "mode");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_server_that_keeps_hanging_up_at_once_is_treated_as_a_credential_problem() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let accepted = Arc::new(Mutex::new(0));
        let counter = accepted.clone();
        tokio::spawn(async move {
            loop {
                let mut ws = accept(&listener).await;
                *counter.lock().unwrap() += 1;
                let _ = ws.next().await;
                drop(ws);
            }
        });

        let (cfg, _ticks, _statuses) = config(port, true);
        let feed = Feed::start(cfg);
        feed.subscribe(1);
        eventually("an error status", || feed.status().state == "error").await;
        assert!(feed.status().message.unwrap().contains("API key"));
        let at_error = *accepted.lock().unwrap();
        assert_eq!(
            at_error, MAX_QUICK_DROPS as i32,
            "gave up after exactly {MAX_QUICK_DROPS} quick drops"
        );
        sleep(Duration::from_millis(300)).await;
        assert_eq!(*accepted.lock().unwrap(), at_error, "and stopped retrying");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn without_credentials_it_reports_that_and_never_connects() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (cfg, _ticks, _statuses) = config(port, false);
        let feed = Feed::start(cfg);
        feed.subscribe(1);
        eventually("an error status", || feed.status().state == "error").await;
        assert!(feed.status().message.unwrap().contains("isn't set up"));
        assert!(
            timeout(Duration::from_millis(200), listener.accept()).await.is_err(),
            "no connection attempt"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_new_instrument_on_a_live_connection_is_subscribed_and_the_last_removal_goes_idle() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (seen_tx, mut seen_rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut ws = accept(&listener).await;
            while let Some(Ok(m)) = ws.next().await {
                if let Message::Text(t) = m {
                    seen_tx.send(serde_json::from_str::<Value>(&t).unwrap()).unwrap();
                }
            }
        });

        let (cfg, _ticks, _statuses) = config(port, true);
        let feed = Feed::start(cfg);
        feed.subscribe(7);
        eventually("live", || feed.status().state == "live").await;
        feed.subscribe(8);
        feed.subscribe(8); // a second chart on the same instrument sends nothing new
        feed.unsubscribe(8);
        feed.unsubscribe(8);
        feed.unsubscribe(7);
        eventually("idle", || feed.status().state == "idle").await;

        let mut actions = Vec::new();
        while let Ok(Some(m)) = timeout(Duration::from_millis(200), seen_rx.recv()).await {
            actions.push((m["a"].as_str().unwrap().to_string(), m["v"].clone()));
        }
        let names: Vec<_> = actions.iter().map(|(a, _)| a.as_str()).collect();
        assert_eq!(
            names,
            ["subscribe", "mode", "subscribe", "mode", "unsubscribe", "unsubscribe"],
            "{actions:?}"
        );
        assert_eq!(actions[2].1, json!([8]));
        assert_eq!(actions[4].1, json!([8]));
        assert_eq!(actions[5].1, json!([7]));
    }
}
