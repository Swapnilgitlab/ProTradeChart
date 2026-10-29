//! Catches FYERS's login redirect, so a login needs no copy-and-paste.
//!
//! FYERS sends the browser to the redirect URL registered on the user's FYERS app (myapi.fyers.in)
//! with `s`, `code`, `auth_code` and `state`; `login_callback` listens for it on the loopback address.
//!
//! The port is fixed because FYERS only redirects to the exact URL registered on the app — see
//! `redirect_url`, which is what the user registers. It is not Zerodha's (47821), so the two logins
//! never compete for one port, and changing it would silently break every existing setup.

use std::time::Duration;

use tokio::net::TcpListener;

use super::protocol::extract_auth_code;
use crate::login_callback;

/// The loopback port FYERS's login redirect arrives on.
pub const PORT: u16 = 47822;
/// How long to wait for the user to finish logging in.
pub const WAIT: Duration = login_callback::WAIT;

/// What the user registers as their FYERS app's redirect URL, and what the login sends as
/// `redirect_uri`: the two must match exactly.
pub fn redirect_url() -> String {
    format!("http://127.0.0.1:{PORT}/")
}

/// Starts listening for the redirect. Bind before sending the user to FYERS, so the browser can never
/// arrive before the app is ready for it.
pub async fn listen() -> Result<TcpListener, String> {
    login_callback::listen(PORT, "FYERS").await
}

/// Waits for the browser to arrive with an `auth_code` for the login started with `state`.
pub async fn wait_for_auth_code(listener: TcpListener, wait: Duration, state: &str) -> Result<String, String> {
    login_callback::wait_for(
        listener,
        wait,
        "FYERS",
        |target| target.contains("auth_code=") || target.contains("s=error") || target.contains("s=ok"),
        |target| extract_auth_code(target, Some(state)),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::login_callback::tests::{browse, listener_on_any_port};

    #[test]
    fn the_redirect_url_is_the_one_to_register_with_fyers() {
        assert_eq!(redirect_url(), "http://127.0.0.1:47822/");
        assert_ne!(PORT, crate::zerodha::callback::PORT);
    }

    #[tokio::test]
    async fn the_redirect_hands_over_its_auth_code_when_the_state_matches() {
        let listener = listener_on_any_port().await;
        let port = listener.local_addr().unwrap().port();
        let waiting = tokio::spawn(async move { wait_for_auth_code(listener, WAIT, "st8").await });
        let ignored = browse(port, "/favicon.ico").await;
        assert!(ignored.starts_with("HTTP/1.1 404"), "{ignored}");
        let answer = browse(port, "/?s=ok&code=200&auth_code=eyJhbGci.payload.sig&state=st8").await;
        assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
        assert_eq!(waiting.await.unwrap().unwrap(), "eyJhbGci.payload.sig");
    }

    #[tokio::test]
    async fn a_redirect_from_another_login_is_refused() {
        let listener = listener_on_any_port().await;
        let port = listener.local_addr().unwrap().port();
        let waiting = tokio::spawn(async move { wait_for_auth_code(listener, WAIT, "mine").await });
        let answer = browse(port, "/?s=ok&auth_code=eyJhbGci.payload.sig&state=theirs").await;
        assert!(answer.starts_with("HTTP/1.1 400"), "{answer}");
        assert!(waiting.await.unwrap().unwrap_err().contains("state"));
    }

    #[tokio::test]
    async fn a_failed_login_is_reported_rather_than_waited_out() {
        let listener = listener_on_any_port().await;
        let port = listener.local_addr().unwrap().port();
        let waiting = tokio::spawn(async move { wait_for_auth_code(listener, WAIT, "x").await });
        browse(port, "/?s=error&code=-413&message=Invalid%20app%20id").await;
        assert!(waiting.await.unwrap().unwrap_err().contains("Invalid app id"));
    }
}
