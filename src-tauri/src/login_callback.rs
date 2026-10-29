//! Catches a broker's login redirect, so a login needs no copy-and-paste.
//!
//! The broker sends the browser to the redirect URL registered on the user's own app, with a
//! one-time code in the query. The app listens on the loopback address for exactly that one
//! redirect: nothing outside this machine can reach it, it accepts one code and stops, and it gives
//! up after [`WAIT`] so a login the user abandoned doesn't leave a socket open.
//!
//! Each broker's port is fixed (`zerodha::callback`, `fyers::callback`), because a broker only ever
//! redirects to the exact URL registered on the app, which is what the user registered.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// How long to wait for the user to finish logging in.
pub const WAIT: Duration = Duration::from_secs(300);
/// Enough for any redirect; a client sending more than this is not a browser.
const MAX_HEAD: usize = 8 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(10);

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

/// Starts listening for the redirect on `port`. Bind before sending the user to the broker, so the
/// browser can never arrive before the app is ready for it.
pub async fn listen(port: u16, broker: &str) -> Result<TcpListener, String> {
    TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            format!(
                "Port {port} is already in use — another login may still be waiting. \
                 Finish it in the browser, or try again in a few minutes."
            )
        } else {
            format!("Couldn't listen for {broker}'s reply: {e}")
        }
    })
}

/// Waits for the browser to arrive with the redirect. `is_redirect` says whether a request target
/// is it (anything else, like a browser asking for `/favicon.ico`, is answered and ignored), and
/// `extract` takes the code out of it or says why the login failed. The first redirect ends the
/// wait, either way.
pub async fn wait_for(
    listener: TcpListener,
    wait: Duration,
    broker: &str,
    is_redirect: impl Fn(&str) -> bool,
    extract: impl Fn(&str) -> Result<String, String>,
) -> Result<String, String> {
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
            if !is_redirect(target) {
                reply(
                    &mut socket,
                    "404 Not Found",
                    &page("Nothing here", "This page is only used to log in."),
                )
                .await;
                continue;
            }
            return match extract(target) {
                Ok(code) => {
                    // Sent before the code is exchanged, so it can't claim the login worked.
                    reply(
                        &mut socket,
                        "200 OK",
                        &page(
                            "Login received",
                            "You can close this tab and go back to ProTradeChart, which is finishing the login.",
                        ),
                    )
                    .await;
                    Ok(code)
                }
                Err(e) => {
                    reply(&mut socket, "400 Bad Request", &page("That didn't work", &e)).await;
                    Err(e)
                }
            };
        }
    })
    .await
    .map_err(|_| format!("Timed out waiting for the {broker} login. Try again, or paste the address yourself."))?
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Talks to a listener the way a browser would, and reports what came back.
    pub(crate) async fn browse(port: u16, target: &str) -> String {
        let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let request = format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        socket.write_all(request.as_bytes()).await.unwrap();
        let mut answer = String::new();
        socket.read_to_string(&mut answer).await.unwrap();
        answer
    }

    pub(crate) async fn listener_on_any_port() -> TcpListener {
        TcpListener::bind(("127.0.0.1", 0)).await.unwrap()
    }

    #[test]
    fn a_request_line_yields_its_target_only_for_a_get() {
        assert_eq!(request_target("GET /?code=abc HTTP/1.1"), Some("/?code=abc"));
        assert_eq!(request_target("POST / HTTP/1.1"), None);
        assert_eq!(request_target(""), None);
    }

    #[tokio::test]
    async fn waiting_gives_up_rather_than_holding_the_port_for_ever() {
        let listener = listener_on_any_port().await;
        let gave_up = wait_for(
            listener,
            Duration::from_millis(30),
            "Broker",
            |_| true,
            |t| Ok(t.into()),
        )
        .await;
        assert!(gave_up.unwrap_err().contains("Timed out waiting for the Broker login"));
    }
}
