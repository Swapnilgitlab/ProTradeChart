//! A small client for Anthropic's Messages API. Plain HTTP: there is no official Rust SDK. The
//! user's API key is passed in for each call (it is read from [`crate::secrets::Secrets`] by the
//! command and never kept here), and nothing about the key or the bodies is logged.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::{network_error, timed_out, AiError, AiErrorKind, AiRequest, Progress, Reply, Stage, ToolCall};

pub const BASE_URL: &str = "https://api.anthropic.com";
const API_VERSION: &str = "2023-06-01";
/// Opts the request into server-side fallbacks (`"fallbacks": "default"` in the body): when the
/// model's safety classifiers decline a request, Anthropic re-runs it on its recommended fallback
/// model within the same call instead of returning the refusal.
pub const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
pub const MODEL: &str = "claude-opus-5-5";
/// Opus 5.5 defaults to `medium`, a level below Opus 5's `high`; every request here is a spec, a
/// plan, an explanation or a script, where thoroughness matters more than a few seconds.
const EFFORT: &str = "high";
/// Room for adaptive thinking plus a full answer. Answers are streamed, so a long one can't time out.
const MAX_TOKENS: u32 = 32_000;
/// How long a streamed answer may go quiet before it is given up on. Anthropic sends a `ping` every
/// few seconds while the model thinks, so this is generous; there is no limit on the whole answer.
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
/// Time to the response headers of a message.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(60);
/// Progress is reported at most this often.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const PROVIDER: &str = "Anthropic";

pub struct ClaudeClient {
    http: reqwest::Client,
    base: String,
    idle: Duration,
}

impl ClaudeClient {
    pub fn new(http: reqwest::Client) -> Self {
        Self::with_base(http, BASE_URL)
    }

    pub fn with_base(http: reqwest::Client, base: &str) -> Self {
        ClaudeClient {
            http,
            base: base.trim_end_matches('/').to_string(),
            idle: IDLE_TIMEOUT,
        }
    }

    #[cfg(test)]
    fn with_idle(self, idle: Duration) -> Self {
        ClaudeClient { idle, ..self }
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
            .map_err(|e| network_error(&e, PROVIDER))?;
        let status = resp.status().as_u16();
        if (200..300).contains(&status) {
            return Ok(());
        }
        let body = resp.text().await.unwrap_or_default();
        Err(http_error(status, &body))
    }

    /// Builds the Messages API body for a request: `output_config.format.json_schema` when it
    /// asks for structured JSON text, or `tools` when it offers tool calls instead. No
    /// `tool_choice` is ever sent (Opus 5.5 refuses a forced one), and no thinking block is sent
    /// back: a conversation's history travels as plain text.
    fn body(&self, req: &AiRequest) -> Value {
        let messages: Vec<Value> = req
            .messages
            .iter()
            .map(|m| json!({"role": m.role, "content": m.content}))
            .collect();
        let mut body = json!({
            "model": MODEL,
            "max_tokens": MAX_TOKENS,
            "fallbacks": "default",
            "thinking": {"type": "adaptive"},
            "system": req.system,
            "messages": messages,
        });
        let map = body.as_object_mut().unwrap();
        let mut output = json!({"effort": EFFORT});
        if let Some(schema) = &req.schema {
            output["format"] = json!({"type": "json_schema", "schema": schema});
        }
        map.insert("output_config".into(), output);
        if req.cache {
            // Caches everything up to the last block, so the next turn re-reads it at a tenth of the price.
            map.insert("cache_control".into(), json!({"type": "ephemeral"}));
        }
        if !req.tools.is_empty() {
            let tools: Vec<Value> = req
                .tools
                .iter()
                .map(|t| json!({"name": t.name, "description": t.description, "input_schema": t.schema}))
                .collect();
            map.insert("tools".into(), Value::Array(tools));
        }
        body
    }

