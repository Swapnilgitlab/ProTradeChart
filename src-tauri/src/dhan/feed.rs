//! Dhan's live market feed.
//!
//! One WebSocket connection is shared by every chart, tab and window: Dhan
//! allows only 5 connections per user (a 6th is refused with error 805), so
//! letting each webview open its own would burn the allowance in minutes. The
//! Rust side owns the socket, counts how many charts want each instrument,
//! connects when the first one arrives, disconnects when the last one leaves,
//! and reconnects with backoff when the link drops. Ticks and status changes
//! go out through callbacks, which `lib.rs` turns into Tauri events.
//!
//! Packets are little-endian binary; requests are JSON. The layouts below are
//! from Dhan's docs, converted to 0-based offsets after an 8-byte header
//! (response code u8, length u16, exchange segment u8, security id i32).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::{self, Message};

use super::client::Credentials;
use super::protocol::FEED_URL;
use super::Segment;

const REQUEST_DISCONNECT: i64 = 12;
/// Quote mode: last price and time, plus the day's volume — enough to build
/// live candles. (Ticker mode omits volume; Full mode adds depth we don't chart.)
const REQUEST_SUBSCRIBE_QUOTE: i64 = 17;
const REQUEST_UNSUBSCRIBE_QUOTE: i64 = 18;
/// Dhan accepts at most this many instruments in one request.
const MAX_PER_REQUEST: usize = 100;

const RESPONSE_INDEX: u8 = 1;
const RESPONSE_TICKER: u8 = 2;
const RESPONSE_QUOTE: u8 = 4;
const RESPONSE_FULL: u8 = 8;
const RESPONSE_DISCONNECT: u8 = 50;
/// After this many quick drops in a row, stop retrying and tell the user.
///
/// Observed against the real service: a wrong or expired token is not refused
/// with a message. The socket opens, then is dropped at once with no close
/// frame, which is indistinguishable from a network blip except by how often
/// it recurs.
const MAX_QUICK_DROPS: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Key {
    pub segment: Segment,
    pub security_id: i64,
}

/// One price update, as delivered to the webview.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TickEvent {
    pub segment: u8,
    pub security_id: i64,
    pub ltp: f64,
    /// Last-trade time, exactly as Dhan sent it (epoch seconds; the base is
    /// checked on the frontend against the clock).
    pub ltt: Option<i64>,
    /// Total volume traded so far today (Quote packets only).
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

#[derive(Debug, Clone, PartialEq)]
pub enum Packet {
    Tick(TickEvent),
    /// The server is closing the connection, with Dhan's reason code.
    Disconnect(i16),
    /// A packet we don't need (previous close, open interest, market status…).
    Ignored(u8),
}

fn slice<const N: usize>(data: &[u8], at: usize) -> Option<[u8; N]> {
    data.get(at..at + N)?.try_into().ok()
}

fn f32_at(data: &[u8], at: usize) -> Option<f64> {
    slice::<4>(data, at).map(|b| f32::from_le_bytes(b) as f64)
}

fn i32_at(data: &[u8], at: usize) -> Option<i64> {
    slice::<4>(data, at).map(|b| i32::from_le_bytes(b) as i64)
}

/// Parses one binary message. `None` means it was too short or malformed to
/// trust — dropped, never guessed at.
pub fn parse_packet(data: &[u8]) -> Option<Packet> {
    let code = *data.first()?;
    if code == RESPONSE_DISCONNECT {
        return slice::<2>(data, 8).map(|b| Packet::Disconnect(i16::from_le_bytes(b)));
    }
    if !matches!(code, RESPONSE_INDEX | RESPONSE_TICKER | RESPONSE_QUOTE | RESPONSE_FULL) {
        return Some(Packet::Ignored(code));
    }
    let segment = Segment::from_code(*data.get(3)? as i64)?;
    let security_id = i32_at(data, 4)?;
    let ltp = f32_at(data, 8)?;
    if !ltp.is_finite() || ltp <= 0.0 {
        return None;
    }
    // Ticker and index packets: price then time. Quote and full packets put a
    // 2-byte last-quantity between them and carry day volume further on.
    let quote_like = matches!(code, RESPONSE_QUOTE | RESPONSE_FULL);
    let (ltt, volume) = if quote_like {
        (i32_at(data, 14), i32_at(data, 22))
    } else {
        (i32_at(data, 12), None)
    };
    Some(Packet::Tick(TickEvent {
        segment: segment.code(),
        security_id,
        ltp,
        ltt,
        volume,
    }))
}

