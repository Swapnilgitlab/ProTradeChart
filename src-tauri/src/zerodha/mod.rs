//! Zerodha (Kite Connect) as a market-data provider: historical candles, a
//! live tick feed and quotes for Indian equities, indices, futures and
//! commodities, from the user's own Kite Connect app.
//!
//! Its parts:
//!
//! - `protocol` — pure: request planning, response parsing, error mapping, and
//!   the login handshake's checksum.
//! - `instruments` — the instrument master (symbol ↔ instrument token) in SQLite.
//! - `client` — HTTP: history, quotes, login, instrument downloads.
//! - `feed` — the live WebSocket, shared by every chart and window.
//!
//! Kite access tokens are opaque and expire every morning, so the app has a login step
//! (`protocol::login_url`, `client::exchange_token`). Kite refuses bad credentials during the
//! WebSocket handshake.

pub mod callback;
pub mod client;
pub mod feed;
pub mod instruments;
pub mod protocol;

/// Tests that talk to the real Kite servers. They are ignored by default (they
/// need the network, and aren't deterministic); run them by hand with
///
/// ```text
/// cargo test --lib zerodha::live -- --ignored --nocapture
/// ```
///
/// They use no credentials: the instrument lists are public, and every
/// authenticated call is made with a made-up key so that what comes back is
/// Kite's real error, which is what the error handling has to cope with.
#[cfg(test)]
mod live {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use super::client::{Credentials, ZerodhaClient};
    use super::feed::{Feed, FeedConfig};
    use super::instruments::{self, Instrument};
    use super::protocol::{Interval, ZerodhaErrorKind};
    use crate::db::Database;

    fn client() -> ZerodhaClient {
        ZerodhaClient::new(reqwest::Client::new())
    }

    fn fake() -> Credentials {
        Credentials {
            api_key: "fakekey".into(),
            access_token: "faketoken".into(),
        }
    }

    async fn real_master() -> Vec<Instrument> {
        let lists = client().download_instrument_master().await.expect("download the lists");
        let mut all = Vec::new();
        for (exchange, bytes) in lists {
            let items = instruments::parse_master(bytes.as_slice(), "2026-09-19").expect("parse");
            println!(
                "{exchange:>4}: {:>6} bytes -> {:>5} chartable instruments",
                bytes.len(),
                items.len()
            );
            all.extend(items);
        }
        all
    }

    #[tokio::test]
    #[ignore = "talks to the real Kite servers"]
    async fn the_real_instrument_lists_download_parse_and_search() {
        let all = real_master().await;
        println!("total: {} instruments", all.len());
        assert!(all.len() > 15_000, "expected the full universe, got {}", all.len());

        let by = |t: &str| all.iter().find(|i| i.ticker == t);
        assert_eq!(
            by("NSE:RELIANCE").map(|i| i.token),
            Some(738561),
            "the token Kite's own docs use for it"
        );
        assert_eq!(by("NSE:NIFTY_50").map(|i| i.token), Some(256265));
        assert!(
            by("NSE:M&M").is_some() && by("NSE:BAJAJ-AUTO").is_some(),
            "symbols with punctuation survive"
        );
        assert!(by("BSE:SENSEX").is_some());
        assert!(
            all.iter().any(|i| i.exchange == "NFO" && i.instrument == "FUT"),
            "index futures"
        );
        assert!(
            all.iter().any(|i| i.exchange == "MCX" && i.instrument == "FUT"),
            "commodity futures"
        );
        // No options, and nothing expired: every future is a live contract.
        let futures: Vec<_> = all.iter().filter(|i| i.instrument == "FUT").collect();
        assert!(
            futures.iter().all(|i| i.symbol.ends_with("FUT")),
            "only futures, no CE/PE options"
        );
        assert!(futures
            .iter()
            .all(|i| i.expiry.as_deref().is_some_and(|d| d >= "2026-09-19")));

        // Store and search it the way the app does.
        let db = Database::open_in_memory().unwrap();
        let mut conn = db.conn.lock().unwrap();
        let stored = instruments::replace_all(&mut conn, &all).unwrap();
        println!("stored {stored} (duplicates across exchanges are ignored)");
        for query in ["reliance", "nifty", "infy", "gold", "sensex", "m&m"] {
            let hits = instruments::search(&conn, query, 6).unwrap();
            println!(
                "search {query:>9}: {:?}",
                hits.iter().map(|h| h.symbol.as_str()).collect::<Vec<_>>()
            );
            assert!(!hits.is_empty(), "no results for {query}");
        }
        assert_eq!(
            instruments::search(&conn, "reliance", 3).unwrap()[0].symbol,
            "NSE:RELIANCE"
        );
        assert_eq!(
            instruments::search(&conn, "nifty", 3).unwrap()[0].symbol,
            "NSE:NIFTY_50"
        );
        assert_eq!(instruments::resolve(&conn, "nifty 50").unwrap().unwrap().token, 256265);
    }

    #[tokio::test]
    #[ignore = "talks to the real Kite servers"]
    async fn a_made_up_token_gets_kites_real_token_error_from_every_call() {
        let all = real_master().await;
        let reliance = all.iter().find(|i| i.ticker == "NSE:RELIANCE").unwrap().clone();
        let now = crate::db::now_ms();

        let history = client()
            .fetch_history(
                &fake(),
                &reliance,
                Interval::Day,
                Some(now - 14 * 86_400_000),
                Some(now),
                now,
            )
            .await
            .unwrap_err();
        println!("history: {history}");
        assert_eq!(history.kind, ZerodhaErrorKind::Token);

        let quotes = client().quotes(&fake(), &[reliance]).await.unwrap_err();
        println!("quotes:  {quotes}");
        assert_eq!(quotes.kind, ZerodhaErrorKind::Token);
        assert!(quotes.message().contains("log in again"));
    }

    #[tokio::test]
    #[ignore = "talks to the real Kite servers"]
    async fn a_made_up_login_is_refused_with_a_readable_reason() {
        let short = client()
            .exchange_token("fakekey", "fakesecret", "short")
            .await
            .unwrap_err();
        println!("short token:  {short:?}");
        assert_eq!(short.kind, ZerodhaErrorKind::BadRequest);

        let plausible = client()
            .exchange_token("fakekey", "fakesecret", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6")
            .await
            .unwrap_err();
        println!("long token:   {plausible:?}");
        assert!(matches!(
            plausible.kind,
            ZerodhaErrorKind::Token | ZerodhaErrorKind::BadRequest
        ));
        assert!(!plausible.detail.is_empty(), "Kite explains itself");
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "talks to the real Kite servers"]
    async fn the_real_feed_refuses_a_made_up_token_at_the_handshake() {
        let statuses = Arc::new(Mutex::new(Vec::new()));
        let seen = statuses.clone();
        let feed = Feed::start(FeedConfig::production(
            Arc::new(|| Some(fake())),
            Arc::new(|_| {}),
            Arc::new(move |s| seen.lock().unwrap().push(s)),
        ));
        feed.subscribe(738561);
        for _ in 0..200 {
            if feed.status().state == "error" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let status = feed.status();
        println!("feed status: {status:?}");
        assert_eq!(status.state, "error", "history: {:?}", statuses.lock().unwrap());
        assert!(status.message.unwrap().contains("log in again"));
    }
}