    /// Sends one Messages API request (built by [`super::prompts`]) as a stream and returns the
    /// finished answer, reporting progress as it arrives.
    pub async fn message(
        &self,
        key: &str,
        req: &AiRequest,
        on_progress: &mut (dyn FnMut(Progress) + Send),
    ) -> Result<Reply, AiError> {
        let mut body = self.body(req);
        body.as_object_mut().unwrap().insert("stream".into(), Value::Bool(true));
        let mut resp = tokio::time::timeout(
            CONNECT_TIMEOUT,
            self.request(self.http.post(format!("{}/v1/messages", self.base)), key)
                .header("anthropic-beta", FALLBACK_BETA)
                .json(&body)
                .send(),
        )
        .await
        .map_err(|_| timed_out(PROVIDER))?
        .map_err(|e| network_error(&e, PROVIDER))?;
        let status = resp.status().as_u16();
        let streamed = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("text/event-stream"));
        if !(200..300).contains(&status) || !streamed {
            // An error, or a server that answered in one piece: read it whole.
            let text = resp.text().await.map_err(|e| network_error(&e, PROVIDER))?;
            log::info!("Claude request finished with HTTP {status}");
            return parse_reply(status, &text);
        }
        let mut stream = SseAccumulator::default();
        let mut last = Instant::now() - PROGRESS_EVERY;
        let mut last_stage = None;
        loop {
            let chunk = tokio::time::timeout(self.idle, resp.chunk())
                .await
                .map_err(|_| timed_out(PROVIDER))?
                .map_err(|e| network_error(&e, PROVIDER))?;
            let Some(chunk) = chunk else { break };
            stream.feed(&chunk);
            let progress = stream.progress();
            if last_stage != Some(progress.stage) || last.elapsed() >= PROGRESS_EVERY {
                on_progress(progress);
                last = Instant::now();
                last_stage = Some(progress.stage);
            }
            if stream.is_done() {
                break;
            }
        }
        let reply = stream.finish();
        log::info!(
            "Claude stream finished: {}",
            match &reply {
                Ok(_) => "answered".to_string(),
                Err(e) => format!("{:?}", e.kind),
            }
        );
        reply
    }
}

/// One content block as it streams: gathered by its `index`, in order, so a fallback can discard
/// everything gathered before it and multiple tool calls stay distinct.
#[derive(Debug)]
enum Block {
    Text(String),
    ToolUse {
        name: String,
        json: String,
    },
    /// thinking, redacted_thinking: carry nothing the app shows.
    Other,
}

/// Reads a Messages API event stream (server-sent events). Pure: fed bytes as they arrive, in
/// chunks that may split a line or a character anywhere.
#[derive(Debug, Default)]
pub struct SseAccumulator {
    pending: Vec<u8>,
    data: String,
    blocks: Vec<Block>,
    model: String,
    stop_reason: Option<String>,
    error: Option<AiError>,
    writing: bool,
    done: bool,
}

