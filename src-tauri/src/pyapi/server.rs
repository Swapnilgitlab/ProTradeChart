//! The listener: binds the loopback interface on a free port, makes the per-launch token,
//! and hands each request to [`routes::dispatch`]. All the decisions about *who* may ask
//! are in `routes`; this only speaks HTTP.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, LengthLimitError, Limited};
use hyper::body::Incoming;
use hyper::header::{HeaderMap, HeaderName, AUTHORIZATION, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, HOST, ORIGIN};
use hyper::service::service_fn;
use hyper::{Method, Request, Response};
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::net::TcpListener;
use tokio::sync::Semaphore;

use super::routes::{authorize, dispatch, too_large, Backend, Ctx, Req, Resp, MAX_BODY_BYTES};
use super::wire::error_json;
use super::ApiError;

/// Connections served at once. A script fetching many symbols in threads needs a handful;
/// this stops a runaway one from opening thousands.
const MAX_CONNECTIONS: usize = 32;
/// A client that hasn't sent a full request header by now is dropped, so a stalled or
/// hostile one can't hold a slot for ever.
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
/// The same for a body that trickles in: a table of a few megabytes over loopback takes
/// milliseconds, so this is generous.
const BODY_TIMEOUT: Duration = Duration::from_secs(30);

/// A running API. Dropping it stops the listener.
pub struct Server {
    /// `http://127.0.0.1:<port>`.
    pub url: String,
    /// What a caller must present as `Authorization: Bearer <token>`.
    pub token: String,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// 256 random bits, as 64 hex characters.
pub fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("the system has no secure random numbers: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Starts listening on `127.0.0.1` at a port the system picks. Loopback only: nothing
/// outside this machine can connect.
pub async fn start(backend: Arc<dyn Backend>) -> Result<Server, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("couldn't open the local data API: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("couldn't read the data API's port: {e}"))?
        .port();
    let token = new_token()?;
    let ctx = Arc::new(Ctx {
        backend,
        token: token.clone(),
        port,
    });
    let task = tokio::spawn(serve(listener, ctx));
    Ok(Server {
        url: format!("http://127.0.0.1:{port}"),
        token,
        task,
    })
}

async fn serve(listener: TcpListener, ctx: Arc<Ctx>) {
    let capacity = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        // Wait for room before accepting, so the excess queue in the OS backlog.
        let Ok(permit) = capacity.clone().acquire_owned().await else {
            return;
        };
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(e) => {
                log::warn!("python API: accept failed: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let ctx = ctx.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let service = service_fn(move |req: Request<Incoming>| {
                let ctx = ctx.clone();
                async move { Ok::<_, Infallible>(respond(&ctx, req).await) }
            });
            let served = hyper::server::conn::http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(HEADER_TIMEOUT)
                .serve_connection(TokioIo::new(stream), service)
                .await;
            if let Err(e) = served {
                log::debug!("python API: connection ended: {e}");
            }
        });
    }
}

/// The body of a request, if it is small enough and arrives in time.
async fn read_body(headers: &HeaderMap, body: Incoming) -> Result<Vec<u8>, ApiError> {
    // A size the client declares up front is refused before a byte of it is read.
    let declared = headers
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<usize>().ok());
    if declared.is_some_and(|n| n > MAX_BODY_BYTES) {
        return Err(too_large());
    }
    match tokio::time::timeout(BODY_TIMEOUT, Limited::new(body, MAX_BODY_BYTES).collect()).await {
        Err(_) => Err(ApiError::new(
            408,
            "request_timeout",
            "The request body took too long to arrive.",
        )),
        Ok(Err(e)) if e.downcast_ref::<LengthLimitError>().is_some() => Err(too_large()),
        Ok(Err(e)) => Err(ApiError::bad_request(format!("Couldn't read the request body: {e}"))),
        Ok(Ok(collected)) => Ok(collected.to_bytes().to_vec()),
    }
}

async fn respond(ctx: &Ctx, request: Request<Incoming>) -> Response<Full<Bytes>> {
    let (parts, body) = request.into_parts();
    let header = |name: HeaderName| {
        parts
            .headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let target = parts
        .uri
        .path_and_query()
        .map_or_else(|| parts.uri.path().to_string(), |pq| pq.as_str().to_string());
    let mut parsed = Req {
        method: parts.method.as_str().to_string(),
        target,
        host: header(HOST),
        origin: header(ORIGIN),
        authorization: header(AUTHORIZATION),
        content_type: header(CONTENT_TYPE),
        body: Vec::new(),
    };

    // Who is asking is settled before any body is read, so a caller that hasn't proved itself
    // can't make the app buffer megabytes.
    if let Err(e) = authorize(ctx, &parsed) {
        return build(refusal(&e));
    }
    if parts.method != Method::GET {
        match read_body(&parts.headers, body).await {
            Ok(bytes) => parsed.body = bytes,
            Err(e) => return build(refusal(&e)),
        }
    }
    build(dispatch(ctx, &parsed).await)
}

fn refusal(e: &ApiError) -> Resp {
    Resp {
        status: e.status,
        body: error_json(e),
    }
}

fn build(answer: Resp) -> Response<Full<Bytes>> {
    Response::builder()
        .status(answer.status)
        .header(CONTENT_TYPE, "application/json")
        // Market data for one script run; nothing should keep a copy.
        .header(CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(Full::new(Bytes::from(answer.body)))
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::from_static(b"{}"))))
}

