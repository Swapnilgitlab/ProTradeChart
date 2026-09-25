//! Catches Zerodha's login redirect, so a login needs no copy-and-paste.
//!
//! Kite sends the browser to the redirect URL registered on the user's Kite app
//! with a one-time `request_token`. The app listens on the loopback address for
//! exactly that one redirect: nothing outside this machine can reach it, it
//! accepts one token and stops, and it gives up after [`WAIT`] so a login the
//! user abandoned doesn't leave a socket open.
//!
//! The port is fixed because Kite only ever redirects to the exact URL
//! registered on the app — see `redirect_url`, which is what the user registers.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::protocol::extract_request_token;

/// The loopback port the login redirect arrives on.
pub const PORT: u16 = 47821;
/// How long to wait for the user to finish logging in.
pub const WAIT: Duration = Duration::from_secs(300);
/// Enough for any redirect; a client sending more than this is not a browser.
const MAX_HEAD: usize = 8 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(10);

/// What the user registers as their Kite app's redirect URL. Any path under it
/// is accepted, so a trailing `/callback` typed by hand still works.
pub fn redirect_url() -> String {
    format!("http://127.0.0.1:{PORT}")
}

fn page(heading: &str, detail: &str) -> String {
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <title>ProTradeChart</title><style>body{{font:16px system-ui,sans-serif;margin:0;display:flex;\
         min-height:100vh;align-items:center;justify-content:center;background:#0f1115;color:#e6e8ee}}\
         div{{max-width:28rem;padding:2rem;text-align:center}}h1{{font-size:1.25rem;margin:0 0 .5rem}}\
         p{{margin:0;color:#9aa3b2}}</style></head><body><div><h1>{heading}</h1><p>{detail}</p></div></body></html>"
    )
}

/// The path and query of an HTTP request, from its first line.
fn request_target(head: &str) -> Option<&str> {
    let mut parts = head.split_whitespace();
    let method = parts.next()?;
    let target = parts.next()?;
    method.eq_ignore_ascii_case("GET").then_some(target)
}

async fn read_head(socket: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < MAX_HEAD {
        match tokio::time::timeout(READ_TIMEOUT, socket.read(&mut chunk)).await {
            Ok(Ok(0)) | Ok(Err(_)) | Err(_) => break,
            Ok(Ok(n)) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    (!buf.is_empty()).then(|| String::from_utf8_lossy(&buf).into_owned())
}

async fn reply(socket: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.shutdown().await;
}

/// Starts listening for the redirect. Bind before sending the user to Zerodha,
/// so the browser can never arrive before the app is ready for it.
pub async fn listen() -> Result<TcpListener, String> {
    TcpListener::bind(("127.0.0.1", PORT)).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            format!(
                "Port {PORT} is already in use — another login may still be waiting. \
                 Finish it in the browser, or try again in a few minutes."
            )
        } else {
            format!("Couldn't listen for Zerodha's reply: {e}")
        }
    })
}

/// Waits for the browser to arrive with a request token. Requests that aren't
/// the redirect (a browser asking for `/favicon.ico`, say) are answered and
/// ignored; the first redirect ends the wait, either way.
pub async fn wait_for_request_token(listener: TcpListener, wait: Duration) -> Result<String, String> {
    tokio::time::timeout(wait, async {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                continue;
            };
            let Some(head) = read_head(&mut socket).await else {
                continue;
            };
            let Some(target) = request_target(&head) else {
                reply(
                    &mut socket,
                    "405 Method Not Allowed",
                    &page("Nothing here", "This page is only used to log in."),
                )
                .await;
                continue;
            };
            if !target.contains("request_token=") && !target.contains("status=") {
                reply(
                    &mut socket,
                    "404 Not Found",
                    &page("Nothing here", "This page is only used to log in."),
                )
                .await;
                continue;
            }
            return match extract_request_token(target) {
                Ok(token) => {
                    // Sent before the token is exchanged, so it can't claim the login worked.
                    reply(
                        &mut socket,
                        "200 OK",
                        &page(
                            "Login received",
                            "You can close this tab and go back to ProTradeChart, which is finishing the login.",
                        ),
                    )
                    .await;
                    Ok(token)
                }
                Err(e) => {
                    reply(&mut socket, "400 Bad Request", &page("That didn't work", &e)).await;
                    Err(e)
                }
            };
        }
    })
    .await
    .map_err(|_| "Timed out waiting for the Zerodha login. Try again, or paste the address yourself.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Talks to a listener the way a browser would, and reports what came back.
    async fn browse(port: u16, target: &str) -> String {
        let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let request = format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        socket.write_all(request.as_bytes()).await.unwrap();
        let mut answer = String::new();
        socket.read_to_string(&mut answer).await.unwrap();
        answer
    }

    async fn listener_on_any_port() -> TcpListener {
        TcpListener::bind(("127.0.0.1", 0)).await.unwrap()
    }

    #[test]
    fn the_redirect_url_is_the_one_to_register_with_kite() {
        assert_eq!(redirect_url(), format!("http://127.0.0.1:{PORT}"));
    }

    #[test]
    fn a_request_line_yields_its_target_only_for_a_get() {
        assert_eq!(
            request_target("GET /?request_token=abc HTTP/1.1"),
            Some("/?request_token=abc")
        );
        assert_eq!(request_target("POST / HTTP/1.1"), None);
        assert_eq!(request_target(""), None);
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
