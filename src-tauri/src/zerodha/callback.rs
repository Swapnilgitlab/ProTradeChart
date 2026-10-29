//! Catches Zerodha's login redirect, so a login needs no copy-and-paste.
//!
//! Kite sends the browser to the redirect URL registered on the user's Kite app
//! with a one-time `request_token`; `login_callback` listens for it on the loopback
//! address.
//!
//! The port is fixed because Kite only ever redirects to the exact URL
//! registered on the app — see `redirect_url`, which is what the user registers.
//! Changing it would silently break every existing setup.

use std::time::Duration;

use tokio::net::TcpListener;

use super::protocol::extract_request_token;
use crate::login_callback;

/// The loopback port the login redirect arrives on.
pub const PORT: u16 = 47821;
/// How long to wait for the user to finish logging in.
pub const WAIT: Duration = login_callback::WAIT;

/// What the user registers as their Kite app's redirect URL. Any path under it
/// is accepted, so a trailing `/callback` typed by hand still works.
pub fn redirect_url() -> String {
    format!("http://127.0.0.1:{PORT}")
}

/// Starts listening for the redirect. Bind before sending the user to Zerodha,
/// so the browser can never arrive before the app is ready for it.
pub async fn listen() -> Result<TcpListener, String> {
    login_callback::listen(PORT, "Zerodha").await
}

/// Waits for the browser to arrive with a request token. Requests that aren't
/// the redirect (a browser asking for `/favicon.ico`, say) are answered and
/// ignored; the first redirect ends the wait, either way.
pub async fn wait_for_request_token(listener: TcpListener, wait: Duration) -> Result<String, String> {
    login_callback::wait_for(
        listener,
        wait,
        "Zerodha",
        |target| target.contains("request_token=") || target.contains("status="),
        extract_request_token,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::login_callback::tests::{browse, listener_on_any_port};

    #[test]
    fn the_redirect_url_is_the_one_to_register_with_kite() {
        assert_eq!(redirect_url(), format!("http://127.0.0.1:{PORT}"));
        assert_eq!(PORT, 47821, "existing Kite apps are registered with this port");
    }

    #[tokio::test]
    async fn the_redirect_hands_over_its_request_token_and_thanks_the_browser() {
        let listener = listener_on_any_port().await;
        let port = listener.local_addr().unwrap().port();
        let waiting = tokio::spawn(wait_for_request_token(listener, WAIT));

        let token = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
        let answer = browse(port, &format!("/?request_token={token}&action=login&status=success")).await;

        assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
        assert!(answer.contains("Login received"), "{answer}");
        assert!(
            !answer.contains("logged in"),
            "the page must not claim success yet: {answer}"
        );
        assert_eq!(waiting.await.unwrap().unwrap(), token);
    }

    #[tokio::test]
    async fn anything_that_is_not_the_redirect_is_waved_through() {
        let listener = listener_on_any_port().await;
        let port = listener.local_addr().unwrap().port();
        let waiting = tokio::spawn(wait_for_request_token(listener, WAIT));

        // Browsers ask for this on their own; it must not end the wait.
        let ignored = browse(port, "/favicon.ico").await;
        assert!(ignored.starts_with("HTTP/1.1 404"), "{ignored}");

        let token = "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4";
        browse(port, &format!("/callback?request_token={token}&status=success")).await;
        assert_eq!(waiting.await.unwrap().unwrap(), token, "a path of its own still works");
    }

    #[tokio::test]
    async fn a_failed_login_is_reported_rather_than_waited_out() {
        let listener = listener_on_any_port().await;
        let port = listener.local_addr().unwrap().port();
        let waiting = tokio::spawn(wait_for_request_token(listener, WAIT));

        let answer = browse(port, "/?status=error&error_type=TokenException").await;
        assert!(answer.starts_with("HTTP/1.1 400"), "{answer}");
        assert!(waiting.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn waiting_gives_up_rather_than_holding_the_port_for_ever() {
        let listener = listener_on_any_port().await;
        let gave_up = wait_for_request_token(listener, Duration::from_millis(30)).await;
        assert!(gave_up.unwrap_err().contains("Timed out"));
    }

    #[tokio::test]
    async fn the_port_can_only_be_claimed_once_at_a_time() {
        let Ok(first) = listen().await else {
            return; // the port is busy on this machine; nothing to prove
        };
        let second = listen().await;
        assert!(second.unwrap_err().contains("already in use"));
        drop(first);
    }
}
