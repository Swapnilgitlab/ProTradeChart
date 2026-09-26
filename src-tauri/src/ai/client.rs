//! A small client for Anthropic's Messages API, used by the AI Study Builder. Plain HTTP: there is
//! no official Rust SDK. The user's API key is passed in for each call (it is read from
//! [`crate::secrets::Secrets`] by the command and never kept here), and nothing about the key or
//! the bodies is logged.

use std::fmt;
use std::time::Duration;

use serde_json::Value;

pub const BASE_URL: &str = "https://api.anthropic.com";
const API_VERSION: &str = "2023-06-01";
/// Opts the request into server-side fallbacks (`"fallbacks": "default"` in the body): when the
/// model's safety classifiers decline a request, Anthropic re-runs it on its recommended fallback
/// model within the same call instead of returning the refusal.
pub const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
/// Thinking and a full Study Specification can take a few minutes; the default client's 30 s would
/// cut most answers off.
const MESSAGE_TIMEOUT: Duration = Duration::from_secs(300);
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiErrorKind {
    /// Anthropic didn't accept the key.
    BadKey,
    /// Rate limited or overloaded: worth trying again later.
    Busy,
    /// The model (and its fallback) declined the request.
    Refused,
    /// The answer hit `max_tokens` before it was complete.
    CutOff,
    Network,
    /// Anything else the API said, in its own words.
    Api,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiError {
    pub kind: AiErrorKind,
    pub message: String,
}

impl AiError {
    fn new(kind: AiErrorKind, message: impl Into<String>) -> Self {
        AiError {
            kind,
            message: message.into(),
        }
    }
}

impl fmt::Display for AiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

/// A finished answer: the text of its `text` blocks, and the model that actually produced it
/// (a fallback model when the requested one declined).
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub text: String,
    pub model: String,
}

pub struct ClaudeClient {
    http: reqwest::Client,
    base: String,
}

impl ClaudeClient {
    pub fn new(http: reqwest::Client) -> Self {
        Self::with_base(http, BASE_URL)
    }

    pub fn with_base(http: reqwest::Client, base: &str) -> Self {
        ClaudeClient {
            http,
            base: base.trim_end_matches('/').to_string(),
        }
    }

    fn request(&self, builder: reqwest::RequestBuilder, key: &str) -> reqwest::RequestBuilder {
        builder
            .header("x-api-key", key)
            .header("anthropic-version", API_VERSION)
    }

    /// Asks Anthropic whether it accepts a key, by listing one model: free, and it needs the key.
    pub async fn check_key(&self, key: &str) -> Result<(), AiError> {
        let resp = self
            .request(self.http.get(format!("{}/v1/models?limit=1", self.base)), key)
            .timeout(CHECK_TIMEOUT)
            .send()
            .await
            .map_err(network)?;
        let status = resp.status().as_u16();
        if (200..300).contains(&status) {
            return Ok(());
        }
        let body = resp.text().await.unwrap_or_default();
        Err(http_error(status, &body))
    }

    /// Sends one Messages API request (built by [`super::prompts`]) and returns its answer.
    pub async fn message(&self, key: &str, body: &Value) -> Result<Reply, AiError> {
        let resp = self
            .request(self.http.post(format!("{}/v1/messages", self.base)), key)
            .header("anthropic-beta", FALLBACK_BETA)
            .json(body)
            .timeout(MESSAGE_TIMEOUT)
            .send()
            .await
            .map_err(network)?;
        let status = resp.status().as_u16();
        let text = resp.text().await.map_err(network)?;
        log::info!("Claude request finished with HTTP {status}");
        parse_reply(status, &text)
    }
}

fn network(e: reqwest::Error) -> AiError {
    let what = if e.is_timeout() {
        "Anthropic took too long to answer. Try again, or ask a narrower question."
    } else {
        "Couldn't reach Anthropic. Check the internet connection and try again."
    };
    log::warn!("Claude request failed: {e}");
    AiError::new(AiErrorKind::Network, what)
}

/// The API's own error message, from `{"type":"error","error":{"type":…,"message":…}}`.
fn api_message(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body).ok()?;
    let message = v.get("error")?.get("message")?.as_str()?.trim();
    (!message.is_empty()).then(|| message.chars().take(500).collect())
}