impl SseAccumulator {
    pub fn feed(&mut self, bytes: &[u8]) {
        self.pending.extend_from_slice(bytes);
        while let Some(end) = self.pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                // A blank line ends an event.
                let data = std::mem::take(&mut self.data);
                if !data.is_empty() {
                    self.event(&data);
                }
            } else if let Some(data) = line.strip_prefix("data:") {
                if !self.data.is_empty() {
                    self.data.push('\n');
                }
                self.data.push_str(data.strip_prefix(' ').unwrap_or(data));
            }
            // `event:` repeats the data's own `type`; comments and ids carry nothing needed.
        }
    }

    fn block_mut(&mut self, index: usize) -> &mut Block {
        while self.blocks.len() <= index {
            self.blocks.push(Block::Other);
        }
        &mut self.blocks[index]
    }

    fn event(&mut self, data: &str) {
        let Ok(v) = serde_json::from_str::<Value>(data) else {
            return;
        };
        let index = v.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        match v.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                if let Some(model) = v.pointer("/message/model").and_then(Value::as_str) {
                    self.model = model.to_string();
                }
            }
            Some("content_block_start") => {
                match v.pointer("/content_block/type").and_then(Value::as_str) {
                    // Another model takes over: what the declining one wrote is not the answer.
                    Some("fallback") => {
                        self.blocks.clear();
                        self.writing = false;
                        if let Some(model) = v.pointer("/content_block/to/model").and_then(Value::as_str) {
                            self.model = model.to_string();
                        }
                    }
                    Some("text") => {
                        self.writing = true;
                        let text = v
                            .pointer("/content_block/text")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        *self.block_mut(index) = Block::Text(text);
                    }
                    Some("tool_use") => {
                        let name = v
                            .pointer("/content_block/name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        *self.block_mut(index) = Block::ToolUse {
                            name,
                            json: String::new(),
                        };
                    }
                    _ => {}
                }
            }
            Some("content_block_delta") => match v.pointer("/delta/type").and_then(Value::as_str) {
                Some("text_delta") => {
                    if let Some(t) = v.pointer("/delta/text").and_then(Value::as_str) {
                        self.writing = true;
                        if let Block::Text(text) = self.block_mut(index) {
                            text.push_str(t);
                        }
                    }
                }
                Some("input_json_delta") => {
                    if let Some(t) = v.pointer("/delta/partial_json").and_then(Value::as_str) {
                        if let Block::ToolUse { json, .. } = self.block_mut(index) {
                            json.push_str(t);
                        }
                    }
                }
                _ => {}
            },
            Some("message_delta") => {
                if let Some(reason) = v.pointer("/delta/stop_reason").and_then(Value::as_str) {
                    self.stop_reason = Some(reason.to_string());
                }
            }
            Some("message_stop") => self.done = true,
            Some("error") => {
                let kind = v.pointer("/error/type").and_then(Value::as_str).unwrap_or_default();
                let status = match kind {
                    "overloaded_error" => 529,
                    "rate_limit_error" => 429,
                    "authentication_error" => 401,
                    "api_error" => 500,
                    _ => 400,
                };
                self.error = Some(http_error(status, data));
                self.done = true;
            }
            _ => {}
        }
    }

    pub fn progress(&self) -> Progress {
        let chars = self
            .blocks
            .iter()
            .map(|b| if let Block::Text(t) = b { t.chars().count() } else { 0 })
            .sum();
        Progress {
            stage: if self.writing { Stage::Writing } else { Stage::Thinking },
            chars,
        }
    }

    pub fn is_done(&self) -> bool {
        self.done
    }

    /// The answer, judged by the same rules as [`parse_reply`]: `stop_reason` first.
    pub fn finish(mut self) -> Result<Reply, AiError> {
        // A final event with no blank line after it still counts.
        if !self.data.is_empty() {
            let data = std::mem::take(&mut self.data);
            self.event(&data);
        }
        if let Some(e) = self.error {
            return Err(e);
        }
        let text: String = self
            .blocks
            .iter()
            .filter_map(|b| if let Block::Text(t) = b { Some(t.as_str()) } else { None })
            .collect();
        let tool_calls: Vec<ToolCall> = self
            .blocks
            .iter()
            .filter_map(|b| match b {
                Block::ToolUse { name, json } => Some(ToolCall {
                    name: name.clone(),
                    arguments: serde_json::from_str(json).unwrap_or(Value::Object(Default::default())),
                }),
                _ => None,
            })
            .collect();
        match self.stop_reason.as_deref() {
            Some("refusal") => Err(refused()),
            Some("max_tokens") => Err(cut_off()),
            None => Err(AiError::new(
                AiErrorKind::Network,
                "Anthropic's answer stopped before it was complete. Try again.",
            )),
            Some(_) if text.trim().is_empty() && tool_calls.is_empty() => Err(empty()),
            Some(_) => Ok(Reply {
                text,
                tool_calls,
                model: self.model,
            }),
        }
    }
}