const QUICK_DROP_MESSAGE: &str = "Dhan keeps closing the live feed the moment it opens. That usually means the \
client ID or access token is wrong or expired. Check them in Data providers.";

/// A user-facing explanation for a disconnect reason code.
pub fn disconnect_message(reason: i16) -> String {
    match reason {
        805 => "Dhan refused the connection: too many feed connections. Close other apps using your Dhan feed.".into(),
        806 => "Your Dhan account doesn't have Data API access.".into(),
        807 => "Your Dhan access token has expired. Paste a fresh one in Data providers.".into(),
        808..=810 => "Dhan rejected your credentials. Check your client ID and access token in Data providers.".into(),
        other => format!("Dhan closed the live feed (code {other})."),
    }
}

/// Reasons a reconnect can't fix: the user has to change something first.
fn is_fatal(reason: i16) -> bool {
    matches!(reason, 805..=810)
}

pub fn subscribe_message(request_code: i64, keys: &[Key]) -> String {
    let list: Vec<_> = keys
        .iter()
        .map(|k| json!({"ExchangeSegment": k.segment.api_name(), "SecurityId": k.security_id.to_string()}))
        .collect();
    json!({"RequestCode": request_code, "InstrumentCount": list.len(), "InstrumentList": list}).to_string()
}

// ---- The shared connection -------------------------------------------------

pub struct FeedConfig {
    /// Where to connect, e.g. `wss://api-feed.dhan.co` (tests point this at a local server).
    pub base_url: String,
    /// Read fresh at every connect, so a new token takes effect on reconnect.
    pub credentials: Arc<dyn Fn() -> Option<Credentials> + Send + Sync>,
    pub on_tick: Arc<dyn Fn(TickEvent) + Send + Sync>,
    pub on_status: Arc<dyn Fn(StatusEvent) + Send + Sync>,
    pub backoff_start: Duration,
    pub backoff_max: Duration,
    /// No message at all (Dhan pings every 10 s) for this long means the link is dead.
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
            idle_timeout: Duration::from_secs(45),
            quick_drop_window: Duration::from_secs(5),
        }
    }
}

enum Cmd {
    Subscribe(Key),
    Unsubscribe(Key),
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

    pub fn subscribe(&self, key: Key) {
        let _ = self.tx.send(Cmd::Subscribe(key));
    }

