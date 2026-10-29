//! FYERS (API v3) — the second broker that can serve `india:` symbols, from the user's own FYERS API
//! app (myapi.fyers.in). Laid out like `zerodha/`: a pure `protocol.rs` and `instruments.rs`, the HTTP
//! `client.rs`, the login redirect's `callback.rs`, and the renewal rule in `session.rs`.
//!
//! Where FYERS is unusual:
//! - **Limits that block.** The Standard (free) plan allows 50 data requests a minute and 5,000 a day;
//!   going over the per-minute limit more than three times in a day blocks the account until the
//!   next. So requests are paced for the plan the user says they have, counted against the day
//!   (`budget.rs`), and a rate-limit answer is retried once, a minute later, not hammered.
//! - **A token that lasts a day**, until 06:30 IST, renewed with the user's PIN through an
//!   endpoint FYERS's documentation doesn't describe (`session.rs`).
//! - **No documented live feed** the app may use: FYERS's data socket speaks a binary protocol
//!   described only by its SDKs' source, and its API terms forbid reverse-engineering. Live charts
//!   are built from polled quotes instead.
//! - **Its own symbols** (`NSE:SBIN-EQ`), mapped to the app's (`NSE:SBIN`) in `instruments.rs`.
//!
//! FYERS's API terms (fyers.in/terms-and-conditions-api) restrict using its data for charting tools
//! and copies of it; the owner's decision is to not release this until FYERS has agreed in writing.
//! Like Zerodha's, its prices stay in memory only.

pub mod budget;
pub mod callback;
pub mod client;
pub mod instruments;
pub mod poller;
pub mod protocol;
pub mod quotes;
pub mod session;

/// Opt-in tests against FYERS's real service, run with
/// `cargo test --lib fyers::live -- --ignored --nocapture`. They need no account: the symbol master
/// is public, and every other call is made with deliberately fake credentials, so what is checked is
/// that the endpoints exist and answer in the shape this module reads.
#[cfg(test)]
mod live {
    use super::client::{Credentials, FyersClient};
    use super::instruments::{parse_master, INDEX_SPELLINGS};
    use super::protocol::{FyersErrorKind, Interval};
    use crate::db::now_ms;
    use crate::market::ist_date;
    use crate::store::instrument_list::Instrument;

    fn client() -> FyersClient {
        FyersClient::new(reqwest::Client::new())
    }

    fn fake() -> Credentials {
        Credentials {
            app_id: "ABCDEFGH12-100".into(),
            access_token: "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.e30.fake".into(),
        }
    }

    async fn master() -> Vec<Instrument> {
        let today = ist_date(now_ms());
        let lists = client()
            .download_symbol_master()
            .await
            .expect("the public symbol master downloads");
        lists
            .iter()
            .flat_map(|(name, bytes)| parse_master(&bytes[..], &today).unwrap_or_else(|e| panic!("{name}: {e}")))
            .collect()
    }

    #[tokio::test]
    #[ignore]
    async fn the_real_symbol_master_maps_to_the_apps_tickers() {
        let all = master().await;
        println!("{} instruments", all.len());
        let find = |t: &str| all.iter().find(|i| i.ticker == t).map(|i| i.symbol.clone());
        for (fyers, ticker, _) in INDEX_SPELLINGS {
            assert_eq!(find(ticker).as_deref(), Some(*fyers), "{ticker}");
        }
        for (ticker, fyers) in [
            ("NSE:RELIANCE", "NSE:RELIANCE-EQ"),
            ("NSE:M&M", "NSE:M&M-EQ"),
            ("NSE:BAJAJ-AUTO", "NSE:BAJAJ-AUTO-EQ"),
            ("BSE:SENSEX", "BSE:SENSEX-INDEX"),
            ("BSE:BANKEX", "BSE:BANKEX-INDEX"),
        ] {
            assert_eq!(find(ticker).as_deref(), Some(fyers), "{ticker}");
        }
        // Every index the Indices watchlist offers is in FYERS's list under the same ticker.
        let missing: Vec<&str> = crate::store::index_catalog::catalog_tickers()
            .filter(|t| find(t).is_none())
            .collect();
        assert!(
            missing.is_empty(),
            "catalogue indices FYERS doesn't list under the app's ticker: {missing:?}"
        );
        assert!(all.iter().any(|i| i.instrument == "FUT" && i.exchange == "NFO"));
        assert!(all.iter().any(|i| i.instrument == "FUT" && i.exchange == "MCX"));
    }

    #[tokio::test]
    #[ignore]
    async fn history_and_quotes_with_a_fake_token_are_refused_as_a_token_problem() {
        let sbin = Instrument {
            ticker: "NSE:SBIN".into(),
            exchange: "NSE".into(),
            token: 0,
            instrument: "EQUITY".into(),
            symbol: "NSE:SBIN-EQ".into(),
            name: None,
            expiry: None,
        };
        let now = now_ms();
        let c = client();
        let history = c
            .fetch_history(&fake(), &sbin, Interval::Day, Some(now - 10 * 86_400_000), None, now)
            .await;
        let e = history.expect_err("a fake token can't read history");
        println!("history: {e:?}");
        assert_eq!(e.kind, FyersErrorKind::Token, "{e:?}");
        let quotes = c.quotes_and_ticks(&fake(), &[sbin]).await.expect_err("nor quotes");
        println!("quotes: {quotes:?}");
        assert_eq!(quotes.kind, FyersErrorKind::Token, "{quotes:?}");
    }

    #[tokio::test]
    #[ignore]
    async fn a_fake_login_and_a_fake_renewal_are_refused_in_fyerss_own_shape() {
        let c = client();
        let login = c
            .validate_authcode("ABCDEFGH12-100", "SECRET", "not-a-code")
            .await
            .expect_err("refused");
        println!("validate-authcode: {login:?}");
        assert_ne!(login.kind, FyersErrorKind::Network, "the endpoint answered");
        let renewal = c
            .refresh("ABCDEFGH12-100", "SECRET", "not-a-token", "0000")
            .await
            .expect_err("refused");
        println!("validate-refresh-token: {renewal:?}");
        assert_ne!(renewal.kind, FyersErrorKind::Network, "the endpoint answered");
        let profile = c.profile(&fake()).await.expect_err("refused");
        assert_eq!(profile.kind, FyersErrorKind::Token, "{profile:?}");
    }

    #[tokio::test]
    #[ignore]
    async fn a_full_batch_of_quote_symbols_makes_a_url_fyers_accepts() {
        let all = master().await;
        let mut nse: Vec<Instrument> = all
            .into_iter()
            .filter(|i| i.exchange == "NSE" && i.instrument == "EQUITY")
            .collect();
        nse.sort_by_key(|i| std::cmp::Reverse(i.symbol.len()));
        nse.truncate(super::protocol::QUOTE_BATCH);
        let e = client()
            .quotes_and_ticks(&fake(), &nse)
            .await
            .expect_err("a fake token");
        // A URL too long would be refused by the server before it looked at the token.
        assert_eq!(e.kind, FyersErrorKind::Token, "{e:?}");
    }
}