fn http_error(status: u16, body: &str) -> AiError {
    let said = api_message(body);
    match status {
        401 => AiError::new(
            AiErrorKind::BadKey,
            "Anthropic didn't accept the API key. Check it in the Claude API key settings.",
        ),
        403 => AiError::new(
            AiErrorKind::Api,
            format!(
                "Anthropic refused this key permission: {}",
                said.as_deref().unwrap_or("no reason given")
            ),
        ),
        429 => AiError::new(
            AiErrorKind::Busy,
            "Your Anthropic account's rate limit was reached. Wait a minute and try again.",
        ),
        529 | 503 => AiError::new(
            AiErrorKind::Busy,
            "Anthropic is overloaded at the moment. Try again in a little while.",
        ),
        413 => AiError::new(AiErrorKind::Api, "The request was too large for Anthropic to accept."),
        500..=599 => AiError::new(
            AiErrorKind::Api,
            format!("Anthropic had a problem answering (HTTP {status}). Try again."),
        ),
        _ => AiError::new(
            AiErrorKind::Api,
            match said {
                Some(m) => format!("Anthropic rejected the request: {m}"),
                None => format!("Anthropic rejected the request (HTTP {status})."),
            },
        ),
    }
}

/// Reads a Messages API response. Pure, so every branch is tested without a server.
///
/// `stop_reason` decides before `content` is read: a refusal can come with no content at all, or
/// with a partial answer that must not be used.
pub fn parse_reply(status: u16, body: &str) -> Result<Reply, AiError> {
    if !(200..300).contains(&status) {
        return Err(http_error(status, body));
    }
    let v: Value = serde_json::from_str(body)
        .map_err(|_| AiError::new(AiErrorKind::Api, "Anthropic's answer wasn't readable."))?;
    match v.get("stop_reason").and_then(Value::as_str) {
        Some("refusal") => {
            return Err(AiError::new(
                AiErrorKind::Refused,
                "Claude declined this request. Try rewording it as a market-research question.",
            ))
        }
        Some("max_tokens") => {
            return Err(AiError::new(
                AiErrorKind::CutOff,
                "Claude's answer was cut off before it was complete. Try a simpler question.",
            ))
        }
        _ => {}
    }
    // Thinking, redacted thinking and fallback blocks carry nothing the app shows.
    let text: String = v
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err(AiError::new(AiErrorKind::Api, "Claude returned an empty answer."));
    }
    Ok(Reply {
        text,
        model: v.get("model").and_then(Value::as_str).unwrap_or_default().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn a_finished_answer_is_its_text_blocks() {
        let body = json!({
            "model": "claude-opus-5",
            "stop_reason": "end_turn",
            "content": [
                {"type": "thinking", "thinking": "…", "signature": "x"},
                {"type": "text", "text": "{\"a\":"},
                {"type": "text", "text": "1}"}
            ]
        });
        let reply = parse_reply(200, &body.to_string()).unwrap();
        assert_eq!(reply.text, "{\"a\":1}");
        assert_eq!(reply.model, "claude-opus-5");
    }

    #[test]
    fn a_fallback_answer_names_the_model_that_gave_it() {
        let body = json!({
            "model": "claude-opus-4-8",
            "stop_reason": "end_turn",
            "content": [
                {"type": "fallback", "from": {"model": "claude-opus-5"}, "to": {"model": "claude-opus-4-8"}},
                {"type": "text", "text": "ok"}
            ]
        });
        let reply = parse_reply(200, &body.to_string()).unwrap();
        assert_eq!((reply.text.as_str(), reply.model.as_str()), ("ok", "claude-opus-4-8"));
    }

    #[test]
    fn a_refusal_or_a_cut_off_answer_is_never_used() {
        let refused = json!({"stop_reason": "refusal", "content": [{"type": "text", "text": "partial"}]});
        assert_eq!(
            parse_reply(200, &refused.to_string()).unwrap_err().kind,
            AiErrorKind::Refused
        );
        let refused_empty = json!({"stop_reason": "refusal", "stop_details": null, "content": []});
        assert_eq!(
            parse_reply(200, &refused_empty.to_string()).unwrap_err().kind,
            AiErrorKind::Refused
        );
        let cut = json!({"stop_reason": "max_tokens", "content": [{"type": "text", "text": "{\"spec\":"}]});
        assert_eq!(
            parse_reply(200, &cut.to_string()).unwrap_err().kind,
            AiErrorKind::CutOff
        );
        let empty = json!({"stop_reason": "end_turn", "content": []});
        assert_eq!(parse_reply(200, &empty.to_string()).unwrap_err().kind, AiErrorKind::Api);
        assert_eq!(parse_reply(200, "<html>").unwrap_err().kind, AiErrorKind::Api);
    }

    #[test]
    fn http_errors_become_plain_words() {
        let err = |status: u16, body: &str| parse_reply(status, body).unwrap_err();
        let invalid = r#"{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: too big"}}"#;
        assert_eq!(err(401, "{}").kind, AiErrorKind::BadKey);
        assert_eq!(err(429, "{}").kind, AiErrorKind::Busy);
        assert_eq!(err(529, "{}").kind, AiErrorKind::Busy);
        let bad = err(400, invalid);
        assert_eq!(bad.kind, AiErrorKind::Api);
        assert!(bad.message.contains("max_tokens: too big"), "{}", bad.message);
        assert!(err(500, "").message.contains("HTTP 500"));
        assert!(err(418, "").message.contains("HTTP 418"));
    }

    /// Answers one request with `status` and `body`, and hands back the request it was sent.
    async fn serve_once(status: u16, body: Value) -> (String, Arc<Mutex<Option<(String, String)>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(None));
        let record = seen.clone();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let head_end = loop {
                let mut chunk = [0u8; 8192];
                let n = sock.read(&mut chunk).await.unwrap();
                buf.extend_from_slice(&chunk[..n]);
                if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break p + 4;
                }
                assert!(n > 0);
            };
            let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
            let length: usize = head
                .lines()
                .find_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    k.eq_ignore_ascii_case("content-length")
                        .then(|| v.trim().parse().ok())?
                })
                .unwrap_or(0);
            while buf.len() < head_end + length {
                let mut chunk = [0u8; 8192];
                let n = sock.read(&mut chunk).await.unwrap();
                buf.extend_from_slice(&chunk[..n]);
            }
            let sent = String::from_utf8_lossy(&buf[head_end..head_end + length]).to_string();
            *record.lock().unwrap() = Some((head, sent));
            let payload = body.to_string();
            let response = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                payload.len()
            );
            sock.write_all(response.as_bytes()).await.unwrap();
            sock.shutdown().await.ok();
        });
        (base, seen)
    }

    #[tokio::test]
    async fn a_message_carries_the_key_version_and_fallback_opt_in() {
        let (base, seen) = serve_once(
            200,
            json!({"model": "claude-opus-5", "stop_reason": "end_turn", "content": [{"type": "text", "text": "hi"}]}),
        )
        .await;
        let client = ClaudeClient::with_base(reqwest::Client::new(), &base);
        let reply = client
            .message("sk-ant-test", &json!({"model": "claude-opus-5"}))
            .await
            .unwrap();
        assert_eq!(reply.text, "hi");
        let (head, body) = seen.lock().unwrap().clone().unwrap();
        let head = head.to_ascii_lowercase();
        assert!(head.starts_with("post /v1/messages "), "{head}");
        assert!(head.contains("x-api-key: sk-ant-test"));
        assert!(head.contains("anthropic-version: 2023-06-01"));
        assert!(head.contains(&format!("anthropic-beta: {FALLBACK_BETA}")));
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["model"], "claude-opus-5");
    }

    #[tokio::test]
    async fn a_key_check_lists_models_and_reads_a_401_as_a_bad_key() {
        let (base, seen) = serve_once(200, json!({"data": []})).await;
        let client = ClaudeClient::with_base(reqwest::Client::new(), &base);
        client.check_key("sk-ant-good").await.unwrap();
        let head = seen.lock().unwrap().clone().unwrap().0;
        assert!(head.starts_with("GET /v1/models?limit=1 "), "{head}");

        let (base, _) = serve_once(
            401,
            json!({"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}}),
        )
        .await;
        let client = ClaudeClient::with_base(reqwest::Client::new(), &base);
        assert_eq!(
            client.check_key("sk-ant-bad").await.unwrap_err().kind,
            AiErrorKind::BadKey
        );
    }
}