fn refused() -> AiError {
    AiError::new(
        AiErrorKind::Refused,
        "Claude declined this request. Try rewording it as a market-research question.",
    )
}

fn cut_off() -> AiError {
    AiError::new(
        AiErrorKind::CutOff,
        "Claude's answer was cut off before it was complete. Try a simpler question.",
    )
}

fn empty() -> AiError {
    AiError::new(AiErrorKind::Api, "Claude returned an empty answer.")
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
            "Anthropic didn't accept the API key. Check it in the AI providers settings.",
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
        Some("refusal") => return Err(refused()),
        Some("max_tokens") => return Err(cut_off()),
        _ => {}
    }
    // Thinking, redacted thinking and fallback blocks carry nothing the app shows, and everything
    // before the last fallback block was written by a model that then declined: it isn't the answer.
    let blocks = v.get("content").and_then(Value::as_array).cloned().unwrap_or_default();
    let from = blocks
        .iter()
        .rposition(|b| b.get("type").and_then(Value::as_str) == Some("fallback"))
        .map_or(0, |i| i + 1);
    let text: String = blocks[from..]
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect();
    let tool_calls: Vec<ToolCall> = blocks[from..]
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
        .map(|b| ToolCall {
            name: b.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
            arguments: b.get("input").cloned().unwrap_or(Value::Object(Default::default())),
        })
        .collect();
    if text.trim().is_empty() && tool_calls.is_empty() {
        return Err(empty());
    }
    Ok(Reply {
        text,
        tool_calls,
        model: v.get("model").and_then(Value::as_str).unwrap_or_default().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{Msg, ToolSpec};
    use serde_json::json;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn req(schema: Value) -> AiRequest {
        AiRequest::structured(
            "system".into(),
            vec![Msg {
                role: "user".into(),
                content: "hi".into(),
            }],
            schema,
        )
    }

    #[test]
    fn a_finished_answer_is_its_text_blocks() {
        let body = json!({
            "model": "claude-opus-5-5",
            "stop_reason": "end_turn",
            "content": [
                {"type": "thinking", "thinking": "…", "signature": "x"},
                {"type": "text", "text": "{\"a\":"},
                {"type": "text", "text": "1}"}
            ]
        });
        let reply = parse_reply(200, &body.to_string()).unwrap();
        assert_eq!(reply.text, "{\"a\":1}");
        assert_eq!(reply.model, "claude-opus-5-5");
        assert!(reply.tool_calls.is_empty());
    }

    #[test]
    fn a_tool_call_is_read_from_a_whole_response() {
        let body = json!({
            "model": "claude-opus-5-5",
            "stop_reason": "tool_use",
            "content": [
                {"type": "text", "text": "Sure, adding it."},
                {"type": "tool_use", "id": "t1", "name": "add_watchlist_item", "input": {"symbol": "binance:BTCUSDT"}}
            ]
        });
        let reply = parse_reply(200, &body.to_string()).unwrap();
        assert_eq!(reply.text, "Sure, adding it.");
        assert_eq!(
            reply.tool_calls,
            vec![ToolCall {
                name: "add_watchlist_item".into(),
                arguments: json!({"symbol": "binance:BTCUSDT"}),
            }]
        );
    }

    #[test]
    fn a_fallback_answer_names_the_model_that_gave_it() {
        let body = json!({
            "model": "claude-opus-4-8",
            "stop_reason": "end_turn",
            "content": [
                {"type": "fallback", "from": {"model": "claude-opus-5-5"}, "to": {"model": "claude-opus-4-8"}},
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
        serve_raw(status, "application/json", body.to_string(), None).await
    }

    /// Answers one request with `payload` of `content_type`, optionally stalling before the end.
    async fn serve_raw(
        status: u16,
        content_type: &'static str,
        payload: String,
        stall_after: Option<usize>,
    ) -> (String, Arc<Mutex<Option<(String, String)>>>) {
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
            let head = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                payload.len()
            );
            sock.write_all(head.as_bytes()).await.unwrap();
            match stall_after {
                Some(n) => {
                    sock.write_all(&payload.as_bytes()[..n]).await.unwrap();
                    tokio::time::sleep(Duration::from_secs(3600)).await;
                }
                None => {
                    // In small pieces, so events and characters arrive split — a real gap between
                    // writes, not just a `flush()` (which doesn't pace a raw socket and let a fast
                    // loopback coalesce every piece into one read on the client side).
                    for piece in payload.as_bytes().chunks(7) {
                        sock.write_all(piece).await.unwrap();
                        sock.flush().await.ok();
                        tokio::time::sleep(Duration::from_millis(2)).await;
                    }
                }
            }
            sock.shutdown().await.ok();
        });
        (base, seen)
    }

    #[tokio::test]
    async fn a_message_carries_the_key_version_and_fallback_opt_in() {
        let (base, seen) = serve_once(
            200,
            json!({"model": "claude-opus-5-5", "stop_reason": "end_turn", "content": [{"type": "text", "text": "hi"}]}),
        )
        .await;
        let client = ClaudeClient::with_base(reqwest::Client::new(), &base);
        let reply = client
            .message("sk-ant-test", &req(json!({"type": "object"})), &mut |_| {})
            .await
            .unwrap();
        assert_eq!(reply.text, "hi");
        let (head, body) = seen.lock().unwrap().clone().unwrap();
        let head = head.to_ascii_lowercase();
        assert!(head.starts_with("post /v1/messages "), "{head}");
        assert!(head.contains("x-api-key: sk-ant-test"));
        assert!(head.contains("anthropic-version: 2023-06-01"));
        assert!(head.contains(&format!("anthropic-beta: {FALLBACK_BETA}")));
        let sent: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(sent["model"], MODEL);
        assert_eq!(sent["stream"], true);
        assert_eq!(sent["output_config"]["format"]["schema"]["type"], "object");
        assert_eq!(sent["output_config"]["effort"], "high");
        assert!(sent.get("cache_control").is_none(), "a one-off request isn't cached");
    }

    #[tokio::test]
    async fn a_conversation_asks_for_its_prefix_to_be_cached() {
        let (base, seen) = serve_once(
            200,
            json!({"model": MODEL, "stop_reason": "end_turn", "content": [{"type": "text", "text": "hi"}]}),
        )
        .await;
        let client = ClaudeClient::with_base(reqwest::Client::new(), &base);
        client
            .message("sk-ant-test", &req(json!({"type": "object"})).cached(), &mut |_| {})
            .await
            .unwrap();
        let (_, body) = seen.lock().unwrap().clone().unwrap();
        let sent: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(sent["cache_control"], json!({"type": "ephemeral"}));
    }

    #[tokio::test]
    async fn a_request_with_tools_sends_them_and_no_schema() {
        let (base, seen) = serve_once(
            200,
            json!({"model": "claude-opus-5-5", "stop_reason": "tool_use", "content": [{"type": "tool_use", "id": "t1", "name": "f", "input": {}}]}),
        )
        .await;
        let client = ClaudeClient::with_base(reqwest::Client::new(), &base);
        let req = AiRequest::with_tools(
            "system".into(),
            vec![Msg {
                role: "user".into(),
                content: "hi".into(),
            }],
            vec![ToolSpec {
                name: "f".into(),
                description: "does f".into(),
                schema: json!({"type": "object", "properties": {}, "required": [], "additionalProperties": false}),
            }],
        );
        client.message("sk-ant-test", &req, &mut |_| {}).await.unwrap();
        let (_, body) = seen.lock().unwrap().clone().unwrap();
        let sent: Value = serde_json::from_str(&body).unwrap();
        assert!(sent["output_config"].get("format").is_none());
        assert_eq!(sent["output_config"]["effort"], "high");
        assert!(sent.get("tool_choice").is_none());
        assert_eq!(sent["tools"][0]["name"], "f");
        assert_eq!(sent["tools"][0]["input_schema"]["type"], "object");
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

    fn sse(events: &[Value]) -> String {
        events
            .iter()
            .map(|e| format!("event: {}\ndata: {e}\n\n", e["type"].as_str().unwrap()))
            .collect()
    }

    fn answer_stream(text_parts: &[&str], stop_reason: &str) -> Vec<Value> {
        let mut events = vec![
            json!({"type": "message_start", "message": {"model": "claude-opus-5-5", "content": []}}),
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "hmm"}}),
            json!({"type": "ping"}),
            json!({"type": "content_block_stop", "index": 0}),
            json!({"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}}),
        ];
        for part in text_parts {
            events.push(
                json!({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": part}}),
            );
        }
        events.push(json!({"type": "content_block_stop", "index": 1}));
        events.push(json!({"type": "message_delta", "delta": {"stop_reason": stop_reason}}));
        events.push(json!({"type": "message_stop"}));
        events
    }

    fn accumulate(stream: &str, piece: usize) -> Result<Reply, AiError> {
        let mut acc = SseAccumulator::default();
        for chunk in stream.as_bytes().chunks(piece) {
            acc.feed(chunk);
        }
        acc.finish()
    }

    #[test]
    fn a_stream_is_read_however_it_is_split() {
        let stream = sse(&answer_stream(&["{\"a\":", " \"₹1 Cr\"}"], "end_turn"));
        for piece in [1, 2, 3, 5, 64, stream.len()] {
            let reply = accumulate(&stream, piece).unwrap();
            assert_eq!(reply.text, "{\"a\": \"₹1 Cr\"}", "split every {piece} bytes");
            assert_eq!(reply.model, "claude-opus-5-5");
        }
        let crlf = stream.replace('\n', "\r\n");
        assert_eq!(accumulate(&crlf, 4).unwrap().text, "{\"a\": \"₹1 Cr\"}");
    }

    #[test]
    fn a_streamed_tool_call_reassembles_its_json_from_partial_deltas() {
        let events = vec![
            json!({"type": "message_start", "message": {"model": "claude-opus-5-5"}}),
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Adding it."}}),
            json!({"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "t1", "name": "add_watchlist_item", "input": {}}}),
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{\"symbol\": \""}}),
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "binance:BTCUSDT\"}"}}),
            json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"}}),
            json!({"type": "message_stop"}),
        ];
        let reply = accumulate(&sse(&events), 9).unwrap();
        assert_eq!(reply.text, "Adding it.");
        assert_eq!(
            reply.tool_calls,
            vec![ToolCall {
                name: "add_watchlist_item".into(),
                arguments: json!({"symbol": "binance:BTCUSDT"}),
            }]
        );
    }

    #[test]
    fn a_tool_only_answer_with_no_text_is_not_an_empty_answer() {
        let events = vec![
            json!({"type": "message_start", "message": {"model": "claude-opus-5-5"}}),
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "t1", "name": "f", "input": {}}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": "{}"}}),
            json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"}}),
            json!({"type": "message_stop"}),
        ];
        let reply = accumulate(&sse(&events), 100).unwrap();
        assert_eq!(reply.text, "");
        assert_eq!(reply.tool_calls[0].name, "f");
    }

    #[test]
    fn progress_moves_from_thinking_to_writing() {
        let events = answer_stream(&["abc", "de"], "end_turn");
        let mut acc = SseAccumulator::default();
        acc.feed(sse(&events[..4]).as_bytes());
        assert_eq!(
            acc.progress(),
            Progress {
                stage: Stage::Thinking,
                chars: 0
            }
        );
        acc.feed(sse(&events[4..8]).as_bytes());
        assert_eq!(
            acc.progress(),
            Progress {
                stage: Stage::Writing,
                chars: 5
            }
        );
        assert!(!acc.is_done());
        acc.feed(sse(&events[8..]).as_bytes());
        assert!(acc.is_done());
    }

    #[test]
    fn a_streamed_refusal_cut_off_or_error_is_never_used() {
        let refused = sse(&answer_stream(&["partial"], "refusal"));
        assert_eq!(accumulate(&refused, 9).unwrap_err().kind, AiErrorKind::Refused);
        let cut = sse(&answer_stream(&["{\"spec\":"], "max_tokens"));
        assert_eq!(accumulate(&cut, 9).unwrap_err().kind, AiErrorKind::CutOff);
        let mut unfinished = answer_stream(&["{}"], "end_turn");
        unfinished.truncate(unfinished.len() - 2);
        assert_eq!(accumulate(&sse(&unfinished), 9).unwrap_err().kind, AiErrorKind::Network);
        let overloaded =
            sse(&[json!({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}})]);
        assert_eq!(accumulate(&overloaded, 9).unwrap_err().kind, AiErrorKind::Busy);
        let invalid =
            sse(&[json!({"type": "error", "error": {"type": "invalid_request_error", "message": "bad schema"}})]);
        assert!(accumulate(&invalid, 9).unwrap_err().message.contains("bad schema"));
    }

    #[test]
    fn a_fallback_discards_what_the_declining_model_wrote() {
        let events = vec![
            json!({"type": "message_start", "message": {"model": "claude-opus-5-5"}}),
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "{\"half"}}),
            json!({"type": "content_block_start", "index": 1, "content_block": {"type": "fallback", "from": {"model": "claude-opus-5-5"}, "to": {"model": "claude-opus-4-8"}}}),
            json!({"type": "content_block_start", "index": 2, "content_block": {"type": "text", "text": ""}}),
            json!({"type": "content_block_delta", "index": 2, "delta": {"type": "text_delta", "text": "{}"}}),
            json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}}),
            json!({"type": "message_stop"}),
        ];
        let reply = accumulate(&sse(&events), 11).unwrap();
        assert_eq!((reply.text.as_str(), reply.model.as_str()), ("{}", "claude-opus-4-8"));

        let whole = json!({"model": "claude-opus-4-8", "stop_reason": "end_turn", "content": [
            {"type": "text", "text": "{\"half"},
            {"type": "fallback", "from": {"model": "claude-opus-5-5"}, "to": {"model": "claude-opus-4-8"}},
            {"type": "text", "text": "{}"}
        ]});
        assert_eq!(parse_reply(200, &whole.to_string()).unwrap().text, "{}");
    }

    #[tokio::test]
    async fn a_streamed_message_reports_progress_and_returns_the_answer() {
        let stream = sse(&answer_stream(&["{\"ok\"", ": true}"], "end_turn"));
        let (base, _) = serve_raw(200, "text/event-stream", stream, None).await;
        let client = ClaudeClient::with_base(reqwest::Client::new(), &base);
        let mut seen = Vec::new();
        let reply = client
            .message("sk-ant-test", &req(json!({"type": "object"})), &mut |p| seen.push(p))
            .await
            .unwrap();
        assert_eq!(reply.text, "{\"ok\": true}");
        assert_eq!(seen.first().map(|p| p.stage), Some(Stage::Thinking));
        assert!(seen.iter().any(|p| p.stage == Stage::Writing));
    }

    #[tokio::test]
    async fn a_stream_that_goes_quiet_is_given_up() {
        let stream = sse(&answer_stream(&["{}"], "end_turn"));
        let (base, _) = serve_raw(200, "text/event-stream", stream, Some(40)).await;
        let client = ClaudeClient::with_base(reqwest::Client::new(), &base).with_idle(Duration::from_millis(300));
        let err = client
            .message("sk-ant-test", &req(json!({"type": "object"})), &mut |_| {})
            .await
            .unwrap_err();
        assert_eq!(err.kind, AiErrorKind::Network);
        assert!(err.message.contains("stopped answering"), "{}", err.message);
    }
}