    pub fn unsubscribe(&self, key: Key) {
        let _ = self.tx.send(Cmd::Unsubscribe(key));
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

type Subs = HashMap<Key, usize>;

fn apply(subs: &mut Subs, cmd: &Cmd) -> bool {
    match cmd {
        Cmd::Subscribe(k) => {
            *subs.entry(*k).or_insert(0) += 1;
            true
        }
        Cmd::Unsubscribe(k) => {
            if let Some(n) = subs.get_mut(k) {
                *n -= 1;
                if *n == 0 {
                    subs.remove(k);
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
        .append_pair("version", "2")
        .append_pair("token", &creds.access_token)
        .append_pair("clientId", &creds.client_id)
        .append_pair("authType", "2");
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
            set_status(
                &cfg,
                &shared,
                "error",
                Some(super::protocol::DhanError::not_configured().message()),
            );
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
            Err(tungstenite::Error::Http(resp)) if matches!(resp.status().as_u16(), 401 | 403) => {
                set_status(&cfg, &shared, "error", Some(disconnect_message(808)));
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

async fn send_all(
    ws: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    code: i64,
    keys: &[Key],
) -> Result<(), tungstenite::Error> {
    for batch in keys.chunks(MAX_PER_REQUEST) {
        ws.send(Message::text(subscribe_message(code, batch))).await?;
    }
    Ok(())
}

async fn session(
    mut ws: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    cfg: &FeedConfig,
    shared: &Mutex<StatusEvent>,
    subs: &mut Subs,
    rx: &mut mpsc::UnboundedReceiver<Cmd>,
) -> SessionEnd {
    let wanted: Vec<Key> = subs.keys().copied().collect();
    let mut got_data = false;
    if let Err(e) = send_all(&mut ws, REQUEST_SUBSCRIBE_QUOTE, &wanted).await {
        return SessionEnd::Lost(e.to_string(), got_data);
    }
    set_status(cfg, shared, "live", None);

    loop {
        tokio::select! {
            incoming = timeout(cfg.idle_timeout, ws.next()) => match incoming {
                Err(_) => return SessionEnd::Lost("the feed went silent".into(), got_data),
                Ok(None) => return SessionEnd::Lost("the connection closed".into(), got_data),
                Ok(Some(Err(e))) => return SessionEnd::Lost(e.to_string(), got_data),
                Ok(Some(Ok(Message::Binary(data)))) => match parse_packet(&data) {
                    Some(Packet::Tick(tick)) => {
                        got_data = true;
                        (cfg.on_tick)(tick)
                    }
                    Some(Packet::Disconnect(reason)) if is_fatal(reason) => return SessionEnd::Fatal(disconnect_message(reason)),
                    Some(Packet::Disconnect(reason)) => return SessionEnd::Lost(disconnect_message(reason), got_data),
                    Some(Packet::Ignored(_)) | None => {}
                },
                Ok(Some(Ok(Message::Close(_)))) => return SessionEnd::Lost("the server closed the connection".into(), got_data),
                // Pings are answered by the library as we keep reading.
                Ok(Some(Ok(_))) => {}
            },
            cmd = rx.recv() => {
                let Some(cmd) = cmd else { return SessionEnd::Shutdown };
                match cmd {
                    Cmd::Reconnect => { let _ = ws.close(None).await; return SessionEnd::Reconnect }
                    Cmd::Subscribe(key) => {
                        let is_new = !subs.contains_key(&key);
                        apply(subs, &Cmd::Subscribe(key));
                        if is_new {
                            if let Err(e) = send_all(&mut ws, REQUEST_SUBSCRIBE_QUOTE, &[key]).await {
                                return SessionEnd::Lost(e.to_string(), got_data);
                            }
                        }
                    }
                    Cmd::Unsubscribe(key) => {
                        apply(subs, &Cmd::Unsubscribe(key));
                        if !subs.contains_key(&key) {
                            let _ = send_all(&mut ws, REQUEST_UNSUBSCRIBE_QUOTE, &[key]).await;
                        }
                        if subs.is_empty() {
                            let _ = ws.send(Message::text(json!({"RequestCode": REQUEST_DISCONNECT}).to_string())).await;
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
    use tokio::net::TcpListener;
    use tokio::time::sleep;

    /// Builds a packet the way Dhan lays it out: 8-byte header, then `payload`.
    fn packet(code: u8, segment: u8, security_id: i32, payload: &[u8]) -> Vec<u8> {
        let mut p = vec![code];
        p.extend_from_slice(&((8 + payload.len()) as u16).to_le_bytes());
        p.push(segment);
        p.extend_from_slice(&security_id.to_le_bytes());
        p.extend_from_slice(payload);
        p
    }

    fn ticker(segment: u8, security_id: i32, ltp: f32, ltt: i32) -> Vec<u8> {
        let mut payload = ltp.to_le_bytes().to_vec();
        payload.extend_from_slice(&ltt.to_le_bytes());
        packet(RESPONSE_TICKER, segment, security_id, &payload)
    }

    fn quote(segment: u8, security_id: i32, ltp: f32, ltt: i32, volume: i32) -> Vec<u8> {
        let mut payload = ltp.to_le_bytes().to_vec();
        payload.extend_from_slice(&5i16.to_le_bytes()); // last traded quantity
        payload.extend_from_slice(&ltt.to_le_bytes());
        payload.extend_from_slice(&1200.5f32.to_le_bytes()); // average price
        payload.extend_from_slice(&volume.to_le_bytes());
        payload.extend_from_slice(&[0u8; 24]); // sell/buy quantity and day OHLC
        packet(RESPONSE_QUOTE, segment, security_id, &payload)
    }

    // ---- packet parsing ----

    #[test]
    fn a_ticker_packet_yields_price_and_time() {
        let Some(Packet::Tick(t)) = parse_packet(&ticker(1, 2885, 1226.4, 1_800_000_000)) else {
            panic!("not a tick")
        };
        assert_eq!((t.segment, t.security_id), (1, 2885));
        assert!((t.ltp - 1226.4).abs() < 0.01);
        assert_eq!(t.ltt, Some(1_800_000_000));
        assert_eq!(t.volume, None);
    }

    #[test]
    fn a_quote_packet_also_yields_the_days_volume() {
        let Some(Packet::Tick(t)) = parse_packet(&quote(4, 500325, 1300.25, 1_800_000_001, 1_234_567)) else {
            panic!("not a tick")
        };
        assert_eq!((t.segment, t.security_id), (4, 500325));
        assert!((t.ltp - 1300.25).abs() < 0.01);
        assert_eq!(t.ltt, Some(1_800_000_001));
        assert_eq!(t.volume, Some(1_234_567));
    }

    #[test]
    fn an_index_packet_reads_like_a_ticker() {
        let mut p = ticker(0, 13, 25000.5, 1_800_000_000);
        p[0] = RESPONSE_INDEX;
        let Some(Packet::Tick(t)) = parse_packet(&p) else {
            panic!("not a tick")
        };
        assert_eq!((t.segment, t.security_id), (0, 13));
        assert!((t.ltp - 25000.5).abs() < 0.01);
    }

    #[test]
    fn a_disconnect_packet_carries_its_reason() {
        let p = packet(RESPONSE_DISCONNECT, 0, 0, &807i16.to_le_bytes());
        assert_eq!(parse_packet(&p), Some(Packet::Disconnect(807)));
        assert!(disconnect_message(807).contains("expired"));
        assert!(disconnect_message(805).contains("too many"));
        assert!(disconnect_message(999).contains("999"));
    }

    #[test]
    fn packets_we_do_not_use_are_ignored_not_errors() {
        for code in [5u8, 6, 7] {
            assert_eq!(parse_packet(&packet(code, 1, 1, &[0; 8])), Some(Packet::Ignored(code)));
        }
    }

    #[test]
    fn malformed_packets_are_dropped_rather_than_guessed_at() {
        assert_eq!(parse_packet(&[]), None);
        assert_eq!(parse_packet(&[RESPONSE_TICKER, 0, 0]), None, "shorter than a header");
        assert_eq!(
            parse_packet(&ticker(1, 1, 100.0, 1)[..10]),
            None,
            "truncated before the price ends"
        );
        assert_eq!(parse_packet(&ticker(1, 1, 0.0, 1)), None, "a zero price is not a trade");
        assert_eq!(parse_packet(&ticker(1, 1, f32::NAN, 1)), None);
        assert_eq!(parse_packet(&ticker(6, 1, 100.0, 1)), None, "6 is not a segment code");
        assert_eq!(
            parse_packet(&[RESPONSE_DISCONNECT, 0, 0, 0, 0, 0, 0, 0]),
            None,
            "a disconnect with no reason"
        );
    }

    // ---- requests ----

    #[test]
    fn subscribe_messages_follow_dhans_json_format() {
        let keys = [
            Key {
                segment: Segment::NseEq,
                security_id: 2885,
            },
            Key {
                segment: Segment::IdxI,
                security_id: 13,
            },
        ];
        let v: serde_json::Value = serde_json::from_str(&subscribe_message(17, &keys)).unwrap();
        assert_eq!(v["RequestCode"], 17);
        assert_eq!(v["InstrumentCount"], 2);
        assert_eq!(
            v["InstrumentList"][0],
            json!({"ExchangeSegment":"NSE_EQ","SecurityId":"2885"})
        );
        assert_eq!(
            v["InstrumentList"][1],
            json!({"ExchangeSegment":"IDX_I","SecurityId":"13"})
        );
    }

    #[test]
    fn the_feed_url_carries_version_token_client_and_auth_type() {
        let creds = Credentials {
            client_id: "1000000001".into(),
            access_token: "a+b/c=".into(),
        };
        let url = feed_url("wss://api-feed.dhan.co", &creds).unwrap();
        assert!(url.starts_with("wss://api-feed.dhan.co/?"));
        assert!(url.contains("version=2") && url.contains("clientId=1000000001") && url.contains("authType=2"));
        assert!(!url.contains("a+b/c="), "the token is percent-encoded: {url}");
    }

    #[test]
    fn subscriptions_are_reference_counted() {
        let key = Key {
            segment: Segment::NseEq,
            security_id: 1,
        };
        let mut subs = Subs::new();
        apply(&mut subs, &Cmd::Subscribe(key));
        apply(&mut subs, &Cmd::Subscribe(key));
        apply(&mut subs, &Cmd::Unsubscribe(key));
        assert!(subs.contains_key(&key), "still wanted by the other chart");
        apply(&mut subs, &Cmd::Unsubscribe(key));
        assert!(subs.is_empty());
        apply(&mut subs, &Cmd::Unsubscribe(key)); // an extra unsubscribe must not underflow
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
                    client_id: "1000000001".into(),
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

    fn key(id: i64) -> Key {
        Key {
            segment: Segment::NseEq,
            security_id: id,
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn it_subscribes_on_connect_and_delivers_ticks() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (seen_tx, mut seen_rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(sock).await.unwrap();
            let first = ws.next().await.unwrap().unwrap();
            seen_tx.send(first.into_text().unwrap().to_string()).unwrap();
            ws.send(Message::binary(quote(1, 2885, 1226.4, 1_800_000_000, 5000)))
                .await
                .unwrap();
            // Keep the socket open so the client stays connected.
            while ws.next().await.is_some() {}
        });

        let (cfg, ticks, statuses) = config(port, true);
        let feed = Feed::start(cfg);
        feed.subscribe(key(2885));

        let subscribe = timeout(Duration::from_secs(5), seen_rx.recv()).await.unwrap().unwrap();
        let v: serde_json::Value = serde_json::from_str(&subscribe).unwrap();
        assert_eq!(v["RequestCode"], 17);
        assert_eq!(v["InstrumentList"][0]["SecurityId"], "2885");

        eventually("a tick", || !ticks.lock().unwrap().is_empty()).await;
        let t = ticks.lock().unwrap()[0].clone();
        assert_eq!((t.security_id, t.volume), (2885, Some(5000)));
        assert!(statuses.lock().unwrap().iter().any(|s| s.state == "live"));
        assert_eq!(feed.status().state, "live");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_expired_token_stops_the_feed_and_says_so_without_retrying() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let accepted = Arc::new(Mutex::new(0));
        let counter = accepted.clone();
        tokio::spawn(async move {
            loop {
                let (sock, _) = listener.accept().await.unwrap();
                *counter.lock().unwrap() += 1;
                let mut ws = tokio_tungstenite::accept_async(sock).await.unwrap();
                let _ = ws.next().await; // the subscribe request
                ws.send(Message::binary(packet(
                    RESPONSE_DISCONNECT,
                    0,
                    0,
                    &807i16.to_le_bytes(),
                )))
                .await
                .unwrap();
                while ws.next().await.is_some() {}
            }
        });

        let (cfg, _ticks, statuses) = config(port, true);
        let feed = Feed::start(cfg);
        feed.subscribe(key(1));
        eventually("an error status", || feed.status().state == "error").await;
        assert!(feed.status().message.unwrap().contains("expired"));

        sleep(Duration::from_millis(400)).await;
        assert_eq!(*accepted.lock().unwrap(), 1, "no reconnect loop after a fatal error");
        assert!(statuses.lock().unwrap().iter().any(|s| s.state == "error"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_dropped_connection_is_retried_and_subscriptions_are_restored() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (seen_tx, mut seen_rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            // First connection: take the subscribe request, then hang up.
            let (sock, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(sock).await.unwrap();
            let _ = ws.next().await;
            drop(ws);
            // Second connection: the subscription must be sent again.
            let (sock, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(sock).await.unwrap();
            let again = ws.next().await.unwrap().unwrap();
            seen_tx.send(again.into_text().unwrap().to_string()).unwrap();
            while ws.next().await.is_some() {}
        });

        let (cfg, _ticks, _statuses) = config(port, true);
        let feed = Feed::start(cfg);
        feed.subscribe(key(2885));
        let resub = timeout(Duration::from_secs(5), seen_rx.recv()).await.unwrap().unwrap();
        assert!(resub.contains("2885"), "{resub}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_server_that_keeps_hanging_up_at_once_is_treated_as_a_credential_problem() {
        // What the real service does with a bad token: accept, then drop without a word.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let accepted = Arc::new(Mutex::new(0));
        let counter = accepted.clone();
        tokio::spawn(async move {
            loop {
                let (sock, _) = listener.accept().await.unwrap();
                *counter.lock().unwrap() += 1;
                let mut ws = tokio_tungstenite::accept_async(sock).await.unwrap();
                let _ = ws.next().await;
                drop(ws);
            }
        });

        let (cfg, _ticks, _statuses) = config(port, true);
        let feed = Feed::start(cfg);
        feed.subscribe(key(1));
        eventually("an error status", || feed.status().state == "error").await;
        assert!(feed.status().message.unwrap().contains("access token"));

        let at_error = *accepted.lock().unwrap();
        assert_eq!(
            at_error, MAX_QUICK_DROPS as i32,
            "gave up after exactly {MAX_QUICK_DROPS} quick drops"
        );
        sleep(Duration::from_millis(300)).await;
        assert_eq!(*accepted.lock().unwrap(), at_error, "and stopped retrying");

        // A new subscription request is the user acting again, so it tries once more.
        feed.subscribe(key(2));
        eventually("another attempt", || *accepted.lock().unwrap() > at_error).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn without_credentials_it_reports_that_and_never_connects() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (cfg, _ticks, _statuses) = config(port, false);
        let feed = Feed::start(cfg);
        feed.subscribe(key(1));
        eventually("an error status", || feed.status().state == "error").await;
        assert!(feed.status().message.unwrap().contains("isn't set up"));
        assert!(
            timeout(Duration::from_millis(200), listener.accept()).await.is_err(),
            "no connection attempt"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn removing_the_last_subscription_disconnects_and_goes_idle() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (seen_tx, mut seen_rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(sock).await.unwrap();
            while let Some(Ok(m)) = ws.next().await {
                if let Message::Text(t) = m {
                    seen_tx.send(t.to_string()).unwrap();
                }
            }
        });

        let (cfg, _ticks, _statuses) = config(port, true);
        let feed = Feed::start(cfg);
        feed.subscribe(key(7));
        eventually("live", || feed.status().state == "live").await;
        feed.unsubscribe(key(7));
        eventually("idle", || feed.status().state == "idle").await;

        let mut codes = Vec::new();
        while let Ok(Some(m)) = timeout(Duration::from_millis(200), seen_rx.recv()).await {
            let v: serde_json::Value = serde_json::from_str(&m).unwrap();
            codes.push(v["RequestCode"].as_i64().unwrap());
        }
        assert_eq!(
            codes,
            vec![17, 18, 12],
            "subscribe, unsubscribe, then a clean disconnect"
        );
    }
}