#[cfg(test)]
mod tests {
    use super::super::routes::testing::FakeBackend;
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    fn port_of(server: &Server) -> u16 {
        server.url.rsplit(':').next().unwrap().parse().unwrap()
    }

    async fn started() -> Server {
        start(Arc::new(FakeBackend::default())).await.unwrap()
    }

    /// Sends `raw` and returns everything the server says before it closes.
    async fn exchange(port: u16, raw: &str) -> String {
        let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        socket.write_all(raw.as_bytes()).await.unwrap();
        let mut answer = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), socket.read_to_end(&mut answer)).await;
        String::from_utf8_lossy(&answer).into_owned()
    }

    fn request(server: &Server, target: &str, extra: &str, with_token: bool) -> String {
        let auth = if with_token {
            format!("Authorization: Bearer {}\r\n", server.token)
        } else {
            String::new()
        };
        format!(
            "GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n{auth}{extra}Connection: close\r\n\r\n",
            port_of(server)
        )
    }

    #[test]
    fn a_token_is_64_hex_characters_and_never_repeats() {
        let (a, b) = (new_token().unwrap(), new_token().unwrap());
        assert_eq!(a.len(), 64);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[tokio::test]
    async fn it_listens_on_the_loopback_interface_only() {
        let server = started().await;
        assert!(server.url.starts_with("http://127.0.0.1:"), "{}", server.url);
    }

    #[tokio::test]
    async fn a_caller_with_the_token_gets_json_that_is_not_cached() {
        let server = started().await;
        let answer = exchange(port_of(&server), &request(&server, "/v1/ping", "", true)).await;
        assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
        let lower = answer.to_lowercase();
        assert!(lower.contains("content-type: application/json"), "{answer}");
        assert!(lower.contains("cache-control: no-store"), "{answer}");
        assert!(answer.contains(r#""ok":true"#), "{answer}");
    }

    #[tokio::test]
    async fn a_caller_without_the_token_gets_nothing_but_a_refusal() {
        let server = started().await;
        let answer = exchange(
            port_of(&server),
            &request(&server, "/v1/bars?symbol=zerodha:NSE:X", "", false),
        )
        .await;
        assert!(answer.starts_with("HTTP/1.1 401"), "{answer}");
        assert!(!answer.contains("\"t\""), "no data leaked: {answer}");
    }

    #[tokio::test]
    async fn a_browser_is_refused_even_with_the_token_and_gets_no_cors_permission() {
        let server = started().await;
        let answer = exchange(
            port_of(&server),
            &request(&server, "/v1/ping", "Origin: https://evil.example\r\n", true),
        )
        .await;
        assert!(answer.starts_with("HTTP/1.1 403"), "{answer}");
        assert!(!answer.to_lowercase().contains("access-control-allow"), "{answer}");
    }

    #[tokio::test]
    async fn a_rebound_host_name_is_refused_even_with_the_token() {
        let server = started().await;
        let raw = format!(
            "GET /v1/ping HTTP/1.1\r\nHost: attacker.example:{}\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n",
            port_of(&server),
            server.token
        );
        let answer = exchange(port_of(&server), &raw).await;
        assert!(answer.starts_with("HTTP/1.1 403"), "{answer}");
    }

    #[tokio::test]
    async fn garbage_is_answered_without_hurting_the_server() {
        let server = started().await;
        let junk = exchange(port_of(&server), "this is not http\r\n\r\n").await;
        assert!(junk.is_empty() || junk.starts_with("HTTP/1.1 400"), "{junk}");
        let answer = exchange(port_of(&server), &request(&server, "/v1/ping", "", true)).await;
        assert!(answer.starts_with("HTTP/1.1 200"), "still serving: {answer}");
    }

    fn post_request(server: &Server, target: &str, content_type: &str, body: &str, with_token: bool) -> String {
        let auth = if with_token {
            format!("Authorization: Bearer {}\r\n", server.token)
        } else {
            String::new()
        };
        format!(
            "POST {target} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n{auth}Content-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            port_of(server),
            body.len()
        )
    }

    const RESULT: &str = r#"{"runId":"run-1","kind":"table","title":"t","data":{"columns":["a"],"rows":[[1]]}}"#;

    #[tokio::test]
    async fn a_result_posted_with_the_token_reaches_the_app() {
        let backend = Arc::new(FakeBackend::default());
        let server = start(backend.clone()).await.unwrap();
        let answer = exchange(
            port_of(&server),
            &post_request(&server, "/v1/results", "application/json", RESULT, true),
        )
        .await;
        assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
        let posted = backend.results.lock().unwrap().clone();
        assert_eq!(posted.len(), 1);
        assert_eq!(posted[0].run_id, "run-1");
        assert_eq!(posted[0].data["rows"][0][0], 1);
    }

    #[tokio::test]
    async fn a_result_without_the_token_is_refused_before_its_body_is_read() {
        let backend = Arc::new(FakeBackend::default());
        let server = start(backend.clone()).await.unwrap();
        // It promises a body and never sends it. A server that read before checking who was
        // asking would wait for it; this one answers at once.
        let raw = format!(
            "POST /v1/results HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n",
            port_of(&server)
        );
        let started = std::time::Instant::now();
        let answer = exchange(port_of(&server), &raw).await;
        assert!(answer.starts_with("HTTP/1.1 401"), "{answer}");
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "waited for a body it should not have read"
        );
        assert!(backend.results.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_declared_size_over_the_cap_is_refused_without_reading_it() {
        let server = started().await;
        let raw = format!(
            "POST /v1/results HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            port_of(&server),
            server.token,
            MAX_BODY_BYTES + 1
        );
        let answer = exchange(port_of(&server), &raw).await;
        assert!(answer.starts_with("HTTP/1.1 413"), "{answer}");
        assert!(answer.contains("too_large"), "{answer}");
    }

    #[tokio::test]
    async fn a_chunked_body_over_the_cap_is_never_accepted_and_the_server_carries_on() {
        let backend = Arc::new(FakeBackend::default());
        let server = start(backend.clone()).await.unwrap();
        // Chunked, so there is no declared length to refuse it by: the limit is on what arrives.
        let mut socket = TcpStream::connect(("127.0.0.1", port_of(&server))).await.unwrap();
        let head = format!(
            "POST /v1/results HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
            port_of(&server),
            server.token
        );
        socket.write_all(head.as_bytes()).await.unwrap();
        let chunk = vec![b'a'; 1024 * 1024];
        for _ in 0..(MAX_BODY_BYTES / chunk.len() + 4) {
            let framed = [format!("{:x}\r\n", chunk.len()).as_bytes(), &chunk, b"\r\n"].concat();
            // Once the server has refused and hung up, writing fails; that is the point.
            if socket.write_all(&framed).await.is_err() {
                break;
            }
        }
        drop(socket);

        assert!(
            backend.results.lock().unwrap().is_empty(),
            "an oversize body was accepted"
        );
        let answer = exchange(port_of(&server), &request(&server, "/v1/ping", "", true)).await;
        assert!(
            answer.starts_with("HTTP/1.1 200"),
            "the server should still be serving: {answer}"
        );
    }

    #[tokio::test]
    async fn a_result_that_is_not_json_or_not_a_result_is_refused_with_a_reason() {
        let server = started().await;
        for (content_type, body, status) in [
            ("text/plain", RESULT, "415"),
            ("application/json", "{not json", "400"),
            (
                "application/json",
                r#"{"runId":"bad run","kind":"table","data":{}}"#,
                "400",
            ),
        ] {
            let answer = exchange(
                port_of(&server),
                &post_request(&server, "/v1/results", content_type, body, true),
            )
            .await;
            assert!(
                answer.starts_with(&format!("HTTP/1.1 {status}")),
                "{content_type} {body}: {answer}"
            );
        }
    }

    #[tokio::test]
    async fn a_stalled_connection_does_not_block_the_others() {
        let server = started().await;
        // Half a request, never finished.
        let mut stalled = TcpStream::connect(("127.0.0.1", port_of(&server))).await.unwrap();
        stalled.write_all(b"GET /v1/ping HTTP/1.1\r\n").await.unwrap();

        let answer = exchange(port_of(&server), &request(&server, "/v1/ping", "", true)).await;
        assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
    }

    #[tokio::test]
    async fn many_requests_at_once_are_all_answered() {
        let server = started().await;
        let port = port_of(&server);
        let raw = request(&server, "/v1/ping", "", true);
        let handles: Vec<_> = (0..20)
            .map(|_| {
                let raw = raw.clone();
                tokio::spawn(async move { exchange(port, &raw).await })
            })
            .collect();
        for h in handles {
            assert!(h.await.unwrap().starts_with("HTTP/1.1 200"));
        }
    }

    #[tokio::test]
    async fn dropping_the_server_closes_the_port() {
        let server = started().await;
        let port = port_of(&server);
        drop(server);
        // Aborting is asynchronous: give the listener a moment to go.
        let mut closed = false;
        for _ in 0..50 {
            if TcpStream::connect(("127.0.0.1", port)).await.is_err() {
                closed = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(closed, "the port was still open a second after the server was dropped");
    }
}
