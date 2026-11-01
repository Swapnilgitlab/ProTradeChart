//! The local data API the Python client talks to.
//!
//! Python scripts run as child processes of the app and ask *this* for market data,
//! rather than holding broker credentials themselves. Rust fetches (paced, through the
//! same clients the charts use), keeps what it fetched in the research store, and
//! answers over HTTP on the loopback interface.
//!
//! Layers, each testable without the others:
//! - [`data`]: turns "bars for this symbol and range" into store reads plus whatever the
//!   broker has to be asked for. Knows nothing of HTTP or Tauri.
//! - [`routes`]: parses a request, checks it came from a caller that holds the token,
//!   and answers. Talks to a [`routes::Backend`], so it is tested with a fake one.
//! - [`server`]: the hyper glue and the per-launch token.
//! - [`backend`]: the real `Backend`, bound to the app's managed state.
//!
//! Nearly everything here is read-only market data. The exceptions are the user's own script asking
//! for what they set up — a result shown, a watchlist written, its SQL run (`sql`), an email to the
//! user's own address, a chart drawn — each documented in [`routes`]. No route places an order, and
//! no route ever returns a credential.

pub mod backend;
pub mod data;
pub mod routes;
pub mod server;
pub mod sql;
pub mod wire;

/// A failure the client is told about: an HTTP status, a stable `code` the Python side
/// turns into an exception class, and a message written for a person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}

impl ApiError {
    pub fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        ApiError {
            status,
            code,
            message: message.into(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(400, "bad_request", message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(404, "not_found", message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(500, "internal", message)
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(e: rusqlite::Error) -> Self {
        ApiError::internal(e.to_string())
    }
}

/// A run id the caller (the webview) made up. It names a run in every event and in every result
/// a script posts, so it is kept short and plain.
pub fn valid_run_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Splits `provider:TICKER` (`india:NSE:RELIANCE` → `india`, `NSE:RELIANCE`) at its
/// first colon. The ticker keeps its own colons, and an old spelling of the Indian namespace
/// (`zerodha:`) reads as `india`.
pub fn split_symbol(symbol: &str) -> Option<(&str, &str)> {
    let (provider, ticker) = symbol.split_once(':')?;
    let (provider, ticker) = (provider.trim(), ticker.trim());
    (!provider.is_empty() && !ticker.is_empty()).then_some((crate::symbols::canonical_provider(provider), ticker))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_symbol_splits_at_its_first_colon_only() {
        assert_eq!(split_symbol("india:NSE:RELIANCE"), Some(("india", "NSE:RELIANCE")));
        assert_eq!(split_symbol("csv:MY_DATA"), Some(("csv", "MY_DATA")));
        assert_eq!(split_symbol(" india : NSE:TCS "), Some(("india", "NSE:TCS")));
        assert_eq!(
            split_symbol("zerodha:NSE:TCS"),
            Some(("india", "NSE:TCS")),
            "the old name"
        );
    }

    #[test]
    fn a_run_id_is_short_and_plain() {
        for good in ["a", "run-1", "3f2b8c1e-7d4a-4c1b-9e0f-1a2b3c4d5e6f", "Run_2"] {
            assert!(valid_run_id(good), "{good}");
        }
        for bad in ["", "has space", "semi;colon", "../x", &"x".repeat(65)] {
            assert!(!valid_run_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_symbol_without_a_provider_or_ticker_is_refused() {
        for text in ["RELIANCE", "", ":", "india:", ":NSE:RELIANCE"] {
            assert_eq!(split_symbol(text), None, "{text:?}");
        }
    }
}
